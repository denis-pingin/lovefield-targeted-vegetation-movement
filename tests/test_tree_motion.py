import cv2
import numpy as np
import pytest

from study_profiles import development_profile
from study_video import extract_tree, mean_feature_speed


def frames_for_shift(dx, dy, *, brightness=0, minority=False):
    random = np.random.default_rng(882)
    first = random.integers(25, 200, (400, 500), dtype=np.uint8)
    first = cv2.GaussianBlur(first, (3, 3), .4)
    second = first.copy()
    moved = cv2.warpAffine(first, np.float32([[1, 0, dx], [0, 1, dy]]),
                           (500, 400), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    second[10:230, 10:230] = moved[10:230, 10:230]
    if minority:
        second = first.copy()
        second[20:110, 20:110] = moved[20:110, 20:110]
    if brightness:
        second = (second.astype(np.int16) + brightness).clip(0, 255).astype(np.uint8)
    a, b, background = (np.zeros(first.shape, dtype=bool) for _ in range(3))
    a[40:200, 40:200] = True
    if minority:
        a[:] = False
        a[45:85, 45:85] = True
        a[140:210, 40:220] = True
    b[40:200, 290:460] = True
    background[290:370, 40:460] = True
    frames = [{'source_id': 'original', 'recording_id': 'recording', 'frame_index': index,
               'timestamp': index * .04, 'pts': index * .04, 'image': image}
              for index, image in enumerate((first, second))]
    return frames, {'A': a, 'B': b, 'background': background}


def test_minority_motion_arithmetic():
    assert mean_feature_speed([0.] * 90 + [1.] * 10, .04) == pytest.approx(2.5)


@pytest.mark.parametrize('dx,dy', [(0, 0), (.25, 0), (1, 0), (3, 0), (0, .25), (0, 1), (0, 3), (.25, .25), (1, 1), (3, 3)])
def test_actual_tracker_measures_known_displacements(dx, dy):
    frames, regions = frames_for_shift(dx, dy)
    result = extract_tree(frames, [], regions, development_profile())
    pair = result['pairs'][0]
    supplied = float(np.hypot(dx, dy))
    assert pair['A_speed'] * .04 == pytest.approx(supplied, abs=max(.1, supplied * .1))
    assert pair['B_speed'] * .04 <= .05
    assert pair['A_track_count'] >= 20
    assert pair['background_track_count'] >= 10
    assert not pair['quality_reasons']


def test_uniform_brightness_does_not_invent_motion():
    frames, regions = frames_for_shift(0, 0, brightness=12)
    pair = extract_tree(frames, [], regions, development_profile())['pairs'][0]
    assert pair['A_speed'] * .04 <= .05
    assert pair['B_speed'] * .04 <= .05


def test_localized_motion_is_mean_at_accepted_feature_positions():
    frames, regions = frames_for_shift(1, 0, minority=True)
    result = extract_tree(frames, [], regions, development_profile(), retain_tracks=True)
    pair = result['pairs'][0]
    tracks = pair['tracks']['A']['accepted']
    expected = sum(x < 110 and y < 110 for x, y, _, _ in tracks) / len(tracks)
    assert 0 < expected < .5
    assert pair['A_speed'] * .04 == pytest.approx(expected, abs=.1)
    assert pair['A_speed'] * .04 > .02


def test_untrackable_region_is_unavailable_with_coverage():
    frames, regions = frames_for_shift(0, 0)
    for frame in frames:
        frame['image'][regions['A']] = 0
    result = extract_tree(frames, [{'interval_id': 'response', 'recording_id': 'recording',
                                  'start': 0, 'end': .04}], regions, development_profile())
    pair = result['pairs'][0]
    assert pair['A_speed'] is None
    assert pair['A_track_count'] < 20
    assert 'insufficient_tracks_A' in pair['quality_reasons']
    assert result['intervals'][0]['coverage_fraction'] == 0
    assert result['intervals'][0]['A_motion'] is None


def test_tracker_retains_forward_rejections_for_annotation_diagnostics(monkeypatch):
    frames, regions = frames_for_shift(0, 0)
    original = cv2.calcOpticalFlowPyrLK
    calls = 0
    def flow(previous, current, points, following, **options):
        nonlocal calls
        calls += 1
        tracked, status, error = original(previous, current, points, following, **options)
        if calls % 2 == 1 and len(points) >= 30:
            status[:3] = 0
        return tracked, status, error
    monkeypatch.setattr(cv2, 'calcOpticalFlowPyrLK', flow)
    pair = extract_tree(frames, [], regions, development_profile(), retain_tracks=True)['pairs'][0]
    rejected = pair['tracks']['A']['rejected']
    assert len(rejected) >= 3
    assert all(np.isfinite(track).all() for track in rejected)
    assert len(pair['tracks']['A']['accepted']) == pair['A_track_count']
