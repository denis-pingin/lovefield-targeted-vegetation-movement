"""Tree originals to cue-aligned motion bins, exact reference results and diagnostics."""
import copy
import hashlib
import json
import math
from pathlib import Path
import logging
import cv2
import numpy as np

from study_profiles import validate_profile, measurement_method, METHOD
from study_video import extract_tree, read_frames, aggregate_tree_pairs
from tree_calculator import Series
from tree_series import calculation_targets, profile_hash
from study_tree_time import regional_summary, transition_summary

LOGGER = logging.getLogger(__name__)


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def generated_assignments(bundle):
    """Issued signed results, in the retained opportunity order; unused tickets are not targets."""
    targets, seen = [], set()
    for ticket in bundle.get('tickets', []):
        if ticket.get('status') != 'issued' or ticket.get('binding', {}).get('stream') != 'tree':
            continue
        result = ticket.get('result', {})
        data = result.get('random', {}).get('data')
        opportunity = ticket['binding']['opportunityId']
        if opportunity in seen or not isinstance(data, list) or len(data) != 1 or type(data[0]) is not int or data[0] not in (0, 1) or not result.get('signature'):
            raise ValueError('A unique signed binary Tree assignment is required')
        seen.add(opportunity)
        binding = ticket['binding']
        if binding.get('runId') != bundle['runId'] or binding.get('configHash') != bundle.get('configHash') or binding.get('experimentSlug') != bundle['experimentSlug']:
            raise ValueError('Tree assignment binding differs from its saved run')
        random_binding = result.get('random', {}).get('userData')
        if random_binding is not None and random_binding != binding:
            raise ValueError('Signed Tree assignment does not match its opportunity')
        rules = ticket.get('rules')
        if not isinstance(rules, dict) or set(rules) != {'0', '1'} or set(rules.values()) != {'A', 'B'}:
            raise ValueError('The retained binary-to-region rules mapping is required')
        event = next((event for event in bundle.get('events', []) if event.get('kind') == 'assignmentRecorded' and (
            event.get('data', {}).get('trialId') == opportunity or event.get('data', {}).get('ticketId') == ticket['ticketId'])), None)
        targets.append({'targetIndex': len(targets), 'trialId': opportunity, 'ticketId': ticket['ticketId'],
                        'assignedRegion': rules[str(data[0])],
                        'generatedAtMs': event.get('serverAtMs') if event else ticket.get('generatedAtMs'),
                        'providerVerified': ticket.get('verification', {}).get('status') == 'verified' and ticket.get('verification', {}).get('response', {}).get('result', {}).get('authenticity') is True})
    return targets


def _bin_measurement(pairs, start, end, recording_id, threshold, parent):
    measured = aggregate_tree_pairs(pairs, {'recording_id': recording_id, 'start': start, 'end': end}, threshold,
                                    parent_interval={'recording_id': recording_id, 'start': parent[0], 'end': parent[1]})
    return {'startSeconds': start, 'duration': end - start,
            'a': measured['A_motion'], 'b': measured['B_motion'],
            'rawA': measured.get('raw_A_motion', measured['A_motion']),
            'rawB': measured.get('raw_B_motion', measured['B_motion']),
            'usable': measured['quantifiable'], 'coverage': measured['coverage_fraction'],
            'reasons': measured['quality_reasons'],
            'acceptedTrackCounts': {name: measured.get(f'{name}_track_count') for name in ('A', 'B', 'background')},
            'pairIndices': measured['pair_indices'],
            'spatialCoverage': {name: {'minimum': measured.get(f'{name}_spatial_coverage_min'),
                                       'mean': measured.get(f'{name}_spatial_coverage_mean')}
                                for name in ('A', 'B') if f'{name}_spatial_coverage_min' in measured}}


def _mask(bin_value, reasons):
    if reasons:
        bin_value.update(usable=False, a=None, b=None,
                         reasons=sorted(set(bin_value['reasons']) | set(reasons)))


def analyze_extracted_run(bundle, measurements, profile, record, *, quality_reasons=(), cue_quality=None):
    """Public adapter over label-blind extracted pairs, also used by original-video analysis."""
    profile = validate_profile(profile)
    if bundle['config']['mode'] != 'tree':
        raise ValueError('Only Tree recordings belong to this study')
    response = bundle['config']['tree']['responseSeconds']
    if not _finite(response) or response <= 0:
        raise ValueError('The saved response duration must be positive and finite')
    generated = generated_assignments(bundle)
    cue_by_trial = {cue['trialId']: cue for cue in bundle.get('cues', []) if cue.get('stream') == 'tree' and cue.get('trialId')}
    pairs = measurements.get('pairs', [])
    threshold = profile['video']['minimumCoverageFraction']
    recording_id = record.get('recordingId', 'unavailable')
    targets = []
    review = record.get('obstructionReview') or {}
    valid_range = record.get('clockMap', {}).get('validPtsRangeSeconds')
    mapping = record.get('clockMap', {})
    for generated_target in generated:
        cue = cue_by_trial.get(generated_target['trialId'])
        onset = cue.get('playedAtMs') if cue and cue.get('deliveryStatus') == 'played' else None
        reasons = list(quality_reasons)
        if cue and cue.get('text') not in (generated_target['assignedRegion'], f"Target {generated_target['assignedRegion']}"):
            reasons.append('assignment_cue_mismatch')
        if onset is not None and not _finite(onset):
            reasons.append('playback_time_invalid')
            onset = None
        reasons.extend((cue_quality or {}).get(generated_target['trialId'], []))
        next_onset = next((candidate['playedAtMs'] / 1000 for later in generated[generated_target['targetIndex'] + 1:]
                           if (candidate := cue_by_trial.get(later['trialId'])) and
                           candidate.get('deliveryStatus') == 'played' and _finite(candidate.get('playedAtMs'))), None)
        bins = []
        for index in range(math.ceil(response)):
            duration = min(1., response - index)
            if onset is None:
                item = {'startSeconds': None, 'duration': duration, 'a': None, 'b': None,
                        'rawA': None, 'rawB': None, 'usable': False, 'coverage': 0.,
                        'reasons': ['cue_not_played'], 'acceptedTrackCounts': {}, 'pairIndices': []}
            else:
                start = onset / 1000 + index
                end = start + duration
                parent_end = min(onset / 1000 + response, next_onset) if next_onset is not None else onset / 1000 + response
                item = _bin_measurement(pairs, start, end, recording_id, threshold, (onset / 1000, parent_end))
                # Saved elapsed durations are exact inputs; subtracting large onsets can add rounding noise.
                item['duration'] = duration
                masked = list(reasons)
                if valid_range is None or len(valid_range) != 2 or not _finite(mapping.get('rate')) or mapping['rate'] <= 0:
                    masked.append('video_clock_reference_range_missing')
                elif ((start - mapping['offset_seconds']) / mapping['rate'] < valid_range[0] - 1e-9 or
                      (end - mapping['offset_seconds']) / mapping['rate'] > valid_range[1] + 1e-9):
                    masked.append('outside_video_clock_references')
                for span in review.get('spans', []):
                    if start < span['endAtMs'] / 1000 and span['startAtMs'] / 1000 < end:
                        masked.append('obstructed_region')
                if next_onset is not None and next_onset < end:
                    # A partial response cannot train a complete elapsed-bin predictor.
                    # In particular no pair after the next cue may enter its prior center.
                    item.update(rawA=None, rawB=None)
                    masked.extend(('overlapping_next_cue', 'raw_response_overlaps_next_cue'))
                _mask(item, masked)
            bins.append(item)
        targets.append({'runId': bundle['runId'], **generated_target, 'playbackAtMs': onset,
                        'responseSeconds': response, 'bins': bins,
                        'missingReasons': sorted({reason for item in bins for reason in item['reasons']})})
    absent = {}
    for name, event_kind, setting in (('preRoll', 'start', 'preRollSeconds'), ('postRoll', 'away', 'postRollSeconds')):
        event = next((event for event in bundle.get('events', []) if event.get('kind') == event_kind), None)
        duration = bundle['config']['tree'].get(setting)
        if event and _finite(duration) and duration > 0:
            start, end = event['serverAtMs'] / 1000, event['serverAtMs'] / 1000 + duration
            measured = aggregate_tree_pairs(pairs, {'start': start, 'end': end, 'recording_id': recording_id}, threshold)
            item = {'startSeconds': start, 'duration': duration, 'a': measured['A_motion'], 'b': measured['B_motion'],
                    'usable': measured['quantifiable'], 'coverage': measured['coverage_fraction'], 'reasons': measured['quality_reasons']}
            masked = list(quality_reasons)
            if valid_range is None or not mapping or (start - mapping.get('offset_seconds', 0)) / mapping.get('rate', 1) < valid_range[0] or (end - mapping.get('offset_seconds', 0)) / mapping.get('rate', 1) > valid_range[1]:
                masked.append('outside_video_clock_references')
            if any(start < span['endAtMs'] / 1000 and span['startAtMs'] / 1000 < end for span in review.get('spans', [])):
                masked.append('obstructed_region')
            _mask(item, masked)
            absent[name] = item
        else:
            absent[name] = {'a': None, 'b': None, 'usable': False, 'reasons': [f'{name}_boundary_missing']}
    all_bins = [item for target in targets for item in target['bins'] if item['usable']]
    covered = sum(item['duration'] for item in all_bins)
    absent['targeting'] = {key: sum(item[key] * item['duration'] for item in all_bins) / covered if covered else None for key in ('a', 'b')}
    for name in ('preRoll', 'postRoll'):
        absent[name]['targetingMinusAbsent'] = {key: absent['targeting'][key] - absent[name][key] if absent['targeting'][key] is not None and absent[name][key] is not None else None for key in ('a', 'b')}
    descriptive_pairs = copy.deepcopy(pairs)
    for pair in descriptive_pairs:
        masked = list(quality_reasons)
        if valid_range is None or not _finite(mapping.get('rate')) or mapping['rate'] <= 0:
            masked.append('video_clock_reference_range_missing')
        elif ((pair['start'] - mapping['offset_seconds']) / mapping['rate'] < valid_range[0] - 1e-9 or
              (pair['end'] - mapping['offset_seconds']) / mapping['rate'] > valid_range[1] + 1e-9):
            masked.append('outside_video_clock_references')
        if any(pair['start'] < span['endAtMs'] / 1000 and span['startAtMs'] / 1000 < pair['end'] for span in review.get('spans', [])):
            masked.append('obstructed_region')
        pair['quality_reasons'] = sorted(set(pair['quality_reasons']) | set(masked))
        if pair['quality_reasons']:
            pair.update(A_speed=None, B_speed=None)
    result = {'experimentSlug': 'tree-targeting', 'runId': bundle['runId'], 'tag': bundle.get('tag'),
              'seriesId': bundle['config'].get('seriesId'), 'configHash': bundle.get('configHash'),
              'collectionProfileHash': bundle.get('profileHash'),
              'createdAtMs': bundle['state'].get('createdAtMs', 0), 'collectionLifecycle': bundle['state']['lifecycle'],
              'collectionStartedAtMs': min((target['generatedAtMs'] for target in targets if _finite(target['generatedAtMs'])), default=None),
              'purpose': bundle['config']['purpose'], 'settings': copy.deepcopy(bundle['config']['tree']),
              'analysisVersion': METHOD, 'measurementMethod': measurement_method(profile),
              'profile': profile, 'profileHash': profile_hash(profile),
              'status': 'completed', 'targets': targets, 'qualityReasons': sorted(set(quality_reasons)),
              'randomizationStatus': 'verified' if generated and all(item['providerVerified'] for item in generated) else 'unverified',
              'regional': regional_summary(targets), 'absent': absent,
              'transitions': transition_summary(targets, descriptive_pairs, recording_id, threshold),
              'timeline': [{'startSeconds': pair['start'], 'endSeconds': pair['end'],
                            'a': pair['A_speed'], 'b': pair['B_speed'], 'reasons': pair['quality_reasons'],
                            'spatialCoverage': {name: pair[f'{name}_spatial']['coverage_fraction']
                                                for name in ('A', 'B') if pair.get(f'{name}_spatial')}
                            } for pair in descriptive_pairs],
              'measurements': copy.deepcopy(measurements),
              'inputHashes': {recording_id: record.get('sha256')}, 'sourceRelease': bundle.get('codeCheckpoint'),
              'originalExperimentSlug': bundle['experimentSlug'], 'setup': copy.deepcopy(bundle['state'].get('setupSnapshot'))}
    calculation = Series()
    result['rawPredictions'] = calculation_targets(calculation, result)
    result['calculation'] = calculation.result()
    return result


def _regions(setup, record):
    shape = (setup['imageSize']['height'], setup['imageSize']['width'])
    if shape != (record['height'], record['width']):
        raise ValueError('Tree setup dimensions differ from the original recording')
    from study_app import rasterize_mask
    return {name: rasterize_mask(shape, {'points': setup['regions'][name]} if isinstance(setup['regions'][name], list) else setup['regions'][name]) for name in ('A', 'B', 'background')}


def analyze_tree_run(bundle, originals, profile, progress=None):
    """Decode retained originals, then apply review masks without retraining raw prediction."""
    profile = validate_profile(profile)
    videos = [record for record in originals.values() if record.get('kind') == 'video']
    setup = bundle.get('state', {}).get('setupSnapshot')
    if len(videos) != 1 or not setup or not setup.get('regions') or not videos[0].get('clockMap'):
        reasons = ['video_recording_missing' if not videos else 'multiple_video_recordings' if len(videos) != 1 else
                   'tree_regions_missing' if not setup or not setup.get('regions') else 'video_clock_mapping_missing']
        return {'status': 'pending', 'qualityReasons': reasons}
    record = videos[0]
    reasons = []
    if bundle['config']['purpose'] == 'scored' and setup.get('retrospective'):
        reasons.append('tree_regions_retrospective')
    if record.get('timeMappingQualified') is not True:
        reasons.extend(record.get('timeMappingQualityReasons') or ['video_clock_mapping_unqualified'])
    review = record.get('obstructionReview')
    if not review or review.get('decision') not in ('clear', 'obstructed'):
        reasons.append('obstruction_review_missing')
    elif review.get('recordingSha256') != record['sha256']:
        reasons.append('obstruction_review_recording_changed')
    elif review['decision'] == 'obstructed' and review.get('timeMapId') != record.get('timeMapId'):
        reasons.append('obstruction_review_time_map_changed')
    setup_hash = setup.get('imageSha256')
    setup_images = [item for item in originals.values() if item.get('kind') == 'setupImage' and item.get('sha256') == setup_hash]
    if not setup_images:
        reasons.append('tree_setup_image_missing')
    elif hashlib.sha256(Path(setup_images[0]['path']).read_bytes()).hexdigest() != setup_hash:
        reasons.append('tree_setup_image_mismatch')
    references = record['clockMap'].get('references', [])
    allowance = max((item.get('clockUncertaintyMs', 0) + item.get('frameSelectionUncertaintyMs', 0) for item in references), default=math.inf) / 1000
    cue_quality = {}
    for cue in bundle.get('cues', []):
        if cue.get('stream') != 'tree' or not cue.get('trialId'):
            continue
        cue_reasons, uncertainty = _playback_timing({**bundle, 'cues': [cue]})
        if allowance + uncertainty > profile['timing']['maximumPairwiseAlignmentSeconds']:
            cue_reasons.append('playback_alignment_uncertainty_exceeds_limit')
        cue_quality[cue['trialId']] = cue_reasons
    mapping = {**record['clockMap'], 'residual_seconds': 0., 'uncertainty_seconds': min(allowance, 1.)}
    source_id = record['recordingId']
    sources = [{'source_id': source_id, 'recording_id': source_id, 'path': record['path'], 'sha256': record['sha256']}]
    measured = extract_tree(read_frames(sources, {source_id: mapping}, progress=progress), [], _regions(setup, record), profile)
    if progress:
        progress(stage='Aligning generated instructions and accumulating evidence')
    return analyze_extracted_run(bundle, measured, profile, record, quality_reasons=reasons, cue_quality=cue_quality)


analyze_hosted_run = analyze_tree_run

def _events(bundle, *kinds):
    return [event for event in bundle["events"] if event["kind"] in kinds]


def _played_cues(bundle, stream):
    return sorted((cue for cue in bundle["cues"] if cue.get("stream") == stream and
                   cue.get("deliveryStatus") == "played" and cue.get("playedAtMs") is not None),
                  key=lambda cue: cue["playedAtMs"])


def _clock_reference_device(bundle, clock_event):
    data = clock_event.get("data", {})
    if data.get("deviceId") is not None:
        return data["deviceId"]
    action_id = clock_event.get("actionId")
    if not action_id:
        return None
    actions = [action for action in bundle.get("actions", [])
               if action.get("actionId") == action_id]
    if len(actions) != 1 or actions[0].get("status") != "completed":
        return None
    payload = actions[0].get("payload", {})
    if payload.get("kind") != "saveClockReference" or payload.get("data") != data:
        return None
    return payload.get("deviceId")


def _playback_timing(bundle):
    streams = {"tree": {"tree"}, "local": {"local"},
               "global": {"local", "approach", "startPractice", "depart"}}[bundle["config"]["mode"]]
    reasons, uncertainty_ms = [], 0
    for cue in (cue for stream in streams for cue in _played_cues(bundle, stream)):
        events = [event for event in _events(bundle, "cuePlayed")
                  if event.get("data", {}).get("cueId") == cue.get("cueId")]
        if len(events) != 1 or events[0].get("data", {}).get("timeSource") != "phone_offset":
            reasons.append("playback_time_unqualified")
            continue
        event, data = events[0], events[0]["data"]
        references = [item.get("data", {}).get("reference", {}) for item in bundle.get("clockReferences", [])
                      if _clock_reference_device(bundle, item) == cue.get("deviceId") and
                      item.get("data", {}).get("reference", {}).get("selected", {}).get("exchangeId") == data.get("clockExchangeId")]
        if not references:
            reasons.append("playback_clock_reference_missing")
            continue
        reference = references[0]
        selected = reference.get("selected", {})
        numbers = [selected.get(key) for key in ("clientSentAtMs", "clientReceivedAtMs",
                   "serverReceivedAtMs", "serverSentAtMs")] + [reference.get("offsetMs"),
                   reference.get("uncertaintyMs"), data.get("clockUncertaintyMs"), event.get("clientAtMs")]
        if not all(type(value) in (int, float) and math.isfinite(value) for value in numbers):
            reasons.append("playback_clock_reference_mismatch")
            continue
        sent, received, server_received, server_sent, offset, uncertainty, cue_uncertainty, client_at = numbers
        measured_offset = ((server_received - sent) + (server_sent - received)) / 2
        measured_uncertainty = ((received - sent) - (server_sent - server_received)) / 2
        if (reference.get("valid") is not True or selected.get("valid") is not True or
                selected not in reference.get("samples", []) or not data.get("clockExchangeId") or
                not cue.get("deviceId") or data.get("deviceId") != cue["deviceId"] or
                data.get("clockSegment") != reference.get("segment") or
                data.get("playedAtMs") != cue["playedAtMs"] or sent > received or server_received > server_sent or
                client_at < received or uncertainty < 0 or cue_uncertainty != uncertainty or
                not math.isclose(offset, measured_offset, rel_tol=0, abs_tol=0.001) or
                not math.isclose(uncertainty, measured_uncertainty, rel_tol=0, abs_tol=0.001) or
                not math.isclose(client_at + offset, cue["playedAtMs"], rel_tol=0, abs_tol=0.001)):
            reasons.append("playback_clock_reference_mismatch")
            continue
        uncertainty_ms = max(uncertainty_ms, uncertainty)
    return sorted(set(reasons)), uncertainty_ms / 1000
