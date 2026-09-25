#!/usr/bin/env python3
"""Reviewed, reusable SQLite service editor for an installed Floor Boards release.

Pass a JSON packet with exact expected values. Preflight is read-only; apply
backs up the live database, checks the packet again under a write lock, and
commits all operations together. This is a service command, not a floor API.
"""

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from uuid import uuid4
from zoneinfo import ZoneInfo


CHICAGO = ZoneInfo("America/Chicago")
BOARDS = {"caja", "cocina", "other"}
LEVELS = {"forbidden", "training", "ok", "preferred"}
REASONS = {"Break", "Cover expo", "Training", "Help slammed", "Other"}
REQUIRED_COLUMNS = {
    "Employee": {"id", "externalId"},
    "Station": {"id", "board", "maxConcurrent"},
    "Shift": {"id", "employeeId", "date", "board", "supersededAt"},
    "Assignment": {"id", "shiftId", "employeeId", "stationId", "hourStart", "hourEnd"},
    "EmployeeStationAbility": {"employeeId", "stationId", "level"},
    "PositionMoveLog": {"id", "date", "hour", "employeeId", "fromStationId", "toStationId", "assignmentId", "reason"},
}


class Refusal(Exception):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def exact_keys(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise Refusal(f"expected fields {sorted(required)}; optional {sorted(optional)}")


def read_packet(path):
    if not path.is_file() or path.is_symlink():
        raise Refusal("packet missing or symlinked")
    raw = path.read_bytes()
    packet_sha = hashlib.sha256(raw).hexdigest()
    packet = json.loads(raw)
    exact_keys(packet, {"version", "release", "operations"})
    if packet["version"] != 1 or not isinstance(packet["release"], str) or not re.fullmatch(r"[0-9a-f]{40}", packet["release"]):
        raise Refusal("packet version or release SHA is invalid")
    if not isinstance(packet["operations"], list) or not 1 <= len(packet["operations"]) <= 100:
        raise Refusal("packet needs 1–100 operations")
    if len({op.get("type") for op in packet["operations"] if isinstance(op, dict)}) != 1:
        raise Refusal("one operation type per packet is required")
    for op in packet["operations"]:
        if not isinstance(op, dict) or op.get("type") not in {"ability", "shiftBoard", "clear", "move"}:
            raise Refusal("unknown operation")
        if op["type"] == "ability":
            exact_keys(op, {"type", "employeeExternalId", "stationId", "from", "to"})
            if op["from"] not in LEVELS | {None} or op["to"] not in LEVELS or op["from"] == op["to"]:
                raise Refusal("ability needs distinct valid from/to levels")
        elif op["type"] == "shiftBoard":
            exact_keys(op, {"type", "employeeExternalId", "shiftId", "date", "from", "to"})
            if op["from"] not in BOARDS or op["to"] not in BOARDS or op["from"] == op["to"]:
                raise Refusal("shift board needs distinct valid from/to boards")
            if not isinstance(op["date"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", op["date"]):
                raise Refusal("date must be YYYY-MM-DD")
            date.fromisoformat(op["date"])
        else:
            exact_keys(op, {"type", "employeeExternalId", "assignmentId", "date", "hour", "fromStationId", "reason"},
                       {"toStationId"} if op["type"] == "move" else set())
            if not isinstance(op["date"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", op["date"]):
                raise Refusal("date must be YYYY-MM-DD")
            date.fromisoformat(op["date"])
            if type(op["hour"]) is not int or not 0 <= op["hour"] <= 23:
                raise Refusal("hour must be a Chicago clock hour from 0 to 23")
            if op["reason"] not in REASONS:
                raise Refusal("clear/move requires a valid move reason")
            if op["type"] == "move" and op["toStationId"] == op["fromStationId"]:
                raise Refusal("move destination must differ")
        for key in ("employeeExternalId", "stationId", "shiftId", "assignmentId", "fromStationId", "toStationId"):
            if key in op and (not isinstance(op[key], str) or not op[key].strip()):
                raise Refusal(f"{key} must be a non-empty string")
    return packet, packet_sha


def check_app(app, release):
    if not app.is_absolute() or not app.is_dir() or app.is_symlink():
        raise Refusal("app directory missing, relative, or symlinked")
    marker = app / "RELEASE_SHA"
    if not marker.is_file() or marker.is_symlink() or marker.read_text().strip() != release:
        raise Refusal("installed release does not match packet")
    db = app / "var/data/floor-boards.db"
    if not db.is_file() or db.is_symlink():
        raise Refusal("database missing or symlinked")
    return db


def check_database(connection):
    for table, required in REQUIRED_COLUMNS.items():
        columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
        if not required <= columns:
            raise Refusal(f"{table} schema lacks reviewed columns")
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise Refusal("database integrity check failed")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise Refusal("database foreign-key check failed")


def employee_id(connection, external_id):
    row = connection.execute('SELECT id FROM "Employee" WHERE externalId=?', (external_id,)).fetchone()
    if row is None:
        raise Refusal(f"employee {external_id} not found")
    return row[0]


def chicago_hour_ms(day, hour):
    local = datetime.fromisoformat(f"{day}T{hour:02d}:00:00").replace(tzinfo=CHICAGO)
    if local.utcoffset() != local.replace(fold=1).utcoffset():
        raise Refusal("ambiguous Chicago hour; packet needs an unambiguous hour")
    if local.astimezone(timezone.utc).astimezone(CHICAGO).hour != hour:
        raise Refusal("nonexistent Chicago hour")
    return int(local.timestamp() * 1000)


def lookup_assignment(connection, op, person_id):
    hour_ms = chicago_hour_ms(op["date"], op["hour"])
    row = connection.execute(
        'SELECT a.id,a.shiftId,a.employeeId,a.stationId,a.hourStart,a.hourEnd,s.board,s.supersededAt '
        'FROM "Assignment" a JOIN "Shift" s ON s.id=a.shiftId '
        'WHERE a.employeeId=? AND a.stationId=? AND a.hourStart=?',
        (person_id, op["fromStationId"], hour_ms),
    ).fetchone()
    if row is None or row[0] != op["assignmentId"] or row[5] != hour_ms + 3600000:
        raise Refusal(f"exact assignment absent: {op['employeeExternalId']} {op['fromStationId']} {op['date']} {op['hour']}")
    return row


def describe(connection, op):
    person = employee_id(connection, op["employeeExternalId"])
    kind = op["type"]
    if kind == "ability":
        if connection.execute('SELECT 1 FROM "Station" WHERE id=?', (op["stationId"],)).fetchone() is None:
            raise Refusal("station not found")
        row = connection.execute('SELECT level FROM "EmployeeStationAbility" WHERE employeeId=? AND stationId=?',
                                 (person, op["stationId"])).fetchone()
        before = row[0] if row else None
        if before != op["from"]:
            raise Refusal(f"ability expected {op['from']}, found {before}")
        if op["to"] == "forbidden":
            future = connection.execute(
                'SELECT COUNT(*) FROM "Assignment" WHERE employeeId=? AND stationId=? AND hourStart>?',
                (person, op["stationId"], int(datetime.now(timezone.utc).timestamp() * 1000)),
            ).fetchone()[0]
            if future:
                raise Refusal("cannot forbid ability with future assigned hours")
        return {"type": kind, "employeeExternalId": op["employeeExternalId"],
                "stationId": op["stationId"], "before": before, "after": op["to"]}
    if kind == "shiftBoard":
        row = connection.execute('SELECT board,supersededAt FROM "Shift" WHERE id=? AND employeeId=? AND date=?',
                                 (op["shiftId"], person, op["date"])).fetchone()
        if row is None or row[1] is not None or row[0] != op["from"]:
            raise Refusal("shift missing, superseded, or board differs from expected")
        occupied = connection.execute(
            'SELECT COUNT(*) FROM "Assignment" a JOIN "Station" t ON t.id=a.stationId '
            'WHERE a.shiftId=? AND t.board<>?', (op["shiftId"], op["to"])).fetchone()[0]
        if occupied:
            raise Refusal("shift has assignments outside target board")
        return {"type": kind, "shiftId": op["shiftId"], "before": row[0], "after": op["to"]}
    row = lookup_assignment(connection, op, person)
    if row[7] is not None and row[4] > int(datetime.now(timezone.utc).timestamp() * 1000):
        raise Refusal("future hour belongs to a superseded shift")
    result = {"type": kind, "assignmentId": row[0], "employeeExternalId": op["employeeExternalId"],
              "date": op["date"], "hour": op["hour"], "before": op["fromStationId"],
              "after": None if kind == "clear" else op["toStationId"]}
    if kind == "move":
        station = connection.execute('SELECT board,maxConcurrent FROM "Station" WHERE id=?',
                                     (op["toStationId"],)).fetchone()
        if station is None or station[0] != row[6]:
            raise Refusal("move destination absent or on different board")
        ability = connection.execute('SELECT level FROM "EmployeeStationAbility" WHERE employeeId=? AND stationId=?',
                                     (person, op["toStationId"])).fetchone()
        if ability is not None and ability[0] == "forbidden":
            raise Refusal("move destination forbidden for employee")
        occupied = connection.execute('SELECT COUNT(*) FROM "Assignment" WHERE stationId=? AND hourStart=?',
                                      (op["toStationId"], row[4])).fetchone()[0]
        if station[1] != -1 and occupied >= station[1]:
            raise Refusal("move destination full")
    return result


def apply_one(connection, op, before):
    person = employee_id(connection, op["employeeExternalId"])
    kind = op["type"]
    if kind == "ability":
        if op["from"] is None:
            connection.execute('INSERT INTO "EmployeeStationAbility" (employeeId,stationId,level) VALUES (?,?,?)',
                               (person, op["stationId"], op["to"]))
        else:
            cursor = connection.execute(
                'UPDATE "EmployeeStationAbility" SET level=? WHERE employeeId=? AND stationId=? AND level=?',
                (op["to"], person, op["stationId"], op["from"]))
            if cursor.rowcount != 1:
                raise Refusal("ability changed during apply")
        actual = connection.execute('SELECT level FROM "EmployeeStationAbility" WHERE employeeId=? AND stationId=?',
                                    (person, op["stationId"])).fetchone()
        if actual != (op["to"],):
            raise Refusal("ability postcheck failed")
    elif kind == "shiftBoard":
        cursor = connection.execute('UPDATE "Shift" SET board=? WHERE id=? AND board=?',
                                    (op["to"], op["shiftId"], op["from"]))
        if cursor.rowcount != 1 or connection.execute('SELECT board FROM "Shift" WHERE id=?',
                                                      (op["shiftId"],)).fetchone() != (op["to"],):
            raise Refusal("shift board postcheck failed")
    else:
        row = lookup_assignment(connection, op, person)
        if row[0] != before["assignmentId"]:
            raise Refusal("assignment changed during apply")
        if row[4] <= int(datetime.now(timezone.utc).timestamp() * 1000):
            connection.execute(
                'INSERT INTO "PositionMoveLog" (id,date,hour,employeeId,fromStationId,toStationId,assignmentId,reason) '
                'VALUES (?,?,?,?,?,?,?,?)',
                (uuid4().hex, op["date"], op["hour"], person, op["fromStationId"],
                 before["after"], row[0], op["reason"]),
            )
        if kind == "clear":
            cursor = connection.execute('DELETE FROM "Assignment" WHERE id=? AND stationId=?',
                                        (row[0], op["fromStationId"]))
            actual = connection.execute('SELECT id FROM "Assignment" WHERE id=?', (row[0],)).fetchone()
            if cursor.rowcount != 1 or actual is not None:
                raise Refusal("clear postcheck failed")
        else:
            cursor = connection.execute('UPDATE "Assignment" SET stationId=? WHERE id=? AND stationId=?',
                                        (op["toStationId"], row[0], op["fromStationId"]))
            actual = connection.execute('SELECT stationId FROM "Assignment" WHERE id=?', (row[0],)).fetchone()
            if cursor.rowcount != 1 or actual != (op["toStationId"],):
                raise Refusal("move postcheck failed")


def backup_database(db, app):
    root = app / "var/backups"
    if root.is_symlink():
        raise Refusal("backup directory is symlinked")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder = root / ("board-edit-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    folder.mkdir(mode=0o700)
    backup = folder / "database.db"
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as live:
        with sqlite3.connect(backup) as copy:
            live.backup(copy)
            check_database(copy)
    os.chmod(backup, 0o600)
    return backup, sha256(backup)


def run(app, packet_path, expected_packet_sha, apply):
    packet, packet_sha = read_packet(packet_path)
    if packet_sha != expected_packet_sha:
        raise Refusal("packet SHA-256 differs from reviewed command")
    db = check_app(app, packet["release"])
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as connection:
        check_database(connection)
        changes = [describe(connection, op) for op in packet["operations"]]
    if not apply:
        return {"mode": "preflight", "release": packet["release"], "packet_sha256": packet_sha,
                "changes": changes, "changed": 0}
    connection = sqlite3.connect(db, timeout=10, isolation_level=None)
    try:
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA foreign_keys=ON")
        # data_version changes on this connection when another connection
        # commits. Keep it open across the backup and compare only after the
        # write lock is held, so the backup cannot miss an intervening write.
        before_backup_version = connection.execute("PRAGMA data_version").fetchone()[0]
        backup, backup_sha = backup_database(db, app)
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("PRAGMA data_version").fetchone()[0] != before_backup_version:
            raise Refusal("database changed after backup; backup is stale and must not be restored; transaction rolled back")
        check_database(connection)
        if [describe(connection, op) for op in packet["operations"]] != changes:
            raise Refusal("preflight changed; transaction rolled back")
        for op, before in zip(packet["operations"], changes):
            apply_one(connection, op, before)
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise Refusal("postwrite foreign-key check failed")
        connection.execute("COMMIT")
    except BaseException:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()
    return {"mode": "apply", "release": packet["release"], "packet_sha256": packet_sha,
            "changes": changes, "changed": len(changes), "backup": str(backup),
            "backup_sha256": backup_sha}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-dir", type=Path, required=True)
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--expected-packet-sha256", required=True,
                        help="SHA-256 of the reviewed packet bytes")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight-only", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        result = run(args.app_dir, args.packet, args.expected_packet_sha256, args.apply)
    except (Refusal, sqlite3.Error, OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
