"""Disposable database checks for the guarded owner-decision operation."""

import json
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/apply-position-names.py"
DECISIONS = json.loads((ROOT / "operations/position-names-2026-09-26.json").read_text())["decisions"]


class PositionNameOperationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "board.db"
        with sqlite3.connect(self.db) as connection:
            connection.executescript('''
                CREATE TABLE "Station" (id TEXT PRIMARY KEY, board TEXT, label TEXT, shortCode TEXT);
                CREATE TABLE "Assignment" (stationId TEXT);
                CREATE TABLE "PositionMoveLog" (fromStationId TEXT, toStationId TEXT);
                CREATE TABLE "ReturnPrompt" (seatId TEXT);
                CREATE TABLE "PositionStationMap" (stationId TEXT);
                CREATE TABLE "EmployeeStationAbility" (
                    employeeId TEXT, stationId TEXT, level TEXT,
                    PRIMARY KEY (employeeId, stationId)
                );
            ''')
            connection.executemany(
                'INSERT INTO "Station" VALUES (?,?,?,?)',
                [(d["station_id"], d["board"], d["label_at_memo"], d["code_at_memo"])
                 for d in DECISIONS],
            )
            connection.executemany(
                'INSERT INTO "EmployeeStationAbility" VALUES (?,?,?)',
                [(employee, d["station_id"],
                  "forbidden" if employee == "caja" else "preferred" if d["station_id"] == "carne" else "ok")
                 for employee in ("caja", "kitchen") for d in DECISIONS
                 if d["action"] == "remove_if_unreferenced"],
            )

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--db", str(self.db), *args],
            capture_output=True, text=True, check=False,
        )

    def test_preview_then_apply_preserves_other_station_fields_and_is_idempotent(self):
        preview = self.run_script()
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertEqual(len(json.loads(preview.stdout)["rename"]), 13)
        self.assertEqual(json.loads(preview.stdout)["ability_rows_to_create"], 30)
        backup = Path(self.temp.name) / "before.db"
        applied = self.run_script("--apply", "--backup", str(backup))
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertTrue(backup.is_file())
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        with sqlite3.connect(self.db) as connection:
            rows = dict(connection.execute('SELECT id,label FROM "Station"'))
            self.assertEqual(rows, {d["station_id"]: d["final_label"] for d in DECISIONS
                                    if d["action"] != "remove_if_unreferenced"})
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM "EmployeeStationAbility"').fetchone()[0], 30)
            abilities = dict(connection.execute(
                'SELECT employeeId || ":" || stationId,level FROM "EmployeeStationAbility"'
            ))
            self.assertEqual(abilities["caja:pdf_guia"], "forbidden")
            self.assertEqual(abilities["caja:pdf_tq3r"], "forbidden")
            self.assertEqual(abilities["kitchen:pdf_crne"], "preferred")
            self.assertEqual(abilities["kitchen:pdf_tf1r"], "ok")
            self.assertNotIn("kitchen:pdf_guia", abilities)
        again = self.run_script()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)["rename"], [])
        self.assertEqual(len(json.loads(again.stdout)["already_removed"]), 6)

    def test_saved_assignment_refuses_the_entire_operation(self):
        with sqlite3.connect(self.db) as connection:
            connection.execute('INSERT INTO "Assignment" VALUES (?)', ("fryer",))
        result = self.run_script("--apply", "--backup", str(Path(self.temp.name) / "before.db"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Assignment.stationId', result.stderr)
        with sqlite3.connect(self.db) as connection:
            self.assertEqual(connection.execute('SELECT label FROM "Station" WHERE id="mana"').fetchone()[0], "MANA (Manager)")
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM "Station"').fetchone()[0], 38)

    def test_move_history_refuses_removal(self):
        with sqlite3.connect(self.db) as connection:
            connection.execute('INSERT INTO "PositionMoveLog" VALUES (?,?)', ("prepa", None))
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PositionMoveLog.fromStationId', result.stderr)

    def test_existing_numbered_ability_conflict_refuses_all_writes(self):
        with sqlite3.connect(self.db) as connection:
            connection.execute(
                'INSERT INTO "EmployeeStationAbility" VALUES (?,?,?)',
                ("kitchen", "pdf_crne", "forbidden"),
            )
        result = self.run_script("--apply", "--backup", str(Path(self.temp.name) / "before.db"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("existing numbered-seat ability conflicts", result.stderr)
        with sqlite3.connect(self.db) as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM "Station"').fetchone()[0], 38)


if __name__ == "__main__":
    unittest.main()
