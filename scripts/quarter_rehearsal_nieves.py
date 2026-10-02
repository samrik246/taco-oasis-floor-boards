"""Nieves proof driver and fail-closed binding across actual candidate/R0 runtimes."""
import json
import os
from pathlib import Path
import re
import subprocess
from quarter_artifacts import MANIFEST, verify
from quarter_guard import file_hash
from quarter_release import record

BATTERY = {'eligible-two-seats', 'identified-capacity', 'repeat-stable', 'saved-intent', 'exact-intervals', 'mapping-0', 'mapping-1', 'mapping-2', 'split-nonoverlap', 'eligibility'}
MODES = ('prepared', 'seed', 'recovered', 'returned')


def resolve_support(support, artifacts=()):
    """Resolve external bytes identically for preflight, execution and validation."""
    if not isinstance(support, dict) or support.get('version') != 1:
        raise ValueError('NIEVES_SUPPORT_REQUIRED')
    paths = {}
    for name in ('driver', 'helper'):
        pin = support.get(name, {})
        path = Path(pin.get('path', ''))
        try:
            if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_file():
                raise ValueError('NIEVES_SUPPORT_PATH:' + name)
            if file_hash(path) != pin.get('sha256'):
                raise ValueError('NIEVES_SUPPORT_CHANGED:' + name)
        except OSError as error:
            raise ValueError('NIEVES_SUPPORT_MISSING:' + name) from error
        paths[name] = path
    if paths['helper'] != Path(__file__).resolve():
        raise ValueError('NIEVES_HELPER_ORIGIN_MISMATCH')
    if any(paths[name].is_relative_to(Path(app).resolve()) for app in artifacts for name in paths):
        raise ValueError('NIEVES_SUPPORT_MUST_BE_EXTERNAL')
    return paths


def preflight(support, source, runtimes):
    """Read only; no disposable directory, database, service or proof is created."""
    paths = resolve_support(support, [pin['path'] for pin in runtimes.values()])
    source = Path(source).resolve(strict=True)
    if paths['helper'] != source / 'scripts/quarter_rehearsal_nieves.py':
        raise ValueError('NIEVES_SOURCE_HELPER_MISMATCH')
    if paths['driver'].is_relative_to(source):
        raise ValueError('NIEVES_DRIVER_SNAPSHOT_REQUIRED')
    # These are the driver's actual dynamic application imports, not type imports.
    modules = re.findall(r'load\(path\.join\(app, "([^"]+)"\)\)', paths['driver'].read_text())
    if not modules: raise ValueError('NIEVES_APPLICATION_IMPORTS_REQUIRED')
    records = {'externalSupport': support, 'dependencies': {}}
    origins = {'source': {'path': str(source), 'manifestSha256': file_hash(source / MANIFEST)}, **runtimes}
    for role, pin in origins.items():
        app = Path(pin['path']).resolve(strict=True)
        if file_hash(app / MANIFEST) != pin['manifestSha256']:
            raise ValueError('NIEVES_PREFLIGHT_MANIFEST_CHANGED:' + role)
        manifest = json.loads((app / MANIFEST).read_text())
        inventory = {row[0]: row for row in manifest['files']}
        # Every shipped script is checked, including local Python imports and
        # entrypoints selected after copying/promoting this artifact.
        required = {name for name in inventory if name.startswith('scripts/')}
        required.update(['scripts/quarter-rehearse.py', 'scripts/quarter_scenarios.py',
                         'tsconfig.json', 'package.json', 'node_modules/tsx/dist/cli.mjs',
                         'node_modules/prisma/build/index.js', *modules])
        entries = []
        for name in sorted(required):
            try:
                path = (app / name).resolve(strict=True)
                relative = path.relative_to(app).as_posix()
                row = inventory.get(relative)
                if not row or row[1] != 'file' or file_hash(path) != row[2]:
                    raise ValueError('NIEVES_PREFLIGHT_DEPENDENCY_CHANGED:' + role + ':' + name)
            except (OSError, ValueError) as error:
                raise ValueError('NIEVES_PREFLIGHT_DEPENDENCY_REQUIRED:' + role + ':' + name) from error
            entries.append({'path': str(app / name), 'resolvedPath': str(path), 'sha256': row[2]})
        records['dependencies'][role] = {'path': str(app), 'manifestSha256': pin['manifestSha256'], 'files': entries}
    records['entrypoints'] = {
        'environment-proofs': 'copied accepted R0 app/scripts/quarter-rehearse.py',
        'other-phases': str(source / 'scripts/quarter-rehearse.py'),
        'nieves-helper': str(paths['helper']), 'nieves-driver': str(paths['driver']),
        'nieves-application': 'prepared: copied candidate q1; seed/returned: promoted candidate app; recovered: promoted R0 app',
    }
    return records


def origin(support, app):
    paths = resolve_support(support, [app])
    return {'driverPath': str(paths['driver']), 'helperPath': str(paths['helper']),
            'helperSha256': support['helper']['sha256'], 'applicationPath': str(Path(app).resolve())}


def run(root, fixture, mode, day, support):
    root = Path(root)
    if mode not in MODES: raise ValueError('NIEVES_PROOF_MODE')
    driver = resolve_support(support, [root])['driver']
    folder = root / 'evidence/nieves'; folder.mkdir(exist_ok=True)
    app = root / ('q1' if mode == 'prepared' else 'app')
    role = 'r0' if mode == 'recovered' else 'candidate'
    pin = fixture[role]['manifestSha256']
    loaded = verify(app, pin, fixture['database'])
    output = folder / (mode + '.json')
    if output.exists(): raise ValueError('NIEVES_EVIDENCE_EXISTS')
    prior = folder / (('recovered' if mode == 'returned' else 'seed') + '.json')
    # The helper lives outside R0. tsconfig and all application imports resolve
    # from the artifact actually named here, not the candidate driver's tree.
    command = ['node', str(app / 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', str(app / 'tsconfig.json'), str(driver), str(app), mode, day, str(output), str(prior)]
    env = dict(os.environ, FLOOR_BOARDS_TEST_ROOT=str(root), DATABASE_URL='file:' + fixture['database'])
    env.pop('NODE_OPTIONS', None)
    origins = origin(support, app)
    record(folder / 'commands.jsonl', 'start', mode=mode, command=command, artifactSha256=pin, sourceSha=loaded['sourceSha'], driverSha256=file_hash(driver), **origins)
    result = subprocess.run(command, cwd=app, env=env, text=True, capture_output=True, timeout=240)
    log = folder / (mode + '.log'); log.write_text(result.stdout + result.stderr)
    record(folder / 'commands.jsonl', 'finish', mode=mode, exit=result.returncode, logSha256=file_hash(log))
    if result.returncode: raise ValueError('NIEVES_PROOF_FAILED:' + mode)
    proof = json.loads(output.read_text())
    if any(proof.get(key) != origins[key] for key in ('driverPath', 'applicationPath')): raise ValueError('NIEVES_DRIVER_ORIGIN_MISMATCH')
    if proof.get('loadedArtifactSha256') != pin or proof.get('sourceSha') != loaded['sourceSha'] or proof.get('driverSha256') != file_hash(driver): raise ValueError('NIEVES_LOADED_PIN_MISMATCH')
    return proof


def validate(root, fixture, sources, support):
    root = Path(root); folder = root / 'evidence/nieves'
    driver_hash = file_hash(resolve_support(support, [root])['driver'])
    proofs = {}; evidence = {}
    for mode in MODES:
        path = folder / (mode + '.json')
        try: proof = json.loads(path.read_text())
        except (OSError, ValueError) as error: raise ValueError('NIEVES_EVIDENCE_REQUIRED:' + mode) from error
        role = 'r0' if mode == 'recovered' else 'candidate'
        origins = origin(support, root / ('q1' if mode == 'prepared' else 'app'))
        if any(proof.get(key) != origins[key] for key in ('driverPath', 'applicationPath')): raise ValueError('NIEVES_EVIDENCE_ORIGIN_MISMATCH:' + mode)
        required = BATTERY if mode in ('prepared', 'seed') else {'crossing-preserved', 'crossing-repeat', 'r0-single-seat-baseline' if mode == 'recovered' else 'returned-revision-preserves'}
        if proof.get('mode') != mode or proof.get('version') != 1 or proof.get('loadedArtifactSha256') != fixture[role]['manifestSha256'] or proof.get('sourceSha') != sources[role] or proof.get('driverSha256') != driver_hash:
            raise ValueError('NIEVES_EVIDENCE_PIN_MISMATCH:' + mode)
        if proof.get('role') != ('QP_COMPAT_R0' if role == 'r0' else 'QP_UI_Q1') or set(proof.get('checks', [])) != required or not proof.get('operations'):
            raise ValueError('NIEVES_ASSERTIONS_INCOMPLETE:' + mode)
        identity = proof.get('database', {})
        if identity.get('path') != fixture['database'] or [identity.get('device'), identity.get('inode')] != fixture['identity']:
            raise ValueError('NIEVES_DATABASE_MISMATCH:' + mode)
        labels = [operation.get('label') for operation in proof['operations']]
        expected_labels = ['initial', 'repeat', 'manager-edit', 'manager-edit', 'revision', 'exact', 'mapping-0', 'mapping-1', 'mapping-2', 'split', 'eligibility'] if mode in ('prepared', 'seed') else ['crossing-repeat', 'r0-existing-allocator' if mode == 'recovered' else 'returned-revision']
        if labels != expected_labels: raise ValueError('NIEVES_OPERATIONS_INCOMPLETE:' + mode)
        for operation in proof['operations']:
            if operation.get('label') == 'manager-edit':
                if mode == 'prepared':
                    if not operation.get('legacyBefore') or 'legacyAfter' not in operation: raise ValueError('NIEVES_LEGACY_EDIT_ROWS_REQUIRED')
                elif not operation.get('receipt'): raise ValueError('NIEVES_PAINT_RECEIPT_REQUIRED')
            elif not operation.get('input') or operation.get('result', {}).get('outcome') not in ('imported', 'refused', 'replayed') or 'rows' not in operation or 'sources' not in operation or len(operation.get('inputSha256', '')) != 64:
                raise ValueError('NIEVES_IMPORT_ROWS_REQUIRED:' + mode)
            if operation.get('label') != 'manager-edit':
                csv = folder / (mode + '-' + operation['label']) / 'Schedule_for_nieves.csv'
                try: input_hash = file_hash(csv)
                except OSError as error: raise ValueError('NIEVES_INPUT_REQUIRED:' + mode) from error
                if operation['inputSha256'] != input_hash: raise ValueError('NIEVES_INPUT_MISMATCH:' + mode)
                evidence[str(csv.relative_to(root / 'evidence'))] = input_hash
                if mode != 'prepared' and (not operation.get('receipts') or any(not r.get('requestId') or not r.get('responseJson') for r in operation['receipts'])):
                    raise ValueError('NIEVES_IMPORT_RECEIPT_REQUIRED:' + mode)
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
        app = root / ('q1' if mode == 'prepared' else 'app')
        if any(start.get(key) != value for key, value in origin(support, app).items()): raise ValueError('NIEVES_COMMAND_ORIGIN_MISMATCH')
        prior = folder / (('recovered' if mode == 'returned' else 'seed') + '.json')
        command = ['node', str(app / 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', str(app / 'tsconfig.json'), support['driver']['path'], str(app), mode, proofs[mode]['date'], str(folder / (mode + '.json')), str(prior)]
        if start.get('command') != command: raise ValueError('NIEVES_COMMAND_PATH_MISMATCH')
        if start['artifactSha256'] != fixture[role]['manifestSha256'] or start['sourceSha'] != sources[role] or start['driverSha256'] != driver_hash or end['logSha256'] != file_hash(log): raise ValueError('NIEVES_COMMAND_PIN_MISMATCH')
        evidence[str(log.relative_to(root / 'evidence'))] = file_hash(log)
    evidence['nieves/commands.jsonl'] = file_hash(folder / 'commands.jsonl')
    return evidence
