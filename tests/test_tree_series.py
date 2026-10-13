import copy

import pytest

from study_analysis import analyze_extracted_run
from study_profiles import area_profile
from tree_series import SeriesStore, accumulate_series
from tree_calculator import Series, MotionBin
from tree_fixtures import tree_bundle
from test_tree_analysis import measured_pairs, recording


def result(run_id, created, response=2):
    bundle = tree_bundle(run_id, response=response)
    bundle['state']['createdAtMs'] = created
    for event in bundle['events']:
        event['serverAtMs'] += created - 1000
    for cue in bundle['cues']:
        for key in ('dueAtMs', 'issuedAtMs', 'playedAtMs'):
            cue[key] += created - 1000
    value = analyze_extracted_run(bundle, measured_pairs(), area_profile(), recording())
    value['revisionId'] = run_id + '-analysis-1'
    return value


def test_reanalysis_replaces_contribution_and_retains_history_after_restart(tmp_path):
    store = SeriesStore(tmp_path)
    first = result('one', 1000)
    store.accept(first)
    revised = copy.deepcopy(first)
    revised['revisionId'] = 'one-analysis-2'
    store.accept(revised)
    restarted = SeriesStore(tmp_path)
    report = restarted.evaluate(area_profile())
    assert report['runCount'] == 1
    assert report['targetCount'] == 2
    assert report['selectedRevisions'] == ['one-analysis-1']
    assert len(restarted.revisions('one')) == 2
    restarted.select_revision('one', 'one-analysis-2')
    assert restarted.evaluate(area_profile())['selectedRevisions'] == ['one-analysis-2']


@pytest.mark.parametrize('method', [None, 'unsupported-method'])
def test_accumulation_requires_explicit_area_measurement_identity(method):
    run = result('one', 1000)
    if method is None:
        del run['measurementMethod']
    else:
        run['measurementMethod'] = method
    with pytest.raises(ValueError, match='Unsupported'):
        accumulate_series([run], area_profile())


def test_two_runs_carry_reference_streams_without_evidence_reset():
    first, second = result('one', 1000, 2), result('two', 10000, 8)
    report = accumulate_series([first, second], area_profile())
    reference = Series()
    for run in (first, second):
        for target in run['targets']:
            reference.add_target(run['runId'], target['targetIndex'], int(target['assignedRegion'] == 'A'),
                [MotionBin(item['duration'], item['rawA'], item['rawB'], item['usable']) for item in target['bins']])
    assert report['logEvidence'] == pytest.approx(reference.log_e())
    assert report['full']['targets'] == 4
    assert report['elapsed'][3]['targets'] == 2
    assert len(report['history']) == 2
    assert report['maxLogEvidence'] >= report['logEvidence']


def test_later_resolved_run_waits_for_pending_earlier_recording(tmp_path):
    store = SeriesStore(tmp_path)
    store.declare('one', 1000, collection_started_at_ms=2000)
    store.accept(result('two', 10000))
    report = store.evaluate(area_profile())
    assert report['runCount'] == 0
    assert report['targetCount'] == 0
    assert report['pendingRuns'] == ['one', 'two']
    assert report['status'] == 'incomplete_prefix'
    store.accept(result('one', 1000))
    assert store.evaluate(area_profile())['runCount'] == 2


def test_single_label_stays_in_main_evidence_and_raw_contrast_is_unavailable():
    bundle = tree_bundle(labels=('A', 'A'))
    run = analyze_extracted_run(bundle, measured_pairs(), area_profile(), recording())
    run['revisionId'] = 'single-label'
    report = accumulate_series([run], area_profile())
    assert report['targetCount'] == 2
    assert run['regional']['full']['A_difference'] is None
    assert run['regional']['full']['counts'] == {'A': 2, 'B': 0}


def test_mixed_statistical_methods_are_not_silently_pooled():
    run = result('one', 1000)
    run['analysisVersion'] = 'different-method'
    with pytest.raises(ValueError, match='method'):
        accumulate_series([run], area_profile())


def test_scored_timing_and_profile_mutation_is_rejected():
    first, second = result('one', 1000), result('two', 10000, 8)
    first['purpose'] = second['purpose'] = 'scored'
    first['randomizationStatus'] = second['randomizationStatus'] = 'verified'
    with pytest.raises(ValueError, match='scored|frozen'):
        accumulate_series([first, second], area_profile())


def test_saved_unstarted_configuration_does_not_block_actual_collection_order(tmp_path):
    store = SeriesStore(tmp_path)
    store.declare('saved-first', 1)
    second = result('collected-first', 2)
    second['collectionStartedAtMs'] = 100
    store.accept(second)
    assert store.evaluate(area_profile())['runIds'] == ['collected-first']
    first = result('saved-first', 1)
    first['collectionStartedAtMs'] = 200
    store.accept(first)
    report = store.evaluate(area_profile())
    assert report['runIds'] == ['collected-first', 'saved-first']
    assert store.state['runs']['saved-first']['createdAtMs'] == 1


def test_unverified_scored_assignment_stays_pending_and_unqualified():
    run = result('one', 1)
    run['purpose'] = 'scored'
    assert run['randomizationStatus'] == 'unverified'
    report = accumulate_series([run], area_profile())
    assert report['interpretationStatus'] == 'unqualified'
    assert report['status'] == 'incomplete_prefix'
    assert report['runCount'] == 0
    assert report['pendingRuns'] == ['one']
    assert report['qualificationReasons'] == ['randomization_unverified']


def test_named_series_are_separate_and_wait_for_their_inventory(tmp_path):
    store = SeriesStore(tmp_path)
    for run_id, name in [('oak-run', 'oak'), ('pine-run', 'pine')]:
        run = result(run_id, 1000)
        run['seriesId'] = name
        store.accept(run)
    assert store.evaluate(area_profile())['targetCount'] == 0
    oak = store.evaluate(area_profile(), series_id='oak')
    assert oak['runCount'] == 0 and oak['pendingRuns'] == ['oak-run']
    assert oak['membershipStatus'] == 'manifest_missing'
    assert oak['qualificationReasons'] == ['series_manifest_missing']


@pytest.mark.parametrize('custom', [False, True])
def test_pending_scored_series_uses_its_actual_frozen_profile_and_hash(tmp_path, custom):
    from publication_fixtures import scored_application
    profile = area_profile()
    if custom:
        profile.update(profileId='custom-grid', label='My frozen settings')
        profile['video']['measurement']['cellSizePixels'] = 96
    app, series_id, _ = scored_application(tmp_path, profile=profile, analyze=False)
    try:
        evaluated = app._accumulating_series(series_id)
        frozen = app.series_store.state['manifests'][series_id]['manifest']
        assert evaluated['measurementMethod'] == 'area-grid-mean-v1'
        assert evaluated['profile'] == frozen['profile'] == profile
        assert evaluated['profileHash'] == frozen['profileHash']
        assert evaluated['runCount'] == 0
        assert evaluated['pendingRuns']
    finally:
        app.close()
