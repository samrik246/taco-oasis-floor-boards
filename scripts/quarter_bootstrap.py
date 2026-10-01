"""Initial pinned hourly-to-R0 bridge. Additive migration only; no hourly recovery."""
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import json
import quarter_artifacts as artifacts
from quarter_guard import capture, canonical, connect, file_hash, hash_value, QUARTER_TABLES
from quarter_release import load_packet, release_lease, target, promote, record
from quarter_service import group_alive

# Fixed existing code/dependency roots, excluding environment, data and private browser state.
LEGACY_ROOTS = ['.next', 'public', 'src/lib', 'prisma/schema.prisma', 'package.json',
                'pnpm-lock.yaml', 'tsconfig.json', 'next.config.ts', 'scripts/import-from-folder.ts',
                'scripts/wiw-export.ts', 'scripts/release-lock.sh', 'RELEASE_SHA', 'node_modules']


def legacy_inventory(app):
    return artifacts.inventory(app, roots=LEGACY_ROOTS)


def verify_legacy(app, pin):
    sha = Path(app, 'RELEASE_SHA').read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{40}', sha) or sha != pin.get('sourceSha'):
        raise ValueError('BOOTSTRAP_LEGACY_SOURCE_MISMATCH')
    if hash_value(legacy_inventory(app)) != pin.get('treeSha256'):
        raise ValueError('BOOTSTRAP_LEGACY_TREE_MISMATCH')
    return sha


def before_migration(database):
    with connect(database) as db:
        ddl = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
        present = {r[1] for r in ddl if r[0] == 'table'} & QUARTER_TABLES
        if present:
            if present != QUARTER_TABLES:
                raise ValueError('BOOTSTRAP_PARTIAL_SCHEMA')
            phase = db.execute('SELECT phase FROM QuarterSchema WHERE id=1').fetchall()
            if phase != [('prepared',)] or any(db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in ('PaintHour', 'PaintSegment', 'PaintMutation', 'PaintCommandReceipt')):
                raise ValueError('BOOTSTRAP_REQUIRES_PREPARED_EMPTY')
    return {'guard': capture(database, include_quarter=bool(present)), 'ddl': ddl}


def migration_preserved(before, after, database):
    original = before['guard']
    for key in ('database', 'foreignKeys', 'foreignKeyViolations', 'registrySha256'):
        if original[key] != after[key]:
            raise ValueError('BOOTSTRAP_PRESERVATION_CHANGED:' + key)
    for table, value in original['tables'].items():
        # The migration records this one shared mutex transaction boundary.
        if table != 'StaffBreakLock' and value != after['tables'][table]:
            raise ValueError('BOOTSTRAP_PRESERVATION_CHANGED:' + table)
    if original['state'] is not None and original['state'] != after['state']:
        raise ValueError('BOOTSTRAP_EPOCH_CHANGED')
    with connect(database) as db:
        ddl = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
        by_name = {(r[0], r[1]): r for r in ddl}
        for row in before['ddl']:
            if tuple(row) != by_name.get((row[0], row[1])):
                raise ValueError('BOOTSTRAP_EXISTING_DDL_CHANGED:' + row[1])
    # artifacts.verify(database=...) separately requires the target's exact complete DDL hash.


def migrate(app, database, claim, run):
    app = Path(app)
    command = ['node', '--import', str(app / 'node_modules/tsx/dist/loader.mjs'),
               str(app / 'scripts/quarter-migrate.ts'), '--controller-claim', claim]
    with (Path(run) / ('migration-' + str(time.time_ns()) + '.log')).open('xb') as output:
        child = subprocess.Popen(command, cwd=app, env=dict(os.environ, DATABASE_URL='file:' + str(database)),
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait(timeout=60)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=2)
            if group_alive(child.pid):
                raise ValueError('BOOTSTRAP_MIGRATION_GROUP_UNRESOLVED')
            raise ValueError('BOOTSTRAP_MIGRATION_TIMEOUT')
    if code or group_alive(child.pid):
        raise ValueError('BOOTSTRAP_MIGRATION_FAILED')


def bootstrap(packet_path, app, database, run, service, checker, resume=False, fault=lambda phase: None):
    app = Path(app).absolute(); database = Path(database).absolute(); run = Path(run).absolute()
    packet = load_packet(packet_path); log = run / 'bootstrap-events.jsonl'; journal = run / 'bootstrap.json'
    synthetic = packet.get('syntheticR0SelfRehearsal', False)
    if synthetic:
        from quarter_guard import synthetic_paths
        synthetic_paths(database, app, run)
    from quarter_guard import release_paths, directory_handle
    app, run = release_paths(app, run)
    with directory_handle(run, create=True): pass
    binding = {'packetSha256': file_hash(packet_path), 'app': str(app), 'database': str(database)}
    with release_lease(app) as owned:
        target(packet, 'r0', None, accepted=not synthetic)
        if resume:
            retained = json.loads(journal.read_text())
            if any(retained[k] != value for k, value in binding.items()):
                raise ValueError('BOOTSTRAP_RESUME_BINDING_MISMATCH')
            identity = database.stat()
            if retained['before']['guard']['database'] != {'device': identity.st_dev, 'inode': identity.st_ino}:
                raise ValueError('BOOTSTRAP_DATABASE_REPLACED')
            # A surviving compatible server may have acknowledged prepared/hourly writes.
            # Stop first and take a fresh preservation expectation; never restore the old guard.
            prior = before_migration(database)
            if prior['guard']['state'] is not None:
                target(packet, 'r0', database, accepted=not synthetic)
            else:
                migration_preserved(retained['before'], prior['guard'], database)
        else:
            if journal.exists():
                raise ValueError('BOOTSTRAP_RESUME_REQUIRED')
            verify_legacy(app, packet.get('legacy', {}))
            before_migration(database)  # Refuse active/partial data before disturbing a healthy service.
        owned(); fault('before-stop'); service.stop()
        before = before_migration(database)
        if not resume:
            # Pin source again after shutdown, then retain the post-drain database expectation.
            verify_legacy(app, packet['legacy'])
            artifacts.atomic_json(journal, {**binding, 'before': before})
        record(log, 'post-stop', guard=before['guard'], resumed=resume)
        try:
            owned(); target(packet, 'r0', None, accepted=not synthetic); fault('before-promote')
            promote(packet['r0']['path'], app, packet['r0']['manifestSha256'], run)
            # Promotion alone must not touch even the mutex timestamp.
            current = before_migration(database)
            if canonical(current) != canonical(before):
                raise ValueError('BOOTSTRAP_PROMOTION_CHANGED_DATABASE')
            fault('before-migrate'); migrate(app, database, owned(), run)
            after = capture(database)
            migration_preserved(before, after, database)
            target(packet, 'r0', database, accepted=not synthetic)
            artifacts.verify(app, packet['r0']['manifestSha256'], database); owned()
            record(log, 'migration-verified', guard=after); fault('after-migrate')
            service.start(); service.readback(); fault('after-start')
            record(log, 'checker-wait', target='r0')
            if checker('bootstrap') != 'pass':
                raise ValueError('BOOTSTRAP_CHECKER_FAILED')
            owned(); service.readback(); owned()
            record(log, 'accepted', guard=capture(database)); return 'accepted'
        except Exception as failure:
            # There is intentionally no old hourly target on this forward migration path.
            # Cleanup failure propagates; it must not be mislabeled as safely stopped.
            service.stop()
            record(log, 'recovery-blocked', error=str(failure), guard=before_migration(database)['guard'])
            return 'recovery-blocked'
