"""Actual-Q1 aggregate must refuse self evidence and incomplete cross-artifact records."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
spec = importlib.util.spec_from_file_location('q1_rehearse', Path(__file__).resolve().parents[1] / 'scripts/quarter-rehearse.py')
rehearse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rehearse)


class Q1AggregateChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'app').mkdir(); (self.root / 'evidence').mkdir()
        (self.root / 'app/QUARTER_ARTIFACT.json').write_text('original R0 bytes')
        self.pin = rehearse.file_hash(self.root / 'app/QUARTER_ARTIFACT.json')
        self.value = {'r0': {'manifestSha256': self.pin}, 'candidate': {'manifestSha256': 'b' * 64}, 'identity': [1, 2]}
        self.r0 = {'sourceSha': '0' * 40, 'quarterUi': False}
        self.q1 = {'sourceSha': '1' * 40, 'quarterUi': True}
        self.database = self.root / 'unused.db'

    def tearDown(self):
        self.temp.cleanup()

    def run_aggregate(self, packet=None):
        with patch('quarter_release.target', side_effect=lambda packet, role, db: self.r0 if role == 'r0' else self.q1), patch('quarter_managed_service.listeners', return_value=[]), patch.object(rehearse, 'verify', return_value={}):
            return rehearse.verify_q1(self.root, self.database, self.value, packet or {})

    def test_r0_self_packet_cannot_become_q1_acceptance(self):
        with self.assertRaisesRegex(ValueError, 'ACTUAL_Q1_PACKET_REQUIRED'):
            self.run_aggregate({'syntheticR0SelfRehearsal': True})

    def test_renamed_same_source_is_not_q1(self):
        self.q1['sourceSha'] = self.r0['sourceSha']
        with self.assertRaisesRegex(ValueError, 'DISTINCT_Q1_UI_REQUIRED'):
            self.run_aggregate()

    def test_ui_disabled_candidate_is_not_q1(self):
        self.q1['quarterUi'] = False
        with self.assertRaisesRegex(ValueError, 'DISTINCT_Q1_UI_REQUIRED'):
            self.run_aggregate()

    def test_six_success_labels_without_real_bundle_files_are_insufficient(self):
        outcomes = ['accepted', 'accepted', 'recovered', 'recovered', 'recovery-blocked', 'preflight-refused']
        rows = [{'scenario': case, 'outcome': 'controller-passed', 'controllerOutcome': outcome,
                 'actualBundleCrossings': 'not-applicable-preflight-refused' if 'incompatible' in case else True}
                for case, outcome in zip(rehearse.SCENARIOS[:6], outcomes)]
        (self.root / 'evidence/rehearsal.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
        with self.assertRaises(FileNotFoundError):
            self.run_aggregate()
        self.assertFalse((self.root / 'evidence/verification.json').exists())

    def test_a_missing_case_refuses_before_report(self):
        (self.root / 'evidence/rehearsal.jsonl').write_text('')
        with self.assertRaisesRegex(ValueError, 'Q1_SCENARIOS_INCOMPLETE'):
            self.run_aggregate()


class NievesBindings(unittest.TestCase):
    def setUp(self):
        from quarter_rehearsal_nieves import validate
        self.validate = validate
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        (self.root / 'evidence/nieves').mkdir(parents=True)
        (self.root / 'q1/scripts').mkdir(parents=True)
        (self.root / 'q1/scripts/quarter-rehearsal-nieves.ts').write_text('pinned driver')
        self.fixture = {'r0': {'manifestSha256': 'a'*64}, 'candidate': {'manifestSha256': 'b'*64}, 'database': str(self.root/'db'), 'identity': [1,2]}
        self.sources = {'r0': '0'*40, 'candidate': '1'*40}

    def tearDown(self): self.temp.cleanup()

    def seed_prepared(self, **changes):
        from quarter_rehearsal_nieves import BATTERY
        value = dict(version=1, mode='prepared', role='QP_UI_Q1', sourceSha='1'*40,
                     loadedArtifactSha256='b'*64, driverSha256=rehearse.file_hash(self.root/'q1/scripts/quarter-rehearsal-nieves.ts'),
                     checks=sorted(BATTERY), database={'path': self.fixture['database'], 'device':1, 'inode':2},
                     operations=[{'label':'initial','input':[{'id':'Alma'}], 'result':{'outcome':'imported'}, 'inputSha256':'c'*64, 'rows':[], 'sources':[]}])
        value.update(changes)
        (self.root/'evidence/nieves/prepared.json').write_text(json.dumps(value))

    def test_generic_importer_flags_do_not_satisfy_nieves(self):
        (self.root/'evidence/importers-active').mkdir()
        (self.root/'evidence/importers-active/completed.json').write_text('{"compatibleDrain":true}')
        with self.assertRaisesRegex(ValueError,'NIEVES_EVIDENCE_REQUIRED:prepared'):
            self.validate(self.root,self.fixture,self.sources)

    def test_old_candidate_pin_refuses(self):
        self.seed_prepared(loadedArtifactSha256='c'*64)
        with self.assertRaisesRegex(ValueError,'NIEVES_EVIDENCE_PIN_MISMATCH'):
            self.validate(self.root,self.fixture,self.sources)

    def test_changed_driver_refuses(self):
        self.seed_prepared(driverSha256='d'*64)
        with self.assertRaisesRegex(ValueError,'NIEVES_EVIDENCE_PIN_MISMATCH'):
            self.validate(self.root,self.fixture,self.sources)

    def test_missing_mapping_assertion_refuses(self):
        self.seed_prepared(checks=['eligible-two-seats'])
        with self.assertRaisesRegex(ValueError,'NIEVES_ASSERTIONS_INCOMPLETE'):
            self.validate(self.root,self.fixture,self.sources)

    def test_replaced_database_refuses(self):
        self.seed_prepared(database={'path':self.fixture['database'],'device':1,'inode':99})
        with self.assertRaisesRegex(ValueError,'NIEVES_DATABASE_MISMATCH'):
            self.validate(self.root,self.fixture,self.sources)

    def test_success_labels_without_rows_refuse(self):
        self.seed_prepared(operations=[{'label':'initial','result':{'outcome':'imported'}}])
        with self.assertRaisesRegex(ValueError,'NIEVES_OPERATIONS_INCOMPLETE'):
            self.validate(self.root,self.fixture,self.sources)

    def test_partial_operation_list_cannot_complete_crossings(self):
        self.seed_prepared()
        with self.assertRaisesRegex(ValueError,'NIEVES_OPERATIONS_INCOMPLETE:prepared'):
            self.validate(self.root,self.fixture,self.sources)


    def complete_fixture(self):
        from quarter_rehearsal_nieves import BATTERY, MODES
        folder = self.root/'evidence/nieves'; commands = []
        saved = {'sources':[{'id':'saved'}], 'rows':[{'shiftId':'saved','stationId':'nieves2','seatNumber':2}], 'breaks':[{'id':'booked','coverShiftId':'saved'}], 'hours':[]}
        seed = {'saved': saved, 'input':[{'id':'Alma'}]}
        for mode in MODES:
            role = 'r0' if mode=='recovered' else 'candidate'
            labels = ['initial','repeat','manager-edit','manager-edit','revision','exact','mapping-0','mapping-1','mapping-2','split','eligibility'] if mode in ('prepared','seed') else ['crossing-repeat','r0-existing-allocator' if mode=='recovered' else 'returned-revision']
            operations=[]
            for label in labels:
                if label=='manager-edit': operations.append({'label':label,'receipt':{'requestId':'paint'},'legacyBefore':{'id':'saved'},'legacyAfter':None}); continue
                directory=folder/(mode+'-'+label); directory.mkdir()
                file=directory/'Schedule_for_nieves.csv'; file.write_text('immutable synthetic input')
                operations.append({'label':label,'input':[{'id':'Alma'}],'inputSha256':rehearse.file_hash(file),'result':{'outcome':'imported'},'sources':[{'id':'saved'}],'rows':[{'shiftId':'saved'}], 'receipts':[{'requestId':'import','responseJson':'{}'}]})
            required=BATTERY if mode in ('prepared','seed') else {'crossing-preserved','crossing-repeat','r0-single-seat-baseline' if mode=='recovered' else 'returned-revision-preserves'}
            value={'version':1,'mode':mode,'role':'QP_COMPAT_R0' if role=='r0' else 'QP_UI_Q1','sourceSha':self.sources[role], 'loadedArtifactSha256':self.fixture[role]['manifestSha256'], 'driverSha256':rehearse.file_hash(self.root/'q1/scripts/quarter-rehearsal-nieves.ts'),'checks':sorted(required),'operations':operations,'database':{'path':self.fixture['database'],'device':1,'inode':2},'date':'2040-01-01' if mode=='prepared' else '2040-02-01','state':seed}
            if mode in ('recovered','returned'): value['before']=saved
            (folder/(mode+'.json')).write_text(json.dumps(value))
            log=folder/(mode+'.log'); log.write_text('retained log')
            commands.extend([{'action':'start','mode':mode,'artifactSha256':self.fixture[role]['manifestSha256'],'sourceSha':self.sources[role],'driverSha256':value['driverSha256']},{'action':'finish','mode':mode,'exit':0,'logSha256':rehearse.file_hash(log)}])
        (folder/'commands.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in commands))

    def test_complete_pinned_records_bind_every_input(self):
        self.complete_fixture()
        evidence=self.validate(self.root,self.fixture,self.sources)
        self.assertEqual(len([f for f in evidence if f.endswith('.csv')]),22)

    def test_csv_tampering_refuses(self):
        self.complete_fixture()
        (self.root/'evidence/nieves/seed-initial/Schedule_for_nieves.csv').write_text('changed')
        with self.assertRaisesRegex(ValueError,'NIEVES_INPUT_MISMATCH:seed'):
            self.validate(self.root,self.fixture,self.sources)

    def test_missing_csv_refuses(self):
        self.complete_fixture()
        (self.root/'evidence/nieves/returned-crossing-repeat/Schedule_for_nieves.csv').unlink()
        with self.assertRaisesRegex(ValueError,'NIEVES_INPUT_REQUIRED:returned'):
            self.validate(self.root,self.fixture,self.sources)

    def test_missing_import_receipt_refuses(self):
        self.complete_fixture(); file=self.root/'evidence/nieves/seed.json'; data=json.loads(file.read_text()); data['operations'][0]['receipts']=[]; file.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'NIEVES_IMPORT_RECEIPT_REQUIRED:seed'):
            self.validate(self.root,self.fixture,self.sources)

    def test_changed_saved_number_refuses(self):
        self.complete_fixture(); file=self.root/'evidence/nieves/recovered.json'; data=json.loads(file.read_text()); data['state']['saved']['rows'][0]['seatNumber']=1; file.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'NIEVES_SAVED_INTENT_CHANGED'):
            self.validate(self.root,self.fixture,self.sources)

    def test_changed_returned_cover_refuses(self):
        self.complete_fixture(); file=self.root/'evidence/nieves/returned.json'; data=json.loads(file.read_text()); data['state']['saved']['breaks']=[]; file.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'NIEVES_RETURNED_INTENT_CHANGED'):
            self.validate(self.root,self.fixture,self.sources)

    def test_failed_child_refuses(self):
        self.complete_fixture(); file=self.root/'evidence/nieves/commands.jsonl'; data=[json.loads(line) for line in file.read_text().splitlines()]; data[-1]['exit']=1; file.write_text(''.join(json.dumps(row)+'\n' for row in data))
        with self.assertRaisesRegex(ValueError,'NIEVES_COMMANDS_INCOMPLETE'):
            self.validate(self.root,self.fixture,self.sources)


if __name__ == '__main__':
    unittest.main()
