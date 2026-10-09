"""Explicit, reproducible missing-camera outcomes using disposable study inputs."""
import copy
import hashlib
import itertools
import json
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

import pytest

from publication_fixtures import scored_application
from study_app import HOSTED_API, StudyApplication
from study_http import AppError, start_http
from study_profiles import development_profile
from study_analysis import analyze_extracted_run
from tree_fixtures import tree_bundle, write_bundle
from test_tree_analysis import measured_pairs, recording
from test_tree_api import comparison_http_request, movie, wait_result
from test_tree_end_to_end import request as http_request
from test_tree_publication_api import wait_publication
from test_publication_reproduction import publication_rehearsal


def finalize(application, run_id, *, request_id='finalize-loss', reason='Camera file was lost.', profile_id='tree-development-1'):
    request = {'requestId': request_id, 'runId': run_id, 'profileId': profile_id, 'reason': reason}
    started = application.dispatch('POST', HOSTED_API + 'finalize-missing-measurements', request)
    return wait_result(application, run_id, started['analysisId']), request


def imported_application(directory, bundle=None, *, analyzer=None):
    application = StudyApplication(directory / 'data', hosted_analyzer=analyzer)
    application.import_run_bundle(write_bundle(directory / 'run.json', bundle or tree_bundle()))
    return application


def remove_camera(application, run_id):
    manifest = application.get_run(run_id)
    recording_id, record = next((identifier, item) for identifier, item in manifest['recordings'].items() if item['kind'] == 'video')
    (application._hosted_directory(run_id) / record['relativePath']).unlink()
    return recording_id, record


def test_finalization_unblocks_collection_order_with_immutable_revision_and_no_network_write(tmp_path):
    application, series_id, _ = scored_application(tmp_path, pending_first=True)
    server = start_http(application)
    calls = []
    application.publication_inventory_reader = lambda *args: calls.append(args)
    try:
        before = application.dispatch('GET', HOSTED_API + 'series/' + series_id)
        assert before['runIds'] == [] and before['pendingRuns'] == ['earlier-pending', 'completed-one']
        pending = application.start_analysis('earlier-pending', 'tree-development-1')
        assert pending['status'] == 'pending'
        request = {'requestId': 'finalize-earlier-loss', 'runId': 'earlier-pending',
                   'profileId': 'tree-development-1', 'reason': 'Camera file was lost.'}
        start_time = int(time.time() * 1000)
        started = http_request(server, 'finalize-missing-measurements', request, expected_status=(202,))
        assert started['status'] == 'running'
        artifact = wait_result(application, request['runId'], started['analysisId'])
        assert artifact['status'] == 'completed', artifact
        result = artifact['result']
        declaration = result['measurementDisposition']
        assert declaration['reason'] == request['reason']
        assert start_time <= declaration['recordedAtMs'] <= int(time.time() * 1000)
        assert declaration['runId'] == request['runId']
        assert declaration['bundleSha256'] == artifact['bundleSha256']
        assert declaration['profileSha256'] == artifact['profileSha256']
        assert declaration['videoExtractionRepeatable'] is False
        assert artifact['inputHashes'] == result['inputHashes'] == {}
        assert len(result['targets']) == 2
        assert all(not item['usable'] and item['a'] is None and item['b'] is None
                   for target in result['targets'] for item in target['bins'])
        assert result['calculation']['streams']['-1']['effect_estimate_bounds'] == [-1., 1.]
        series = comparison_http_request(server, 'series/' + series_id)
        assert series['runIds'] == ['earlier-pending', 'completed-one']
        assert series['targetCount'] == 4
        assert series['selectedRevisions'][0] == started['analysisId']
        assert http_request(server, 'finalize-missing-measurements', request, expected_status=(202,)) == started
        assert application.get_analysis(request['runId'], pending['analysisId'])['status'] == 'pending'
        assert calls == []
        directory = application.directory
        completed = copy.deepcopy(artifact)
    finally:
        server.shutdown()
        server.server_close()
        application.close()
    restarted = StudyApplication(directory)
    try:
        assert restarted.get_analysis(request['runId'], started['analysisId']) == completed
        assert restarted.dispatch('POST', HOSTED_API + 'finalize-missing-measurements', request)['analysisId'] == started['analysisId']
        assert restarted.dispatch('GET', HOSTED_API + 'series/' + series_id)['runIds'] == ['earlier-pending', 'completed-one']
        with pytest.raises(AppError, match='requestId'):
            restarted.dispatch('POST', HOSTED_API + 'finalize-missing-measurements', {**request, 'reason': 'Different reason.'})
    finally:
        restarted.close()


@pytest.mark.parametrize('reason', ['', '   ', None, 23, [], {}, 'x' * 2001])
def test_invalid_reason_leaves_no_new_analysis(tmp_path, reason):
    application = imported_application(tmp_path)
    try:
        before = application.get_run('tree-1')['analyses']
        with pytest.raises(AppError, match='reason|Reason'):
            finalize(application, 'tree-1', reason=reason)
        assert application.get_run('tree-1')['analyses'] == before
    finally:
        application.close()


def test_finalization_rejects_extra_provenance_supplied_by_the_client(tmp_path):
    application = imported_application(tmp_path)
    try:
        with pytest.raises(AppError, match='request|field'):
            application.dispatch('POST', HOSTED_API + 'finalize-missing-measurements', {
                'requestId': 'invented-provenance', 'runId': 'tree-1', 'profileId': 'tree-development-1',
                'reason': 'Lost.', 'recordedAtMs': 1, 'bundleSha256': 'a' * 64})
        assert application.get_run('tree-1')['analyses'] == {}
    finally:
        application.close()


def test_finalization_rejects_available_camera_and_active_publication(tmp_path):
    application, series_id, inventory = scored_application(tmp_path)
    entered, release = threading.Event(), threading.Event()
    def blocked_inventory(*arguments):
        entered.set()
        assert release.wait(10)
        return {'inventory': inventory, 'previousPublicationId': None}
    try:
        before = len(application.get_run('completed-one')['analyses'])
        with pytest.raises(AppError, match='available|original'):
            finalize(application, 'completed-one')
        assert len(application.get_run('completed-one')['analyses']) == before
        application.publication_inventory_reader = blocked_inventory
        job = application.dispatch('POST', HOSTED_API + 'publication/prepare', {
            'requestId': 'prepare-blocked', 'seriesId': series_id, 'environment': 'test', 'softwareTest': True})
        assert entered.wait(2)
        with pytest.raises(AppError, match='publication'):
            finalize(application, 'later-pending')
        release.set()
        assert wait_publication(application, job['jobId'], {'prepared', 'failed'})['status'] == 'prepared'
    finally:
        release.set()
        application.close()


def test_unverified_assignments_are_retained_and_keep_scored_series_unqualified(tmp_path):
    application, series_id, _ = scored_application(tmp_path, pending_first=True)
    try:
        bundle = json.loads((tmp_path / 'earlier-pending.json').read_text())
        bundle['bundleRevision'] = 2
        bundle['tickets'][0]['verification'] = {'status': 'pending'}
        application.import_run_bundle(write_bundle(tmp_path / 'unverified.json', bundle))
        artifact, _ = finalize(application, 'earlier-pending')
        assert artifact['status'] == 'completed'
        assert len(artifact['result']['targets']) == 2
        assert artifact['result']['randomizationStatus'] == 'unverified'
        series = application.dispatch('GET', HOSTED_API + 'series/' + series_id)
        assert series['runIds'] == []
        assert 'randomization_unverified' in series['qualificationReasons']
    finally:
        application.close()


@pytest.mark.parametrize('duration', [.4, 2.4, 15.25])
def test_saved_fractional_durations_are_exact_and_unknown_not_zero(tmp_path, duration):
    application = imported_application(tmp_path, tree_bundle(response=duration))
    try:
        artifact, _ = finalize(application, 'tree-1')
        bins = artifact['result']['targets'][0]['bins']
        assert [item['duration'] for item in bins] == [min(1., duration - index) for index in range(len(bins))]
        assert artifact['result']['settings']['responseSeconds'] == duration
        assert all(item['rawA'] is None and item['rawB'] is None for item in bins)
        assert artifact['result']['calculation']['streams']['-1']['bounded_missing_targets'] == 2
    finally:
        application.close()


def test_registered_start_without_generated_assignments_stays_outside_collected_statistics(tmp_path):
    original, series_id, _ = scored_application(tmp_path, pending_first=True)
    analyzer = original.hosted_analyzer
    original.close()
    series = json.loads((tmp_path / 'series.json').read_bytes())
    series['members'][0]['collectionStartedAtMs'] = None
    series['collectionRunIds'] = ['completed-one']
    (tmp_path / 'never-generated-series.json').write_text(json.dumps(series))
    bundle = json.loads((tmp_path / 'earlier-pending.json').read_text())
    bundle['tickets'] = []
    bundle['cues'] = []
    bundle['events'] = [event for event in bundle['events'] if event['kind'] not in ('assignmentRecorded', 'cuePlayed')]
    for sequence, event in enumerate(bundle['events'], 1):
        event['sequence'] = sequence
    application = StudyApplication(tmp_path / 'zero-data', hosted_analyzer=analyzer)
    try:
        application.import_collection_bundle(tmp_path / 'never-generated-series.json')
        application.import_run_bundle(write_bundle(tmp_path / 'never-generated.json', bundle))
        application.import_run_bundle(tmp_path / 'completed-one.json')
        camera = application.import_recording('completed-one', tmp_path / 'camera.avi', 'video')
        application.save_obstruction_review('completed-one', camera['recordingId'], 'clear', [])
        started = application.start_analysis('completed-one', 'tree-development-1')
        assert wait_result(application, 'completed-one', started['analysisId'])['status'] == 'completed'
        artifact, _ = finalize(application, 'earlier-pending')
        assert artifact['result']['targets'] == []
        assert artifact['result']['collectionStartedAtMs'] is None
        assert artifact['result']['calculation']['streams'] == {}
        selected = application.dispatch('GET', HOSTED_API + 'series/' + series_id)
        assert selected['inventoryRunIds'] == ['earlier-pending', 'completed-one']
        assert selected['runIds'] == ['completed-one']
        assert selected['runCount'] == 1 and selected['targetCount'] == 2
    finally:
        application.close()


def test_lost_imported_original_keeps_partial_measurements_raw_predictors_and_prior_bytes(tmp_path):
    pairs = measured_pairs()
    for pair in pairs['pairs']:
        if 3 <= pair['start'] < 4:
            pair.update(A_speed=None, B_speed=None, quality_reasons=['frame_gap'])
    def analyzer(bundle, originals, profile):
        return analyze_extracted_run(bundle, pairs, profile, recording())
    application = imported_application(tmp_path, analyzer=analyzer)
    try:
        camera = application.import_recording('tree-1', movie(tmp_path / 'original.avi'), 'video')
        application.save_obstruction_review('tree-1', camera['recordingId'], 'clear', [])
        started = application.start_analysis('tree-1', 'tree-development-1')
        prior = wait_result(application, 'tree-1', started['analysisId'])
        assert prior['status'] == 'completed'
        original_entry = application.get_run('tree-1')['analyses'][started['analysisId']]
        original_path = application._hosted_directory('tree-1') / original_entry['outputPath']
        original_bytes = original_path.read_bytes()
        recording_id, record = remove_camera(application, 'tree-1')
        artifact, _ = finalize(application, 'tree-1')
        result = artifact['result']
        for field in ('measurements', 'rawPredictions', 'targets', 'calculation', 'regional', 'timeline'):
            assert result[field] == prior['result'][field]
        assert result['targets'][0]['bins'][0]['usable']
        assert not result['targets'][0]['bins'][1]['usable']
        assert artifact['inputHashes'] == result['inputHashes'] == {}
        disposition = result['measurementDisposition']
        assert disposition['retainedAnalysis']['analysisId'] == started['analysisId']
        assert disposition['retainedAnalysis']['sha256'] == hashlib.sha256(original_bytes).hexdigest()
        assert disposition['missingRecordings'][0]['recordingId'] == recording_id
        assert disposition['missingRecordings'][0]['sha256'] == record['sha256']
        assert disposition['videoExtractionRepeatable'] is False
        assert original_path.read_bytes() == original_bytes
        assert any('original' in text.lower() and 'repeat' in text.lower() for text in artifact['displayReport']['narrative'])
    finally:
        application.close()


@pytest.mark.parametrize('change', ['artifact', 'bundle', 'profile'])
def test_retained_measurements_must_match_unchanged_bundle_profile_and_artifact(tmp_path, change):
    application, _, _ = scored_application(tmp_path)
    try:
        run_id = 'completed-one'
        manifest = application.get_run(run_id)
        prior_id = application.series_store.state['runs'][run_id]['selectedRevision']
        if change == 'artifact':
            entry = manifest['analyses'][prior_id]
            (application._hosted_directory(run_id) / entry['outputPath']).write_bytes(b'changed')
        elif change == 'bundle':
            bundle = json.loads((tmp_path / (run_id + '.json')).read_bytes())
            bundle['bundleRevision'] = 2
            bundle['events'].append({**bundle['events'][-1], 'kind': 'incident', 'serverAtMs': 11000,
                'sequence': len(bundle['events']) + 1, 'data': {'reason': 'Added source record'}})
            application.import_run_bundle(write_bundle(tmp_path / 'new-bundle.json', bundle))
        remove_camera(application, run_id)
        before = len(application.get_run(run_id)['analyses'])
        with pytest.raises(AppError, match='changed|match|profile|artifact|bundle'):
            finalize(application, run_id, profile_id='tree-development-area-1' if change == 'profile' else 'tree-development-1')
        assert len(application.get_run(run_id)['analyses']) == before
    finally:
        application.close()


def test_recovered_original_creates_and_selects_a_new_revision_without_erasing_missing_revision(tmp_path):
    application, series_id, _ = scored_application(tmp_path, pending_first=True)
    try:
        missing, _ = finalize(application, 'earlier-pending')
        entry = application.get_run('earlier-pending')['analyses'][missing['analysisId']]
        path = application._hosted_directory('earlier-pending') / entry['outputPath']
        retained = path.read_bytes()
        camera = application.import_recording('earlier-pending', movie(tmp_path / 'recovered.avi'), 'video')
        application.save_obstruction_review('earlier-pending', camera['recordingId'], 'clear', [])
        recovered = application.start_analysis('earlier-pending', 'tree-development-1')
        assert wait_result(application, 'earlier-pending', recovered['analysisId'])['status'] == 'completed'
        before = application.dispatch('GET', HOSTED_API + 'series/' + series_id)
        assert before['selectedRevisions'][0] == missing['analysisId']
        after = application.dispatch('POST', HOSTED_API + 'select-revision', {
            'requestId': 'select-recovered', 'runId': 'earlier-pending', 'analysisId': recovered['analysisId']})
        assert after['selectedRevisions'][0] == recovered['analysisId']
        assert after['runIds'] == before['runIds'] and after['targetCount'] == before['targetCount']
        assert path.read_bytes() == retained
    finally:
        application.close()


def test_reimporting_a_lost_previously_imported_original_restores_normal_analysis_and_revision_selection(tmp_path):
    application, series_id, _ = scored_application(tmp_path)
    try:
        recording_id, record = remove_camera(application, 'completed-one')
        missing, _ = finalize(application, 'completed-one')
        missing_entry = application.get_run('completed-one')['analyses'][missing['analysisId']]
        missing_path = application._hosted_directory('completed-one') / missing_entry['outputPath']
        missing_bytes = missing_path.read_bytes()
        application.dispatch('POST', HOSTED_API + 'select-revision', {
            'requestId': 'select-missing', 'runId': 'completed-one', 'analysisId': missing['analysisId']})
        before = application.dispatch('GET', HOSTED_API + 'series/' + series_id)
        recovered = application.import_recording('completed-one', tmp_path / 'camera.avi', 'video')
        assert recovered['recordingId'] == recording_id
        for field in ('clockMap', 'obstructionReviewId', 'timelineSha256'):
            assert recovered[field] == record[field]
        application.save_obstruction_review('completed-one', recovered['recordingId'], 'clear', [])
        started = application.start_analysis('completed-one', 'tree-development-1')
        artifact = wait_result(application, 'completed-one', started['analysisId'])
        assert artifact['status'] == 'completed', artifact
        assert artifact['inputHashes'][recovered['recordingId']] == record['sha256']
        assert 'measurementDisposition' not in artifact['result']
        selected = application.dispatch('POST', HOSTED_API + 'select-revision', {
            'requestId': 'select-restored', 'runId': 'completed-one', 'analysisId': started['analysisId']})
        assert selected['selectedRevisions'][0] == started['analysisId']
        assert selected['runIds'] == before['runIds'] and selected['targetCount'] == before['targetCount']
        assert application.get_run('completed-one')['recordings'][recording_id]['available'] is True
        assert missing_path.read_bytes() == missing_bytes
    finally:
        application.close()


def test_later_unselected_original_analysis_survives_repeated_loss_and_restart(tmp_path, monkeypatch):
    import study_app
    application, series_id, _ = scored_application(tmp_path, pending_first=True)
    # Later UUIDs sort before earlier ones; completion order must survive JSON persistence.
    identifiers = itertools.count(1)
    monkeypatch.setattr(study_app, '_identifier', lambda: f'{1000 - next(identifiers):032x}')
    try:
        first, _ = finalize(application, 'earlier-pending', request_id='first-loss')
        camera = application.import_recording('earlier-pending', movie(tmp_path / 'recovered.avi'), 'video')
        application.save_obstruction_review('earlier-pending', camera['recordingId'], 'clear', [])
        started = application.start_analysis('earlier-pending', 'tree-development-1')
        measured = wait_result(application, 'earlier-pending', started['analysisId'])
        assert measured['status'] == 'completed'
        assert any(item['usable'] for target in measured['result']['targets'] for item in target['bins'])
        before = application.dispatch('GET', HOSTED_API + 'series/' + series_id)
        assert before['selectedRevisions'][0] == first['analysisId']
        manifest = application.get_run('earlier-pending')
        retained_paths = {identifier: application._hosted_directory('earlier-pending') / manifest['analyses'][identifier]['outputPath']
                          for identifier in (first['analysisId'], measured['analysisId'])}
        retained_bytes = {identifier: path.read_bytes() for identifier, path in retained_paths.items()}
        remove_camera(application, 'earlier-pending')
        data = application.directory
    finally:
        application.close()
    restarted = StudyApplication(data)
    try:
        second, _ = finalize(restarted, 'earlier-pending', request_id='second-loss')
        reference = second['result']['measurementDisposition']['retainedAnalysis']
        assert reference == {'analysisId': measured['analysisId'],
                             'sha256': hashlib.sha256(retained_bytes[measured['analysisId']]).hexdigest()}
        for field in ('measurements', 'rawPredictions', 'targets', 'calculation', 'regional', 'timeline'):
            assert second['result'][field] == measured['result'][field]
        assert second['inputHashes'] == second['result']['inputHashes'] == {}
        unselected = restarted.dispatch('GET', HOSTED_API + 'series/' + series_id)
        assert unselected['selectedRevisions'] == before['selectedRevisions']
        selected = restarted.dispatch('POST', HOSTED_API + 'select-revision', {
            'requestId': 'select-second-loss', 'runId': 'earlier-pending', 'analysisId': second['analysisId']})
        assert selected['selectedRevisions'][0] == second['analysisId']
        assert selected['runIds'] == before['runIds'] and selected['targetCount'] == before['targetCount']
        assert all(path.read_bytes() == retained_bytes[identifier] for identifier, path in retained_paths.items())
    finally:
        restarted.close()


def test_publication_seals_missing_disposition_and_retained_measurements_and_reproduces_from_downloaded_source(publication_rehearsal, tmp_path):
    from tree_publication import prepare_publication
    from tree_publication_reproduction import extract_source_package
    fixture = publication_rehearsal
    data = tmp_path / 'data'
    shutil.copytree(fixture['data'], data)
    application = StudyApplication(data)
    try:
        application.import_run_bundle(Path(fixture['manifest']).parent / 'pending-collected.json')
        no_camera, _ = finalize(application, 'pending-collected')
        recording_id, missing_record = remove_camera(application, 'completed-one')
        surviving, _ = finalize(application, 'completed-one', request_id='retain-surviving', reason='The imported original is lost; derived measurements survive.')
        application.dispatch('POST', HOSTED_API + 'select-revision', {
            'requestId': 'select-loss', 'runId': 'completed-one', 'analysisId': surviving['analysisId']})
        accumulated = application.dispatch('GET', HOSTED_API + 'series/' + fixture['seriesId'])
        assert accumulated['runIds'] == ['completed-one', 'pending-collected', 'missing-stopped']
        inventory = json.loads(Path(fixture['inventory']).read_text())['inventory']
        job = prepare_publication(application, fixture['seriesId'], 'test', inventory=inventory, software_test=True)
        downloads = tmp_path / 'downloads'
        downloads.mkdir()
        for identity, path in job['localFiles'].items():
            shutil.copyfile(path, downloads / identity)
        selected = {entry['runId']: entry for entry in job['manifest']['includedAnalyses']}
        for run_id in ('completed-one', 'pending-collected'):
            entry = selected[run_id]
            assert entry['videos'] == []
            inputs = json.loads((downloads / entry['reproductionInputsSha256']).read_bytes())
            declaration = json.loads((downloads / inputs['measurementDispositionSha256']).read_bytes())
            assert declaration['reason'] == (surviving if run_id == 'completed-one' else no_camera)['result']['measurementDisposition']['reason']
            assert inputs['measurementDispositionSha256'] in entry['inputSha256s']
            assert 'measurementDispositionSha256' in entry
        inputs = json.loads((downloads / selected['completed-one']['reproductionInputsSha256']).read_bytes())
        assert inputs['retainedAnalysisSha256'] in selected['completed-one']['inputSha256s']
        disposition = json.loads((downloads / inputs['measurementDispositionSha256']).read_bytes())
        assert disposition['missingRecordings'][0]['recordingId'] == recording_id
        assert disposition['missingRecordings'][0]['sha256'] == missing_record['sha256']
        assert missing_record['sha256'] not in job['manifest']['files']
        source = tmp_path / 'source'
        extract_source_package(downloads / job['manifest']['sourceReleases']['accumulation']['packageSha256'], source)
        reproduced = subprocess.run([sys.executable, '-I', str(source / 'scripts/reproduce-publication.py'),
            '--publication', job['manifestPath'], '--files', str(downloads), '--output', str(tmp_path / 'reproduction')],
            cwd=source, capture_output=True, text=True)
        assert reproduced.returncode == 0, reproduced.stderr
        summary = json.loads(reproduced.stdout)
        assert summary['comparison']['matched'] is True
        rebuilt = json.loads((tmp_path / 'reproduction/accumulated-result.json').read_bytes())
        for key in ('targetCount', 'full', 'logEvidence', 'selectedRevisions', 'runIds'):
            assert rebuilt[key] == accumulated[key]
        from tree_publication_reproduction import reproduce_publication
        for field in ('measurementDispositionSha256', 'retainedAnalysisSha256'):
            changed = tmp_path / field
            shutil.copytree(downloads, changed)
            (changed / inputs[field]).write_bytes(b'changed')
            with pytest.raises(ValueError, match='changed'):
                reproduce_publication(job['manifestPath'], changed, tmp_path / (field + '-reproduction'))
    finally:
        application.close()
