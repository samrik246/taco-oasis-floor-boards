"""QP_COMPAT_R0 immutable runtime inventories; no service or database writes."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
from quarter_guard import canonical, capture, file_hash, hash_value, regular

MANIFEST = 'QUARTER_ARTIFACT.json'
ROOTS = json.loads((Path(__file__).resolve().parent.parent / 'src/lib/quarter/artifact-roots.json').read_text())
FORBIDDEN = {'db:setup', 'db:push', 'remote-deploy.sh', 'home-base.sh', 'seed.ts'}
VERSIONS = {'reader': 2, 'writer': 2, 'receipt': 2, 'draft': 1, 'cache': 2, 'schema': 2}


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    with temporary.open('x') as stream:
        stream.write(canonical(value) + '\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def permitted(name):
    p = PurePosixPath(name)
    return not p.is_absolute() and '..' not in p.parts and (any(name == r or name.startswith(r + '/') for r in ROOTS) or name.startswith('node_modules/')) and not any(part.startswith('.env') or part.endswith(('.db', '.db-wal', '.db-shm')) for part in p.parts)


def ignored(name):
    return name == '.next/cache' or name.startswith('.next/cache/') or '__pycache__' in PurePosixPath(name).parts


def inventory(app, dependencies=True):
    app = Path(app).absolute()
    if app.resolve(strict=True) != app:
        raise ValueError('ARTIFACT_ROOT_LINK')
    result = []
    roots = ROOTS + (['node_modules'] if dependencies else [])
    for root in roots:
        start = app / root
        if not start.exists():
            raise ValueError('ARTIFACT_FILE_MISSING:' + root)
        paths = [start] if start.is_file() else sorted(start.rglob('*'))
        for p in paths:
            rel = p.relative_to(app).as_posix()
            if ignored(rel):
                continue
            if not permitted(rel):
                raise ValueError('ARTIFACT_PATH_FORBIDDEN:' + rel)
            if p.is_symlink():
                if not rel.startswith('node_modules/') or not p.resolve(strict=True).is_relative_to(app / 'node_modules'):
                    raise ValueError('ARTIFACT_LINK_FORBIDDEN:' + rel)
                result.append([rel, 'link', os.readlink(p)])
            elif p.is_file():
                result.append([rel, 'file', file_hash(p), stat.S_IMODE(p.stat().st_mode)])
            elif not p.is_dir():
                raise ValueError('ARTIFACT_SPECIAL_FILE:' + rel)
    return sorted(result, key=lambda row: row[0].encode())


def seal(app, database, receipt):
    app = Path(app).resolve(strict=True)
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=app, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=app, text=True).strip():
        raise ValueError('ARTIFACT_SOURCE_NOT_CLEAN')
    proof = json.loads(Path(receipt).read_text().splitlines()[-1])
    if proof['sha'] != sha or proof['sha256'] != file_hash(app / '.next/BUILD_ID'):
        raise ValueError('ARTIFACT_BUILD_RECEIPT_MISMATCH')
    guard = capture(database)
    (app / "RELEASE_SHA").write_text(sha + "\n")
    files = inventory(app)
    manifest = {'version': 1, 'scope': 'source-check', 'role': 'QP_COMPAT_R0', 'sourceSha': sha, 'qualification': 'candidate',
                'versions': VERSIONS, 'quarterUi': False, 'blockNotes': False, 'files': files,
                'treeSha256': hash_value(files), 'staticSha256': hash_value([r for r in files if r[0].startswith('.next/static/')]),
                'buildIdSha256': file_hash(app / '.next/BUILD_ID'), 'schemaSha256': guard['schemaSha256'],
                'migrationSha256': guard['state'][5], 'registrySha256': guard['registrySha256'],
                'controllerSha256': file_hash(app / 'scripts/quarter_release.py'),
                'timerSha256': file_hash(app / 'src/lib/breaks/auto-pick.ts'), 'managedRoots': ROOTS + ['node_modules']}
    atomic_json(app / MANIFEST, manifest)
    return {'manifestSha256': file_hash(app / MANIFEST), 'sourceSha': sha, 'treeSha256': manifest['treeSha256']}


def verify(app, expected=None, database=None):
    app = Path(app).absolute()
    manifest_file = regular(app / MANIFEST)
    if expected and file_hash(manifest_file) != expected:
        raise ValueError('ARTIFACT_MANIFEST_PIN_MISMATCH')
    value = json.loads(manifest_file.read_text())
    if value.get('version') != 1 or value.get('role') not in ('QP_COMPAT_R0', 'QP_UI_Q1') or value.get('versions') != VERSIONS or value.get('managedRoots') != ROOTS + ['node_modules']:
        raise ValueError('ARTIFACT_PROTOCOL_INCOMPATIBLE')
    actual = inventory(app)
    if actual != value['files'] or hash_value(actual) != value['treeSha256']:
        raise ValueError('ARTIFACT_TREE_MISMATCH')
    pins = {'controllerSha256': 'scripts/quarter_release.py', 'registrySha256': 'src/lib/quarter/preservation-columns.json',
            'timerSha256': 'src/lib/breaks/auto-pick.ts', 'buildIdSha256': '.next/BUILD_ID'}
    if any(value[key] != file_hash(app / rel) for key, rel in pins.items()):
        raise ValueError('ARTIFACT_INTERNAL_PIN_MISMATCH')
    if hash_value([r for r in actual if r[0].startswith('.next/static/')]) != value['staticSha256']:
        raise ValueError('ARTIFACT_STATIC_PIN_MISMATCH')
    if database:
        state = capture(database)
        if state['schemaSha256'] != value['schemaSha256'] or state['registrySha256'] != value['registrySha256'] or state['state'][5] != value['migrationSha256']:
            raise ValueError('ARTIFACT_SCHEMA_INCOMPATIBLE')
    return value


def copy(app, destination, expected, runtime=False):
    source = Path(app).absolute(); target = Path(destination).absolute()
    value = verify(source, expected)
    if target.exists():
        raise ValueError('ARTIFACT_DESTINATION_EXISTS')
    target.mkdir(parents=True)
    for root in value['managedRoots']:
        src = source / root; dst = target / root; dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, symlinks=True, ignore=lambda folder, names: [n for n in names if ignored((Path(folder) / n).relative_to(source).as_posix())])
        else:
            shutil.copy2(src, dst)
    shutil.copy2(source / MANIFEST, target / MANIFEST)
    if runtime:
        package = json.loads((target / 'package.json').read_text())
        package['scripts'] = {key: command for key, command in package.get('scripts', {}).items() if key in ('start', 'db:generate', 'postinstall')}
        atomic_json(target / 'package.json', package)
        value = dict(value, scope='runtime', files=inventory(target), sourceManifestSha256=expected)
        value['treeSha256'] = hash_value(value['files'])
        atomic_json(target / MANIFEST, value)
    verify(target, file_hash(target / MANIFEST))
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    seal_p = sub.add_parser('seal'); seal_p.add_argument('--app', required=True); seal_p.add_argument('--database', required=True); seal_p.add_argument('--build-receipt', required=True)
    check = sub.add_parser('verify'); check.add_argument('--app', required=True); check.add_argument('--manifest-sha256', required=True); check.add_argument('--database')
    pack = sub.add_parser('copy'); pack.add_argument('--app', required=True); pack.add_argument('--destination', required=True); pack.add_argument('--manifest-sha256', required=True); pack.add_argument('--runtime', action='store_true')
    args = parser.parse_args()
    if args.action == 'seal':
        result = seal(args.app, args.database, args.build_receipt)
    elif args.action == 'verify':
        value = verify(args.app, args.manifest_sha256, args.database); result = {'verified': True, 'sourceSha': value['sourceSha']}
    else:
        target = copy(args.app, args.destination, args.manifest_sha256, args.runtime)
        result = {'path': str(target), 'manifestSha256': file_hash(target / MANIFEST)}
    print(canonical(result))


if __name__ == '__main__':
    main()
