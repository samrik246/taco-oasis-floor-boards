"""B4 application-only archive preparation. Never reads a live environment or database."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile

NEST = Path('/Users/dan/.buzz')
HEAVY_LOCK = NEST / 'WORK_LOGS/COLOR_BOARDS_B4_HEAVY_CHECKS_2026_09_30.lock'
NODE_BIN = '/opt/homebrew/opt/node@22/bin'
RUNTIME = [
    '.next', 'public', 'prisma/schema.prisma', 'prisma/seed.ts',
    'scripts/agent-paint.ts', 'scripts/edit-board.py', 'scripts/home-base.sh',
    'scripts/import-from-folder.ts', 'scripts/import-staff-passcodes.ts',
    'scripts/readiness-check.ts', 'scripts/release-lock.sh', 'scripts/remote-deploy.sh',
    'scripts/s14-station-colours.ts', 'scripts/s15-carne-relleno.ts',
    'scripts/seed-ability-columns.ts', 'scripts/seed-position-map.ts',
    'scripts/set-owner.ts', 'scripts/upgrade-home-base.ts', 'scripts/wiw-export.ts',
    'src/lib', 'fixtures/historical-hourly-sales.json',
    'fixtures/wheniwork-restaurant-export-sample.xlsx', 'package.json',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'next.config.ts', 'postcss.config.mjs',
    'tsconfig.json', 'components.json', '.env.production.example', 'RELEASE_SHA', '.artifact-files',
]
DIRECTORIES = {'.next', 'public', 'src/lib', 'node_modules'}
TOOLS = ['b4_artifacts.py', 'b4_release.py', 'b4-cutover.sh', 'b4_rehearse.py',
         'release-lock.sh', 'home-base.sh', 'migrate-manager-linkage.py']


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, value, exclusive=False):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    if exclusive:
        try:
            os.link(temporary, path)
        finally:
            temporary.unlink()
    else:
        os.replace(temporary, path)


def clean_env():
    env = {key: os.environ[key] for key in ('HOME', 'LANG') if key in os.environ}
    env.update(PATH=NODE_BIN + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
               NEXT_TELEMETRY_DISABLED='1', PYTHONDONTWRITEBYTECODE='1')
    return env


@contextlib.contextmanager
def heavy():
    with HEAVY_LOCK.open('a+') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def allowed(name, dependencies=False):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        return False
    if not (dependencies and path.parts[0] == 'node_modules') and any(part.startswith('.env') and part != '.env.production.example' or part.endswith(('.db', '.sqlite', '.sqlite3', '-wal', '-shm')) for part in path.parts):
        return False
    roots = RUNTIME + (['node_modules'] if dependencies else [])
    return any(name == root or (root in DIRECTORIES and name.startswith(root + '/')) for root in roots)


def cache_path(name):
    # Next's writable runtime cache is not a compiled application asset.
    return name == '.next/cache' or name.startswith('.next/cache/')


def no_symlink_parents(root, relative):
    root = Path(root)
    if root.is_symlink() or root.resolve() != root:
        raise ValueError('Root must be a real absolute directory')
    current = root
    for part in PurePosixPath(relative).parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise ValueError('Symlinked application parent: ' + relative)


def inventory(root):
    root = Path(root)
    if root.is_symlink() or root.resolve(strict=True) != root:
        raise ValueError('Runtime root must be a real absolute directory')
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            rel = path.relative_to(root).as_posix()
            if cache_path(rel):
                if name in dirs:
                    dirs.remove(name)
                continue
            parent_only = path.is_dir() and not path.is_symlink() and any(item.startswith(rel + '/') for item in RUNTIME)
            if not allowed(rel, dependencies=True) and not parent_only:
                raise ValueError('Unexpected runtime entry: ' + rel)
            if path.is_symlink():
                if not allowed(rel, dependencies=True):
                    raise ValueError('Unexpected runtime link: ' + rel)
                if not path.resolve().is_relative_to(root):
                    raise ValueError('Dependency link escapes stage: ' + rel)
                result[rel] = {'link': os.readlink(path)}
            elif path.is_file():
                if not allowed(rel, dependencies=True):
                    raise ValueError('Unexpected runtime file: ' + rel)
                result[rel] = {'sha256': digest(path), 'mode': stat.S_IMODE(path.stat().st_mode)}
    return result


def extract_archive(archive, destination):
    destination.mkdir()
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            rel = member.name.removeprefix('./').rstrip('/')
            if rel in ('', '.'):
                continue
            path = PurePosixPath(rel)
            parent_only = member.isdir() and any(root.startswith(rel + '/') for root in RUNTIME)
            if path.is_absolute() or '..' in path.parts or not (allowed(rel) or parent_only):
                raise ValueError('Unexpected archive path: ' + rel)
            if not (member.isfile() or member.isdir()):
                raise ValueError('Archive links/devices are forbidden: ' + rel)
        source.extractall(destination, filter='data')
    cache = destination / '.next/cache'
    if cache.exists():
        shutil.rmtree(cache)
    declared = (destination / '.artifact-files').read_text().splitlines()
    if set(declared) != set(RUNTIME):
        raise ValueError('Archive managed paths differ from reviewed runtime set')


def pack(repo, receipt, output):
    repo = Path(repo).resolve(strict=True)
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip():
        raise ValueError('Source must be clean')
    proof = json.loads(Path(receipt).read_text().splitlines()[-1])
    if proof['sha'] != head or proof['sha256'] != digest(repo / '.next/BUILD_ID'):
        raise ValueError('Fresh build receipt does not match source/output')
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError('Never overwrite a release archive')
    with tarfile.open(output, 'x:gz') as archive:
        def filtered(info):
            if cache_path(info.name):
                return None
            if not (info.isfile() or info.isdir()):
                raise ValueError('Source runtime link/device forbidden: ' + info.name)
            return info
        for name in RUNTIME:
            if name in ('.env.production.example', 'RELEASE_SHA', '.artifact-files'):
                continue
            archive.add(repo / name, arcname=name, filter=filtered)
        import io
        for name, text in {'.env.production.example': '# Existing installation configuration is preserved.\n',
                           'RELEASE_SHA': head + '\n', '.artifact-files': '\n'.join(RUNTIME) + '\n'}.items():
            payload = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(payload))
    return {'sha': head, 'archive': str(output), 'sha256': digest(output)}


def prepare(packet, old_archive, new_archive, source):
    packet = Path(packet).resolve()
    packet.mkdir()
    tools = packet / 'tools'
    tools.mkdir()
    for name in TOOLS:
        shutil.copy2(Path(source) / 'scripts' / name, tools / name)
    manifest = {'version': 1, 'cacheExclusions': ['.next/cache/**'], 'releases': {},
                'tools': {name: digest(tools / name) for name in TOOLS}}
    with heavy(), (packet / 'prepare.log').open('x') as log:
        for label, origin in [('old', old_archive), ('new', new_archive)]:
            archive = packet / (label + '.tgz')
            shutil.copy2(origin, archive)
            stage = packet / label
            extract_archive(archive, stage)
            sha = (stage / 'RELEASE_SHA').read_text().strip()
            if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
                raise ValueError('Bad release marker')
            for command in [['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
                            ['pnpm', 'exec', 'prisma', 'generate']]:
                log.write(json.dumps({'stage': label, 'command': command}) + '\n'); log.flush()
                subprocess.run(command, cwd=stage, env=clean_env(), stdout=log, stderr=log, check=True)
            files = inventory(stage)
            write_json(packet / (label + '-files.json'), files)
            manifest['releases'][label] = {'sha': sha, 'archiveSha256': digest(archive),
                                          'inventorySha256': digest(packet / (label + '-files.json'))}
    if manifest['releases']['old']['sha'] == manifest['releases']['new']['sha']:
        raise ValueError('Old and new releases must differ')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    if head != manifest['releases']['new']['sha'] or subprocess.check_output(['git', 'status', '--porcelain'], cwd=source, text=True).strip():
        raise ValueError('Prepared tools must come from the exact clean candidate')
    write_json(packet / 'manifest.json', manifest)
    return manifest


def verify(packet):
    packet = Path(packet).resolve(strict=True)
    manifest = json.loads((packet / 'manifest.json').read_text())
    if manifest['version'] != 1 or set(manifest['tools']) != set(TOOLS):
        raise ValueError('Unsupported packet')
    for name, expected in manifest['tools'].items():
        if digest(packet / 'tools' / name) != expected:
            raise ValueError('Packet tool changed: ' + name)
    for label in ('old', 'new'):
        if (packet / label).is_symlink():
            raise ValueError('Prepared stage must not be linked')
        release = manifest['releases'][label]
        if digest(packet / (label + '.tgz')) != release['archiveSha256'] or digest(packet / (label + '-files.json')) != release['inventorySha256']:
            raise ValueError('Artifact or inventory changed')
        if inventory(packet / label) != json.loads((packet / (label + '-files.json')).read_text()):
            raise ValueError('Prepared runtime changed: ' + label)
        if (packet / label / 'RELEASE_SHA').read_text().strip() != release['sha']:
            raise ValueError('Runtime marker mismatch')
    return manifest


def promote(stage, app, retired):
    """Move only reviewed application paths; preserve .env, var and every other path."""
    app, stage, retired = Path(app), Path(stage), Path(retired)
    retired.mkdir()
    roots = RUNTIME + ['node_modules']
    # Validate every parent before moving any byte; RELEASE_SHA moves last.
    roots = [name for name in roots if name != 'RELEASE_SHA'] + ['RELEASE_SHA']
    for name in roots:
        no_symlink_parents(app, name)
        if (app / name).is_symlink():
            raise ValueError('Refuse linked managed root: ' + name)
        if not (stage / name).exists():
            raise ValueError('Prepared path missing: ' + name)
    for name in roots:
        target = app / name
        saved = retired / name
        saved.parent.mkdir(parents=True, exist_ok=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            os.replace(target, saved)
        os.replace(stage / name, target)


def copy_runtime(source, destination):
    destination.mkdir()
    for name in RUNTIME + ['node_modules']:
        src = Path(source) / name
        dst = destination / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, symlinks=True, ignore=lambda folder, names: ['cache'] if Path(folder) == src and name == '.next' else [])
        else:
            shutil.copy2(src, dst)
