"""Bounded, streamed clips annotated by the analysis tracker and exact reseeding."""
import hashlib
import json
import math
import logging
from pathlib import Path

import cv2

from study_video import _extract_tree_motion, _tracking_preview_image, read_frames, VideoQualityError
from study_profiles import validate_profile
from study_timing import video_end_seconds
from tree_series import profile_hash


def validate_annotation_range(video, start_seconds, duration_seconds):
    if type(start_seconds) not in (int, float) or not math.isfinite(start_seconds) or start_seconds < 0:
        raise ValueError('Annotation start must be a nonnegative finite number')
    if type(duration_seconds) not in (int, float) or not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError('Annotation duration must be a positive finite number')
    end_seconds = video_end_seconds(video.get('frameTimeline'))
    if start_seconds >= end_seconds or start_seconds + duration_seconds > end_seconds + 1e-9:
        raise ValueError('Choose an annotation range within the selected video')
    return end_seconds


def export_annotated_clip(video, regions, profile, start_seconds, duration_seconds, destination, progress=None,
                          display_magnification=10):
    validate_annotation_range(video, start_seconds, duration_seconds)
    if type(display_magnification) not in (int, float) or not math.isfinite(display_magnification) or not 0 < display_magnification <= 100:
        raise ValueError('Display vector magnification must be between zero and 100')
    profile = validate_profile(profile)
    path = Path(video['path'])
    destination = Path(destination)
    if destination.suffix.lower() != '.avi':
        raise ValueError('Choose an AVI destination for the annotated clip')
    sidecar = destination.with_suffix('.tracks.jsonl')
    if destination.exists() or sidecar.exists():
        raise ValueError('The annotated artifact already exists; choose a new filename')
    capture = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
    fps = capture.get(cv2.CAP_PROP_FPS)
    width, height = (int(capture.get(property)) for property in (cv2.CAP_PROP_FRAME_WIDTH, cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    if not math.isfinite(fps) or fps <= 0 or width <= 0 or height <= 0:
        raise VideoQualityError('The source clip has no usable cadence or dimensions')
    destination.parent.mkdir(parents=True, exist_ok=True)
    identifier = video.get('recordingId', 'clip')
    digest = video['sha256']
    source = {'source_id': identifier, 'recording_id': identifier, 'path': str(path), 'sha256': digest}
    if not video.get('clockMap'):
        logging.warning('Annotated recording %s has no clock map; diagnostic labels use original video time only', identifier)
    mapping = {**(video.get('clockMap') or {'rate': 1., 'offset_seconds': 0.}), 'residual_seconds': 0.}
    end_seconds = start_seconds + duration_seconds
    writer, count, first, last = None, 0, None, None

    def frames():
        iterator = read_frames([source], {identifier: mapping})
        try:
            # Preceding frames use the same carried tracks and fixed video-time reseeding.
            for frame in iterator:
                if frame['device_time'] >= end_seconds - 1e-9:
                    break
                if progress:
                    progress(stage='Tracking and annotating clip', completed=frame['device_time'], total=end_seconds, unit='video seconds')
                yield frame
        finally:
            iterator.close()

    try:
        with sidecar.open('x') as diagnostics:
            def observe(frame, checked_regions, measured):
                nonlocal writer, count, first, last
                if frame['device_time'] < start_seconds - 1e-9:
                    return
                if writer is None:
                    writer = cv2.VideoWriter(str(destination), cv2.VideoWriter_fourcc(*'MJPG'), fps, (width, height))
                    if not writer.isOpened():
                        raise VideoQualityError('The annotated clip could not be opened for writing')
                annotated = _tracking_preview_image(frame, checked_regions, measured, display_magnification)
                for name, values in measured.items():
                    for x, y, u, v in values.get('rejected_tracks', []):
                        cv2.drawMarker(annotated, (round(u if u is not None else x), round(v if v is not None else y)), (0, 0, 220), cv2.MARKER_TILTED_CROSS, 4, 1)
                writer.write(annotated)
                row = {'frameIndex': frame['frame_index'], 'ptsSeconds': frame['device_time'],
                       'mappedSeconds': frame['timestamp'],
                       'tracks': {name: {'accepted': value.get('tracks', []), 'rejected': value.get('rejected_tracks', [])} for name, value in measured.items()},
                       'spatial': {name: value['spatial'] for name, value in measured.items() if value.get('spatial')},
                       'acceptedCounts': {name: value['count'] for name, value in measured.items()},
                       'rejectedCounts': {name: value.get('rejected_count', 0) for name, value in measured.items()}}
                diagnostics.write(json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n')
                count += 1
                first = frame['device_time'] if first is None else first
                last = frame['device_time']
            summary = _extract_tree_motion(frames(), [], regions, profile, frame_observer=observe)
        if count == 0:
            raise VideoQualityError('The requested snippet contains no source frames')
        with path.open('rb') as source_file:
            if hashlib.file_digest(source_file, 'sha256').hexdigest() != digest:
                raise VideoQualityError('The original changed during annotation')
    except Exception:
        if writer is not None:
            writer.release()
            writer = None
        destination.unlink(missing_ok=True)
        sidecar.unlink(missing_ok=True)
        raise
    finally:
        if writer is not None:
            writer.release()
    with destination.open('rb') as artifact_file, sidecar.open('rb') as tracks_file:
        artifact_hash = hashlib.file_digest(artifact_file, 'sha256').hexdigest()
        tracks_hash = hashlib.file_digest(tracks_file, 'sha256').hexdigest()
    return {'status': 'completed', 'frames': count, 'frameRate': fps, 'width': width, 'height': height,
            'startPtsSeconds': first, 'lastPtsSeconds': last, 'sourceSha256': digest,
            'profile': profile, 'profileHash': profile_hash(profile),
            'artifactPath': str(destination), 'tracksPath': str(sidecar),
            'artifactSha256': artifact_hash,
            'tracksSha256': tracks_hash,
            'displayMagnification': display_magnification,
            'measuredPairs': len(summary['pairs']), 'interpretation': 'Actual accepted tracks and rejected matches. Descriptive tracking diagnostic; not an inferential outcome.'}
