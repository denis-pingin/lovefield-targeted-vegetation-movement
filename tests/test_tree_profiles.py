import copy
import hashlib

import pytest

from study_profiles import ProfileRepository, area_profile, measurement_method, validate_profile


@pytest.mark.parametrize('location', ['video', 'measurement'])
@pytest.mark.parametrize('value', [None, []])
def test_nonmapping_motion_settings_have_explicit_validation_errors(location, value):
    profile = area_profile()
    if location == 'video':
        profile['video'] = value
    else:
        profile['video']['measurement'] = value
    with pytest.raises(ValueError, match='Unsupported|settings'):
        validate_profile(profile)


def test_preparation_profiles_retain_actual_settings_and_exact_bytes(tmp_path):
    repository = ProfileRepository(tmp_path)
    initial = area_profile()
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
    profile = area_profile()
    profile.update(profileId='tree-new-profile', label='Canopy 6000/21 settings')
    profile['video']['featureDetection']['maxCorners'] = 6000
    profile['video']['tracking']['windowSizePixels'] = [21, 21]
    retained = repository.save_new(profile)
    assert ProfileRepository(tmp_path).load(profile['profileId']) == retained
    assert retained['profile'] == profile


@pytest.mark.parametrize('label', ['', '   ', None, 12])
def test_invalid_profile_names_are_rejected(label):
    profile = area_profile()
    profile['label'] = label
    with pytest.raises(ValueError, match='name'):
        validate_profile(profile)


@pytest.mark.parametrize('value', [0, -1, 1.5, True, float('nan'), float('inf')])
def test_invalid_point_counts_are_rejected(value):
    profile = area_profile()
    profile['video']['featureDetection']['maxCorners'] = value
    with pytest.raises(ValueError):
        validate_profile(profile)


@pytest.mark.parametrize('window', [[0, 0], [20, 20], [21, 20], [21.5, 21.5], [float('inf'), 41]])
def test_tracking_window_must_be_positive_odd_integers(window):
    profile = area_profile()
    profile['video']['tracking']['windowSizePixels'] = window
    with pytest.raises(ValueError):
        validate_profile(profile)


def test_scored_profile_cannot_be_rewritten(tmp_path):
    repository = ProfileRepository(tmp_path)
    profile = area_profile()
    changed = copy.deepcopy(profile)
    changed['video']['featureDetection']['maxCorners'] = 1500
    with pytest.raises(ValueError, match='scored|frozen'):
        repository.save_new(changed, purpose='scored')


@pytest.mark.parametrize('purpose', ['preparation', 'scored'])
def test_unsupported_profile_is_rejected_for_every_purpose_without_writes(tmp_path, purpose):
    profile = area_profile()
    profile['version'] = 'tree-profile-development-1'
    profile['profileId'] = 'unsupported-settings'
    del profile['video']['measurement']
    with pytest.raises(ValueError, match='Unsupported'):
        validate_profile(profile)
    if purpose == 'preparation':
        with pytest.raises(ValueError, match='Unsupported'):
            ProfileRepository(tmp_path).save_new(profile, purpose=purpose)
    assert not list(tmp_path.iterdir())


def test_canonical_profile_is_the_only_builtin(tmp_path):
    from study_profiles import canonical_profile, BUILTIN_PROFILE_PATHS, AREA_GRID_MEAN
    repository = ProfileRepository(tmp_path)
    assert canonical_profile() == area_profile()
    assert list(BUILTIN_PROFILE_PATHS) == ['tree-development-area-1']
    assert measurement_method(canonical_profile()) == AREA_GRID_MEAN
    assert repository.load('tree-development-area-1')['profile'] == canonical_profile()


def test_custom_grid_profile_retains_every_tuning_value(tmp_path):
    profile = area_profile()
    profile.update(profileId='custom-canopy', label='Continuous canopy')
    profile['video']['measurement'].update(cellSizePixels=96, pointsPerCell=24,
        minimumTracksPerCell=4, minimumSpatialCoverageFraction=.98, refreshPolicy='continuous')
    profile['video']['featureDetection'].update(minDistancePixels=9, qualityLevel=.02)
    profile['video']['tracking']['windowSizePixels'] = [31, 31]
    saved = ProfileRepository(tmp_path).save_new(profile)
    assert ProfileRepository(tmp_path).load('custom-canopy') == saved
    assert saved['profile'] == profile


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
