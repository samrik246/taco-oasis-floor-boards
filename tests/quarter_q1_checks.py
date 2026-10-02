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
        with self.assertRaisesRegex(ValueError,'NIEVES_IMPORT_ROWS_REQUIRED'):
            self.validate(self.root,self.fixture,self.sources)

    def test_prepared_only_cannot_complete_crossings(self):
        self.seed_prepared()
        with self.assertRaisesRegex(ValueError,'NIEVES_EVIDENCE_REQUIRED:seed'):
            self.validate(self.root,self.fixture,self.sources)


if __name__ == '__main__':
    unittest.main()
