"""Exact standalone Tree source packages, without operator files or credentials."""
import hashlib
import json
import importlib.metadata
from pathlib import Path, PurePosixPath
import platform
import subprocess
import zipfile

PACKAGE = Path(__file__).resolve().parents[1]
TOP_LEVEL = {'.gitignore', '.yarnrc.yml', 'README.md', 'protocol.md', 'analysis-methods.md', 'validation.md', 'requirements.txt',
             'package.json', 'yarn.lock', 'wrangler.jsonc', 'analysis-profile.json', 'analysis-profile-area.json',
             'publication-release-guide.md', 'start-registry.config.json', 'LICENSE.md', 'LICENSE-PolyForm-Noncommercial-1.0.0.md',
             'LICENSE-CC-BY-NC-4.0.txt'}
EXTENSIONS = {'src': {'.py'}, 'server': {'.mjs'}, 'web': {'.mjs', '.css', '.html', '.mp3', '.svg', '.webp', '.woff2'},
              'scripts': {'.py', '.mjs'}, 'mac': {'.py', '.applescript'},
              'tests': {'.py', '.mjs', '.json'}, 'validation': {'.py', '.json', '.txt'}}


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def allowed_source_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ('', '.', '..') for part in path.parts): return False
    if path.parts[:2] == ('web', 'current-study'): return False
    if len(path.parts) == 1: return name in TOP_LEVEL
    return (path.parts[0] in EXTENSIONS
            and (path.suffix in EXTENSIONS[path.parts[0]] or name == 'web/visual-identity/OFL.txt')
            and not any(part.startswith('.') or part in ('__pycache__', 'node_modules') for part in path.parts)
            and path.name not in ('credentials.json',) and not path.name.startswith('service-account'))


def _git(package, arguments):
    return subprocess.run(['git', *arguments], cwd=package, capture_output=True)


def _repository(package):
    result = _git(package, ['rev-parse', '--show-toplevel'])
    if result.returncode: return None
    root = Path(result.stdout.decode().strip()).resolve()
    if not package.is_relative_to(root): return None
    relative = package.relative_to(root).as_posix()
    return '' if relative == '.' else relative


def _source(package, checkpoint=None):
    package = Path(package).resolve()
    relative = _repository(package)
    if checkpoint is not None and relative is not None:
        prefix = relative + '/' if relative else ''
        listed = _git(package, ['ls-tree', '-r', '--name-only', '--full-tree', checkpoint, '--', prefix or '.'])
        if listed.returncode: raise ValueError(f'Historical Tree source is unavailable for {checkpoint}.')
        files = {}
        for tracked in listed.stdout.decode().splitlines():
            name = tracked[len(prefix):]
            if not allowed_source_path(name): continue
            content = _git(package, ['show', f'{checkpoint}:{tracked}'])
            if content.returncode: raise ValueError(f'Historical Tree source is unavailable for {checkpoint}.')
            files[name] = content.stdout
        if not files: raise ValueError(f'Historical Tree source is unavailable for {checkpoint}.')
        return files, {'kind': 'git-checkpoint', 'checkpoint': checkpoint, 'originalPackagePath': relative or '.'}
    files = {}
    candidates = [package / name for name in TOP_LEVEL]
    for folder in EXTENSIONS:
        if (package / folder).is_dir(): candidates.extend((package / folder).rglob('*'))
    for target in sorted(candidates):
        name = target.relative_to(package).as_posix()
        if not allowed_source_path(name): continue
        if target.is_symlink(): raise ValueError(f'Source symlink is not supported: {name}.')
        if target.is_file(): files[name] = target.read_bytes()
    hashes = {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}
    identity = hashlib.sha256(_json(hashes)).hexdigest()
    if checkpoint is not None:
        inventory_path = package / 'source-inventory.json'
        retained = json.loads(inventory_path.read_text()) if inventory_path.is_file() else None
        if not retained or checkpoint != identity or retained.get('files') != hashes:
            raise ValueError(f'Historical Tree source is unavailable or changed for {checkpoint}.')
        return files, {'kind': 'content-inventory', 'checkpoint': checkpoint,
                       'originalPackagePath': retained['origin']['originalPackagePath']}
    head = _git(package, ['rev-parse', 'HEAD']) if relative is not None else None
    return files, {'kind': 'working-source', 'checkpoint': head.stdout.decode().strip() if head and not head.returncode else None,
                   'originalPackagePath': relative or '.'}


def _inventory(files, origin):
    hashes = {name: hashlib.sha256(content).hexdigest() for name, content in sorted(files.items())}
    return {'schemaVersion': 1, 'experimentSlug': 'tree-targeting', 'origin': origin,
            'contentSha256': hashlib.sha256(_json(hashes)).hexdigest(), 'files': hashes,
            'dependencyFiles': {name: hashes[name] for name in ('requirements.txt', 'package.json', 'yarn.lock', 'wrangler.jsonc') if name in hashes}}


def prepare_source_release(destination, *, package=PACKAGE, checkpoint=None):
    destination = Path(destination).resolve()
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError('The source release destination must be a new or empty directory.')
    files, origin = _source(package, checkpoint)
    inventory = _inventory(files, origin)
    destination.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (destination / 'source-inventory.json').write_bytes(_json(inventory))
    return inventory


def analysis_source_checkpoint(hashes, *, package=PACKAGE):
    package = Path(package).resolve()
    names = {name if '/' in name or name.endswith('.json') else 'src/' + name: digest for name, digest in hashes.items()}
    if all(allowed_source_path(name) and (package / name).is_file()
           and hashlib.sha256((package / name).read_bytes()).hexdigest() == digest for name, digest in names.items()):
        return None
    relative = _repository(package)
    if relative is not None:
        prefix = relative + '/' if relative else ''
        history = _git(package, ['log', '--all', '--format=%H', '--', *[str(package / name) for name in names]])
        for checkpoint in history.stdout.decode().splitlines() if not history.returncode else []:
            primary = _git(package, ['show', f'{checkpoint}:{prefix}src/study_app.py'])
            if primary.returncode or hashlib.sha256(primary.stdout).hexdigest() != names.get('src/study_app.py'): continue
            matched = True
            for name, digest in names.items():
                if not allowed_source_path(name): raise ValueError('An analysis source reference escapes the Tree package.')
                retained = _git(package, ['show', f'{checkpoint}:{prefix}{name}'])
                if retained.returncode or hashlib.sha256(retained.stdout).hexdigest() != digest:
                    matched = False; break
            if matched: return checkpoint
    raise ValueError('Historical analysis source and its sibling modules are unavailable for this revision.')


def runtime_identity():
    return {'python': platform.python_version(), 'implementation': platform.python_implementation(),
            'system': platform.system(), 'machine': platform.machine(),
            'packages': {name: importlib.metadata.version(name) for name in ('numpy', 'opencv-python', 'scipy')}}


def archive_source_release(destination, *, package=PACKAGE, checkpoint=None):
    files, origin = _source(package, checkpoint)
    inventory = _inventory(files, origin)
    Path(destination).parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted({**files, 'source-inventory.json': _json(inventory)}.items()):
            information = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            information.compress_type = zipfile.ZIP_DEFLATED
            information.external_attr = 0o100644 << 16
            archive.writestr(information, content)
    return inventory
