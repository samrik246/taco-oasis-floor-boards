"""Schema-2 release/recovery controller. Artifact-only promotion; never restore database bytes."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import time
import uuid
from quarter_guard import canonical, capture, connect, file_hash, hash_value, preserved
import quarter_artifacts as artifacts


def record(log, action, **values):
    with Path(log).open('a') as stream:
        stream.write(canonical({'atMs': int(time.time() * 1000), 'action': action, **values}) + '\n'); stream.flush(); os.fsync(stream.fileno())


@contextlib.contextmanager
def release_lease(app, wait_seconds=10):
    directory = Path(app).absolute().parent / '.taco-oasis-floor-boards-release.lock'
    directory.mkdir(exist_ok=True)
    claim = directory / (str(os.getpid()) + '.' + uuid.uuid4().hex)
    deadline = time.monotonic() + wait_seconds
    while True:
        claim.touch(exist_ok=False)
        others = [p for p in directory.iterdir() if re.fullmatch(r'[1-9][0-9]*\.[A-Za-z0-9]+', p.name) and p != claim]
        if not others:
            break
        claim.unlink()
        for other in others:
            try:
                os.kill(int(other.name.split('.')[0]), 0)
            except ProcessLookupError:
                other.unlink(missing_ok=True)
            except PermissionError:
                # Exclusion is conservative; an inaccessible process remains an owner.
                pass
        if time.monotonic() >= deadline:
            raise ValueError('RELEASE_BUSY')
        time.sleep(0.1)
    try:
        yield lambda: require_lease(directory, claim)
    finally:
        claim.unlink(missing_ok=True)


def require_lease(directory, claim):
    claims = [p.name for p in directory.iterdir() if re.fullmatch(r'[1-9][0-9]*\.[A-Za-z0-9]+', p.name)]
    if claims != [claim.name]:
        raise ValueError('RELEASE_LEASE_LOST')
    return claim.name


def load_packet(path):
    packet = json.loads(Path(path).read_text())
    if packet.get('version') != 1 or packet.get('controllerSha256') != file_hash(__file__):
        raise ValueError('CONTROLLER_MANIFEST_MISMATCH')
    return packet


def target(packet, name, database, accepted=True):
    pin = packet.get(name)
    if not pin or not re.fullmatch(r'[a-f0-9]{64}', pin.get('manifestSha256', '')):
        raise ValueError('COMPATIBLE_TARGET_MISSING')
    manifest = artifacts.verify(pin['path'], pin['manifestSha256'], database)
    if manifest.get('scope') != 'runtime' or manifest['controllerSha256'] != file_hash(__file__):
        raise ValueError('TARGET_CONTROLLER_MISMATCH')
    expected_role = 'QP_COMPAT_R0' if name == 'r0' else 'QP_UI_Q1'
    if packet.get('syntheticR0SelfRehearsal'):
        expected_role = 'QP_COMPAT_R0'
    if manifest['role'] != expected_role:
        raise ValueError('TARGET_ROLE_MISMATCH')
    if accepted:
        proof = pin.get('acceptance', {})
        if proof.get('decision') != 'pass' or proof.get('artifactSha256') != pin['manifestSha256'] or proof.get('sourceSha') != manifest['sourceSha'] or not proof.get('builder') or not proof.get('reviewer') or proof['reviewer'] == proof.get('builder') or not proof.get('evidencePath') or file_hash(proof['evidencePath']) != proof.get('evidenceSha256'):
            raise ValueError('INDEPENDENT_ARTIFACT_ACCEPTANCE_REQUIRED')
    return manifest


def promote(source, app, expected, run):
    source = Path(source).absolute(); app = Path(app).absolute()
    stage = Path(run) / ('stage-' + uuid.uuid4().hex)
    artifacts.copy(source, stage, expected)
    old = Path(run) / ('retired-' + uuid.uuid4().hex); old.mkdir()
    value = artifacts.verify(stage, expected)
    # var, environment, DB and activation evidence are outside this fixed managed set.
    for name in value['managedRoots'] + [artifacts.MANIFEST]:
        dst = app / name; src = stage / name
        if dst.is_symlink() or any(p.is_symlink() for p in dst.parents if p != app.parent):
            raise ValueError('PROMOTE_LINK_FORBIDDEN')
        if dst.exists():
            backup = old / name; backup.parent.mkdir(parents=True, exist_ok=True); shutil.move(dst, backup)
        dst.parent.mkdir(parents=True, exist_ok=True); shutil.move(src, dst)
    artifacts.verify(app, expected)


def readbacks(packet, app, guard, now_ms=None):
    now = int(time.time() * 1000) if now_ms is None else now_ms
    pin = packet.get('clients', {})
    inventory_file = Path(pin.get('inventoryPath', ''))
    records_file = Path(pin.get('readbacksPath', ''))
    if not inventory_file.is_file() or not records_file.is_file() or file_hash(inventory_file) != pin.get('inventorySha256') or file_hash(records_file) != pin.get('readbacksSha256'):
        raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
    inv = json.loads(inventory_file.read_text()); receipts = json.loads(records_file.read_text())
    digest = hash_value(inv)
    server = Path(app) / 'var/quarter-clients'
    if hash_value(json.loads((server / ('inventory-' + digest + '.json')).read_text())) != digest:
        raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
    retained = [d for d in inv['devices'] if d['disposition'] == 'retained']
    if not retained or len({d['label'] for d in inv['devices']}) != len(inv['devices']) or len({d['clientInstanceId'] for d in retained}) != len(retained) or any(d['disposition'] == 'retired' and not d.get('noReturnToFloor') for d in inv['devices']):
        raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
    if len({r['challengeId'] for r in receipts}) != len(receipts) or len(receipts) != len(retained):
        raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
    allowed = {packet[k]['manifestSha256']: artifacts.verify(packet[k]['path'], packet[k]['manifestSha256']) for k in ('r0', 'candidate')}
    from datetime import datetime
    ms = lambda text: int(datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp() * 1000)
    if inv.get('version') != 1 or type(inv.get('synthetic')) is not bool or not 0 <= now - ms(inv['enumeratedAt']) <= 900000 or any(d.get('disposition') not in ('retained', 'retired') for d in inv['devices']):
        raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
    for device in retained:
        matches = [r for r in receipts if r.get('label') == device['label']]
        if len(matches) != 1:
            raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
        r = matches[0]; m = r['measurement']; visible = r['visible']; manifest = allowed.get(r['artifactSha256'])
        stored = json.loads((server / (r['challengeId'] + '.receipt.json')).read_text())
        payload = {k: v for k, v in r.items() if k != 'recordSha256'}
        if r != stored or hash_value(payload) != r['recordSha256'] or r.get('matched') is not True or not manifest or r['inventorySha256'] != digest or r['operatorId'] != inv['operatorId'] or r['synthetic'] != inv['synthetic'] or m['observedDatabaseEpoch'] != guard['state'][2] or m['schemaFingerprint'] != guard['schemaSha256'] or m['clientBuildSha'] != manifest['sourceSha'] or r['staticSha256'] != manifest['staticSha256']:
            raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
        if type(m.get('isSecureContext')) is not bool or m.get('challengeId') != r['challengeId'] or any(type(m.get(k)) is not int for k in ('protocol', 'cacheSchema', 'draftDbVersion')) or any(m[k] != device[k] for k in ('clientInstanceId', 'origin', 'role', 'board')) or any(visible[k] != device[k] for k in ('label', 'clientInstanceId', 'board', 'view')) or visible.get('oldTabsClosed') is not True or m.get('idbProbe') != 'commit-readback-ok' or m.get('legacyBoardCacheAbsent') is not True or [m.get(k) for k in ('protocol', 'cacheSchema', 'draftDbVersion')] != [2, 2, 1]:
            raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
        issued, received, observed = ms(r['issuedAt']), ms(r['receivedAt']), ms(visible['observedAt'])
        if not (issued <= observed <= received <= now and 0 <= received - issued <= 120000 and now - received <= 900000):
            raise ValueError('CLIENT_READBACK_MISSING_OR_STALE')
    return {'inventorySha256': digest, 'recordsSha256': hash_value(receipts), 'retained': len(retained)}


def activate(packet_path, app, database, log):
    packet = load_packet(packet_path)
    if packet.get('syntheticR0SelfRehearsal'):
        raise ValueError('ACTUAL_Q1_PIN_REQUIRED')
    with release_lease(app) as owned:
        target(packet, 'r0', database); target(packet, 'candidate', database)
        guard = capture(database)
        clients = readbacks(packet, app, guard)
        from quarter_importers import verify_importers
        importers = verify_importers(packet, app)
        owned()
        with connect(database, readonly=False) as db:
            db.execute('BEGIN IMMEDIATE')
            # Recheck current phase and emptiness inside the same transaction.
            state = db.execute('SELECT phase,databaseEpoch FROM QuarterSchema WHERE id=1').fetchone()
            if state != ('prepared', guard['state'][2]) or db.execute('SELECT COUNT(*) FROM PaintHour').fetchone()[0] or db.execute('SELECT COUNT(*) FROM PaintSegment').fetchone()[0]:
                raise ValueError('ACTIVATION_NOT_PREPARED_EMPTY')
            from quarter_guard import schema_fingerprint
            if schema_fingerprint(db) != guard['schemaSha256']:
                raise ValueError('ACTIVATION_SCHEMA_CHANGED')
            readbacks(packet, app, guard); verify_importers(packet, app); owned()
            db.execute("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=? WHERE id=1", (int(time.time() * 1000),))
        record(log, 'activated', clients=clients, importers=importers, guard=capture(database))


def cutover(packet_path, app, database, run, operation, service, checker, fault=lambda phase: None):
    run = Path(run); run.mkdir(parents=True, exist_ok=True); log = run / 'events.jsonl'
    packet = load_packet(packet_path)
    synthetic = packet.get('syntheticR0SelfRehearsal', False)
    if synthetic:
        from quarter_guard import disposable
        disposable(database)
    accepted = not synthetic
    chosen = 'r0' if operation == 'rollback' else 'candidate'
    with release_lease(app) as owned:
        # Every target refusal here leaves the healthy current process untouched.
        target(packet, chosen, database, accepted)
        current_pin = packet.get('currentManifestSha256')
        if not current_pin:
            raise ValueError('CURRENT_ARTIFACT_PIN_REQUIRED')
        artifacts.verify(app, current_pin, database)
        owned(); record(log, 'preflight-passed', operation=operation)
        stopped = False
        try:
            fault('before-stop'); service.stop(); stopped = True
            before = capture(database); record(log, 'post-stop-guard', guard=before)
            fault('before-promote'); owned(); target(packet, chosen, database, accepted)
            promote(packet[chosen]['path'], app, packet[chosen]['manifestSha256'], run)
            preserved(before, capture(database)); fault('after-promote')
            owned(); target(packet, chosen, database, accepted); artifacts.verify(app, packet[chosen]['manifestSha256'], database)
            service.start(); fault('after-start'); service.readback(); fault('readback')
            record(log, 'checker-wait', target=chosen)
            verdict = checker(chosen)
            if verdict != 'pass':
                raise ValueError('CHECKER_' + verdict.upper())
            record(log, 'accepted', target=chosen, guard=capture(database))
            return 'accepted'
        except Exception as failure:
            record(log, 'candidate-failed', error=str(failure))
            if not stopped:
                raise
            # The candidate may have acknowledged writes during checker-wait.
            # Stop first, then acquire the NEW preservation expectation.
            service.stop(); before = capture(database); record(log, 'recovery-post-stop-guard', guard=before)
            try:
                owned(); target(packet, 'r0', database, accepted); fault('recovery-verify')
                promote(packet['r0']['path'], app, packet['r0']['manifestSha256'], run)
                preserved(before, capture(database)); owned(); artifacts.verify(app, packet['r0']['manifestSha256'], database)
                service.start(); service.readback()
                if checker('recovery') != 'pass':
                    raise ValueError('RECOVERY_CHECKER_FAILED')
                record(log, 'recovered', guard=capture(database)); return 'recovered'
            except Exception as recovery:
                service.stop(); record(log, 'recovery-blocked', error=str(recovery), guard=capture(database)); return 'recovery-blocked'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['install', 'rollback', 'activate', 'bootstrap', 'bootstrap-resume'])
    for name in ('packet', 'app', 'database', 'run'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--port', type=int, default=3100)
    args = parser.parse_args()
    if args.operation == 'activate':
        Path(args.run).mkdir(parents=True, exist_ok=True); activate(args.packet, args.app, args.database, Path(args.run) / 'events.jsonl'); return
    from quarter_service import Service, checker_wait
    service = Service(args.app, args.database, args.port, args.run)
    if args.operation.startswith('bootstrap'):
        from quarter_bootstrap import bootstrap
        result = bootstrap(args.packet, args.app, args.database, args.run, service, lambda phase: checker_wait(args.run, phase), resume=args.operation == 'bootstrap-resume')
    else:
        result = cutover(args.packet, args.app, args.database, args.run, args.operation, service, lambda phase: checker_wait(args.run, phase))
    print(canonical({'outcome': result}))
    if result == 'recovery-blocked':
        raise SystemExit(2)


if __name__ == '__main__':
    main()
