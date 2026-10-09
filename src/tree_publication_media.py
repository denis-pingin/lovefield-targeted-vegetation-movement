"""Prepare an identified browser viewing copy without changing camera measurements."""
import hashlib
import json
import math
import tempfile
from pathlib import Path
import shutil
import subprocess

from study_http import AppError


def _failure(message):
    return AppError(message, operation='publication_media', status=409)


def prepare_viewing_video(original, destination, *, progress=None):
    original, destination = Path(original), Path(destination)
    probe, encoder = shutil.which('ffprobe'), shutil.which('ffmpeg')
    if not probe or not encoder:
        raise _failure('Installed FFmpeg and ffprobe are required to prepare the publication viewing video.')
    if progress: progress(stage='Inspecting publication video')
    inspected = subprocess.run([probe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(original)], capture_output=True)
    try:
        if inspected.returncode: raise ValueError()
        metadata = json.loads(inspected.stdout)
        video = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'video')
    except (ValueError, KeyError, StopIteration):
        raise _failure('The retained camera original cannot be inspected for browser playback.')
    try:
        duration = float(metadata['format'].get('duration', 0))
        if not math.isfinite(duration) or duration < 0: raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise _failure('The retained camera duration cannot be read for full-length viewing preparation.')
    audio = [stream for stream in metadata['streams'] if stream['codec_type'] == 'audio']
    if original.suffix.lower() == '.mp4' and video['codec_name'] == 'h264' and video.get('pix_fmt') == 'yuv420p' and all(stream['codec_name'] == 'aac' for stream in audio):
        return {'path': str(original), 'derivedFrom': None, 'command': None, 'version': None}
    with original.open('rb') as source:
        original_hash = hashlib.file_digest(source, 'sha256').hexdigest()
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # PTS are relative to the original timeline; there is no trim, resampling or measurement input substitution.
    command = [encoder, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(original),
               '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22',
               '-vf', 'scale=in_range=auto:out_range=tv', '-color_range', 'tv', '-c:a', 'aac', '-movflags', '+faststart', '-progress', 'pipe:1', str(destination)]
    versions = subprocess.run([encoder, '-version'], capture_output=True, text=True).stdout.splitlines()
    if not versions: raise _failure('The installed FFmpeg version could not be read.')
    version = versions[0]
    if progress: progress(stage='Preparing viewing video', completed=0, total=duration or None, unit='seconds')
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as diagnostic:
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=diagnostic, text=True) as process:
            for line in process.stdout:
                if progress and line.startswith('out_time_us='):
                    value = line.strip().partition('=')[2]
                    if value.isdigit(): progress(stage='Preparing viewing video', completed=int(value) / 1_000_000, total=duration or None, unit='seconds')
            if process.wait() or not destination.is_file():
                diagnostic.seek(0, 2)
                length = diagnostic.tell()
                diagnostic.seek(max(0, length - 4096))
                detail = diagnostic.read().replace(str(original), 'camera original').replace(str(destination), 'viewing copy').strip()
                raise _failure('FFmpeg could not create the full publication viewing video. ' + (detail or 'The encoder returned no diagnostic.'))
    return {'path': str(destination), 'derivedFrom': original_hash, 'command': command, 'version': version}
