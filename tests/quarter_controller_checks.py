"""Controller fault tests on disposable SQLite; real artifact/browser proofs run separately."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import quarter_guard as guard
import quarter_release as release


class ControllerChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['FLOOR_BOARDS_TEST_ROOT']); self.root = Path(self.temp.name)
        self.db = self.root / 'test.db'
        columns = json.loads(guard.REGISTRY.read_text())
        with sqlite3.connect(self.db) as db:
            for table, names in columns.items():
                names = [n for n in names if n != 'rowid']
                fields = [guard.quote(n) + (' INTEGER' if n in ('id', 'schemaVersion', 'minReader', 'minWriter', 'activatedAtMs') and table == 'QuarterSchema' else ' TEXT') for n in names]
                if table == 'Manager': fields.append('codeHash TEXT')
                db.execute('CREATE TABLE ' + guard.quote(table) + '(' + ','.join(fields) + ')')
            db.execute("INSERT INTO QuarterSchema VALUES(1,2,'active','fixture-epoch',2,2,'migration',1)")
            db.execute("INSERT INTO Manager(id,name,codeHash) VALUES('m','Synthetic','excluded-one')")
        self.app = self.root / 'app'; self.app.mkdir(); self.run = self.root / 'run'
        self.packet = self.root / 'packet.json'
        self.packet.write_text(json.dumps({'version':1,'controllerSha256':guard.file_hash(release.__file__),'currentManifestSha256':'initial','r0':{'path':'r0','manifestSha256':'r0'},'candidate':{'path':'candidate','manifestSha256':'candidate'}}))
        self.events = []; self.serving = True
        outer = self
        class Service:
            def stop(self): outer.events.append('stop'); outer.serving=False
            def start(self): outer.events.append('start'); outer.serving=True
            def readback(self): outer.events.append('readback')
        self.service = Service()

    def tearDown(self): self.temp.cleanup()

    def write(self):
        with sqlite3.connect(self.db) as db:
            db.execute("INSERT INTO PaintCommandReceipt(actorId,requestId,responseJson) VALUES('actor','ack','saved')")
            db.execute("INSERT INTO PaintSegment(id,state,startMs,endMs) VALUES('quarter','erased','2233486800000','2233487700000')")

    def run_cutover(self, checker, target=lambda *args: {}, fault=lambda phase: None):
        with patch.object(release, 'target', side_effect=target), patch.object(release.artifacts, 'verify', return_value={}), patch.object(release, 'promote', side_effect=lambda *args: self.events.append('promote')):
            return release.cutover(self.packet,self.app,self.db,self.run,'install',self.service,checker,fault)

    def test_guard_excludes_credentials_and_detects_interval_and_schema_change(self):
        before=guard.capture(self.db)
        with sqlite3.connect(self.db) as db: db.execute("UPDATE Manager SET codeHash='excluded-two'")
        guard.preserved(before,guard.capture(self.db))
        self.write()
        with self.assertRaisesRegex(ValueError,'PRESERVATION_CHANGED'): guard.preserved(before,guard.capture(self.db))
        current=guard.capture(self.db)
        with sqlite3.connect(self.db) as db: db.execute('CREATE INDEX synthetic_index ON PaintSegment(state)')
        self.assertNotEqual(current['schemaSha256'],guard.capture(self.db)['schemaSha256'])

    def test_reject_and_timeout_keep_acknowledged_writes(self):
        for verdict in ('reject','timeout'):
            with self.subTest(verdict=verdict):
                if verdict=='timeout':
                    with sqlite3.connect(self.db) as db: db.execute('DELETE FROM PaintCommandReceipt');db.execute('DELETE FROM PaintSegment')
                expected=[]
                def checker(phase):
                    if phase=='recovery': return 'pass'
                    self.write();expected.append(guard.capture(self.db));return verdict
                result=self.run_cutover(checker)
                self.assertEqual(result,'recovered');guard.preserved(expected[0],guard.capture(self.db));self.assertTrue(self.serving)

    def test_refused_target_does_not_stop_healthy_server(self):
        with self.assertRaisesRegex(ValueError,'bad-target'):
            self.run_cutover(lambda phase:'pass',target=lambda *args: (_ for _ in ()).throw(ValueError('bad-target')))
        self.assertEqual(self.events,[]);self.assertTrue(self.serving)

    def test_bad_recovery_target_stays_stopped_after_acknowledged_write(self):
        expected=[]
        def checker(phase): self.write();expected.append(guard.capture(self.db));return 'reject'
        def target(packet,name,*args):
            if name=='r0':raise ValueError('missing-r0')
            return {}
        self.assertEqual(self.run_cutover(checker,target),'recovery-blocked');self.assertFalse(self.serving);guard.preserved(expected[0],guard.capture(self.db))

    def test_recovery_checker_failure_stays_stopped(self):
        expected=[]
        def checker(phase):
            if phase!='recovery':self.write();expected.append(guard.capture(self.db))
            return 'reject'
        self.assertEqual(self.run_cutover(checker),'recovery-blocked');self.assertFalse(self.serving);guard.preserved(expected[0],guard.capture(self.db))

    def test_fault_before_stop_leaves_service_untouched(self):
        def fault(phase):
            if phase=='before-stop':raise ValueError('early')
        with self.assertRaisesRegex(ValueError,'early'): self.run_cutover(lambda phase:'pass',fault=fault)
        self.assertTrue(self.serving);self.assertEqual(self.events,[])

    def test_fault_after_promotion_recovers_without_rewinding_file(self):
        before=guard.capture(self.db)
        def fault(phase):
            if phase=='after-promote':raise ValueError('promoted')
        self.assertEqual(self.run_cutover(lambda phase:'pass',fault=fault),'recovered');guard.preserved(before,guard.capture(self.db))

    def test_changed_controller_refuses_before_actions(self):
        self.packet.write_text(json.dumps({'version':1,'controllerSha256':'0'*64}))
        with self.assertRaisesRegex(ValueError,'CONTROLLER_MANIFEST'):self.run_cutover(lambda phase:'pass')
        self.assertEqual(self.events,[])

    def test_lease_excludes_competing_process_and_retains_claim(self):
        import subprocess
        with release.release_lease(self.app) as owned:
            code='import sys;sys.path.insert(0,sys.argv[1]);from quarter_release import release_lease\nwith release_lease(sys.argv[2],wait_seconds=0): pass'
            result=subprocess.run([sys.executable,'-c',code,str(Path(release.__file__).parent),str(self.app)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0);self.assertIn('RELEASE_BUSY',result.stderr);owned()


if __name__=='__main__':unittest.main()
