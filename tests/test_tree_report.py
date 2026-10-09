import copy
import json
import math
from pathlib import Path

import pytest

from tree_report import build_tree_report
from test_tree_series import result
from tree_series import accumulate_series
from study_profiles import development_profile

EXAMPLES = json.loads((Path(__file__).parents[1] / 'validation/results.json').read_text())['examples']


@pytest.mark.parametrize('name', list(EXAMPLES))
def test_retained_examples_use_reference_values_and_relative_units(name):
    example = EXAMPLES[name]
    report = build_tree_report({'purpose': 'preparation', 'calculation': example,
                                'regionalDiagnostics': example['regional_diagnostics']})
    assert report['status'] == 'Preparation result'
    assert report['effectUnits'] == 'relative-share percentage points'
    assert report['full']['estimate'] == pytest.approx(example['streams']['-1']['effect_estimate'] * 100)
    assert report['full']['confidenceRange'] == pytest.approx([value * 100 for value in example['streams']['-1']['simultaneous_confidence_interval']])
    assert report['evidence']['logValue'] == example['log_e']
    assert report['evidence']['threshold'] == 20
    assert report['elapsed'][0]['estimate'] == pytest.approx(example['streams']['0']['effect_estimate'] * 100)
    assert 'exploratory' in report['caveat']
    assert 'raw-speed percent' in report['caveat']
    assert all(row['unit'] == report['effectUnits'] for row in report['tables']['effects'])
    assert report['charts'][0]['series'][0]['values'][0]['y'] == report['elapsed'][0]['estimate']


def test_bounded_missing_and_single_label_are_visible_without_claiming_region_increases():
    run = result('one', 1)
    run['targets'][0]['bins'][0].update(usable=False, a=None, b=None, reasons=['obstructed_region'])
    report = build_tree_report(accumulate_series([run], development_profile()))
    assert report['counts']['missingBins'] == 1
    assert report['full']['estimate'] is None
    assert 'bounded unknown' in ' '.join(report['narrative'])
    assert 'both regions increased' not in ' '.join(report['narrative'])
    run['regional']['full'].update(A_difference=None, B_difference=None, counts={'A': 2, 'B': 0})
    single = build_tree_report(run)
    assert single['tables']['regional'][0]['A targeting difference'] is None
    assert 'unavailable' in ' '.join(single['narrative']).lower()


def test_incomplete_prefix_and_unverified_randomization_remain_visible():
    run = result('one', 1)
    report = build_tree_report(accumulate_series([{'runId': 'earlier', 'status': 'pending'}, run], development_profile()))
    assert report['pendingRuns'] == ['earlier', 'one']
    assert 'waiting' in ' '.join(report['narrative']).lower()
    assert report['randomizationStatus'] is None
    assert report['counts']['runs'] == 0


def test_empty_series_has_only_pending_text_and_no_evidence_or_qualification_claim():
    report = build_tree_report(accumulate_series([], development_profile()))
    assert report['status'] == 'Pending Tree result'
    assert report['counts']['targets'] == 0
    assert report['full'] is None and report['evidence'] is None
    assert report['elapsed'] == [] and report['charts'] == []
    assert report['randomizationStatus'] is None
    assert report['narrative'] == ['No analyzed targets yet. Import and analyze a Tree recording to start the series.']


def test_series_history_joins_selected_individual_results_by_run_id_without_changing_cumulative_data():
    first, second = result('one', 1000, 2), result('two', 10000, 8)
    first['tag'], second['tag'] = 'First recording', 'Second recording'
    first['calculation']['streams']['-1']['effect_estimate'] = .123
    second['calculation']['streams']['-1']['effect_estimate'] = -.045
    first['calculation']['log_e'] = math.log(2)
    second['calculation']['log_e'] = math.log(4)
    combined = accumulate_series([first, second], development_profile())
    cumulative_history = copy.deepcopy(combined['history'])
    combined['runs'].reverse()
    original = copy.deepcopy(combined)

    report = build_tree_report(combined)

    assert combined == original
    for row, cumulative, run in zip(report['tables']['history'], cumulative_history, [first, second]):
        assert {key: value for key, value in row.items() if key != 'individual'} == cumulative
        assert row['individual']['tag'] == run['tag']
        assert row['individual']['targetCount'] == len(run['targets'])
        assert row['individual']['logEvidence'] == run['calculation']['log_e']
        assert row['individual']['full']['estimate'] == pytest.approx(
            100 * run['calculation']['streams']['-1']['effect_estimate'])
        assert row['individual']['full']['confidenceRange'] == pytest.approx(
            [100 * value for value in run['calculation']['streams']['-1']['simultaneous_confidence_interval']])
    assert report['tables']['history'][0]['individual']['full']['estimate'] != report['tables']['history'][1]['full']['estimate']


def test_series_peak_sets_sequential_p_even_when_current_e_falls():
    combined = accumulate_series([result('one', 1000)], development_profile())
    combined['maxLogEvidence'] = math.log(100)
    combined['logEvidence'] = math.log(2)
    report = build_tree_report(combined)

    assert report['evidence']['logValue'] == pytest.approx(math.log(2))
    assert report['evidence']['maxLogValue'] == pytest.approx(math.log(100))
    assert report['evidence']['sequentialLogPValue'] == pytest.approx(-math.log(100))
    assert report['evidence']['sequentialPValueLabel'] == '0.01'
    assert 'highest cumulative e' in ' '.join(report['narrative']).lower()
    assert 'sequential p-value' in ' '.join(report['narrative']).lower()
    assert 'estimated full-response effect size' in ' '.join(report['narrative']).lower()


@pytest.mark.parametrize('peak,expected', [(math.log(.5), '1'), (0, '1'), (math.log(20), '0.05')])
def test_sequential_p_uses_initial_e_one_and_preserves_the_e_twenty_threshold(peak, expected):
    combined = accumulate_series([result('one', 1000)], development_profile())
    combined['maxLogEvidence'] = peak
    combined['logEvidence'] = peak

    report = build_tree_report(combined)

    assert report['evidence']['sequentialLogPValue'] == pytest.approx(-max(0, peak))
    assert report['evidence']['sequentialPValueLabel'] == expected
    assert report['evidence']['threshold'] == 20


def test_extreme_peak_keeps_finite_log_p_and_nonzero_scientific_label():
    combined = accumulate_series([result('one', 1000)], development_profile())
    combined['maxLogEvidence'] = 1000.
    combined['logEvidence'] = 0.

    evidence = build_tree_report(combined)['evidence']

    assert evidence['sequentialLogPValue'] == -1000.
    assert evidence['sequentialPValueLabel'] != '0'
    assert '10^-435' in evidence['sequentialPValueLabel']
    assert 'inf' not in evidence['sequentialPValueLabel'].lower()


def test_missing_individual_estimate_retains_bounds_and_unmatched_run_warns(caplog):
    first, second = result('one', 1000), result('two', 10000)
    combined = accumulate_series([first, second], development_profile())
    selected = combined['runs'][0]['calculation']['streams']['-1']
    selected['effect_estimate'] = None
    selected['effect_estimate_bounds'] = [-.2, .3]
    combined['runs'] = combined['runs'][:1]

    history = build_tree_report(combined)['tables']['history']

    assert history[0]['individual']['full']['estimate'] is None
    assert history[0]['individual']['full']['estimateBounds'] == pytest.approx([-20, 30])
    assert history[1]['individual']['full'] is None
    assert history[1]['individual']['logEvidence'] is None
    assert 'two' in caplog.text


def test_individual_report_does_not_invent_cumulative_peak_p_value():
    report = build_tree_report(result('one', 1000))
    assert 'sequentialLogPValue' not in report['evidence']
    assert 'sequentialPValueLabel' not in report['evidence']


@pytest.mark.parametrize('pre_roll_start,first_second', [(21, 17), (10, 10)])
def test_exported_motion_chart_crops_clock_filming_and_preserves_actual_absence(pre_roll_start, first_second):
    from study_analysis import analyze_extracted_run
    from tree_fixtures import tree_bundle
    from test_tree_analysis import measured_pairs, recording
    bundle = tree_bundle()
    for event in bundle['events']:
        event['serverAtMs'] += 20000
        if event['kind'] == 'start':
            event['serverAtMs'] = pre_roll_start * 1000
    for cue in bundle['cues']:
        for key in ('dueAtMs', 'issuedAtMs', 'playedAtMs'):
            cue[key] += 20000
    pairs = measured_pairs()
    for pair in pairs['pairs']:
        if pair['end'] <= first_second or pair['start'] >= 28.2:
            pair.update(A_speed=1860., B_speed=1000.)
    profile = development_profile()
    run = analyze_extracted_run(bundle, pairs, profile, recording())
    retained = copy.deepcopy(run['timeline'])
    report = json.loads(json.dumps(build_tree_report(run)))
    chart = next(item for item in report['charts'] if item['kind'] == 'timeline')
    assert chart['xDomain'][0] >= first_second
    assert chart['xDomain'][1] <= 28.2
    assert chart['series'][0]['values'][0]['start'] == pytest.approx(first_second)
    assert chart['series'][0]['values'][-1]['end'] == pytest.approx(28.2)
    assert max(point['y'] for point in chart['series'][0]['values'] if point['y'] is not None) == 2
    assert [marker['x'] for marker in chart['markers']] == pytest.approx([22, 24.1])
    assert run['timeline'] == retained
    assert any(row['a'] == 1860 for row in retained)


def test_timeline_uses_saved_target_intervals_and_exact_response_bins_without_mutating_runs():
    from study_analysis import analyze_extracted_run
    from tree_fixtures import tree_bundle
    from test_tree_analysis import measured_pairs, recording

    run = analyze_extracted_run(tree_bundle(response=2.4, labels=('A', 'A', 'B')),
                                measured_pairs(60), development_profile(), recording())
    missing = run['targets'][1]['bins'][1]
    missing.update(usable=False, a=None, b=None, reasons=['obstructed_region'])
    original = copy.deepcopy(run)

    chart = next(item for item in build_tree_report(run)['charts'] if item['kind'] == 'timeline')
    origin = run['timeline'][0]['startSeconds']
    expected_intervals = [
        {'index': target['targetIndex'] + 1, 'label': target['assignedRegion'],
         'start': target['playbackAtMs'] / 1000 - origin,
         'end': target['playbackAtMs'] / 1000 + target['responseSeconds'] - origin}
        for target in run['targets']
    ]
    assert chart['targetIntervals'] == expected_intervals
    assert [(item['label'], item['index']) for item in chart['targetIntervals']] == [('A', 1), ('A', 2), ('B', 3)]
    assert [later['start'] - earlier['end'] for earlier, later in zip(chart['targetIntervals'], chart['targetIntervals'][1:])] == pytest.approx([.1, .1])
    assert chart['xDomain'][0] <= min(item['start'] for item in expected_intervals)
    assert chart['xDomain'][1] >= max(item['end'] for item in expected_intervals)

    for target in run['targets']:
        for saved in target['bins']:
            start = saved['startSeconds'] - origin
            end = start + saved['duration']
            for series, field in zip(chart['series'], ('a', 'b')):
                matching = [point for point in series['values']
                            if point['start'] == pytest.approx(start) and point['end'] == pytest.approx(end)]
                assert len(matching) == 1
                assert matching[0]['x'] == pytest.approx(start + saved['duration'] / 2)
                assert matching[0]['y'] == saved[field]
    assert run == original

    unplayed_bundle = tree_bundle(response=2.4, labels=('A', 'A', 'B'))
    unplayed_bundle['cues'][-1].update(playedAtMs=None, deliveryStatus='failed')
    unplayed = analyze_extracted_run(unplayed_bundle, measured_pairs(60), development_profile(), recording())
    unplayed_chart = next(item for item in build_tree_report(unplayed)['charts'] if item['kind'] == 'timeline')
    assert len(unplayed['targets']) == 3
    assert len(unplayed_chart['targetIntervals']) == 2
    assert all(item['index'] != 3 for item in unplayed_chart['targetIntervals'])


def test_timeline_uses_each_recordings_saved_response_duration_without_changing_series():
    first, second = result('short', 1000, 2), result('long', 10000, 8)
    combined = accumulate_series([first, second], development_profile())
    original = copy.deepcopy((first, second, combined))
    series_before = build_tree_report(combined)

    for run in (first, second):
        chart = next(item for item in build_tree_report(run)['charts'] if item['kind'] == 'timeline')
        assert all(interval['end'] - interval['start'] == pytest.approx(run['settings']['responseSeconds'])
                   for interval in chart['targetIntervals'])
    assert build_tree_report(combined) == series_before
    assert (first, second, combined) == original


def test_timeline_context_is_duration_weighted_and_keeps_invalid_measurements_and_real_gaps():
    run = result('context', 1000)
    run['timeline'] = [
        {'startSeconds': 0., 'endSeconds': .25, 'a': 2., 'b': 1., 'reasons': []},
        {'startSeconds': .25, 'endSeconds': 1., 'a': 4., 'b': 3., 'reasons': []},
        {'startSeconds': 1., 'endSeconds': 1.25, 'a': 10., 'b': 5., 'reasons': []},
        {'startSeconds': 1.25, 'endSeconds': 1.5, 'a': None, 'b': None, 'reasons': ['obstructed_region']},
        {'startSeconds': 1.75, 'endSeconds': 2.25, 'a': 20., 'b': 10., 'reasons': []},
        {'startSeconds': 2.25, 'endSeconds': 2.5, 'a': 9999., 'b': 9999., 'reasons': []},
        {'startSeconds': 4., 'endSeconds': 4.1, 'a': 7., 'b': 4., 'reasons': []},
        {'startSeconds': 6., 'endSeconds': 6.5, 'a': 6., 'b': 3., 'reasons': []},
    ]
    original = copy.deepcopy(run)

    chart = next(item for item in build_tree_report(run)['charts'] if item['kind'] == 'timeline')
    a_values, b_values = (series['values'] for series in chart['series'])
    first = next(point for point in a_values if point['start'] == 0)
    first_b = next(point for point in b_values if point['start'] == 0)
    assert (first['start'], first['end'], first['x'], first['y']) == pytest.approx((0, 1, .5, 3.5))
    assert first_b['y'] == pytest.approx(2.5)
    assert any(point['start'] == pytest.approx(1.25) and point['end'] == pytest.approx(1.5)
               and point['y'] is None for point in a_values)
    assert any(point['start'] == pytest.approx(1.75) and point['end'] == pytest.approx(2.)
               and point['y'] == pytest.approx(20) for point in a_values)
    assert not any(point['start'] < 1.75 and point['end'] > 1.5 for point in a_values)
    assert any(point['start'] == pytest.approx(4.) and point['end'] == pytest.approx(4.1)
               and point['y'] == pytest.approx(7) for point in a_values)
    assert any(point['start'] == pytest.approx(6.1) and point['end'] == pytest.approx(6.5)
               and point['y'] == pytest.approx(6) for point in a_values)
    assert not any(point['y'] == 9999 for point in a_values)
    assert run == original
