#!/usr/bin/env python3
"""One-file synthetic quarter rehearsal. Init alone may create schema on a new empty DB."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
# Ignore all cached application bytecode before importing the pinned source modules.
import sys
sys.dont_write_bytecode = True
sys.pycache_prefix = str(Path(__file__).resolve().parent / '.no-bytecode-cache')
if Path(sys.pycache_prefix).exists() or Path(sys.pycache_prefix).is_symlink():
    raise ValueError('Packet bytecode prefix must remain absent')
from quarter_guard import canonical, capture, disposable, file_hash, preserved
from quarter_artifacts import MANIFEST, atomic_json, copy, verify
from quarter_release import activate, load_packet, record

APP = Path(__file__).resolve().parent.parent
SCENARIOS = ['normal-r0-q1-r0-q1', 'explicit-rollback-after-write', 'checker-reject-after-write', 'checker-timeout-after-write',
             'recovery-failure-offline', 'incompatible-target-never-starts', 'r0-self-rollback', 'r0-self-reject', 'r0-self-timeout', 'r0-self-blocked', 'r0-self-incompatible', 'r0-self-roundtrip', *['r0-self-fault-' + phase for phase in ('before-promote','after-promote','after-start','readback','recovery-verify')]]


def fixture(root):
    root = Path(root).absolute(); value = json.loads((root / 'fixture.json').read_text())
    database = disposable(value['database'], root)
    if [database.stat().st_dev, database.stat().st_ino] != value['identity']:
        raise ValueError('REHEARSAL_DATABASE_REPLACED')
    return value, database


def run_command(root, argv, database):
    env = dict(os.environ, FLOOR_BOARDS_TEST_ROOT=str(root), DATABASE_URL='file:' + str(database), NEXT_TELEMETRY_DISABLED='1', PYTHONDONTWRITEBYTECODE='1')
    env['NODE_OPTIONS'] = '--require=' + str(APP / 'scripts/test-db-guard.cjs')
    number = time.time_ns(); log = root / 'evidence' / (str(number) + '.log')
    record(root / 'evidence/commands.jsonl', 'start', argv=argv, database=str(database))
    with log.open('wb') as output:
        result = subprocess.run(argv, cwd=APP, env=env, stdout=output, stderr=subprocess.STDOUT)
    record(root / 'evidence/commands.jsonl', 'finish', argv=argv, exit=result.returncode, outputLog=str(log), sha256=file_hash(log))
    if result.returncode:
        raise ValueError('REHEARSAL_COMMAND_FAILED:' + str(log))


def init(root, date, bootstrap_hourly=False):
    root = Path(root).absolute()
    if root.parent != Path('/tmp').resolve() or not re.fullmatch(r'color-boards-test-[A-Za-z0-9]+', root.name):
        raise ValueError('TEST_DB_ROOT_NOT_DISPOSABLE')
    verify(APP, file_hash(APP / MANIFEST))
    root.mkdir()  # Existing roots, including failed prior runs, are never reused as new.
    (root / 'evidence').mkdir(); (root / 'data').mkdir()
    database = root / 'data/floor-boards.db'; database.touch(exist_ok=False); disposable(database, root)
    if database.stat().st_size != 0:
        raise ValueError('INIT_DATABASE_NOT_EMPTY')
    # The only destructive-schema command in the harness: exclusive empty-file initialization.
    run_command(root, ['node', str(APP / 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'], database)
    run_command(root, ['node', str(APP / 'node_modules/tsx/dist/cli.mjs'), 'scripts/quarter-rehearsal-init.ts', date], database)
    runtime = copy(APP, root / 'r0', file_hash(APP / MANIFEST), runtime=True)
    if bootstrap_hourly:
        from quarter_bootstrap_rehearsal import rehearse
        rehearse(root, APP, runtime, database)
    else:
        run_command(root, ['node', str(APP / 'node_modules/tsx/dist/cli.mjs'), 'scripts/quarter-migrate.ts'], database)
        copy(runtime, root / 'app', file_hash(runtime / MANIFEST))
    value = {'version': 1, 'synthetic': True, 'date': date, 'database': str(database), 'identity': [database.stat().st_dev, database.stat().st_ino], 'r0': {'path': str(runtime), 'manifestSha256': file_hash(runtime / MANIFEST)}}
    atomic_json(root / 'fixture.json', value); atomic_json(root / 'evidence/prepared-guard.json', capture(database))
    return value


def verify_r0(root, database, value, packet):
    if packet.get('syntheticR0SelfRehearsal') is not True:
        raise ValueError('R0_SELF_PACKET_REQUIRED')
    app = root / 'app'; manifest = verify(app, value['r0']['manifestSha256'], database)
    if manifest['role'] != 'QP_COMPAT_R0': raise ValueError('R0_SELF_ARTIFACT_REQUIRED')
    from quarter_managed_service import listeners
    if listeners(3100) or any((app / 'var/run' / name).exists() for name in ('quarter-owned-service.json', 'quarter-service-launch-intent.json')):
        raise ValueError('REHEARSAL_CLEANUP_REQUIRED')
    records = [json.loads(line) for line in (root / 'evidence/rehearsal.jsonl').read_text().splitlines()]
    required = [name for name in SCENARIOS if name.startswith('r0-self-')]
    cases = [row for row in records if row.get('outcome') == 'controller-passed']
    if sorted(row['scenario'] for row in cases) != sorted(required): raise ValueError('R0_CONTROLLER_PROOFS_INCOMPLETE')
    if not any(row.get('action') == 'migration-repeat' for row in records): raise ValueError('MIGRATION_REPEAT_PROOF_REQUIRED')
    paths = ['bootstrap/bootstrap-events.jsonl', 'measurements/completed.json', 'importers-prepared/completed.json', 'importers-active/completed.json',
             'agent-before/completed.json', 'agent-after/completed.json', 'picker-matrix-before.json', 'picker-matrix-after.json', 'environment/completed.json']
    evidence = {name: file_hash(root / 'evidence' / name) for name in paths}
    def read(name): return json.loads((root / 'evidence' / name).read_text())
    bootstrap_records = [json.loads(line) for line in (root / 'evidence' / paths[0]).read_text().splitlines()]
    if bootstrap_records[-1].get('action') != 'accepted': raise ValueError('HOURLY_BOOTSTRAP_PROOF_REQUIRED')
    from quarter_rehearsal_environment import delivered_files
    environment = read('environment/completed.json')
    expected_observations = [{'mode': mode, 'parentDatabaseAbsent': True, 'envFileFlag': False, 'path': str(database), 'device': database.stat().st_dev, 'inode': database.stat().st_ino, 'launchDirectory': str(cwd), 'app': str(app)} for cwd in (app, root / 'environment-other-cwd') for mode in ('shared', 'direct')]
    if environment.get('runtimeManifestSha256') != value['r0']['manifestSha256'] or environment.get('observations') != expected_observations or environment.get('database') != capture(database)['database'] or environment.get('configurationRemoved') is not True or environment.get('deliveredFiles') != delivered_files(app, manifest):
        raise ValueError('ENVIRONMENT_PROOFS_INCOMPLETE')
    measured = read('measurements/completed.json')
    if measured.get('realLoadedProfiles') != 2 or measured.get('activation') != 'actual-Q1-required': raise ValueError('CLIENT_PROOFS_INCOMPLETE')
    for phase in ('prepared', 'active'):
        imported = read('importers-' + phase + '/completed.json')
        if imported.get('phase') != phase or imported.get('compatibleDrain') is not True or imported.get('hourlyCurrentAndNextWeek') is not True or imported.get('database') != capture(database)['database']:
            raise ValueError('IMPORTER_PROOFS_INCOMPLETE')
    for mode in ('before', 'after'):
        command = read('agent-' + mode + '/completed.json')
        if command.get('mode') != mode or command.get('originalReceiptReplay') is not True or command.get('runtimeManifestSha256') != value['r0']['manifestSha256']:
            raise ValueError('HOST_COMMAND_PROOFS_INCOMPLETE')
    if read('picker-matrix-before.json') != read('picker-matrix-after.json') or len(read('picker-matrix-before.json')) != 11:
        raise ValueError('PICKER_RECOVERY_PROOFS_INCOMPLETE')
    report = {'outcome': 'r0-self-composed-passed', 'synthetic': True, 'independentAcceptance': False,
              'artifact': value['r0'], 'sourceSha': manifest['sourceSha'], 'scenarios': required,
              'actualQ1Pending': SCENARIOS[:6], 'evidenceSha256': evidence, 'guard': capture(database)}
    atomic_json(root / 'evidence/r0-verification.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('init', 'check-migration-repeat', 'activate', 'run', 'verify', 'verify-r0', 'picker-matrix', 'importer-proofs', 'agent-proofs', 'client-proofs', 'environment-proofs'):
        p = sub.add_parser(action); p.add_argument('--root', required=True)
        if action == 'init':
            p.add_argument('--date', required=True)
            p.add_argument('--bootstrap-hourly', action='store_true')
        else:
            p.add_argument('--manifest', required=True)
        if action == 'activate':
            p.add_argument('--inventory', required=True); p.add_argument('--client-evidence', required=True)
        if action in ('picker-matrix', 'agent-proofs'):
            p.add_argument('--mode', choices=['before','after'], required=True)
        if action == 'run':
            p.add_argument('--scenario', choices=SCENARIOS, required=True)
    args = parser.parse_args(); root = Path(args.root).absolute()
    if args.action == 'init':
        print(canonical(init(root, args.date, args.bootstrap_hourly))); return
    value, database = fixture(root); os.environ['FLOOR_BOARDS_TEST_ROOT'] = str(root); os.environ['DATABASE_URL'] = 'file:' + str(database)
    def interrupted(signum, frame):
        record(root / 'evidence/signals.jsonl', 'signal-received', signal=signum, pid=os.getpid(), parentPid=os.getppid(), processGroup=os.getpgrp(), operation=args.action)
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    packet = load_packet(args.manifest)
    if args.action == 'verify-r0':
        print(canonical(verify_r0(root, database, value, packet))); return
    if args.action == 'environment-proofs':
        from quarter_rehearsal_environment import run
        run(root,value,database);return
    if args.action == 'client-proofs':
        from quarter_rehearsal_measurements import run
        run(root,value,database,args.manifest);return
    if args.action == 'agent-proofs':
        from quarter_rehearsal_agent import run
        run(root,value,database,args.mode);return
    if args.action == 'importer-proofs':
        from quarter_rehearsal_importers import run
        run(root,value,database);return
    if args.action == 'picker-matrix':
        app=root/'app';verify(app,file_hash(app/MANIFEST),database)
        output=root/'evidence'/('picker-matrix-'+args.mode+'.json')
        if output.exists():raise ValueError('PICKER_MATRIX_EVIDENCE_EXISTS')
        run_command(root,['node',str(app/'node_modules/tsx/dist/cli.mjs'),'--tsconfig',str(app/'tsconfig.json'),str(app/'scripts/quarter-rehearsal-picker-matrix.ts'),value['date'],args.mode,str(output),str(root/'evidence/picker-matrix-before.json')],database)
        record(root/'evidence/rehearsal.jsonl','picker-matrix-proof',mode=args.mode,evidenceSha256=file_hash(output));return
    if args.action == 'check-migration-repeat':
        before = capture(database)
        run_command(root, ['node', str(APP / 'node_modules/tsx/dist/cli.mjs'), 'scripts/quarter-migrate.ts'], database)
        after = capture(database)
        # The shared mutex timestamp is a recorded transaction boundary, not schema change.
        if before['state'] != after['state'] or before['schemaSha256'] != after['schemaSha256']:
            raise ValueError('MIGRATION_REPEAT_CHANGED_SCHEMA')
        for table in before['tables']:
            if table != 'StaffBreakLock' and before['tables'][table] != after['tables'][table]:
                raise ValueError('MIGRATION_REPEAT_CHANGED_DATA:' + table)
        record(root / 'evidence/rehearsal.jsonl', 'migration-repeat', before=before, after=after)
    elif args.action == 'activate':
        if packet.get('clients', {}).get('inventoryPath') != args.inventory or packet.get('clients', {}).get('readbacksPath') != args.client_evidence:
            raise ValueError('CLIENT_PACKET_PIN_MISMATCH')
        activate(args.manifest, root / 'app', database, root / 'evidence/rehearsal.jsonl')
    elif args.action == 'run':
        from quarter_scenarios import run_scenario
        run_scenario(root, args.manifest, args.scenario)
    else:
        records = [json.loads(line) for line in (root / 'evidence/rehearsal.jsonl').read_text().splitlines()]
        done = {r.get('scenario') for r in records if r.get('outcome') == 'passed'}
        required = SCENARIOS[:6]
        report = {'synthetic': True, 'sameFile': value['identity'], 'guard': capture(database), 'passed': sorted(done), 'pending': [s for s in required if s not in done]}
        atomic_json(root / 'evidence/verification.json', report); print(canonical(report))
        if report['pending']:
            raise SystemExit(2)


if __name__ == '__main__':
    main()
