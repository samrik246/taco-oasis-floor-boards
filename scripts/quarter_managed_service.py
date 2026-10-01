"""Packet-pinned service-only adapter. No installation, environment read, schema push or restore."""
import json
import os
from pathlib import Path
import plistlib
import signal
import shutil
import subprocess
import time
import uuid
from quarter_artifacts import MANIFEST, atomic_json
from quarter_guard import capture, file_hash, regular
from quarter_importers import timer_readback
from quarter_service import Service, process_start, group_alive


def metadata(path):
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        return None
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_nlink != 1:
        raise ValueError('SERVICE_CONFIGURATION_NOT_REGULAR')
    return {'device': stat.st_dev, 'inode': stat.st_ino, 'size': stat.st_size,
            'modifiedNs': stat.st_mtime_ns, 'mode': stat.st_mode & 0o7777, 'uid': stat.st_uid}


def listeners(port):
    result = subprocess.run(['lsof', '-nP', '-t', '-iTCP:' + str(port), '-sTCP:LISTEN'], text=True, capture_output=True)
    if result.returncode not in (0, 1):
        raise ValueError('SERVICE_LISTENER_INVENTORY_FAILED')
    return {int(value) for value in result.stdout.split()}


def process_cwd(pid):
    result = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], text=True, capture_output=True)
    return [line[1:] for line in result.stdout.splitlines() if line.startswith('n')]


def launch_state(domain, label):
    # Filter while streaming. Never retain the job's environment, including on error.
    public = {'arguments': []}; arguments = False; depth = 0
    with subprocess.Popen(['launchctl', 'print', domain + '/' + label], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True) as child:
        for raw in child.stdout:
            line = raw.strip()
            if arguments:
                if line == '}': arguments = False; depth -= 1
                else: public['arguments'].append(line)
            elif depth == 1 and line == 'arguments = {': arguments = True; depth += 1
            else:
                if depth == 1:
                    for field in ('pid', 'program', 'working directory', 'path'):
                        if line.startswith(field + ' = '): public[field] = line[len(field) + 3:]
                if line.endswith(' = {'): depth += 1
                elif line == '}': depth -= 1
        code = child.wait()
    if code == 113: return None  # launchctl: service not found in the requested domain.
    if code: raise ValueError('SERVICE_LAUNCH_QUERY_FAILED')
    if arguments or depth: raise ValueError('SERVICE_LAUNCH_STATE_INVALID')
    return public


class ManagedService(Service):
    def __init__(self, app, database, run, pin):
        profile_path = regular(pin['path'])
        if file_hash(profile_path) != pin['sha256']:
            raise ValueError('SERVICE_PROFILE_PIN_MISMATCH')
        self.profile_sha = pin['sha256']; self.profile_path = profile_path
        self.profile = p = json.loads(profile_path.read_text())
        self.synthetic = p.get('synthetic') is True
        if p.get('version') != 1 or p.get('app') != str(Path(app).absolute()) or p.get('database') != str(Path(database).absolute()) or p.get('mode') not in ('direct', 'launch-agent') or type(p.get('port')) is not int or not 1024 <= p['port'] <= 65535 or p.get('host') not in ('127.0.0.1', '0.0.0.0'):
            raise ValueError('SERVICE_PROFILE_INVALID')
        if self.synthetic:
            from quarter_guard import disposable
            disposable(database); disposable(profile_path)
            if p['host'] != '127.0.0.1' or p['mode'] != 'direct':
                raise ValueError('SYNTHETIC_SERVICE_LOOPBACK_ONLY')
        else:
            proof = pin.get('acceptance', {})
            if proof.get('decision') != 'pass' or proof.get('profileSha256') != self.profile_sha or not proof.get('builder') or not proof.get('reviewer') or proof['builder'] == proof['reviewer'] or file_hash(proof['evidencePath']) != proof.get('evidenceSha256'):
                raise ValueError('SERVICE_PROFILE_ACCEPTANCE_REQUIRED')
        if not Path(p['node']).is_absolute() or not Path(p['node']).is_file():
            raise ValueError('SERVICE_NODE_REQUIRED')
        super().__init__(app, database, p['port'], run)
        if self.app.resolve(strict=True) != self.app:
            raise ValueError('SERVICE_APP_LINK')
        self.runtime = self.app / 'var/run'
        self.runtime.mkdir(parents=True, exist_ok=True)
        if self.runtime.resolve(strict=True) != self.runtime:
            raise ValueError('SERVICE_STATE_LINK')
        self.state = self.runtime / 'quarter-owned-service.json'
        self.initial_closed = self.runtime / 'quarter-initial-service-closed.json'
        self.contract = self.runtime / 'quarter-start-contract.json'
        self.receipt = self.runtime / 'quarter-start-receipt.json'
        self.domain = 'gui/' + str(os.getuid())
        self.configuration()

    def configuration(self):
        if file_hash(regular(self.profile_path)) != self.profile_sha:
            raise ValueError('SERVICE_PROFILE_CHANGED')
        expected = self.profile['configuration']
        if metadata(self.app / '.env') != expected['environment']:
            raise ValueError('SERVICE_ENVIRONMENT_METADATA_CHANGED')
        if expected.get('importer') is not None:
            timer_readback(expected['importer'], self.synthetic)
        elif not self.synthetic:
            raise ValueError('SERVICE_IMPORT_TIMER_PIN_REQUIRED')
        if self.profile['mode'] == 'launch-agent':
            launch = self.profile['launch']; public = launch['public']
            if public['Label'] != 'com.taco-oasis.floor-boards' or public['WorkingDirectory'] != str(self.app) or public['ProgramArguments'] != self.command() or public.get('KeepAlive') is not True or public.get('RunAtLoad') is not True:
                raise ValueError('SERVICE_LAUNCH_PROFILE_INVALID')
            if metadata(launch['path']) != launch['metadata']:
                raise ValueError('SERVICE_LAUNCH_DESCRIPTOR_CHANGED')
            for key, expected_value in public.items():
                if key not in ('Label', 'ProgramArguments', 'WorkingDirectory', 'KeepAlive', 'RunAtLoad'):
                    raise ValueError('SERVICE_LAUNCH_FIELD_FORBIDDEN')
                raw = subprocess.check_output(['/usr/libexec/PlistBuddy', '-x', '-c', 'Print :' + key, launch['path']])
                if plistlib.loads(raw) != expected_value:
                    raise ValueError('SERVICE_LAUNCH_DESCRIPTOR_CHANGED')

    def command(self):
        return [self.profile['node'], str(self.app / 'node_modules/next/dist/bin/next'), 'start', '-H', self.profile['host'], '-p', str(self.port)]

    def job(self):
        launch = self.profile['launch']; value = launch_state(self.domain, launch['public']['Label'])
        if value is not None and (value.get('path') != launch['path'] or value.get('program') != self.profile['node'] or value.get('arguments') != self.command() or value.get('working directory') != str(self.app)):
            raise ValueError('SERVICE_LOADED_JOB_CHANGED')
        return value

    def owned(self):
        if self.state.exists() or self.state.is_symlink():
            regular(self.state)
            value = json.loads(self.state.read_text())
            if value.get('profileSha256') != self.profile_sha or value.get('app') != str(self.app):
                raise ValueError('SERVICE_OWNER_RECORD_CHANGED')
            self.validate_owner(value)
            return value
        if self.initial_closed.exists() or self.initial_closed.is_symlink():
            if json.loads(regular(self.initial_closed).read_text()) != {'profileSha256': self.profile_sha}:
                raise ValueError('SERVICE_INITIAL_RECORD_CHANGED')
            return None
        value = self.profile.get('initial')
        if value is not None: self.validate_owner(value)
        return value

    def validate_owner(self, value):
        if not isinstance(value, dict) or type(value.get('pid')) is not int or value['pid'] <= 1 or not isinstance(value.get('started'), str) or not value['started'].strip():
            raise ValueError('SERVICE_OWNER_RECORD_INVALID')
        if value.get('legacyPidFile') and value['legacyPidFile'] != str(self.runtime / 'floor-boards.pid'):
            raise ValueError('SERVICE_LEGACY_PID_FILE_OUTSIDE_RUNTIME')

    def check_pid(self, value, require_listener=False):
        self.validate_owner(value)
        child = getattr(self, 'child', None)
        if child is not None and child.pid == value['pid']: child.poll()
        actual = process_start(value['pid'])
        if actual is None: return False
        if actual != value['started'] or process_cwd(value['pid']) != [str(self.app)]:
            raise ValueError('SERVICE_PROCESS_CHANGED')
        if require_listener and listeners(self.port) != {value['pid']}:
            raise ValueError('SERVICE_LISTENER_OWNER_CHANGED')
        return True

    def stop(self):
        self.configuration(); value = self.owned()
        initial = not self.state.exists()
        job = self.job() if self.profile['mode'] == 'launch-agent' else None
        if value is None:
            if job is not None or listeners(self.port): raise ValueError('SERVICE_UNOWNED_LISTENER')
            return
        alive = self.check_pid(value)
        if initial and alive: self.check_pid(value, require_listener=True)
        if job is not None:
            if not alive or job.get('pid') != str(value['pid']): raise ValueError('SERVICE_LAUNCH_PID_CHANGED')
            subprocess.run(['launchctl', 'bootout', self.domain + '/' + self.profile['launch']['public']['Label']], check=True, timeout=10)
        elif alive:
            if self.profile['mode'] == 'launch-agent': raise ValueError('SERVICE_JOB_MISSING_WITH_LIVE_PROCESS')
            try: os.kill(value['pid'], signal.SIGTERM)
            except ProcessLookupError: pass  # The retained identity is still checked below.
        deadline = time.monotonic() + 30
        while self.check_pid(value) and time.monotonic() < deadline: time.sleep(.1)
        if self.check_pid(value):
            # Signal only the attested PID. The legacy nohup process may share its group.
            try: os.kill(value['pid'], signal.SIGKILL)
            except ProcessLookupError: pass
            deadline = time.monotonic() + 5
            while self.check_pid(value) and time.monotonic() < deadline: time.sleep(.1)
        if self.check_pid(value) or listeners(self.port) or (self.profile['mode'] == 'launch-agent' and self.job() is not None):
            raise ValueError('SERVICE_DID_NOT_EXIT')
        if not initial and self.profile['mode'] == 'direct' and group_alive(value['pid']):
            # New direct starts own a session. An orphan keeps the ownership record;
            # it cannot be silently replaced even after its listener disappeared.
            raise ValueError('SERVICE_ORPHAN_REQUIRES_REVIEW')
        if value.get('legacyPidFile'):
            pidfile = regular(value['legacyPidFile'])
            if metadata(pidfile) != value['legacyPidMetadata'] or pidfile.read_text().strip() != str(value['pid']):
                raise ValueError('SERVICE_LEGACY_PID_FILE_CHANGED')
            pidfile.unlink()
        self.state.unlink(missing_ok=True)
        if initial: atomic_json(self.initial_closed, {'profileSha256': self.profile_sha})
        self.configuration()

    def start(self):
        self.configuration()
        prior = self.owned()
        if self.state.exists() or (prior is not None and self.check_pid(prior)) or listeners(self.port) or (self.profile['mode'] == 'launch-agent' and self.job() is not None):
            raise ValueError('SERVICE_ALREADY_OWNED_OR_OCCUPIED')
        identity = regular(self.database).stat()
        contract = {'version': 1, 'nonce': str(uuid.uuid4()), 'app': str(self.app), 'database': str(self.database),
                    'databaseIdentity': {'device': identity.st_dev, 'inode': identity.st_ino},
                    'artifactSha256': file_hash(self.app / MANIFEST), 'profileSha256': self.profile_sha}
        atomic_json(self.contract, contract)
        self.receipt.unlink(missing_ok=True)
        launched = False
        try:
            if self.profile['mode'] == 'direct':
                with (self.run / ('managed-server-' + str(time.time_ns()) + '.log')).open('xb') as output:
                    self.child = subprocess.Popen(self.command(), cwd=self.app, env=dict(os.environ, DATABASE_URL='file:' + str(self.database), NEXT_TELEMETRY_DISABLED='1'), stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                pid = self.child.pid
                launched = True
            else:
                # A failed/timeout bootstrap can still have loaded the reviewed job.
                # Cleanup must query its exact public identity before bootout.
                launched = True
                subprocess.run(['launchctl', 'bootstrap', self.domain, self.profile['launch']['path']], check=True, timeout=10)
                pid = None; deadline = time.monotonic() + 10
                while pid is None and time.monotonic() < deadline:
                    value = self.job()
                    if value and value.get('pid'): pid = int(value['pid'])
                    else: time.sleep(.1)
                if pid is None: raise ValueError('SERVICE_LAUNCH_PID_MISSING')
            started = process_start(pid)
            if not started: raise ValueError('SERVICE_START_FAILED')
            self.pending_owner = {'pid': pid, 'started': started, 'app': str(self.app), 'profileSha256': self.profile_sha, 'nonce': contract['nonce']}
            atomic_json(self.state, self.pending_owner)
            self.readback()
        except BaseException:
            # Preserve ownership through failed publication and readback; never adopt a port.
            if self.state.exists():
                self.stop()
            elif launched and self.profile['mode'] == 'direct':
                for sig, seconds in ((signal.SIGTERM, 30), (signal.SIGKILL, 5)):
                    if self.child.poll() is not None: break
                    self.child.send_signal(sig)
                    try: self.child.wait(timeout=seconds)
                    except subprocess.TimeoutExpired: continue
                    break
                if group_alive(self.child.pid) or listeners(self.port):
                    raise ValueError('SERVICE_UNPUBLISHED_CLEANUP_REQUIRED')
            elif launched:
                # The job was absent before our attempt. Refuse a changed descriptor
                # or loaded identity rather than signaling an unrelated process.
                self.configuration()
                if self.job() is not None:
                    subprocess.run(['launchctl', 'bootout', self.domain + '/' + self.profile['launch']['public']['Label']], check=True, timeout=10)
                deadline = time.monotonic() + 30
                while (self.job() is not None or listeners(self.port)) and time.monotonic() < deadline: time.sleep(.1)
                if self.job() is not None or listeners(self.port):
                    raise ValueError('SERVICE_UNPUBLISHED_CLEANUP_REQUIRED')
            raise

    def readback(self):
        value = self.owned()
        if value is None or not value.get('nonce'): raise ValueError('SERVICE_START_PROOF_REQUIRED')
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if not self.check_pid(value): raise ValueError('SERVICE_START_FAILED')
            if self.receipt.exists():
                proof = json.loads(regular(self.receipt).read_text()); guard = capture(self.database)
                if any(proof.get(key) != expected for key, expected in {
                    'nonce': value['nonce'], 'pid': value['pid'], 'app': str(self.app), 'profileSha256': self.profile_sha,
                    'artifactSha256': file_hash(self.app / MANIFEST), 'database': str(self.database),
                    'databaseIdentity': guard['database'], 'databaseEpoch': guard['state'][2], 'schemaFingerprint': guard['schemaSha256']}.items()):
                    raise ValueError('SERVICE_START_PROOF_MISMATCH')
                self.check_pid(value, require_listener=True); self.configuration()
                if self.profile['mode'] == 'launch-agent' and (self.job() or {}).get('pid') != str(value['pid']):
                    raise ValueError('SERVICE_LAUNCH_PID_CHANGED')
                result = super().readback()
                if result.get('databaseEpoch') != guard['state'][2]: raise ValueError('SERVICE_DATABASE_EPOCH_CHANGED')
                return result
            time.sleep(.1)
        raise ValueError('SERVICE_START_PROOF_TIMEOUT')


def synthetic_service(app, database, port, run):
    """Same adapter as installed mode, with a positively disposable direct-only profile."""
    from quarter_guard import disposable
    database = disposable(database)
    app = Path(app).absolute()
    if not app.is_relative_to(database.parent.parent):
        raise ValueError('SYNTHETIC_SERVICE_APP_OUTSIDE_ROOT')
    profile = {'version': 1, 'synthetic': True, 'app': str(app), 'database': str(database),
               'port': port, 'host': '127.0.0.1', 'mode': 'direct', 'node': shutil.which('node'),
               'configuration': {'environment': metadata(app / '.env'), 'importer': None}, 'initial': None}
    file = app.parent / ('quarter-managed-profile-' + str(port) + '.json')
    if file.exists():
        if json.loads(regular(file).read_text()) != profile:
            raise ValueError('SYNTHETIC_SERVICE_PROFILE_CHANGED')
    else: atomic_json(file, profile)
    return ManagedService(app, database, run, {'path': str(file), 'sha256': file_hash(file)})
