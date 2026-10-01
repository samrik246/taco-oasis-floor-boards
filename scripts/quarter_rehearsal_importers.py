"""Actual synthetic importer entrypoints, retained loaded pins, and activation inventory refusals."""
from datetime import datetime, timezone, date, timedelta
import json
import os
from pathlib import Path
import subprocess
import time
from quarter_artifacts import MANIFEST, atomic_json, copy, verify
from quarter_guard import capture, file_hash, hash_value
from quarter_importers import verify_importers
from quarter_release import release_lease, record


def run(root, fixture, database):
    root=Path(root);app=root/'app';out=root/'evidence/importers';out.mkdir()
    pin=file_hash(app/MANIFEST);verify(app,pin,database)
    exports=root/'synthetic-exports';exports.mkdir()
    import_date=(date.fromisoformat(fixture['date'])+timedelta(days=60)).isoformat()
    (exports/'Schedule_for_synthetic.csv').write_text('Schedule,Site,Position,First Name,Last Name,Employee ID,Email,Shift Start Date,Shift Start Time,Shift End Time,Hourly Rate,Status\n'+f'Synthetic,Synthetic,Caja - Regular,Synthetic,Importer,synthetic-importer,,{import_date},1:00 pm,2:00 pm,0,Published\n')
    env=dict(os.environ,FLOOR_BOARDS_TEST_ROOT=str(root),DATABASE_URL='file:'+str(database),FLOOR_BOARDS_IMPORT_DIR=str(exports),FLOOR_BOARDS_IMPORT_MODE='apply',WIW_LOGIN_FILE=str(root/'never-read-login'),WIW_BROWSER_PROFILE=str(root/'never-open-browser'))
    env.pop('NODE_OPTIONS',None)
    def command(script,location=app):
        return ['node','--import',str(location/'node_modules/tsx/dist/loader.mjs'),str(location/'scripts'/script)]
    def finish(child,label,expected_code=0,contains=None):
        stdout,stderr=child.communicate(timeout=60)
        (out/(label+'.log')).write_text(stdout+stderr)
        if child.returncode!=expected_code or (contains and contains not in stdout+stderr):
            raise ValueError('IMPORTER_CASE_FAILED:'+label)
        record(out/'events.jsonl','child-ended',case=label,pid=child.pid,exit=child.returncode,outputSha256=file_hash(out/(label+'.log')))
    def spawn(script,location=app):
        child=subprocess.Popen(command(script,location),cwd=location,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        record(out/'events.jsonl','child-started',pid=child.pid,script=script,artifact=pin)
        return child
    def wait_registered(child):
        path=app/'var/quarter-importers'/(str(child.pid)+'.json');deadline=time.monotonic()+8
        while not path.exists() and child.poll() is None and time.monotonic()<deadline:time.sleep(.02)
        if not path.exists():raise ValueError('IMPORTER_DID_NOT_REGISTER')
        value=json.loads(path.read_text())
        if value['state']!='waiting' or value['artifactSha256']!=pin:raise ValueError('IMPORTER_LOADED_PIN_MISSING')
        return value
    public={'Label':'synthetic.importer','ProgramArguments':['node',str(app/'scripts/wiw-export.ts')],'WorkingDirectory':str(app),'RunAtLoad':False,'StartCalendarInterval':[{'Hour':7,'Minute':0}]}
    descriptor=out/'timer.json';atomic_json(descriptor,public)
    launch=out/'launch.txt';launch.write_text('synthetic only\n')
    def inventory(processes):
        evidence={'version':1,'app':str(app),'synthetic':True,'observedAt':datetime.now(timezone.utc).isoformat(),'processes':processes,
          'timer':{'publicDescriptor':public,'publicDescriptorSha256':hash_value(public),'descriptorPath':str(descriptor),'launchPath':str(launch),'launchSha256':file_hash(launch)}}
        path=out/'inventory.json';atomic_json(path,evidence)
        return {'r0':{'manifestSha256':pin},'candidate':{'manifestSha256':pin},'importers':{'inventoryPath':str(path),'inventorySha256':file_hash(path)}}
    def refuse(packet,code):
        try:verify_importers(packet,app)
        except ValueError as error:
            if str(error)!=code:raise
            record(out/'events.jsonl','inventory-refused',code=code)
        else:raise ValueError('IMPORTER_INVENTORY_FALSE_ACCEPTANCE')
    before=capture(database)
    child=None
    try:
        with release_lease(app):
            child=spawn('import-from-folder.ts');registered=wait_registered(child)
            refuse(inventory([registered]),'IMPORTER_OLD_OR_WAITING')
            refuse(inventory([]),'IMPORTER_UNKNOWN_OR_CHANGED')
        finish(child,'prepared-drain',contains='outcome=imported');child=None
        after=capture(database);atomic_json(out/'prepared-after.json',after)
        allowed={'Employee','Shift','Assignment','ImportBatch','PaintCommandReceipt','PaintMutation','BoardChangeLog','QuarterWorldRevision','StaffBreakLock'}
        for table in before['tables']:
            if table not in allowed and before['tables'][table]!=after['tables'][table]:raise ValueError('IMPORTER_CHANGED_UNRELATED:'+table)
        child=spawn('import-from-folder.ts');finish(child,'exact-fingerprint-replay',contains='outcome=replayed');child=None
        replay=capture(database)
        for table in after['tables']:
            if table!='StaffBreakLock' and after['tables'][table]!=replay['tables'][table]:raise ValueError('IMPORT_REPLAY_CHANGED:'+table)
        retained=copy(app,root/'tampered-importer',pin)
        original=(retained/MANIFEST).read_bytes()
        for script,label in [('import-from-folder.ts','folder'),('wiw-export.ts','hourly')]:
            with release_lease(app):
                child=spawn(script,retained);registered=wait_registered(child)
                refuse(inventory([registered]),'IMPORTER_OLD_OR_WAITING')
                (retained/MANIFEST).write_text('{}\n')
            finish(child,label+'-changed-while-waiting',expected_code=1,contains='LOADED_ARTIFACT_CHANGED' if label=='folder' else 'wiw-export error=RUN');child=None
            (retained/MANIFEST).write_bytes(original)
            current=capture(database)
            for table in replay['tables']:
                if replay['tables'][table]!=current['tables'][table]:raise ValueError('REFUSED_IMPORTER_MUTATED:'+table)
        if (root/'never-read-login').exists() or (root/'never-open-browser').exists():raise ValueError('HOURLY_PROVIDER_TOUCHED')
        readback=verify_importers(inventory([]),app)
        atomic_json(out/'completed.json',{'preparedDrain':True,'exactFingerprintReplay':True,'changedLoadedPinsRefused':['folder','hourly'],'providerInvoked':False,'idleInventory':readback,'database':capture(database)['database']})
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:child.communicate(timeout=5)
            except subprocess.TimeoutExpired:child.kill();child.communicate(timeout=5)
