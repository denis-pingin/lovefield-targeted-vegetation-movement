import hashlib
import http.client
import json
import shutil
import subprocess
import time
from pathlib import Path

import cv2
import numpy as np

from study_app import StudyApplication, HOSTED_API
from study_http import start_http, APPLICATION_HEADER, APPLICATION_VALUE
from tree_calculator import Series, MotionBin
from test_tree_api import Picker


def synthetic_original(path, seed):
    base = np.random.default_rng(seed).integers(0, 255, (120, 180), dtype=np.uint8)
    intermediate = path.with_suffix('.avi')
    writer = cv2.VideoWriter(str(intermediate), cv2.VideoWriter_fourcc(*'MJPG'), 25., (180, 120))
    for index in range(200):
        frame = cv2.warpAffine(base, np.float32([[1, 0, index * .1], [0, 1, 0]]), (180, 120), borderMode=cv2.BORDER_REFLECT)
        writer.write(cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR))
    writer.release()
    subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-i', str(intermediate), '-c:v', 'copy',
                    '-timecode', '00:00:00:00', str(path)], check=True, capture_output=True)
    return path


def request(server, endpoint, payload=None, expected_status=(200, 202)):
    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=20)
    try:
        headers = {'Origin': f'http://127.0.0.1:{server.server_port}', APPLICATION_HEADER: APPLICATION_VALUE,
                   'Content-Type': 'application/json'}
        connection.request('GET' if payload is None else 'POST', HOSTED_API + endpoint,
                           body=None if payload is None else json.dumps(payload), headers=headers)
        response = connection.getresponse()
        value = json.loads(response.read())
        assert response.status in expected_status, value
        return value
    finally:
        connection.close()


def completed_analysis(server, run_id, request_id):
    job = request(server, 'start-analysis', {'requestId': request_id, 'runId': run_id, 'profileId': 'tree-development-1'})
    for _ in range(400):
        value = request(server, f"runs/{run_id}/analyses/{job['analysisId']}")
        if value['status'] != 'running':
            assert value['status'] == 'completed', value
            return value
        time.sleep(.01)
    raise AssertionError('Actual synthetic camera analysis did not finish')


def test_installed_analysis_page_serves_every_nested_module_with_javascript_mime(tmp_path):
    application = StudyApplication(tmp_path / 'data')
    server = start_http(application)
    try:
        for asset in ('app.mjs', 'operator-model.mjs', 'views.mjs', 'tree-comparisons.mjs',
                      'tree-results.mjs', 'run-config.mjs', 'cues.mjs', 'clock.mjs'):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            try:
                connection.request('GET', '/tree-targeting/analysis/' + asset)
                response = connection.getresponse()
                body = response.read()
                assert response.status == 200, (asset, response.status, body)
                assert response.getheader('Content-Type') == 'text/javascript; charset=utf-8'
                assert body
            finally:
                connection.close()
    finally:
        server.shutdown()
        server.server_close()
        application.close()


def test_handler_export_to_mac_original_analysis_pending_prefix_revisions_and_restart(tmp_path):
    setup = tmp_path / 'setup'
    setup.mkdir()
    image = cv2.imencode('.png', np.random.default_rng(21).integers(0, 255, (120, 180, 3), dtype=np.uint8))[1].tobytes()
    digest = hashlib.sha256(image).hexdigest()
    (setup / f'{digest}.png').write_bytes(image)
    (setup / f'{digest}.json').write_text(json.dumps({'sha256': digest,
        'imageSize': {'width': 180, 'height': 120}, 'sources': [{'sourceKind': 'main',
        'sourceVideoName': 'synthetic.mov', 'sourceVideoSha256': 'a' * 64, 'frameIndex': 0, 'ptsSeconds': 0}]}))
    fixture = Path(__file__).parent / 'server/export-fixture.mjs'
    subprocess.run([shutil.which('node'), str(fixture), str(tmp_path), digest], check=True, capture_output=True, text=True)
    paths = {run_id: tmp_path / f'{run_id}.json' for run_id in ('earlier-stopped', 'later-completed')}
    originals = {run_id: synthetic_original(tmp_path / f'{run_id}.mov', seed)
                 for run_id, seed in [('earlier-stopped', 41), ('later-completed', 43)]}
    original_hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in {**paths, **{
        name + '-camera': value for name, value in originals.items()}}.items()}
    data = tmp_path / 'independent-tree-data'
    picker = Picker(setup)
    application = StudyApplication(data, picker=picker)
    server = start_http(application)
    try:
        picker.path = paths['later-completed']
        imported_run = request(server, 'import-bundle', {'requestId': 'import-later-completed'})
        assert imported_run['runId'] == 'later-completed'
        assert request(server, 'series/' + imported_run['seriesId'])['membershipStatus'] == 'manifest_missing'
        picker.path = tmp_path / 'series.json'
        imported_series = request(server, 'import-bundle', {'requestId': 'import-series'})
        series_id = imported_series['seriesId']
        assert imported_series['bundleKind'] == 'series'
        picker.path = setup
        request(server, 'import-retained-setup', {'requestId': 'setup'})
        def import_camera(run_id):
            assert request(server, 'runs/' + run_id)['savedSetup']['imageSha256'] == digest
            picker.path = originals[run_id]
            imported = request(server, 'import-recording', {'requestId': 'camera-' + run_id, 'runId': run_id, 'kind': 'video'})['recordings'][0]
            base = 1000000 if run_id == 'earlier-stopped' else 1020000
            mapping = request(server, 'save-time-map', {'requestId': 'map-' + run_id, 'runId': run_id,
                'videoRecordingId': imported['recordingId'], 'windRecordingId': None,
                'references': [{'frameIndex': 0, 'serverDisplayedAtMs': base, 'clockUncertaintyMs': .05},
                               {'frameIndex': 199, 'serverDisplayedAtMs': base + 7960, 'clockUncertaintyMs': .05}]})
            assert mapping['qualified'] is True, mapping
            request(server, 'save-obstruction-review', {'requestId': 'review-' + run_id, 'runId': run_id,
                'videoRecordingId': imported['recordingId'], 'decision': 'clear', 'spans': []})
        import_camera('later-completed')
        later = completed_analysis(server, 'later-completed', 'later-analysis')
        assert later['result']['report']['counts']['usableBins'] == 2
        pending = request(server, 'series/' + series_id)
        assert pending['runCount'] == 0
        assert pending['pendingRuns'] == ['earlier-stopped', 'later-completed']
        assert pending['inventoryRunIds'] == ['unstarted-configuration', 'earlier-stopped', 'later-completed']
        changed = json.loads((tmp_path / 'series.json').read_text())
        changed['members'][-1]['configHash'] = 'b' * 64
        invalid = tmp_path / 'changed-series.json'
        invalid.write_text(json.dumps(changed))
        picker.path = invalid
        rejected = request(server, 'import-bundle', {'requestId': 'changed-series'}, expected_status=(400,))
        assert rejected['error']['code'] == 'invalid_series_bundle'
        assert request(server, 'series/' + series_id) == pending
        assert request(server, 'runs')['runs'][0]['seriesId'] == series_id
        picker.path = paths['earlier-stopped']
        request(server, 'import-bundle', {'requestId': 'import-earlier-stopped'})
        import_camera('earlier-stopped')
        earlier = completed_analysis(server, 'earlier-stopped', 'earlier-analysis')
        accumulated = request(server, 'series/' + series_id)
        assert accumulated['runCount'] == 2 and accumulated['targetCount'] == 2
        assert accumulated['full']['bounded_missing_targets'] == 1
        assert accumulated['runIds'] == ['earlier-stopped', 'later-completed']
        revised = completed_analysis(server, 'earlier-stopped', 'earlier-analysis-revised')
        retained = request(server, 'series/' + series_id)
        assert retained['runCount'] == 2 and retained['targetCount'] == 2
        assert retained['selectedRevisions'] == [earlier['analysisId'], later['analysisId']]
        request(server, 'select-revision', {'requestId': 'choose-earlier-revision',
            'runId': 'earlier-stopped', 'analysisId': revised['analysisId']})
        retained = request(server, 'series/' + series_id)
        assert retained['selectedRevisions'] == [revised['analysisId'], later['analysisId']]
        reference = Series()
        for artifact in (earlier, later):
            for target in artifact['result']['targets']:
                reference.add_target(artifact['runId'], target['targetIndex'], int(target['assignedRegion'] == 'A'),
                    [MotionBin(item['duration'], item['a'], item['b'], item['usable'],
                               raw_motion=(item['rawA'], item['rawB'])) for item in target['bins']])
        assert retained['logEvidence'] == reference.log_e()
        assert request(server, 'runs/earlier-stopped')['lifecycle'] == 'stopped'
        independent = request(server, 'series')
        assert independent['runCount'] == 0 and independent['targetCount'] == 0
        assert independent['membershipStatus'] == 'local_imports_only'
        picker.path = tmp_path
        exported = request(server, 'export-report', {'requestId': 'named-report', 'seriesId': series_id})
        saved = json.loads((tmp_path / exported['filename']).read_text())
        assert saved['seriesId'] == series_id and saved['runIds'] == retained['runIds']
        assert saved['full']['bounded_missing_targets'] == 1
        assert 'Preparation results are exploratory' in (tmp_path / exported['textFilename']).read_text()
    finally:
        server.shutdown()
        server.server_close()
        application.close()
    restarted = StudyApplication(data)
    server = start_http(restarted)
    try:
        assert request(server, 'series/' + series_id) == retained
        assert len(request(server, 'runs/earlier-stopped')['analyses']) == 2
        for name, path in {**paths, **{name + '-camera': value for name, value in originals.items()}}.items():
            assert hashlib.sha256(path.read_bytes()).hexdigest() == original_hashes[name]
    finally:
        server.shutdown()
        server.server_close()
        restarted.close()
