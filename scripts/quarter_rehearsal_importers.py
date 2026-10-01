"""Actual synthetic importer entrypoints, retained loaded pins, and activation inventory refusals."""
from datetime import datetime, timezone, date, timedelta
from zoneinfo import ZoneInfo
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
    root=Path(root);app=root/'app';phase=capture(database)['state'][1]
    if phase not in ('prepared','active'):raise ValueError('IMPORTER_REHEARSAL_PHASE')
    out=root/'evidence'/('importers-'+phase);out.mkdir()
    pin=file_hash(app/MANIFEST);verify(app,pin,database)
    exports=root/('synthetic-exports-'+phase);exports.mkdir()
    # Exercise the unchanged production CLI's actual current-week check. Bracket
    # today in Chicago so crossing midnight while held does not invalidate it.
    today=datetime.now(ZoneInfo('America/Chicago')).date()
    rows=''.join(f'Synthetic,Synthetic,Caja - Regular,Synthetic,Importer,synthetic-importer-{phase},,{today+timedelta(days=offset)},1:00 pm,2:00 pm,0,Published\n' for offset in (-1,0,1))
    (exports/'Schedule_for_synthetic.csv').write_text('Schedule,Site,Position,First Name,Last Name,Employee ID,Email,Shift Start Date,Shift Start Time,Shift End Time,Hourly Rate,Status\n'+rows)
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
    def spawn(script,location=app,args=(),overrides=None):
        child=subprocess.Popen(command(script,location)+list(args),cwd=location,env=dict(env,**(overrides or {})),text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
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
        if phase == 'active':
            # The earlier prepared import's receipt must survive activation and
            # intervening writes, not merely replay another active-phase file.
            previous = root / 'synthetic-exports-prepared'
            if not previous.is_dir(): raise ValueError('PREPARED_IMPORT_PROOF_REQUIRED')
            child = spawn('import-from-folder.ts', overrides={'FLOOR_BOARDS_IMPORT_DIR': str(previous)})
            finish(child, 'prepared-receipt-after-activation', contains='outcome=replayed'); child = None
            retained = capture(database)
            for table in before['tables']:
                if table != 'StaffBreakLock' and before['tables'][table] != retained['tables'][table]:
                    raise ValueError('PREPARED_IMPORT_REPLAY_CHANGED:' + table)
        with release_lease(app):
            child=spawn('import-from-folder.ts');registered=wait_registered(child)
            refuse(inventory([registered]),'IMPORTER_OLD_OR_WAITING')
            refuse(inventory([]),'IMPORTER_UNKNOWN_OR_CHANGED')
        finish(child,'prepared-drain',contains='outcome=imported');child=None
        after=capture(database);atomic_json(out/'prepared-after.json',after)
        allowed={'Employee','EmployeeStationAbility','Shift','Assignment','ImportBatch','PaintHour','PaintSegment','PaintCommandReceipt','PaintMutation','BoardChangeLog','QuarterWorldRevision','StaffBreakLock'}
        for table in before['tables']:
            if table not in allowed and before['tables'][table]!=after['tables'][table]:raise ValueError('IMPORTER_CHANGED_UNRELATED:'+table)
        child=spawn('import-from-folder.ts')
        finish(child,'exact-fingerprint-replay',expected_code=3 if phase=='prepared' else 0,contains='code=DUPLICATE' if phase=='prepared' else 'outcome=replayed');child=None
        replay=capture(database)
        for table in after['tables']:
            if table!='StaffBreakLock' and after['tables'][table]!=replay['tables'][table]:raise ValueError('IMPORT_REPLAY_CHANGED:'+table)
        hourly_exports=root/('synthetic-hourly-exports-'+phase);hourly_exports.mkdir()
        hourly_date=(date.fromisoformat(fixture['date'])+timedelta(days=60 if phase=='prepared' else 81)).isoformat()
        for label in ('hourly-drain','hourly-replay'):
            output=out/(label+'.json')
            with release_lease(app):
                child=spawn('quarter-rehearsal-hourly.ts',args=(hourly_date,str(output)),overrides={'FLOOR_BOARDS_IMPORT_DIR':str(hourly_exports)})
                registered=wait_registered(child)
                if registered['kind']!='hourly':raise ValueError('HOURLY_IDENTITY_KIND')
                refuse(inventory([registered]),'IMPORTER_OLD_OR_WAITING')
                time.sleep(.1)
                if Path(str(output)+'.provider-started').exists() or output.exists() or child.poll() is not None:
                    raise ValueError('HOURLY_PROVIDER_STARTED_BEFORE_LEASE')
            finish(child,label,expected_code=3 if label=='hourly-replay' and phase=='prepared' else 0);child=None
            proof=json.loads(output.read_text());result=proof['result']
            expected='imported' if label=='hourly-drain' else 'refused' if phase=='prepared' else 'replayed'
            if proof['loadedArtifactSha256']!=pin or result['importResult']['outcome']!=expected or result['next']['importResult']['outcome']!=expected or len([c for c in proof['calls'] if c.startswith('export:')])!=2:
                raise ValueError('HOURLY_IMPORT_OR_REPLAY_MISSING')
            if expected=='refused' and any(r['code']!='DUPLICATE' for r in (result['importResult'],result['next']['importResult'])):
                raise ValueError('HOURLY_PREPARED_DUPLICATE_REASON')
            current=capture(database)
            if label=='hourly-drain':
                for table in replay['tables']:
                    if table not in allowed and replay['tables'][table]!=current['tables'][table]:raise ValueError('HOURLY_CHANGED_UNRELATED:'+table)
                replay=current
            else:
                for table in replay['tables']:
                    if table!='StaffBreakLock' and replay['tables'][table]!=current['tables'][table]:raise ValueError('HOURLY_REPLAY_CHANGED:'+table)
                replay=current
        retained=copy(app,root/('tampered-importer-'+phase),pin)
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
        atomic_json(out/'completed.json',{'phase':phase,'compatibleDrain':True,'duplicateBehavior':'prepared-legacy-refusal' if phase=='prepared' else 'original-receipt-replay','hourlyCurrentAndNextWeek':True,'providerWaitedForLease':True,'changedLoadedPinsRefused':['folder','hourly'],'realProviderInvoked':False,'idleInventory':readback,'database':capture(database)['database']})
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:child.communicate(timeout=5)
            except subprocess.TimeoutExpired:child.kill();child.communicate(timeout=5)
