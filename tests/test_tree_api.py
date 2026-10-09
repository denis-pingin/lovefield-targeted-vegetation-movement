import copy
import hashlib
import http.client
import json
import time
from pathlib import Path

import cv2
import numpy as np
import pytest

from study_app import StudyApplication, HOSTED_API
from study_http import AppError, APPLICATION_HEADER, APPLICATION_VALUE, start_http
from study_profiles import area_profile, development_profile
from study_analysis import analyze_extracted_run
from tree_fixtures import tree_bundle, write_bundle
from test_tree_analysis import measured_pairs, recording


class Picker:
    def __init__(self, path): self.path = path
    def choose(self, kind): return [self.path]


def wait_result(app, run_id, identifier):
    for _ in range(100):
        result = app.get_analysis(run_id, identifier)
        if result['status'] != 'running': return result
        time.sleep(.01)
    raise AssertionError('Analysis did not finish')


def movie(path, *, frame_count=15, frame_rate=25.):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), frame_rate, (120, 80))
    assert writer.isOpened()
    rng = np.random.default_rng(21)
    frame = rng.integers(0, 255, (80, 120, 3), dtype=np.uint8)
    for _ in range(frame_count): writer.write(frame)
    writer.release()
    return path


def comparison_http_request(server, endpoint, payload=None):
    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
    try:
        headers = {'Origin': f'http://127.0.0.1:{server.server_port}',
                   APPLICATION_HEADER: APPLICATION_VALUE, 'Content-Type': 'application/json'}
        connection.request('POST' if payload is not None else 'GET', HOSTED_API + endpoint,
                           body=json.dumps(payload) if payload is not None else None, headers=headers)
        response = connection.getresponse()
        value = json.loads(response.read())
        assert response.status == 200, value
        return value
    finally:
        connection.close()


def test_profile_save_and_selection_survive_service_restart(tmp_path):
    bundle = write_bundle(tmp_path / 'run.json', tree_bundle())
    data = tmp_path / 'data'
    app = StudyApplication(data, picker=Picker(bundle))
    try:
        app.dispatch('POST', HOSTED_API + 'import-bundle', {'requestId': 'import'})
        profile = copy.deepcopy(development_profile())
        profile['profileId'] = 'tree-1200-31'
        profile['label'] = 'Tree 1200/31 - my settings'
        profile['video']['featureDetection']['maxCorners'] = 1200
        profile['video']['tracking']['windowSizePixels'] = [31, 31]
        saved = app.dispatch('POST', HOSTED_API + 'save-profile', {'requestId': 'save', 'runId': 'tree-1', 'profile': profile})
        selected = app.dispatch('POST', HOSTED_API + 'select-profile', {'requestId': 'select', 'runId': 'tree-1', 'profileId': profile['profileId']})
        assert selected['selectedProfileId'] == profile['profileId']
        assert saved['profile']['video']['featureDetection']['maxCorners'] == 1200
    finally: app.close()
    restarted = StudyApplication(data)
    try:
        assert restarted.dispatch('GET', HOSTED_API + 'runs/tree-1')['selectedProfileId'] == 'tree-1200-31'
        available = restarted.dispatch('GET', HOSTED_API + 'profiles')['profiles']
        assert next(profile for profile in available if profile['profileId'] == 'tree-1200-31')['label'] == 'Tree 1200/31 - my settings'
    finally: restarted.close()


def test_real_comparison_api_pins_both_revisions_and_reopens_after_restart(tmp_path):
    bundle = write_bundle(tmp_path / 'run.json', tree_bundle())
    def analyzer(retained, originals, profile):
        return analyze_extracted_run(retained, measured_pairs(), profile, recording())
    directory = tmp_path / 'data'
    app = StudyApplication(directory, picker=Picker(bundle), hosted_analyzer=analyzer)
    server = start_http(app)
    try:
        app.dispatch('POST', HOSTED_API + 'import-bundle', {'requestId': 'import'})
        imported = app.import_recording('tree-1', movie(tmp_path / 'camera.avi'), 'video')
        app.save_obstruction_review('tree-1', imported['recordingId'], 'clear', [])
        candidate = comparison_http_request(server, 'comparison-candidates')
        assert candidate['runs'][0]['runId'] == 'tree-1'
        assert candidate['runs'][0]['analyses'] == []
        left = app.start_analysis('tree-1', 'tree-development-1')
        wait_result(app, 'tree-1', left['analysisId'])
        right = app.start_analysis('tree-1', 'tree-development-area-1')
        wait_result(app, 'tree-1', right['analysisId'])
        request = {'requestId': 'save-comparison', 'label': 'Matched footage',
                   'leftProfileId': 'tree-development-1', 'rightProfileId': 'tree-development-area-1',
                   'rows': [{'runId': 'tree-1', 'leftAnalysisId': left['analysisId'],
                             'rightAnalysisId': right['analysisId']}]}
        saved = comparison_http_request(server, 'save-comparison', request)
        assert saved['commonPrefixRunIds'] == ['tree-1']
        assert saved['rows'][0]['status'] == 'paired'
        assert saved['rows'][0]['tag'] == candidate['runs'][0]['tag']
        assert saved['rows'][0]['createdAtMs'] == candidate['runs'][0]['createdAtMs']
        assert saved['left']['targetCount'] == saved['right']['targetCount'] == 2
        assert comparison_http_request(server, 'comparisons')['comparisons'][0]['comparisonId'] == saved['comparisonId']
    finally:
        server.shutdown()
        server.server_close()
        app.close()
    restarted = StudyApplication(directory)
    server = start_http(restarted)
    try:
        opened = comparison_http_request(server, 'comparisons/' + saved['comparisonId'])
        assert opened['comparisonId'] == saved['comparisonId']
        assert opened['rows'] == saved['rows']
        assert opened['leftDisplayReport']['counts']['targets'] == opened['rightDisplayReport']['counts']['targets'] == 2
    finally:
        server.shutdown()
        server.server_close()
        restarted.close()


def test_stopped_export_import_analysis_retains_unknown_and_reanalysis_once(tmp_path):
    bundle = tree_bundle()
    bundle['state']['lifecycle'] = 'stopped'
    bundle['cues'][-1].update(deliveryStatus='failed', playedAtMs=None)
    path = write_bundle(tmp_path / 'stopped.json', bundle)
    def analyzer(retained, originals, profile):
        return analyze_extracted_run(retained, measured_pairs(), profile, recording())
    app = StudyApplication(tmp_path / 'data', picker=Picker(path), hosted_analyzer=analyzer)
    try:
        app.dispatch('POST', HOSTED_API + 'import-bundle', {'requestId': 'import'})
        imported = app.import_recording('tree-1', movie(tmp_path / 'camera.avi'), 'video')
        app.save_obstruction_review('tree-1', imported['recordingId'], 'clear', [])
        first = app.dispatch('POST', HOSTED_API + 'start-analysis', {'requestId': 'analysis-one', 'runId': 'tree-1', 'profileId': 'tree-development-1'})
        artifact = wait_result(app, 'tree-1', first['analysisId'])
        assert artifact['status'] == 'completed'
        assert artifact['result']['report']['counts']['targets'] == 2
        assert artifact['result']['report']['counts']['missingBins'] == 2
        entry = app.get_run('tree-1')['analyses'][first['analysisId']]
        artifact_path = app._hosted_directory('tree-1') / entry['outputPath']
        original_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        assert artifact['displayReport']['counts']['targets'] == 2
        assert artifact['displayReportSourceHash'] == hashlib.sha256(
            (Path(__file__).parents[1] / 'src/tree_report.py').read_bytes()).hexdigest()
        app.get_analysis('tree-1', first['analysisId'])
        assert hashlib.sha256(artifact_path.read_bytes()).hexdigest() == original_hash
        report = app.dispatch('GET', HOSTED_API + 'series')
        assert report['runCount'] == 1
        assert report['targetCount'] == 2
        assert report['report']['full']['bounded_missing_targets'] == 1
        second = app.start_analysis('tree-1', 'tree-development-1')
        wait_result(app, 'tree-1', second['analysisId'])
        updated = app.dispatch('GET', HOSTED_API + 'series')
        assert updated['runCount'] == 1 and updated['targetCount'] == 2
        assert updated['selectedRevisions'] == [first['analysisId']]
        assert len(app.get_run('tree-1')['analyses']) == 2
        assert app.dispatch('GET', HOSTED_API + f"runs/tree-1/analyses/{first['analysisId']}")['analysisId'] == first['analysisId']
        assert app.dispatch('GET', HOSTED_API + f"runs/tree-1/analyses/{second['analysisId']}")['analysisId'] == second['analysisId']
        assert hashlib.sha256(artifact_path.read_bytes()).hexdigest() == original_hash
    finally: app.close()


def test_annotation_job_exposes_progress_and_verified_saved_artifact(tmp_path):
    bundle = tree_bundle()
    bundle['state']['setupSnapshot'] = {'imageSize': {'width': 120, 'height': 80}, 'regions': {
        'A': {'x': 2, 'y': 2, 'width': 35, 'height': 65}, 'B': {'x': 42, 'y': 2, 'width': 35, 'height': 65}, 'background': {'x': 82, 'y': 2, 'width': 35, 'height': 65}}}
    path = write_bundle(tmp_path / 'run.json', bundle)
    app = StudyApplication(tmp_path / 'data', picker=Picker(tmp_path))
    try:
        app.import_run_bundle(path)
        imported = app.import_recording('tree-1', movie(tmp_path / 'camera.avi'), 'video')
        assert app.get_run('tree-1')['recordings'][imported['recordingId']]['videoEndSeconds'] == .6
        with pytest.raises(AppError, match='magnification'):
            app.dispatch('POST', HOSTED_API + 'export-annotated-clip', {'requestId': 'invalid-display', 'runId': 'tree-1',
                'recordingId': imported['recordingId'], 'profileId': 'tree-development-1',
                'startSeconds': .2, 'durationSeconds': .2, 'displayMagnification': 0})
        assert app.dispatch('GET', HOSTED_API + 'annotations')['jobs'] == []
        assert app.dispatch('GET', HOSTED_API + 'progress')['status'] == 'idle'
        job = app.dispatch('POST', HOSTED_API + 'export-annotated-clip', {'requestId': 'annotation', 'runId': 'tree-1',
            'recordingId': imported['recordingId'], 'profileId': 'tree-development-1', 'startSeconds': .2, 'durationSeconds': .2})
        for _ in range(100):
            current = app.dispatch('GET', HOSTED_API + 'annotations/' + job['jobId'])
            if current['status'] != 'running': break
            time.sleep(.01)
        assert current['status'] == 'completed', current
        assert current['frames'] == 5
        assert current['artifactUrl'].endswith('/clip.avi')
        artifact = app.get_annotation_artifact(job['jobId'])
        assert artifact.is_file()
        assert current['profileHash'] == app._resolve_hosted_profile('tree-development-1')['sha256']
    finally: app.close()


def test_full_video_annotation_uses_retained_endpoint_and_rejects_range_past_it(tmp_path):
    bundle = tree_bundle()
    bundle['state']['setupSnapshot'] = {'imageSize': {'width': 120, 'height': 80}, 'regions': {
        'A': {'x': 2, 'y': 2, 'width': 35, 'height': 65}, 'B': {'x': 42, 'y': 2, 'width': 35, 'height': 65},
        'background': {'x': 82, 'y': 2, 'width': 35, 'height': 65}}}
    path = write_bundle(tmp_path / 'run.json', bundle)
    app = StudyApplication(tmp_path / 'data', picker=Picker(tmp_path))
    try:
        app.import_run_bundle(path)
        original = movie(tmp_path / 'long-camera.avi', frame_count=122, frame_rate=2.)
        source_hash = hashlib.sha256(original.read_bytes()).hexdigest()
        imported = app.import_recording('tree-1', original, 'video')
        retained = app.dispatch('GET', HOSTED_API + 'runs/tree-1')['recordings'][imported['recordingId']]
        assert retained['videoEndSeconds'] == 61
        job = app.dispatch('POST', HOSTED_API + 'export-annotated-clip', {'requestId': 'full-annotation',
            'runId': 'tree-1', 'recordingId': imported['recordingId'], 'profileId': 'tree-development-1',
            'startSeconds': 0, 'durationSeconds': retained['videoEndSeconds']})
        initial_progress = app.dispatch('GET', HOSTED_API + 'progress')
        assert initial_progress['status'] == 'running' and initial_progress['jobId'] == job['jobId']
        for _ in range(1000):
            current = app.dispatch('GET', HOSTED_API + 'annotations/' + job['jobId'])
            if current['status'] != 'running':
                break
            time.sleep(.01)
        assert current['status'] == 'completed', current
        assert current['frames'] == 122
        assert (current['startPtsSeconds'], current['lastPtsSeconds']) == (0, 60.5)
        assert current['sourceSha256'] == retained['sha256'] == source_hash
        assert current['profileHash'] == app._resolve_hosted_profile('tree-development-1')['sha256']
        assert app.get_annotation_artifact(job['jobId']).is_file()
        assert hashlib.sha256(original.read_bytes()).hexdigest() == source_hash
        before = set(app._annotation_jobs)
        with pytest.raises(AppError, match='range|video|duration'):
            app.dispatch('POST', HOSTED_API + 'export-annotated-clip', {'requestId': 'past-end',
                'runId': 'tree-1', 'recordingId': imported['recordingId'], 'profileId': 'tree-development-1',
                'startSeconds': 0, 'durationSeconds': retained['videoEndSeconds'] + .5})
        assert set(app._annotation_jobs) == before
    finally:
        app.close()
