"""Measured browser evidence through the actual release reader. R0 never claims Q1 activation."""
import json
import os
from pathlib import Path
import subprocess
from quarter_artifacts import MANIFEST, atomic_json, verify
from quarter_guard import capture, disposable, file_hash, preserved
from quarter_managed_service import synthetic_service
from quarter_release import activate, load_packet, readbacks, record


def run(root, fixture, database, packet_path):
    root = Path(root); database = disposable(database); app = root / 'app'
    verify(app, file_hash(app / MANIFEST), database)
    out = root / 'evidence/measurements'; out.mkdir()
    packet = load_packet(packet_path)
    service = synthetic_service(app, database, 3100, out)
    try:
        service.start()
        command = ['node', '--import', str(app / 'node_modules/tsx/dist/loader.mjs'), str(app / 'scripts/quarter-rehearsal-measurements.ts'), str(out)]
        env = dict(os.environ, FLOOR_BOARDS_TEST_ROOT=str(root), DATABASE_URL='file:' + str(database)); env.pop('NODE_OPTIONS', None)
        with (out / 'collector.log').open('x') as output:
            result = subprocess.run(command, cwd=app, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=180)
        record(out / 'events.jsonl', 'collector', exit=result.returncode, outputSha256=file_hash(out / 'collector.log'))
        if result.returncode: raise ValueError('MEASURED_CLIENT_COLLECTION_FAILED')
        original_inventory = json.loads((out / 'inventory.json').read_text()); original_records = json.loads((out / 'readbacks.json').read_text())
        guard = capture(database)
        def evidence(inventory, records, label):
            directory = out / label; directory.mkdir()
            inv = directory / 'inventory.json'; rec = directory / 'readbacks.json'
            atomic_json(inv, inventory); atomic_json(rec, records)
            return {**packet, 'clients': {'inventoryPath': str(inv), 'inventorySha256': file_hash(inv), 'readbacksPath': str(rec), 'readbacksSha256': file_hash(rec)}}
        accepted = evidence(original_inventory, original_records, 'original')
        proof = readbacks(accepted, app, guard)
        record(out / 'events.jsonl', 'actual-readbacks-accepted', proof=proof)
        for label in ('missing', 'duplicate', 'expired', 'origin', 'build', 'epoch', 'inventory', 'challenge'):
            inv = json.loads(json.dumps(original_inventory)); records = json.loads(json.dumps(original_records)); now = None
            if label == 'missing': records.pop()
            if label == 'duplicate': records[1] = records[0]
            if label == 'expired': now = 4102444800000
            if label == 'origin': records[0]['measurement']['origin'] = 'http://wrong.test:3100'
            if label == 'build': records[0]['measurement']['clientBuildSha'] = '0' * 40
            if label == 'epoch': records[0]['measurement']['observedDatabaseEpoch'] = 'wrong'
            if label == 'inventory': inv['revision'] = 'changed'
            if label == 'challenge': records[0]['measurement']['challengeId'] = records[1]['challengeId']
            altered = evidence(inv, records, label)
            try: readbacks(altered, app, guard, now)
            except (ValueError, FileNotFoundError): record(out / 'events.jsonl', 'readback-refused', case=label)
            else: raise ValueError('MEASUREMENT_FALSE_ACCEPTANCE:' + label)
        # Original evidence remains accepted after probing only separate copies.
        if readbacks(accepted, app, guard) != proof: raise ValueError('MEASURED_ORIGINAL_CHANGED')
        before = capture(database)
        try: activate(packet_path, app, database, out / 'activation.jsonl')
        except ValueError as error:
            if str(error) != 'ACTUAL_Q1_PIN_REQUIRED': raise
            record(out / 'events.jsonl', 'activation-refused', code=str(error))
        else: raise ValueError('R0_SELF_ACTIVATION_FALSE_ACCEPTANCE')
        preserved(before, capture(database))
        atomic_json(out / 'completed.json', {'synthetic': True, 'realLoadedProfiles': 2, 'readerProof': proof, 'activation': 'actual-Q1-required', 'serviceProfileSha256': service.profile_sha})
    finally: service.stop()
