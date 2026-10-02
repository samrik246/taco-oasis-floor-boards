"""Nieves proof driver and fail-closed binding across actual candidate/R0 runtimes."""
import json
import os
from pathlib import Path
import subprocess
from quarter_artifacts import MANIFEST, verify
from quarter_guard import file_hash
from quarter_release import record

BATTERY = {'eligible-two-seats', 'identified-capacity', 'repeat-stable', 'saved-intent', 'exact-intervals', 'mapping-0', 'mapping-1', 'mapping-2', 'split-nonoverlap', 'eligibility'}
MODES = ('prepared', 'seed', 'recovered', 'returned')


def run(root, fixture, mode, day):
    root = Path(root)
    if mode not in MODES: raise ValueError('NIEVES_PROOF_MODE')
    folder = root / 'evidence/nieves'; folder.mkdir(exist_ok=True)
    app = root / ('q1' if mode == 'prepared' else 'app')
    role = 'r0' if mode == 'recovered' else 'candidate'
    pin = fixture[role]['manifestSha256']
    loaded = verify(app, pin, fixture['database'])
    driver = root / 'q1/scripts/quarter-rehearsal-nieves.ts'
    output = folder / (mode + '.json')
    if output.exists(): raise ValueError('NIEVES_EVIDENCE_EXISTS')
    prior = folder / (('recovered' if mode == 'returned' else 'seed') + '.json')
    # The helper lives outside R0. tsconfig and all application imports resolve
    # from the artifact actually named here, not the candidate driver's tree.
    command = ['node', str(app / 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', str(app / 'tsconfig.json'), str(driver), str(app), mode, day, str(output), str(prior)]
    env = dict(os.environ, FLOOR_BOARDS_TEST_ROOT=str(root), DATABASE_URL='file:' + fixture['database'])
    env.pop('NODE_OPTIONS', None)
    record(folder / 'commands.jsonl', 'start', mode=mode, command=command, artifactSha256=pin, sourceSha=loaded['sourceSha'], driverSha256=file_hash(driver))
    result = subprocess.run(command, cwd=app, env=env, text=True, capture_output=True, timeout=240)
    log = folder / (mode + '.log'); log.write_text(result.stdout + result.stderr)
    record(folder / 'commands.jsonl', 'finish', mode=mode, exit=result.returncode, logSha256=file_hash(log))
    if result.returncode: raise ValueError('NIEVES_PROOF_FAILED:' + mode)
    proof = json.loads(output.read_text())
    if proof.get('loadedArtifactSha256') != pin or proof.get('sourceSha') != loaded['sourceSha'] or proof.get('driverSha256') != file_hash(driver): raise ValueError('NIEVES_LOADED_PIN_MISMATCH')
    return proof


def validate(root, fixture, sources):
    root = Path(root); folder = root / 'evidence/nieves'
    driver_hash = file_hash(root / 'q1/scripts/quarter-rehearsal-nieves.ts')
    proofs = {}; evidence = {}
    for mode in MODES:
        path = folder / (mode + '.json')
        try: proof = json.loads(path.read_text())
        except (OSError, ValueError) as error: raise ValueError('NIEVES_EVIDENCE_REQUIRED:' + mode) from error
        role = 'r0' if mode == 'recovered' else 'candidate'
        required = BATTERY if mode in ('prepared', 'seed') else {'crossing-preserved', 'crossing-repeat', 'r0-single-seat-baseline' if mode == 'recovered' else 'returned-revision-preserves'}
        if proof.get('mode') != mode or proof.get('version') != 1 or proof.get('loadedArtifactSha256') != fixture[role]['manifestSha256'] or proof.get('sourceSha') != sources[role] or proof.get('driverSha256') != driver_hash:
            raise ValueError('NIEVES_EVIDENCE_PIN_MISMATCH:' + mode)
        if proof.get('role') != ('QP_COMPAT_R0' if role == 'r0' else 'QP_UI_Q1') or set(proof.get('checks', [])) != required or not proof.get('operations'):
            raise ValueError('NIEVES_ASSERTIONS_INCOMPLETE:' + mode)
        identity = proof.get('database', {})
        if identity.get('path') != fixture['database'] or [identity.get('device'), identity.get('inode')] != fixture['identity']:
            raise ValueError('NIEVES_DATABASE_MISMATCH:' + mode)
        for operation in proof['operations']:
            if operation.get('label') == 'manager-edit':
                if not operation.get('receipt'): raise ValueError('NIEVES_PAINT_RECEIPT_REQUIRED')
            elif not operation.get('input') or operation.get('result', {}).get('outcome') not in ('imported', 'refused', 'replayed') or 'rows' not in operation or 'sources' not in operation or len(operation.get('inputSha256', '')) != 64:
                raise ValueError('NIEVES_IMPORT_ROWS_REQUIRED:' + mode)
        proofs[mode] = proof
        evidence[str(path.relative_to(root / 'evidence'))] = file_hash(path)
    seed, recovered, returned = (proofs[m] for m in ('seed', 'recovered', 'returned'))
    if seed['date'] != recovered['date'] or seed['date'] != returned['date'] or proofs['prepared']['date'] == seed['date']:
        raise ValueError('NIEVES_FIXTURE_DATES_MISMATCH')
    if recovered.get('before') != seed['state']['saved'] or recovered['state'] != seed['state'] or returned.get('before') != recovered['state']['saved']:
        raise ValueError('NIEVES_SAVED_INTENT_CHANGED')
    old = seed['state']['saved']; final = returned['state']['saved']; ids = {s['id'] for s in old['sources']}
    if final['breaks'] != old['breaks'] or [r for r in final['rows'] if r['shiftId'] in ids] != old['rows']:
        raise ValueError('NIEVES_RETURNED_INTENT_CHANGED')
    commands = [json.loads(line) for line in (folder / 'commands.jsonl').read_text().splitlines()]
    if [r['mode'] for r in commands if r['action'] == 'start'] != list(MODES) or any(r.get('exit') != 0 for r in commands if r['action'] == 'finish') or len([r for r in commands if r['action']=='finish']) != len(MODES):
        raise ValueError('NIEVES_COMMANDS_INCOMPLETE')
    for mode in MODES:
        role = 'r0' if mode == 'recovered' else 'candidate'
        start = next(r for r in commands if r['action']=='start' and r['mode']==mode)
        end = next(r for r in commands if r['action']=='finish' and r['mode']==mode)
        log = folder / (mode + '.log')
        if start['artifactSha256'] != fixture[role]['manifestSha256'] or start['sourceSha'] != sources[role] or start['driverSha256'] != driver_hash or end['logSha256'] != file_hash(log): raise ValueError('NIEVES_COMMAND_PIN_MISMATCH')
        evidence[str(log.relative_to(root / 'evidence'))] = file_hash(log)
    evidence['nieves/commands.jsonl'] = file_hash(folder / 'commands.jsonl')
    return evidence
