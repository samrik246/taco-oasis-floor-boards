#!/usr/bin/env python3
"""One-file synthetic quarter rehearsal. Init alone may create schema on a new empty DB."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from quarter_guard import canonical, capture, disposable, file_hash, preserved
from quarter_artifacts import MANIFEST, atomic_json, copy, verify
from quarter_release import activate, load_packet, record

APP = Path(__file__).resolve().parent.parent
SCENARIOS = ['normal-r0-q1-r0-q1', 'explicit-rollback-after-write', 'checker-reject-after-write', 'checker-timeout-after-write',
             'recovery-failure-offline', 'incompatible-target-never-starts', 'r0-self-rollback', 'r0-self-reject', 'r0-self-timeout', 'r0-self-blocked', 'r0-self-incompatible']


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


def init(root, date):
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
    run_command(root, ['node', str(APP / 'node_modules/tsx/dist/cli.mjs'), 'scripts/quarter-migrate.ts'], database)
    runtime = copy(APP, root / 'r0', file_hash(APP / MANIFEST), runtime=True)
    copy(runtime, root / 'app', file_hash(runtime / MANIFEST))
    value = {'version': 1, 'synthetic': True, 'date': date, 'database': str(database), 'identity': [database.stat().st_dev, database.stat().st_ino], 'r0': {'path': str(runtime), 'manifestSha256': file_hash(runtime / MANIFEST)}}
    atomic_json(root / 'fixture.json', value); atomic_json(root / 'evidence/prepared-guard.json', capture(database))
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('init', 'check-migration-repeat', 'activate', 'run', 'verify'):
        p = sub.add_parser(action); p.add_argument('--root', required=True)
        if action == 'init':
            p.add_argument('--date', required=True)
        else:
            p.add_argument('--manifest', required=True)
        if action == 'activate':
            p.add_argument('--inventory', required=True); p.add_argument('--client-evidence', required=True)
        if action == 'run':
            p.add_argument('--scenario', choices=SCENARIOS, required=True)
    args = parser.parse_args(); root = Path(args.root).absolute()
    if args.action == 'init':
        print(canonical(init(root, args.date))); return
    value, database = fixture(root); os.environ['FLOOR_BOARDS_TEST_ROOT'] = str(root); os.environ['DATABASE_URL'] = 'file:' + str(database)
    packet = load_packet(args.manifest)
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
