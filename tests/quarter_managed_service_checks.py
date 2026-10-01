"""Service identity/cleanup fault checks; no installed job or real process is touched."""
import io
from contextlib import ExitStack
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
import quarter_release as release
import quarter_bootstrap as bootstrap
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
            for pid in (-1, 0, 1, True, '23456', os.getpid()):
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
        with patch.object(self.service, 'configuration'), patch.object(self.service, 'job', side_effect=lambda: {'pid': '23456'} if live[0] else None), patch.object(self.service, 'check_pid', side_effect=lambda value, **kwargs: live[0]), patch.object(managed, 'listeners', return_value=set()), patch.object(managed.subprocess, 'run', side_effect=command), patch.object(managed.os, 'kill') as kill:
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

    def test_unresolved_unpublished_process_blocks_recovery_and_fresh_controller(self):
        for before_identity in (False, True):
            with self.subTest(before_identity=before_identity):
                child = Mock(pid=23456); child.poll.return_value = 0
                def publish(path, value):
                    if path == self.service.state: raise OSError('disk-full')
                    atomic_json(path, value)
                packet = self.root / 'packet.json'
                atomic_json(packet, {'version': 1, 'controllerSha256': file_hash(release.__file__), 'syntheticR0SelfRehearsal': True,
                                     'currentManifestSha256': 'initial', 'r0': {'path': 'r0', 'manifestSha256': 'r0'}, 'candidate': {'path': 'candidate', 'manifestSha256': 'candidate'}})
                with ExitStack() as stack:
                    stack.enter_context(patch.object(managed, 'listeners', return_value=set()))
                    launch = stack.enter_context(patch.object(managed.subprocess, 'Popen', return_value=child))
                    stack.enter_context(patch.object(managed, 'process_start', side_effect=([None] if before_identity else ['fixed-start']) + [None] * 20))
                    stack.enter_context(patch.object(managed, 'atomic_json', side_effect=publish))
                    stack.enter_context(patch.object(managed, 'group_alive', return_value=True))
                    stack.enter_context(patch.object(release, 'target', return_value={}))
                    stack.enter_context(patch.object(release.artifacts, 'verify', return_value={}))
                    stack.enter_context(patch.object(release, 'capture', return_value={'synthetic': 'unchanged'}))
                    promotion = stack.enter_context(patch.object(release, 'promote'))
                    with self.assertRaisesRegex(ValueError, 'SERVICE_UNPUBLISHED_CLEANUP_REQUIRED|SERVICE_ORPHAN_REQUIRES_REVIEW|SERVICE_PROCESS_CHANGED'):
                        release.cutover(packet, self.app, self.db, self.root / ('cutover-' + str(before_identity)), 'install', self.service, lambda phase: 'pass')
                    self.assertEqual(promotion.call_count, 1)  # Initial promotion only; no recovery promotion.
                    launch.assert_called_once()
                    with self.assertRaises(ValueError): self.service.stop()
                    with self.assertRaises(ValueError): self.service.start()
                    fresh = managed.ManagedService(self.app, self.db, self.root / 'fresh-run', {'path': str(self.service.profile_path), 'sha256': self.service.profile_sha})
                    with self.assertRaisesRegex(ValueError, 'SERVICE_UNPUBLISHED_CLEANUP_REQUIRED'): fresh.stop()
                    with self.assertRaisesRegex(ValueError, 'SERVICE_UNPUBLISHED_CLEANUP_REQUIRED'): fresh.start()
                    launch.assert_called_once(); self.assertTrue(self.service.intent.exists())
                child.send_signal.assert_not_called()
                # Only this isolated test fixture is reset between fault variants.
                self.service.intent.unlink(); self.service.pending_owner = None

    def test_intent_failure_prevents_launch_and_clean_failed_start_allows_retry(self):
        with patch.object(managed, 'listeners', return_value=set()), patch.object(managed.subprocess, 'Popen') as launch:
            def fail_intent(path, value):
                if path == self.service.intent: raise OSError('intent-disk-full')
                atomic_json(path, value)
            with patch.object(managed, 'atomic_json', side_effect=fail_intent):
                with self.assertRaisesRegex(OSError, 'intent-disk-full'): self.service.start()
            launch.assert_not_called()
            child = Mock(pid=23456); child.poll.return_value = 0; launch.return_value = child
            with patch.object(managed, 'process_start', return_value=None), patch.object(managed, 'group_alive', return_value=False):
                for attempt in range(2):
                    with self.assertRaisesRegex(ValueError, 'SERVICE_START_FAILED'): self.service.start()
                    self.assertFalse(self.service.intent.exists())
            self.assertEqual(launch.call_count, 2)

    def test_exit_between_ps_and_cwd_is_reaped_and_not_a_changed_process(self):
        self.service.child = Mock(pid=23456)
        with patch.object(managed, 'process_start', side_effect=['fixed-start', None]), patch.object(managed, 'process_cwd', return_value=[]):
            self.assertFalse(self.service.check_pid(self.owner))
        self.assertEqual(self.service.child.poll.call_count, 2)
        with patch.object(managed, 'process_start', return_value='fixed-start'), patch.object(managed, 'process_cwd', return_value=[]):
            self.assertTrue(self.service.check_pid(self.owner, draining=True))
            with self.assertRaisesRegex(ValueError, 'SERVICE_PROCESS_CHANGED'): self.service.check_pid(self.owner)

    def test_synthetic_constructor_cli_and_controller_confine_all_mutable_paths(self):
        with tempfile.TemporaryDirectory(dir=Path(os.environ['FLOOR_BOARDS_TEST_ROOT']).parent) as outer:
            outside = Path(outer).resolve(); link = self.root / 'linked-app'; link.symlink_to(outside, target_is_directory=True)
            self.assertFalse(outside.is_relative_to(Path(os.environ['FLOOR_BOARDS_TEST_ROOT'])))
            for app, run in [(outside, self.root / 'inside-run'), (self.app, outside / 'outside-run'), (link, self.root / 'inside-run'), (Path(os.environ['FLOOR_BOARDS_TEST_ROOT']), self.root / 'inside-run')]:
                with self.subTest(app=app, run=run):
                    profile = dict(self.service.profile, app=str(app)); file = self.root / 'outside-profile.json'; atomic_json(file, profile)
                    pin = {'path': str(file), 'sha256': file_hash(file)}
                    with patch.object(managed.subprocess, 'Popen') as launch:
                        with self.assertRaisesRegex(ValueError, 'SYNTHETIC_MUTABLE_PATH_OUTSIDE_ROOT'):
                            managed.ManagedService(app, self.db, run, pin)
                        launch.assert_not_called()
                    for with_profile in (False, True):
                        packet = self.root / 'outside-packet.json'; value = {'version': 1, 'controllerSha256': file_hash(release.__file__), 'syntheticR0SelfRehearsal': True}
                        if with_profile: value['service'] = pin
                        atomic_json(packet, value)
                        result = subprocess.run([sys.executable, release.__file__, 'install', '--packet', str(packet), '--app', str(app), '--database', str(self.db), '--run', str(run)], capture_output=True, text=True)
                        self.assertNotEqual(result.returncode, 0); self.assertIn('SYNTHETIC_MUTABLE_PATH_OUTSIDE_ROOT', result.stderr)
                    service = Mock()
                    for entry in (release.cutover, bootstrap.bootstrap):
                        args = (packet, app, self.db, run, 'install', service, lambda phase: 'pass') if entry is release.cutover else (packet, app, self.db, run, service, lambda phase: 'pass')
                        with self.assertRaisesRegex(ValueError, 'SYNTHETIC_MUTABLE_PATH_OUTSIDE_ROOT'): entry(*args)
                    self.assertEqual(service.mock_calls, []); self.assertEqual(list(outside.iterdir()), [])

    def test_derived_directory_and_evidence_aliases_refuse_before_any_service_action(self):
        for kind in ('var', 'lease', 'events.jsonl', 'bootstrap-events.jsonl', 'service-events.jsonl', 'bootstrap.json', 'hardlink', 'dangling'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=Path(os.environ['FLOOR_BOARDS_TEST_ROOT']).parent) as outer:
                outside = Path(outer).resolve(); sentinel = outside / '999999.dead'; sentinel.write_bytes(b'outside sentinel\n')
                case = self.root / kind; case.mkdir(); app = case / 'app'; app.mkdir(); run = case / 'run'; run.mkdir()
                if kind == 'var': (app / 'var').symlink_to(outside, target_is_directory=True)
                elif kind == 'lease': (case / '.taco-oasis-floor-boards-release.lock').symlink_to(outside, target_is_directory=True)
                elif kind == 'hardlink': os.link(sentinel, run / 'events.jsonl')
                else: (run / ('events.jsonl' if kind == 'dangling' else kind)).symlink_to(outside / 'absent' if kind == 'dangling' else sentinel)
                def outside_snapshot():
                    return {p.name: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns, p.stat().st_nlink) for p in outside.iterdir()}
                before = outside_snapshot()
                profile = dict(self.service.profile, app=str(app)); file = case / 'profile.json'; atomic_json(file, profile)
                pin = {'path': str(file), 'sha256': file_hash(file)}; packet = case / 'packet.json'
                value = {'version': 1, 'controllerSha256': file_hash(release.__file__), 'syntheticR0SelfRehearsal': True,
                         'currentManifestSha256': 'initial', 'legacy': {}, 'r0': {'path': 'r0', 'manifestSha256': 'r0'},
                         'candidate': {'path': 'candidate', 'manifestSha256': 'candidate'}}
                atomic_json(packet, value)
                with ExitStack() as stack:
                    launch = stack.enter_context(patch.object(managed.subprocess, 'Popen'))
                    promotion = stack.enter_context(patch.object(release, 'promote'))
                    stack.enter_context(patch.object(release, 'target', return_value={}))
                    stack.enter_context(patch.object(release.artifacts, 'verify', return_value={}))
                    stack.enter_context(patch.object(bootstrap, 'target', return_value={}))
                    stack.enter_context(patch.object(bootstrap, 'verify_legacy', return_value={}))
                    stack.enter_context(patch.object(bootstrap, 'before_migration', return_value={'guard': {}}))
                    service = Mock()
                    operations = [lambda: managed.ManagedService(app, self.db, run, pin),
                                  lambda: managed.synthetic_service(app, self.db, 3100, run),
                                  lambda: release.cutover(packet, app, self.db, run, 'install', service, lambda phase: 'pass'),
                                  lambda: bootstrap.bootstrap(packet, app, self.db, run, service, lambda phase: 'pass')]
                    for operation in operations:
                        with self.assertRaisesRegex(ValueError, 'MUTABLE_'): operation()
                    self.assertEqual(service.mock_calls, []); launch.assert_not_called(); promotion.assert_not_called()
                for with_profile in (False, True):
                    atomic_json(packet, {**value, **({'service': pin} if with_profile else {})})
                    result = subprocess.run([sys.executable, release.__file__, 'install', '--packet', str(packet), '--app', str(app), '--database', str(self.db), '--run', str(run)], capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0); self.assertIn('MUTABLE_', result.stderr)
                if kind == 'lease':
                    with self.assertRaisesRegex(ValueError, 'MUTABLE_'):
                        with release.release_lease(app): self.fail('aliased lease admitted')
                if kind not in ('var', 'lease'):
                    log = run / ('events.jsonl' if kind in ('hardlink', 'dangling') else kind)
                    with self.assertRaisesRegex(ValueError, 'MUTABLE_'): release.record(log, 'forbidden')
                self.assertEqual(outside_snapshot(), before)

    def test_post_spawn_exception_and_unknown_spawn_keep_replacement_inhibited(self):
        original_open = Path.open
        class OutputFailure:
            def __init__(self, stream): self.stream = stream
            def __enter__(self): return self.stream.__enter__()
            def __exit__(self, *args):
                self.stream.__exit__(*args); raise OSError('post-spawn-output-close')
        def open_file(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            return OutputFailure(stream) if path.name.startswith('managed-server-') else stream
        for uncertain in (False, True):
            with self.subTest(uncertain=uncertain):
                child = Mock(pid=23456); child.poll.return_value = 0
                self.service.child = Mock(pid=34567)  # Prior handles cannot authorize this attempted spawn.
                packet = self.root / 'spawn-packet.json'
                atomic_json(packet, {'version': 1, 'controllerSha256': file_hash(release.__file__), 'syntheticR0SelfRehearsal': True,
                                     'currentManifestSha256': 'initial', 'r0': {'path': 'r0', 'manifestSha256': 'r0'}, 'candidate': {'path': 'candidate', 'manifestSha256': 'candidate'}})
                with ExitStack() as stack:
                    stack.enter_context(patch.object(managed, 'listeners', return_value=set()))
                    stack.enter_context(patch.object(managed, 'group_alive', return_value=True))
                    stack.enter_context(patch.object(Path, 'open', open_file))
                    launch = stack.enter_context(patch.object(managed.subprocess, 'Popen', side_effect=InterruptedError('spawn-interrupted') if uncertain else None, return_value=child))
                    stack.enter_context(patch.object(release, 'target', return_value={}))
                    stack.enter_context(patch.object(release.artifacts, 'verify', return_value={}))
                    stack.enter_context(patch.object(release, 'capture', return_value={'synthetic': 'unchanged'}))
                    promotion = stack.enter_context(patch.object(release, 'promote'))
                    with self.assertRaisesRegex(ValueError, 'SERVICE_UNPUBLISHED_CLEANUP_REQUIRED'):
                        release.cutover(packet, self.app, self.db, self.root / ('spawn-' + str(uncertain)), 'install', self.service, lambda phase: 'pass')
                    self.assertEqual(promotion.call_count, 1); launch.assert_called_once()
                    for instance in (self.service, managed.ManagedService(self.app, self.db, self.root / 'fresh-spawn', {'path': str(self.service.profile_path), 'sha256': self.service.profile_sha})):
                        with self.assertRaisesRegex(ValueError, 'SERVICE_UNPUBLISHED_CLEANUP_REQUIRED'): instance.stop()
                        with self.assertRaisesRegex(ValueError, 'SERVICE_UNPUBLISHED_CLEANUP_REQUIRED'): instance.start()
                    launch.assert_called_once(); self.assertTrue(self.service.intent.exists()); child.send_signal.assert_not_called()
                    self.assertIs(self.service.child, None if uncertain else child)
                self.service.intent.unlink(); self.service.pending_owner = None
        child = Mock(pid=23456); child.poll.return_value = None
        with patch.object(Path, 'open', open_file), patch.object(managed, 'listeners', return_value=set()), patch.object(managed, 'group_alive', return_value=False), patch.object(managed.subprocess, 'Popen', return_value=child):
            for _ in range(2):
                with self.assertRaisesRegex(OSError, 'post-spawn-output-close'): self.service.start()
                self.assertFalse(self.service.intent.exists())
        self.assertEqual(child.send_signal.call_count, 2); self.assertEqual(child.wait.call_count, 2)

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
