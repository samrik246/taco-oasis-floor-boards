#!/usr/bin/env python3
"""Add only Manager.employeeId. Caller owns the release lock and stopped writers.
No db push, table rebuild, backup, export, restore, or implicit file creation.
"""
import argparse
import json
import sqlite3
from pathlib import Path


def migrate(path):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError("Database must already be a regular file")
    db = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, isolation_level=None)
    try:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("Database integrity check failed")
        columns = db.execute('PRAGMA table_info("Manager")').fetchall()
        if not {"id", "name", "codeHash", "active", "role"}.issubset({c[1] for c in columns}):
            raise ValueError("Expected Manager schema is absent")
        linked = [c for c in columns if c[1] == "employeeId"]
        if linked and (linked[0][2].upper() != "TEXT" or linked[0][3:] != (0, None, 0)):
            raise ValueError("Incompatible Manager.employeeId column")
        before = db.execute('SELECT rowid, id FROM "Manager" ORDER BY rowid').fetchall()
        if not linked:
            db.execute('ALTER TABLE "Manager" ADD COLUMN "employeeId" TEXT')
        after = db.execute('SELECT rowid, id FROM "Manager" ORDER BY rowid').fetchall()
        if before != after or db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("Migration integrity check failed")
        db.execute("COMMIT")
        return {"changed": not bool(linked), "managerRows": len(before), "rowidsPreserved": True}
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", help="Existing SQLite file; caller holds release lock")
    print(json.dumps(migrate(parser.parse_args().database)))
