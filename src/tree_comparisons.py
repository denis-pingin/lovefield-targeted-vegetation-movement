"""Immutable preparation snapshots of two analyses over one recording inventory."""
import copy
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path

from study_profiles import METHOD, validate_profile
from tree_series import accumulate_series


def _profile(record):
    if not isinstance(record, dict) or not isinstance(record.get('sealedProfileJson'), str):
        raise ValueError('Select an exact saved analysis profile')
    sealed = record['sealedProfileJson'].encode('utf-8')
    if hashlib.sha256(sealed).hexdigest() != record.get('sha256') or json.loads(sealed) != record.get('profile'):
        raise ValueError('The selected profile bytes or hash changed')
    validate_profile(record['profile'])
    return record


def _target_identity(result):
    return [{key: target.get(key) for key in ('targetIndex', 'trialId', 'ticketId', 'assignedRegion',
                                             'generatedAtMs', 'playbackAtMs', 'responseSeconds')} |
            {'bins': [(item.get('startSeconds'), item.get('duration')) for item in target['bins']]}
            for target in result['targets']]


def _individual(result, profile):
    report = accumulate_series([result], profile)
    return {'effect': report['full']['estimate'], 'confidenceRange': report['full']['confidenceRange'],
            'evidence': report['evidenceLabel'], 'logEvidence': report['logEvidence'],
            'usableBinCount': report['usableBinCount'], 'missingBinCount': report['missingBinCount'],
            'targetCount': report['targetCount'], 'revisionId': result['revisionId']}


def _matches_profile(artifact, profile):
    return (artifact.get('profileSha256') == profile['sha256'] and
            artifact.get('profileId') == profile['profile']['profileId'] and
            artifact['result'].get('profileHash') == profile['sha256'])


class ComparisonStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._list_cache = None

    def create(self, label, left_profile, right_profile, rows):
        if not isinstance(label, str) or not label.strip():
            raise ValueError('Enter a comparison name')
        if not isinstance(rows, list) or not rows:
            raise ValueError('Select at least one recording for comparison')
        left_profile, right_profile = _profile(left_profile), _profile(right_profile)
        if left_profile['sha256'] == right_profile['sha256']:
            raise ValueError('Choose two distinct saved profiles')
        seen_runs, seen_analyses, inventory, left_results, right_results = set(), set(), [], [], []
        stopped = False
        for row in rows:
            run_id = row.get('runId') if isinstance(row, dict) else None
            if not isinstance(run_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', run_id):
                raise ValueError('Select a valid recording identity')
            if run_id in seen_runs:
                raise ValueError('A recording may appear only once in the comparison')
            seen_runs.add(run_id)
            sides = {side: row.get(side) for side in ('left', 'right')}
            for side, artifact in sides.items():
                if artifact is None:
                    continue
                if artifact.get('runId') != run_id:
                    raise ValueError('The selected analysis belongs to another recording')
                analysis_id = artifact.get('analysisId')
                if not isinstance(analysis_id, str) or analysis_id in seen_analyses:
                    raise ValueError('A selected analysis revision is duplicate or invalid')
                seen_analyses.add(analysis_id)
                if artifact.get('result', {}).get('purpose') not in (None, 'preparation'):
                    raise ValueError('Method comparisons are preparation-only; scored analyses cannot be included')
            left, right = sides['left'], sides['right']
            if left is None:
                status = 'missing_left'
            elif right is None:
                status = 'missing_right'
            elif left.get('status') != 'completed':
                status = 'unavailable_left'
            elif right.get('status') != 'completed':
                status = 'unavailable_right'
            elif any(left.get(key) != right.get(key) for key in ('bundleSha256', 'inputHashes', 'derivedInputHashes')):
                status = 'source_mismatch'
            elif _target_identity(left['result']) != _target_identity(right['result']):
                status = 'target_mismatch'
            elif not _matches_profile(left, left_profile) or not _matches_profile(right, right_profile):
                status = 'profile_mismatch'
            elif any(artifact['result'].get('analysisVersion') != METHOD for artifact in (left, right)):
                status = 'statistical_version_mismatch'
            else:
                status = 'paired'
            entry = {'runId': run_id, 'status': status,
                     'tag': row.get('tag'), 'createdAtMs': row.get('createdAtMs'),
                     'recordingStartedAtMs': row.get('recordingStartedAtMs'),
                     'leftAnalysisId': left.get('analysisId') if left else None,
                     'rightAnalysisId': right.get('analysisId') if right else None,
                     'leftProfileSha256': left.get('profileSha256') if left else None,
                     'rightProfileSha256': right.get('profileSha256') if right else None,
                     'leftBundleSha256': left.get('bundleSha256') if left else None,
                     'rightBundleSha256': right.get('bundleSha256') if right else None,
                     'leftInputHashes': copy.deepcopy(left.get('inputHashes')) if left else None,
                     'rightInputHashes': copy.deepcopy(right.get('inputHashes')) if right else None,
                     'leftDerivedInputHashes': copy.deepcopy(left.get('derivedInputHashes')) if left else None,
                     'rightDerivedInputHashes': copy.deepcopy(right.get('derivedInputHashes')) if right else None,
                     'leftCodeSha256': left.get('codeSha256') if left else None,
                     'rightCodeSha256': right.get('codeSha256') if right else None}
            for side, artifact, profile in (('left', left, left_profile), ('right', right, right_profile)):
                if (artifact is not None and artifact.get('status') == 'completed' and
                    _matches_profile(artifact, profile) and artifact['result'].get('analysisVersion') == METHOD):
                    entry[f'{side}Individual'] = _individual(artifact['result'], profile['profile'])
            if status == 'paired':
                if not stopped:
                    left_results.append(left['result'])
                    right_results.append(right['result'])
            else:
                stopped = True
            inventory.append(entry)
        left_report = accumulate_series(left_results, left_profile['profile'])
        right_report = accumulate_series(right_results, right_profile['profile'])
        if [entry['runId'] for entry in inventory[:len(left_results)]] != left_report['runIds'] or left_report['runIds'] != right_report['runIds']:
            raise ValueError('The compared accumulations must share one chronological prefix')
        identifier = uuid.uuid4().hex
        value = {'comparisonId': identifier, 'label': label.strip(), 'createdAtMs': int(time.time() * 1000),
                 'purpose': 'preparation', 'leftProfile': copy.deepcopy(left_profile),
                 'rightProfile': copy.deepcopy(right_profile), 'rows': inventory,
                 'commonPrefixRunIds': left_report['runIds'], 'left': left_report, 'right': right_report}
        with (self.directory / f'{identifier}.json').open('x', encoding='utf-8') as output:
            json.dump(value, output, sort_keys=True, separators=(',', ':'), allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        self._list_cache = None
        return value

    def get(self, comparison_id):
        if not isinstance(comparison_id, str) or not re.fullmatch(r'[a-f0-9]{32}', comparison_id):
            raise ValueError('Choose a valid saved comparison')
        return json.loads((self.directory / f'{comparison_id}.json').read_text())

    def list(self):
        if self._list_cache is not None:
            return copy.deepcopy(self._list_cache)
        values = []
        for path in self.directory.glob('*.json'):
            if not re.fullmatch(r'[a-f0-9]{32}', path.stem):
                continue
            saved = self.get(path.stem)
            values.append({'comparisonId': saved['comparisonId'], 'label': saved['label'],
                           'createdAtMs': saved['createdAtMs'],
                           'commonPrefixRunIds': saved['commonPrefixRunIds'],
                           'rowCount': len(saved['rows'])})
        self._list_cache = sorted(values, key=lambda item: (item['createdAtMs'], item['comparisonId']), reverse=True)
        return copy.deepcopy(self._list_cache)
