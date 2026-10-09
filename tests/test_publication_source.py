import hashlib
import json
from pathlib import Path
import zipfile
import subprocess

import pytest

from tree_source_release import prepare_source_release, archive_source_release, analysis_source_checkpoint


def source_fixture(directory):
    files = {'src/engine.py': b'print("source only")\n', 'server/worker.mjs': b'export default {};\n',
             'web/app.mjs': b'export const version = 1;\n', 'scripts/run.py': b'print("run")\n',
             'tests/test_engine.py': b'def test_source(): pass\n', 'validation/reference.py': b'version = 1\n',
             'protocol.md': b'# Retained protocol\n', 'analysis-methods.md': b'# Methods\n',
             'LICENSE.md': b'# Study licensing\n',
             'LICENSE-PolyForm-Noncommercial-1.0.0.md': b'PolyForm fixture\n',
             'LICENSE-CC-BY-NC-4.0.txt': b'CC fixture\n',
             'requirements.txt': b'numpy==2.4.2\n', 'package.json': b'{"type":"module"}',
             'yarn.lock': b'# exact dependency lock\n', 'wrangler.jsonc': b'{"compatibility_date":"2026-09-28"}',
             'web/visual-identity/archivo.woff2': b'font fixture', 'web/visual-identity/OFL.txt': b'font license fixture',
             'web/visual-identity/identity-mark.svg': b'<svg>canonical mark fixture</svg>',
             'web/study-media/tree-tracking.webp': b'image fixture'}
    for name, content in {**files, '.env': b'IGNORED=true', 'data/original.mov': b'private fixture',
                          'node_modules/ignored.mjs': b'not a source dependency',
                          'web/visual-identity/private.txt': b'not the named font license',
                          'private.txt': b'not an explicitly included license'}.items():
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return files


def test_source_copy_is_deterministic_complete_and_excludes_operator_data(tmp_path):
    package = tmp_path / 'package'
    expected = source_fixture(package)
    first, second = tmp_path / 'first', tmp_path / 'second'
    inventory = prepare_source_release(first, package=package)
    assert prepare_source_release(second, package=package) == inventory
    assert inventory['files'] == {name: hashlib.sha256(content).hexdigest() for name, content in expected.items()}
    assert json.loads((first / 'source-inventory.json').read_text()) == inventory
    for name, content in expected.items():
        assert (first / name).read_bytes() == content
    assert not (first / '.env').exists()
    assert not (first / 'data').exists()
    assert not (first / 'node_modules').exists()
    assert not (first / 'web/visual-identity/private.txt').exists()
    assert not (first / 'private.txt').exists()
    first_zip, second_zip = tmp_path / 'first.zip', tmp_path / 'second.zip'
    assert archive_source_release(first_zip, package=package) == archive_source_release(second_zip, package=package)
    assert first_zip.read_bytes() == second_zip.read_bytes()
    with zipfile.ZipFile(first_zip) as archive:
        assert json.loads(archive.read('source-inventory.json')) == inventory
        for name, content in expected.items():
            assert archive.read(name) == content
        assert 'web/visual-identity/private.txt' not in archive.namelist()
        assert 'private.txt' not in archive.namelist()


def test_source_copy_refuses_nonempty_targets_symlinks_and_unavailable_history(tmp_path):
    package = tmp_path / 'package'
    source_fixture(package)
    output = tmp_path / 'output'
    output.mkdir()
    (output / 'retain.txt').write_text('retained')
    with pytest.raises(ValueError, match='empty'):
        prepare_source_release(output, package=package)
    with pytest.raises(ValueError, match='Historical.*unavailable'):
        archive_source_release(tmp_path / 'missing.zip', package=package, checkpoint='f' * 40)
    (package / 'src/link.py').symlink_to(package / 'src/engine.py')
    with pytest.raises(ValueError, match='symlink'):
        prepare_source_release(tmp_path / 'safe', package=package)


def test_extracted_source_inventory_replaces_git_only_for_its_exact_content_identity(tmp_path):
    package = tmp_path / 'package'
    source_fixture(package)
    extracted = tmp_path / 'extracted'
    inventory = prepare_source_release(extracted, package=package)
    archive_source_release(tmp_path / 'exact.zip', package=extracted, checkpoint=inventory['contentSha256'])
    (extracted / 'src/engine.py').write_text('changed')
    with pytest.raises(ValueError, match='Historical.*unavailable|changed'):
        archive_source_release(tmp_path / 'changed.zip', package=extracted, checkpoint=inventory['contentSha256'])


def test_historical_analysis_package_is_found_when_only_a_calculation_module_changed(tmp_path):
    package = tmp_path / 'package'
    (package / 'src').mkdir(parents=True)
    adapter, calculator = package / 'src/study_app.py', package / 'src/tree_calculator.py'
    adapter.write_text('version = "unchanged adapter"\n')
    def git(*arguments):
        return subprocess.check_output(['git', '-c', 'user.email=software-test@example.invalid', '-c', 'user.name=Software Test',
                                       '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *arguments], cwd=package, stderr=subprocess.DEVNULL, text=True).strip()
    git('init', '-b', 'main')
    for version in [1, 2, 3]:
        calculator.write_text(f'version = {version}\n')
        git('add', 'src')
        git('commit', '-m', 'Retain calculation source')
        if version == 2:
            expected = git('rev-parse', 'HEAD')
            hashes = {target.name: hashlib.sha256(target.read_bytes()).hexdigest() for target in (adapter, calculator)}
    assert analysis_source_checkpoint(hashes, package=package) == expected


def test_standalone_source_retains_usable_public_registry_configuration_without_signing_secrets(tmp_path):
    package = tmp_path / 'package'
    source_fixture(package)
    configuration = {'test': {'enabled': False, 'chainId': 84532, 'rpcUrl': 'https://sepolia.base.org',
                               'signerAddress': None, 'fromBlock': None},
                     'production': {'enabled': False, 'chainId': 8453, 'rpcUrl': 'https://mainnet.base.org',
                                    'signerAddress': None, 'fromBlock': None}}
    (package / 'start-registry.config.json').write_text(json.dumps(configuration))
    (package / 'registry.secrets').write_text('synthetic-excluded-signing-secret')
    output = tmp_path / 'output'
    prepare_source_release(output, package=package)
    assert json.loads((output / 'start-registry.config.json').read_text()) == configuration
    assert not (output / 'registry.secrets').exists()
