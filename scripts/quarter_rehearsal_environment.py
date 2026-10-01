"""Relocated prepared runtime loads only a disposable app configuration, without CLI assistance."""
import json
import os
from pathlib import Path
import subprocess
from quarter_artifacts import MANIFEST, atomic_json, verify
from quarter_guard import capture, disposable, file_hash, preserved, synthetic_paths
from quarter_release import record


ENVIRONMENT_FILES = [
    'src/lib/db.ts', 'src/lib/prisma-client.ts', 'src/lib/app-environment.ts', 'src/lib/quarter/artifact-root.ts',
    'scripts/import-from-folder.ts', 'scripts/agent-paint.ts', 'scripts/seed-ability-columns.ts',
    'scripts/import-staff-passcodes.ts', 'scripts/wiw-export.ts', 'scripts/readiness-check.ts',
    'scripts/upgrade-home-base.ts', 'scripts/seed-position-map.ts', 'scripts/set-owner.ts',
    'scripts/s14-station-colours.ts', 'scripts/s15-carne-relleno.ts', 'scripts/clear-employee-emails.ts', 'prisma/seed.ts',
    'scripts/quarter-rehearsal-environment.ts', 'scripts/quarter_rehearsal_environment.py',
]


def delivered_files(app, manifest):
    pinned = {row[0]: row[2] for row in manifest['files'] if row[1] == 'file'}
    actual = {name: file_hash(Path(app) / name) for name in ENVIRONMENT_FILES}
    if any(pinned.get(name) != digest for name, digest in actual.items()): raise ValueError('ENVIRONMENT_DELIVERY_INCOMPLETE')
    return actual


def run(root, fixture, database):
    root = Path(root); database = disposable(database); app = root / 'app'
    synthetic_paths(database, app)
    pin = file_hash(app / MANIFEST); manifest = verify(app, pin, database)
    if pin != fixture['r0']['manifestSha256']: raise ValueError('ENVIRONMENT_RUNTIME_MISMATCH')
    out = root / 'evidence/environment'; out.mkdir()
    delivered = delivered_files(app, manifest)
    other = root / 'environment-other-cwd'; other.mkdir()
    # A competing synthetic cwd .env must never replace the loaded application's settings.
    (other / '.env').write_text('DATABASE_URL="file:' + str(root / 'must-not-open.db') + '"\n')
    before = capture(database); config = app / '.env'
    # Exclusive creation refuses all existing settings, including dangling aliases.
    with config.open('x') as stream: stream.write('DATABASE_URL="file:' + str(database) + '"\n')
    identity = config.stat(); observations = []
    try:
        env = dict(os.environ, FLOOR_BOARDS_TEST_ROOT=str(root))
        for name in ('DATABASE_URL', 'NODE_OPTIONS'): env.pop(name, None)
        for launch, cwd in (('app', app), ('other', other)):
            for mode in ('shared', 'direct'):
                command = ['node', '--import', str(app / 'node_modules/tsx/dist/loader.mjs'), str(app / 'scripts/quarter-rehearsal-environment.ts'), mode, str(database)]
                result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
                log = out / (launch + '-' + mode + '.log'); log.write_text(result.stdout + result.stderr)
                record(out / 'events.jsonl', 'environment-probe', mode=mode, launch=launch, exit=result.returncode, outputSha256=file_hash(log))
                if result.returncode: raise ValueError('ENVIRONMENT_PROOF_FAILED:' + launch + ':' + mode)
                observed = json.loads(result.stdout)
                expected = {'mode': mode, 'parentDatabaseAbsent': True, 'envFileFlag': False, 'path': str(database), 'device': database.stat().st_dev, 'inode': database.stat().st_ino, 'launchDirectory': str(cwd), 'app': str(app)}
                if observed != expected: raise ValueError('ENVIRONMENT_PROOF_READBACK_MISMATCH')
                observations.append(observed)
    finally:
        current = config.lstat()
        if (current.st_dev, current.st_ino, current.st_nlink) != (identity.st_dev, identity.st_ino, 1): raise ValueError('ENVIRONMENT_FIXTURE_CONFIG_CHANGED')
        config.unlink()
    if (root / 'must-not-open.db').exists(): raise ValueError('ENVIRONMENT_WRONG_CWD_DATABASE_OPENED')
    after = capture(database); preserved(before, after)
    if before != after: raise ValueError('ENVIRONMENT_PROOF_MUTATED_DATABASE')
    verify(app, pin, database)
    atomic_json(out / 'completed.json', {'runtimeManifestSha256': pin, 'deliveredFiles': delivered, 'observations': observations, 'database': after['database'], 'configurationRemoved': True, 'guard': after})
