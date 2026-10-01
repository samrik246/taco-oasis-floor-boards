"""Real artifact/HTTP controller scenarios; completed sub-proofs stay distinct from full acceptance."""
import json
import os
from pathlib import Path
import subprocess
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
    if not service.state.exists():
        service.start()
    service.readback()
    writes = run / 'acknowledged-writes.json'
    before_recovery = None
    date = '2040-10-' + str(10 + index)
    source = 'quarter-rehearsal-' + str(index)
    def client(mode, output):
        command = ['node', str(app / 'node_modules/tsx/dist/cli.mjs'), str(app / 'scripts/quarter-rehearsal-client.ts'), 'http://127.0.0.1:3100', date, source, str(output), mode]
        record(run / 'client-commands.jsonl', 'start', argv=command)
        result = subprocess.run(command, cwd=app, capture_output=True, text=True)
        (run / ('client-' + mode + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise ValueError('REHEARSAL_CLIENT_FAILED')
    def checker(phase):
        nonlocal before_recovery
        if phase == 'recovery':
            return 'pass'
        client('write', writes)
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
                original = json.loads(writes.read_text())['day']; recovered = json.loads((run / 'recovered-day.json').read_text())
                if original != recovered:
                    raise ValueError('RECOVERED_INTERVAL_READ_CHANGED')
            elif service.state.exists():
                raise ValueError('RECOVERY_BLOCKED_STILL_SERVING')
        record(root / 'evidence/rehearsal.jsonl', 'scenario-controller-proof', scenario=scenario, outcome='controller-passed', controllerOutcome=result,
               pending=['browser-store-reload-and-unsent-draft', 'exact-receipt-replay', 'ledger-and-cover-readback', 'controlled-picker'], guard=capture(database))
    finally:
        service.stop()
