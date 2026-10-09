import copy
import hashlib
import json

import pytest

from study_profiles import area_profile, development_profile
from tree_comparisons import ComparisonStore
from tree_series import accumulate_series, profile_hash
from test_tree_series import result


def loaded(profile):
    sealed = json.dumps(profile, sort_keys=True, separators=(',', ':'))
    return {'profile': profile, 'sha256': hashlib.sha256(sealed.encode()).hexdigest(),
            'sealedProfileJson': sealed}


def artifact(run, profile, analysis_id):
    value = copy.deepcopy(run)
    value['profile'] = copy.deepcopy(profile)
    value['profileHash'] = profile_hash(profile)
    value['measurementMethod'] = profile.get('video', {}).get('measurement', {}).get('method', 'feature-mean-v1')
    value['revisionId'] = analysis_id
    value['analysisVersion'] = 'tree-analysis-development-1'
    return {'status': 'completed', 'runId': value['runId'], 'analysisId': analysis_id,
            'profileId': profile['profileId'], 'profileSha256': loaded(profile)['sha256'],
            'bundleSha256': f"bundle-{value['runId']}", 'inputHashes': {'original': f"original-{value['runId']}"},
            'derivedInputHashes': {'clock': f"clock-{value['runId']}"},
            'codeSha256': f'code-{analysis_id}', 'result': value}


def paired(run_id, created):
    base = result(run_id, created)
    return {'runId': run_id,
            'left': artifact(base, development_profile(), f'{run_id}-left'),
            'right': artifact(base, area_profile(), f'{run_id}-right')}


def test_saved_comparison_has_independent_exact_accumulations_and_survives_restart(tmp_path):
    rows = [paired('one', 1000), paired('two', 10000)]
    store = ComparisonStore(tmp_path)
    saved = store.create('Spatial comparison', loaded(development_profile()), loaded(area_profile()), rows)
    assert saved['left']['runIds'] == saved['right']['runIds'] == ['one', 'two']
    assert saved['left']['targetCount'] == saved['right']['targetCount']
    assert saved['left']['logEvidence'] == accumulate_series([row['left']['result'] for row in rows], development_profile())['logEvidence']
    assert saved['right']['logEvidence'] == accumulate_series([row['right']['result'] for row in rows], area_profile())['logEvidence']
    assert saved['rows'][0]['leftInputHashes'] == rows[0]['left']['inputHashes']
    assert saved['rows'][0]['rightDerivedInputHashes'] == rows[0]['right']['derivedInputHashes']
    assert ComparisonStore(tmp_path).get(saved['comparisonId']) == saved
    rows[0]['left']['result']['targets'].clear()
    assert ComparisonStore(tmp_path).get(saved['comparisonId']) == saved
    assert store.list()[0]['comparisonId'] == saved['comparisonId']


def test_missing_or_mismatched_side_holds_the_common_prefix_and_retains_rows(tmp_path):
    rows = [paired('one', 1000), paired('two', 10000), paired('three', 20000)]
    rows[1]['right']['inputHashes']['original'] = 'different-source'
    rows[2]['left'] = None
    saved = ComparisonStore(tmp_path).create('Stopped prefix', loaded(development_profile()), loaded(area_profile()), rows)
    assert saved['left']['runIds'] == saved['right']['runIds'] == ['one']
    assert [row['status'] for row in saved['rows']] == ['paired', 'source_mismatch', 'missing_left']
    assert [row['runId'] for row in saved['rows']] == ['one', 'two', 'three']


@pytest.mark.parametrize('missing_side', ['left', 'right'])
def test_completed_individual_side_remains_visible_when_other_side_is_missing(tmp_path, missing_side):
    rows = [paired('one', 1000), paired('two', 10000)]
    available_side = 'right' if missing_side == 'left' else 'left'
    available = rows[1][available_side]
    rows[1][missing_side] = None
    saved = ComparisonStore(tmp_path).create('Partial pair', loaded(development_profile()),
                                             loaded(area_profile()), rows)
    individual = saved['rows'][1][f'{available_side}Individual']
    profile = area_profile() if available_side == 'right' else development_profile()
    expected = accumulate_series([available['result']], profile)
    assert individual['revisionId'] == available['analysisId']
    assert individual['effect'] == expected['full']['estimate']
    assert individual['evidence'] == expected['evidenceLabel']
    assert individual['usableBinCount'] == expected['usableBinCount']
    assert individual['missingBinCount'] == expected['missingBinCount']
    assert saved['rows'][1].get(f'{missing_side}Individual') is None
    assert saved['rows'][1]['status'] == f'missing_{missing_side}'
    assert saved['left']['runIds'] == saved['right']['runIds'] == ['one']


def test_duplicate_or_scored_comparison_is_refused(tmp_path):
    row = paired('one', 1000)
    store = ComparisonStore(tmp_path)
    with pytest.raises(ValueError, match='once|duplicate'):
        store.create('duplicate', loaded(development_profile()), loaded(area_profile()), [row, row])
    scored = paired('two', 10000)
    scored['left']['result']['purpose'] = 'scored'
    with pytest.raises(ValueError, match='preparation|scored'):
        store.create('scored', loaded(development_profile()), loaded(area_profile()), [scored])


def test_distinct_timed_and_continuous_grid_profiles_can_be_compared(tmp_path):
    timed = area_profile()
    continuous = copy.deepcopy(timed)
    continuous['profileId'] = 'continuous-grid'
    continuous['video']['measurement']['refreshPolicy'] = 'continuous'
    base = result('one', 1000)
    row = {'runId': 'one', 'left': artifact(base, timed, 'timed-revision'),
           'right': artifact(base, continuous, 'continuous-revision')}
    saved = ComparisonStore(tmp_path).create('Refresh comparison', loaded(timed), loaded(continuous), [row])
    assert saved['rows'][0]['status'] == 'paired'
    assert saved['commonPrefixRunIds'] == ['one']
