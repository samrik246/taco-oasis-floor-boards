"""Real artifact/HTTP controller scenarios; completed sub-proofs stay distinct from full acceptance."""
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path
import subprocess
from datetime import date as calendar_date, timedelta
from quarter_artifacts import MANIFEST, atomic_json, copy, verify
from quarter_guard import REGISTRY, capture, canonical, file_hash, hash_value, preserved, connect, quote, regular
from quarter_release import cutover, load_packet, record
from quarter_service import checker_wait
from quarter_managed_service import synthetic_service


def boundary_snapshot(database, folder, label):
    """Save all safe guards and typed lock rows before any boundary assertion."""
    path = folder / (label + '-boundary.json')
    if path.exists(): raise ValueError('BOUNDARY_EVIDENCE_EXISTS:' + label)
    value = {'version': 1, 'checkpoint': label, 'databasePath': str(database),
             'startedAtMs': time.time_ns() // 1_000_000, 'errors': {}}
    try: value['guard'] = json.loads(canonical(capture(database)))
    except (OSError, ValueError, sqlite3.Error) as error: value['errors']['guard'] = str(error)
    try:
        columns = json.loads(REGISTRY.read_text())['StaffBreakLock']
        with closing(connect(database)) as db:
            fields = [expr for col in columns for expr in ('typeof(' + quote(col) + ')', 'CAST(' + quote(col) + ' AS TEXT)')]
            rows = [[list(row[i:i + 2]) for i in range(0, len(row), 2)] for row in db.execute('SELECT ' + ','.join(fields) + ' FROM StaffBreakLock')]
        rows.sort(key=lambda row: canonical(row).encode())
        value['lockRows'] = {'columns': columns, 'values': rows}
        identity = regular(database).stat()
        value['rowDatabase'] = {'device': identity.st_dev, 'inode': identity.st_ino}
    except (OSError, ValueError, sqlite3.Error) as error: value['errors']['lockRows'] = str(error)
    value['finishedAtMs'] = time.time_ns() // 1_000_000
    atomic_json(path, value)
    return value


def validate_boundary_snapshot(value):
    columns = json.loads(REGISTRY.read_text()); guard = value.get('guard', {})
    if (value.get('version') != 1 or value.get('errors') != {} or not guard
            or set(guard['tables']) != set(columns) or guard['registrySha256'] != file_hash(REGISTRY)
            or guard['foreignKeys'] != 1 or guard['foreignKeyViolations'] != 0
            or guard['database'] != value.get('rowDatabase')):
        raise ValueError('BOUNDARY_SNAPSHOT_INVALID')
    times = [value.get(k) for k in ('startedAtMs', 'finishedAtMs')]
    if any(type(t) is not int or t <= 0 for t in times) or times[0] > times[1]:
        raise ValueError('BOUNDARY_TIME_INVALID')
    retained = value.get('lockRows', {}); rows = retained.get('values', [])
    if retained.get('columns') != columns['StaffBreakLock'] or not rows:
        raise ValueError('BOUNDARY_LOCK_ROWS_INVALID')
    ids = []
    for row in rows:
        if len(row) != 2 or any(not isinstance(cell, list) or len(cell) != 2 or cell[0] != 'integer'
                                or not isinstance(cell[1], str) or not cell[1].isdigit() for cell in row):
            raise ValueError('BOUNDARY_LOCK_ROWS_INVALID')
        ids.append(int(row[0][1]))
    if len(set(ids)) != len(ids) or any(i < 1 for i in ids): raise ValueError('BOUNDARY_LOCK_ROWS_INVALID')
    if guard['tables']['StaffBreakLock'] != {'rows': len(rows), 'sha256': hash_value(rows)}:
        raise ValueError('BOUNDARY_LOCK_GUARD_MISMATCH')


def validate_boundary_pair(before, after):
    for value in (before, after): validate_boundary_snapshot(value)
    if before['databasePath'] != after['databasePath'] or before['finishedAtMs'] > after['startedAtMs']:
        raise ValueError('BOUNDARY_IDENTITY_OR_ORDER_CHANGED')
    preserved(before['guard'], after['guard'])  # All 26 tables, including every lock cell.


def authenticated_boundary(database, folder, read):
    boundary_snapshot(database, folder, 'pre-nieves-read')
    try: read()
    finally: after = boundary_snapshot(database, folder, 'post-nieves')
    # Sign-in is setup, so this final snapshot becomes the rollback expectation.
    return after


def boundary_contract(scenario):
    if 'incompatible' in scenario:
        return ['refusal-before', 'refusal-after'], [('refusal-before', 'refusal-after')]
    labels = ['post-acknowledgement']; baseline = labels[0]
    if scenario == 'normal-r0-q1-r0-q1':
        labels += ['pre-nieves-read', 'post-nieves']; baseline = 'post-nieves'
    labels.append('recovery-after'); pairs = [(baseline, 'recovery-after')]
    if scenario in ('normal-r0-q1-r0-q1', 'r0-self-roundtrip'):
        labels += ['return-before', 'return-after']; pairs.append(('return-before', 'return-after'))
    return labels, pairs


def validate_scenario_boundaries(folder, completion, fixture):
    labels, pairs = boundary_contract(completion['scenario'])
    expected = {label + '-boundary.json' for label in labels}
    binding = completion.get('boundaryEvidence', {})
    if set(binding) != expected: raise ValueError('SCENARIO_BOUNDARY_EVIDENCE_REQUIRED')
    snapshots = {}
    for label in labels:
        name = label + '-boundary.json'; path = folder / name
        if file_hash(path) != binding[name]: raise ValueError('SCENARIO_BOUNDARY_CHANGED:' + label)
        value = json.loads(path.read_text()); validate_boundary_snapshot(value)
        if (value.get('checkpoint') != label or value['databasePath'] != fixture['database']
                or [value['guard']['database'][key] for key in ('device', 'inode')] != fixture['identity']):
            raise ValueError('SCENARIO_BOUNDARY_DATABASE_MISMATCH')
        snapshots[label] = value
    for first, last in pairs: validate_boundary_pair(snapshots[first], snapshots[last])
    for first, last in zip(labels, labels[1:]):
        if snapshots[first]['finishedAtMs'] > snapshots[last]['startedAtMs']:
            raise ValueError('SCENARIO_BOUNDARY_ORDER_CHANGED')
    return {'scenarios/' + completion['scenario'] + '/' + name: digest for name, digest in binding.items()}


def run_scenario(root, manifest_file, scenario):
    root = Path(root); fixture = json.loads((root / 'fixture.json').read_text()); database = Path(fixture['database'])
    base = load_packet(manifest_file)
    self_run = scenario.startswith('r0-self-')
    roundtrip = scenario in ('normal-r0-q1-r0-q1', 'r0-self-roundtrip')
    if self_run != bool(base.get('syntheticR0SelfRehearsal')):
        raise ValueError('SCENARIO_PACKET_KIND_MISMATCH')
    if not self_run and verify(base['candidate']['path'], base['candidate']['manifestSha256'])['role'] != 'QP_UI_Q1':
        raise ValueError('ACTUAL_Q1_PIN_REQUIRED')
    cases = root / 'evidence/scenarios'; cases.mkdir(exist_ok=True)
    run = cases / scenario; run.mkdir()  # Never reset or overwrite a case.
    index = len(list(cases.iterdir())) - 1
    if index >= 32:
        raise ValueError('NEW_REHEARSAL_FIXTURE_REQUIRED')
    app = root / 'app'; r0 = copy(base['r0']['path'], run / 'recovery-target', base['r0']['manifestSha256'])
    packet = dict(base, r0={**base['r0'], 'path': str(r0)}, currentManifestSha256=file_hash(app / MANIFEST))
    packet_file = run / 'packet.json'; atomic_json(packet_file, packet)
    state = capture(database)
    if state['state'][1] == 'prepared':
        if not self_run:
            raise ValueError('ACTIVATION_REQUIRED')
        # Explicit R0-only fixture. This does not invoke or qualify the production activation tool.
        with connect(database, False) as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT COUNT(*) FROM PaintHour').fetchone()[0]:
                raise ValueError('SELF_FIXTURE_NOT_EMPTY')
            db.execute("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=1 WHERE id=1")
        record(root / 'evidence/rehearsal.jsonl', 'synthetic-r0-self-fixture-active', scope='not-activation-acceptance')
    os.environ.update(MANAGER_SESSION_SECRET='quarter-rehearsal-session-0000000000', STAFF_PASSCODE_PEPPER='quarter-rehearsal-pepper-0000000000')
    service = synthetic_service(app, database, 3100, run)
    writes = run / 'acknowledged-writes.json'
    before_recovery = None
    post_write_read = run / 'post-write-read.json'
    date = (calendar_date.fromisoformat(fixture['date']) + timedelta(days=index)).isoformat()
    source = 'quarter-rehearsal-' + str(index)
    def client(mode, output, prior=None):
        command = ['node', str(app / 'node_modules/tsx/dist/cli.mjs'), str(app / 'scripts/quarter-rehearsal-client.ts'), 'http://127.0.0.1:3100', date, source, str(output), mode] + ([str(prior)] if prior else [])
        record(run / 'client-commands.jsonl', 'start', argv=command)
        result = subprocess.run(command, cwd=app, capture_output=True, text=True)
        (run / ('client-' + mode + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise ValueError('REHEARSAL_CLIENT_FAILED')
    def picker(label):
        output = run / ('picker-' + label + '.json')
        command = ['node',str(app / 'node_modules/tsx/dist/cli.mjs'),str(app / 'scripts/quarter-rehearsal-picker.ts'),date,source,str(output),'before' if label == 'before' else 'after']
        result = subprocess.run(command,cwd=app,capture_output=True,text=True)
        (run / ('picker-' + label + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode: raise ValueError('REHEARSAL_PICKER_FAILED:' + label)
    browser_seed = run / 'browser-seed.json'
    bundle_seed = run / 'real-bundle-seed.json'
    bundle_reconciled = run / 'real-bundle-reconciled.json'
    profile = run / 'browser-profile'
    def browser(mode, output, prior=browser_seed):
        command = ['node', str(app / 'node_modules/tsx/dist/cli.mjs'), str(app / 'scripts/quarter-rehearsal-browser.ts'), mode, str(profile), date, source, str(output), str(prior)]
        record(run / 'browser-commands.jsonl', 'start', argv=command)
        result = subprocess.run(command, cwd=app, capture_output=True, text=True)
        (run / ('browser-' + mode + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise ValueError('REHEARSAL_BROWSER_FAILED:' + mode)
    def real_bundle(mode, output, prior=bundle_seed):
        # Always use the Q1 proof driver, even while the app serves the frozen R0.
        # The observed page and challenge come from the currently served artifact.
        driver = Path(base['candidate']['path'])
        command = ['node', str(driver / 'node_modules/tsx/dist/cli.mjs'), str(driver / 'scripts/quarter-rehearsal-browser.ts'), 'bundle-' + mode, str(run / 'real-bundle-profile'), date, source, str(output), str(prior)]
        record(run / 'browser-commands.jsonl', 'actual-bundle-start', argv=command, servedManifestSha256=file_hash(app / MANIFEST))
        result = subprocess.run(command, cwd=app, capture_output=True, text=True)
        log = run / ('real-bundle-' + mode + '.log'); log.write_text(result.stdout + result.stderr)
        if result.returncode: raise ValueError('ACTUAL_BUNDLE_PROOF_FAILED:' + mode)
    def nieves(mode):
        from quarter_rehearsal_nieves import run as run_nieves
        day = (calendar_date.fromisoformat(fixture["date"]) + timedelta(days=220)).isoformat()
        run_nieves(root, fixture, mode, day, base.get('qualificationSupport'))
    def replay_preserved(before, after):
        # Exact replay takes the shared mutex but must add no application mutation.
        for key in ('database', 'state', 'schemaSha256', 'registrySha256'):
            if canonical(before[key]) != canonical(after[key]):
                raise ValueError('REPLAY_CHANGED:' + key)
        for table in before['tables']:
            if table != 'StaffBreakLock' and before['tables'][table] != after['tables'][table]:
                raise ValueError('REPLAY_CHANGED:' + table)
    def acknowledge():
        nonlocal before_recovery
        client('write', writes)
        browser('seed', browser_seed)
        if not self_run: real_bundle('seed', bundle_seed)
        picker('before')
        client('read', run / 'post-write-read.json')
        before_recovery = boundary_snapshot(database, run, 'post-acknowledgement')
        atomic_json(run / 'post-acknowledgement-guard.json', before_recovery['guard'])
    def checker(phase):
        if phase == 'recovery':
            return 'pass'
        acknowledge()
        if scenario.endswith('blocked') or scenario == 'recovery-failure-offline':
            # Tamper only this scenario's recovery copy after successful candidate writes.
            (r0 / MANIFEST).write_text('{}\n')
            return 'reject'
        if 'timeout' in scenario:
            return checker_wait(run, phase, seconds=0.1)
        return 'reject' if ('reject' in scenario or scenario.endswith('recovery-verify')) else 'pass'
    fault_phase = scenario.removeprefix('r0-self-fault-') if scenario.startswith('r0-self-fault-') else None
    def fault(phase):
        if phase == fault_phase:
            if phase in ('after-start', 'readback'):
                service.readback(); acknowledge()
            raise ValueError('REHEARSAL_INJECTED:' + phase)
    try:
        if not service.state.exists():
            service.start()
        service.readback()
        if 'incompatible' in scenario:
            healthy = json.loads(service.state.read_text()); before = boundary_snapshot(database, run, 'refusal-before')
            packet['candidate'] = {'path': str(run / 'incompatible'), 'manifestSha256': '0' * 64}; atomic_json(packet_file, packet)
            try:
                cutover(packet_file, app, database, run / 'cutover', 'install', service, checker)
            except (ValueError, FileNotFoundError):
                pass
            else:
                raise ValueError('INCOMPATIBLE_TARGET_STARTED')
            if json.loads(service.state.read_text()) != healthy:
                raise ValueError('HEALTHY_SERVICE_CHANGED_ON_REFUSAL')
            service.readback(); after = boundary_snapshot(database, run, 'refusal-after')
            validate_boundary_pair(before, after); result = 'preflight-refused'
        else:
            if fault_phase in ('before-promote', 'after-promote'):
                acknowledge()  # Fresh expectation includes writes accepted before stopping.
            result = cutover(packet_file, app, database, run / 'cutover', 'install', service, checker, fault)
            if roundtrip and not self_run:
                nieves('seed')
                post_write_read = run / 'post-nieves-read.json'
                before_recovery = authenticated_boundary(database, run, lambda: client('read', post_write_read))
                atomic_json(run / 'post-nieves-guard.json', before_recovery['guard'])
            if 'rollback' in scenario or roundtrip:
                packet['currentManifestSha256'] = file_hash(app / MANIFEST); atomic_json(packet_file, packet)
                result = cutover(packet_file, app, database, run / 'rollback', 'rollback', service, lambda phase: 'pass')
            if before_recovery is None:
                raise ValueError('ACKNOWLEDGED_CHECKER_WAIT_WRITE_REQUIRED')
            after_recovery = boundary_snapshot(database, run, 'recovery-after')
            validate_boundary_pair(before_recovery, after_recovery)
            expected = 'recovery-blocked' if ('blocked' in scenario or scenario == 'recovery-failure-offline' or fault_phase == 'recovery-verify') else ('recovered' if ('reject' in scenario or 'timeout' in scenario or fault_phase) else 'accepted')
            if result != expected:
                raise ValueError('RECOVERY_OUTCOME_MISMATCH')
            if result != 'recovery-blocked':
                client('read', run / 'recovered-day.json')
                original = json.loads(post_write_read.read_text()); recovered = json.loads((run / 'recovered-day.json').read_text())
                if original != recovered:
                    raise ValueError('RECOVERED_INTERVAL_READ_CHANGED')
                picker('after')
                browser('reconcile', run / 'browser-reconciled.json')
                if not self_run: real_bundle('reconcile', bundle_reconciled)
                client('replay', run / 'replayed.json', writes)
                replay_preserved(before_recovery['guard'], capture(database))
                client('fresh', run / 'post-recovery-write.json')
                client('replay', run / 'post-recovery-replay.json', run / 'post-recovery-write.json')
                atomic_json(run / 'post-recovery-write-guard.json', capture(database))
                if roundtrip:
                    # R0 has now read/replayed the candidate writes and accepted a fresh
                    # command. Return to the actual candidate against that new expectation.
                    if not self_run: nieves('recovered')
                    client('read', run / 'r0-post-write-read.json')
                    current = boundary_snapshot(database, run, 'return-before')
                    packet['currentManifestSha256'] = file_hash(app / MANIFEST); atomic_json(packet_file, packet)
                    if cutover(packet_file, app, database, run / 'return-candidate', 'install', service, lambda phase: 'pass') != 'accepted':
                        raise ValueError('ROUNDTRIP_RETURN_NOT_ACCEPTED')
                    returned = boundary_snapshot(database, run, 'return-after')
                    validate_boundary_pair(current, returned)
                    client('read', run / 'returned-candidate-read.json')
                    if json.loads((run / 'r0-post-write-read.json').read_text()) != json.loads((run / 'returned-candidate-read.json').read_text()):
                        raise ValueError('ROUNDTRIP_INTERVAL_READ_CHANGED')
                    browser('preserve', run / 'browser-returned-candidate.json', run / 'browser-reconciled.json')
                    if not self_run: real_bundle('preserve', run / 'real-bundle-returned.json', bundle_reconciled)
                    client('replay', run / 'returned-original-replay.json', writes)
                    client('replay', run / 'returned-r0-replay.json', run / 'post-recovery-write.json')
                    replay_preserved(current['guard'], capture(database)); picker('after-return')
                    if not self_run: nieves('returned')
            else:
                if service.state.exists():
                    raise ValueError('RECOVERY_BLOCKED_STILL_SERVING')
                browser('inspect', run / 'browser-offline-preserved.json')
                if not self_run: real_bundle('offline', run / 'real-bundle-offline.json')
        labels, _ = boundary_contract(scenario)
        binding = {label + '-boundary.json': file_hash(run / (label + '-boundary.json')) for label in labels}
        validate_scenario_boundaries(run, {'scenario': scenario, 'boundaryEvidence': binding}, fixture)
        record(root / 'evidence/rehearsal.jsonl', 'scenario-controller-proof', scenario=scenario, outcome='controller-passed', controllerOutcome=result,
               pending=['composed-proof-summary','actual-Q1-artifact-crossings'] if self_run else ['composed-proof-summary'],
               actualBundleCrossings=('not-applicable-preflight-refused' if 'incompatible' in scenario else not self_run),
               boundaryEvidence=binding, roundtrip=roundtrip, browserStores=bool(before_recovery), receiptReplay=bool(before_recovery and result != 'recovery-blocked'), guard=capture(database))
    finally:
        # On an action exception save the immediate failing side before stopping.
        # Never overwrite a completed comparison or adopt a new baseline on failure.
        try:
            for first, last in (('refusal-before', 'refusal-after'), ('post-acknowledgement', 'recovery-after'), ('return-before', 'return-after')):
                if (run / (first + '-boundary.json')).exists() and not (run / (last + '-boundary.json')).exists():
                    boundary_snapshot(database, run, last)
        finally: service.stop()
