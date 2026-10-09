import hashlib
import json
from pathlib import Path

import pytest
import zipfile

from publication_fixtures import scored_application
from study_http import AppError
from tree_publication import prepare_publication, verify_publication_files
from test_tree_api import wait_result


def test_snapshot_retains_exact_mac_reports_and_immutable_inputs(tmp_path):
    app, series_id, inventory = scored_application(tmp_path)
    try:
        accumulated = app._call(app._accumulating_series, series_id)
        run = app.get_run('completed-one')
        analysis = next(item for item in run['analyses'].values() if item['status'] == 'completed')
        original = app._hosted_directory('completed-one') / analysis['outputPath']
        before = original.read_bytes()
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        manifest = job['manifest']
        assert json.loads(Path(job['localFiles'][manifest['accumulated']['reportSha256']]).read_bytes()) == accumulated['report']
        included = manifest['includedAnalyses'][0]
        assert included['analysisId'] == accumulated['selectedRevisions'][0]
        assert json.loads(Path(job['localFiles'][included['reportSha256']]).read_bytes()) == app.get_analysis('completed-one', analysis['analysisId'])['displayReport']
        assert original.read_bytes() == before
        assert included['analysisSha256'] == hashlib.sha256(before).hexdigest()
        assert manifest['inventory'][1]['analysisState'] == 'pending'
        assert manifest['softwareTest'] is True and manifest['purpose'] == 'scored'
        assert str(tmp_path) not in json.dumps(manifest)
        verify_publication_files(job)
        assert app._call(app._accumulating_series, series_id) == accumulated
    finally:
        app.close()


def test_changed_retained_file_blocks_retry(tmp_path):
    app, series_id, inventory = scored_application(tmp_path)
    try:
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        original_hash = next(key for key, value in job['manifest']['files'].items() if value['role'] == 'camera-original')
        Path(job['localFiles'][original_hash]).write_bytes(b'changed')
        with pytest.raises(AppError, match='changed|missing'):
            verify_publication_files(job)
    finally: app.close()


def test_preparation_and_wrong_environment_are_ineligible(tmp_path):
    app, series_id, inventory = scored_application(tmp_path)
    try:
        with pytest.raises(AppError, match='environment'):
            prepare_publication(app, series_id, 'arbitrary', inventory=inventory)
        with pytest.raises(AppError, match='Software test|software test'):
            prepare_publication(app, series_id, 'production', inventory=inventory, software_test=True)
        with pytest.raises(AppError, match='scored|Scored'):
            prepare_publication(app, None, 'test', inventory=[])
    finally: app.close()


def test_pending_earlier_run_retains_empty_prefix_and_later_analysis(tmp_path):
    app, series_id, inventory = scored_application(tmp_path, pending_first=True)
    try:
        before = app._call(app._accumulating_series, series_id)
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        manifest = job['manifest']
        assert manifest['accumulated']['included'] == []
        assert manifest['includedAnalyses'] == []
        assert manifest['inventory'][0]['analysisState'] == 'pending'
        assert manifest['inventory'][1]['analysisState'] == 'completed'
        assert manifest['inventory'][1]['contributes'] is False
        assert json.loads(Path(job['localFiles'][manifest['accumulated']['reportSha256']]).read_text()) == before['report']
    finally: app.close()


def test_missing_outcome_retains_reasons_and_bounded_calculation(tmp_path):
    app, series_id, inventory = scored_application(tmp_path, missing=True)
    try:
        before = app._call(app._accumulating_series, series_id)
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        assert job['manifest']['includedAnalyses'][0]['missingReasons']
        assert before['runCount'] == 1
        saved = json.loads(Path(job['localFiles'][job['manifest']['accumulated']['resultSha256']]).read_text())
        assert saved['calculation'] == before['calculation']
        assert saved['missingBinCount'] == before['missingBinCount']
    finally: app.close()


def test_retained_preparation_series_is_rejected_and_unimported_scored_member_is_pending(tmp_path):
    app, series_id, inventory = scored_application(tmp_path)
    try:
        later = app._hosted_directory('later-pending')
        import shutil
        shutil.rmtree(later)
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        assert job['manifest']['inventory'][1]['analysisReason'] == 'Recording bundle has not been imported locally.'
    finally: app.close()
    preparation_directory = tmp_path / 'preparation'
    preparation_directory.mkdir()
    app, series_id, inventory = scored_application(preparation_directory, purpose='preparation')
    try:
        with pytest.raises(AppError, match='scored'):
            prepare_publication(app, series_id, 'test', inventory=inventory)
    finally: app.close()


def test_snapshot_includes_full_source_packages_and_keeps_local_series_catalog_private(tmp_path):
    app, series_id, inventory = scored_application(tmp_path)
    try:
        app.series_store.declare('private-preparation', 0, series_id='private-preparation-series')
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        releases = job['manifest']['sourceReleases']
        assert inventory[0]['codeCheckpoint'] in releases['packages']
        for package in releases['packages'].values():
            with zipfile.ZipFile(job['localFiles'][package['sha256']]) as archive:
                source = json.loads(archive.read('source-inventory.json'))
                for name in ('server/worker.mjs', 'web/app.mjs', 'src/study_http.py', 'requirements.txt', 'yarn.lock', 'wrangler.jsonc'):
                    assert hashlib.sha256(archive.read(name)).hexdigest() == source['files'][name]
        saved = json.loads(Path(job['localFiles'][job['manifest']['accumulated']['resultSha256']]).read_text())
        assert 'series' not in saved
        assert 'private-preparation-series' not in json.dumps(saved)
        entry = job['manifest']['includedAnalyses'][0]
        artifact = json.loads(Path(job['localFiles'][entry['analysisSha256']]).read_text())
        assert artifact['runtime']['python']
        assert artifact['runtime']['packages']['numpy'] == '2.4.2'
        assert releases['analyses'][entry['analysisId']]['runtime'] == artifact['runtime']
    finally: app.close()


def test_deduplicated_original_keeps_each_recordings_complete_references(tmp_path):
    app, series_id, inventory = scored_application(tmp_path)
    try:
        imported = app.import_recording('later-pending', tmp_path / 'camera.avi', 'video')
        app.save_obstruction_review('later-pending', imported['recordingId'], 'clear', [])
        analysis = app.start_analysis('later-pending', 'tree-development-1')
        wait_result(app, 'later-pending', analysis['analysisId'])
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        original = next(digest for digest, item in job['manifest']['files'].items() if item['role'] == 'camera-original')
        assert len(job['manifest']['includedAnalyses']) == 2
        for entry in job['manifest']['includedAnalyses']:
            assert original in entry['inputSha256s']
            inputs = json.loads(Path(job['localFiles'][entry['reproductionInputsSha256']]).read_text())
            assert any(item['sha256'] == original for item in inputs['recordings'].values())
            assert entry['videos'][0]['originalSha256'] == original
    finally: app.close()


def test_prepared_protocol_bytes_survive_later_checkout_document_changes(tmp_path, monkeypatch):
    import tree_publication
    import shutil
    package = tmp_path / 'source-copy'
    shutil.copytree(tree_publication.PACKAGE, package, ignore=shutil.ignore_patterns('node_modules', '.git', '.build', '.wrangler', '.yarn', '__pycache__', '.pytest_cache'))
    monkeypatch.setattr(tree_publication, 'PACKAGE', package)
    app, series_id, inventory = scored_application(tmp_path)
    try:
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        documents = {identity: Path(job['localFiles'][identity]).read_bytes() for identity, file in job['manifest']['files'].items() if file['role'] == 'protocol'}
        (package / 'protocol.md').write_text('Later protocol wording')
        (package / 'analysis-methods.md').write_text('Later method wording')
        verify_publication_files(job)
        assert {identity: Path(job['localFiles'][identity]).read_bytes() for identity in documents} == documents
    finally: app.close()


def test_methods_downloads_use_the_scored_series_frozen_source_documents(tmp_path, monkeypatch):
    import tree_publication
    import shutil
    package = tmp_path / 'newer-checkout'
    shutil.copytree(tree_publication.PACKAGE, package, ignore=shutil.ignore_patterns('node_modules', '.git', '.build', '.wrangler', '.yarn', '__pycache__', '.pytest_cache'))
    (package / 'protocol.md').write_text('Newer protocol that was not frozen for this study')
    (package / 'analysis-methods.md').write_text('Newer methods that were not frozen for this study')
    monkeypatch.setattr(tree_publication, 'PACKAGE', package)
    app, series_id, inventory = scored_application(tmp_path)
    try:
        job = prepare_publication(app, series_id, 'test', inventory=inventory, software_test=True)
        manifest = job['manifest']
        checkpoint = app.series_store.state['manifests'][series_id]['manifest']['codeCheckpoint']
        source = manifest['sourceReleases']['packages'][checkpoint]['sha256']
        with zipfile.ZipFile(job['localFiles'][source]) as archive:
            for name, reference in [('protocol.md', 'protocolSha256'), ('analysis-methods.md', 'methodsSha256')]:
                published = Path(job['localFiles'][manifest['reportPresentation'][reference]]).read_bytes()
                assert published == archive.read(name)
                assert published != (package / name).read_bytes()
        assert manifest['seriesBundle']['codeCheckpoint'] == checkpoint
    finally: app.close()
