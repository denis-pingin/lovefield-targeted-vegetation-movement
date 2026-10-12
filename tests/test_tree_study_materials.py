import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from test_publication_source import source_fixture
from tree_source_release import prepare_source_release
from tree_study_materials import prepare_study_materials


def test_materials_retain_actual_documents_and_reproducible_source_without_scored_state(tmp_path):
    package = tmp_path / 'package'
    expected = source_fixture(package)
    first = tmp_path / 'first'
    materials = prepare_study_materials(first, package=package)
    assert materials['schemaVersion'] == 1
    assert materials['experimentSlug'] == 'tree-targeting'
    assert materials['stage'] == 'before-scored-collection'
    assert not {'series', 'seriesId', 'publicationId', 'accumulated', 'repositoryUrl'} & materials.keys()
    assert json.loads((first / 'study.json').read_bytes()) == materials
    assert set(materials['files']) == {'protocol', 'methods'}
    assert {target.name for target in first.iterdir()} == {'study.json', 'protocol.md', 'analysis-methods.md'}
    for name in ('protocol', 'methods'):
        descriptor = materials['files'][name]
        assert (first / descriptor['filename']).read_bytes() == expected[descriptor['filename']]
    for descriptor in materials['files'].values():
        data = (first / descriptor['filename']).read_bytes()
        assert len(data) == descriptor['size']
        assert hashlib.sha256(data).hexdigest() == descriptor['sha256']
    inventory = prepare_source_release(tmp_path / 'source', package=package)
    assert materials['source'] == {key: inventory[key] for key in ('contentSha256', 'origin', 'files')}
    assert materials['source']['files'] == {name: hashlib.sha256(data).hexdigest() for name, data in expected.items()}
    second = tmp_path / 'second'
    assert prepare_study_materials(second, package=package) == materials
    assert {target.name: target.read_bytes() for target in first.iterdir()} == {
        target.name: target.read_bytes() for target in second.iterdir()}


def test_scientific_validation_is_included_and_private_verification_is_unavailable(tmp_path):
    package = tmp_path / 'package'
    source_fixture(package)
    (package / 'validation.md').write_text('# Scientific validation\n')
    (package / 'implementation-verification.md').write_text('Private deployment history\n')
    (package / 'validation').mkdir(exist_ok=True)
    (package / 'validation/reference.py').write_text('reference = True\n')
    materials = prepare_study_materials(tmp_path / 'materials', package=package)
    extracted = tmp_path / 'source'
    inventory = prepare_source_release(extracted, package=package)
    for name in ('validation.md', 'validation/reference.py'):
        assert (extracted / name).read_bytes() == (package / name).read_bytes()
        assert materials['source']['files'][name] == hashlib.sha256((package / name).read_bytes()).hexdigest()
    assert not (extracted / 'implementation-verification.md').exists()
    assert materials['source']['files'] == inventory['files']


def test_regeneration_excludes_generated_assets_and_credentials_and_tracks_source_changes(tmp_path):
    package = tmp_path / 'package'
    source_fixture(package)
    output = package / 'web/current-study'
    first = prepare_study_materials(output, package=package)
    (output / 'source.zip').write_bytes(b'obsolete generated archive')
    (output / 'stale.mjs').write_text('generated stale artifact')
    (package / 'tests/credentials.json').write_text('private fixture')
    second = prepare_study_materials(output, package=package)
    assert first == second
    assert not (output / 'source.zip').exists()
    assert (output / 'stale.mjs').read_text() == 'generated stale artifact'
    assert not any(name.startswith('web/current-study/') for name in second['source']['files'])
    assert not any(name.endswith('credentials.json') for name in second['source']['files'])
    (package / 'protocol.md').write_text('# Changed current protocol\n')
    changed = prepare_study_materials(output, package=package)
    assert changed['source']['contentSha256'] != first['source']['contentSha256']
    assert changed['files']['protocol']['sha256'] != first['files']['protocol']['sha256']


@pytest.mark.parametrize('name', ['protocol.md', 'analysis-methods.md'])
def test_missing_canonical_document_fails_before_replacing_current_materials(tmp_path, name):
    package = tmp_path / 'package'
    source_fixture(package)
    output = tmp_path / 'materials'
    prepare_study_materials(output, package=package)
    (output / 'source.zip').write_bytes(b'obsolete generated archive')
    (output / 'retain.txt').write_text('unrelated retained file')
    before = {target.name: target.read_bytes() for target in output.iterdir()}
    (package / name).unlink()
    with pytest.raises(ValueError, match=name):
        prepare_study_materials(output, package=package)
    assert {target.name: target.read_bytes() for target in output.iterdir()} == before


@pytest.mark.parametrize('name', ['protocol.md', 'analysis-methods.md'])
def test_oversized_document_fails_before_replacing_current_materials(tmp_path, monkeypatch, name):
    package = tmp_path / 'package'
    source_fixture(package)
    output = tmp_path / 'materials'
    prepare_study_materials(output, package=package)
    (output / 'source.zip').write_bytes(b'obsolete generated archive')
    before = {target.name: target.read_bytes() for target in output.iterdir()}
    monkeypatch.setattr('tree_study_materials.MAX_STATIC_ASSET_BYTES', 32)
    (package / name).write_bytes(b'x' * 33)
    with pytest.raises(ValueError, match='25 MiB'):
        prepare_study_materials(output, package=package)
    assert {target.name: target.read_bytes() for target in output.iterdir()} == before


def test_source_inventory_is_not_limited_as_a_served_static_asset(tmp_path, monkeypatch):
    monkeypatch.setattr('tree_study_materials.MAX_STATIC_ASSET_BYTES', 32)
    package = tmp_path / 'package'
    source_fixture(package)
    source = b'print("source larger than a served document")\n'
    (package / 'src/engine.py').write_bytes(source)
    materials = prepare_study_materials(tmp_path / 'materials', package=package)
    assert set(materials['files']) == {'protocol', 'methods'}
    assert all(file['size'] <= 32 for file in materials['files'].values())
    assert materials['source']['files']['src/engine.py'] == hashlib.sha256(source).hexdigest()


def test_only_explicit_https_github_repository_destinations_are_accepted(tmp_path):
    package = tmp_path / 'package'
    source_fixture(package)
    materials = prepare_study_materials(tmp_path / 'valid', package=package,
                                       repository_url='https://github.com/selected-owner/selected-study')
    assert materials['repositoryUrl'] == 'https://github.com/selected-owner/selected-study'
    for url in ['http://github.com/owner/study', 'https://github.com.evil.test/owner/study',
                'https://github.com/owner/study?credential=value', 'https://owner:password@github.com/owner/study',
                'https://github.com/owner', 'https://github.com/owner/study/tree/main']:
        with pytest.raises(ValueError, match='GitHub'):
            prepare_study_materials(tmp_path / 'invalid', package=package, repository_url=url)


def test_materials_regenerate_from_extracted_source_without_parent_repository(tmp_path):
    package = Path(__file__).resolve().parents[1]
    materials = prepare_study_materials(tmp_path / 'materials', package=package)
    extracted = tmp_path / 'source'
    prepare_source_release(extracted, package=package)
    result = subprocess.run([sys.executable, str(extracted / 'scripts/prepare-study-materials.py')],
                            cwd=extracted, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    regenerated = json.loads((extracted / 'web/current-study/study.json').read_bytes())
    assert regenerated['source']['contentSha256'] == materials['source']['contentSha256']
    assert regenerated['files']['protocol'] == materials['files']['protocol']
    assert regenerated['files']['methods'] == materials['files']['methods']
    assert {target.name for target in (extracted / 'web/current-study').iterdir()} == {
        'study.json', 'protocol.md', 'analysis-methods.md'}


def test_historical_materials_use_verified_git_bytes_and_working_bytes_do_not_claim_a_clean_release(tmp_path):
    package = tmp_path / 'package'
    source_fixture(package)
    def git(*arguments):
        return subprocess.check_output(['git', '-c', 'user.email=software-test@example.invalid',
                                       '-c', 'user.name=Software Test', '-c', 'core.hooksPath=/dev/null',
                                       '-c', 'commit.gpgsign=false', *arguments], cwd=package, text=True).strip()
    git('init', '-b', 'main')
    git('add', 'src', 'web', 'protocol.md', 'analysis-methods.md')
    git('commit', '-m', 'Retain study source')
    checkpoint = git('rev-parse', 'HEAD')
    (package / 'protocol.md').write_text('# Developing protocol\n')
    working = prepare_study_materials(tmp_path / 'working', package=package)
    retained = prepare_study_materials(tmp_path / 'retained', package=package, checkpoint=checkpoint)
    assert working['source']['origin']['kind'] == 'working-source'
    assert retained['source']['origin']['kind'] == 'git-checkpoint'
    assert retained['source']['origin']['checkpoint'] == checkpoint
    assert (tmp_path / 'retained/protocol.md').read_bytes() == b'# Retained protocol\n'
    assert working['source']['contentSha256'] != retained['source']['contentSha256']
