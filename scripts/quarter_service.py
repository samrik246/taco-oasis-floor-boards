"""Owned local runtime process and external checker handshake for QP rehearsal/release."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.request
from quarter_artifacts import atomic_json
from quarter_guard import canonical, file_hash


def process_start(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else None


def group_alive(pgid):
    try:
        os.killpg(pgid, 0); return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS can return EPERM for an unreaped zombie. This is never absence.
        return True


def port_idle(port):
    with socket.socket() as probe:
        return probe.connect_ex(('127.0.0.1', port)) != 0


class Service:
    def __init__(self, app, database, port, run):
        self.app = Path(app).absolute(); self.database = Path(database).absolute(); self.port = port
        self.run = Path(run).absolute(); self.run.mkdir(parents=True, exist_ok=True)
        self.state = self.app.parent / ('quarter-service-' + str(port) + '.json')

    def owned_group_alive(self, pid):
        child = getattr(self, "child", None)
        if child is not None and child.pid == pid:
            child.poll()  # Reap our child before the process-group probe.
        return group_alive(pid)

    def stop(self):
        if not self.state.exists():
            if not port_idle(self.port):
                raise ValueError('SERVICE_UNOWNED_LISTENER')
            return
        state = json.loads(self.state.read_text())
        if state['app'] != str(self.app) or state['database'] != str(self.database):
            raise ValueError('SERVICE_IDENTITY_MISMATCH')
        pid = state['pid']
        self.owned_group_alive(pid)
        current = process_start(pid)
        if current is None:
            if self.owned_group_alive(pid) or not port_idle(self.port):
                raise ValueError('SERVICE_ORPHAN_REQUIRES_REVIEW')
            self.state.unlink(); return
        if current != state['started']:
            raise ValueError('SERVICE_PROCESS_CHANGED')
        try:
            if os.getpgid(pid) != pid:
                raise ValueError('SERVICE_PROCESS_CHANGED')
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            if self.owned_group_alive(pid) or not port_idle(self.port):
                raise ValueError('SERVICE_ORPHAN_REQUIRES_REVIEW')
            self.state.unlink(); return
        deadline = time.monotonic() + 15
        while self.owned_group_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        if self.owned_group_alive(pid):
            leader = process_start(pid)
            if leader is not None and leader != state['started']:
                raise ValueError('SERVICE_PROCESS_CHANGED')
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            while self.owned_group_alive(pid) and time.monotonic() < deadline:
                time.sleep(0.1)
        if self.owned_group_alive(pid) or not port_idle(self.port):
            raise ValueError('SERVICE_DID_NOT_EXIT')
        self.state.unlink()

    def start(self):
        if self.state.exists():
            raise ValueError('SERVICE_STATE_EXISTS')
        if not port_idle(self.port):
            raise ValueError("SERVICE_PORT_OCCUPIED")
        env = dict(os.environ, DATABASE_URL='file:' + str(self.database), NEXT_TELEMETRY_DISABLED='1')
        with (self.run / ('server-' + str(time.time_ns()) + '.log')).open('wb') as output:
            child = subprocess.Popen(['node', str(self.app / 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', str(self.port)], cwd=self.app, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        started = process_start(child.pid)
        if not started:
            raise ValueError('SERVICE_START_FAILED')
        atomic_json(self.state, {'pid': child.pid, 'started': started, 'app': str(self.app), 'database': str(self.database), 'manifestSha256': file_hash(self.app / 'QUARTER_ARTIFACT.json')})
        self.child = child

    def readback(self):
        manifest = json.loads((self.app / 'QUARTER_ARTIFACT.json').read_text())
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen('http://127.0.0.1:' + str(self.port) + '/api/paint/capabilities', timeout=2) as response:
                    body = json.load(response)
                if body.get('artifactSha256') != file_hash(self.app / 'QUARTER_ARTIFACT.json') or body.get('schemaFingerprint') != manifest['schemaSha256'] or body.get('artifactRole') != manifest['role']:
                    raise ValueError('SERVICE_READBACK_MISMATCH')
                return body
            except (OSError, TimeoutError):
                time.sleep(0.2)
        raise ValueError('SERVICE_READBACK_TIMEOUT')


def checker_wait(run, phase, seconds=600):
    run = Path(run); challenge = {'phase': phase, 'issuedAtMs': int(time.time() * 1000), 'nonce': os.urandom(16).hex()}
    atomic_json(run / 'checker-wait.json', challenge)
    answer = run / ('checker-' + challenge['nonce'] + '.json')
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if answer.exists():
            value = json.loads(answer.read_text())
            if value.get('nonce') != challenge['nonce'] or value.get('phase') != phase or not value.get('builder') or not value.get('reviewer') or value.get('reviewer') == value.get('builder') or file_hash(value['evidencePath']) != value.get('evidenceSha256'):
                return 'reject'
            return 'pass' if value.get('verdict') == 'pass' else 'reject'
        time.sleep(0.2)
    return 'timeout'
