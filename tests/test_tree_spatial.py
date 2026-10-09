import copy

import cv2
import numpy as np
import pytest

from study_profiles import area_profile, development_profile
from study_video import extract_tree
from tree_spatial import aggregate_cells, grid_cells, track_grid
from study_video import _motion_settings
from test_tree_motion import frames_for_shift


def test_equal_area_cells_have_equal_weight_despite_unequal_sample_density():
    cells = [{'id': 0, 'area': 100, 'minimum_tracks': 1},
             {'id': 1, 'area': 100, 'minimum_tracks': 1}]
    tracks = {0: [[0, 0, 0, 0]] * 10, 1: [[0, 0, 2, 0]]}
    measured = aggregate_cells(cells, tracks, elapsed=1, minimum_coverage=1)
    assert measured['speed'] == pytest.approx(1)
    assert measured['coverage_fraction'] == 1
    missing = aggregate_cells(cells, {0: tracks[0]}, elapsed=1, minimum_coverage=1)
    assert missing['speed'] is None
    assert missing['observed_area_speed'] == 0
    assert missing['coverage_fraction'] == .5


def test_clipped_grid_uses_polygon_pixel_area_and_scaled_counts():
    mask = np.zeros((70, 130), dtype=bool)
    mask[0:64, 0:64] = True
    mask[0:16, 64:80] = True
    cells = grid_cells(mask, 64, 32, 3)
    assert [(cell['area'], cell['budget'], cell['minimum_tracks']) for cell in cells] == [
        (4096, 32, 3), (256, 2, 1)]
    result = aggregate_cells(cells, {0: [[0, 0, 0, 0]] * 3, 1: [[0, 0, 2, 0]]}, 1, 1)
    assert result['speed'] == pytest.approx(2 * 256 / (4096 + 256))


def test_grid_extraction_retains_legacy_control_and_reports_spatial_coverage():
    frames, regions = frames_for_shift(1, 0)
    legacy = extract_tree(copy.deepcopy(frames), [], regions, development_profile())['pairs'][0]
    profile = area_profile()
    profile['video']['measurement'].update(cellSizePixels=80, pointsPerCell=16,
                                            minimumTracksPerCell=1,
                                            minimumSpatialCoverageFraction=.5)
    result = extract_tree(frames, [], regions, profile, retain_tracks=True)
    pair = result['pairs'][0]
    assert legacy['A_speed'] is not None
    assert pair['A_speed'] is not None
    assert pair['A_spatial']['coverage_fraction'] >= .5
    assert pair['B_spatial']['coverage_fraction'] >= .5
    assert pair['A_spatial']['covered_area'] <= pair['A_spatial']['total_area']
    assert pair['A_track_count'] == len(pair['tracks']['A']['accepted'])
    assert result['measurementMethod'] == 'area-grid-mean-v1'


def test_cell_local_detection_returns_global_coordinates_with_clipped_mask(monkeypatch):
    mask = np.zeros((96, 160), dtype=bool)
    mask[32:64, 64:96] = True
    mask[32:35, 64:67] = False
    cells = grid_cells(mask, 32, 1, 1)
    detected_shapes = []
    def detect(crop, *, mask, **_options):
        detected_shapes.append(crop.shape)
        locations = np.argwhere(mask)
        y, x = locations[len(locations) // 2]
        return np.array([[[x, y]]], dtype=np.float32)
    def flow(_previous, _current, points, _following, **_options):
        return points.copy(), np.ones((len(points), 1), dtype=np.uint8), None
    monkeypatch.setattr(cv2, 'goodFeaturesToTrack', detect)
    monkeypatch.setattr(cv2, 'calcOpticalFlowPyrLK', flow)
    image = np.zeros(mask.shape, dtype=np.uint8)
    profile = area_profile()
    result = track_grid(image, image, mask, cells, {}, _motion_settings(profile),
                        profile['video']['measurement'], 1)
    assert detected_shapes and max(shape[0] * shape[1] for shape in detected_shapes) < mask.size / 4
    x, y, _, _ = result['tracks'][0]
    assert mask[int(y), int(x)]
    assert 64 <= x < 96 and 32 <= y < 64


def test_continuous_tracking_rebins_healthy_cross_cell_endpoints(monkeypatch):
    mask = np.ones((32, 64), dtype=bool)
    cells = grid_cells(mask, 32, 1, 1)
    calls = 0
    def flow(_previous, _current, points, _following, **_options):
        nonlocal calls
        calls += 1
        moved = points.copy()
        moved[:, 0, 0] += 2 if calls % 2 else -2
        return moved, np.ones((len(points), 1), dtype=np.uint8), None
    monkeypatch.setattr(cv2, 'calcOpticalFlowPyrLK', flow)
    image = np.zeros(mask.shape, dtype=np.uint8)
    profile = area_profile()
    profile['video']['measurement'].update(cellSizePixels=32, pointsPerCell=1,
                                            minimumTracksPerCell=1, minimumSpatialCoverageFraction=.5,
                                            refreshPolicy='continuous')
    settings = _motion_settings(profile)
    first = track_grid(image, image, mask, cells, {0: np.array([[31., 10.]], dtype=np.float32)},
                       settings, profile['video']['measurement'], 1)
    assert first['tracks'][0][0] == 31 and first['tracks'][0][2] == 33
    assert first['following'][1].tolist() == [[33., 10.]]
    second = track_grid(image, image, mask, cells, first['following'], settings,
                        profile['video']['measurement'], 1)
    assert any(track[0] == 33 for track in second['tracks'])


def _area_fixture(*, moving_cells=(0,), blank_cells=(), duplicate_columns=1):
    cell_size = 64
    columns = max(2, duplicate_columns)
    shape = (192, (columns + 1) * cell_size)
    first = np.full(shape, 100, dtype=np.uint8)
    second = first.copy()
    rng = np.random.default_rng(1947)
    texture = cv2.GaussianBlur(rng.integers(20, 230, (cell_size, cell_size), dtype=np.uint8), (3, 3), .4)
    shifted = cv2.warpAffine(texture, np.float32([[1, 0, 2], [0, 1, 0]]),
                            (cell_size, cell_size), borderMode=cv2.BORDER_REFLECT)
    a = np.zeros(shape, dtype=bool)
    for index in range(columns * 2):
        row, column = divmod(index, columns)
        y, x = row * cell_size, column * cell_size
        if index not in blank_cells:
            first[y:y + cell_size, x:x + cell_size] = texture
            second[y:y + cell_size, x:x + cell_size] = shifted if index in moving_cells else texture
        a[y + 8:y + 56, x + 8:x + 56] = True
    b = np.zeros(shape, dtype=bool)
    b[8:120, columns * cell_size + 8:columns * cell_size + 56] = True
    first[b] = rng.integers(20, 230, np.count_nonzero(b), dtype=np.uint8)
    second[b] = first[b]
    background = np.zeros(shape, dtype=bool)
    background[136:184, 8:columns * cell_size + 56] = True
    first[background] = rng.integers(20, 230, np.count_nonzero(background), dtype=np.uint8)
    second[background] = first[background]
    frames = [{'source_id': 'original', 'recording_id': 'recording', 'frame_index': index,
               'timestamp': index * .04, 'pts': index * .04, 'image': image}
              for index, image in enumerate((first, second))]
    return frames, {'A': a, 'B': b, 'background': background}


def _area_test_profile(coverage=1, refresh='timed'):
    profile = area_profile()
    profile['video']['measurement'].update(cellSizePixels=64, pointsPerCell=16,
                                            minimumTracksPerCell=3,
                                            minimumSpatialCoverageFraction=coverage,
                                            refreshPolicy=refresh)
    return profile


def test_actual_opencv_area_average_is_invariant_when_identical_moving_content_doubles():
    one_frames, one_regions = _area_fixture(moving_cells=(0, 1, 2, 3))
    two_frames, two_regions = _area_fixture(moving_cells=tuple(range(8)), duplicate_columns=4)
    profile = _area_test_profile()
    one = extract_tree(one_frames, [], one_regions, profile)['pairs'][0]
    two = extract_tree(two_frames, [], two_regions, profile)['pairs'][0]
    assert one['A_spatial']['coverage_fraction'] == 1
    assert two['A_spatial']['coverage_fraction'] == 1
    assert two['A_spatial']['total_area'] == 2 * one['A_spatial']['total_area']
    assert one['A_speed'] * .04 == pytest.approx(2, abs=.2)
    assert two['A_speed'] * .04 == pytest.approx(one['A_speed'] * .04, abs=.1)


def test_actual_opencv_moving_minority_and_stationary_texture_remain_distinct_from_unknown():
    frames, regions = _area_fixture(moving_cells=(0,))
    profile = _area_test_profile()
    measured = extract_tree(frames, [], regions, profile, retain_tracks=True)['pairs'][0]
    assert measured['A_spatial']['coverage_fraction'] == 1
    assert measured['A_spatial']['valid_cell_count'] == 4
    assert measured['A_speed'] * .04 == pytest.approx(.5, abs=.12)
    tracks = measured['tracks']['A']['accepted']
    stationary = [np.hypot(u - x, v - y) for x, y, u, v in tracks if not (x < 64 and y < 64)]
    assert len(stationary) >= 9
    assert max(stationary) < .15
    absent_frames, absent_regions = _area_fixture(moving_cells=(0,), blank_cells=(3,))
    unavailable = extract_tree(absent_frames, [], absent_regions, profile)['pairs'][0]
    assert unavailable['A_spatial']['coverage_fraction'] == .75
    assert unavailable['A_spatial']['valid_cell_count'] == 3
    assert unavailable['A_speed'] is None
    observed = extract_tree(absent_frames, [], absent_regions, _area_test_profile(.75))['pairs'][0]
    assert observed['A_speed'] * .04 == pytest.approx(2 / 3, abs=.16)


def test_extraction_continuous_policy_retains_valid_tracks_across_one_second_boundary():
    frames, regions = _area_fixture(moving_cells=())
    first = frames[0]['image']
    frames = [{**frames[0], 'frame_index': index, 'timestamp': timestamp, 'pts': timestamp,
               'image': first.copy()} for index, timestamp in enumerate((.92, .96, 1.0))]
    timed = extract_tree(frames, [], regions, _area_test_profile(refresh='timed'))['pairs']
    continuous = extract_tree(frames, [], regions, _area_test_profile(refresh='continuous'))['pairs']
    assert timed[1]['reseeded'] and continuous[1]['reseeded']
    assert timed[1]['A_spatial']['carried_count'] == 0
    assert continuous[1]['A_spatial']['carried_count'] > 0
    assert continuous[1]['A_spatial']['coverage_fraction'] == 1
