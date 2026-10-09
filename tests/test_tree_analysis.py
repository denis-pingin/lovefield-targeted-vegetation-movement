import copy
import math

import pytest

from study_analysis import analyze_extracted_run
from study_profiles import development_profile
from tree_calculator import MotionBin, Series
from tree_fixtures import tree_bundle


def measured_pairs(end=40):
    return {'pairs': [{'start': index / 25, 'end': (index + 1) / 25, 'recording_id': 'video',
                       'A_speed': 2., 'B_speed': 1., 'raw_A_speed': 2., 'raw_B_speed': 1.,
                       'A_track_count': 25, 'B_track_count': 25, 'background_track_count': 15,
                       'quality_reasons': []} for index in range(math.ceil(end * 25))],
            'shake_spans': []}


def recording():
    return {'recordingId': 'video', 'clockMap': {'rate': 1., 'offset_seconds': 0.,
            'validPtsRangeSeconds': [0, 100]}, 'obstructionReview': {'decision': 'clear', 'spans': []},
            'timeMappingQualified': True, 'sha256': 'a' * 64}


@pytest.mark.parametrize('duration', [2, 8, 15, 2.4])
def test_actual_cue_bins_keep_duration_and_reference_values(duration):
    bundle = tree_bundle(response=duration, labels=('A', 'A', 'B'))
    result = analyze_extracted_run(bundle, measured_pairs(55), development_profile(), recording())
    assert len(result['targets']) == 3
    reference = Series()
    for index, target in enumerate(result['targets']):
        assert len(target['bins']) == math.ceil(duration)
        assert sum(item['duration'] for item in target['bins']) == pytest.approx(duration)
        assert target['bins'][0]['startSeconds'] == target['playbackAtMs'] / 1000
        reference.add_target(bundle['runId'], index, int(target['assignedRegion'] == 'A'),
                             [MotionBin(item['duration'], item['rawA'], item['rawB'], item['usable'])
                              for item in target['bins']])
    assert result['calculation']['log_e'] == pytest.approx(reference.result()['log_e'])
    assert result['calculation']['streams']['-1']['targets'] == 3


def test_generated_undelivered_assignment_is_bounded_not_deleted():
    bundle = tree_bundle()
    bundle['cues'][-1].update(playedAtMs=None, deliveryStatus='failed')
    result = analyze_extracted_run(bundle, measured_pairs(), development_profile(), recording())
    assert len(result['targets']) == 2
    failed = result['targets'][1]
    assert failed['playbackAtMs'] is None
    assert len(failed['bins']) == 2
    assert all(not item['usable'] and item['rawA'] is None for item in failed['bins'])
    assert result['calculation']['streams']['-1']['targets'] == 2
    assert result['calculation']['streams']['-1']['bounded_missing_targets'] == 1


def test_overlap_and_parent_edges_do_not_admit_future_or_pre_cue_motion():
    bundle = tree_bundle(response=2, labels=('A', 'B'))
    bundle['cues'][1]['playedAtMs'] = 3500
    pairs = measured_pairs()
    pairs['pairs'].append({'start': 1.9, 'end': 2.1, 'recording_id': 'video',
                            'A_speed': 9999., 'B_speed': 0., 'quality_reasons': []})
    result = analyze_extracted_run(bundle, pairs, development_profile(), recording())
    assert result['targets'][0]['bins'][0]['rawA'] == pytest.approx(2)
    assert result['targets'][0]['bins'][0]['usable']
    assert not result['targets'][0]['bins'][1]['usable']
    assert 'overlapping_next_cue' in result['targets'][0]['bins'][1]['reasons']


def test_retrospective_obstruction_preserves_raw_predictor_sequence():
    bundle = tree_bundle(labels=('A', 'B', 'A'))
    clean = analyze_extracted_run(bundle, measured_pairs(), development_profile(), recording())
    changed = recording()
    changed['obstructionReview'] = {'decision': 'obstructed', 'spans': [{'startAtMs': 2000, 'endAtMs': 3000}]}
    masked = analyze_extracted_run(bundle, measured_pairs(), development_profile(), changed)
    assert clean['rawPredictions'] == masked['rawPredictions']
    assert masked['targets'][0]['bins'][0]['rawA'] == 2
    assert masked['targets'][0]['bins'][0]['a'] is None
    assert masked['calculation']['log_e'] <= clean['calculation']['log_e']


def test_absence_uses_start_and_away_not_approach_or_return():
    bundle = tree_bundle()
    bundle['state']['recordingStartedAtMs'] = 250
    bundle['events'].append({'kind': 'approach', 'serverAtMs': 9000})
    result = analyze_extracted_run(bundle, measured_pairs(), development_profile(), recording())
    assert result['absent']['preRoll']['startSeconds'] == 1
    away = next(event for event in bundle['events'] if event['kind'] == 'away')['serverAtMs'] / 1000
    assert result['absent']['postRoll']['startSeconds'] == away


def test_saved_provider_rules_are_distinct_from_statistical_binary_label():
    from study_analysis import generated_assignments
    bundle = tree_bundle(labels=('A', 'B', 'A'))
    assert [item['assignedRegion'] for item in generated_assignments(bundle)] == ['A', 'B', 'A']
    bundle['tickets'][0]['rules'] = {'0': 'B', '1': 'A'}
    assert generated_assignments(bundle)[0]['assignedRegion'] == 'B'
    bundle['tickets'][0].pop('rules')
    with pytest.raises(ValueError, match='rules|mapping'):
        generated_assignments(bundle)


def test_retained_dsc0056_provider_metadata_matches_all_recorded_target_labels():
    import json
    from pathlib import Path
    from study_analysis import generated_assignments
    bundle = json.loads((Path(__file__).parent / 'fixtures/retained-tree-labels.json').read_text())
    targets = generated_assignments(bundle)
    cues = {cue['trialId']: cue['text'] for cue in bundle['cues'] if cue.get('stream') == 'tree'}
    assert len(targets) == 16
    assert [item['assignedRegion'] for item in targets].count('A') == 6
    assert [item['assignedRegion'] for item in targets].count('B') == 10
    assert all(cues[item['trialId']] == 'Target ' + item['assignedRegion'] for item in targets)


def test_overlapping_next_cue_cannot_train_prediction_from_its_future_frames():
    bundle = tree_bundle(response=2, labels=('A', 'B'))
    bundle['cues'][1]['playedAtMs'] = 3500
    baseline = measured_pairs()
    changed = copy.deepcopy(baseline)
    for pair in changed['pairs']:
        if pair['end'] > 3.5:
            pair.update(A_speed=100., raw_A_speed=100.)
    first = analyze_extracted_run(bundle, baseline, development_profile(), recording())
    second = analyze_extracted_run(bundle, changed, development_profile(), recording())
    assert first['rawPredictions'][1]['centers'] == second['rawPredictions'][1]['centers']
    assert second['targets'][0]['bins'][1]['rawA'] is None
    assert second['targets'][0]['bins'][1]['rawB'] is None
    assert 'raw_response_overlaps_next_cue' in second['targets'][0]['bins'][1]['reasons']


def test_obstructed_context_and_timeline_use_masks_but_raw_pairs_remain_retained():
    bundle = tree_bundle(response=2, labels=('A', 'B'))
    bundle['cues'][1]['playedAtMs'] = 5000
    record = recording()
    record['obstructionReview'] = {'decision': 'obstructed', 'spans': [{'startAtMs': 2000, 'endAtMs': 5000}]}
    pairs = measured_pairs()
    result = analyze_extracted_run(bundle, pairs, development_profile(), record)
    context = result['transitions']['A-to-B']['transitions'][0]['before']
    assert all(row['a'] is None and row['b'] is None for row in context)
    assert result['transitions']['A-to-B']['firstSecondChange'] == {'a': None, 'b': None}
    timeline = [row for row in result['timeline'] if row['startSeconds'] >= 2 and row['endSeconds'] <= 5]
    assert all(row['a'] is None and 'obstructed_region' in row['reasons'] for row in timeline)
    assert result['measurements'] == pairs
    assert result['targets'][0]['bins'][0]['rawA'] == 2


def test_later_cadence_quality_mask_does_not_retrain_raw_prediction():
    bundle = tree_bundle()
    clean_pairs = measured_pairs()
    qualified = copy.deepcopy(clean_pairs)
    for pair in qualified['pairs']:
        if pair['start'] < 4:
            pair.update(A_speed=None, B_speed=None, quality_reasons=['frame_gap'])
    clean = analyze_extracted_run(bundle, clean_pairs, development_profile(), recording())
    masked = analyze_extracted_run(bundle, qualified, development_profile(), recording())
    assert clean['rawPredictions'] == masked['rawPredictions']
    assert not masked['targets'][0]['bins'][0]['usable']


def test_qualified_coverage_scores_accepted_motion_but_trains_on_retained_raw_motion():
    bundle = tree_bundle()
    pairs = measured_pairs()
    rejected = next(pair for pair in pairs['pairs'] if pair['start'] == 2)
    rejected.update(A_speed=None, B_speed=None, raw_A_speed=100., raw_B_speed=1., quality_reasons=['target_tracks_lost'])
    run = analyze_extracted_run(bundle, pairs, development_profile(), recording())
    first = run['targets'][0]['bins'][0]
    assert first['usable'] and first['coverage'] == pytest.approx(.96)
    assert first['a'] == 2 and first['rawA'] > 2
    assert run['calculation']['streams']['0']['effect_estimate'] == pytest.approx(0)
    assert run['rawPredictions'][1]['centers']['0'] > 1 / 3


def test_saved_native_pixel_polygons_are_rasterized_at_original_dimensions():
    from study_analysis import _regions
    regions = {'A': [[1, 1], [35, 1], [35, 65], [1, 65]],
               'B': [[40, 1], [75, 1], [75, 65], [40, 65]],
               'background': [[80, 1], [115, 1], [115, 65], [80, 65]]}
    masks = _regions({'imageSize': {'width': 120, 'height': 80}, 'regions': regions}, {'width': 120, 'height': 80})
    assert masks['A'].shape == (80, 120)
    assert masks['A'][20, 20] and not masks['A'][20, 60]
    assert masks['B'][20, 60] and not masks['B'][20, 20]
