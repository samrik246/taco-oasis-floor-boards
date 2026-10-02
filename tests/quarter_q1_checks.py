"""Actual-Q1 aggregate must refuse self evidence and incomplete cross-artifact records."""
import importlib.util
import copy
import json
import os
import shutil
import sqlite3
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
        with self.assertRaisesRegex(ValueError, 'SCENARIO_BOUNDARY_EVIDENCE_REQUIRED'):
            self.run_aggregate()
        self.assertFalse((self.root / 'evidence/verification.json').exists())

    def test_a_missing_case_refuses_before_report(self):
        (self.root / 'evidence/rehearsal.jsonl').write_text('')
        with self.assertRaisesRegex(ValueError, 'Q1_SCENARIOS_INCOMPLETE'):
            self.run_aggregate()


class NievesBindings(unittest.TestCase):
    def setUp(self):
        from quarter_rehearsal_nieves import validate
        self.validate = lambda root, fixture, sources: validate(root, fixture, sources, self.support)
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name).resolve() / 'run'
        (self.root / 'evidence/nieves').mkdir(parents=True)
        driver = self.root.parent / 'support/quarter-rehearsal-nieves.ts'; driver.parent.mkdir(); driver.write_text('pinned driver')
        helper = Path(rehearse.APP) / 'scripts/quarter_rehearsal_nieves.py'
        self.support = {'version': 1, 'driver': {'path': str(driver), 'sha256': rehearse.file_hash(driver)}, 'helper': {'path': str(helper), 'sha256': rehearse.file_hash(helper)}}
        self.fixture = {'r0': {'manifestSha256': 'a'*64}, 'candidate': {'manifestSha256': 'b'*64}, 'database': str(self.root/'db'), 'identity': [1,2]}
        self.sources = {'r0': '0'*40, 'candidate': '1'*40}

    def tearDown(self): self.temp.cleanup()

    def seed_prepared(self, **changes):
        from quarter_rehearsal_nieves import BATTERY
        value = dict(version=1, mode='prepared', role='QP_UI_Q1', sourceSha='1'*40,
                     loadedArtifactSha256='b'*64, driverSha256=self.support['driver']['sha256'],
                     checks=sorted(BATTERY), database={'path': self.fixture['database'], 'device':1, 'inode':2},
                     operations=[{'label':'initial','input':[{'id':'Alma'}], 'result':{'outcome':'imported'}, 'inputSha256':'c'*64, 'rows':[], 'sources':[]}])
        value.update(driverPath=self.support['driver']['path'], applicationPath=str(self.root/'q1'))
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
            value={'version':1,'mode':mode,'role':'QP_COMPAT_R0' if role=='r0' else 'QP_UI_Q1','sourceSha':self.sources[role], 'loadedArtifactSha256':self.fixture[role]['manifestSha256'], 'driverSha256':self.support['driver']['sha256'],'checks':sorted(required),'operations':operations,'database':{'path':self.fixture['database'],'device':1,'inode':2},'date':'2040-01-01' if mode=='prepared' else '2040-02-01','state':seed}
            app = self.root / ('q1' if mode == 'prepared' else 'app')
            value.update(driverPath=self.support['driver']['path'], applicationPath=str(app))
            if mode in ('recovered','returned'): value['before']=saved
            (folder/(mode+'.json')).write_text(json.dumps(value))
            log=folder/(mode+'.log'); log.write_text('retained log')
            from quarter_rehearsal_nieves import origin
            prior=folder/(('recovered' if mode=='returned' else 'seed')+'.json')
            command=['node',str(app/'node_modules/tsx/dist/cli.mjs'),'--tsconfig',str(app/'tsconfig.json'),self.support['driver']['path'],str(app),mode,value['date'],str(folder/(mode+'.json')),str(prior)]
            commands.extend([{**origin(self.support,app),'command':command,'action':'start','mode':mode,'artifactSha256':self.fixture[role]['manifestSha256'],'sourceSha':self.sources[role],'driverSha256':value['driverSha256']},{'action':'finish','mode':mode,'exit':0,'logSha256':rehearse.file_hash(log)}])
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


    def test_changed_external_driver_refuses_before_evidence(self):
        self.complete_fixture()
        Path(self.support['driver']['path']).write_text('changed driver')
        with self.assertRaisesRegex(ValueError, 'NIEVES_SUPPORT_CHANGED:driver'):
            self.validate(self.root, self.fixture, self.sources)

    def test_application_origin_cannot_be_the_driver_tree(self):
        self.complete_fixture(); file=self.root/'evidence/nieves/recovered.json'
        data=json.loads(file.read_text()); data['applicationPath']=str(Path(self.support['driver']['path']).parent); file.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'NIEVES_EVIDENCE_ORIGIN_MISMATCH:recovered'):
            self.validate(self.root, self.fixture, self.sources)

    def test_command_cannot_substitute_copied_runtime_driver(self):
        self.complete_fixture(); file=self.root/'evidence/nieves/commands.jsonl'
        data=[json.loads(line) for line in file.read_text().splitlines()]; data[0]['command'][4]=str(self.root/'q1/scripts/quarter-rehearsal-nieves.ts')
        file.write_text(''.join(json.dumps(row)+'\n' for row in data))
        with self.assertRaisesRegex(ValueError, 'NIEVES_COMMAND_PATH_MISMATCH'):
            self.validate(self.root, self.fixture, self.sources)


class NievesSupportPreflight(unittest.TestCase):
    def setUp(self):
        import re
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name).resolve()
        repo=Path(rehearse.APP); self.source=self.root/'source'; scripts=self.source/'scripts'; scripts.mkdir(parents=True)
        helper=scripts/'quarter_rehearsal_nieves.py'; shutil.copy2(repo/'scripts/quarter_rehearsal_nieves.py',helper)
        spec=importlib.util.spec_from_file_location('external_nieves_helper',helper)
        self.helper=importlib.util.module_from_spec(spec); spec.loader.exec_module(self.helper)
        driver=self.root/'support/quarter-rehearsal-nieves.ts'; driver.parent.mkdir(); shutil.copy2(repo/'scripts/quarter-rehearsal-nieves.ts',driver)
        self.support={'version':1,'driver':{'path':str(driver),'sha256':rehearse.file_hash(driver)},'helper':{'path':str(helper),'sha256':rehearse.file_hash(helper)}}
        modules=re.findall(r'load\(path\.join\(app, "([^"]+)"\)\)',driver.read_text())
        files=['scripts/quarter-rehearse.py','scripts/quarter_scenarios.py','scripts/quarter_artifacts.py','scripts/quarter_guard.py','scripts/quarter_release.py','scripts/quarter_rehearsal_environment.py','tsconfig.json','package.json','node_modules/tsx/dist/cli.mjs','node_modules/prisma/build/index.js',*modules]
        self.runtimes={}
        for role in ('source','q1','r0'):
            app=self.root/role; entries=[]
            for name in files:
                path=app/name; path.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(repo/name,path)
                entries.append([name,'file',rehearse.file_hash(path),420])
            manifest=app/'QUARTER_ARTIFACT.json'; manifest.write_text(json.dumps({'files':entries}))
            if role!='source': self.runtimes[role]={'path':str(app),'manifestSha256':rehearse.file_hash(manifest)}
        self.database=self.root/'not-initialized/data/floor-boards.db'

    def tearDown(self): self.temp.cleanup()

    def run_preflight(self):
        # A real copied-file layout: runtime scripts intentionally omit both
        # external Nieves support files, exactly like accepted R0/candidate.
        return self.helper.preflight(self.support,self.source,self.runtimes)

    def test_external_support_succeeds_with_runtime_omissions(self):
        result=self.run_preflight()
        for role in ('q1','r0'):
            self.assertFalse((self.root/role/'scripts/quarter-rehearsal-nieves.ts').exists())
            self.assertFalse((self.root/role/'scripts/quarter_rehearsal_nieves.py').exists())
        self.assertEqual(result['entrypoints']['nieves-driver'],self.support['driver']['path'])
        self.assertFalse(self.database.parent.parent.exists())

    def test_missing_driver_refuses_before_initialization(self):
        Path(self.support['driver']['path']).unlink()
        with self.assertRaisesRegex(ValueError,'NIEVES_SUPPORT_MISSING:driver'): self.run_preflight()
        self.assertFalse(self.database.parent.parent.exists())

    def test_changed_driver_refuses_before_initialization(self):
        Path(self.support['driver']['path']).write_text('changed')
        with self.assertRaisesRegex(ValueError,'NIEVES_SUPPORT_CHANGED:driver'): self.run_preflight()
        self.assertFalse(self.database.parent.parent.exists())

    def test_changed_helper_refuses_before_initialization(self):
        Path(self.support['helper']['path']).write_text('changed')
        with self.assertRaisesRegex(ValueError,'NIEVES_SUPPORT_CHANGED:helper'): self.run_preflight()
        self.assertFalse(self.database.parent.parent.exists())

    def test_other_helper_origin_refuses(self):
        helper=self.root/'other-helper.py'; shutil.copy2(self.support['helper']['path'],helper)
        self.support['helper']['path']=str(helper)
        with self.assertRaisesRegex(ValueError,'NIEVES_HELPER_ORIGIN_MISMATCH'): self.run_preflight()

    def test_missing_runtime_entrypoint_refuses(self):
        (self.root/'r0/scripts/quarter-rehearse.py').unlink()
        with self.assertRaisesRegex(ValueError,'NIEVES_PREFLIGHT_DEPENDENCY_REQUIRED:r0'): self.run_preflight()
        self.assertFalse(self.database.parent.parent.exists())

    def test_changed_application_module_refuses(self):
        (self.root/'q1/src/lib/import/folder-import.ts').write_text('changed application')
        with self.assertRaisesRegex(ValueError,'NIEVES_PREFLIGHT_DEPENDENCY_REQUIRED:q1'): self.run_preflight()


class ActivationTransitionChecks(unittest.TestCase):
    def setUp(self):
        import quarter_guard as guard
        import quarter_rehearsal_measurements as measurements
        import quarter_release as release
        self.guard, self.measurements, self.release = guard, measurements, release
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('FLOOR_BOARDS_TEST_ROOT'))
        self.root = Path(self.temp.name).resolve(); self.database = self.root / 'test.db'
        self.app = self.root / 'app'; self.app.mkdir()
        self.out = self.root / 'measurements'; self.out.mkdir()
        columns = json.loads(guard.REGISTRY.read_text())
        migration_path = Path(rehearse.APP) / 'src/lib/quarter/migration-sql.ts'
        # Execute the actual source SQL, including the real revision trigger.
        sql = json.loads(migration_path.read_text().split('= ', 1)[1].split(' as const;', 1)[0])
        with sqlite3.connect(self.database) as db:
            for table, names in columns.items():
                if table in guard.QUARTER_TABLES: continue
                fields = [guard.quote(name) + (' TEXT PRIMARY KEY' if name == 'id' else ' TEXT') for name in names if name != 'rowid']
                db.execute('CREATE TABLE ' + guard.quote(table) + '(' + ','.join(fields) + ')')
            for statement in sql: db.execute(statement)
            db.execute('INSERT INTO QuarterWorldRevision VALUES(1,664)')
            db.execute("INSERT INTO QuarterSchema VALUES(1,2,'prepared','synthetic-epoch',1,1,?,NULL)", ('a' * 64,))
            db.execute("INSERT INTO Manager(id,name) VALUES('m','Synthetic')")
        self.packet = self.root / 'packet.json'
        self.packet.write_text(json.dumps({'version': 1, 'controllerSha256': guard.file_hash(release.__file__)}))
        self.reader = {'retained': 2}
        identity = self.database.stat()
        self.fixture = {'database': str(self.database), 'identity': [identity.st_dev, identity.st_ino]}

    def tearDown(self): self.temp.cleanup()

    def activate(self):
        self.assertTrue((self.out / 'activation-before.json').is_file())
        self.assertFalse((self.out / 'activation-after.json').exists())
        with patch.object(self.release, 'target'), patch.object(self.release, 'readbacks', return_value=self.reader), patch('quarter_importers.verify_importers', return_value={}):
            self.release.activate(self.packet, self.app, self.database, self.out / 'activation.jsonl')

    def collect(self, mutation=None):
        def action():
            self.activate()
            if mutation:
                with sqlite3.connect(self.database) as db:
                    db.execute('PRAGMA ignore_check_constraints=ON')
                    db.executescript(mutation)
        return self.measurements.retain_activation(self.database, self.out, action)

    def snapshots(self):
        return [json.loads((self.out / name).read_text()) for name in self.measurements.ACTIVATION_FILES[:2]]

    def evidence(self, binding):
        return self.measurements.validate_activation_evidence(self.out, {'activationEvidence': binding, 'readerProof': self.reader}, self.fixture)

    def assert_retained(self):
        before, after = self.snapshots()
        self.assertEqual(len(before['guard']['tables']), 26)
        self.assertEqual(len(after['guard']['tables']), 26)
        self.assertIn('QuarterWorldRevision', after['rows'])
        self.assertFalse((self.out / 'completed.json').exists())

    def test_actual_controller_and_pinned_trigger_increment_nonzero_once(self):
        binding = self.collect(); before, after = self.snapshots()
        self.assertEqual(before['rows']['QuarterWorldRevision']['values'][0][1], ['integer', '665'])
        self.assertEqual(after['rows']['QuarterWorldRevision']['values'][0][1], ['integer', '666'])
        self.assertEqual(set(self.evidence(binding)), {'measurements/' + name for name in self.measurements.ACTIVATION_FILES})

    def test_zero_increment_refuses_and_keeps_both_snapshots(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_REVISION_TRANSITION_INVALID'):
            self.collect('UPDATE QuarterWorldRevision SET revision=revision-1')
        self.assert_retained()

    def test_extra_increment_refuses_and_keeps_both_snapshots(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_REVISION_TRANSITION_INVALID'):
            self.collect('UPDATE QuarterWorldRevision SET revision=revision+1')
        self.assert_retained()

    def test_missing_before_revision_refuses(self):
        with sqlite3.connect(self.database) as db: db.execute('DELETE FROM QuarterWorldRevision')
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_SINGLETON_INVALID:QuarterWorldRevision'): self.collect()
        self.assert_retained()

    def test_missing_after_revision_refuses(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_SINGLETON_INVALID:QuarterWorldRevision'):
            self.collect('DELETE FROM QuarterWorldRevision')
        self.assert_retained()

    def test_extra_singleton_refuses(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_SINGLETON_INVALID:QuarterWorldRevision'):
            self.collect('INSERT INTO QuarterWorldRevision VALUES(2,666)')
        self.assert_retained()

    def test_malformed_revision_refuses(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_REVISION_ROW_INVALID'):
            self.collect("UPDATE QuarterWorldRevision SET revision='bad'")
        self.assert_retained()

    def test_unrelated_table_mutation_refuses(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_DATA_CHANGED:Manager'):
            self.collect("UPDATE Manager SET name='changed'")
        self.assert_retained()

    def test_epoch_drift_refuses_even_with_exact_increment(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_SCHEMA_TRANSITION_INVALID'):
            self.collect("UPDATE QuarterSchema SET databaseEpoch='changed'; UPDATE QuarterWorldRevision SET revision=666")
        self.assert_retained()

    def test_action_exception_still_keeps_immediate_after(self):
        def fail():
            self.activate()
            raise ValueError('INJECTED_AFTER_ACTIVATION')
        with self.assertRaisesRegex(ValueError, 'INJECTED_AFTER_ACTIVATION'):
            self.measurements.retain_activation(self.database, self.out, fail)
        self.assert_retained()

    def test_r0_self_refusal_still_preserves_database(self):
        packet = json.loads(self.packet.read_text()); packet['syntheticR0SelfRehearsal'] = True
        self.packet.write_text(json.dumps(packet)); before = self.guard.capture(self.database)
        with self.assertRaisesRegex(ValueError, 'ACTUAL_Q1_PIN_REQUIRED'): self.collect()
        self.guard.preserved(before, self.guard.capture(self.database)); self.assert_retained()

    def test_state_identity_schema_registry_and_foreign_key_drift_refuse(self):
        self.collect(); original = self.snapshots()
        for key, value in (('database', {'device': 5, 'inode': 6}), ('schemaSha256', '0' * 64),
                           ('registrySha256', '0' * 64), ('foreignKeys', 0), ('foreignKeyViolations', 1)):
            with self.subTest(key=key):
                before, after = copy.deepcopy(original); after['guard'][key] = value
                with self.assertRaises(ValueError): self.measurements.validate_activation_transition(before, after)
        for side, index, value in ((0, 2, ['text', 'active']), (1, 0, ['integer', '2']), (1, 1, ['integer', '3']),
                                    (1, 2, ['text', 'prepared']), (1, 4, ['integer', '1']), (1, 5, ['integer', '1']),
                                    (1, 6, ['text', 'b' * 64]), (1, 7, ['integer', '1']), (1, 7, ['null', None])):
            with self.subTest(side=side, index=index, value=value):
                pair = copy.deepcopy(original); snapshot = pair[side]
                rows = snapshot['rows']['QuarterSchema']['values']; rows[0][index] = value
                snapshot['guard']['tables']['QuarterSchema']['sha256'] = self.guard.hash_value(rows)
                snapshot['guard']['state'] = [int(v) if kind == 'integer' else v for kind, v in rows[0][1:]]
                with self.assertRaises(ValueError): self.measurements.validate_activation_transition(*pair)

    def test_missing_schema_row_and_inconsistent_guard_refuse(self):
        self.collect(); before, after = self.snapshots()
        for rows in ([], after['rows']['QuarterSchema']['values'] * 2):
            altered = copy.deepcopy(after); altered['rows']['QuarterSchema']['values'] = rows
            with self.assertRaisesRegex(ValueError, 'ACTIVATION_SINGLETON_INVALID:QuarterSchema'):
                self.measurements.validate_activation_transition(before, altered)
        after['guard']['tables']['QuarterWorldRevision']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_ROW_GUARD_MISMATCH'):
            self.measurements.validate_activation_transition(before, after)

    def test_aggregate_requires_bound_snapshots_and_journal(self):
        binding = self.collect()
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_EVIDENCE_REQUIRED'): self.evidence({})
        for name in binding:
            changed = dict(binding, **{name: '0' * 64})
            with self.assertRaisesRegex(ValueError, 'ACTIVATION_EVIDENCE_CHANGED'): self.evidence(changed)
        self.fixture['identity'][1] += 1
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_DATABASE_MISMATCH'): self.evidence(binding)

    def test_aggregate_revalidates_even_rehashed_invalid_transition(self):
        binding = self.collect(); before, after = self.snapshots()
        after['rows']['QuarterWorldRevision']['values'][0][1] = ['integer', '667']
        after['guard']['tables']['QuarterWorldRevision']['sha256'] = self.guard.hash_value(after['rows']['QuarterWorldRevision']['values'])
        path = self.out / 'activation-after.json'; path.write_text(json.dumps(after))
        binding[path.name] = self.guard.file_hash(path)
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_REVISION_TRANSITION_INVALID'): self.evidence(binding)

    def test_aggregate_rejects_journal_guard_drift(self):
        binding = self.collect(); path = self.out / 'activation.jsonl'
        event = json.loads(path.read_text()); event['guard']['schemaSha256'] = '0' * 64
        path.write_text(json.dumps(event) + '\n'); binding[path.name] = self.guard.file_hash(path)
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_JOURNAL_MISMATCH'): self.evidence(binding)


class ScenarioBoundaryChecks(unittest.TestCase):
    def setUp(self):
        ActivationTransitionChecks.setUp(self)
        import quarter_scenarios as scenarios
        self.scenarios = scenarios
        with sqlite3.connect(self.database) as db:
            db.execute('DROP TABLE StaffBreakLock')
            db.execute('CREATE TABLE StaffBreakLock(id INTEGER PRIMARY KEY, updatedAt DATETIME NOT NULL)')
            db.executemany('INSERT INTO StaffBreakLock VALUES(?,?)', [(1, 1000), (2, 2000)])

    def tearDown(self): self.temp.cleanup()

    def mutate(self, sql):
        with sqlite3.connect(self.database) as db: db.executescript(sql)

    def snapshot(self, label): return self.scenarios.boundary_snapshot(self.database, self.out, label)

    def load(self, label): return json.loads((self.out / (label + '-boundary.json')).read_text())

    def ordered(self):
        self.snapshot('post-acknowledgement')
        def read():
            self.assertTrue((self.out / 'pre-nieves-read-boundary.json').exists())
            self.assertFalse((self.out / 'post-nieves-boundary.json').exists())
            self.mutate('UPDATE StaffBreakLock SET updatedAt=3000 WHERE id=2')
        return self.scenarios.authenticated_boundary(self.database, self.out, read)

    def complete(self):
        self.ordered(); self.snapshot('recovery-after'); self.snapshot('return-before'); self.snapshot('return-after')
        names, _ = self.scenarios.boundary_contract('normal-r0-q1-r0-q1')
        return {'scenario': 'normal-r0-q1-r0-q1', 'boundaryEvidence': {n + '-boundary.json': self.guard.file_hash(self.out / (n + '-boundary.json')) for n in names}}

    def test_final_read_precedes_strict_baseline_and_retains_safe_auth_delta(self):
        baseline = self.ordered(); after = self.snapshot('recovery-after')
        self.scenarios.validate_boundary_pair(baseline, after)
        before = self.load('pre-nieves-read')
        self.assertEqual(before['lockRows']['values'][1][1], ['integer', '2000'])
        self.assertEqual(baseline['lockRows']['values'][1][1], ['integer', '3000'])
        with self.assertRaisesRegex(ValueError, 'QUARTER_PRESERVATION_CHANGED:tables'):
            self.scenarios.validate_boundary_pair(before, after)
        self.assertEqual(len(after['guard']['tables']), 26)

    def test_lock_mutation_after_final_baseline_refuses_with_raw_rows(self):
        before = self.ordered(); self.mutate('UPDATE StaffBreakLock SET updatedAt=4000 WHERE id=2')
        after = self.snapshot('recovery-after')
        with self.assertRaisesRegex(ValueError, 'QUARTER_PRESERVATION_CHANGED:tables'):
            self.scenarios.validate_boundary_pair(before, after)
        self.assertEqual(self.load('recovery-after')['lockRows']['values'][1][1], ['integer', '4000'])

    def test_unrelated_mutation_after_final_baseline_refuses(self):
        before = self.ordered(); self.mutate("UPDATE Manager SET name='changed'")
        after = self.snapshot('recovery-after')
        with self.assertRaisesRegex(ValueError, 'QUARTER_PRESERVATION_CHANGED:tables'):
            self.scenarios.validate_boundary_pair(before, after)

    def test_acknowledged_receipt_removal_refuses(self):
        self.mutate("INSERT INTO PaintCommandReceipt VALUES('m','ack',?, 'synthetic-epoch',1,2,'{}',1000)".replace('?', "'" + 'a' * 64 + "'"))
        before = self.ordered(); self.mutate('DELETE FROM PaintCommandReceipt')
        with self.assertRaisesRegex(ValueError, 'QUARTER_PRESERVATION_CHANGED:tables'):
            self.scenarios.validate_boundary_pair(before, self.snapshot('recovery-after'))

    def test_auth_action_exception_still_retains_after_rows(self):
        def fail():
            self.mutate('UPDATE StaffBreakLock SET updatedAt=3000 WHERE id=2')
            raise ValueError('READ_FAILED')
        with self.assertRaisesRegex(ValueError, 'READ_FAILED'):
            self.scenarios.authenticated_boundary(self.database, self.out, fail)
        self.assertEqual(self.load('post-nieves')['lockRows']['values'][1][1], ['integer', '3000'])

    def test_malformed_lock_failure_is_saved_before_validation(self):
        before = self.ordered(); self.mutate("UPDATE StaffBreakLock SET updatedAt='bad' WHERE id=2")
        after = self.snapshot('recovery-after')
        with self.assertRaisesRegex(ValueError, 'BOUNDARY_LOCK_ROWS_INVALID'):
            self.scenarios.validate_boundary_pair(before, after)
        self.assertEqual(self.load('recovery-after')['lockRows']['values'][1][1], ['text', 'bad'])

    def test_guard_failure_is_saved(self):
        self.mutate('DROP TABLE StaffBreakLock'); value = self.snapshot('recovery-after')
        self.assertEqual(set(value['errors']), {'guard', 'lockRows'})
        with self.assertRaisesRegex(ValueError, 'BOUNDARY_SNAPSHOT_INVALID'): self.scenarios.validate_boundary_snapshot(value)

    def test_existing_evidence_cannot_be_rebaselined(self):
        original = self.snapshot('post-nieves'); self.mutate('UPDATE StaffBreakLock SET updatedAt=4000')
        with self.assertRaisesRegex(ValueError, 'BOUNDARY_EVIDENCE_EXISTS'): self.snapshot('post-nieves')
        self.assertEqual(self.load('post-nieves'), original)

    def test_same_database_identity_and_order_required(self):
        before = self.ordered(); original = self.snapshot('recovery-after')
        for key, value in (('databasePath', 'replacement.db'), ('startedAtMs', 1)):
            after = copy.deepcopy(original); after[key] = value
            with self.assertRaises(ValueError): self.scenarios.validate_boundary_pair(before, after)
        after = copy.deepcopy(original); after['guard']['database']['inode'] += 1; after['rowDatabase']['inode'] += 1
        with self.assertRaisesRegex(ValueError, 'QUARTER_PRESERVATION_CHANGED:database'):
            self.scenarios.validate_boundary_pair(before, after)

    def test_completion_binds_both_crossings_and_auth_diagnostics(self):
        completion = self.complete()
        bound = self.scenarios.validate_scenario_boundaries(self.out, completion, self.fixture)
        self.assertEqual(len(bound), 6)
        for name in list(completion['boundaryEvidence']):
            changed = copy.deepcopy(completion); del changed['boundaryEvidence'][name]
            with self.assertRaisesRegex(ValueError, 'SCENARIO_BOUNDARY_EVIDENCE_REQUIRED'):
                self.scenarios.validate_scenario_boundaries(self.out, changed, self.fixture)

    def test_changed_and_rehashed_invalid_boundary_refuse(self):
        completion = self.complete(); path = self.out / 'recovery-after-boundary.json'; value = json.loads(path.read_text())
        value['lockRows']['values'][1][1] = ['integer', '9999']; value['guard']['tables']['StaffBreakLock']['sha256'] = self.guard.hash_value(value['lockRows']['values'])
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'SCENARIO_BOUNDARY_CHANGED'):
            self.scenarios.validate_scenario_boundaries(self.out, completion, self.fixture)
        completion['boundaryEvidence'][path.name] = self.guard.file_hash(path)
        with self.assertRaisesRegex(ValueError, 'QUARTER_PRESERVATION_CHANGED:tables'):
            self.scenarios.validate_scenario_boundaries(self.out, completion, self.fixture)

    def test_aggregate_refuses_wrong_fixture_identity(self):
        completion = self.complete(); self.fixture['identity'][1] += 1
        with self.assertRaisesRegex(ValueError, 'SCENARIO_BOUNDARY_DATABASE_MISMATCH'):
            self.scenarios.validate_scenario_boundaries(self.out, completion, self.fixture)

    def test_all_six_cases_require_strict_boundary_pairs(self):
        expected_counts = [2, 1, 1, 1, 1, 1]
        for scenario, count in zip(rehearse.SCENARIOS[:6], expected_counts):
            labels, pairs = self.scenarios.boundary_contract(scenario)
            self.assertEqual(len(pairs), count)
            self.assertTrue(all(a in labels and b in labels for a, b in pairs))


if __name__ == '__main__':
    unittest.main()
