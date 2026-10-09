import copy
import hashlib

import pytest

from study_profiles import ProfileRepository, area_profile, development_profile, measurement_method, validate_profile


def test_preparation_profiles_retain_actual_settings_and_exact_bytes(tmp_path):
    repository = ProfileRepository(tmp_path)
    initial = development_profile()
    initial['profileId'] = 'candidate-one'
    first = repository.save_new(initial)
    changed = copy.deepcopy(initial)
    changed['profileId'] = 'candidate-two'
    changed['video']['featureDetection']['maxCorners'] = 1500
    changed['video']['tracking']['windowSizePixels'] = [21, 21]
    second = repository.save_new(changed)
    restarted = ProfileRepository(tmp_path)
    assert restarted.load(first['profile']['profileId'])['profile'] == initial
    assert restarted.load(second['profile']['profileId'])['profile'] == changed
    assert hashlib.sha256(first['sealedProfileJson'].encode()).hexdigest() == first['sha256']
    assert restarted.load(first['profile']['profileId']) == first
    with pytest.raises(ValueError, match='exists'):
        repository.save_new(changed)


def test_profile_name_preserves_spaces_slashes_and_actual_settings(tmp_path):
    repository = ProfileRepository(tmp_path)
    profile = development_profile()
    profile.update(profileId='tree-new-profile', label='Tree 6000/21 - mean-track analysis')
    profile['video']['featureDetection']['maxCorners'] = 6000
    profile['video']['tracking']['windowSizePixels'] = [21, 21]
    retained = repository.save_new(profile)
    assert ProfileRepository(tmp_path).load(profile['profileId']) == retained
    assert retained['profile'] == profile


@pytest.mark.parametrize('label', ['', '   ', None, 12])
def test_invalid_profile_names_are_rejected(label):
    profile = development_profile()
    profile['label'] = label
    with pytest.raises(ValueError, match='name'):
        validate_profile(profile)


@pytest.mark.parametrize('value', [0, -1, 1.5, True, float('nan'), float('inf')])
def test_invalid_point_counts_are_rejected(value):
    profile = development_profile()
    profile['video']['featureDetection']['maxCorners'] = value
    with pytest.raises(ValueError):
        validate_profile(profile)


@pytest.mark.parametrize('window', [[0, 0], [20, 20], [21, 20], [21.5, 21.5], [float('inf'), 41]])
def test_tracking_window_must_be_positive_odd_integers(window):
    profile = development_profile()
    profile['video']['tracking']['windowSizePixels'] = window
    with pytest.raises(ValueError):
        validate_profile(profile)


def test_scored_profile_cannot_be_rewritten(tmp_path):
    repository = ProfileRepository(tmp_path)
    profile = development_profile()
    changed = copy.deepcopy(profile)
    changed['video']['featureDetection']['maxCorners'] = 1500
    with pytest.raises(ValueError, match='scored|frozen'):
        repository.save_new(changed, purpose='scored')


def test_legacy_and_area_profile_round_trip_with_distinct_measurements(tmp_path):
    repository = ProfileRepository(tmp_path)
    legacy = development_profile()
    legacy['profileId'] = 'legacy-copy'
    saved_legacy = repository.save_new(legacy)
    assert repository.load('legacy-copy') == saved_legacy
    assert measurement_method(legacy) == 'feature-mean-v1'
    candidate = area_profile()
    assert candidate['version'] == 'tree-profile-development-2'
    assert measurement_method(candidate) == 'area-grid-mean-v1'
    assert validate_profile(candidate) == candidate
    candidate['profileId'] = 'area-copy'
    saved_area = repository.save_new(candidate)
    assert repository.load('area-copy') == saved_area
    with pytest.raises(ValueError, match='scored|frozen'):
        repository.save_new({**candidate, 'profileId': 'area-scored'}, purpose='scored')


@pytest.mark.parametrize(('field', 'invalid'), [
    ('cellSizePixels', 0), ('cellSizePixels', 1.5), ('cellSizePixels', True),
    ('pointsPerCell', 0), ('pointsPerCell', float('nan')),
    ('minimumTracksPerCell', 0), ('minimumTracksPerCell', 33),
    ('minimumSpatialCoverageFraction', 0), ('minimumSpatialCoverageFraction', 1.01),
    ('refreshPolicy', 'unknown'),
])
def test_area_profile_rejects_invalid_measurement_settings(field, invalid):
    profile = area_profile()
    profile['video']['measurement'][field] = invalid
    with pytest.raises(ValueError):
        validate_profile(profile)
