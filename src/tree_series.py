"""Chronological accumulation and immutable analysis revisions, using the reference."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import uuid

from study_profiles import METHOD, measurement_method, validate_profile
from tree_calculator import MotionBin, Series


def profile_hash(profile):
    return hashlib.sha256(json.dumps(profile, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def evidence_label(log_value):
    if abs(log_value) < 1e-14:
        return '1.00'
    if -6 < log_value < math.log(1e6):
        return f'{math.exp(log_value):.2f}'
    exponent = math.floor(log_value / math.log(10))
    coefficient = math.exp(log_value - exponent * math.log(10))
    return f'{coefficient:.3g} x 10^{exponent}'


def calculation_targets(series, run):
    predictions = []
    for target in run['targets']:
        bins = [MotionBin(item['duration'], item['a'], item['b'], item['usable'],
                          raw_motion=(item['rawA'], item['rawB'])) for item in target['bins']]
        if target['targetIndex'] == 0:
            prior = {key: 0. for key in [-1, *range(len(bins))]}
        else:
            prior = {key: stream.run_prediction_total / stream.run_prediction_count
                     if stream.run_prediction_count else 0. for key, stream in series.streams.items()}
        predictions.append({'targetIndex': target['targetIndex'], 'centers': {str(key): prior.get(key, 0.) for key in [-1, *range(len(bins))]},
                            'rawValues': [item.prediction_value() for item in bins],
                            'rawUnavailable': [any(value is None for value in item.raw_motion) for item in bins]})
        series.add_target(run['runId'], target['targetIndex'], int(target['assignedRegion'] == 'A'), bins)
    return predictions


def stream_view(index, stream):
    item = stream.result(.05 * Series.weight(index))
    return {**item, 'index': index, 'weight': Series.weight(index),
            'estimate': None if item['effect_estimate'] is None else 100 * item['effect_estimate'],
            'estimateBounds': [100 * value for value in item['effect_estimate_bounds']],
            'confidenceRange': [100 * value for value in item['simultaneous_confidence_interval']]}


def accumulate_series(runs, profile):
    """Resolve the supplied collection order; an unresolved earlier run holds its tail."""
    validate_profile(profile)
    series, accepted, pending, history, seen = Series(), [], [], [], set()
    maximum, crossing, stopped, scored_settings, measurement_family = 0., None, False, None, None
    qualification_reasons = set()
    purposes = {run.get('purpose', 'preparation') for run in runs}
    if len(purposes) > 1:
        raise ValueError('Preparation and scored histories must be separate')
    for run in runs:
        run_id = run['runId']
        if run_id in seen:
            raise ValueError('A run can contribute only once; select one analysis revision')
        seen.add(run_id)
        if run.get('purpose') == 'scored' and run.get('randomizationStatus') != 'verified':
            qualification_reasons.add('randomization_unverified')
            pending.append(run_id)
            stopped = True
            continue
        if stopped or run.get('status') not in ('completed', 'resolved_missing'):
            pending.append(run_id)
            stopped = True
            continue
        family = run.get('measurementMethod') or measurement_method(run.get('profile', profile))
        if measurement_family is None:
            measurement_family = family
        elif family != measurement_family:
            qualification_reasons.add('mixed_measurement_methods')
            pending.append(run_id)
            stopped = True
            continue
        if run.get('analysisVersion') != METHOD:
            raise ValueError('Do not pool different statistical method versions')
        if run.get('purpose') == 'scored':
            locked = (run.get('profileHash'), run.get('settings'))
            if scored_settings is None:
                scored_settings = locked
            elif scored_settings != locked:
                raise ValueError('Scored timing and profile settings are frozen across runs')
        calculation_targets(series, run)
        accepted.append(run)
        log_e = series.log_e()
        maximum = max(maximum, log_e)
        if crossing is None and log_e >= math.log(20):
            crossing = {'runId': run_id, 'runCount': len(accepted), 'logEvidence': log_e}
        full = stream_view(-1, series.streams[-1]) if -1 in series.streams else None
        history.append({'runId': run_id, 'revisionId': run.get('revisionId'),
                        'runCount': len(accepted), 'targetCount': sum(len(item['targets']) for item in accepted),
                        'logEvidence': log_e, 'evidenceLabel': evidence_label(log_e),
                        'maxLogEvidence': maximum, 'firstCrossing': crossing, 'full': full})
    bins = [item for run in accepted for target in run['targets'] for item in target['bins']]
    settings_groups = {}
    for run in accepted:
        key = json.dumps(run['settings'], sort_keys=True, separators=(',', ':'))
        settings_groups.setdefault(key, {'settings': run['settings'], 'runIds': [], 'targetCount': 0})
        settings_groups[key]['runIds'].append(run['runId'])
        settings_groups[key]['targetCount'] += len(run['targets'])
    elapsed = []
    for index in sorted(key for key in series.streams if key >= 0):
        item = stream_view(index, series.streams[index])
        item['durations'] = [target['bins'][index]['duration'] for run in accepted for target in run['targets'] if index < len(target['bins'])]
        item['runIds'] = [run['runId'] for run in accepted if any(index < len(target['bins']) for target in run['targets'])]
        elapsed.append(item)
    log_e = series.log_e()
    report = {'experimentSlug': 'tree-targeting', 'analysisVersion': METHOD,
              'profileHash': profile_hash(profile), 'profile': copy.deepcopy(profile),
              'status': 'incompatible_measurement' if 'mixed_measurement_methods' in qualification_reasons else 'incomplete_prefix' if pending else 'completed',
              'measurementMethod': measurement_family or measurement_method(profile),
              'action': 'Select compatible revisions or save a method comparison' if 'mixed_measurement_methods' in qualification_reasons else None,
              'purpose': next(iter(purposes), 'preparation'), 'runCount': len(accepted),
              'targetCount': sum(len(run['targets']) for run in accepted),
              'deliveredTargetCount': sum(target['playbackAtMs'] is not None for run in accepted for target in run['targets']),
              'usableBinCount': sum(item['usable'] for item in bins), 'missingBinCount': sum(not item['usable'] for item in bins),
              'pendingRuns': pending, 'selectedRevisions': [run.get('revisionId') for run in accepted],
              'runIds': [run['runId'] for run in accepted], 'settingsGroups': list(settings_groups.values()),
              'logEvidence': log_e, 'evidenceLabel': evidence_label(log_e),
              'maxLogEvidence': maximum, 'firstCrossing': crossing, 'threshold': 20,
              'thresholdReached': crossing is not None,
              'full': stream_view(-1, series.streams[-1]) if -1 in series.streams else {'targets': 0, 'estimate': None, 'estimateBounds': [-100, 100], 'confidenceRange': [-100, 100]},
              'elapsed': elapsed, 'history': history, 'calculation': series.result(),
              'runs': copy.deepcopy(accepted),
              'interpretationStatus': 'exploratory' if next(iter(purposes), 'preparation') == 'preparation' else 'unqualified' if pending else 'scored',
              'qualificationReasons': sorted(qualification_reasons),
              'missingReasons': sorted({reason for item in bins for reason in item['reasons']}),
              'randomizationStatus': 'verified' if accepted and all(run.get('randomizationStatus') == 'verified' for run in accepted) else 'unverified'}
    # No non-finite JSON values, including extremely large E.
    json.dumps(report, allow_nan=False)
    return report


class SeriesStore:
    """Append recording identities; select revisions without duplicating observations."""
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'series.json'
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {'runs': {}, 'version': 2}
        self.state.setdefault('manifests', {})

    def _save(self):
        temporary = self.path.with_name(f'{self.path.name}.{uuid.uuid4().hex}.tmp')
        with temporary.open('x') as output:
            json.dump(self.state, output, allow_nan=False, sort_keys=True, separators=(',', ':'))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.path)

    @staticmethod
    def _pending_run(run_id, created_at_ms, purpose, series_id, collection_started_at_ms):
        return {'runId': run_id, 'createdAtMs': created_at_ms, 'purpose': purpose, 'seriesId': series_id,
                'collectionStartedAtMs': collection_started_at_ms, 'status': 'pending',
                'revisions': [], 'selectedRevision': None}

    @staticmethod
    def _check_member(run, member):
        if run['createdAtMs'] != member['createdAtMs']:
            raise ValueError('A series member cannot change its recording creation time')
        if run.get('collectionStartedAtMs') is not None and member['collectionStartedAtMs'] is not None:
            if run['collectionStartedAtMs'] != member['collectionStartedAtMs']:
                raise ValueError('A series member cannot change its collection time')
            for key, manifest_key in (('configHash', 'configHash'), ('collectionProfileHash', 'profileHash'), ('sourceRelease', 'codeCheckpoint')):
                if run.get(key) is not None and run[key] != member[manifest_key]:
                    raise ValueError('A collected series member differs from its frozen hashes or source')

    def declare(self, run_id, created_at_ms, *, purpose='preparation', collection_started_at_ms=None,
                series_id=None, config_hash=None, collection_profile_hash=None, source_release=None):
        existing = self.state['runs'].get(run_id)
        fields = {'configHash': config_hash, 'collectionProfileHash': collection_profile_hash, 'sourceRelease': source_release}
        if existing is not None:
            if existing['createdAtMs'] != created_at_ms or existing['purpose'] != purpose or existing.get('seriesId') != series_id:
                raise ValueError('A recording identity cannot change its creation time, purpose or series')
            if existing.get('collectionStartedAtMs') is not None:
                for key, value in fields.items():
                    if value is not None and existing.get(key) not in (None, value):
                        raise ValueError('A collected recording cannot change its frozen hashes or source')
            if collection_started_at_ms is not None:
                retained = existing.get('collectionStartedAtMs')
                if retained is not None and retained != collection_started_at_ms:
                    raise ValueError('A recording identity cannot change its collection time')
                existing['collectionStartedAtMs'] = collection_started_at_ms
            existing.update({key: value for key, value in fields.items() if value is not None})
            self._save()
            return
        self.state['runs'][run_id] = {**self._pending_run(run_id, created_at_ms, purpose, series_id, collection_started_at_ms),
                                      **{key: value for key, value in fields.items() if value is not None}}
        self._save()

    def retain_manifest(self, manifest, sha256):
        series_id = manifest['seriesId']
        previous = self.state['manifests'].get(series_id)
        if previous:
            earlier = previous['manifest']
            if any(earlier[key] != manifest[key] for key in ('configHash', 'profileHash', 'codeCheckpoint', 'createdAtMs')):
                raise ValueError('A named series cannot change its frozen configuration, profile or source')
            if manifest['runIds'][:len(earlier['runIds'])] != earlier['runIds']:
                raise ValueError('A named series recording inventory is append-only')
            for member, later in zip(earlier['members'], manifest['members']):
                if member['createdAtMs'] != later['createdAtMs'] or member['codeCheckpoint'] != later['codeCheckpoint'] or (
                        member['collectionStartedAtMs'] is not None and member != later):
                    raise ValueError('A collected series member is immutable')
        candidate = copy.deepcopy(self.state)
        for member in manifest['members']:
            run = candidate['runs'].get(member['runId'])
            purpose = manifest['config']['purpose']
            if run:
                if run.get('seriesId') != series_id or run['purpose'] != purpose:
                    raise ValueError('A recording cannot belong to another named series or purpose')
                self._check_member(run, member)
            else:
                run = self._pending_run(member['runId'], member['createdAtMs'], purpose, series_id, member['collectionStartedAtMs'])
                candidate['runs'][member['runId']] = run
            if member['collectionStartedAtMs'] is not None:
                run.update(collectionStartedAtMs=member['collectionStartedAtMs'], configHash=member['configHash'],
                           collectionProfileHash=member['profileHash'], sourceRelease=member['codeCheckpoint'])
        hashes = list(previous['bundleHashes']) if previous else []
        if sha256 not in hashes:
            hashes.append(sha256)
        candidate['manifests'][series_id] = {'manifest': copy.deepcopy(manifest), 'sha256': sha256, 'bundleHashes': hashes}
        self.state = candidate
        self._save()

    def list_series(self):
        names = set(self.state['manifests']) | {run['seriesId'] for run in self.state['runs'].values() if run.get('seriesId')}
        return [{'seriesId': name, 'label': self.state['manifests'].get(name, {}).get('manifest', {}).get('label', name),
                 'manifestImported': name in self.state['manifests']} for name in sorted(names)]

    def accept(self, result):
        self.declare(result['runId'], result['createdAtMs'], purpose=result.get('purpose', 'preparation'),
                     collection_started_at_ms=result.get('collectionStartedAtMs'), series_id=result.get('seriesId'),
                     config_hash=result.get('configHash'), collection_profile_hash=result.get('collectionProfileHash'),
                     source_release=result.get('sourceRelease'))
        revision_id = result.get('revisionId')
        if not isinstance(revision_id, str) or not revision_id:
            raise ValueError('A retained immutable analysis revision is required')
        run = self.state['runs'][result['runId']]
        existing = next((item for item in run['revisions'] if item['revisionId'] == revision_id), None)
        if existing is not None and existing != result:
            raise ValueError('An immutable revision cannot change')
        if existing is None:
            run['revisions'].append(copy.deepcopy(result))
        if run['selectedRevision'] is None:
            run['selectedRevision'] = revision_id
        run['status'] = result['status']
        self._save()

    def revisions(self, run_id):
        return copy.deepcopy(self.state['runs'][run_id]['revisions'])

    def select_revision(self, run_id, revision_id):
        run = self.state['runs'][run_id]
        if not any(item['revisionId'] == revision_id for item in run['revisions']):
            raise ValueError('Select a retained analysis revision')
        run['selectedRevision'] = revision_id
        self._save()

    def evaluate(self, profile, *, purpose='preparation', series_id=None):
        retained = self.state['manifests'].get(series_id)
        manifest = retained['manifest'] if retained else None
        if manifest:
            purpose = manifest['config']['purpose']
        ranks = {name: index for index, name in enumerate(manifest['collectionRunIds'])} if manifest else {}
        runs = sorted((run for run in self.state['runs'].values() if run['purpose'] == purpose and run.get('seriesId') == series_id and
                       run.get('collectionStartedAtMs') is not None),
                      key=lambda item: (item['collectionStartedAtMs'], ranks.get(item['runId'], len(ranks)), item['runId']))
        selected = [next((revision for revision in run['revisions'] if revision['revisionId'] == run['selectedRevision']),
                         {'runId': run['runId'], 'status': 'pending', 'purpose': purpose}) for run in runs]
        member_by_id = {member['runId']: member for member in manifest['members']} if manifest else {}
        missing_manifest = series_id is not None and manifest is None
        outdated = bool(manifest and any(run['runId'] not in member_by_id or
                        member_by_id[run['runId']]['collectionStartedAtMs'] is None for run in runs))
        if missing_manifest or outdated:
            selected = [{'runId': run['runId'], 'status': 'pending', 'purpose': purpose} for run in runs]
        evaluated_profile = next((run['profile'] for run in selected if run.get('status') == 'completed' and
                                  isinstance(run.get('profile'), dict)), profile)
        value = accumulate_series(selected, evaluated_profile)
        if missing_manifest or outdated:
            value['qualificationReasons'].append('series_manifest_missing' if missing_manifest else 'series_manifest_outdated')
        value.update(seriesId=series_id, seriesLabel=manifest['label'] if manifest else series_id or 'Independent preparation recordings',
                     membershipStatus='manifest_missing' if missing_manifest else 'manifest_outdated' if outdated else 'manifest_imported' if manifest else 'local_imports_only',
                     manifestSha256=retained['sha256'] if retained else None,
                     inventoryRunIds=manifest['runIds'] if manifest else [run['runId'] for run in runs])
        return value
