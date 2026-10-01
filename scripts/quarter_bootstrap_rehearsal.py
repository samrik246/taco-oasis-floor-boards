"""Build a genuine pinned pre-R0 artifact in an exclusive synthetic fixture, then bridge it."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import urllib.request
from quarter_artifacts import atomic_json, MANIFEST
from quarter_bootstrap import bootstrap, legacy_inventory
from quarter_guard import disposable, file_hash, hash_value
from quarter_release import record
from quarter_service import Service, process_start, port_idle

# Independently accepted foundation, with hourly UI, no R0 runtime manifest or draft client.
HOURLY_SHA = '23304a2258bce7cf89a056c2f67acb53228f3fa9'


def rehearse(root, source, runtime, database):
    root=Path(root); source=Path(source); runtime=Path(runtime); database=disposable(database,root)
    app=root/'app'; app.mkdir(); run=root/'evidence/bootstrap'; run.mkdir()
    env=dict(os.environ,FLOOR_BOARDS_TEST_ROOT=str(root),DATABASE_URL='file:'+str(database),NEXT_TELEMETRY_DISABLED='1',PYTHONDONTWRITEBYTECODE='1')
    if not port_idle(3100):raise ValueError('BOOTSTRAP_TEST_PORT_OCCUPIED')
    # Exact Git objects, never a second implementation checkout or an R0 artifact relabeled hourly.
    archive=root/'hourly-source.tar'
    subprocess.run(['git','archive','--format=tar','--output='+str(archive),HOURLY_SHA],cwd=source,check=True)
    with tarfile.open(archive) as bundle:bundle.extractall(app,filter='data')
    if (app/MANIFEST).exists():raise ValueError('HOURLY_FIXTURE_HAS_QUARTER_MANIFEST')
    (app/'RELEASE_SHA').write_text(HOURLY_SHA+'\n')
    shutil.copytree(runtime/'node_modules',app/'node_modules',symlinks=True)
    with (run/'hourly-build.log').open('xb') as out:
        subprocess.run(['node',str(app/'node_modules/next/dist/bin/next'),'build','--webpack'],cwd=app,env=env,stdout=out,stderr=subprocess.STDOUT,check=True)
    legacy={'sourceSha':HOURLY_SHA,'treeSha256':hash_value(legacy_inventory(app)),'archiveSha256':file_hash(archive)}
    packet={'version':1,'syntheticR0SelfRehearsal':True,'controllerSha256':file_hash(source/'scripts/quarter_release.py'),
            'legacy':legacy,'r0':{'path':str(runtime),'manifestSha256':file_hash(runtime/MANIFEST)}}
    packet_file=run/'packet.json';atomic_json(packet_file,packet)
    service=Service(app,database,3100,run)
    # This one harness-owned old process starts only on a fresh legacy file. Production uses its
    # separately reviewed service adapter. No old-artifact start occurs after bridge migration.
    os.environ.update(FLOOR_BOARDS_TEST_ROOT=str(root),DATABASE_URL='file:'+str(database))
    with (run/'hourly-server.log').open('xb') as out:
        child=subprocess.Popen(['node',str(app/'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p','3100'],cwd=app,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
    service.child=child
    atomic_json(service.state,{'pid':child.pid,'started':process_start(child.pid),'app':str(app),'database':str(database),'legacy':legacy})
    try:
        deadline=time.monotonic()+45
        while True:
            try:
                with urllib.request.urlopen('http://127.0.0.1:3100/api/paint/capabilities',timeout=2) as response:body=json.load(response)
                if body.get('artifactRole')!='foundation' or body.get('recovery') is not False:raise ValueError('HOURLY_FIXTURE_IDENTITY_MISMATCH')
                record(run/'hourly-readback.jsonl','readback',sourceSha=HOURLY_SHA,capabilities=body);break
            except (OSError,TimeoutError):
                if time.monotonic()>=deadline:raise ValueError('HOURLY_FIXTURE_START_TIMEOUT')
                time.sleep(.2)
        if bootstrap(packet_file,app,database,run,service,lambda phase:'pass')!='accepted':
            raise ValueError('BOOTSTRAP_REHEARSAL_FAILED')
    finally:service.stop()
    record(root/'evidence/rehearsal.jsonl','bootstrap-controller-proof',legacy=legacy,r0=packet['r0'],scope='synthetic-not-independent-acceptance')
