"""Schema-2 preservation guard. Explicit safe-column reads; no database copy/restore."""
from pathlib import Path
import hashlib
import json
import os
import re
import sqlite3

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / 'src/lib/quarter/preservation-columns.json'
QUARTER_TABLES = {'QuarterSchema', 'QuarterWorldRevision', 'PaintHour', 'PaintSegment', 'PaintCommandReceipt', 'PaintMutation'}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def hash_value(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def regular(path):
    path = Path(path).absolute()
    if path.resolve(strict=True) != path or not path.is_file() or path.stat().st_nlink != 1:
        raise ValueError('DATABASE_PATH_NOT_REGULAR')
    return path


def disposable(database, root=None):
    root = Path(root or os.environ.get('FLOOR_BOARDS_TEST_ROOT', '')).absolute()
    if root.parent != Path('/tmp').resolve() or not re.fullmatch(r'color-boards-test-[A-Za-z0-9]+', root.name) or root.resolve(strict=True) != root:
        raise ValueError('TEST_DB_ROOT_NOT_DISPOSABLE')
    database = regular(database)
    if not database.is_relative_to(root):
        raise ValueError('TEST_DB_OUTSIDE_DISPOSABLE_ROOT')
    return database


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def schema_fingerprint(connection):
    return hash_value(connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall())


def connect(database, readonly=True):
    path = regular(database)
    connection = sqlite3.connect(path.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=10)
    connection.execute('PRAGMA foreign_keys=ON')
    return connection


def capture(database, include_quarter=True, registry=REGISTRY):
    database = regular(database)
    identity = database.stat()
    columns_by_table = json.loads(Path(registry).read_text())
    if len(columns_by_table) != 26 or 'codeHash' in canonical(columns_by_table):
        raise ValueError('PRESERVATION_REGISTRY_INVALID')
    with connect(database) as db:
        db.execute('BEGIN')
        tables = {}
        for table, columns in columns_by_table.items():
            if not include_quarter and table in QUARTER_TABLES:
                continue
            names = {row[1] for row in db.execute('PRAGMA table_info(' + quote(table) + ')')}
            if not names or any(c != 'rowid' and c not in names for c in columns):
                raise ValueError('QUARTER_PRESERVATION_SCHEMA_MISMATCH:' + table)
            fields = [expression for col in columns for expression in ('typeof(' + quote(col) + ')', 'CAST(' + quote(col) + ' AS TEXT)')]
            rows = [[list(row[i:i + 2]) for i in range(0, len(row), 2)] for row in db.execute('SELECT ' + ','.join(fields) + ' FROM ' + quote(table))]
            rows.sort(key=lambda row: canonical(row).encode())
            tables[table] = {'rows': len(rows), 'sha256': hash_value(rows)}
        state = db.execute('SELECT schemaVersion,phase,databaseEpoch,minReader,minWriter,migrationSha256,activatedAtMs FROM QuarterSchema WHERE id=1').fetchone() if include_quarter else None
        snapshot = {'version': 1, 'tables': tables, 'schemaSha256': schema_fingerprint(db),
                    'foreignKeys': db.execute('PRAGMA foreign_keys').fetchone()[0],
                    'foreignKeyViolations': len(db.execute('PRAGMA foreign_key_check').fetchall()),
                    'database': {'device': identity.st_dev, 'inode': identity.st_ino}, 'state': state,
                    'registrySha256': file_hash(registry)}
    if regular(database).stat().st_ino != identity.st_ino:
        raise ValueError('DATABASE_IDENTITY_CHANGED')
    if snapshot['foreignKeyViolations']:
        raise ValueError('FOREIGN_KEY_VIOLATIONS')
    return snapshot


def preserved(before, after):
    if canonical(before) != canonical(after):
        changed = [k for k in before if before[k] != after.get(k)]
        raise ValueError('QUARTER_PRESERVATION_CHANGED:' + ','.join(changed))
