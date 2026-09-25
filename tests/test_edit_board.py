"""Service editor behavior against a disposable SQLite fixture."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/edit-board.py"
spec = importlib.util.spec_from_file_location("edit_board", SCRIPT)
edit_board = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edit_board)
RELEASE = "c05fa9b3d5b89c41d669eb624bc5e14929aa07bd"


class EditorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name) / "app"
        (self.app / "var/data").mkdir(parents=True)
        (self.app / "RELEASE_SHA").write_text(RELEASE + "\n")
        self.db = self.app / "var/data/floor-boards.db"
        with sqlite3.connect(self.db) as db:
            db.executescript('''
                CREATE TABLE "Employee" (id TEXT PRIMARY KEY, externalId TEXT UNIQUE);
                CREATE TABLE "Station" (id TEXT PRIMARY KEY, board TEXT, maxConcurrent INTEGER);
                CREATE TABLE "Shift" (id TEXT PRIMARY KEY, employeeId TEXT, date TEXT, board TEXT,
                                      supersededAt INTEGER);
                CREATE TABLE "Assignment" (id TEXT PRIMARY KEY, shiftId TEXT, employeeId TEXT,
                    stationId TEXT, hourStart INTEGER, hourEnd INTEGER,
                    FOREIGN KEY(shiftId) REFERENCES "Shift"(id),
                    FOREIGN KEY(stationId) REFERENCES "Station"(id));
                CREATE TABLE "EmployeeStationAbility" (employeeId TEXT, stationId TEXT, level TEXT,
                    PRIMARY KEY(employeeId,stationId));
                CREATE TABLE "PositionMoveLog" (id TEXT PRIMARY KEY, date TEXT, hour INTEGER,
                    employeeId TEXT, fromStationId TEXT, toStationId TEXT, assignmentId TEXT, reason TEXT);
                INSERT INTO "Employee" VALUES ('person','2473');
                INSERT INTO "Station" VALUES ('green1','caja',1),('green2','caja',1);
                INSERT INTO "Shift" VALUES ('shift','person','2026-09-23','caja',NULL);
                INSERT INTO "EmployeeStationAbility" VALUES ('person','green2','forbidden');
            ''')

    def packet(self, operations):
        path = Path(self.temp.name) / "packet.json"
        raw = json.dumps({"version": 1, "release": RELEASE, "operations": operations}).encode()
        path.write_bytes(raw)
        return path, hashlib.sha256(raw).hexdigest()

    def query(self, sql):
        with sqlite3.connect(self.db) as db:
            return db.execute(sql).fetchall()

    def ability(self, before="forbidden", after="ok"):
        return {"type": "ability", "employeeExternalId": "2473", "stationId": "green2",
                "from": before, "to": after}

    def add_assignment(self):
        hour = edit_board.chicago_hour_ms("2026-09-23", 12)
        with sqlite3.connect(self.db) as db:
            db.execute('INSERT INTO "Assignment" VALUES (?,?,?,?,?,?)',
                       ("cell", "shift", "person", "green1", hour, hour + 3600000))

    def test_ability_preflight_backup_apply_and_exact_postcheck(self):
        path, digest = self.packet([self.ability()])
        plan = edit_board.run(self.app, path, digest, False)
        self.assertEqual(plan["changes"][0]["before"], "forbidden")
        self.assertEqual(plan["changes"][0]["after"], "ok")
        self.assertEqual(plan["changed"], 0)
        self.assertEqual(self.query('SELECT level FROM "EmployeeStationAbility"'), [("forbidden",)])
        result = edit_board.run(self.app, path, digest, True)
        self.assertEqual(result["changed"], 1)
        self.assertEqual(self.query('SELECT level FROM "EmployeeStationAbility"'), [("ok",)])
        backup = Path(result["backup"])
        self.assertEqual(edit_board.sha256(backup), result["backup_sha256"])
        with sqlite3.connect(backup) as copy:
            self.assertEqual(copy.execute('SELECT level FROM "EmployeeStationAbility"').fetchone(),
                             ("forbidden",))
        with self.assertRaises(edit_board.Refusal):
            edit_board.run(self.app, path, digest, True)

    def test_stale_value_and_wrong_packet_hash_refuse_without_write(self):
        path, digest = self.packet([self.ability("training", "ok")])
        with self.assertRaises(edit_board.Refusal):
            edit_board.run(self.app, path, digest, True)
        with self.assertRaises(edit_board.Refusal):
            edit_board.run(self.app, path, "0" * 64, True)
        self.assertFalse((self.app / "var/backups").exists())
        self.assertEqual(self.query('SELECT level FROM "EmployeeStationAbility"'), [("forbidden",)])

    def test_move_then_clear_logs_past_hours_and_keeps_other_rows(self):
        self.add_assignment()
        with sqlite3.connect(self.db) as db:
            db.execute('UPDATE "EmployeeStationAbility" SET level="ok"')
        base = {"employeeExternalId": "2473", "assignmentId": "cell", "date": "2026-09-23", "hour": 12,
                "reason": "Training"}
        move = {"type": "move", **base, "fromStationId": "green1", "toStationId": "green2"}
        path, digest = self.packet([move])
        edit_board.run(self.app, path, digest, True)
        self.assertEqual(self.query('SELECT stationId FROM "Assignment" WHERE id="cell"'), [("green2",)])
        clear = {"type": "clear", **base, "fromStationId": "green2"}
        path, digest = self.packet([clear])
        edit_board.run(self.app, path, digest, True)
        self.assertEqual(self.query('SELECT id FROM "Assignment"'), [])
        self.assertEqual(self.query('SELECT fromStationId,toStationId,reason FROM "PositionMoveLog" ORDER BY rowid'),
                         [("green1", "green2", "Training"), ("green2", None, "Training")])

    def test_shift_board_and_batch_failure_rollback(self):
        shift = {"type": "shiftBoard", "employeeExternalId": "2473", "shiftId": "shift",
                 "date": "2026-09-23", "from": "caja", "to": "other"}
        bad_ability = self.ability("training", "ok")
        path, digest = self.packet([shift, bad_ability])
        with self.assertRaises(edit_board.Refusal):
            edit_board.run(self.app, path, digest, True)
        self.assertEqual(self.query('SELECT board FROM "Shift"'), [("caja",)])
        path, digest = self.packet([shift])
        edit_board.run(self.app, path, digest, True)
        self.assertEqual(self.query('SELECT board FROM "Shift"'), [("other",)])

    def test_forbidden_ability_refuses_future_assigned_hour(self):
        hour = edit_board.chicago_hour_ms("2099-09-25", 12)
        with sqlite3.connect(self.db) as db:
            db.execute('UPDATE "EmployeeStationAbility" SET level="ok"')
            db.execute('INSERT INTO "Assignment" VALUES (?,?,?,?,?,?)',
                       ("future-cell", "shift", "person", "green2", hour, hour + 3600000))
        path, digest = self.packet([self.ability("ok", "forbidden")])
        with self.assertRaises(edit_board.Refusal):
            edit_board.run(self.app, path, digest, True)
        self.assertEqual(self.query('SELECT level FROM "EmployeeStationAbility"'), [("ok",)])

    def test_unrelated_commit_after_backup_refuses_without_using_stale_backup(self):
        path, digest = self.packet([self.ability()])
        original = edit_board.backup_database
        backups = []

        def interleave(db_path, app):
            backup, backup_sha = original(db_path, app)
            backups.append(backup)
            with sqlite3.connect(db_path) as writer:
                writer.execute('INSERT INTO "Station" VALUES (?,?,?)', ("yellow2", "caja", 1))
            return backup, backup_sha

        with patch.object(edit_board, "backup_database", side_effect=interleave):
            with self.assertRaisesRegex(edit_board.Refusal, "database changed after backup"):
                edit_board.run(self.app, path, digest, True)
        self.assertEqual(self.query('SELECT level FROM "EmployeeStationAbility"'), [("forbidden",)])
        self.assertEqual(self.query('SELECT id FROM "Station" WHERE id="yellow2"'), [("yellow2",)])
        with sqlite3.connect(backups[0]) as copy:
            self.assertEqual(copy.execute('SELECT id FROM "Station" WHERE id="yellow2"').fetchall(), [])


if __name__ == "__main__":
    unittest.main()
