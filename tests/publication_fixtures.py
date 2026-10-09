"""Scored software-test records built independently of preparation data."""
import hashlib
import json
import subprocess
from pathlib import Path

from study_app import StudyApplication
from study_profiles import development_profile
from study_analysis import analyze_extracted_run
from tree_fixtures import tree_bundle, write_bundle
from test_tree_analysis import measured_pairs, recording
from test_tree_api import movie, wait_result


def fixture_source_checkpoint():
    package = Path(__file__).parents[1]
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=package, capture_output=True, text=True)
    if result.returncode == 0: return result.stdout.strip()
    inventory = package / 'source-inventory.json'
    if inventory.is_file(): return json.loads(inventory.read_text())['contentSha256']
    raise ValueError('The software fixture needs Git or an exact extracted source inventory.')


def scored_application(directory, *, missing=False, pending_first=False, purpose='scored'):
    series_id = 'software-test-scored-series'
    profile = development_profile()
    config = {'version': 'tree-targeting-3', 'experimentSlug': 'tree-targeting', 'mode': 'tree',
              'purpose': purpose, 'seriesId': series_id, 'analysisProfileId': profile['profileId'],
              'tree': {'preRollSeconds': 1, 'postRollSeconds': 1, 'responseSeconds': 2,
                       'recoverySeconds': 0, 'announceRelease': False, 'count': 2}}
    sealed = json.dumps(config, separators=(',', ':'))
    sealed_profile = json.dumps(profile, separators=(',', ':'))
    source = fixture_source_checkpoint()
    members, bundles = [], []
    names = ['earlier-pending', 'completed-one'] if pending_first else ['completed-one', 'later-pending']
    for index, name in enumerate(names):
        bundle = tree_bundle(name, slug='tree-targeting', config=config, profile=profile)
        bundle['codeCheckpoint'] = source
        bundle['state'].update(createdAtMs=1000 + index * 10000, recordingStartedAtMs=1500 + index * 10000)
        for event in bundle['events']: event['serverAtMs'] += index * 10000
        for cue in bundle['cues']:
            for key in ('dueAtMs', 'issuedAtMs', 'playedAtMs'): cue[key] += index * 10000
        for ticket in bundle['tickets']: ticket['verification'] = {'status': 'verified', 'response': {'result': {'authenticity': True}}}
        if missing:
            for cue in bundle['cues']: cue.update(playedAtMs=None, deliveryStatus='failed')
        bundles.append(bundle)
        members.append({'runId': name, 'createdAtMs': bundle['state']['createdAtMs'],
                        'collectionStartedAtMs': 2000 + index * 10000,
                        'configHash': bundle['configHash'], 'profileHash': bundle['profileHash'], 'codeCheckpoint': source})
    series = {'experimentSlug': 'tree-targeting', 'seriesId': series_id, 'label': 'Software test only',
              'status': 'frozen', 'createdAtMs': 1000, 'codeCheckpoint': source, 'config': config,
              'sealedConfigJson': sealed, 'configHash': hashlib.sha256(sealed.encode()).hexdigest(),
              'profile': profile, 'sealedProfileJson': sealed_profile, 'profileHash': hashlib.sha256(sealed_profile.encode()).hexdigest(),
              'members': members, 'runIds': names, 'collectionRunIds': names}
    def analyzer(bundle, originals, selected_profile):
        record = {**recording(), 'sha256': next(item['sha256'] for item in originals.values() if item['kind'] == 'video')}
        return analyze_extracted_run(bundle, measured_pairs(50), selected_profile, record)
    application = StudyApplication(directory / 'data', hosted_analyzer=analyzer)
    series_path = directory / 'series.json'
    series_path.write_text(json.dumps(series))
    application.import_collection_bundle(series_path)
    for bundle in bundles:
        application.import_run_bundle(write_bundle(directory / (bundle['runId'] + '.json'), bundle))
    imported = application.import_recording('completed-one', movie(directory / 'camera.avi'), 'video')
    application.save_obstruction_review('completed-one', imported['recordingId'], 'clear', [])
    analysis = application.start_analysis('completed-one', profile['profileId'])
    wait_result(application, 'completed-one', analysis['analysisId'])
    inventory = [{**member, 'tag': name, 'lifecycle': 'completed', 'recordingStartedAtMs': 1500 + index * 10000,
                  'finishedAtMs': 10000 + index * 10000} for index, (name, member) in enumerate(zip(names, members))]
    return application, series_id, inventory
