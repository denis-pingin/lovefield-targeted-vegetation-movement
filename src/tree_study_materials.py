"""Deployable developing study materials from the canonical standalone source."""
import hashlib
import json
from pathlib import Path
import re
import tempfile
import zipfile

from tree_source_release import PACKAGE, archive_source_release

MAX_STATIC_ASSET_BYTES = 25 * 1024 * 1024


def prepare_study_materials(destination, *, package=PACKAGE, checkpoint=None, repository_url=None):
    if repository_url is not None and not re.fullmatch(
            r'https://github\.com/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9_.-]+', repository_url):
        raise ValueError('Select an exact HTTPS GitHub repository URL without credentials, query or subpath.')
    with tempfile.TemporaryDirectory(prefix='tree-study-materials-') as directory:
        archive_path = Path(directory) / 'source.zip'
        inventory = archive_source_release(archive_path, package=package, checkpoint=checkpoint)
        products = {'source': ('source.zip', archive_path.read_bytes())}
        with zipfile.ZipFile(archive_path) as archive:
            for key, filename in [('protocol', 'protocol.md'), ('methods', 'analysis-methods.md')]:
                if filename not in archive.namelist():
                    raise ValueError(f'The canonical study document {filename} is unavailable.')
                products[key] = (filename, archive.read(filename))
    if any(len(data) > MAX_STATIC_ASSET_BYTES for _, data in products.values()):
        raise ValueError('Current study material exceeds the 25 MiB static-asset limit.')
    materials = {'schemaVersion': 1, 'experimentSlug': 'tree-targeting', 'stage': 'before-scored-collection',
                 'source': {key: inventory[key] for key in ('contentSha256', 'origin', 'files')},
                 'files': {key: {'filename': filename, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
                           for key, (filename, data) in products.items()}}
    if repository_url is not None:
        materials['repositoryUrl'] = repository_url
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for filename, data in products.values():
        (destination / filename).write_bytes(data)
    (destination / 'study.json').write_text(json.dumps(materials, sort_keys=True, separators=(',', ':'),
                                                     ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')
    return materials
