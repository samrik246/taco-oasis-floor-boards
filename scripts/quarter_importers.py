"""Activation exclusion readback for loaded importer processes and pinned launch/timer evidence."""
import json
import time
import os
import re
import plistlib
from datetime import datetime
from pathlib import Path
import subprocess
from quarter_guard import file_hash, hash_value
from quarter_service import process_start


def matching_importers(app):
    # Only PID output is read. Never list unrelated process arguments/environment.
    result = subprocess.run(['pgrep', '-f', r'(^|[ /])(wiw-export|import-from-folder)\.ts([[:space:]]|$)'], text=True, capture_output=True)
    if result.returncode not in (0, 1):
        raise ValueError('IMPORTER_PROCESS_INVENTORY_UNAVAILABLE')
    # Unknown importers are conservatively unresolved, including relative launches.
    return {int(p) for p in result.stdout.split()}


def loaded_calendar(lines):
    slots, current, depth, invalid = [], None, 0, False
    for line in lines:
        line = line.strip()
        if depth == 0:
            if line == 'event triggers = {': depth = 1
            continue
        if current is not None:
            if line == '}': slots.append(current); current = None
            else:
                field = re.fullmatch(r'"(Hour|Minute)"\s*=>\s*(\d+)', line)
                if not field or field[1] in current: invalid = True
                else: current[field[1]] = int(field[2])
        elif line.startswith('stream = ') and line != 'stream = com.apple.launchd.calendarinterval': invalid = True
        elif line == 'descriptor = {': current = {}
        depth += line.count('{') - line.count('}')
    if invalid or depth or current is not None: raise ValueError('IMPORTER_LOADED_TIMER_UNREADABLE')
    return sorted(slots,key=lambda v:(v.get('Hour',-1),v.get('Minute',-1)))


def loaded_timer(lines, public):
    arguments, reading, program, directory = [], False, None, None
    def filtered():
        nonlocal reading, program, directory
        for raw in lines:
            line = raw.strip()
            if reading:
                if line == '}': reading = False
                else: arguments.append(line)
            elif line == 'arguments = {': reading = True
            elif line.startswith('program = '): program = line[len('program = '):]
            elif line.startswith('working directory = '): directory = line[len('working directory = '):]
            yield raw
    calendar = loaded_calendar(filtered())
    expected = public['ProgramArguments']
    if reading or arguments != expected or program != expected[0] or directory != public['WorkingDirectory']:
        raise ValueError('IMPORTER_LOADED_LAUNCH_CHANGED')
    return calendar


def timer_readback(timer, synthetic):
    public = timer['publicDescriptor']
    if synthetic:
        from quarter_guard import disposable
        # Synthetic fixtures never inspect the Mac's installed launchd state.
        descriptor = disposable(timer['descriptorPath'])
        actual = json.loads(descriptor.read_text())
        loaded = actual
    else:
        fields = {}
        for key in ('Label', 'ProgramArguments', 'WorkingDirectory', 'StartCalendarInterval', 'RunAtLoad'):
            raw = subprocess.check_output(['/usr/libexec/PlistBuddy','-x','-c','Print :' + key,timer['descriptorPath']])
            fields[key] = plistlib.loads(raw)
        actual = fields
        label = public['Label']
        if not re.fullmatch(r'[A-Za-z0-9._-]+',label): raise ValueError('IMPORTER_TIMER_LABEL_INVALID')
        domain = 'gui/' + str(os.getuid())
        with subprocess.Popen(['launchctl','print',domain + '/' + label],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True) as proc:
            calendar = loaded_timer(proc.stdout,public)
            if proc.wait() != 0: raise ValueError('IMPORTER_TIMER_NOT_LOADED')
        disabled = subprocess.check_output(['launchctl','print-disabled',domain],text=True)
        if re.search(r'"' + re.escape(label) + r'"\s*=>\s*true',disabled): raise ValueError('IMPORTER_TIMER_DISABLED')
        loaded = dict(actual,StartCalendarInterval=calendar)
    if actual != public or loaded != public or hash_value(public) != timer.get('publicDescriptorSha256') or file_hash(timer['launchPath']) != timer.get('launchSha256'):
        raise ValueError('IMPORTER_TIMER_CHANGED')
    if public.get('RunAtLoad') is not False or not public.get('ProgramArguments') or not public.get('WorkingDirectory') or not public.get('StartCalendarInterval'):
        raise ValueError('IMPORTER_TIMER_INCOMPLETE')
    return {'loadedCalendar':loaded['StartCalendarInterval'],'publicDescriptorSha256':hash_value(public),'launchSha256':timer['launchSha256'],'synthetic':synthetic}



def verify_importers(packet, app):
    pin = packet.get('importers', {})
    if not pin.get('inventoryPath') or file_hash(pin['inventoryPath']) != pin.get('inventorySha256'):
        raise ValueError('IMPORTER_INVENTORY_REQUIRED')
    evidence = json.loads(Path(pin['inventoryPath']).read_text())
    if evidence.get('version') != 1 or evidence.get('app') != str(Path(app).absolute()):
        raise ValueError('IMPORTER_INVENTORY_MISMATCH')
    now = int(time.time() * 1000)
    observed = int(datetime.fromisoformat(evidence['observedAt'].replace('Z','+00:00')).timestamp() * 1000)
    synthetic = bool(os.environ.get('FLOOR_BOARDS_TEST_ROOT'))
    if evidence.get('synthetic') is not synthetic or not 0 <= now - observed <= 900000:
        raise ValueError('IMPORTER_INVENTORY_STALE')
    timer = timer_readback(evidence['timer'],synthetic)
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
