"""Generated original footage and real local Tree analysis, never field data."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

import cv2

from publication_fixtures import fixture_source_checkpoint
from study_app import StudyApplication
from study_http import start_http
from test_tree_api import Picker
from test_tree_end_to_end import synthetic_original, request, completed_analysis


def prepare_rehearsal(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()): raise ValueError('The software rehearsal destination must be empty.')
    originals = {name: synthetic_original(directory / (name + '.mov'), seed)
                 for name, seed in [('completed-one', 41), ('missing-stopped', 43)]}
    capture = cv2.VideoCapture(str(originals['completed-one']))
    try:
        available, frame = capture.read()
        if not available: raise ValueError('The generated original cannot be decoded.')
    finally: capture.release()
    image = cv2.imencode('.png', frame)[1].tobytes()
    digest = hashlib.sha256(image).hexdigest()
    setup = directory / 'setup'
    setup.mkdir()
    (setup / (digest + '.png')).write_bytes(image)
    (setup / (digest + '.json')).write_text(json.dumps({'sha256': digest, 'imageSize': {'width': 180, 'height': 120},
        'sources': [{'sourceKind': 'main', 'sourceVideoName': originals['completed-one'].name,
                     'sourceVideoSha256': hashlib.sha256(originals['completed-one'].read_bytes()).hexdigest(), 'frameIndex': 0, 'ptsSeconds': 0}]}))
    subprocess.run([shutil.which('node'), str(Path(__file__).parent / 'server/export-fixture.mjs'), str(directory), digest,
                    'scored', fixture_source_checkpoint()], check=True, capture_output=True)
    series = json.loads((directory / 'series.json').read_text())
    inventory = []
    for member in series['members']:
        if member['collectionStartedAtMs'] is None: continue
        bundle = json.loads((directory / (member['runId'] + '.json')).read_text())
        inventory.append({**member, 'lifecycle': bundle['state']['lifecycle'],
                          'recordingStartedAtMs': bundle['state']['recordingStartedAtMs'],
                          'finishedAtMs': bundle['state']['finishedAtMs'], 'tag': 'software-test-generated-video'})
    retained_inventory = {'seriesId': series['seriesId'], 'softwareTest': True, 'inventory': inventory}
    inventory_path = directory / 'software-test-inventory.json'
    inventory_path.write_text(json.dumps(retained_inventory))
    picker = Picker(setup)
    data = directory / 'data'
    application = StudyApplication(data, picker=picker, publication_inventory_reader=lambda *_: {**retained_inventory, 'previousPublicationId': None})
    server = start_http(application)
    try:
        picker.path = directory / 'series.json'
        request(server, 'import-bundle', {'requestId': 'series'})
        for run_id in originals:
            picker.path = directory / (run_id + '.json')
            request(server, 'import-bundle', {'requestId': 'bundle-' + run_id})
        picker.path = setup
        request(server, 'import-retained-setup', {'requestId': 'setup'})
        for run_id, base in [('completed-one', 1000000), ('missing-stopped', 1040000)]:
            picker.path = originals[run_id]
            camera = request(server, 'import-recording', {'requestId': 'camera-' + run_id, 'runId': run_id, 'kind': 'video'})['recordings'][0]
            mapping = request(server, 'save-time-map', {'requestId': 'map-' + run_id, 'runId': run_id,
                'videoRecordingId': camera['recordingId'], 'windRecordingId': None,
                'references': [{'frameIndex': 0, 'serverDisplayedAtMs': base, 'clockUncertaintyMs': .05},
                               {'frameIndex': 199, 'serverDisplayedAtMs': base + 7960, 'clockUncertaintyMs': .05}]})
            if not mapping['qualified']: raise ValueError('The generated camera mapping is unqualified.')
            request(server, 'save-obstruction-review', {'requestId': 'review-' + run_id, 'runId': run_id,
                'videoRecordingId': camera['recordingId'], 'decision': 'clear', 'spans': []})
            completed_analysis(server, run_id, 'analysis-' + run_id)
        job = request(server, 'publication/prepare', {'requestId': 'software-test-publication',
                      'seriesId': series['seriesId'], 'environment': 'test', 'softwareTest': True})
        deadline = time.monotonic() + 60
        while job['status'] == 'preparing' and time.monotonic() < deadline:
            time.sleep(.02)
            job = request(server, 'publication/' + job['jobId'])
        if job['status'] != 'prepared': raise ValueError('Software publication preparation failed: ' + json.dumps(job.get('error')))
        snapshot_path = application.publication_jobs._snapshot_path(job['jobId'])
        snapshot = json.loads(snapshot_path.read_text())
        downloads = directory / 'downloaded-files'
        downloads.mkdir()
        for identity, original in snapshot['localFiles'].items(): shutil.copyfile(original, downloads / identity)
        manifest = directory / 'manifest.json'
        shutil.copyfile(snapshot['manifestPath'], manifest)
        selected = request(server, 'series/' + series['seriesId'])
        if not selected.get('softwareTest'): raise ValueError('The selected series lost its retained software-test marker.')
    finally:
        server.shutdown(); server.server_close(); application.close()
    result = {'softwareTest': True, 'seriesId': series['seriesId'], 'jobId': job['jobId'], 'jobPath': str(snapshot_path),
              'data': str(data), 'manifest': str(manifest), 'downloads': str(downloads), 'inventory': str(inventory_path)}
    (directory / 'rehearsal.json').write_text(json.dumps(result, indent=2))
    return result
