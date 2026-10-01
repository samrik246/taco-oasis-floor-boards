"""Real artifact/HTTP controller scenarios; completed sub-proofs stay distinct from full acceptance."""
import json
import os
from pathlib import Path
import subprocess
from datetime import date as calendar_date, timedelta
from quarter_artifacts import MANIFEST, atomic_json, copy, verify
from quarter_guard import capture, canonical, file_hash, preserved, connect
from quarter_release import cutover, load_packet, record
from quarter_service import Service, checker_wait


def run_scenario(root, manifest_file, scenario):
    root = Path(root); fixture = json.loads((root / 'fixture.json').read_text()); database = Path(fixture['database'])
    base = load_packet(manifest_file)
    self_run = scenario.startswith('r0-self-')
    if self_run != bool(base.get('syntheticR0SelfRehearsal')):
        raise ValueError('SCENARIO_PACKET_KIND_MISMATCH')
    if not self_run and verify(base['candidate']['path'], base['candidate']['manifestSha256'])['role'] != 'QP_UI_Q1':
        raise ValueError('ACTUAL_Q1_PIN_REQUIRED')
    cases = root / 'evidence/scenarios'; cases.mkdir(exist_ok=True)
    run = cases / scenario; run.mkdir()  # Never reset or overwrite a case.
    index = len(list(cases.iterdir())) - 1
    if index >= 12:
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
    service = Service(app, database, 3100, run)
    writes = run / 'acknowledged-writes.json'
    before_recovery = None
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
        command = ['node',str(app / 'node_modules/tsx/dist/cli.mjs'),str(app / 'scripts/quarter-rehearsal-picker.ts'),date,source,str(output),label]
        result = subprocess.run(command,cwd=app,capture_output=True,text=True)
        (run / ('picker-' + label + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode: raise ValueError('REHEARSAL_PICKER_FAILED:' + label)
    browser_seed = run / 'browser-seed.json'
    profile = run / 'browser-profile'
    def browser(mode, output):
        command = ['node', str(app / 'node_modules/tsx/dist/cli.mjs'), str(app / 'scripts/quarter-rehearsal-browser.ts'), mode, str(profile), date, source, str(output), str(browser_seed)]
        record(run / 'browser-commands.jsonl', 'start', argv=command)
        result = subprocess.run(command, cwd=app, capture_output=True, text=True)
        (run / ('browser-' + mode + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise ValueError('REHEARSAL_BROWSER_FAILED:' + mode)
    def replay_preserved(before, after):
        # Exact replay takes the shared mutex but must add no application mutation.
        for key in ('database', 'state', 'schemaSha256', 'registrySha256'):
            if before[key] != after[key]:
                raise ValueError('REPLAY_CHANGED:' + key)
        for table in before['tables']:
            if table != 'StaffBreakLock' and before['tables'][table] != after['tables'][table]:
                raise ValueError('REPLAY_CHANGED:' + table)
    def checker(phase):
        nonlocal before_recovery
        if phase == 'recovery':
            return 'pass'
        client('write', writes)
        browser('seed', browser_seed)
        picker('before')
        client('read', run / 'post-write-read.json')
        before_recovery = capture(database)
        atomic_json(run / 'post-acknowledgement-guard.json', before_recovery)
        if scenario.endswith('blocked') or scenario == 'recovery-failure-offline':
            # Tamper only this scenario's recovery copy after successful candidate writes.
            (r0 / MANIFEST).write_text('{}\n')
            return 'reject'
        if 'timeout' in scenario:
            return checker_wait(run, phase, seconds=0.1)
        return 'reject' if 'reject' in scenario else 'pass'
    try:
        if not service.state.exists():
            service.start()
        service.readback()
        if 'incompatible' in scenario:
            healthy = json.loads(service.state.read_text()); before = capture(database)
            packet['candidate'] = {'path': str(run / 'incompatible'), 'manifestSha256': '0' * 64}; atomic_json(packet_file, packet)
            try:
                cutover(packet_file, app, database, run / 'cutover', 'install', service, checker)
            except (ValueError, FileNotFoundError):
                pass
            else:
                raise ValueError('INCOMPATIBLE_TARGET_STARTED')
            if json.loads(service.state.read_text()) != healthy:
                raise ValueError('HEALTHY_SERVICE_CHANGED_ON_REFUSAL')
            service.readback(); preserved(before, capture(database)); result = 'preflight-refused'
        else:
            result = cutover(packet_file, app, database, run / 'cutover', 'install', service, checker)
            if 'rollback' in scenario:
                packet['currentManifestSha256'] = file_hash(app / MANIFEST); atomic_json(packet_file, packet)
                result = cutover(packet_file, app, database, run / 'rollback', 'rollback', service, lambda phase: 'pass')
            if before_recovery is None:
                raise ValueError('ACKNOWLEDGED_CHECKER_WAIT_WRITE_REQUIRED')
            preserved(before_recovery, capture(database))
            expected = 'recovery-blocked' if ('blocked' in scenario or scenario == 'recovery-failure-offline') else ('recovered' if ('reject' in scenario or 'timeout' in scenario) else 'accepted')
            if result != expected:
                raise ValueError('RECOVERY_OUTCOME_MISMATCH')
            if result != 'recovery-blocked':
                client('read', run / 'recovered-day.json')
                original = json.loads((run / 'post-write-read.json').read_text()); recovered = json.loads((run / 'recovered-day.json').read_text())
                if original != recovered:
                    raise ValueError('RECOVERED_INTERVAL_READ_CHANGED')
                picker('after')
                browser('reconcile', run / 'browser-reconciled.json')
                client('replay', run / 'replayed.json', writes)
                replay_preserved(before_recovery, capture(database))
            elif service.state.exists():
                raise ValueError('RECOVERY_BLOCKED_STILL_SERVING')
        record(root / 'evidence/rehearsal.jsonl', 'scenario-controller-proof', scenario=scenario, outcome='controller-passed', controllerOutcome=result,
               pending=['expanded-picker-mismatch-cross-board-shuffle-races','full-importer-and-activation-proofs'], browserStores=bool(before_recovery and result != 'recovery-blocked'), receiptReplay=bool(before_recovery and result != 'recovery-blocked'), guard=capture(database))
    finally:
        service.stop()
