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


def init(root, date, bootstrap_hourly=False, accepted_r0=None, accepted_r0_manifest=None):
    root = Path(root).absolute()
    if root.parent != Path('/tmp').resolve() or not re.fullmatch(r'color-boards-test-[A-Za-z0-9]+', root.name):
        raise ValueError('TEST_DB_ROOT_NOT_DISPOSABLE')
    current = verify(APP, file_hash(APP / MANIFEST))
    if current['role'] == 'QP_UI_Q1':
        if not accepted_r0 or not accepted_r0_manifest: raise ValueError('ACCEPTED_R0_PIN_REQUIRED')
        recovery = verify(accepted_r0, accepted_r0_manifest)
        if recovery['role'] != 'QP_COMPAT_R0' or recovery['scope'] != 'runtime' or recovery['sourceSha'] == current['sourceSha']:
            raise ValueError('DISTINCT_RUNTIME_R0_REQUIRED')
    elif accepted_r0 or accepted_r0_manifest: raise ValueError('Q1_SOURCE_REQUIRED')
    root.mkdir()  # Existing roots, including failed prior runs, are never reused as new.
    (root / 'evidence').mkdir(); (root / 'data').mkdir()
    database = root / 'data/floor-boards.db'; database.touch(exist_ok=False); disposable(database, root)
    if database.stat().st_size != 0:
        raise ValueError('INIT_DATABASE_NOT_EMPTY')
    # The only destructive-schema command in the harness: exclusive empty-file initialization.
    run_command(root, ['node', str(APP / 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'], database)
    run_command(root, ['node', str(APP / 'node_modules/tsx/dist/cli.mjs'), 'scripts/quarter-rehearsal-init.ts', date], database)
    runtime = copy(accepted_r0 or APP, root / 'r0', accepted_r0_manifest or file_hash(APP / MANIFEST), runtime=not bool(accepted_r0))
    candidate = copy(APP, root / 'q1', file_hash(APP / MANIFEST), runtime=True) if accepted_r0 else None
    if bootstrap_hourly:
        from quarter_bootstrap_rehearsal import rehearse
        rehearse(root, APP, runtime, database)
    else:
        run_command(root, ['node', str(APP / 'node_modules/tsx/dist/cli.mjs'), 'scripts/quarter-migrate.ts'], database)
        copy(runtime, root / 'app', file_hash(runtime / MANIFEST))
    value = {'version': 1, 'synthetic': True, 'date': date, 'database': str(database), 'identity': [database.stat().st_dev, database.stat().st_ino], 'r0': {'path': str(runtime), 'manifestSha256': file_hash(runtime / MANIFEST)}}
    if candidate: value['candidate'] = {'path': str(candidate), 'manifestSha256': file_hash(candidate / MANIFEST)}
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


def verify_q1(root, database, value, packet):
    if packet.get('syntheticR0SelfRehearsal') or not value.get('candidate'): raise ValueError('ACTUAL_Q1_PACKET_REQUIRED')
    from quarter_release import target
    r0 = target(packet, 'r0', database); q1 = target(packet, 'candidate', database)
    if not q1.get('quarterUi') or r0.get('quarterUi') or q1['sourceSha'] == r0['sourceSha']: raise ValueError('DISTINCT_Q1_UI_REQUIRED')
    from quarter_managed_service import listeners
    app = root / 'app'; current = file_hash(app / MANIFEST)
    if current not in (value['r0']['manifestSha256'], value['candidate']['manifestSha256']): raise ValueError('FINAL_ARTIFACT_UNKNOWN')
    verify(app, current, database)
    if listeners(3100) or any((app / 'var/run' / name).exists() for name in ('quarter-owned-service.json', 'quarter-service-launch-intent.json')): raise ValueError('REHEARSAL_CLEANUP_REQUIRED')
    records = [json.loads(line) for line in (root / 'evidence/rehearsal.jsonl').read_text().splitlines()]
    cases = [row for row in records if row.get('outcome') == 'controller-passed']
    if sorted(row['scenario'] for row in cases) != sorted(SCENARIOS[:6]): raise ValueError('Q1_SCENARIOS_INCOMPLETE')
    evidence = {}
    expected = {'normal-r0-q1-r0-q1': 'accepted', 'explicit-rollback-after-write': 'accepted', 'checker-reject-after-write': 'recovered', 'checker-timeout-after-write': 'recovered', 'recovery-failure-offline': 'recovery-blocked', 'incompatible-target-never-starts': 'preflight-refused'}
    for row in cases:
        scenario = row['scenario']; folder = root / 'evidence/scenarios' / scenario
        if row['controllerOutcome'] != expected[scenario] or row.get('actualBundleCrossings') != ('not-applicable-preflight-refused' if scenario == 'incompatible-target-never-starts' else True): raise ValueError('Q1_CASE_INCOMPLETE:' + scenario)
        if scenario != 'incompatible-target-never-starts':
            seed = json.loads((folder / 'real-bundle-seed.json').read_text())
            if seed.get('role') != 'QP_UI_Q1' or seed.get('sourceSha') != q1['sourceSha'] or seed.get('measurement', {}).get('artifactSha256') != value['candidate']['manifestSha256'] or not seed.get('receipt') or not seed.get('newerIntentId'): raise ValueError('Q1_LOADED_SEED_REQUIRED')
            required_files = ['acknowledged-writes.json', 'post-acknowledgement-guard.json', 'browser-seed.json', 'post-write-read.json']
            if scenario == 'recovery-failure-offline':
                offline = json.loads((folder / 'real-bundle-offline.json').read_text())
                if offline.get('offlinePreserved') is not True or offline.get('after') != seed['after']: raise ValueError('Q1_OFFLINE_BUNDLE_BYTES_CHANGED')
                required_files.append('browser-offline-preserved.json')
            else:
                recovered = json.loads((folder / 'real-bundle-reconciled.json').read_text())
                if recovered.get('role') != 'QP_COMPAT_R0' or recovered.get('sourceSha') != r0['sourceSha'] or recovered.get('measurement', {}).get('artifactSha256') != value['r0']['manifestSha256'] or recovered.get('newerIntentId') != seed['newerIntentId'] or recovered.get('receipt') != seed['receipt']: raise ValueError('R0_LOADED_RECONCILIATION_REQUIRED')
                required_files += ['recovered-day.json', 'replayed.json', 'post-recovery-write.json', 'post-recovery-replay.json', 'browser-reconciled.json']
                if scenario == 'normal-r0-q1-r0-q1':
                    returned = json.loads((folder / 'real-bundle-returned.json').read_text())
                    if returned.get('sourceSha') != q1['sourceSha'] or returned.get('measurement', {}).get('artifactSha256') != value['candidate']['manifestSha256'] or returned['after']['stores'] != recovered['after']['stores'] or returned.get('newerIntentId') != seed['newerIntentId']: raise ValueError('Q1_RETURNED_BUNDLE_REQUIRED')
                    required_files += ['returned-candidate-read.json', 'returned-original-replay.json', 'returned-r0-replay.json', 'browser-returned-candidate.json']
            for name in required_files: file_hash(folder / name)
        # The per-case runner validates all comparisons before emitting its completed record.
        # Bind every retained proof/log here, rather than accepting renamed R0 outcome flags.
        for file in folder.rglob('*'):
            if not file.is_file() or any(part.startswith(('retired-', 'stage-')) or part in ('recovery-target', 'browser-profile', 'real-bundle-profile') for part in file.relative_to(folder).parts): continue
            evidence[str(file.relative_to(root / 'evidence'))] = file_hash(file)
    for name in ('measurements/completed.json', 'importers-prepared/completed.json', 'importers-active/completed.json', 'agent-before/completed.json', 'agent-after/completed.json', 'picker-matrix-before.json', 'picker-matrix-after.json'):
        file = root / 'evidence' / name; evidence[name] = file_hash(file)
    measured = json.loads((root / 'evidence/measurements/completed.json').read_text())
    if measured.get('activation') != 'synthetic-actual-q1' or measured.get('realLoadedProfiles') != 2: raise ValueError('Q1_ACTIVATION_PROOF_REQUIRED')
    for phase in ('prepared', 'active'):
        imported = json.loads((root / 'evidence' / ('importers-' + phase) / 'completed.json').read_text())
        pin = value['r0' if phase == 'prepared' else 'candidate']['manifestSha256']
        if imported.get('runtimeManifestSha256') != pin or imported.get('compatibleDrain') is not True or imported.get('hourlyCurrentAndNextWeek') is not True: raise ValueError('Q1_IMPORTER_PROOF_REQUIRED')
    for mode in ('before', 'after'):
        host = json.loads((root / 'evidence' / ('agent-' + mode) / 'completed.json').read_text())
        if host.get('runtimeManifestSha256') != value['candidate' if mode == 'before' else 'r0']['manifestSha256'] or host.get('originalReceiptReplay') is not True: raise ValueError('Q1_HOST_PROOF_REQUIRED')
    before = json.loads((root / 'evidence/picker-matrix-before.json').read_text()); after = json.loads((root / 'evidence/picker-matrix-after.json').read_text())
    if before != after or len(before) != 11: raise ValueError('Q1_PICKER_PROOF_REQUIRED')
    for mode, role in (('before', 'candidate'), ('after', 'r0')):
        matching = [r for r in records if r.get('action') == 'picker-matrix-proof' and r.get('mode') == mode]
        if len(matching) != 1 or matching[0].get('artifactSha256') != value[role]['manifestSha256']: raise ValueError('Q1_PICKER_ARTIFACT_REQUIRED')
    from quarter_rehearsal_nieves import validate as validate_nieves
    evidence.update(validate_nieves(root, value, {'r0': r0['sourceSha'], 'candidate': q1['sourceSha']}, packet.get('qualificationSupport')))
    guard = capture(database)
    if [guard['database']['device'], guard['database']['inode']] != value['identity']: raise ValueError('REHEARSAL_DATABASE_REPLACED')
    report = {'outcome': 'actual-q1-composed-passed', 'synthetic': True, 'independentAcceptance': False, 'r0': value['r0'], 'candidate': value['candidate'], 'scenarios': SCENARIOS[:6], 'pending': [], 'evidenceSha256': evidence, 'guard': guard}
    atomic_json(root / 'evidence/verification.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('init', 'check-migration-repeat', 'activate', 'run', 'verify', 'verify-r0', 'picker-matrix', 'importer-proofs', 'agent-proofs', 'client-proofs', 'environment-proofs', 'nieves-prepared'):
        p = sub.add_parser(action); p.add_argument('--root', required=True)
        if action == 'init':
            p.add_argument('--date', required=True)
            p.add_argument('--bootstrap-hourly', action='store_true')
            p.add_argument('--accepted-r0'); p.add_argument('--accepted-r0-manifest')
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
        print(canonical(init(root, args.date, args.bootstrap_hourly, args.accepted_r0, args.accepted_r0_manifest))); return
    value, database = fixture(root); os.environ['FLOOR_BOARDS_TEST_ROOT'] = str(root); os.environ['DATABASE_URL'] = 'file:' + str(database)
    def interrupted(signum, frame):
        record(root / 'evidence/signals.jsonl', 'signal-received', signal=signum, pid=os.getpid(), parentPid=os.getppid(), processGroup=os.getpgrp(), operation=args.action)
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    packet = load_packet(args.manifest)
    if args.action == 'verify-r0':
        print(canonical(verify_r0(root, database, value, packet))); return
    if args.action == 'nieves-prepared':
        from datetime import date, timedelta
        from quarter_rehearsal_nieves import run
        run(root, value, 'prepared', (date.fromisoformat(value['date']) + timedelta(days=120)).isoformat(), packet.get('qualificationSupport')); return
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
        record(root/'evidence/rehearsal.jsonl','picker-matrix-proof',mode=args.mode,artifactSha256=file_hash(app/MANIFEST),evidenceSha256=file_hash(output));return
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
        print(canonical(verify_q1(root, database, value, packet)))


if __name__ == '__main__':
    main()
