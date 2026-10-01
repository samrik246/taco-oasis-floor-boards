"""Actual retained runtime's host CLI: exact packet replay and refusal without mutation."""
from datetime import date, timedelta
import json
import os
from pathlib import Path
import subprocess
import uuid
from quarter_artifacts import MANIFEST, atomic_json, verify
from quarter_guard import capture, canonical, disposable, file_hash, hash_value
from quarter_release import release_lease, record


def unchanged(before, after):
    for key in ('database', 'state', 'schemaSha256', 'registrySha256'):
        if before[key] != after[key]: raise ValueError('AGENT_CHANGED:' + key)
    for table in before['tables']:
        if table != 'StaffBreakLock' and before['tables'][table] != after['tables'][table]:
            raise ValueError('AGENT_CHANGED:' + table)


def run(root, fixture, database, mode):
    root = Path(root); database = disposable(database); app = root / 'app'
    pin = file_hash(app / MANIFEST); verify(app, pin, database)
    out = root / 'evidence' / ('agent-' + mode); out.mkdir()
    day = (date.fromisoformat(fixture['date']) + timedelta(days=31)).isoformat()
    source = 'quarter-rehearsal-31'
    env = dict(os.environ, FLOOR_BOARDS_TEST_ROOT=str(root), DATABASE_URL='file:' + str(database))
    env.pop('NODE_OPTIONS', None)
    def cli(label, args, packet=None, expected=None):
        command = ['node', '--import', str(app / 'node_modules/tsx/dist/loader.mjs'), str(app / 'scripts/quarter-agent.ts'), *args]
        result = subprocess.run(command, cwd=app, env=env, input=canonical(packet) if packet else '', capture_output=True, text=True, timeout=45)
        log = out / (label + '.log'); log.write_text(result.stdout + result.stderr)
        record(out / 'events.jsonl', 'command', label=label, argv=command, exit=result.returncode, outputSha256=file_hash(log))
        if expected:
            if result.returncode == 0 or expected not in result.stdout + result.stderr: raise ValueError('AGENT_EXPECTED_REFUSAL:' + label)
            return None
        if result.returncode: raise ValueError('AGENT_COMMAND_FAILED:' + label)
        return json.loads(result.stdout)
    def create(label, station):
        view = cli(label + '-read', ['--read', 'caja', day]); sources = [s for s in view['sources'] if s['shiftId'] == source]
        if len(sources) != 1: raise ValueError('AGENT_SOURCE_MISSING')
        command = {'protocol': 2, 'requestId': str(uuid.uuid4()), 'capabilitySha256': view['capabilitySha256'], 'board': 'caja', 'date': day,
                   'expected': {'databaseEpoch': view['databaseEpoch'], 'worldRevision': view['worldRevision']}, 'sources': sources,
                   'hours': [{**{k: h[k] for k in ('shiftId', 'hourStart', 'revision')}, **({'legacySha256': h['legacySha256']} if h['revision'] is None else {})} for h in view['hours'] if h['shiftId'] == source],
                   'intents': [{'shiftId': source, 'quarter': '09:15', 'granularity': 'quarter', 'action': 'station', 'stationId': station}]}
        packet = {'version': 2, 'artifactSha256': pin, 'agent': 'Synthetic CLI', 'command': command}
        before = capture(database); preview = cli(label + '-preflight', ['--preflight'], packet); unchanged(before, capture(database))
        if preview['packetSha256'] != hash_value(packet): raise ValueError('AGENT_PREFLIGHT_DIGEST_CHANGED')
        receipt = cli(label + '-apply', ['--apply', preview['packetSha256']], packet)
        return {'packet': packet, 'receipt': receipt}
    def replay(label, saved):
        before = capture(database)
        result = cli(label, ['--apply', hash_value(saved['packet'])], saved['packet'])
        if result != saved['receipt']: raise ValueError('AGENT_ORIGINAL_RECEIPT_CHANGED')
        unchanged(before, capture(database))
    if mode == 'before':
        original = create('original', 'green1'); later = create('later', 'blue')
        atomic_json(out / 'retained.json', {'original': original, 'later': later})
        replay('after-later-write', original)
        def refuse(label, packet, expected, digest=None):
            before = capture(database); cli(label, ['--apply', digest or hash_value(packet)], packet, expected); unchanged(before, capture(database))
        refuse('wrong-digest', original['packet'], 'PACKET_SHA_MISMATCH', '0' * 64)
        refuse('wrong-loaded-pin', {**original['packet'], 'artifactSha256': '0' * 64}, 'ARTIFACT_MANIFEST_PIN_MISMATCH')
        changed = json.loads(canonical(original['packet'])); changed['command']['intents'][0]['stationId'] = 'purple1'
        refuse('same-id-altered-body', changed, 'REQUEST_ID_REUSE')
        with release_lease(app): refuse('release-busy', original['packet'], 'RELEASE_BUSY')
    else:
        retained = json.loads((root / 'evidence/agent-before/retained.json').read_text())
        replay('original-after-recovery', retained['original']); replay('later-after-recovery', retained['later'])
    atomic_json(out / 'completed.json', {'mode': mode, 'runtimeManifestSha256': pin, 'sameFileGuard': capture(database), 'originalReceiptReplay': True})
