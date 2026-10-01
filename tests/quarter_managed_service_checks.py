"""Service identity/cleanup fault checks; no installed job or real process is touched."""
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import quarter_managed_service as managed
from quarter_artifacts import atomic_json
from quarter_guard import file_hash


class ManagedServiceChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['FLOOR_BOARDS_TEST_ROOT'])
        self.root = Path(self.temp.name); self.app = self.root / 'app'; self.app.mkdir()
        self.db = self.root / 'data/test.db'; self.db.parent.mkdir(); self.db.write_text('synthetic')
        (self.app / 'QUARTER_ARTIFACT.json').write_text('{}')
        self.service = managed.synthetic_service(self.app, self.db, 3100, self.root / 'run')
        self.owner = {'pid': 23456, 'started': 'fixed-start', 'app': str(self.app), 'profileSha256': self.service.profile_sha, 'nonce': 'fixed-nonce'}

    def tearDown(self): self.temp.cleanup()

    def record(self): atomic_json(self.service.state, self.owner)

    def launch_profile(self):
        self.service.profile['mode'] = 'launch-agent'
        self.service.profile['launch'] = {'path': str(self.root / 'service.plist'), 'public': {'Label': 'com.taco-oasis.floor-boards'}}

    def test_future_profile_and_non_disposable_synthetic_refuse(self):
        path = self.service.profile_path
        profile = json.loads(path.read_text()); profile['version'] = 2; atomic_json(path, profile)
        with self.assertRaisesRegex(ValueError, 'SERVICE_PROFILE_INVALID'):
            managed.ManagedService(self.app, self.db, self.root / 'run', {'path': str(path), 'sha256': file_hash(path)})
        profile['version'] = 1; profile['database'] = str(self.root.parent.parent / 'outside.db'); atomic_json(path, profile)
        with self.assertRaises((ValueError, FileNotFoundError)):
            managed.ManagedService(self.app, profile['database'], self.root / 'run', {'path': str(path), 'sha256': file_hash(path)})

    def test_non_synthetic_profile_requires_independent_acceptance(self):
        path = self.service.profile_path
        profile = json.loads(path.read_text()); profile['synthetic'] = False; atomic_json(path, profile)
        with self.assertRaisesRegex(ValueError, 'SERVICE_PROFILE_ACCEPTANCE_REQUIRED'):
            managed.ManagedService(self.app, self.db, self.root / 'run', {'path': str(path), 'sha256': file_hash(path)})

    def test_environment_metadata_and_importer_observation_are_preserved(self):
        # No environment value is opened: a changed metadata record is sufficient.
        (self.app / '.env').touch()
        with self.assertRaisesRegex(ValueError, 'SERVICE_ENVIRONMENT_METADATA_CHANGED'): self.service.configuration()
        (self.app / '.env').unlink()
        self.service.profile['configuration']['importer'] = {'synthetic': 'timer-proof'}
        with patch.object(managed, 'timer_readback') as timer:
            self.service.configuration(); timer.assert_called_once_with({'synthetic': 'timer-proof'}, True)

    def test_invalid_pids_and_changed_processes_never_signal(self):
        with patch.object(managed.os, 'kill') as kill, patch.object(managed, 'listeners', return_value=set()):
            for pid in (-1, 0, 1, True, '23456'):
                with self.subTest(pid=pid):
                    self.owner['pid'] = pid; self.record()
                    with self.assertRaisesRegex(ValueError, 'SERVICE_OWNER_RECORD_INVALID'): self.service.stop()
            self.owner['pid'] = 23456; self.record()
            with patch.object(managed, 'process_start', return_value='other-start'):
                with self.assertRaisesRegex(ValueError, 'SERVICE_PROCESS_CHANGED'): self.service.stop()
            with patch.object(managed, 'process_start', return_value='fixed-start'), patch.object(managed, 'process_cwd', return_value=['/other']):
                with self.assertRaisesRegex(ValueError, 'SERVICE_PROCESS_CHANGED'): self.service.stop()
            kill.assert_not_called()

    def test_absent_record_or_wrong_initial_listener_never_adopts_port(self):
        with patch.object(managed, 'listeners', return_value={23456}), patch.object(managed.os, 'kill') as kill:
            with self.assertRaisesRegex(ValueError, 'SERVICE_UNOWNED_LISTENER'): self.service.stop()
            self.service.profile['initial'] = self.owner
            with patch.object(managed, 'process_start', return_value='fixed-start'), patch.object(managed, 'process_cwd', return_value=[str(self.app)]), patch.object(managed, 'listeners', return_value={34567}):
                with self.assertRaisesRegex(ValueError, 'SERVICE_LISTENER_OWNER_CHANGED'): self.service.stop()
            kill.assert_not_called()

    def test_exact_initial_pid_is_drained_without_group_signal_and_closed_once(self):
        pidfile = self.service.runtime / 'floor-boards.pid'; pidfile.write_text('23456\n')
        self.owner.update(legacyPidFile=str(pidfile), legacyPidMetadata=managed.metadata(pidfile))
        self.service.profile['initial'] = self.owner
        alive = [True]
        def stop(pid, sig):
            self.assertEqual((pid, sig), (23456, signal.SIGTERM)); alive[0] = False
        with patch.object(managed, 'process_start', side_effect=lambda pid: 'fixed-start' if alive[0] else None), patch.object(managed, 'process_cwd', return_value=[str(self.app)]), patch.object(managed, 'listeners', side_effect=lambda port: {23456} if alive[0] else set()), patch.object(managed.os, 'kill', side_effect=stop) as kill, patch.object(managed.os, 'killpg') as group:
            self.service.stop(); self.service.stop()
            kill.assert_called_once(); group.assert_not_called()
        self.assertFalse(pidfile.exists()); self.assertIsNone(self.service.owned())

    def test_reaps_owned_child_before_identity_probe(self):
        self.service.child = Mock(pid=23456); order = []
        self.service.child.poll.side_effect = lambda: order.append('poll')
        def start(pid):
            self.assertEqual(order, ['poll']); return None
        with patch.object(managed, 'process_start', side_effect=start): self.assertFalse(self.service.check_pid(self.owner))

    def test_orphaned_direct_session_keeps_record_and_blocks_replacement(self):
        self.record()
        with patch.object(managed, 'process_start', return_value=None), patch.object(managed, 'listeners', return_value=set()), patch.object(managed, 'group_alive', return_value=True), patch.object(managed.os, 'kill') as kill:
            with self.assertRaisesRegex(ValueError, 'SERVICE_ORPHAN_REQUIRES_REVIEW'): self.service.stop()
            with self.assertRaisesRegex(ValueError, 'SERVICE_ALREADY_OWNED_OR_OCCUPIED'): self.service.start()
            kill.assert_not_called()
        self.assertTrue(self.service.state.exists())

    def test_loaded_launch_identity_mismatch_prevents_bootout(self):
        self.launch_profile(); self.record()
        with patch.object(self.service, 'configuration'), patch.object(managed, 'launch_state', return_value={'path': '/wrong'}), patch.object(managed.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'SERVICE_LOADED_JOB_CHANGED'): self.service.stop()
            run.assert_not_called()

    def test_keepalive_job_is_removed_before_stop_can_succeed(self):
        self.launch_profile(); self.record(); live = [True]
        def command(argv, **kwargs):
            self.assertEqual(argv, ['launchctl', 'bootout', self.service.domain + '/com.taco-oasis.floor-boards'])
            live[0] = False
        with patch.object(self.service, 'configuration'), patch.object(self.service, 'job', side_effect=lambda: {'pid': '23456'} if live[0] else None), patch.object(self.service, 'check_pid', side_effect=lambda value: live[0]), patch.object(managed, 'listeners', return_value=set()), patch.object(managed.subprocess, 'run', side_effect=command), patch.object(managed.os, 'kill') as kill:
            self.service.stop(); kill.assert_not_called()
        self.assertFalse(self.service.state.exists())

    def test_state_publication_failure_keeps_direct_child_owned_and_reaps_it(self):
        child = Mock(pid=23456); child.poll.return_value = None
        def publish(path, value):
            if path == self.service.state: raise OSError('disk-full')
            atomic_json(path, value)
        with patch.object(managed, 'listeners', return_value=set()), patch.object(managed.subprocess, 'Popen', return_value=child), patch.object(managed, 'process_start', return_value='fixed-start'), patch.object(managed, 'atomic_json', side_effect=publish), patch.object(managed, 'group_alive', return_value=False):
            with self.assertRaisesRegex(OSError, 'disk-full'): self.service.start()
        child.send_signal.assert_called_once_with(signal.SIGTERM); child.wait.assert_called_once_with(timeout=30)
        self.assertIs(self.service.child, child); self.assertFalse(self.service.state.exists())

    def test_unresolved_unpublished_process_blocks_replacement(self):
        child = Mock(pid=23456); child.poll.return_value = 0
        def publish(path, value):
            if path == self.service.state: raise OSError('disk-full')
            atomic_json(path, value)
        with patch.object(managed, 'listeners', return_value=set()), patch.object(managed.subprocess, 'Popen', return_value=child), patch.object(managed, 'process_start', return_value='fixed-start'), patch.object(managed, 'atomic_json', side_effect=publish), patch.object(managed, 'group_alive', return_value=True):
            with self.assertRaisesRegex(ValueError, 'SERVICE_UNPUBLISHED_CLEANUP_REQUIRED'): self.service.start()
        child.send_signal.assert_not_called()

    def test_unknown_bootstrap_completion_queries_and_drains_exact_job(self):
        self.launch_profile(); calls = []; live = [False]
        def command(argv, **kwargs):
            calls.append(argv[1])
            if argv[1] == 'bootstrap':
                live[0] = True
                raise subprocess.TimeoutExpired(argv, 10)
            self.assertEqual(argv[1], 'bootout'); live[0] = False
        with patch.object(self.service, 'configuration'), patch.object(self.service, 'job', side_effect=lambda: {'pid': '23456'} if live[0] else None), patch.object(managed, 'listeners', return_value=set()), patch.object(managed.subprocess, 'run', side_effect=command):
            with self.assertRaises(subprocess.TimeoutExpired): self.service.start()
        self.assertEqual(calls, ['bootstrap', 'bootout']); self.assertFalse(live[0])

    def test_startup_proof_binds_nonce_pid_database_inode_and_epoch(self):
        self.record(); guard = {'database': {'device': 7, 'inode': 8}, 'state': [2, 'active', 'epoch'], 'schemaSha256': 'schema'}
        proof = {**self.owner, 'artifactSha256': file_hash(self.app / 'QUARTER_ARTIFACT.json'), 'database': str(self.db), 'databaseIdentity': guard['database'], 'databaseEpoch': 'epoch', 'schemaFingerprint': 'schema'}
        for field, bad in [('nonce', 'old'), ('pid', 999), ('databaseIdentity', {'device': 7, 'inode': 9}), ('databaseEpoch', 'old')]:
            with self.subTest(field=field):
                atomic_json(self.service.receipt, {**proof, field: bad})
                with patch.object(self.service, 'check_pid', return_value=True), patch.object(managed, 'capture', return_value=guard), patch.object(managed.Service, 'readback') as http:
                    with self.assertRaisesRegex(ValueError, 'SERVICE_START_PROOF_MISMATCH'): self.service.readback()
                    http.assert_not_called()
        atomic_json(self.service.receipt, proof)
        with patch.object(self.service, 'check_pid', return_value=True) as identity, patch.object(managed, 'capture', return_value=guard), patch.object(managed.Service, 'readback', return_value={'databaseEpoch': 'epoch'}):
            self.assertEqual(self.service.readback(), {'databaseEpoch': 'epoch'})
            self.assertTrue(identity.call_args.kwargs['require_listener'])

    def test_launch_parser_keeps_only_top_level_public_fields(self):
        output = '''gui/501/test = {
    path = /synthetic/service.plist
    program = /synthetic/node
    arguments = {
        /synthetic/node
        /synthetic/next
    }
    environment = {
        SYNTHETIC_TEST_VALUE = never-retain
        pid = 999
    }
    working directory = /synthetic/app
    pid = 23456
}
'''
        child = Mock(stdout=io.StringIO(output)); child.wait.return_value = 0
        context = Mock(); context.__enter__ = Mock(return_value=child); context.__exit__ = Mock(return_value=False)
        with patch.object(managed.subprocess, 'Popen', return_value=context): value = managed.launch_state('gui/501', 'synthetic')
        self.assertEqual(value, {'path': '/synthetic/service.plist', 'program': '/synthetic/node', 'arguments': ['/synthetic/node', '/synthetic/next'], 'working directory': '/synthetic/app', 'pid': '23456'})


if __name__ == '__main__': unittest.main()
