#!/usr/bin/env python3
from __future__ import annotations
from pathlib import Path
import argparse
import json
import os
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
EXPORT_DIR = Path('/mnt/data')

DEFAULT_EXCLUDES = {
    'node_modules',
    '.git',
    '.pytest_cache',
    '__pycache__',
}
DEFAULT_SKIP_NAMES = {
    '.DS_Store',
}


def read_version() -> str:
    pkg = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    return str(pkg['version'])


def next_release_number(version: str) -> int:
    pattern = re.compile(rf'^wurster_lab_v{re.escape(version)}_r(\d{{3}})\.zip$')
    numbers = []
    for path in EXPORT_DIR.iterdir():
        match = pattern.match(path.name)
        if match:
            numbers.append(int(match.group(1)))
    return (max(numbers) + 1) if numbers else 1


def should_skip(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if rel.parts[:3] == ('authority', 'wrst.io', 'private'):
        return True
    if path.name.startswith('.dev.vars'):
        return True
    for part in rel.parts:
        if part in DEFAULT_EXCLUDES:
            return True
        if part == 'dist' and len(rel.parts) > 1:
            # runtime/web/dist is a distributable source artifact, not a heavy native build output.
            if rel.parts[:3] != ('runtime', 'web', 'dist'):
                return True
    if path.name in DEFAULT_SKIP_NAMES:
        return True
    if path.suffix == '.bak':
        return True
    if path.suffix == '.zip' and path.parent == EXPORT_DIR:
        return True
    return False


def iter_files():
    for path in ROOT.rglob('*'):
        if not path.is_file():
            continue
        if should_skip(path):
            continue
        yield path


def sync_site_docs() -> None:
    script = ROOT / 'tools' / 'sync-site-docs.mjs'
    if script.exists():
        subprocess.run(['node', str(script)], cwd=ROOT, check=True)


def build_web_runtime() -> None:
    script = ROOT / 'runtime' / 'web' / 'build.mjs'
    if script.exists():
        subprocess.run(['node', str(script)], cwd=ROOT, check=True)


def build_operator_vault() -> None:
    script = ROOT / 'tools' / 'build-operator-vault.mjs'
    if script.exists():
        subprocess.run(['node', str(script)], cwd=ROOT, check=True)


def sync_authority_public() -> None:
    script = ROOT / 'tools' / 'wrst-authority.mjs'
    if script.exists():
        subprocess.run(['node', str(script), 'sync'], cwd=ROOT, check=True)


def export_zip(output: Path):
    version = read_version()
    try:
        major = int(version.split('.', 1)[0])
    except ValueError:
        major = 0
    if major >= 1:
        subprocess.run(['node', str(ROOT / 'tools' / 'wrst-authority.mjs'), 'production-check'], cwd=ROOT, check=True)
    sync_authority_public()
    build_operator_vault()
    build_web_runtime()
    sync_site_docs()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(iter_files()):
            arcname = Path('wurster_lab') / path.relative_to(ROOT)
            zf.write(path, arcname)


def main():
    parser = argparse.ArgumentParser(description='Export the current wurster_lab workspace as a versioned zip.')
    parser.add_argument('--output', help='Explicit output path. Defaults to /mnt/data/wurster_lab_v<version>_rNNN.zip')
    args = parser.parse_args()

    version = read_version()
    if args.output:
        output = Path(args.output).resolve()
    else:
        release = next_release_number(version)
        output = EXPORT_DIR / f'wurster_lab_v{version}_r{release:03}.zip'

    output.parent.mkdir(parents=True, exist_ok=True)
    export_zip(output)
    print(output)


if __name__ == '__main__':
    main()
