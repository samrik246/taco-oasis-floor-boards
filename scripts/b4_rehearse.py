#!/usr/bin/env python3
"""Boot exact old/new/old/new packet artifacts on one newly synthetic migrated file."""
import argparse
from http.client import HTTPConnection, HTTPException
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
# -B alone prevents writes, not reads of previously cached application bytecode.
# Use a deliberately absent prefix before importing any packet module.
sys.dont_write_bytecode = True
sys.pycache_prefix = str(Path(__file__).resolve().parent / '.no-bytecode-cache')
if Path(sys.pycache_prefix).exists() or Path(sys.pycache_prefix).is_symlink():
    raise ValueError('Packet bytecode prefix must remain absent')
from b4_artifacts import clean_env, copy_runtime, digest, heavy, promote, verify, write_json
from b4_release import guard, require_preserved, verify_live_runtime


def rehearse(packet, evidence):
    packet, evidence = Path(packet).resolve(strict=True), Path(evidence).resolve()
    evidence.mkdir()
    with heavy():
        manifest = verify(packet)
        root = Path('/tmp').resolve() / ('color-boards-test-' + uuid.uuid4().hex)
        root.mkdir()
        app = root / 'app'
        copy_runtime(packet / 'old', app)
        data = app / 'var/data'
        data.mkdir(parents=True)
        database = data / 'rehearsal.db'
        with database.open('xb'):
            pass
        (app / '.env').write_text('B4_REHEARSAL_MARKER=synthetic-only\n')
        env_marker = (app / '.env').read_bytes()
        env = clean_env()
        env.update(DATABASE_URL='file:' + str(database), FLOOR_BOARDS_TEST_ROOT=str(root),
                   MANAGER_SESSION_SECRET='b4-rehearsal-synthetic-session-secret-0000',
                   STAFF_PASSCODE_PEPPER='b4-rehearsal-synthetic-pepper-0000000',
                   FLOOR_BOARDS_E2E_NOW='2040-06-06T13:00:00.000Z')
        identity = [database.stat().st_dev, database.stat().st_ino]
        with (evidence / 'commands.log').open('x') as log:
            def run(command, input=None):
                log.write(json.dumps({'command': command, 'cwd': str(app)}) + '\n'); log.flush()
                subprocess.run(command, cwd=app, env=env, input=input, text=True, stdout=log, stderr=log, check=True)
            # Schema creation is permitted only here, on this just-created synthetic file.
            assert database.stat().st_size == 0 and database.resolve().is_relative_to(root)
            run(['pnpm', 'exec', 'prisma', 'db', 'push', '--skip-generate'])
            run(['node', '-'], r'''
const {PrismaClient}=require('@prisma/client');const {createHash}=require('node:crypto');const db=new PrismaClient();
const hash=code=>createHash('sha256').update('taco-oasis-manager-v1:'+code).digest('hex');
(async()=>{
 await db.manager.create({data:{id:'proof-owner',name:'Synthetic Owner',codeHash:hash('rehearsal-owner-code'),role:'owner'}});
 await db.manager.create({data:{id:'proof-manager',name:'Synthetic Gerente',codeHash:hash('rehearsal-gerente-code'),role:'manager'}});
 for(const id of ['one','two','pending','old-writer']){
  await db.employee.create({data:{id,externalId:'proof-'+id,firstName:id,lastName:'Synthetic'}});
  await db.shift.create({data:{id:'shift-'+id,employeeId:id,date:'2040-06-06',board:'cocina',sourcePosition:id==='two'?'Cocina Guia Abrir':'Cocina',startAt:new Date('2040-06-06T12:00:00Z'),endAt:new Date('2040-06-07T01:00:00Z')}});
 }
 await db.staffBreak.create({data:{id:'proof-booked',employeeId:'one',shiftId:'shift-one',board:'cocina',date:'2040-06-06',startAt:new Date('2040-06-06T19:00:00Z'),endAt:new Date('2040-06-06T19:15:00Z'),actor:'one',status:'booked',coverEmployeeId:'two',coverShiftId:'shift-two',auto:false}});
 await db.staffBreak.create({data:{id:'proof-pending',employeeId:'pending',shiftId:'shift-pending',board:'cocina',date:'2040-06-06',startAt:new Date('2040-06-06T19:30:00Z'),endAt:new Date('2040-06-06T19:45:00Z'),actor:'pending',status:'pending'}});
 for(const station of ['pdf_tq1r','pdf_tq2r','pdf_tf1r','pdf_pr1e','pdf_br1a','pdf_guia']){
  const id='numbered-'+station;
  await db.station.create({data:{id:station,board:'cocina',label:station,color:'gray',maxConcurrent:1,sortOrder:1}});
  await db.employee.create({data:{id,externalId:id,firstName:station,lastName:'Synthetic'}});
  await db.shift.create({data:{id:'shift-'+id,employeeId:id,board:'cocina',date:'2040-06-06',sourcePosition:'Cocina',startAt:new Date('2040-06-06T13:00:00Z'),endAt:new Date('2040-06-07T01:00:00Z')}});
  await db.assignment.create({data:{employeeId:id,shiftId:'shift-'+id,stationId:station,hourStart:new Date('2040-06-06T20:00:00Z'),hourEnd:new Date('2040-06-06T21:00:00Z')}});
 }
 await db.staffBreak.create({data:{id:'proof-ended',employeeId:'numbered-pdf_tf1r',shiftId:'shift-numbered-pdf_tf1r',board:'cocina',date:'2040-06-06',startAt:new Date('2040-06-06T21:00:00Z'),endAt:new Date('2040-06-06T21:15:00Z'),actor:'numbered-pdf_tf1r',status:'ended'}});
 await db.$disconnect();
})().catch(e=>{console.error(e);process.exitCode=1});
''')
            def http(port, method, path, body=None, token=None):
                conn = HTTPConnection('127.0.0.1', port, timeout=20)
                headers = {'content-type': 'application/json'}
                if token:
                    headers['x-manager-session'] = token
                conn.request(method, path, json.dumps(body) if body is not None else None, headers)
                response = conn.getresponse(); status = response.status; body = response.read(); conn.close()
                if status >= 400:
                    raise ValueError('Synthetic HTTP refusal: ' + method + ' ' + path + ' ' + str(status))
                return json.loads(body)
            phases = []
            def boot(phase, probe):
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
                with (evidence / (phase + '.log')).open('x') as output:
                    child = subprocess.Popen(['node', str(app / 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', str(port)],
                                             cwd=app, env=env, stdout=output, stderr=output, start_new_session=True)
                    try:
                        for _ in range(150):
                            if child.poll() is not None:
                                raise RuntimeError('Synthetic server exited before ready')
                            try:
                                http(port, 'GET', '/api/managers'); break
                            except (OSError, HTTPException):
                                time.sleep(.2)
                        else:
                            raise TimeoutError('Synthetic server did not start')
                        owner = http(port, 'POST', '/api/managers', {'code': 'rehearsal-owner-code'})['sessionToken']
                        probe(port, owner)
                        phases.append({'phase': phase, 'release': (app / 'RELEASE_SHA').read_text().strip(), 'port': port, 'passed': True})
                    finally:
                        if child.poll() is None:
                            child.terminate()
                        child.wait(timeout=20)
                        with socket.socket() as sock:
                            if sock.connect_ex(('127.0.0.1', port)) == 0:
                                raise RuntimeError('Owned rehearsal listener remains')
                print(phase + ' passed; server ended', flush=True)
            def old_probe(port, owner, writes=False):
                for employee in ('pending', 'numbered-pdf_tf1r'):
                    http(port, 'GET', '/api/breaks/manage?board=cocina&employeeId=' + employee, token=owner)
                if not writes:
                    return
                http(port, 'POST', '/api/breaks/manage', {'board': 'cocina', 'employeeId': 'old-writer', 'startAt': '2040-06-06T14:00:00.000Z', 'endAt': '2040-06-06T14:15:00.000Z'}, owner)
                http(port, 'POST', '/api/notes', {'board': 'cocina', 'date': '2040-06-06', 'body': 'Synthetic old-client write'}, owner)
            def new_probe(port, owner, writes=False):
                if writes:
                    http(port, 'PUT', '/api/admin/manager-pairings', {'managerId': 'proof-manager', 'employeeId': 'two', 'confirm': True}, owner)
                pairs = http(port, 'GET', '/api/admin/manager-pairings', token=owner)
                assert next(m for m in pairs['managers'] if m['id'] == 'proof-manager')['employeeId'] == 'two'
                gerente = http(port, 'POST', '/api/managers', {'code': 'rehearsal-gerente-code'})['sessionToken']
                http(port, 'GET', '/api/breaks/manage?board=cocina&employeeId=pending', token=gerente)
                if writes:
                    http(port, 'POST', '/api/breaks/manage', {'board': 'cocina', 'employeeId': 'numbered-pdf_tq1r', 'startAt': '2040-06-06T20:00:00.000Z', 'endAt': '2040-06-06T20:15:00.000Z'}, owner)
                timeline = http(port, 'GET', '/api/breaks/timeline?date=2040-06-06', token=owner)
                assert any(row['id'] == 'proof-pending' and row['status'] == 'pending' for row in timeline['breaks'])
                assert any(row['id'] == 'proof-ended' and row['status'] == 'ended' for row in timeline['breaks'])
                with sqlite3.connect(database) as db:
                    assert db.execute("SELECT status,coverEmployeeId,coverShiftId,auto FROM StaffBreak WHERE employeeId='numbered-pdf_tq1r'").fetchone() == ('booked', 'numbered-pdf_tq2r', 'shift-numbered-pdf_tq2r', 0)
            def switch(label, phase):
                incoming = root / ('incoming-' + phase)
                copy_runtime(packet / label, incoming)
                before = guard(database)
                promote(incoming, app, root / ('retired-' + phase))
                require_preserved(before, guard(database))
                assert (app / '.env').read_bytes() == env_marker
                verify_live_runtime(app, packet, label)
            boot('old-before', lambda port, owner: old_probe(port, owner, writes=True))
            before = guard(database)
            with sqlite3.connect(database) as db:
                schema_before = db.execute("SELECT sql FROM sqlite_master WHERE name='Manager'").fetchone()[0]
            spec = importlib.util.spec_from_file_location('migration', packet / 'tools/migrate-manager-linkage.py')
            migration = importlib.util.module_from_spec(spec); spec.loader.exec_module(migration)
            assert migration.migrate(database)['changed'] is True
            require_preserved(before, guard(database))
            assert migration.migrate(database)['changed'] is False
            switch('new', 'new-first'); boot('new-before-rollback', lambda port, owner: new_probe(port, owner, writes=True))
            linked = guard(database)
            switch('old', 'old-rollback'); boot('old-after-migration', old_probe)
            require_preserved(linked, guard(database))
            run(['node', '-'], "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.manager.create({data:{id:'old-created',name:'Synthetic Old Writer',codeHash:'synthetic-unused'}}).finally(()=>db.$disconnect());")
            with sqlite3.connect(database) as db:
                assert db.execute("SELECT employeeId FROM Manager WHERE id='old-created'").fetchone() == (None,)
                assert db.execute("SELECT employeeId FROM Manager WHERE id='proof-manager'").fetchone() == ('two',)
                schema_after = db.execute("SELECT sql FROM sqlite_master WHERE name='Manager'").fetchone()[0]
            before_final = guard(database)
            switch('new', 'new-return'); boot('new-after-rollback', new_probe)
            require_preserved(before_final, guard(database))
            assert identity == guard(database)['fileIdentity']
            verify(packet)
            result = {'old': manifest['releases']['old'], 'new': manifest['releases']['new'], 'database': str(database),
                      'sameFileIdentity': identity, 'phases': phases, 'managerSchemaBefore': schema_before,
                      'managerSchemaAfter': schema_after, 'migrationRerun': True, 'preservedLinksPendingBookedEndedAndCover': True,
                      'numberedCoverAutoFalse': True, 'oldCreatedNullLinkage': True, 'preservedEnvironmentSentinel': True,
                      'packetManifestSha256': digest(packet / 'manifest.json'), 'noBuildOrDataCopy': True}
            write_json(evidence / 'result.json', result)
            return result


if __name__ == '__main__':
    import sys
    if len(sys.argv)>1 and sys.argv[1]=='quarter':
        import runpy
        sys.argv.pop(1)
        runpy.run_path(str(Path(__file__).with_name('quarter-rehearse.py')),run_name='__main__')
        raise SystemExit(0)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packet', required=True); parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    print(json.dumps(rehearse(args.packet, args.evidence), indent=2))
