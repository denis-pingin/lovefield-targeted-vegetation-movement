import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

import cv2
import numpy as np
import pytest

from publication_fixtures import fixture_source_checkpoint


def test_scored_export_fixture_uses_actual_collection_and_excludes_private_playback_payloads(tmp_path):
    image = cv2.imencode('.png', np.random.default_rng(8).integers(0, 255, (120, 180, 3), dtype=np.uint8))[1].tobytes()
    digest = hashlib.sha256(image).hexdigest()
    subprocess.run([shutil.which('node'), str(Path(__file__).parent / 'server/export-fixture.mjs'),
                    str(tmp_path), digest, 'scored', fixture_source_checkpoint()], check=True, capture_output=True)
    series = json.loads((tmp_path / 'series.json').read_text())
    assert series['config']['purpose'] == 'scored'
    assert series['collectionRunIds'] == ['completed-one', 'pending-collected', 'missing-stopped']
    for name in series['collectionRunIds']:
        raw = (tmp_path / (name + '.json')).read_text()
        bundle = json.loads(raw)
        assert bundle['config']['purpose'] == 'scored'
        assert 'playbackToken' not in raw
        assert 'apiKey' not in raw
        if bundle['state']['lifecycle'] == 'completed':
            assert bundle['tickets'][0]['result']['signature'] == 'synthetic-test-only'


@pytest.fixture(scope='module')
def publication_rehearsal(tmp_path_factory):
    from publication_rehearsal import prepare_rehearsal
    return prepare_rehearsal(tmp_path_factory.mktemp('publication-rehearsal'))


def test_reproduction_recomputes_original_video_reports_and_series_without_local_service(publication_rehearsal, tmp_path):
    from tree_publication_reproduction import reproduce_publication
    fixture = publication_rehearsal
    result = reproduce_publication(fixture['manifest'], fixture['downloads'], tmp_path / 'reproduction')
    assert result['hashesVerified'] is True
    assert result['comparison']['matched'] is True
    assert result['comparison']['missingInputs'] == []
    assert len(result['comparison']['individualAnalyses']) == 2
    assert result['comparison']['accumulated'] is True
    app_data = Path(fixture['data']) / 'tree-targeting/_publications/jobs.json'
    assert json.loads(app_data.read_text())[fixture['jobId']]['softwareTest'] is True


def test_reproduction_rejects_changed_missing_and_escaping_inputs(publication_rehearsal, tmp_path):
    from tree_publication_reproduction import reproduce_publication
    fixture = publication_rehearsal
    for role, expected in [('camera-original', 'changed'), ('analysis', 'changed'), ('clock-map', 'missing')]:
        downloads = tmp_path / role
        shutil.copytree(fixture['downloads'], downloads)
        manifest = json.loads(Path(fixture['manifest']).read_text())
        digest = next(key for key, file in manifest['files'].items() if file['role'] == role)
        if expected == 'changed': (downloads / digest).write_bytes(b'changed')
        else: (downloads / digest).unlink()
        with pytest.raises(ValueError, match=expected):
            reproduce_publication(fixture['manifest'], downloads, tmp_path / ('result-' + role), verify_only=True)
    unsafe = json.loads(Path(fixture['manifest']).read_text())
    next(iter(unsafe['files'].values()))['filename'] = '../escape'
    unsafe_path = tmp_path / 'unsafe.json'
    unsafe_path.write_text(json.dumps(unsafe))
    with pytest.raises(ValueError, match='filename|escape'):
        reproduce_publication(unsafe_path, fixture['downloads'], tmp_path / 'unsafe-output', verify_only=True)
    unavailable = json.loads(Path(fixture['manifest']).read_text())
    next(iter(unavailable['sourceReleases']['analyses'].values()))['packageSha256'] = 'f' * 64
    missing_source = tmp_path / 'missing-source.json'
    missing_source.write_text(json.dumps(unavailable))
    with pytest.raises(ValueError, match='Historical.*unavailable|source package'):
        reproduce_publication(missing_source, fixture['downloads'], tmp_path / 'missing-output')


def test_reproduction_requires_source_release_to_match_the_actual_selected_analysis(publication_rehearsal, tmp_path):
    from tree_publication_reproduction import reproduce_publication
    fixture = publication_rehearsal
    for field, value in [('files', {}), ('codeSha256', '0' * 64)]:
        manifest = json.loads(Path(fixture['manifest']).read_bytes())
        first = manifest['includedAnalyses'][0]['analysisId']
        manifest['sourceReleases']['analyses'][first][field] = value
        path = tmp_path / (field + '.json')
        path.write_text(json.dumps(manifest))
        with pytest.raises(ValueError, match='source.*identity|source.*identities'):
            reproduce_publication(path, fixture['downloads'], tmp_path / (field + '-output'))


def test_selected_analysis_reproduces_its_original_clock_and_review_after_later_edits(publication_rehearsal, tmp_path):
    from study_app import StudyApplication
    from tree_publication import prepare_publication
    from tree_publication_reproduction import reproduce_publication
    fixture = publication_rehearsal
    data = tmp_path / 'data'
    shutil.copytree(fixture['data'], data)
    application = StudyApplication(data)
    try:
        run_id = 'completed-one'
        retained = application._call(application._hosted_manifest, run_id)
        recording_id, recording = next((identity, record) for identity, record in retained['recordings'].items() if record['kind'] == 'video')
        analysis_id = application.series_store.state['runs'][run_id]['selectedRevision']
        artifact_path = application._hosted_directory(run_id) / retained['analyses'][analysis_id]['outputPath']
        artifact_bytes = artifact_path.read_bytes()
        application.save_recording_time_map(run_id, recording_id, None,
            [{'frameIndex': 0, 'serverDisplayedAtMs': 1000100, 'clockUncertaintyMs': .05},
             {'frameIndex': 199, 'serverDisplayedAtMs': 1008060, 'clockUncertaintyMs': .05}])
        application.save_obstruction_review(run_id, recording_id, 'obstructed',
            [{'startFrameIndex': 70, 'endFrameIndex': 90}])
        inventory = json.loads(Path(fixture['inventory']).read_text())['inventory']
        job = prepare_publication(application, fixture['seriesId'], 'test', inventory=inventory, software_test=True)
        files = tmp_path / 'files'
        files.mkdir()
        for identity, path in job['localFiles'].items(): shutil.copyfile(path, files / identity)
        result = reproduce_publication(job['manifestPath'], files, tmp_path / 'reproduction')
        assert result['comparison']['matched'] is True
        selected = next(item for item in job['manifest']['includedAnalyses'] if item['runId'] == run_id)
        inputs = json.loads((files / selected['reproductionInputsSha256']).read_text())['recordings'][recording_id]
        assert inputs['timeMapId'] == recording['timeMapId']
        assert inputs['clockMap'] == recording['clockMap']
        assert inputs['obstructionReviewId'] == recording['obstructionReviewId']
        assert artifact_path.read_bytes() == artifact_bytes
    finally: application.close()


def test_legacy_analysis_remains_readable_but_publication_requires_retained_input_associations(publication_rehearsal, tmp_path):
    from study_app import StudyApplication
    from study_http import AppError
    from tree_publication import prepare_publication
    fixture = publication_rehearsal
    data = tmp_path / 'data'
    shutil.copytree(fixture['data'], data)
    application = StudyApplication(data)
    try:
        run_id = 'completed-one'
        retained = application._call(application._hosted_manifest, run_id)
        analysis_id = application.series_store.state['runs'][run_id]['selectedRevision']
        directory = application._hosted_directory(run_id)
        artifact_path = directory / retained['analyses'][analysis_id]['outputPath']
        legacy = json.loads(artifact_path.read_bytes())
        legacy.pop('inputRecordings', None)
        artifact_path.write_text(json.dumps(legacy, sort_keys=True, separators=(',', ':')))
        retained['analyses'][analysis_id]['outputSha256'] = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        (directory / 'manifest.json').write_text(json.dumps(retained))
        assert application.get_analysis(run_id, analysis_id)['status'] == 'completed'
        inventory = json.loads(Path(fixture['inventory']).read_text())['inventory']
        with pytest.raises(AppError, match='input associations') as failure:
            prepare_publication(application, fixture['seriesId'], 'test', inventory=inventory, software_test=True)
        assert failure.value.code == 'analysis_inputs_unavailable'
        assert 'new analysis' in failure.value.public()['corrective_action']
        assert failure.value.public()['requiresNewSnapshot'] is True
    finally: application.close()


def test_no_camera_analysis_remains_visible_pending_and_fixture_marker_survives_restart(publication_rehearsal):
    from study_app import StudyApplication
    from study_http import AppError
    from tree_publication import prepare_publication
    fixture = publication_rehearsal
    inventory = json.loads(Path(fixture['inventory']).read_text())['inventory']
    application = StudyApplication(fixture['data'])
    try:
        selected = application._call(application._accumulating_series, fixture['seriesId'])
        assert selected['softwareTest'] is True
        with pytest.raises(AppError, match='Test|marker'):
            application._call(application.publication_jobs.create, {'seriesId': fixture['seriesId'], 'environment': 'production'})
        bundle = Path(fixture['manifest']).parent / 'pending-collected.json'
        application.import_run_bundle(bundle)
        pending = application.start_analysis('pending-collected', 'tree-development-1')
        assert pending['status'] == 'pending'
        assert pending['qualityReasons'] == ['video_recording_missing']
        job = prepare_publication(application, fixture['seriesId'], 'test', inventory=inventory, software_test=True)
        member = next(item for item in job['manifest']['inventory'] if item['runId'] == 'pending-collected')
        assert member['analysisState'] == 'pending' and member['contributes'] is False
        assert 'video_recording_missing' in member['analysisReason']
        assert [entry['runId'] for entry in job['manifest']['includedAnalyses']] == ['completed-one']
        created = application._call(application.publication_jobs.create, {'seriesId': fixture['seriesId'], 'environment': 'test'})
        assert created['softwareTest'] is True
    finally: application.close()


def test_downloaded_source_reproduces_from_its_own_package_after_public_http_download(publication_rehearsal, tmp_path):
    from tree_publication_reproduction import extract_source_package
    fixture = publication_rehearsal
    manifest = json.loads(Path(fixture['manifest']).read_text())
    digest = manifest['sourceReleases']['accumulation']['packageSha256']
    package = tmp_path / 'downloaded-source'
    extract_source_package(Path(fixture['downloads']) / digest, package)
    server = subprocess.Popen([shutil.which('node'), str(Path(__file__).parent / 'server/publication-rehearsal.mjs'),
                               fixture['jobPath']], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        ready = json.loads(server.stdout.readline())
        assert ready['status'] == 'completed', ready
        url = f"http://127.0.0.1:{ready['port']}/studies/tree-targeting/public/api/publications/{fixture['jobId']}"
        output = tmp_path / 'http-reproduced'
        downloaded = tmp_path / 'http-downloads'
        result = subprocess.run([sys.executable, '-I', str(package / 'scripts/reproduce-publication.py'),
                                 '--url', url, '--download', str(downloaded), '--output', str(output)],
                                cwd=package, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        summary = json.loads(result.stdout)
        assert summary['comparison']['matched'] is True
        assert (downloaded / 'manifest.json').read_bytes() == Path(fixture['manifest']).read_bytes()
        assert (downloaded / digest).read_bytes() == (Path(fixture['downloads']) / digest).read_bytes()
    finally:
        server.terminate()
        server.communicate(timeout=10)


@pytest.mark.parametrize('public_base', ['/studies/targeted-vegetation-movement/public/', '/studies/tree-targeting/public/'])
@pytest.mark.parametrize('input_kind', ['page', 'manifest', 'latest'])
def test_public_downloader_accepts_old_and_new_links_but_requests_canonical_bytes(public_base, input_kind, tmp_path, monkeypatch):
    from io import BytesIO
    import tree_publication_reproduction as reproduction
    publication_id = '11111111-1111-4111-8111-111111111111'
    original = bytes([0, 255, 32, 11, 64])
    digest = hashlib.sha256(original).hexdigest()
    manifest = {'schemaVersion': 1, 'experimentSlug': 'tree-targeting', 'purpose': 'scored', 'publicationId': publication_id,
                'files': {digest: {'sha256': digest, 'size': len(original), 'filename': 'camera original.mp4'}}}
    raw = (json.dumps(manifest, indent=2) + '\n').encode()
    canonical = 'https://lab.sourceof.love/studies/targeted-vegetation-movement/public/api/'
    requested = []
    class PublicOpener:
        def open(self, request, timeout):
            requested.append(request.full_url)
            assert request.get_header('Authorization') is None
            assert request.get_header('Cf-access-client-secret') is None
            assert timeout == 60
            if request.full_url == canonical + 'latest': return BytesIO(json.dumps({'publicationId': publication_id}).encode())
            if request.full_url == canonical + 'publications/' + publication_id + '/manifest': return BytesIO(raw)
            assert request.full_url == canonical + 'publications/' + publication_id + '/files/' + digest + '/camera%20original.mp4'
            return BytesIO(original)
    monkeypatch.setattr(reproduction, 'build_opener', lambda *handlers: PublicOpener())
    suffix = {'page': 'results?publication=' + publication_id + '#recording-one',
              'manifest': 'api/publications/' + publication_id + '/manifest', 'latest': ''}[input_kind]
    downloaded = reproduction.download_publication('https://lab.sourceof.love' + public_base + suffix, tmp_path / 'download')
    assert downloaded.read_bytes() == raw
    assert (downloaded.parent / digest).read_bytes() == original
    assert all(url.startswith(canonical) for url in requested)


@pytest.mark.parametrize('url', [
    'https://lab.sourceof.love/studies/targeted-vegetation-movement-other/public/',
    'https://lab.sourceof.love/studies/tree-targeting-other/public/',
    'https://lab.sourceof.love/studies/targeted-vegetation-movement/app/',
    'https://lab.sourceof.love/private/',
    'https://fixture:fixture@lab.sourceof.love/studies/targeted-vegetation-movement/public/',
    'http://lab.sourceof.love/studies/targeted-vegetation-movement/public/',
])
def test_public_downloader_rejects_credentials_nonpublic_paths_and_lookalikes_before_transport(url, tmp_path, monkeypatch):
    import tree_publication_reproduction as reproduction
    requested = []
    monkeypatch.setattr(reproduction, 'build_opener', lambda *handlers: requested.append(handlers))
    with pytest.raises(ValueError, match='public|HTTPS|URL'):
        reproduction.download_publication(url, tmp_path / 'download')
    assert requested == []


@pytest.mark.parametrize('public_base', ['/studies/targeted-vegetation-movement/public/', '/studies/tree-targeting/public/'])
def test_public_downloader_refuses_redirects_without_moving_the_request_or_credentials(public_base, tmp_path, monkeypatch):
    from urllib.error import HTTPError
    import tree_publication_reproduction as reproduction
    requested = []
    class RedirectingOpener:
        def open(self, request, timeout):
            requested.append(request.full_url)
            raise HTTPError(request.full_url, 308, 'Moved', {'Location': 'https://other.invalid/'}, None)
    monkeypatch.setattr(reproduction, 'build_opener', lambda *handlers: RedirectingOpener())
    with pytest.raises(ValueError, match='public access.*308'):
        reproduction.download_publication('https://lab.sourceof.love' + public_base + 'results?publication=retained', tmp_path / 'download')
    assert requested == ['https://lab.sourceof.love/studies/targeted-vegetation-movement/public/api/publications/retained/manifest']
