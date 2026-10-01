#!/usr/bin/env python3
"""B4 packet CLI. Cutover requires the existing shared lock and independent read-back."""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import sqlite3
import subprocess
import sys
import time
import uuid
import urllib.request
from zoneinfo import ZoneInfo
# -B alone prevents writes, not reads of previously cached application bytecode.
# Use a deliberately absent prefix before importing any packet module.
sys.dont_write_bytecode = True
sys.pycache_prefix = str(Path(__file__).resolve().parent / '.no-bytecode-cache')
if Path(sys.pycache_prefix).exists() or Path(sys.pycache_prefix).is_symlink():
    raise ValueError('Packet bytecode prefix must remain absent')
from b4_artifacts import (NEST, RUNTIME, clean_env, copy_runtime, digest,
                          pack, prepare, prior_permissions, promote, verify, write_json)

APP = NEST / 'COLOR_BOARDS_APP'
DATABASE = APP / 'var/data/floor-boards.db'
LABEL = 'com.taco-oasis.wiw-export'
# T MAC MINI's existing schedule, observed read-only for S4-P2. Includes both
# original 07:00/16:00 requirements; never reconfigure the timer at cutover.
IMPORT_HOURS = list(range(6, 22))


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def record(run, action, **fields):
    row = {'time': stamp(), 'action': action, **fields}
    with (run / 'events.jsonl').open('a') as stream:
        stream.write(json.dumps(row) + '\n'); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps(row), flush=True)


def metadata(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('Expected an existing regular file: ' + str(path))
    s = path.stat()
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_mode]


def require_hourly_packet_database(database):
    """Foundation is not the reviewed V2 recovery controller. Refuse before changing services."""
    with sqlite3.connect(Path(database).as_uri() + '?mode=ro', uri=True) as db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='QuarterSchema'").fetchone():
            raise ValueError('QUARTER_COMPATIBLE_RECOVERY_PACKET_REQUIRED')


def guard(database):
    """Read only safe invariant columns. No credential selection, row export or DB copy."""
    database = Path(database)
    require_hourly_packet_database(database)
    identity = metadata(database)[:2]
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('Database integrity failed')
        columns = db.execute('PRAGMA table_info("Manager")').fetchall()
        linkage = [c for c in columns if c[1] == 'employeeId']
        if linkage and (linkage[0][2].upper() != 'TEXT' or linkage[0][3:] != (0, None, 0)):
            raise ValueError('Incompatible linkage column')
        safe = {}
        for key, sql in {
            'managers': 'SELECT rowid,id,active,role,' + ('employeeId' if linkage else 'NULL') + ' FROM Manager ORDER BY rowid',
            'breaks': 'SELECT rowid,id,employeeId,shiftId,board,date,status,startAt,endAt,coverEmployeeId,coverShiftId,auto FROM StaffBreak ORDER BY rowid',
            'shifts': 'SELECT rowid,id,employeeId,board,date,startAt,endAt,boardRemoved,supersededAt FROM Shift ORDER BY rowid',
            'assignments': 'SELECT rowid,id,employeeId,shiftId,stationId,hourStart,hourEnd,seatNumber FROM Assignment ORDER BY rowid',
        }.items():
            rows = db.execute(sql).fetchall()
            import hashlib
            safe[key] = {'count': len(rows), 'sha256': hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()}
        return {'fileIdentity': identity, 'linkagePresent': bool(linkage), 'safeInvariants': safe, 'integrity': 'ok'}


def require_preserved(before, after):
    if before['fileIdentity'] != after['fileIdentity'] or before['safeInvariants'] != after['safeInvariants']:
        raise ValueError('Database identity or protected state changed')


def verify_live_runtime(app, packet, label, dependencies=True, prior_installed=False):
    """Compare managed files only; never walk live var or inspect .env."""
    if prior_installed and (label != 'old' or dependencies):
        raise ValueError('Installed baseline is only valid for the old non-dependency preflight')
    modes = prior_permissions(packet, json.loads((packet / 'manifest.json').read_text())) if prior_installed else {}
    expected = json.loads((packet / (label + '-files.json')).read_text())
    for rel, state in expected.items():
        if not dependencies and rel.startswith("node_modules/"):
            continue
        path = app / rel
        if 'link' in state:
            if not path.is_symlink() or os.readlink(path) != state['link'] or not path.resolve().is_relative_to(app):
                raise ValueError('Installed dependency link mismatch: ' + rel)
        elif not path.is_file() or path.is_symlink() or digest(path) != state['sha256'] or (path.stat().st_mode & 0o7777) != modes.get(rel, state['mode']):
            raise ValueError('Installed asset mismatch: ' + rel)
    return len(expected)


def loaded_calendar(lines):
    """Retain only numeric calendar descriptors; discard all other launchd output."""
    slots, current, depth, invalid = [], None, 0, False
    for line in lines:
        line = line.strip()
        if depth == 0:
            if line == 'event triggers = {': depth = 1
            continue
        if current is not None:
            if line == '}':
                slots.append(current); current = None
            else:
                field = re.fullmatch(r'"(Hour|Minute)"\s*=>\s*(\d+)', line)
                if not field or field[1] in current: invalid = True
                else: current[field[1]] = int(field[2])
        elif line.startswith('stream = ') and line != 'stream = com.apple.launchd.calendarinterval':
            invalid = True
        elif line == 'descriptor = {':
            current = {}
        depth += line.count('{') - line.count('}')
    if invalid or depth or current is not None:
        raise ValueError('Unexpected loaded import calendar descriptor')
    return slots


def timer_state():
    domain = 'gui/' + str(os.getuid())
    # Stream only calendar descriptors. Never retain/print the environment section.
    with subprocess.Popen(['launchctl', 'print', domain + '/' + LABEL], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as proc:
        observed = loaded_calendar(proc.stdout)
        loaded = proc.wait() == 0
    disabled = subprocess.check_output(['launchctl', 'print-disabled', domain], text=True)
    if re.search(r'"' + re.escape(LABEL) + r'"\s*=>\s*true', disabled):
        raise ValueError('Import timer is disabled')
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    # Read only this public schedule field, never the full plist or launchd env.
    raw = subprocess.check_output(['/usr/libexec/PlistBuddy', '-x', '-c', 'Print :StartCalendarInterval', str(plist)])
    slots = plistlib.loads(raw)
    def expected(calendar):
        return (isinstance(calendar, list) and len(calendar) == len(IMPORT_HOURS)
                and all(isinstance(slot, dict) and set(slot) == {'Hour', 'Minute'}
                        and type(slot['Hour']) is int and type(slot['Minute']) is int
                        and slot['Minute'] == 0 for slot in calendar)
                and sorted(slot['Hour'] for slot in calendar) == IMPORT_HOURS)
    run_at_load = subprocess.check_output(['/usr/libexec/PlistBuddy', '-c', 'Print :RunAtLoad', str(plist)], text=True).strip()
    if not loaded or not expected(slots) or not expected(observed) or run_at_load != 'false':
        raise ValueError('Expected enabled hourly 06:00–21:00 import timer missing')
    return {'loaded': True, 'hours': IMPORT_HOURS.copy(), 'minutes': [0] * len(IMPORT_HOURS),
            'loadedCalendar': sorted(observed, key=lambda slot: slot['Hour']), 'runAtLoad': False, 'plistMetadata': metadata(plist)}


def service(packet, action, run):
    if action not in ('start', 'stop', 'status'):
        raise ValueError('Forbidden service action')
    with (run / 'service.log').open('a') as log:
        subprocess.run(['bash', str(packet / 'tools/home-base.sh'), action, str(APP)],
                       env=clean_env(), stdout=log, stderr=log, check=True, timeout=45)
    if action == 'stop':
        if subprocess.run(['lsof', '-nP', '-iTCP:3000', '-sTCP:LISTEN'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 1:
            raise ValueError('Port 3000 did not stop')


def public_readback(base='http://127.0.0.1:3000', timeline=True):
    today = datetime.datetime.now(ZoneInfo('America/Chicago')).date().isoformat()
    result = {'date': today, 'boards': {}}
    for board in ('caja', 'cocina'):
        with urllib.request.urlopen(base + '/api/boards/' + board + '/days/' + today, timeout=20) as response:
            data = json.load(response)
        if data['date'] != today or data['board'] != board or not data['stations']:
            raise ValueError('Unexpected current board response')
        result['boards'][board] = {'stationLabels': [{k: s[k] for k in ('id', 'label')} for s in data['stations']],
                                    'shiftCount': len(data['shifts']), 'auxiliaryCount': len(data.get('auxiliaryShifts', []))}
    if timeline:
        with urllib.request.urlopen(base + '/api/breaks/timeline?date=' + today, timeout=20) as response:
            data = json.load(response)
        if data['date'] != today:
            raise ValueError('Unexpected timeline date')
        result['timelineCount'] = len(data['breaks'])
    for path in ('/', '/descansos?board=caja', '/descansos?board=cocina'):
        with urllib.request.urlopen(base + path, timeout=20) as response:
            if response.status != 200:
                raise ValueError('Expected page missing')
    return result


def wait_for_checker(run, phase, sha, seconds=600):
    nonce = uuid.uuid4().hex
    request = {'nonce': nonce, 'phase': phase, 'sha': sha, 'created': stamp(), 'timeoutSeconds': seconds}
    write_json(run / 'awaiting.json', request)
    record(run, 'awaiting-independent-checker', **request)
    destination = run / (phase + '-verdict.json')
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if destination.exists():
            verdict = json.loads(destination.read_text())
            if any(verdict.get(k) != request[k] for k in ('nonce', 'phase', 'sha')):
                raise ValueError('Stale or wrong-phase checker verdict')
            evidence = Path(verdict['evidence'])
            if not evidence.is_file() or digest(evidence) != verdict['evidenceSha256']:
                raise ValueError('Checker evidence is missing or changed')
            if verdict['verdict'] != 'pass':
                raise ValueError('Independent checker refused this phase')
            record(run, 'independent-checker-passed', phase=phase, evidence=str(evidence), evidenceSha256=verdict['evidenceSha256'])
            return
        time.sleep(1)
    raise TimeoutError('Independent technical read-back timed out')


def attest(run, verdict, evidence):
    run, evidence = Path(run).resolve(strict=True), Path(evidence).resolve(strict=True)
    request = json.loads((run / 'awaiting.json').read_text())
    target = run / (request['phase'] + '-verdict.json')
    if target.exists() or not evidence.is_file():
        raise ValueError('Verdict already exists or evidence missing')
    result = {**request, 'verdict': verdict, 'evidence': str(evidence), 'evidenceSha256': digest(evidence), 'at': stamp()}
    write_json(target, result, exclusive=True)
    return result


def cutover(packet, operation):
    packet = Path(packet).resolve(strict=True)
    manifest = verify(packet)
    claim = NEST / '.taco-oasis-floor-boards-release.lock'
    if not list(claim.glob(str(os.getppid()) + '.*')):
        raise ValueError('Use b4-cutover.sh: parent must hold the shared release lock')
    if APP.is_symlink() or APP.resolve() != APP or not APP.is_dir():
        raise ValueError('Unexpected installation path')
    old_sha = manifest['releases']['old']['sha']; new_sha = manifest['releases']['new']['sha']
    live_sha = (APP / 'RELEASE_SHA').read_text().strip()
    if live_sha not in ([old_sha] if operation == 'install' else [old_sha, new_sha]):
        raise ValueError('Actual installed SHA changed; repin/rehearse before cutover')
    run = NEST / 'WORK_LOGS' / ('COLOR_BOARDS_B4_CUTOVER_' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '_' + uuid.uuid4().hex[:8])
    run.mkdir()
    record(run, 'starting', operation=operation, packet=str(packet), prior=live_sha, pid=os.getpid(), lockParent=os.getppid())
    if operation == 'install':
        verify_live_runtime(APP, packet, 'old', dependencies=False, prior_installed=True)
    if DATABASE.resolve() != DATABASE:
        raise ValueError('Database path must match the reviewed fixed installation path')
    require_hourly_packet_database(DATABASE)
    env_before = metadata(APP / '.env')
    timer_before = timer_state()
    record(run, 'configuration-before', environmentMetadata=env_before, timer=timer_before)
    # All preparation is application-only and occurs before stopping the live app.
    for label in ('old', 'new'):
        copy_runtime(packet / label, run / ('incoming-' + label))
    altered = False
    recovering = False
    def interrupted(signum, frame):
        if not recovering:
            raise InterruptedError('Cutover interrupted by signal ' + str(signum))
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        altered = True  # A partially failed stop must also enter recovery.
        service(packet, 'stop', run)
        before = guard(DATABASE)
        record(run, 'stopped-invariants', **before)
        if operation == 'install':
            spec = importlib.util.spec_from_file_location('link_migration', packet / 'tools/migrate-manager-linkage.py')
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            migrated = module.migrate(DATABASE)
            require_preserved(before, guard(DATABASE))
            record(run, 'additive-migration', **migrated)
        label = 'new' if operation == 'install' else 'old'
        promote(run / ('incoming-' + label), APP, run / 'retired-application')
        require_preserved(before, guard(DATABASE))
        verify_live_runtime(APP, packet, label)
        timer_after = timer_state()
        if metadata(APP / '.env') != env_before or timer_after != timer_before:
            raise ValueError('Configuration or import timer changed')
        record(run, 'configuration-after-promotion', timer=timer_after, unchanged=True)
        service(packet, 'start', run)
        service(packet, 'status', run)
        public = public_readback(timeline=label == 'new')
        after_start = guard(DATABASE)
        require_preserved(before, after_start)
        record(run, 'operator-readback', release=manifest['releases'][label]['sha'], public=public, data=after_start)
        wait_for_checker(run, 'installed' if label == 'new' else 'rolled-back', manifest['releases'][label]['sha'])
        if metadata(APP / '.env') != env_before or timer_state() != timer_before:
            raise ValueError('Configuration or import timer changed during read-back')
        record(run, 'accepted', state='installed; technical read-back passed; physical tablets and owner pairings pending' if label == 'new' else 'prior application restored; same migrated database; independent rollback read-back passed')
    except BaseException as error:
        record(run, 'cutover-failed', errorType=type(error).__name__, message=str(error))
        if not altered:
            raise
        recovering = True
        try:
            service(packet, 'stop', run)
            retained = guard(DATABASE)
            # A failed promotion can consume any prefix, even with its marker still present.
            old_stage = run / 'incoming-old-recovery'
            copy_runtime(packet / 'old', old_stage)
            promote(old_stage, APP, run / 'retired-failed-application')
            require_preserved(retained, guard(DATABASE))
            verify_live_runtime(APP, packet, 'old')
            timer_recovered = timer_state()
            if metadata(APP / '.env') != env_before or timer_recovered != timer_before:
                raise ValueError('Configuration or import timer changed during recovery')
            record(run, 'configuration-after-recovery', timer=timer_recovered, unchanged=True)
            service(packet, 'start', run)
            public = public_readback(timeline=False)
            after_start = guard(DATABASE)
            require_preserved(retained, after_start)
            record(run, 'rollback-operator-readback', public=public, data=after_start)
            wait_for_checker(run, 'recovery', old_sha)
            if metadata(APP / '.env') != env_before or timer_state() != timer_before:
                raise ValueError('Configuration or import timer changed during recovery read-back')
            record(run, 'rolled-back', originalError=type(error).__name__)
        except BaseException as recovery_error:
            record(run, 'recovery-blocked', errorType=type(recovery_error).__name__, message=str(recovery_error))
            # Never leave an unaccepted new release running after failed recovery.
            service(packet, 'stop', run)
            raise
        raise SystemExit(2)
    return {'run': str(run)}


def main():
    import sys
    if len(sys.argv)>1 and sys.argv[1]=='quarter':
        sys.argv.pop(1)
        from quarter_release import main as quarter_main
        return quarter_main()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('pack'); p.add_argument('--source', required=True); p.add_argument('--build-receipt', required=True); p.add_argument('--output', required=True)
    p = sub.add_parser('prepare'); p.add_argument('--packet', required=True); p.add_argument('--old', required=True); p.add_argument('--new', required=True); p.add_argument('--source', required=True); p.add_argument('--prior-modes', required=True)
    p = sub.add_parser('verify'); p.add_argument('--packet', required=True)
    p = sub.add_parser('cutover'); p.add_argument('--packet', required=True); p.add_argument('--operation', choices=['install', 'rollback'], required=True)
    p = sub.add_parser('attest'); p.add_argument('--run', required=True); p.add_argument('--verdict', choices=['pass', 'fail'], required=True); p.add_argument('--evidence', required=True)
    args = parser.parse_args()
    if args.command == 'pack': result = pack(args.source, args.build_receipt, args.output)
    elif args.command == 'prepare': result = prepare(args.packet, args.old, args.new, args.source, args.prior_modes)
    elif args.command == 'verify': result = verify(args.packet)
    elif args.command == 'cutover': result = cutover(args.packet, args.operation)
    else: result = attest(args.run, args.verdict, args.evidence)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
