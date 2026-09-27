#!/usr/bin/env python3
"""Preview or apply Richard's 2026-09-26 station-name decisions.

The six retired seats may be removed only when no assignment or board history
references them. A preview makes no writes. Apply takes an SQLite backup first,
then repeats every guard inside one write transaction.
"""

import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path


DECISIONS = Path(__file__).resolve().parent.parent / "operations/position-names-2026-09-26.json"
HISTORY_COLUMNS = (
    ("Assignment", "stationId"),
    ("PositionMoveLog", "fromStationId"),
    ("PositionMoveLog", "toStationId"),
    ("ReturnPrompt", "seatId"),
)
CONFIG_COLUMNS = (("PositionStationMap", "stationId"),)
ABILITY_TARGETS = {
    "fryer": ("pdf_tf1r", "pdf_tf2r"),
    "tortilla": ("pdf_tf1r", "pdf_tf2r"),
    "birria": ("pdf_br1a", "pdf_br2a"),
    "taquero": ("pdf_tq1r", "pdf_tq2r", "pdf_tq3r"),
    "carne": ("pdf_crne",),
    "prepa": ("pdf_pr1e", "pdf_pr2e", "pdf_pr3e"),
}


class Refusal(Exception):
    pass


def load_decisions():
    data = json.loads(DECISIONS.read_text())
    decisions = data["decisions"]
    if len(decisions) != 38 or len({d["station_id"] for d in decisions}) != 38:
        raise Refusal("expected 38 unique station decisions")
    actions = {kind: [d for d in decisions if d["action"] == kind]
               for kind in ("rename", "keep", "remove_if_unreferenced")}
    if [len(actions[kind]) for kind in actions] != [13, 19, 6]:
        raise Refusal("decision action counts changed")
    if {d["station_id"] for d in actions["remove_if_unreferenced"]} != set(ABILITY_TARGETS):
        raise Refusal("removal IDs do not match the ability transfer map")
    return decisions


def plan_ability_transfer(connection, decisions):
    old_ids = tuple(ABILITY_TARGETS)
    cocina_ids = tuple(d["station_id"] for d in decisions
                       if d["board"] == "cocina" and d["action"] != "remove_if_unreferenced")
    rows = connection.execute(
        f'SELECT employeeId, stationId, level FROM "EmployeeStationAbility" '
        f'WHERE stationId IN ({",".join("?" for _ in old_ids)})', old_ids,
    ).fetchall()
    by_employee = {}
    for employee_id, station_id, level in rows:
        by_employee.setdefault(employee_id, {})[station_id] = level
    inserts = []
    for employee_id, levels in by_employee.items():
        if set(levels) != set(old_ids):
            raise Refusal("an employee has an incomplete old Cocina ability set")
        if not set(levels.values()) <= {"forbidden", "training", "ok", "preferred"}:
            raise Refusal("an old Cocina ability has an unknown level")
        if levels["fryer"] != levels["tortilla"]:
            raise Refusal("Fryer and Tortilla abilities conflict for a combined numbered seat")
        desired = {}
        for source, targets in ABILITY_TARGETS.items():
            for target in targets:
                if target in desired and desired[target] != levels[source]:
                    raise Refusal(f"conflicting ability sources for {target}")
                desired[target] = levels[source]
        # The old six were all forbidden for cross-board staff. Keep that
        # restriction on all retained Cocina seats, including unmatched duties.
        if set(levels.values()) == {"forbidden"}:
            desired.update({target: "forbidden" for target in cocina_ids})
        existing = dict(connection.execute(
            f'SELECT stationId, level FROM "EmployeeStationAbility" WHERE employeeId=? '
            f'AND stationId IN ({",".join("?" for _ in cocina_ids)})',
            (employee_id, *cocina_ids),
        ).fetchall())
        for target, level in desired.items():
            if target in existing:
                if existing[target] != level:
                    raise Refusal(f"existing numbered-seat ability conflicts at {target}")
            else:
                inserts.append((employee_id, target, level))
    return inserts


def check(connection, decisions):
    result = {"rename": [], "already_named": [], "remove": [], "already_removed": [],
              "ability_rows_to_remove": 0, "ability_rows_to_create": 0}
    for d in decisions:
        station_id = d["station_id"]
        row = connection.execute(
            'SELECT board, label, shortCode FROM "Station" WHERE id=?', (station_id,)
        ).fetchone()
        if d["action"] == "remove_if_unreferenced":
            refs = {f"{table}.{column}": connection.execute(
                f'SELECT COUNT(*) FROM "{table}" WHERE "{column}"=?', (station_id,)
            ).fetchone()[0] for table, column in HISTORY_COLUMNS + CONFIG_COLUMNS}
            if any(refs.values()):
                raise Refusal(f"{station_id}: referenced; counts={json.dumps(refs, sort_keys=True)}")
            abilities = connection.execute(
                'SELECT COUNT(*) FROM "EmployeeStationAbility" WHERE stationId=?',
                (station_id,),
            ).fetchone()[0]
            if row is None:
                if abilities:
                    raise Refusal(f"{station_id}: absent station still has {abilities} ability rows")
                result["already_removed"].append(station_id)
                continue
            if row != (d["board"], d["label_at_memo"], d["code_at_memo"]):
                raise Refusal(f"{station_id}: expected original board, label and code; found {row}")
            result["ability_rows_to_remove"] += abilities
            result["remove"].append(station_id)
            continue
        if row is None or row[0] != d["board"] or row[2] != d["code_at_memo"]:
            raise Refusal(f"{station_id}: missing or board/code changed; found {row}")
        if row[1] == d["final_label"]:
            result["already_named"].append(station_id)
        elif row[1] == d["label_at_memo"]:
            result["rename"].append(station_id)
        else:
            raise Refusal(f"{station_id}: label changed since the owner decision; found {row[1]!r}")
    result["ability_rows_to_create"] = len(plan_ability_transfer(connection, decisions))
    return result


def apply(connection, decisions, checked):
    by_id = {d["station_id"]: d for d in decisions}
    ability_inserts = plan_ability_transfer(connection, decisions)
    if len(ability_inserts) != checked["ability_rows_to_create"]:
        raise Refusal("ability transfer changed since preflight")
    connection.executemany(
        'INSERT INTO "EmployeeStationAbility" (employeeId, stationId, level) VALUES (?,?,?)',
        ability_inserts,
    )
    for employee_id, station_id, level in ability_inserts:
        actual = connection.execute(
            'SELECT level FROM "EmployeeStationAbility" WHERE employeeId=? AND stationId=?',
            (employee_id, station_id),
        ).fetchone()
        if actual != (level,):
            raise Refusal(f"numbered-seat ability readback failed at {station_id}")
    for station_id in checked["rename"]:
        decision = by_id[station_id]
        cursor = connection.execute(
            'UPDATE "Station" SET label=? WHERE id=? AND label=?',
            (decision["final_label"], station_id, decision["label_at_memo"]),
        )
        if cursor.rowcount != 1:
            raise Refusal(f"{station_id}: guarded rename failed")
    for station_id in checked["remove"]:
        connection.execute(
            'DELETE FROM "EmployeeStationAbility" WHERE stationId=?', (station_id,)
        )
        cursor = connection.execute(
            'DELETE FROM "Station" WHERE id=? AND board=? AND label=? AND shortCode=?',
            (station_id, by_id[station_id]["board"], by_id[station_id]["label_at_memo"],
             by_id[station_id]["code_at_memo"]),
        )
        if cursor.rowcount != 1:
            raise Refusal(f"{station_id}: guarded removal failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", type=Path, help="required for --apply; must not exist")
    args = parser.parse_args()
    if not args.db.is_file() or args.db.is_symlink():
        raise Refusal("database must be an existing regular, non-symlink file")
    if args.apply and (args.backup is None or args.backup.exists() or args.backup.is_symlink()):
        raise Refusal("--apply requires a new --backup path")
    decisions = load_decisions()
    uri = f"file:{args.db.resolve()}?mode={'rw' if args.apply else 'ro'}"
    with sqlite3.connect(uri, uri=True, isolation_level=None, timeout=10) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        if not args.apply:
            print(json.dumps({"mode": "preview", **check(connection, decisions)}, sort_keys=True))
            return
        # Preserve a consistent recovery copy before attempting the transaction.
        descriptor = os.open(args.backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        with sqlite3.connect(args.backup) as backup:
            connection.backup(backup)
        backup_hash = hashlib.sha256(args.backup.read_bytes()).hexdigest()
        try:
            connection.execute("BEGIN IMMEDIATE")
            checked = check(connection, decisions)
            apply(connection, decisions, checked)
            after = check(connection, decisions)
            if after["rename"] or after["remove"]:
                raise Refusal("post-write verification failed")
            connection.execute("COMMIT")
        except BaseException:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
    print(json.dumps({"mode": "applied", "backup": str(args.backup),
                      "backup_sha256": backup_hash, **checked}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refusal, sqlite3.Error, OSError, ValueError, KeyError) as error:
        raise SystemExit(f"REFUSED: {error}")
