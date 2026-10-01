"""Activation exclusion readback for loaded importer processes and pinned launch/timer evidence."""
import json
from pathlib import Path
import subprocess
from quarter_guard import file_hash, hash_value
from quarter_service import process_start


def matching_importers(app):
    # Only PID output is read. Never list unrelated process arguments/environment.
    escaped = str(Path(app).absolute()).replace('.', r'\.')
    result = subprocess.run(['pgrep', '-f', escaped + r'/scripts/(wiw-export|import-from-folder)\.ts'], text=True, capture_output=True)
    if result.returncode not in (0, 1):
        raise ValueError('IMPORTER_PROCESS_INVENTORY_UNAVAILABLE')
    return {int(p) for p in result.stdout.split()}


def verify_importers(packet, app):
    pin = packet.get('importers', {})
    if not pin.get('inventoryPath') or file_hash(pin['inventoryPath']) != pin.get('inventorySha256'):
        raise ValueError('IMPORTER_INVENTORY_REQUIRED')
    evidence = json.loads(Path(pin['inventoryPath']).read_text())
    if evidence.get('version') != 1 or evidence.get('app') != str(Path(app).absolute()):
        raise ValueError('IMPORTER_INVENTORY_MISMATCH')
    timer = evidence['timer']
    # Exact supplied launch path and timer descriptor must still be the reviewed bytes.
    if file_hash(timer['launchPath']) != timer['launchSha256'] or file_hash(timer['descriptorPath']) != timer['descriptorSha256']:
        raise ValueError('IMPORTER_TIMER_CHANGED')
    live = matching_importers(app)
    registry = Path(app) / 'var/quarter-importers'
    records = []
    for file in registry.glob('*.json'):
        value = json.loads(file.read_text())
        if process_start(value['pid']) == value['started']:
            records.append(value)
    if {r['pid'] for r in records} != live or live != {r['pid'] for r in evidence['processes']}:
        raise ValueError('IMPORTER_UNKNOWN_OR_CHANGED')
    pins = {packet[k]['manifestSha256'] for k in ('r0', 'candidate')}
    for r in records:
        expected = next(row for row in evidence['processes'] if row['pid'] == r['pid'])
        if r != expected or r.get('artifactSha256') not in pins or r.get('state') != 'idle-compatible':
            raise ValueError('IMPORTER_OLD_OR_WAITING')
    return {'processes': len(records), 'inventorySha256': hash_value(evidence), 'timer': timer}
