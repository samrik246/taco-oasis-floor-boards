#!/usr/bin/env python3
"""Explicit forward prepared migration from a pinned compatible artifact. Never activate or restore."""
import argparse
import os
from pathlib import Path
import subprocess
# Ignore all cached application bytecode before importing the pinned source modules.
import sys
sys.dont_write_bytecode = True
sys.pycache_prefix = str(Path(__file__).resolve().parent / '.no-bytecode-cache')
if Path(sys.pycache_prefix).exists() or Path(sys.pycache_prefix).is_symlink():
    raise ValueError('Packet bytecode prefix must remain absent')
from quarter_artifacts import verify, MANIFEST
from quarter_guard import file_hash, regular


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--migration', required=True, choices=['quarter-paint-v2-001'])
    parser.add_argument('--phase', required=True, choices=['prepared'])
    args = parser.parse_args()
    app = Path(__file__).resolve().parent.parent
    verify(app, file_hash(app / MANIFEST))
    database = regular(args.database)
    subprocess.run(['node', str(app / 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', str(app / 'tsconfig.json'), str(app / 'scripts/quarter-migrate.ts')], cwd=app, env=dict(os.environ, DATABASE_URL='file:' + str(database)), check=True)


if __name__ == '__main__':
    main()
