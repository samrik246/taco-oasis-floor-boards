"""Synthetic filesystem/service tests only. No live app or database is addressed."""
import contextlib
import io
import json
import py_compile
import plistlib
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import b4_artifacts as a
import b4_release as r

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def runtime(root, sha):
    root.mkdir()
    for name in a.RUNTIME + ['node_modules']:
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        if name in a.DIRECTORIES:
            p.mkdir(); (p / 'example.txt').write_text(sha)
        else:
            p.write_text(sha + '\n')


def packet(root):
    root.mkdir(); (root / 'tools').mkdir()
    for name in a.TOOLS:
        shutil.copy2(SCRIPTS / name, root / 'tools' / name)
    manifest = {'version': 2, 'tools': {n: a.digest(root / 'tools' / n) for n in a.TOOLS}, 'releases': {}}
    for label, sha in [('old', 'a'*40), ('new', 'b'*40)]:
        runtime(root / label, sha)
        (root / (label + '.tgz')).write_bytes(b'synthetic archive; never extracted in these tests')
        a.write_json(root / (label + '-files.json'), a.inventory(root / label))
        manifest['releases'][label] = {'sha': sha, 'archiveSha256': a.digest(root / (label + '.tgz')), 'inventorySha256': a.digest(root / (label + '-files.json'))}
    old_files = json.loads((root / 'old-files.json').read_text())
    a.write_json(root / 'prior-installed-modes.json', {'oldSha': 'a'*40, 'files': {p: state['mode'] for p, state in old_files.items() if not p.startswith('node_modules/')}})
    manifest['priorModesSha256'] = a.digest(root / 'prior-installed-modes.json')
    a.write_json(root / 'manifest.json', manifest)
    return root


def database(path):
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE Manager(id TEXT PRIMARY KEY,name TEXT,codeHash TEXT,active BOOLEAN,role TEXT)')
        db.execute("INSERT INTO Manager VALUES('synthetic','Synthetic','unused',1,'manager')")
        db.execute('CREATE TABLE StaffBreak(id TEXT,employeeId TEXT,shiftId TEXT,board TEXT,date TEXT,status TEXT,startAt TEXT,endAt TEXT,coverEmployeeId TEXT,coverShiftId TEXT,auto BOOLEAN)')
        db.execute("INSERT INTO StaffBreak VALUES('break','person','shift','cocina','2040-06-06','pending','start','end',NULL,NULL,0)")
        db.execute('CREATE TABLE Shift(id TEXT,employeeId TEXT,board TEXT,date TEXT,startAt TEXT,endAt TEXT,boardRemoved BOOLEAN,supersededAt TEXT)')
        db.execute('CREATE TABLE Assignment(id TEXT,employeeId TEXT,shiftId TEXT,stationId TEXT,hourStart TEXT,hourEnd TEXT,seatNumber INTEGER)')


class PacketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='b4-packet-check-')
        self.root = Path(self.temp.name).resolve()
    def tearDown(self):
        self.temp.cleanup()
    def timer_case(self, slots, loaded=True, disabled=False, loaded_slots=None, run_at_load='false'):
        home = self.root / 'home'
        plist = home / 'Library/LaunchAgents' / (r.LABEL + '.plist')
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_bytes(b'synthetic untouched timer metadata')
        before = plist.read_bytes(), plist.stat().st_mode, plist.stat().st_mtime_ns
        def output(command, **kwargs):
            if command[:2] == ['launchctl', 'print-disabled']:
                return '"' + r.LABEL + '" => ' + ('true' if disabled else 'false')
            if command[1:3] == ['-c', 'Print :RunAtLoad']:
                return run_at_load + '\n'
            self.assertEqual(command, ['/usr/libexec/PlistBuddy', '-x', '-c', 'Print :StartCalendarInterval', str(plist)])
            return plistlib.dumps(slots)
        calendar = loaded_slots if loaded_slots is not None else [{'Hour': hour, 'Minute': 0} for hour in range(6, 22)]
        text = 'environment = {\nSYNTHETIC_IGNORED = placeholder\n}\nevent triggers = {\n'
        for slot in calendar:
            text += 'trigger = {\nstream = com.apple.launchd.calendarinterval\ndescriptor = {\n' + ''.join('"'+key+'" => '+str(value)+'\n' for key, value in slot.items()) + '}\n}\n'
        text += '}\n'
        process = MagicMock(); process.__enter__.return_value = process
        process.stdout = io.StringIO(text); process.wait.return_value = 0 if loaded else 1
        with patch.object(r.Path, 'home', return_value=home), patch.object(r.subprocess, 'check_output', side_effect=output), patch.object(r.subprocess, 'Popen', return_value=process) as run:
            try:
                return r.timer_state()
            finally:
                self.assertEqual((plist.read_bytes(), plist.stat().st_mode, plist.stat().st_mtime_ns), before)
                run.assert_called_once_with(['launchctl', 'print', 'gui/' + str(os.getuid()) + '/' + r.LABEL], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    def test_hourly_packet_refuses_quarter_database_before_cutover_or_guard(self):
        db_path = self.root / 'synthetic' / 'floor-boards.db'
        database(db_path)
        with sqlite3.connect(db_path) as db:
            db.execute('CREATE TABLE QuarterSchema(id INTEGER PRIMARY KEY,phase TEXT)')
            db.execute("INSERT INTO QuarterSchema VALUES(1,'prepared')")
        original = db_path.read_bytes()
        for check in (r.require_hourly_packet_database, r.guard):
            with self.assertRaisesRegex(ValueError, 'QUARTER_COMPATIBLE_RECOVERY_PACKET_REQUIRED'):
                check(db_path)
            self.assertEqual(db_path.read_bytes(), original)

    def test_observed_hourly_timer_is_preserved(self):
        slots = [{'Hour': hour, 'Minute': 0} for hour in range(6, 22)]
        result = self.timer_case(list(reversed(slots)))
        self.assertEqual(result['hours'], list(range(6, 22)))
        self.assertEqual(result['minutes'], [0] * 16)
        self.assertTrue(result['loaded'])
    def test_timer_refuses_changed_incomplete_or_disabled_schedule(self):
        expected = [{'Hour': hour, 'Minute': 0} for hour in range(6, 22)]
        for slots in [expected[1:], expected + [expected[0]], expected[:-1] + [expected[0]],
                      [{'Hour': 7, 'Minute': 0}, {'Hour': 16, 'Minute': 0}],
                      [{**slot, 'Weekday': 1} for slot in expected],
                      [{**slot, 'Minute': 1} for slot in expected],
                      [{**slot, 'Minute': False} for slot in expected], {'Hour': 7, 'Minute': 0}]:
            with self.subTest(slots=slots), self.assertRaises(ValueError): self.timer_case(slots)
        for kwargs in [{'loaded': False}, {'disabled': True}, {'run_at_load': 'true'}, {'loaded_slots': expected[1:]}, {'loaded_slots': [{**slot, 'Weekday': 1} for slot in expected]}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError): self.timer_case(expected, **kwargs)
    def test_archive_rejects_paths_and_links(self):
        for index, name in enumerate(['../escape', '/absolute', '.env', '.next/private.db', 'var/data/example.sqlite', 'public/link']):
            archive = self.root / str(index)
            with tarfile.open(archive, 'w') as out:
                info = tarfile.TarInfo(name)
                if name == 'public/link': info.type = tarfile.SYMTYPE; info.linkname = '/tmp/outside'
                out.addfile(info)
            with self.assertRaises(ValueError): a.extract_archive(archive, self.root / ('stage-' + str(index)))
        self.assertFalse((self.root.parent / 'escape').exists())
    def test_inventory_rejects_secrets_escape_and_linked_root(self):
        app = self.root / 'app'; runtime(app, 'a'*40)
        for name in ['.env', '.next/private.db']:
            p = app / name; p.write_text('synthetic')
            with self.assertRaises(ValueError): a.inventory(app)
            p.unlink()
        (app / 'node_modules/escape').symlink_to(self.root)
        with self.assertRaises(ValueError): a.inventory(app)
        (app / 'node_modules/escape').unlink()
        (self.root / 'linked').symlink_to(app)
        with self.assertRaises(ValueError): a.inventory(self.root / 'linked')
    def test_tamper_is_rejected(self):
        p = packet(self.root / 'packet'); a.verify(p)
        for name in ['tools/b4_release.py', 'old.tgz', 'new-files.json', 'new/public/example.txt', 'prior-installed-modes.json']:
            target = p / name; before = target.read_bytes(); target.write_bytes(before + b'tampered')
            with self.assertRaises((ValueError, json.JSONDecodeError)): a.verify(p)
            target.write_bytes(before)
        a.verify(p)
    def test_stale_matching_bytecode_is_never_loaded(self):
        p = packet(self.root / 'packet')
        source = p / 'tools/b4_artifacts.py'; actual = source.read_bytes()
        cache = source.parent / '__pycache__' / ('b4_artifacts.' + sys.implementation.cache_tag + '.pyc')
        cache.parent.mkdir(parents=True, exist_ok=True)
        malicious = b"raise RuntimeError('stale packet bytecode executed')\n#"
        source.write_bytes(malicious + b' ' * (len(actual) - len(malicious)))
        os.utime(source, (1700000000, 1700000000))
        py_compile.compile(str(source), cfile=str(cache), doraise=True)
        source.write_bytes(actual); os.utime(source, (1700000000, 1700000000))
        result = subprocess.run([sys.executable, '-B', str(p / 'tools/b4_release.py'), 'verify', '--packet', str(p)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(cache.exists())  # retained, never deleted as a workaround
        (p / 'tools/.no-bytecode-cache').mkdir()
        refused = subprocess.run([sys.executable, '-B', str(p / 'tools/b4_release.py'), 'verify', '--packet', str(p)], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('prefix must remain absent', refused.stderr)
    def test_promotion_preserves_environment_data_and_unknown_files(self):
        app = self.root / 'app'; runtime(app, 'a'*40)
        (app / '.env').write_text('synthetic sentinel')
        (app / 'operator-note').write_text('untouched')
        db = app / 'var/data/state.db'; database(db); before = r.guard(db)
        stage = self.root / 'stage'; runtime(stage, 'b'*40)
        a.promote(stage, app, self.root / 'retired')
        r.require_preserved(before, r.guard(db))
        self.assertEqual((app / '.env').read_text(), 'synthetic sentinel')
        self.assertEqual((app / 'operator-note').read_text(), 'untouched')
        self.assertEqual((app / 'RELEASE_SHA').read_text().strip(), 'b'*40)
    def test_symlink_parent_refused_before_mutation(self):
        app = self.root / 'app'; runtime(app, 'a'*40)
        shutil.rmtree(app / 'prisma'); outside = self.root / 'outside'; outside.mkdir(); (app / 'prisma').symlink_to(outside)
        stage = self.root / 'stage'; runtime(stage, 'b'*40)
        before = (app / 'public/example.txt').read_bytes()
        with self.assertRaises(ValueError): a.promote(stage, app, self.root / 'retired')
        self.assertEqual((app / 'public/example.txt').read_bytes(), before)
        self.assertEqual(list(outside.iterdir()), [])
    def test_prior_modes_are_explicit_and_do_not_relax_artifacts_or_promotion(self):
        p = packet(self.root / 'packet'); app = self.root / 'app'; a.copy_runtime(p / 'old', app)
        baseline = json.loads((p / 'prior-installed-modes.json').read_text())
        for rel in baseline['files']:
            baseline['files'][rel] = 0o700 if rel in ('scripts/home-base.sh','scripts/release-lock.sh') else 0o600
            (app / rel).chmod(baseline['files'][rel])
        a.write_json(p / 'prior-installed-modes.json', baseline)
        manifest = json.loads((p / 'manifest.json').read_text()); manifest['priorModesSha256'] = a.digest(p / 'prior-installed-modes.json'); a.write_json(p / 'manifest.json',manifest)
        a.verify(p)
        with self.assertRaises(ValueError): r.verify_live_runtime(app,p,'old',dependencies=False)
        r.verify_live_runtime(app,p,'old',dependencies=False,prior_installed=True)
        target = app / 'public/example.txt'; original = target.read_bytes()
        self.assertEqual(target.stat().st_mode & 0o777,0o600)
        target.chmod(0o644)
        with self.assertRaises(ValueError): r.verify_live_runtime(app,p,'old',dependencies=False,prior_installed=True)
        target.chmod(0o600); target.write_bytes(b'changed')
        with self.assertRaises(ValueError): r.verify_live_runtime(app,p,'old',dependencies=False,prior_installed=True)
        target.write_bytes(original)
        with self.assertRaises(ValueError): r.verify_live_runtime(app,p,'new',dependencies=False,prior_installed=True)
        incoming = self.root / 'incoming'; a.copy_runtime(p / 'new',incoming); a.promote(incoming,app,self.root / 'retired')
        r.verify_live_runtime(app,p,'new')
        target.chmod(0o600)
        with self.assertRaises(ValueError): r.verify_live_runtime(app,p,'new')
        (p / 'old/public/example.txt').chmod(0o600)
        with self.assertRaises(ValueError): a.verify(p)
    def test_guard_detects_protected_changes(self):
        db = self.root / 'data/state.db'; database(db); before = r.guard(db)
        with sqlite3.connect(db) as conn: conn.execute("UPDATE StaffBreak SET status='booked'")
        with self.assertRaises(ValueError): r.require_preserved(before, r.guard(db))
    def test_checker_receipt_binding_refusal_timeout_and_tamper(self):
        for scenario in ['pass', 'nonce', 'phase', 'sha', 'fail', 'tamper', 'timeout']:
            run = self.root / scenario; run.mkdir(); evidence = run / 'evidence.json'; evidence.write_text('{}')
            def deposit(_):
                request = json.loads((run / 'awaiting.json').read_text())
                if scenario == 'timeout': return
                verdict = {**request, 'verdict': 'fail' if scenario == 'fail' else 'pass', 'evidence': str(evidence), 'evidenceSha256': a.digest(evidence)}
                if scenario in ['nonce','phase','sha']: verdict[scenario] = 'wrong'
                if scenario == 'tamper': evidence.write_text('changed')
                a.write_json(run / 'installed-verdict.json', verdict)
            with patch.object(r.time, 'sleep', side_effect=deposit), patch.object(r.time, 'monotonic', side_effect=[0, .1, .2, 2]):
                if scenario == 'pass': r.wait_for_checker(run, 'installed', 'b'*40, seconds=1)
                else:
                    with self.assertRaises((ValueError, TimeoutError)): r.wait_for_checker(run, 'installed', 'b'*40, seconds=1)
    def test_attestation_cannot_overwrite(self):
        run = self.root / 'run'; run.mkdir(); evidence = run / 'evidence'; evidence.write_text('checked')
        a.write_json(run / 'awaiting.json', {'phase': 'installed', 'sha': 'b'*40, 'nonce': 'unique'})
        r.attest(run, 'pass', evidence)
        before = (run / 'installed-verdict.json').read_bytes()
        with self.assertRaises(ValueError): r.attest(run, 'fail', evidence)
        self.assertEqual((run / 'installed-verdict.json').read_bytes(), before)
    def cutover_case(self, fault=None, operation='install'):
        p = packet(self.root / 'packet'); app = self.root / 'app'; a.copy_runtime(p / 'old', app)
        (app / '.env').write_text('synthetic sentinel')
        db = app / 'var/data/state.db'; database(db); original = r.guard(db)
        (self.root / 'WORK_LOGS').mkdir(); claim = self.root / '.taco-oasis-floor-boards-release.lock'; claim.mkdir(); (claim / (str(os.getppid()) + '.synthetic')).touch()
        phases = []; services = []; calls = [0]
        real_replace = os.replace
        def replacement(src, dst):
            if fault == 'partial' and 'incoming-' in str(src):
                calls[0] += 1
                if calls[0] == 3: raise OSError('synthetic partial promotion')
            return real_replace(src, dst)
        def checker(run, phase, sha):
            self.assertTrue(list(claim.iterdir())); phases.append(phase)
            if phase == 'installed' and fault == 'checker': raise TimeoutError('synthetic checker timeout')
        with contextlib.ExitStack() as stack:
            for key, value in [('NEST',self.root),('APP',app),('DATABASE',db)]: stack.enter_context(patch.object(r,key,value))
            stack.enter_context(patch.object(r,'timer_state',return_value={'synthetic':'enabled'}))
            stack.enter_context(patch.object(r,'service',side_effect=lambda packet, action, run: services.append(action)))
            stack.enter_context(patch.object(r,'public_readback',return_value={'synthetic':'read'}))
            stack.enter_context(patch.object(r,'wait_for_checker',side_effect=checker))
            stack.enter_context(patch.object(r.signal,'signal'))
            stack.enter_context(patch.object(a.os,'replace',side_effect=replacement))
            if fault:
                with self.assertRaises(SystemExit) as result: r.cutover(p,operation)
                self.assertEqual(result.exception.code,2)
            else: r.cutover(p,operation)
        r.require_preserved(original,r.guard(db))
        self.assertEqual((app / '.env').read_text(),'synthetic sentinel')
        self.assertEqual((app / 'RELEASE_SHA').read_text().strip(), ('b' if not fault and operation == 'install' else 'a')*40)
        self.assertIn('recovery' if fault else 'installed' if operation == 'install' else 'rolled-back',phases)
        self.assertEqual(services[0],'stop')
    def test_install(self): self.cutover_case()
    def test_partial_install_recovers(self): self.cutover_case('partial')
    def test_checker_timeout_recovers(self): self.cutover_case('checker')
    def test_partial_morning_rollback_recovers(self): self.cutover_case('partial','rollback')
    def test_wrapper_holds_lock_through_interrupted_child_recovery(self):
        # Substitute only the app path in a temporary copy; use the real lock implementation.
        p = self.root / 'packet'; (p / 'tools').mkdir(parents=True)
        app = self.root / 'app'; app.mkdir()
        wrapper = (SCRIPTS / 'b4-cutover.sh').read_text().replace('app=/Users/dan/.buzz/COLOR_BOARDS_APP', 'app=' + str(app))
        (p / 'tools/b4-cutover.sh').write_text(wrapper)
        shutil.copy2(SCRIPTS / 'release-lock.sh',p / 'tools/release-lock.sh')
        fake = """import os,sys,signal,time\nfrom pathlib import Path\np=Path(__file__).resolve().parents[1]\nif sys.argv[1]=='verify': sys.exit(0)\nclaim=p.parent/'.taco-oasis-floor-boards-release.lock'\ndef stop(*args):\n assert list(claim.glob(str(os.getppid())+'.*'))\n time.sleep(.3)\n assert list(claim.glob(str(os.getppid())+'.*'))\n (p/'recovered').touch()\n sys.exit(2)\nsignal.signal(signal.SIGTERM,stop)\n(p/'ready').touch()\nwhile True: time.sleep(.1)\n"""
        (p / 'tools/b4_release.py').write_text(fake)
        proc = subprocess.Popen(['bash',str(p / 'tools/b4-cutover.sh'),str(p),'install'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            deadline=time.monotonic()+10
            while not (p/'ready').exists():
                if proc.poll() is not None or time.monotonic()>deadline: self.fail('synthetic wrapper failed before ready')
                time.sleep(.02)
            proc.terminate(); out,err=proc.communicate(timeout=10)
            self.assertEqual(proc.returncode,130,(out,err)); self.assertTrue((p/'recovered').exists())
            self.assertEqual(list((self.root/'.taco-oasis-floor-boards-release.lock').iterdir()),[])
        finally:
            if proc.poll() is None: proc.terminate(); proc.wait(timeout=10)


if __name__ == '__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(PacketTests))
    if not result.wasSuccessful(): sys.exit(1)
    print('release packet checks passed')
