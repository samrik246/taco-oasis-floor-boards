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
import quarter_importers as importers
from datetime import datetime, timezone


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

    def test_relative_importer_process_is_not_missed(self):
        import subprocess
        observed=[]
        def pgrep(argv,**kwargs):
            observed.append(argv)
            return subprocess.CompletedProcess(argv,0,'8123\n','')
        with patch.object(importers.subprocess,'run',side_effect=pgrep):
            self.assertEqual(importers.matching_importers(self.app),{8123})
        self.assertIn('wiw-export',observed[0][-1]);self.assertNotIn(str(self.app),observed[0][-1])

    def test_loaded_timer_measures_launch_and_calendar(self):
        public={'ProgramArguments':['/synthetic/run-import','--hourly'],'WorkingDirectory':'/synthetic/app'}
        lines=['program = /synthetic/run-import','working directory = /synthetic/app','arguments = {','/synthetic/run-import','--hourly','}',
               'environment = {','discarded = redacted-fixture','}', 'event triggers = {','stream = com.apple.launchd.calendarinterval','descriptor = {','"Hour" => 6','"Minute" => 0','}','}']
        self.assertEqual(importers.loaded_timer(lines,public),[{'Hour':6,'Minute':0}])
        for old,new in [('program = /synthetic/run-import','program = /synthetic/old-import'),('--hourly','--old'),('working directory = /synthetic/app','working directory = /synthetic/old')]:
            with self.assertRaisesRegex(ValueError,'IMPORTER_LOADED_LAUNCH_CHANGED'):
                importers.loaded_timer([new if line==old else line for line in lines],public)

    def test_client_readback_negative_matrix(self):
        now=1790880000000
        iso=lambda ms:datetime.fromtimestamp(ms/1000,timezone.utc).isoformat().replace('+00:00','Z')
        device={'label':'floor','clientInstanceId':'11111111-1111-4111-8111-111111111111','origin':'http://floor-boards.test:3100','role':'floor','board':'caja','view':'schedule','disposition':'retained'}
        manifest={'sourceSha':'a'*40,'staticSha256':'b'*64}
        inventory={'version':1,'synthetic':True,'operatorId':'owner','revision':'fixture','enumeratedAt':iso(now-2000),'devices':[device]}
        record={'version':1,'synthetic':True,'challengeId':'22222222-2222-4222-8222-222222222222','issuedAt':iso(now-1500),'receivedAt':iso(now-500),'operatorId':'owner','inventorySha256':guard.hash_value(inventory),'artifactSha256':'c'*64,'staticSha256':'b'*64,'label':'floor','matched':True,
                'measurement':{k:device[k] for k in ('clientInstanceId','origin','role','board')},'visible':{k:device[k] for k in ('label','clientInstanceId','board','view')}}
        record['measurement'].update(challengeId=record['challengeId'],observedDatabaseEpoch='fixture-epoch',schemaFingerprint=guard.capture(self.db)['schemaSha256'],clientBuildSha='a'*40,protocol=2,cacheSchema=2,draftDbVersion=1,isSecureContext=False,idbProbe='commit-readback-ok',legacyBoardCacheAbsent=True)
        record['visible'].update(oldTabsClosed=True,observedAt=iso(now-1000))
        server=self.app/'var/quarter-clients';server.mkdir(parents=True)
        inv_file=self.root/'inventory.json';records_file=self.root/'readbacks.json'
        def publish(inv,record):
            inv_file.write_text(guard.canonical(inv));(server/('inventory-'+guard.hash_value(inv)+'.json')).write_text(guard.canonical(inv))
            record=dict(record,inventorySha256=guard.hash_value(inv));record['recordSha256']=guard.hash_value(record)
            records_file.write_text(guard.canonical([record]));(server/(record['challengeId']+'.receipt.json')).write_text(guard.canonical(record))
            return {'clients':{'inventoryPath':str(inv_file),'inventorySha256':guard.file_hash(inv_file),'readbacksPath':str(records_file),'readbacksSha256':guard.file_hash(records_file)},'r0':{'path':'r0','manifestSha256':'c'*64},'candidate':{'path':'q1','manifestSha256':'d'*64}}
        with patch.object(release.artifacts,'verify',return_value=manifest):
            self.assertEqual(release.readbacks(publish(inventory,record),self.app,guard.capture(self.db),now)['retained'],1)
            for mode in ('expired','future','origin','epoch','build','unmatched','future-inventory','stale-inventory','duplicate-device','protocol-boolean','challenge'):
                with self.subTest(mode=mode):
                    inv=json.loads(json.dumps(inventory));r=json.loads(json.dumps(record))
                    if mode=='expired':r['receivedAt']=iso(now-900001)
                    if mode=='future':r['receivedAt']=iso(now+1)
                    if mode=='origin':r['measurement']['origin']='http://other.test:3100'
                    if mode=='epoch':r['measurement']['observedDatabaseEpoch']='other'
                    if mode=='build':r['measurement']['clientBuildSha']='f'*40
                    if mode=='unmatched':r['matched']=1
                    if mode=='future-inventory':inv['enumeratedAt']=iso(now+1)
                    if mode=='stale-inventory':inv['enumeratedAt']=iso(now-900001)
                    if mode=='duplicate-device':inv['devices'].append(dict(device,label='second'))
                    if mode=='protocol-boolean':r['measurement']['draftDbVersion']=True
                    if mode=='challenge':r['measurement']['challengeId']='33333333-3333-4333-8333-333333333333'
                    with self.assertRaisesRegex(ValueError,'CLIENT_READBACK_MISSING_OR_STALE'):
                        release.readbacks(publish(inv,r),self.app,guard.capture(self.db),now)


if __name__=='__main__':unittest.main()
