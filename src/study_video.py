"""Label-blind original-resolution Tree tracking and retained frame-pair diagnostics."""
import hashlib
import logging
import math
from copy import deepcopy
from pathlib import Path
import cv2
import numpy as np
from tree_calculator import mean_feature_speed
LOGGER = logging.getLogger(__name__)
class VideoQualityError(ValueError):
    """An original recording or a required camera measurement is unusable."""


def _finite(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float, np.number)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return float(value)


def _digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _clock_settings(mapping):
    if "rate" not in mapping:
        raise ValueError("Video needs a saved measured clock map")
    rate = _finite(mapping["rate"], "clock rate")
    offset = _finite(mapping["offset_seconds"], "clock offset")
    residual = _finite(mapping["residual_seconds"], "clock residual")
    uncertainty = _finite(mapping.get("uncertainty_seconds", 0.0), "clock uncertainty")
    if rate <= 0 or residual < 0 or uncertainty < 0 or residual + uncertainty > 1:
        raise ValueError("Video clock mapping needs a positive rate and uncertainty at most one second")
    return rate, offset


def read_frames(sources, clock_maps, progress=None):
    """Yield timestamped frames without loading a clip into memory or decoding audio.

    Sources contain source_id (clip), recording_id (collection), path and sha256.
    Each clip requires its own fitted clock map or synchronization references.
    Timestamp gaps are retained for the frozen cadence check during extraction.
    """
    previous_timestamp = None
    previous_interval = None
    seen = set()
    for source in sources:
        source_id = source["source_id"]
        if not isinstance(source_id, str) or not source_id or source_id in seen:
            raise ValueError("Every video segment needs a distinct source_id")
        recording_id = source.get("recording_id")
        if not isinstance(recording_id, str) or not recording_id:
            raise VideoQualityError(f"Video segment {source_id} has no collection recording identity")
        seen.add(source_id)
        if source_id not in clock_maps:
            raise ValueError(f"Video segment {source_id} has no individual clock mapping")
        rate, offset = _clock_settings(clock_maps[source_id])
        path = Path(source["path"])
        if not path.is_file():
            raise VideoQualityError(f"Original video {source_id} is missing")
        expected_hash = source["sha256"]
        if _digest(path) != expected_hash:
            raise VideoQualityError(f"Original video {source_id} changed before decoding")
        capture = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
        try:
            if not capture.isOpened() or capture.getBackendName().upper() != "FFMPEG":
                raise VideoQualityError(f"Video {source_id} requires the FFmpeg decoder")
            fps = capture.get(cv2.CAP_PROP_FPS)
            if not math.isfinite(fps) or fps <= 0:
                raise VideoQualityError(f"Video {source_id} has no positive presentation time base")
            declared_count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
            previous_pts = None
            frame_index = 0
            while True:
                success, image = capture.read()
                if not success:
                    break
                pts = capture.get(cv2.CAP_PROP_PTS)
                if not math.isfinite(pts) or (previous_pts is not None and pts <= previous_pts):
                    raise VideoQualityError(f"Video {source_id} frame {frame_index} has invalid presentation timestamps")
                timestamp = pts / fps * rate + offset
                if not math.isfinite(timestamp):
                    raise VideoQualityError(f"Video {source_id} frame {frame_index} has invalid mapped timestamps")
                if previous_timestamp is not None and timestamp <= previous_timestamp:
                    raise VideoQualityError(f"Video segment {source_id} overlaps the preceding timestamps")
                segment_start = frame_index == 0
                preceding_gap = None
                if segment_start and previous_timestamp is not None:
                    preceding_gap = timestamp - previous_timestamp - previous_interval
                if progress:
                    progress(stage='Decoding and measuring motion', completed=frame_index + 1,
                             total=int(declared_count) if math.isfinite(declared_count) and declared_count > 0 else None,
                             unit='frames', videoSeconds=float(pts / fps))
                yield {
                    "source_id": source_id,
                    "recording_id": recording_id,
                    "frame_index": frame_index,
                    "pts": float(pts),
                    "device_time": float(pts / fps),
                    "timestamp": timestamp,
                    "image": image,
                    "segment_start": segment_start,
                    "preceding_gap_seconds": preceding_gap,
                }
                previous_pts = pts
                previous_timestamp = timestamp
                previous_interval = rate / fps
                frame_index += 1
            if frame_index == 0:
                raise VideoQualityError(f"Video {source_id} contains no decoded frames")
            if math.isfinite(declared_count) and declared_count > 0 and frame_index < int(round(declared_count)):
                raise VideoQualityError(f"Video {source_id} stopped decoding before its declared frame count")
            if _digest(path) != expected_hash:
                raise VideoQualityError(f"Original video {source_id} changed during decoding")
        finally:
            capture.release()


def _mask(mask, shape, name):
    result = np.asarray(mask)
    if result.shape != shape or result.dtype != bool or not np.any(result):
        raise ValueError(f"Frozen {name} mask must be nonempty, boolean and match the reference")
    return result


MOTION_VERSION = "tree-mean-track-development-1"


MOTION_DEFAULTS = {
    "features": {"maxCorners": 200, "qualityLevel": 0.01, "minDistance": 7, "blockSize": 7},
    "tracking": {"winSize": [21, 21], "maxLevel": 3, "maxIterations": 30, "epsilon": 0.01},
    "forward_backward_error_pixels": 1.0,
    "minimum_target_tracks": 20,
    "minimum_background_tracks": 10,
    "reseed_seconds": 1.0,
    "minimum_coverage_fraction": 0.95,
    "maximum_pair_gap_seconds": 1.0,
    "maximum_cadence_multiple": 3.0,
    "shake_displacement_pixels": 0.5,
    "shake_consecutive_pairs": 3,
}


def _motion_settings(profile):
    if not isinstance(profile, dict):
        raise ValueError("Video motion profile must be a mapping")
    if "video" in profile and "featureDetection" in profile["video"]:
        from study_profiles import tracking_settings
        profile = tracking_settings(profile)
    supplied = profile.get("video", profile)
    if not isinstance(supplied, dict):
        raise ValueError("Video motion settings must be a mapping")
    settings = deepcopy(MOTION_DEFAULTS)
    allowed = set(settings)
    if set(supplied) - allowed:
        raise ValueError("Video motion profile contains an unknown setting")
    for key, value in supplied.items():
        if key in ("features", "tracking"):
            if not isinstance(value, dict) or set(value) - set(settings[key]):
                raise ValueError(f"Video {key} settings are invalid")
            settings[key].update(value)
        else:
            settings[key] = value
    features = settings["features"]
    tracking = settings["tracking"]
    for key in ("maxCorners", "blockSize"):
        value = features[key]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"Video {key} must be a positive integer")
    if _finite(features["minDistance"], "minDistance") <= 0:
        raise ValueError("Video minDistance must be positive")
    if not 0 < _finite(features["qualityLevel"], "qualityLevel") <= 1:
        raise ValueError("Video qualityLevel must be between zero and one")
    for key in ("maxLevel", "maxIterations"):
        value = tracking[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < (0 if key == "maxLevel" else 1):
            raise ValueError(f"Video {key} is invalid")
    win_size = tracking["winSize"]
    if not isinstance(win_size, (list, tuple)) or len(win_size) != 2 or any(
        isinstance(value, bool) or not isinstance(value, int) or value < 1 for value in win_size
    ):
        raise ValueError("Video LK window size is invalid")
    if _finite(tracking["epsilon"], "tracking epsilon") <= 0:
        raise ValueError("Video tracking epsilon must be positive")
    for key in ("minimum_target_tracks", "minimum_background_tracks", "shake_consecutive_pairs"):
        value = settings[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"Video {key} must be a positive integer")
    if max(settings["minimum_target_tracks"], settings["minimum_background_tracks"]) > features["maxCorners"]:
        raise ValueError("Video minimum tracks cannot exceed maxCorners")
    for key in ("forward_backward_error_pixels", "reseed_seconds", "maximum_pair_gap_seconds",
                "maximum_cadence_multiple", "shake_displacement_pixels"):
        if _finite(settings[key], key) <= 0:
            raise ValueError(f"Video {key} must be positive")
    if not 0 < _finite(settings["minimum_coverage_fraction"], "minimum coverage") <= 1:
        raise ValueError("Video coverage threshold must be between zero and one")
    return settings


def _tracking_grayscale(image):
    pixels = np.asarray(image)
    if pixels.dtype != np.uint8:
        raise ValueError("Tree tracking requires original 8-bit decoded pixels")
    if pixels.ndim == 3 and pixels.shape[2] == 3:
        return cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
    if pixels.ndim == 2 and pixels.size:
        return pixels
    raise ValueError("Tree tracking requires nonempty grayscale or BGR frames")


def _tracking_regions(regions, image_shape):
    if not isinstance(regions, dict) or set(regions) != {"A", "B", "background"}:
        raise ValueError("Tree tracking needs A, B and stationary background regions")
    checked = {name: _mask(regions[name], image_shape, name) for name in ("A", "B", "background")}
    if np.any(checked["A"] & checked["B"]) or np.any((checked["A"] | checked["B"]) & checked["background"]):
        raise ValueError("Tree tracking regions must not overlap")
    return checked


def _neutral_intervals(intervals):
    records = []
    seen = set()
    allowed = {"interval_id", "recording_id", "start", "end"}
    for interval in intervals:
        if not isinstance(interval, dict) or set(interval) - allowed:
            raise ValueError("Tree extraction accepts only neutral interval IDs, times and recording identities")
        interval_id = interval["interval_id"]
        if not isinstance(interval_id, str) or not interval_id or interval_id in seen:
            raise ValueError("Tree intervals need distinct nonempty identifiers")
        seen.add(interval_id)
        start = _finite(interval["start"], "interval start")
        end = _finite(interval["end"], "interval end")
        if end <= start:
            raise ValueError("Tree interval end must follow start")
        recording_id = interval.get("recording_id")
        if not isinstance(recording_id, str) or not recording_id:
            raise ValueError("Tree intervals require a nonempty recording identity")
        records.append({"interval_id": interval_id, "recording_id": recording_id, "start": start, "end": end})
    return records


def _point_inside(points, mask):
    height, width = mask.shape
    x = points[:, 0]
    y = points[:, 1]
    finite = np.isfinite(points).all(axis=1)
    inside = finite & (x >= 0) & (x < width) & (y >= 0) & (y < height)
    selected = np.flatnonzero(inside)
    inside[selected] &= mask[y[selected].astype(np.intp), x[selected].astype(np.intp)]
    return inside


def _track_region(previous, current, mask, seeded, settings, minimum_tracks, elapsed):
    features = settings["features"]
    points = seeded
    if points is None or len(points) < minimum_tracks:
        points = cv2.goodFeaturesToTrack(previous, mask=mask.astype(np.uint8) * 255, **features)
    if points is None or len(points) < minimum_tracks:
        return {"speed": None, "vector": None, "count": 0 if points is None else len(points),
                "following": None, "tracks": [], "reason": "insufficient_tracks"}
    tracking = settings["tracking"]
    lk_options = {"winSize": tuple(tracking["winSize"]), "maxLevel": tracking["maxLevel"],
                  "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
                               tracking["maxIterations"], tracking["epsilon"])}
    following, forward_status, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None, **lk_options)
    if following is None or forward_status is None or len(following) != len(points) or len(forward_status) != len(points):
        return {"speed": None, "vector": None, "count": 0, "following": None, "tracks": [], "reason": "insufficient_tracks"}
    initial = points.reshape(-1, 2)
    forward = following.reshape(-1, 2)
    def rows(starts, ends):
        return [[float(x), float(y), float(u) if np.isfinite(u) else None, float(v) if np.isfinite(v) else None]
                for (x, y), (u, v) in zip(starts, ends)]
    forward_valid = (forward_status.reshape(-1).astype(bool) & _point_inside(initial, mask)
                     & _point_inside(forward, mask))
    rejected = rows(initial[~forward_valid], forward[~forward_valid])
    initial = initial[forward_valid]
    forward = forward[forward_valid]
    if len(forward) < minimum_tracks:
        return {"speed": None, "vector": None, "count": 0, "following": None,
                "tracks": [], "rejected_tracks": rejected, "detected_count": len(points),
                "rejected_count": len(rejected), "reason": "insufficient_tracks"}
    returning, backward_status, _ = cv2.calcOpticalFlowPyrLK(
        current, previous, forward.reshape(-1, 1, 2), None, **lk_options)
    if returning is None or backward_status is None or len(returning) != len(initial) or len(backward_status) != len(initial):
        rejected.extend(rows(initial, forward))
        return {"speed": None, "vector": None, "count": 0, "following": None, "tracks": [],
                "rejected_tracks": rejected, "detected_count": len(points), "rejected_count": len(rejected), "reason": "insufficient_tracks"}
    backward = returning.reshape(-1, 2)
    finite = np.isfinite(backward).all(axis=1)
    return_error = np.full(len(initial), np.inf)
    return_error[finite] = np.linalg.norm(backward[finite] - initial[finite], axis=1)
    valid = backward_status.reshape(-1).astype(bool) & (return_error <= settings["forward_backward_error_pixels"])
    accepted_initial = initial[valid]
    accepted_forward = forward[valid]
    count = len(accepted_forward)
    rejected.extend(rows(initial[~valid], forward[~valid]))
    tracks = rows(accepted_initial, accepted_forward)
    if count < minimum_tracks:
        return {"speed": None, "vector": None, "count": count, "following": None,
                "tracks": tracks, "rejected_tracks": rejected, "detected_count": len(points),
                "rejected_count": len(rejected), "reason": "insufficient_tracks"}
    displacement = accepted_forward - accepted_initial
    speed = mean_feature_speed(np.linalg.norm(displacement, axis=1).tolist(), elapsed)
    vector = np.median(displacement, axis=0)
    return {"speed": speed, "vector": [float(vector[0]), float(vector[1])], "count": count,
            "following": accepted_forward.reshape(-1, 1, 2), "tracks": tracks,
            "rejected_tracks": rejected, "detected_count": len(points),
            "rejected_count": len(rejected), "reason": None}


def aggregate_tree_pairs(pairs, interval, minimum_coverage_fraction=0.95, *, parent_interval=None):
    """Duration-weight neutral speeds, splitting pairs only inside a parent window.

    Both regions use the same eligible durations. References index the retained
    pair list; no new copy of the original frames or feature tracks is needed.
    """
    parent = parent_interval or interval
    start, end = interval["start"], interval["end"]
    duration = end - start
    touching = [(index, pair, max(0., min(pair["end"], end) - max(pair["start"], start)))
                for index, pair in enumerate(pairs)
                if pair["recording_id"] == interval["recording_id"]
                and pair["start"] >= parent["start"] and pair["end"] <= parent["end"]
                and pair["start"] < end and start < pair["end"]]
    reasons = set(interval.get("quality_reasons", [])) | set(parent.get("quality_reasons", []))
    if parent.get("quantifiable") is False and not reasons:
        reasons.add("unquantifiable_parent_interval")
    eligible = []
    raw_pairs = []
    pair_reasons = set()
    for index, pair, overlap in touching:
        pair_reasons.update(pair.get("quality_reasons", []))
        finite = all(type(pair.get(key)) in (int, float) and math.isfinite(pair[key]) and pair[key] >= 0
                     for key in ("A_speed", "B_speed"))
        if not finite:
            pair_reasons.add("invalid_pair_motion")
        raw = {key: pair.get('raw_' + key, pair.get(key)) for key in ('A_speed', 'B_speed')}
        if all(type(value) in (int, float) and math.isfinite(value) and value >= 0 for value in raw.values()):
            raw_pairs.append((index, raw, overlap))
        if finite and not pair.get("quality_reasons"):
            eligible.append((index, pair, overlap))
    covered = sum(overlap for _, _, overlap in eligible)
    fraction = min(1., covered / duration)
    if fraction + 1e-12 < minimum_coverage_fraction:
        reasons.add("insufficient_coverage")
        reasons.update(pair_reasons)
    if 'camera_shake' in pair_reasons:
        reasons.add('camera_shake')
    available = bool(eligible) and not reasons
    a_motion = sum(pair["A_speed"] * overlap for _, pair, overlap in eligible) / covered if available else None
    b_motion = sum(pair["B_speed"] * overlap for _, pair, overlap in eligible) / covered if available else None
    tracks = {}
    for key in ("A_track_count", "B_track_count", "background_track_count"):
        counts = [pair[key] for _, pair, _ in touching if pair.get(key) is not None]
        tracks[key] = min(counts) if counts else None
    raw_covered = sum(overlap for _, _, overlap in raw_pairs)
    raw_a = sum(pair['A_speed'] * overlap for _, pair, overlap in raw_pairs) / raw_covered if raw_covered else None
    raw_b = sum(pair['B_speed'] * overlap for _, pair, overlap in raw_pairs) / raw_covered if raw_covered else None
    spatial = {}
    for name in ('A', 'B'):
        fractions = [pair[f'{name}_spatial']['coverage_fraction'] for _, pair, _ in touching
                     if isinstance(pair.get(f'{name}_spatial'), dict)]
        if fractions:
            spatial[f'{name}_spatial_coverage_min'] = min(fractions)
            spatial[f'{name}_spatial_coverage_mean'] = math.fsum(fractions) / len(fractions)
    return {"quantifiable": available, "A_motion": a_motion, "B_motion": b_motion,
            "raw_A_motion": raw_a,
            "raw_B_motion": raw_b,
            "D": a_motion - b_motion if available else None,
            "pair_count": len(touching), "eligible_pair_count": len(eligible),
            "covered_seconds": covered, "coverage_fraction": fraction,
            "quality_reasons": sorted(reasons), "pair_indices": [index for index, _, _ in touching],
            "first_frame_index": touching[0][1].get("first_frame_index") if touching else None,
            "last_frame_index": touching[-1][1].get("last_frame_index") if touching else None, **tracks, **spatial}


def _extract_tree_motion(frames, intervals, regions, profile, frame_observer=None, inclusive_endpoint=False,
                         retain_tracks=False):
    from study_profiles import AREA_GRID_MEAN, measurement_method
    from tree_spatial import grid_cells, track_grid
    settings = _motion_settings(profile)
    method = measurement_method(profile) if isinstance(profile, dict) and 'version' in profile else 'feature-mean-v1'
    grid_measurement = profile['video']['measurement'] if method == AREA_GRID_MEAN else None
    neutral_intervals = _neutral_intervals(intervals)
    pairs = []
    previous = None
    checked_regions = None
    grids = None
    carried = {name: None for name in ("A", "B", "background")}
    for frame in frames:
        if not isinstance(frame, dict) or set(frame) - {
            "source_id", "recording_id", "frame_index", "pts", "device_time", "timestamp", "image",
            "segment_start", "preceding_gap_seconds",
        }:
            raise ValueError("Tree frames must contain neutral pixels, times and identities only")
        timestamp = _finite(frame["timestamp"], "frame timestamp")
        gray = _tracking_grayscale(frame["image"])
        if checked_regions is None:
            checked_regions = _tracking_regions(regions, gray.shape)
            if grid_measurement:
                grids = {name: grid_cells(checked_regions[name], grid_measurement['cellSizePixels'],
                         grid_measurement['pointsPerCell'], grid_measurement['minimumTracksPerCell']) for name in ('A', 'B')}
        elif gray.shape != next(iter(checked_regions.values())).shape:
            raise VideoQualityError("Tree recording frame dimensions changed")
        identity = {"timestamp": timestamp, "source_id": frame.get("source_id"),
                    "recording_id": frame.get("recording_id"), "frame_index": frame.get("frame_index"),
                    "pts": frame.get("pts"), "video_seconds": frame.get("device_time", frame.get("pts", timestamp))}
        if not isinstance(identity["recording_id"], str) or not identity["recording_id"]:
            raise VideoQualityError("Tree frame has no recording identity")
        measured = {}
        if previous is not None:
            elapsed = timestamp - previous["identity"]["timestamp"]
            if elapsed <= 0:
                raise VideoQualityError("Tree frame presentation times are not increasing")
            same_source = (identity["source_id"] == previous["identity"]["source_id"]
                           and identity["recording_id"] == previous["identity"]["recording_id"])
            if not same_source:
                carried = {name: None for name in carried}
            else:
                previous_time = previous["identity"]["timestamp"]
                reseed = math.floor(previous["identity"]["video_seconds"] / settings["reseed_seconds"]) != math.floor(
                    identity["video_seconds"] / settings["reseed_seconds"])
                if reseed:
                    carried['background'] = None
                    if not grid_measurement or grid_measurement['refreshPolicy'] == 'timed':
                        carried['A'] = carried['B'] = None
                for name in ("A", "B", "background"):
                    minimum = settings["minimum_background_tracks"] if name == "background" else settings["minimum_target_tracks"]
                    try:
                        if grid_measurement and name != 'background':
                            measured[name] = track_grid(previous['image'], gray, checked_regions[name],
                                grids[name], carried[name] or {}, settings, grid_measurement, elapsed)
                        else:
                            measured[name] = _track_region(previous["image"], gray, checked_regions[name],
                                                           carried[name], settings, minimum, elapsed)
                    except cv2.error as error:
                        LOGGER.warning(
                            "Tree optical flow failed for region %s at %.6f in recording %s (%s); "
                            "the frame pair is unavailable", name, timestamp, identity["recording_id"], error,
                        )
                        measured[name] = {"speed": None, "vector": None, "count": 0, "following": None,
                                          "tracks": [], "reason": "tracking_failed"}
                    carried[name] = measured[name]["following"]
                reasons = [f"{result['reason']}_{name}" for name, result in measured.items() if result["reason"]]
                background_vector = measured["background"]["vector"]
                background_displacement = (float(np.linalg.norm(background_vector))
                                           if background_vector is not None else None)
                pairs.append({"start": previous_time, "end": timestamp, "elapsed_seconds": elapsed,
                              "source_id": identity["source_id"], "recording_id": identity["recording_id"],
                              "first_frame_index": previous["identity"]["frame_index"],
                              "last_frame_index": identity["frame_index"],
                              "A_speed": measured["A"]["speed"], "B_speed": measured["B"]["speed"],
                              "raw_A_speed": measured["A"]["speed"], "raw_B_speed": measured["B"]["speed"],
                              "A_track_count": measured["A"]["count"], "B_track_count": measured["B"]["count"],
                              "background_track_count": measured["background"]["count"],
                              "background_vector": background_vector,
                              "background_displacement_pixels": background_displacement,
                              "shake_candidate": (background_displacement is not None and
                                                  background_displacement > settings["shake_displacement_pixels"]),
                              "reseeded": reseed,
                              "detected_counts": {name: result.get('detected_count', result['count']) for name, result in measured.items()},
                              "rejected_counts": {name: result.get('rejected_count', 0) for name, result in measured.items()},
                              "quality_reasons": reasons})
                if grid_measurement:
                    for name in ('A', 'B'):
                        spatial = measured[name].get('spatial')
                        if spatial:
                            pairs[-1][f'{name}_spatial'] = {
                                key: spatial[key] for key in ('observed_area_speed', 'coverage_fraction',
                                                                'covered_area', 'total_area', 'reason')}
                            pairs[-1][f'{name}_spatial'].update(
                                requested_count=sum(cell['budget'] for cell in spatial['cells']),
                                detected_count=measured[name]['detected_count'],
                                carried_count=measured[name]['carried_count'],
                                accepted_count=measured[name]['count'],
                                valid_cell_count=sum(cell['reason'] is None for cell in spatial['cells']),
                                total_cell_count=len(spatial['cells']))
                if retain_tracks:
                    pairs[-1]['tracks'] = {name: {'accepted': result['tracks'],
                        'rejected': result.get('rejected_tracks', [])} for name, result in measured.items()}
        if frame_observer is not None:
            frame_observer(frame, checked_regions, measured)
        previous = {"identity": identity, "image": gray}
    cadences = {}
    for pair in pairs:
        if pair["elapsed_seconds"] <= settings["maximum_pair_gap_seconds"]:
            key = (pair["recording_id"], pair["source_id"])
            cadences.setdefault(key, []).append(pair["elapsed_seconds"])
    maximum_gaps = {
        key: min(settings["maximum_pair_gap_seconds"],
                 float(np.median(samples)) * settings["maximum_cadence_multiple"])
        for key, samples in cadences.items()
    }
    for pair in pairs:
        key = (pair["recording_id"], pair["source_id"])
        maximum_gap = maximum_gaps.get(key, settings["maximum_pair_gap_seconds"])
        if pair["elapsed_seconds"] > maximum_gap:
            pair["quality_reasons"].append("camera_frame_gap")
            pair["A_speed"] = pair["B_speed"] = None
            pair["background_vector"] = pair["background_displacement_pixels"] = None
            pair["shake_candidate"] = False
    shake_spans = []
    run = []
    for pair in [*pairs, None]:
        if pair is not None and pair["shake_candidate"] and (not run or run[-1]["end"] == pair["start"]):
            run.append(pair)
            continue
        if len(run) >= settings["shake_consecutive_pairs"]:
            shake_spans.append({"start": run[0]["start"], "end": run[-1]["end"], "pair_count": len(run)})
        run = [pair] if pair is not None and pair["shake_candidate"] else []
    summaries = []
    if inclusive_endpoint:
        for pair in pairs:
            if any(span["start"] < pair["end"] and pair["start"] < span["end"] for span in shake_spans):
                pair["quality_reasons"].append("camera_shake")
    for interval in neutral_intervals:
        if inclusive_endpoint:
            reasons = ["camera_shake"] if any(
                span["start"] < interval["end"] and interval["start"] < span["end"] for span in shake_spans) else []
            summary = aggregate_tree_pairs(pairs, {**interval, "quality_reasons": reasons},
                                           settings["minimum_coverage_fraction"])
            summaries.append({**interval, "baseline_required": False, **summary})
            continue
        duration = interval["end"] - interval["start"]
        touching = [pair for pair in pairs
                    if pair["start"] >= interval["start"] and pair["end"] < interval["end"]
                    and pair["recording_id"] == interval["recording_id"]]
        eligible = [pair for pair in touching if not pair["quality_reasons"]]
        coverage = sum(pair["elapsed_seconds"] for pair in eligible)
        coverage_fraction = min(1.0, coverage / duration)
        reasons = set(reason for pair in touching for reason in pair["quality_reasons"])
        if coverage_fraction + 1e-12 < settings["minimum_coverage_fraction"]:
            reasons.add("insufficient_coverage")
        if any(span["start"] < interval["end"] and interval["start"] < span["end"] for span in shake_spans):
            reasons.add("camera_shake")
        available = bool(eligible) and not reasons
        a_motion = (sum(pair["A_speed"] * pair["elapsed_seconds"] for pair in eligible) / coverage
                    if available else None)
        b_motion = (sum(pair["B_speed"] * pair["elapsed_seconds"] for pair in eligible) / coverage
                    if available else None)
        summaries.append({**interval, "baseline_required": False, "quantifiable": available,
                          "A_motion": a_motion, "B_motion": b_motion,
                          "D": a_motion - b_motion if available else None,
                          "pair_count": len(touching), "eligible_pair_count": len(eligible),
                          "covered_seconds": coverage, "coverage_fraction": coverage_fraction,
                          "quality_reasons": sorted(reasons)})
    return {"version": MOTION_VERSION if not grid_measurement else 'tree-area-grid-development-1',
            "measurementMethod": method, "module": "tree", "units": "pixels/second",
            "profile": settings, "spatialGrid": grids,
            "pairs": pairs, "shake_spans": shake_spans, "intervals": summaries}


def _tracking_preview_image(frame, regions, measured, display_magnification=10):
    original = np.asarray(frame["image"])
    image = cv2.cvtColor(original, cv2.COLOR_GRAY2BGR) if original.ndim == 2 else original.copy()
    scale = max(1, round(min(image.shape[1] / 960, image.shape[0] / 540)))
    vector_outline_width = max(1, round(scale * .5))
    vector_color_width = max(1, round(scale * .25))
    dot_outline_radius = max(2, round(scale * .75))
    dot_color_radius = max(1, round(scale * .5))
    colors = {"A": (255, 0, 255), "B": (255, 215, 0), "background": (40, 190, 210)}
    for name, mask in regions.items():
        contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(image, contours, -1, (0, 0, 0), 3 * scale)
        cv2.drawContours(image, contours, -1, colors[name], scale)
        positions = np.argwhere(mask)
        if positions.size:
            y, x = positions[0]
            cv2.putText(image, name, (int(x), max(10 * scale, int(y))), cv2.FONT_HERSHEY_SIMPLEX,
                        0.4 * scale, colors[name], scale, cv2.LINE_AA)
        for x, y, u, v in measured.get(name, {}).get("tracks", []):
            start = (round(x), round(y))
            display_end = (round(x + (u - x) * display_magnification),
                           round(y + (v - y) * display_magnification))
            cv2.line(image, start, display_end, (0, 0, 0), vector_outline_width, cv2.LINE_AA)
            cv2.line(image, start, display_end, colors[name], vector_color_width, cv2.LINE_AA)
            actual = (round(u), round(v))
            cv2.circle(image, actual, dot_outline_radius, (0, 0, 0), -1, cv2.LINE_AA)
            cv2.circle(image, actual, dot_color_radius, colors[name], -1, cv2.LINE_AA)
        spatial = measured.get(name, {}).get('spatial')
        if spatial:
            for cell in spatial['cells']:
                if cell['reason']:
                    region = mask[cell['y']:cell['bottom'], cell['x']:cell['right']]
                    contours, _ = cv2.findContours(region.astype(np.uint8), cv2.RETR_EXTERNAL,
                                                   cv2.CHAIN_APPROX_SIMPLE)
                    outline = np.zeros(region.shape, dtype=np.uint8)
                    cv2.drawContours(outline, contours, -1, 255, 2 * scale)
                    pixels = image[cell['y']:cell['bottom'], cell['x']:cell['right']]
                    pixels[(outline > 0) & region] = (0, 0, 220)
            anchor = np.argwhere(mask)
            if anchor.size:
                y, x = anchor[0]
                label = f"{name} measured area {spatial['coverage_fraction']:.1%}"
                unknown_area = spatial['total_area'] - spatial['covered_area']
                if unknown_area > 0:
                    label += f"; {unknown_area} px unknown"
                font_scale = .45 * scale
                text_width = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 3 * scale)[0][0]
                label_x = max(3 * scale, min(int(x), image.shape[1] - text_width - 3 * scale))
                label_position = (label_x, min(image.shape[0] - 4 * scale, int(y) + 20 * scale))
                cv2.putText(image, label,
                            label_position, cv2.FONT_HERSHEY_SIMPLEX,
                            font_scale, (0, 0, 0), 3 * scale, cv2.LINE_AA)
                cv2.putText(image, label,
                            label_position, cv2.FONT_HERSHEY_SIMPLEX,
                            font_scale, colors[name], scale, cv2.LINE_AA)
    cv2.putText(image, f'Display vectors {display_magnification:g}x; dots = actual matches',
                (8 * scale, image.shape[0] - 8 * scale), cv2.FONT_HERSHEY_SIMPLEX,
                .45 * scale, (0, 0, 0), 3 * scale, cv2.LINE_AA)
    cv2.putText(image, f'Display vectors {display_magnification:g}x; dots = actual matches',
                (8 * scale, image.shape[0] - 8 * scale), cv2.FONT_HERSHEY_SIMPLEX,
                .45 * scale, (255, 255, 255), scale, cv2.LINE_AA)
    return image


def extract_tree(frames, intervals, regions_or_setup, profile, *, preview_path=None, preview_fps=30,
                 inclusive_endpoint=True, retain_tracks=False):
    """Measure original-resolution features under the retained Tree profile."""
    if preview_path is None:
        return _extract_tree_motion(frames, intervals, regions_or_setup, profile,
                                    inclusive_endpoint=inclusive_endpoint, retain_tracks=retain_tracks)
    path = Path(preview_path)
    if path.suffix.lower() != ".avi" or _finite(preview_fps, "preview fps") <= 0:
        raise ValueError("Tracking preview requires an AVI path and positive preview frame rate")
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = None

    def observe(frame, regions, measured):
        nonlocal writer
        annotated = _tracking_preview_image(frame, regions, measured)
        if writer is None:
            height, width = annotated.shape[:2]
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"),
                                     float(preview_fps), (width, height))
            if not writer.isOpened():
                raise VideoQualityError(f"Tracking preview could not be opened at {path}")
        writer.write(annotated)

    try:
        result = _extract_tree_motion(frames, intervals, regions_or_setup, profile, frame_observer=observe,
                                     inclusive_endpoint=inclusive_endpoint, retain_tracks=retain_tracks)
    finally:
        if writer is not None:
            writer.release()
    if writer is None:
        raise VideoQualityError("Tracking preview contains no decoded frames")
    result["preview_path"] = str(path)
    return result
