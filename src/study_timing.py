"""Map filmed phone/video and local CSV clocks onto the server event clock.

The returned maps describe measured clock coordinates. They do not correct the
wind sensor's physical response lag or infer an unrecorded clock segment.
"""

from datetime import datetime, timezone
from decimal import Decimal
from fractions import Fraction
import json
import logging
import math
from pathlib import Path
import re
import subprocess
import tempfile


_TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S.%f"
_TIMECODE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d:[0-9]{2}$")
_SECONDS_PER_DAY = 24 * 60 * 60
_MAXIMUM_ALIGNMENT_UNCERTAINTY_SECONDS = 0.5
_MAXIMUM_UNEXPLAINED_WALL_STEP_MS = 250
LOGGER = logging.getLogger(__name__)


def _number(value, name, minimum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return float(value)


def _frame_index(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("frameIndex must be a nonnegative integer")
    return value


def _timecode_seconds(value, frames_per_second):
    if not isinstance(value, str) or not _TIMECODE.fullmatch(value):
        return None
    hours, minutes, seconds, frame = (int(part) for part in value.split(":"))
    if frame >= frames_per_second:
        return None
    return hours * 3600 + minutes * 60 + seconds + frame / frames_per_second


def _video_metadata(metadata):
    if not isinstance(metadata, dict):
        raise ValueError("frame metadata must be an object")
    frame_rate = metadata.get("frameRate")
    if isinstance(frame_rate, bool) or not isinstance(frame_rate, int) or frame_rate <= 0:
        raise ValueError("camera frameRate must be a positive integer")
    frames = metadata.get("frames")
    if not isinstance(frames, list) or len(frames) < 2:
        raise ValueError("camera metadata needs at least two timestamped frames")
    checked = []
    reasons = set()
    rollovers = 0
    for source in frames:
        if not isinstance(source, dict):
            raise ValueError("each camera frame mark must be an object")
        row = {
            "frameIndex": _frame_index(source.get("frameIndex")),
            "ptsSeconds": _number(source.get("ptsSeconds"), "frame ptsSeconds", 0),
            "timecode": source.get("timecode"),
        }
        current_timecode = _timecode_seconds(row["timecode"], frame_rate)
        if current_timecode is None:
            reasons.add("missing_timecode" if row["timecode"] is None else "invalid_timecode")
        if checked:
            previous = checked[-1]
            if row["frameIndex"] <= previous["frameIndex"] or row["ptsSeconds"] <= previous["ptsSeconds"]:
                raise ValueError("camera frames must have increasing indices and presentation times")
            frame_difference = row["frameIndex"] - previous["frameIndex"]
            pts_difference = row["ptsSeconds"] - previous["ptsSeconds"]
            if metadata.get("completeFrameTimeline", False) and (
                    frame_difference != 1 or abs(pts_difference - 1 / frame_rate) > 0.5 / frame_rate):
                reasons.add("frame_discontinuity")
            previous_timecode = _timecode_seconds(previous["timecode"], frame_rate)
            if current_timecode is not None and previous_timecode is not None:
                timecode_difference = current_timecode - previous_timecode
                if timecode_difference < 0:
                    timecode_difference += _SECONDS_PER_DAY
                    rollovers += 1
                if abs(timecode_difference - pts_difference) > 1.5 / frame_rate:
                    reasons.add("timecode_discontinuity")
        checked.append(row)
    if metadata.get("completeFrameTimeline", False):
        count = metadata.get("declaredFrameCount")
        if count is not None and count != len(checked):
            reasons.add("frame_count_mismatch")
    if rollovers > 1:
        reasons.add("timecode_discontinuity")
    return checked, frame_rate, rollovers, reasons


def frame_selection_uncertainty_ms(frames, frame_index):
    """One decoded frame interval bounds the selection of a readable display."""
    position = next((index for index, frame in enumerate(frames)
                     if frame['frameIndex'] == frame_index), None)
    if position is None or len(frames) < 2:
        raise ValueError('Selected frame needs a decoded neighbouring frame')
    pairs = [(frames[index - 1], frames[index]) for index in (position, position + 1)
             if 0 < index < len(frames)]
    return 1000 * max((right['ptsSeconds'] - left['ptsSeconds']) /
                      (right['frameIndex'] - left['frameIndex']) for left, right in pairs)


def _references(references, frames, require_phone):
    if not isinstance(references, list) or len(references) != 2:
        raise ValueError("two distinct filmed references are required")
    by_index = {frame["frameIndex"]: frame for frame in frames}
    checked = []
    for source in references:
        if not isinstance(source, dict):
            raise ValueError("each filmed clock reference must be an object")
        index = _frame_index(source.get("frameIndex"))
        if index not in by_index:
            raise ValueError(f"filmed reference frameIndex {index} is not in camera metadata")
        checked.append({
            "frameIndex": index,
            "ptsSeconds": by_index[index]["ptsSeconds"],
            "phoneDisplayedAtMs": (_number(source.get("phoneDisplayedAtMs"), "phoneDisplayedAtMs")
                                   if require_phone or source.get("phoneDisplayedAtMs") is not None else None),
            "serverDisplayedAtMs": _number(source.get("serverDisplayedAtMs"), "serverDisplayedAtMs"),
            "clockUncertaintyMs": _number(source.get("clockUncertaintyMs"), "clockUncertaintyMs", 0),
            "frameSelectionUncertaintyMs": _number(
                source.get("frameSelectionUncertaintyMs", frame_selection_uncertainty_ms(frames, index)),
                "frameSelectionUncertaintyMs", 0),
            "phoneMonotonicAtMs": (None if source.get("phoneMonotonicAtMs") is None else _number(
                source["phoneMonotonicAtMs"], "phoneMonotonicAtMs")),
        })
    left, right = checked
    if (right["frameIndex"] <= left["frameIndex"] or
            right["ptsSeconds"] <= left["ptsSeconds"] or
            (require_phone and right["phoneDisplayedAtMs"] <= left["phoneDisplayedAtMs"]) or
            right["serverDisplayedAtMs"] <= left["serverDisplayedAtMs"]):
        raise ValueError("filmed references must be ordered by frame, phone and server time")
    return checked


def _linear_map(first_coordinate, second_coordinate, first_server_ms, second_server_ms):
    rate = ((second_server_ms - first_server_ms) / 1000) / (second_coordinate - first_coordinate)
    offset = first_server_ms / 1000 - rate * first_coordinate
    if not math.isfinite(rate) or not math.isfinite(offset) or rate <= 0:
        raise ValueError("clock references cannot form a positive finite map")
    return rate, offset


def map_recording_times(references, frame_metadata, csv_metadata):
    """Return explicit video/CSV maps and the conservative pairwise alignment bound.

    Reference values are copied from the filmed phone clock display and paired
    with actual decoded frame presentation times. CSV timestamps remain local
    clock text until an explicit UTC offset converts them into phone wall time.
    """
    frames, frame_rate, rollovers, reasons = _video_metadata(frame_metadata)
    checked = _references(references, frames, csv_metadata is not None)
    utc_offset = None
    timestamp_resolution_ms = 0
    if csv_metadata is not None:
        if not isinstance(csv_metadata, dict) or csv_metadata.get("timestampFormat") != _TIMESTAMP_FORMAT:
            raise ValueError("CSV requires the recorded fractional local timestamp format")
        utc_offset = csv_metadata.get("utcOffsetMinutes")
        if isinstance(utc_offset, bool) or not isinstance(utc_offset, int) or not -840 <= utc_offset <= 840:
            raise ValueError("CSV UTC offset in minutes must be recorded explicitly")
        timestamp_resolution_ms = _number(csv_metadata.get("timestampResolutionMs"), "CSV timestampResolutionMs", 0)
        if timestamp_resolution_ms > 1000:
            raise ValueError("CSV timestampResolutionMs cannot exceed one second")
    first, last = checked
    video_rate, video_offset = _linear_map(first["ptsSeconds"], last["ptsSeconds"],
                                           first["serverDisplayedAtMs"], last["serverDisplayedAtMs"])
    video = {
        "rate": video_rate,
        "offset_seconds": video_offset,
        "references": checked,
        "validPtsRangeSeconds": [first["ptsSeconds"], last["ptsSeconds"]],
        "timecodeRollovers": rollovers,
        "frameRate": frame_rate,
        "timecodeSource": frame_metadata.get("timecodeSource", "supplied-frame-marks"),
        "streamStartTimecode": frame_metadata.get("streamStartTimecode"),
    }
    csv = None
    if csv_metadata is not None:
        if first["phoneMonotonicAtMs"] is None or last["phoneMonotonicAtMs"] is None:
            reasons.add("phone_clock_jump_unchecked")
        else:
            wall_elapsed = last["phoneDisplayedAtMs"] - first["phoneDisplayedAtMs"]
            monotonic_elapsed = last["phoneMonotonicAtMs"] - first["phoneMonotonicAtMs"]
            if monotonic_elapsed <= 0 or abs(wall_elapsed - monotonic_elapsed) > _MAXIMUM_UNEXPLAINED_WALL_STEP_MS:
                reasons.add("phone_clock_jump")
    if csv_metadata is not None and "phone_clock_jump" not in reasons and "phone_clock_jump_unchecked" not in reasons:
        csv_rate, csv_offset = _linear_map(first["phoneDisplayedAtMs"] / 1000,
                                            last["phoneDisplayedAtMs"] / 1000,
                                            first["serverDisplayedAtMs"], last["serverDisplayedAtMs"])
        csv = {
            "rate": csv_rate,
            "offset_seconds": csv_offset,
            "references": checked,
            "validPhoneRangeSeconds": [first["phoneDisplayedAtMs"] / 1000,
                                       last["phoneDisplayedAtMs"] / 1000],
            "utcOffsetMinutes": utc_offset,
            "timestampFormat": _TIMESTAMP_FORMAT,
            "timestampResolutionMs": timestamp_resolution_ms,
        }
    clock_uncertainty_ms = max(row["clockUncertaintyMs"] for row in checked)
    frame_uncertainty_ms = max(row["frameSelectionUncertaintyMs"] for row in checked)
    maximum_uncertainty_seconds = (
        clock_uncertainty_ms + frame_uncertainty_ms +
        (clock_uncertainty_ms + timestamp_resolution_ms if csv_metadata is not None else 0)
    ) / 1000
    if maximum_uncertainty_seconds > _MAXIMUM_ALIGNMENT_UNCERTAINTY_SECONDS + 1e-12:
        reasons.add("alignment_uncertainty_exceeds_limit")
    return {
        "video": video,
        "csv": csv,
        "maximum_uncertainty_seconds": maximum_uncertainty_seconds,
        "qualified": not reasons,
        "quality_reasons": sorted(reasons),
    }


def map_video_time(pts_seconds, video_map):
    """Map one decoded frame presentation time to server UTC epoch seconds."""
    coordinate = _number(pts_seconds, "video presentation time", 0)
    return video_map["rate"] * coordinate + video_map["offset_seconds"]


def map_csv_time(raw_timestamp, csv_map):
    """Map fractional local AnemoTracker text to server UTC epoch seconds."""
    if not isinstance(raw_timestamp, str):
        raise ValueError("CSV timestamp must be original text")
    if not isinstance(csv_map, dict):
        raise ValueError("CSV time map is unavailable")
    try:
        local = datetime.strptime(raw_timestamp, csv_map["timestampFormat"])
    except (ValueError, KeyError) as error:
        raise ValueError("CSV timestamp does not match its recorded format") from error
    phone_epoch_seconds = local.replace(tzinfo=timezone.utc).timestamp() - 60 * csv_map["utcOffsetMinutes"]
    return csv_map["rate"] * phone_epoch_seconds + csv_map["offset_seconds"]


def _derived_timecode(start, frame_index, frame_rate):
    parsed = _timecode_seconds(start, frame_rate)
    if parsed is None:
        return None
    position = (round(parsed * frame_rate) + frame_index) % (_SECONDS_PER_DAY * frame_rate)
    seconds, frame = divmod(position, frame_rate)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frame:02d}"


def video_end_seconds(timeline):
    """Return the first instant after the final retained video frame."""
    if not isinstance(timeline, dict) or not isinstance(timeline.get('frames'), list) or not timeline['frames']:
        raise ValueError('The selected video has no retained frame timeline')
    frame_rate = _number(timeline.get('frameRate'), 'video frame rate', minimum=0)
    if frame_rate == 0:
        raise ValueError('The selected video has no positive frame rate')
    frames = timeline['frames']
    if not isinstance(frames[-1], dict):
        raise ValueError('The selected video has an invalid final frame')
    last = _number(frames[-1].get('ptsSeconds'), 'final video presentation time', minimum=0)
    last_decimal = Decimal(str(last))
    if len(frames) > 1:
        if not isinstance(frames[-2], dict):
            raise ValueError('The selected video has an invalid penultimate frame')
        previous = _number(frames[-2].get('ptsSeconds'), 'penultimate video presentation time', minimum=0)
        interval = last_decimal - Decimal(str(previous))
    else:
        interval = Decimal(1) / Decimal(str(frame_rate))
    if interval <= 0:
        raise ValueError('The selected video has no positive final frame interval')
    end_seconds = float(last_decimal + interval)
    if not math.isfinite(end_seconds):
        raise ValueError('The selected video endpoint is invalid')
    return end_seconds


def inspect_video_timeline(path, *, runner=None, progress=None):
    """Read actual frame presentation times and available MOV timecode markers.

    When ffprobe exposes only a stream-start timecode, frame labels are derived
    for navigation and identified as such. PTS/count checks remain independent;
    derived labels do not purport to detect a mid-clip timecode reset.
    """
    source = Path(path)
    if not source.is_file():
        raise ValueError("video original is missing")
    arguments = [
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_streams",
        "-show_entries",
        "frame=best_effort_timestamp_time:frame_tags=timecode:frame_side_data=timecode:"
        "stream=avg_frame_rate,nb_frames:stream_tags=timecode",
        "-of", "json", str(source),
    ]
    try:
        if runner is not None:
            result = runner(arguments, check=True, capture_output=True, text=True)
            output = result.stdout
        else:
            pieces, count = [], 0
            if progress:
                progress(stage='Reading frame timeline', completed=0, unit='frames')
            with tempfile.TemporaryFile(mode='w+') as errors:
                process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=errors, text=True)
                try:
                    for line in process.stdout:
                        pieces.append(line)
                        timestamp = re.search(r'"best_effort_timestamp_time":\s*"([0-9.]+)"', line)
                        if timestamp:
                            count += 1
                            if progress:
                                progress(stage='Reading frame timeline', completed=count, unit='frames',
                                         videoSeconds=float(timestamp.group(1)))
                    if process.wait():
                        raise ValueError('ffprobe could not read the video timeline')
                finally:
                    process.stdout.close()
                    if process.poll() is None:
                        process.terminate()
                        process.wait()
            output = ''.join(pieces)
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError("ffprobe could not read the video timeline") from error
    try:
        metadata = json.loads(output)
    except (AttributeError, ValueError) as error:
        raise ValueError("ffprobe returned invalid video metadata") from error
    streams = metadata.get("streams")
    raw_frames = metadata.get("frames")
    if not isinstance(streams, list) or len(streams) != 1 or not isinstance(raw_frames, list) or not raw_frames:
        raise ValueError("ffprobe did not find one decodable video stream")
    stream = streams[0]
    try:
        fraction = Fraction(stream["avg_frame_rate"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
        raise ValueError("ffprobe video has no declared frame rate") from error
    if fraction <= 0 or fraction.denominator != 1:
        raise ValueError("this protocol requires a whole-number camera frame rate")
    frame_rate = fraction.numerator
    start_timecode = stream.get("tags", {}).get("timecode")
    frame_marks = []
    actual_timecodes = 0
    for index, frame in enumerate(raw_frames):
        if not isinstance(frame, dict):
            raise ValueError("ffprobe returned a malformed frame record")
        try:
            pts_seconds = float(frame["best_effort_timestamp_time"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"video frame {index} has no presentation timestamp") from error
        if not math.isfinite(pts_seconds) or pts_seconds < 0:
            raise ValueError(f"video frame {index} has invalid presentation time")
        timecode = frame.get("tags", {}).get("timecode")
        if timecode is None:
            timecode = next((entry.get("timecode") for entry in frame.get("side_data_list", [])
                             if isinstance(entry, dict) and entry.get("timecode")), None)
        if timecode is not None:
            actual_timecodes += 1
        else:
            timecode = _derived_timecode(start_timecode, index, frame_rate)
        frame_marks.append({"frameIndex": index, "ptsSeconds": pts_seconds, "timecode": timecode})
    declared = stream.get("nb_frames")
    if declared is not None:
        try:
            declared = int(declared)
        except (TypeError, ValueError) as error:
            raise ValueError("video declared frame count is invalid") from error
    provenance = ("frame-tags" if actual_timecodes == len(frame_marks)
                  else "frame-tags-and-stream-derived" if actual_timecodes
                  else "stream-start-derived" if _timecode_seconds(start_timecode, frame_rate) is not None
                  else "missing")
    if provenance != "frame-tags":
        LOGGER.warning("Video %s has %s timecode; keeping this limitation in the timeline metadata",
                       source.name, provenance)
    return {
        "frameRate": frame_rate,
        "frames": frame_marks,
        "completeFrameTimeline": True,
        "decodedFrameCount": len(frame_marks),
        "declaredFrameCount": declared,
        "timecodeSource": provenance,
        "streamStartTimecode": start_timecode,
    }
