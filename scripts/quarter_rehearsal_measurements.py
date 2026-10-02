"""Measured browser evidence through the actual release reader. R0 never claims Q1 activation."""
import json
import os
from contextlib import closing
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from quarter_artifacts import MANIFEST, atomic_json, verify
from quarter_guard import REGISTRY, canonical, capture, connect, disposable, file_hash, hash_value, preserved, quote, regular
from quarter_managed_service import synthetic_service
from quarter_release import activate, load_packet, readbacks, record


ACTIVATION_TABLES = ('QuarterSchema', 'QuarterWorldRevision')
ACTIVATION_FILES = ('activation-before.json', 'activation-after.json', 'activation.jsonl')


def activation_snapshot(database):
    """Retain safe rows even when the guard or singleton is invalid. Validate later."""
    snapshot = {'version': 1, 'databasePath': str(database), 'startedAtMs': time.time_ns() // 1_000_000,
                'rows': {}, 'errors': {}}
    try: snapshot['guard'] = capture(database)
    except (OSError, ValueError, sqlite3.Error) as error: snapshot['errors']['guard'] = str(error)
    columns = json.loads(REGISTRY.read_text())
    try:
        with closing(connect(database)) as db:
            db.execute('BEGIN')
            for table in ACTIVATION_TABLES:
                fields = [expression for col in columns[table] for expression in ('typeof(' + quote(col) + ')', 'CAST(' + quote(col) + ' AS TEXT)')]
                try:
                    rows = [[list(row[i:i + 2]) for i in range(0, len(row), 2)] for row in db.execute('SELECT ' + ','.join(fields) + ' FROM ' + quote(table))]
                    rows.sort(key=lambda row: canonical(row).encode())
                    snapshot['rows'][table] = {'columns': columns[table], 'values': rows}
                except sqlite3.Error as error: snapshot['errors'][table] = str(error)
        identity = regular(database).stat()
        snapshot['rowDatabase'] = {'device': identity.st_dev, 'inode': identity.st_ino}
    except (OSError, ValueError, sqlite3.Error) as error: snapshot['errors']['rows'] = str(error)
    snapshot['finishedAtMs'] = time.time_ns() // 1_000_000
    return snapshot


def validate_activation_transition(before, after):
    columns = json.loads(REGISTRY.read_text())
    decoded = []
    for snapshot in (before, after):
        guard = snapshot.get('guard', {})
        if snapshot.get('version') != 1 or snapshot.get('errors') != {} or not guard:
            raise ValueError('ACTIVATION_SNAPSHOT_INVALID')
        if (set(guard['tables']) != set(columns) or guard['registrySha256'] != file_hash(REGISTRY)
                or guard['foreignKeys'] != 1 or guard['foreignKeyViolations'] != 0
                or guard['database'] != snapshot.get('rowDatabase')):
            raise ValueError('ACTIVATION_GUARD_INVALID')
        times = [snapshot.get(key) for key in ('startedAtMs', 'finishedAtMs')]
        if any(type(t) is not int or t <= 0 for t in times) or times[0] > times[1]:
            raise ValueError('ACTIVATION_CAPTURE_TIME_INVALID')
        values = {}
        for table in ACTIVATION_TABLES:
            retained = snapshot['rows'].get(table, {})
            rows = retained.get('values', [])
            if retained.get('columns') != columns[table] or len(rows) != 1 or len(rows[0]) != len(columns[table]):
                raise ValueError('ACTIVATION_SINGLETON_INVALID:' + table)
            if guard['tables'][table] != {'rows': 1, 'sha256': hash_value(rows)}:
                raise ValueError('ACTIVATION_ROW_GUARD_MISMATCH:' + table)
            row = []
            for cell in rows[0]:
                if not isinstance(cell, list) or len(cell) != 2: raise ValueError('ACTIVATION_CELL_INVALID')
                kind, value = cell
                if kind == 'integer' and isinstance(value, str) and re.fullmatch(r'0|-?[1-9][0-9]*', value): row.append(int(value))
                elif kind == 'text' and isinstance(value, str): row.append(value)
                elif kind == 'null' and value is None: row.append(None)
                else: raise ValueError('ACTIVATION_CELL_INVALID')
            values[table] = row
        schema, revision = (values[table] for table in ACTIVATION_TABLES)
        if (any(type(schema[i]) is not int for i in (0, 1, 4, 5)) or schema[:2] != [1, 2]
                or not isinstance(schema[3], str) or not schema[3]
                or not isinstance(schema[6], str) or not re.fullmatch('[0-9a-f]{64}', schema[6])
                or list(guard['state'] or []) != schema[1:]):
            raise ValueError('ACTIVATION_SCHEMA_ROW_INVALID')
        if any(type(v) is not int for v in revision) or revision[0] != 1 or revision[1] < 0:
            raise ValueError('ACTIVATION_REVISION_ROW_INVALID')
        decoded.append(values)
    first, last = before['guard'], after['guard']
    if before['databasePath'] != after['databasePath'] or before['finishedAtMs'] > after['startedAtMs']:
        raise ValueError('ACTIVATION_BOUNDARY_INVALID')
    for key in ('version', 'database', 'schemaSha256', 'registrySha256', 'foreignKeys', 'foreignKeyViolations'):
        if first[key] != last[key]: raise ValueError('ACTIVATION_GUARD_CHANGED:' + key)
    old, new = (value['QuarterSchema'] for value in decoded)
    if old[2] != 'prepared' or old[4:6] != [1, 1] or old[7] is not None:
        raise ValueError('ACTIVATION_NOT_PREPARED')
    if (new[:2] != old[:2] or new[2] != 'active' or new[3] != old[3] or new[4:6] != [2, 2]
            or new[6] != old[6] or type(new[7]) is not int or new[7] <= 0
            or not before['finishedAtMs'] <= new[7] <= after['startedAtMs']):
        raise ValueError('ACTIVATION_SCHEMA_TRANSITION_INVALID')
    if decoded[1]['QuarterWorldRevision'][1] != decoded[0]['QuarterWorldRevision'][1] + 1:
        raise ValueError('ACTIVATION_REVISION_TRANSITION_INVALID')
    changed = [table for table in first['tables'] if table not in ACTIVATION_TABLES and first['tables'][table] != last['tables'][table]]
    if changed: raise ValueError('ACTIVATION_DATA_CHANGED:' + ','.join(changed))


def retain_activation(database, out, action):
    before_path, after_path = (out / name for name in ACTIVATION_FILES[:2])
    if before_path.exists() or after_path.exists(): raise ValueError('ACTIVATION_EVIDENCE_EXISTS')
    before = activation_snapshot(database); atomic_json(before_path, before)
    try: action()
    finally:
        after = activation_snapshot(database); atomic_json(after_path, after)
    # Both raw snapshots exist before the first assertion, including failed runs.
    validate_activation_transition(before, after)
    return {name: file_hash(out / name) for name in ACTIVATION_FILES}


def validate_activation_evidence(out, measured, fixture):
    binding = measured.get('activationEvidence', {})
    if set(binding) != set(ACTIVATION_FILES): raise ValueError('ACTIVATION_EVIDENCE_REQUIRED')
    for name, digest in binding.items():
        if file_hash(out / name) != digest: raise ValueError('ACTIVATION_EVIDENCE_CHANGED:' + name)
    before, after = (json.loads((out / name).read_text()) for name in ACTIVATION_FILES[:2])
    validate_activation_transition(before, after)
    if (before['databasePath'] != fixture['database']
            or [before['guard']['database'][key] for key in ('device', 'inode')] != fixture['identity']):
        raise ValueError('ACTIVATION_DATABASE_MISMATCH')
    events = [json.loads(line) for line in (out / 'activation.jsonl').read_text().splitlines()]
    if (len(events) != 1 or events[0].get('action') != 'activated'
            or events[0].get('guard') != after['guard'] or events[0].get('clients') != measured['readerProof']):
        raise ValueError('ACTIVATION_JOURNAL_MISMATCH')
    return {'measurements/' + name: digest for name, digest in binding.items()}


def run(root, fixture, database, packet_path):
    root = Path(root); database = disposable(database); app = root / 'app'
    verify(app, file_hash(app / MANIFEST), database)
    out = root / 'evidence/measurements'; out.mkdir()
    packet = load_packet(packet_path)
    service = synthetic_service(app, database, 3100, out)
    try:
        service.start()
        command = ['node', '--import', str(app / 'node_modules/tsx/dist/loader.mjs'), str(app / 'scripts/quarter-rehearsal-measurements.ts'), str(out)]
        env = dict(os.environ, FLOOR_BOARDS_TEST_ROOT=str(root), DATABASE_URL='file:' + str(database)); env.pop('NODE_OPTIONS', None)
        with (out / 'collector.log').open('x') as output:
            result = subprocess.run(command, cwd=app, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=180)
        record(out / 'events.jsonl', 'collector', exit=result.returncode, outputSha256=file_hash(out / 'collector.log'))
        if result.returncode: raise ValueError('MEASURED_CLIENT_COLLECTION_FAILED')
        original_inventory = json.loads((out / 'inventory.json').read_text()); original_records = json.loads((out / 'readbacks.json').read_text())
        guard = capture(database)
        def evidence(inventory, records, label):
            directory = out / label; directory.mkdir()
            inv = directory / 'inventory.json'; rec = directory / 'readbacks.json'
            atomic_json(inv, inventory); atomic_json(rec, records)
            return {**packet, 'clients': {'inventoryPath': str(inv), 'inventorySha256': file_hash(inv), 'readbacksPath': str(rec), 'readbacksSha256': file_hash(rec)}}
        accepted = evidence(original_inventory, original_records, 'original')
        proof = readbacks(accepted, app, guard)
        record(out / 'events.jsonl', 'actual-readbacks-accepted', proof=proof)
        for label in ('missing', 'duplicate', 'expired', 'origin', 'build', 'epoch', 'inventory', 'challenge'):
            inv = json.loads(json.dumps(original_inventory)); records = json.loads(json.dumps(original_records)); now = None
            if label == 'missing': records.pop()
            if label == 'duplicate': records[1] = records[0]
            if label == 'expired': now = 4102444800000
            if label == 'origin': records[0]['measurement']['origin'] = 'http://wrong.test:3100'
            if label == 'build': records[0]['measurement']['clientBuildSha'] = '0' * 40
            if label == 'epoch': records[0]['measurement']['observedDatabaseEpoch'] = 'wrong'
            if label == 'inventory': inv['revision'] = 'changed'
            if label == 'challenge': records[0]['measurement']['challengeId'] = records[1]['challengeId']
            altered = evidence(inv, records, label)
            try: readbacks(altered, app, guard, now)
            except (ValueError, FileNotFoundError): record(out / 'events.jsonl', 'readback-refused', case=label)
            else: raise ValueError('MEASUREMENT_FALSE_ACCEPTANCE:' + label)
        # Original evidence remains accepted after probing only separate copies.
        if readbacks(accepted, app, guard) != proof: raise ValueError('MEASURED_ORIGINAL_CHANGED')
        activation_evidence = {}
        if packet.get('syntheticR0SelfRehearsal'):
            before = capture(database)
            try: activate(packet_path, app, database, out / 'activation.jsonl')
            except ValueError as error:
                if str(error) != 'ACTUAL_Q1_PIN_REQUIRED': raise
                record(out / 'events.jsonl', 'activation-refused', code=str(error))
            else: raise ValueError('R0_SELF_ACTIVATION_FALSE_ACCEPTANCE')
            preserved(before, capture(database)); activation = 'actual-Q1-required'
        else:
            # This branch requires separately reviewed real R0/Q1 runtime pins.
            # Importer proof has already drained all synthetic importers and supplied
            # a fresh public inventory. No installed descriptor or provider is read.
            importers = root / 'evidence/importers-prepared/inventory.json'
            accepted['importers'] = {'inventoryPath': str(importers), 'inventorySha256': file_hash(importers)}
            active_packet = out / 'activation-packet.json'; atomic_json(active_packet, accepted)
            activation_evidence = retain_activation(database, out, lambda: activate(active_packet, app, database, out / 'activation.jsonl'))
            activation = 'synthetic-actual-q1'
        atomic_json(out / 'completed.json', {'synthetic': True, 'realLoadedProfiles': 2, 'readerProof': proof, 'activation': activation, 'activationEvidence': activation_evidence, 'serviceProfileSha256': service.profile_sha})
    finally: service.stop()
