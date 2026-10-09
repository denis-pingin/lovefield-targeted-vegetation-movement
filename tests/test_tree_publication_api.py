import json
import threading
import time

import pytest

from publication_fixtures import scored_application
from study_app import HOSTED_API, StudyApplication
from study_http import AppError, start_http
from test_tree_api import comparison_http_request


def wait_publication(app, identifier, expected):
    for _ in range(500):
        result = app.dispatch('GET', HOSTED_API + 'publication/' + identifier)
        if result['status'] in expected: return result
        time.sleep(.01)
    raise AssertionError(result)


def test_explicit_prepare_is_async_visible_safe_and_excludes_conflicting_changes(tmp_path):
    app, series_id, inventory = scored_application(tmp_path)
    entered, release = threading.Event(), threading.Event()
    calls = []
    def inventory_reader(series, environment, software_test):
        calls.append((series, environment, software_test)); entered.set(); assert release.wait(10)
        return {'inventory': inventory, 'previousPublicationId': None}
    app.publication_inventory_reader = inventory_reader
    server = start_http(app)
    try:
        assert calls == []  # Completed local analysis has not contacted publication infrastructure.
        request = {'requestId': 'prepare', 'seriesId': series_id, 'environment': 'test', 'softwareTest': True}
        result = comparison_http_request(server, 'publication/prepare', request)
        assert result['status'] == 'preparing' and entered.wait(2)
        assert app.operation_progress()['stage'] == 'Preparing publication'
        assert comparison_http_request(server, 'publication/' + result['jobId'])['status'] == 'preparing'
        repeated = comparison_http_request(server, 'publication/prepare', request)
        assert repeated['jobId'] == result['jobId'] and len(calls) == 1
        with pytest.raises(AppError, match='publication'):
            app.dispatch('POST', HOSTED_API + 'select-revision', {'requestId': 'conflict', 'runId': 'completed-one', 'analysisId': 'irrelevant'})
        release.set()
        prepared = wait_publication(app, result['jobId'], {'prepared', 'failed'})
        assert prepared['status'] == 'prepared', prepared
        assert prepared['fileCount'] > 0 and prepared['uploadBytes'] > 0
        assert str(tmp_path) not in json.dumps(prepared)
        assert calls == [(series_id, 'test', True)]
    finally:
        release.set(); server.shutdown(); server.server_close(); app.close()


def test_upload_failure_is_visible_and_same_job_resumes_after_restart(tmp_path):
    app, series_id, inventory = scored_application(tmp_path)
    app.publication_inventory_reader = lambda *args: {'inventory': inventory, 'previousPublicationId': None}
    attempts = []
    def fail(job, progress):
        attempts.append(job['jobId']); progress(stage='Uploading publication', completed=2, total=10, unit='bytes')
        raise RuntimeError('private-subprocess-detail')
    app.publication_uploader = fail
    try:
        prepared = app.dispatch('POST', HOSTED_API + 'publication/prepare', {'requestId': 'prepare', 'seriesId': series_id, 'environment': 'test', 'softwareTest': True})
        wait_publication(app, prepared['jobId'], {'prepared'})
        result = app.dispatch('POST', HOSTED_API + 'publication/' + prepared['jobId'] + '/start', {'requestId': 'start'})
        assert result['status'] == 'uploading'
        failed = wait_publication(app, prepared['jobId'], {'failed'})
        assert 'private-subprocess-detail' not in json.dumps(failed)
        assert failed['error'] and attempts == [prepared['jobId']]
        directory = app.directory
    finally: app.close()
    resumed = StudyApplication(directory, publication_uploader=lambda job, progress: {'publicationId': job['jobId'], 'status': 'completed', 'resultsUrl': 'https://test.lab.sourceof.love/studies/tree-targeting/public/results'})
    try:
        assert resumed.dispatch('GET', HOSTED_API + 'publication')['jobs'][0]['jobId'] == prepared['jobId']
        resumed.dispatch('POST', HOSTED_API + 'publication/' + prepared['jobId'] + '/start', {'requestId': 'resume'})
        completed = wait_publication(resumed, prepared['jobId'], {'completed'})
        assert completed['resultsUrl'].startswith('https://test.lab.sourceof.love/')
    finally: resumed.close()


def test_status_polling_remains_available_during_serialized_snapshot_hashing(tmp_path, monkeypatch):
    import tree_publication
    import tree_source_release
    app, series_id, inventory = scored_application(tmp_path)
    app.publication_inventory_reader = lambda *args: {'inventory': inventory, 'previousPublicationId': None}
    entered, release, packaging_release = threading.Event(), threading.Event(), threading.Event()
    real_archive = tree_source_release.archive_source_release
    def held_archive(*arguments, **keywords):
        assert packaging_release.wait(10)
        return real_archive(*arguments, **keywords)
    monkeypatch.setattr(tree_source_release, 'archive_source_release', held_archive)
    real_digest = tree_publication.digest_file
    def held_digest(path, progress=None):
        if not entered.is_set():
            entered.set(); assert release.wait(10)
        return real_digest(path, progress)
    monkeypatch.setattr(tree_publication, 'digest_file', held_digest)
    try:
        preparing = app.dispatch('POST', HOSTED_API + 'publication/prepare', {'requestId': 'hashing', 'seriesId': series_id, 'environment': 'test', 'softwareTest': True})
        assert entered.wait(3)
        started = time.monotonic()
        state = app.dispatch('GET', HOSTED_API + 'publication/' + preparing['jobId'])
        assert state['status'] == 'preparing' and time.monotonic() - started < .5
        repeated = app.dispatch('POST', HOSTED_API + 'publication/prepare', {'requestId': 'hashing', 'seriesId': series_id, 'environment': 'test', 'softwareTest': True})
        assert repeated['jobId'] == preparing['jobId']
        with pytest.raises(AppError, match='publication'):
            app.dispatch('POST', HOSTED_API + 'select-revision', {'requestId': 'blocked-during-hash'})
        release.set()
        packaging_release.set()
        assert wait_publication(app, preparing['jobId'], {'prepared', 'failed'})['status'] == 'prepared'
    finally:
        release.set()
        packaging_release.set()
        app.close()
