"""Explicit missing-measurement finalization using the retained scientific engine."""
import copy
import hashlib
import json
import math
import re

from study_analysis import analyze_extracted_run, generated_assignments
from study_profiles import METHOD, validate_profile
from tree_calculator import Series
from tree_series import calculation_targets

HASH = re.compile(r'[a-f0-9]{64}\Z')


def missing_measurement_reason(reason):
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 2000:
        raise ValueError('A missing-measurement reason must be nonblank text of at most 2,000 characters.')
    return reason.strip()


def validate_measurement_disposition(disposition, bundle, bundle_sha256, profile_sha256):
    fields = {'schemaVersion', 'kind', 'runId', 'reason', 'recordedAtMs', 'bundleSha256',
              'profileSha256', 'collectionStartedAtMs', 'missingRecordings', 'retainedAnalysis',
              'videoExtractionRepeatable'}
    if not isinstance(disposition, dict) or set(disposition) != fields or (
        disposition['schemaVersion'] != 1 or disposition['kind'] != 'video_recording_missing' or
        disposition['runId'] != bundle['runId'] or disposition['bundleSha256'] != bundle_sha256 or
        disposition['profileSha256'] != profile_sha256 or disposition['videoExtractionRepeatable'] is not False
    ):
        raise ValueError('The missing-measurement disposition differs from its run, bundle or profile identity.')
    if missing_measurement_reason(disposition['reason']) != disposition['reason']:
        raise ValueError('The retained missing-measurement reason changed.')
    if type(disposition['recordedAtMs']) is not int or disposition['recordedAtMs'] < 0:
        raise ValueError('The disposition needs its server-recorded time.')
    collected = disposition['collectionStartedAtMs']
    if collected is not None and (type(collected) not in (int, float) or not math.isfinite(collected) or
                                  collected < bundle['state']['createdAtMs']):
        raise ValueError('The disposition collection time differs from its saved run.')
    missing = disposition['missingRecordings']
    if not isinstance(missing, list):
        raise ValueError('The disposition needs its known missing recording identities.')
    seen = set()
    for record in missing:
        if not isinstance(record, dict) or set(record) != {'recordingId', 'kind', 'name', 'sha256', 'sizeBytes'} or (
            not isinstance(record['recordingId'], str) or not record['recordingId'] or
            record['recordingId'] in seen or record['kind'] not in ('video', 'setupImage') or
            not isinstance(record['name'], str) or not record['name'] or
            not isinstance(record['sha256'], str) or not HASH.fullmatch(record['sha256']) or
            type(record['sizeBytes']) is not int or record['sizeBytes'] < 0
        ):
            raise ValueError('A known missing recording identity changed.')
        seen.add(record['recordingId'])
    retained = disposition['retainedAnalysis']
    if retained is not None and (not isinstance(retained, dict) or set(retained) != {'analysisId', 'sha256'} or
                                 not isinstance(retained['analysisId'], str) or not retained['analysisId'] or
                                 not isinstance(retained['sha256'], str) or not HASH.fullmatch(retained['sha256'])):
        raise ValueError('The retained measurement analysis identity changed.')
    return disposition


def analyze_missing_measurements(bundle, profile, disposition, *, bundle_sha256, profile_sha256,
                                 input_hashes=None, retained_artifact=None, retained_sha256=None):
    """Repeat bounded calculation from no measurements or verified surviving derived inputs."""
    profile = validate_profile(profile)
    validate_measurement_disposition(disposition, bundle, bundle_sha256, profile_sha256)
    generated = generated_assignments(bundle)
    reference = disposition['retainedAnalysis']
    if reference is None:
        if retained_artifact is not None or retained_sha256 is not None:
            raise ValueError('Undeclared retained measurement inputs cannot enter the analysis.')
        result = analyze_extracted_run(bundle, {'pairs': [], 'shake_spans': []}, profile, {},
                                       quality_reasons=['video_recording_missing'])
    else:
        retained = retained_artifact
        if not isinstance(retained, dict) or retained_sha256 != reference['sha256'] or (
            retained.get('analysisId') != reference['analysisId'] or retained.get('runId') != bundle['runId'] or
            retained.get('status') != 'completed' or retained.get('bundleSha256') != bundle_sha256 or
            retained.get('profileSha256') != profile_sha256
        ):
            raise ValueError('The retained measurement artifact does not match its run, bundle or profile.')
        sealed = retained.get('sealedProfileJson')
        if not isinstance(sealed, str) or hashlib.sha256(sealed.encode()).hexdigest() != profile_sha256 or json.loads(sealed) != profile:
            raise ValueError('The retained measurement profile changed.')
        result = copy.deepcopy(retained.get('result'))
        if not isinstance(result, dict) or result.get('runId') != bundle['runId'] or (
            result.get('revisionId') != reference['analysisId'] or result.get('analysisVersion') != METHOD or
            result.get('profile') != profile or result.get('profileHash') != profile_sha256 or
            result.get('configHash') != bundle['configHash'] or result.get('settings') != bundle['config']['tree'] or
            result.get('collectionProfileHash') != bundle['profileHash'] or
            not isinstance(result.get('measurements'), dict) or len(result.get('targets', [])) != len(generated)
        ):
            raise ValueError('The surviving measurements differ from the saved run and analysis settings.')
        for target, expected in zip(result['targets'], generated):
            if any(target.get(key) != value for key, value in expected.items()):
                raise ValueError('A retained measurement target differs from its generated assignment.')
            durations = [min(1., bundle['config']['tree']['responseSeconds'] - index)
                         for index in range(math.ceil(bundle['config']['tree']['responseSeconds']))]
            if [item['duration'] for item in target['bins']] != durations:
                raise ValueError('The retained measurement response durations changed.')
        calculation = Series()
        predictions = calculation_targets(calculation, result)
        if predictions != result.get('rawPredictions') or calculation.result() != result.get('calculation'):
            raise ValueError('The retained raw prediction sequence or bounded calculation changed.')
        result.pop('report', None)
        result.pop('revisionId', None)
        result['qualityReasons'] = sorted(set(result['qualityReasons']) | {'video_recording_missing'})
    if not generated:
        result['collectionStartedAtMs'] = disposition['collectionStartedAtMs']
        result['randomizationStatus'] = 'verified'
    result['inputHashes'] = copy.deepcopy(input_hashes or {})
    result['measurementDisposition'] = copy.deepcopy(disposition)
    return result
