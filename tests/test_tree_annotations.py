import hashlib
import json

import cv2
import numpy as np
import pytest

from study_profiles import area_profile, development_profile
from study_timing import inspect_video_timeline, video_end_seconds
from study_video import read_frames, extract_tree, _tracking_preview_image
from tree_annotations import export_annotated_clip


def test_bounded_annotation_uses_same_tracks_and_source_cadence(tmp_path):
    path = tmp_path / 'translated.avi'
    rng = np.random.default_rng(204)
    base = rng.integers(0, 255, (120, 180), dtype=np.uint8)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), 25., (180, 120))
    for index in range(40):
        frame = cv2.warpAffine(base, np.float32([[1, 0, index * .3], [0, 1, 0]]), (180, 120), borderMode=cv2.BORDER_REFLECT)
        writer.write(cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR))
    writer.release()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    video = {'path': str(path), 'sha256': digest, 'recordingId': 'movie',
             'clockMap': {'rate': 1., 'offset_seconds': 0., 'residual_seconds': 0.},
             'frameTimeline': inspect_video_timeline(path)}
    regions = {name: np.zeros((120, 180), dtype=bool) for name in ('A', 'B', 'background')}
    for index, region in enumerate(regions.values()): region[15:105, index * 60 + 5:index * 60 + 55] = True
    profile = development_profile()
    profile['video']['shake']['minimumBackgroundDisplacementPixels'] = 100.
    expected = extract_tree(read_frames([{'source_id': 'movie', 'recording_id': 'movie', 'path': str(path), 'sha256': digest}], {'movie': video['clockMap']}), [], regions, profile, retain_tracks=True)
    output = export_annotated_clip(video, regions, profile, .8, .4, tmp_path / 'annotation.avi')
    capture = cv2.VideoCapture(str(tmp_path / 'annotation.avi'))
    assert capture.get(cv2.CAP_PROP_FPS) == 25
    assert capture.get(cv2.CAP_PROP_FRAME_COUNT) == 10
    capture.release()
    rows = [json.loads(line) for line in (tmp_path / 'annotation.tracks.jsonl').read_text().splitlines()]
    assert [row['frameIndex'] for row in rows] == list(range(20, 30))
    assert output['frames'] == 10
    for row in rows:
        original = next(pair for pair in expected['pairs'] if pair['last_frame_index'] == row['frameIndex'])
        assert row['tracks'] == original['tracks']
        assert row['acceptedCounts']['A'] == len(original['tracks']['A']['accepted'])
        for x, y, u, v in row['tracks']['A']['accepted']:
            assert regions['A'][int(v), int(u)]
        assert np.mean([u - x for x, y, u, v in row['tracks']['A']['accepted']]) == pytest.approx(.3, abs=.15)
    assert path.read_bytes() and hashlib.sha256(path.read_bytes()).hexdigest() == digest


def test_full_length_annotation_includes_first_and_last_source_frames(tmp_path):
    path = tmp_path / 'long-camera.avi'
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), 2., (120, 80))
    assert writer.isOpened()
    rng = np.random.default_rng(205)
    frame = rng.integers(0, 255, (80, 120, 3), dtype=np.uint8)
    for _ in range(122):
        writer.write(frame)
    writer.release()
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    video = {'path': str(path), 'sha256': source_hash, 'recordingId': 'long-camera',
             'frameTimeline': inspect_video_timeline(path)}
    regions = {name: np.zeros((80, 120), dtype=bool) for name in ('A', 'B', 'background')}
    for index, region in enumerate(regions.values()):
        region[5:75, index * 40 + 2:index * 40 + 38] = True
    profile = development_profile()
    output = export_annotated_clip(video, regions, profile, 0, 61, tmp_path / 'full.avi')
    rows = [json.loads(line) for line in (tmp_path / 'full.tracks.jsonl').read_text().splitlines()]
    capture = cv2.VideoCapture(str(tmp_path / 'full.avi'))
    assert capture.get(cv2.CAP_PROP_FRAME_COUNT) == 122
    capture.release()
    assert output['frames'] == len(rows) == 122
    assert (output['startPtsSeconds'], output['lastPtsSeconds']) == (0, 60.5)
    assert (rows[0]['frameIndex'], rows[-1]['frameIndex']) == (0, 121)
    assert output['sourceSha256'] == source_hash
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source_hash


def test_video_endpoint_uses_final_interval_without_display_float_noise():
    timeline = {'frameRate': 25, 'frames': [
        {'frameIndex': 0, 'ptsSeconds': 0},
        {'frameIndex': 1, 'ptsSeconds': 316.28},
        {'frameIndex': 2, 'ptsSeconds': 316.3}]}
    assert video_end_seconds(timeline) == 316.32
    assert video_end_seconds({'frameRate': 25, 'frames': [{'frameIndex': 0, 'ptsSeconds': 0}]}) == .04
    with pytest.raises(ValueError, match='interval'):
        video_end_seconds({'frameRate': 25, 'frames': [
            {'frameIndex': 0, 'ptsSeconds': 1}, {'frameIndex': 1, 'ptsSeconds': 1}]})


def test_display_magnification_changes_only_colored_annotation_not_track_coordinates(tmp_path):
    path = tmp_path / 'stationary.avi'
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), 25., (180, 120))
    assert writer.isOpened()
    rng = np.random.default_rng(99)
    image = rng.integers(50, 200, (120, 180, 3), dtype=np.uint8)
    for _ in range(4): writer.write(image)
    writer.release()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    video = {'path': str(path), 'sha256': digest, 'recordingId': 'still',
             'frameTimeline': inspect_video_timeline(path)}
    regions = {name: np.zeros((120, 180), dtype=bool) for name in ('A', 'B', 'background')}
    for index, region in enumerate(regions.values()): region[10:110, index * 60 + 5:index * 60 + 55] = True
    profile = area_profile()
    profile['video']['measurement'].update(cellSizePixels=32, pointsPerCell=8,
                                            minimumTracksPerCell=1, minimumSpatialCoverageFraction=.1)
    first = export_annotated_clip(video, regions, profile, 0, .16, tmp_path / 'one.avi', display_magnification=1)
    second = export_annotated_clip(video, regions, profile, 0, .16, tmp_path / 'ten.avi', display_magnification=10)
    rows = lambda name: [json.loads(line) for line in (tmp_path / f'{name}.tracks.jsonl').read_text().splitlines()]
    assert [row['tracks'] for row in rows('one')] == [row['tracks'] for row in rows('ten')]
    assert [row['spatial'] for row in rows('one')] == [row['spatial'] for row in rows('ten')]
    assert first['displayMagnification'] == 1 and second['displayMagnification'] == 10


def test_annotation_uses_readable_non_green_target_colors_on_green_pixels():
    image = np.full((80, 160, 3), (10, 180, 10), dtype=np.uint8)
    regions = {name: np.zeros((80, 160), dtype=bool) for name in ('A', 'B', 'background')}
    regions['A'][10:70, 5:65] = True
    regions['B'][10:70, 80:140] = True
    regions['background'][70:79, 5:155] = True
    measured = {'A': {'tracks': [[25, 30, 26, 30]]}, 'B': {'tracks': [[100, 30, 101, 30]]}}
    rendered = _tracking_preview_image({'image': image}, regions, measured, display_magnification=10)
    assert rendered[30, 26, 0] > 180 and rendered[30, 26, 2] > 180  # Magenta A (BGR).
    assert rendered[30, 101, 0] > 180 and rendered[30, 101, 1] > 150  # Cyan B (BGR).


def test_full_resolution_annotation_survives_desktop_downscaling():
    image = np.full((2160, 3840, 3), (10, 180, 10), dtype=np.uint8)
    regions = {name: np.zeros((2160, 3840), dtype=bool) for name in ('A', 'B', 'background')}
    regions['A'][200:1900, 100:1850] = True
    regions['B'][200:1900, 2000:3750] = True
    regions['background'][2000:2100, 100:3750] = True
    measured = {'A': {'tracks': [[1000, 1000, 1002, 1000]]},
                'B': {'tracks': [[3000, 1000, 3002, 1000]]}}
    rendered = _tracking_preview_image({'image': image}, regions, measured, display_magnification=10)
    viewed = cv2.resize(rendered, (960, 540), interpolation=cv2.INTER_AREA)
    a = viewed[245:255, 245:260]
    b = viewed[245:255, 745:760]
    assert np.count_nonzero((a[:, :, 0] > 50) & (a[:, :, 2] > 50)) >= 3
    assert np.count_nonzero((b[:, :, 0] > 50) & (b[:, :, 1] > 140)) >= 3


def test_dense_full_resolution_tracks_preserve_source_texture_and_colored_marks():
    rng = np.random.default_rng(311)
    image = rng.integers(30, 190, (2160, 3840, 3), dtype=np.uint8)
    image[:, :, 1] = rng.integers(130, 220, (2160, 3840), dtype=np.uint8)
    regions = {name: np.zeros((2160, 3840), dtype=bool) for name in ('A', 'B', 'background')}
    regions['A'][800:1400, 800:1700] = True
    tracks = [[x, y, x + 2, y] for y in range(1008, 1160, 16)
              for x in range(1008, 1160, 16)]
    tracks.append([1400, 1000, 1420, 1000])
    rendered = _tracking_preview_image({'image': image}, regions,
                                       {'A': {'tracks': tracks}}, display_magnification=1)
    source_patch = image[1000:1160, 1000:1160]
    rendered_patch = rendered[1000:1160, 1000:1160]
    assert np.mean(np.all(source_patch == rendered_patch, axis=2)) > .6
    assert np.array_equal(rendered[1008, 1010], (255, 0, 255))
    assert rendered[1000, 1410, 0] > 180 and rendered[1000, 1410, 2] > 180
    assert np.array_equal(rendered[1004, 1410], image[1004, 1410])


def _clipped_unknown_cell_preview(monkeypatch):
    image = np.full((160, 160, 3), (10, 180, 10), dtype=np.uint8)
    regions = {name: np.zeros((160, 160), dtype=bool) for name in ('A', 'B', 'background')}
    regions['A'][:65, :65] = True
    regions['B'][10:80, 100:150] = True
    regions['background'][100:150, 10:100] = True
    cell = {'id': 3, 'x': 64, 'y': 64, 'right': 128, 'bottom': 128,
            'area': 1, 'reason': 'insufficient_tracks', 'accepted_count': 0}
    spatial = {'cells': [cell], 'covered_area': 4224, 'total_area': 4225,
               'coverage_fraction': 4224 / 4225}
    labels = []
    original_put_text = cv2.putText
    def capture(*args, **kwargs):
        labels.append(args[1])
        return original_put_text(*args, **kwargs)
    monkeypatch.setattr(cv2, 'putText', capture)
    rendered = _tracking_preview_image({'image': image}, regions, {'A': {'tracks': [], 'spatial': spatial}})
    return regions['A'], rendered, labels


def test_unknown_clipped_cell_annotation_marks_only_its_selected_polygon_pixels(monkeypatch):
    mask, rendered, _ = _clipped_unknown_cell_preview(monkeypatch)
    red = (rendered[:, :, 2] > 160) & (rendered[:, :, 1] < 80) & (rendered[:, :, 0] < 80)
    assert np.count_nonzero(red & mask) > 0
    assert np.count_nonzero(red & ~mask) == 0


def test_rounded_full_coverage_annotation_still_names_nonzero_unknown_area(monkeypatch):
    _, _, labels = _clipped_unknown_cell_preview(monkeypatch)
    coverage = next(text for text in labels if text.startswith('A measured area'))
    assert '100.0%' in coverage
    assert '1 px unknown' in coverage


def test_coverage_label_is_clamped_within_image_at_right_polygon_boundary(monkeypatch):
    image = np.full((540, 960, 3), (10, 180, 10), dtype=np.uint8)
    regions = {name: np.zeros((540, 960), dtype=bool) for name in ('A', 'B', 'background')}
    regions['A'][50:420, 100:400] = True
    regions['B'][50:420, 760:950] = True
    regions['background'][460:520, 200:740] = True
    spatial = {'cells': [], 'covered_area': 9990, 'total_area': 10000,
               'coverage_fraction': .999}
    labels = []
    original_put_text = cv2.putText
    def capture(*args, **kwargs):
        if args[1].startswith(('A measured area', 'B measured area')):
            labels.append((args[1], args[2], args[3], args[4], args[6]))
        return original_put_text(*args, **kwargs)
    monkeypatch.setattr(cv2, 'putText', capture)
    _tracking_preview_image({'image': image}, regions,
                            {'A': {'tracks': [], 'spatial': spatial},
                             'B': {'tracks': [], 'spatial': spatial}})
    assert len(labels) == 4
    for label, (x, _), font, scale, thickness in labels:
        width = cv2.getTextSize(label, font, scale, thickness)[0][0]
        assert x >= thickness
        assert x + width + thickness <= image.shape[1]
    assert next(x for label, (x, _), *_ in labels if label.startswith('B measured area')) < 760


@pytest.mark.parametrize('start,duration', [(-1, 1), (0, 0), (0, float('nan')),
                                            (float('inf'), 1), (61, 1), (60.5, .6), (0, 100000)])
def test_annotation_rejects_unbounded_or_invalid_requests(tmp_path, start, duration):
    video = {'frameTimeline': {'frameRate': 2, 'frames': [
        {'frameIndex': 120, 'ptsSeconds': 60}, {'frameIndex': 121, 'ptsSeconds': 60.5}]}}
    with pytest.raises(ValueError, match='duration|start|range|video'):
        export_annotated_clip(video, {}, development_profile(), start, duration, tmp_path / 'clip.avi')
    assert not (tmp_path / 'clip.avi').exists()
