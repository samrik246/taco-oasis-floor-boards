"""Synthetic filesystem/service tests only. No live app or database is addressed."""
import contextlib
import io
import json
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
from unittest.mock import patch
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
    manifest = {'version': 1, 'tools': {n: a.digest(root / 'tools' / n) for n in a.TOOLS}, 'releases': {}}
    for label, sha in [('old', 'a'*40), ('new', 'b'*40)]:
        runtime(root / label, sha)
        (root / (label + '.tgz')).write_bytes(b'synthetic archive; never extracted in these tests')
        a.write_json(root / (label + '-files.json'), a.inventory(root / label))
        manifest['releases'][label] = {'sha': sha, 'archiveSha256': a.digest(root / (label + '.tgz')), 'inventorySha256': a.digest(root / (label + '-files.json'))}
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
        for name in ['tools/b4_release.py', 'old.tgz', 'new-files.json', 'new/public/example.txt']:
            target = p / name; before = target.read_bytes(); target.write_bytes(before + b'tampered')
            with self.assertRaises((ValueError, json.JSONDecodeError)): a.verify(p)
            target.write_bytes(before)
        a.verify(p)
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
