"""Create a standalone source + prebuilt review ZIP without Site/Git credentials.

Run after a successful build/check. No account changes or data collection.
"""
from pathlib import Path
from datetime import date
import argparse
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TREES = ('src', 'data', 'collector', 'analysis', 'tests', 'docs', 'scripts', 'notebooks', '.github', 'dist')
FILES = ('package.json', 'vercel.json', '.gitignore', '.gitattributes', 'README.md', 'START_HERE.md', 'Open_Local_Review.cmd')
EXCLUDE = {'.git', '.openai', '__pycache__', '.ipynb_checkpoints', 'node_modules', 'cache', 'responses', 'qa', 'releases'}
EVIDENCE = {'collection_manifest.json', 'full_block_reconciliation.json', 'payout_reconciliation.json'}


def source_paths():
    selected = [ROOT / name for name in FILES]
    for tree in TREES:
        for path in (ROOT / tree).rglob('*'):
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(ROOT)
            if EXCLUDE.intersection(relative.parts) or path.suffix in {'.pyc', '.zip', '.tar'}:
                continue
            if relative.parts[:2] == ('collector', 'evidence') and path.name not in EVIDENCE:
                continue
            selected.append(path)
    if any(not path.is_file() for path in selected):
        raise ValueError('A required handoff file is missing.')
    return sorted(set(selected))


def package(output, source_commit=None):
    # Uses the same exact asset validation as the local-review launcher; no server.
    from review_locally import reviewed_directory
    reviewed_directory(ROOT)
    audit = json.loads((ROOT / 'data/settlement-integration.json').read_text())
    if not audit.get('monthlyActivationReady') or not audit.get('fortnightReceiptVerified'):
        raise ValueError('The monthly and prior-stage integration must be verified first.')
    paths = source_paths()
    manifest = {'version': 1, 'preparedAt': date.today().isoformat(), 'sourceCommit': source_commit,
        'notice': 'Fleet Observatory: independent product branding with separate recorded earnings and sampled selection evidence. Publishing this source is a separate step.',
        'window': audit['sourceWindow'], 'claims': audit['claims'], 'sessions': audit['sessions'],
        'files': {str(p.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + '.building')
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in paths:
            archive.write(path, 'fleet-observatory/' + path.relative_to(ROOT).as_posix())
        archive.writestr('fleet-observatory/HANDOFF_MANIFEST.json', json.dumps(manifest, indent=2) + '\n')
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC validation failed.')
        for relative, digest in manifest['files'].items():
            if hashlib.sha256(archive.read('fleet-observatory/' + relative)).hexdigest() != digest:
                raise ValueError('Packaged file differs: ' + relative)
    temporary.replace(output)
    return {'file': str(output), 'fileCount': len(paths) + 1, 'bytes': output.stat().st_size,
        'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'claims': audit['claims'], 'sessions': audit['sessions']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'releases/fleet_observatory_source.zip')
    parser.add_argument('--source-commit', help='Verified source commit returned by the source workflow; optional for a local rebuild.')
    args = parser.parse_args()
    print(json.dumps(package(args.output, args.source_commit), indent=2))


if __name__ == '__main__':
    main()
