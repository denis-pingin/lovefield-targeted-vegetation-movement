import hashlib
import json
import subprocess

from test_tree_api import movie
from tree_publication_media import prepare_viewing_video


def test_viewing_copy_keeps_original_bytes_and_relative_timeline(tmp_path):
    original = movie(tmp_path / 'camera.avi', frame_count=25)
    before = original.read_bytes()
    progress = []
    result = prepare_viewing_video(original, tmp_path / 'view.mp4', progress=lambda **value: progress.append(value))
    assert original.read_bytes() == before
    assert result['derivedFrom'] == hashlib.sha256(before).hexdigest()
    assert result['path'] == str(tmp_path / 'view.mp4')
    assert result['command'] and result['version']
    metadata = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', result['path']]))
    video = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'video')
    assert video['codec_name'] == 'h264' and video['pix_fmt'] == 'yuv420p'
    assert abs(float(metadata['format']['duration']) - 1) <= .04
    assert progress and any(item['stage'] == 'Preparing viewing video' for item in progress)
    unchanged = prepare_viewing_video(result['path'], tmp_path / 'unneeded.mp4')
    assert unchanged['path'] == result['path'] and unchanged['derivedFrom'] is None
    assert not (tmp_path / 'unneeded.mp4').exists()


def test_conversion_failure_retains_bounded_safe_diagnostic(tmp_path):
    import pytest
    from study_http import AppError
    original = movie(tmp_path / 'camera.avi')
    destination = tmp_path / 'occupied.mp4'
    destination.mkdir()
    with pytest.raises(AppError) as captured:
        prepare_viewing_video(original, destination)
    assert 'directory' in captured.value.message.lower() or 'output' in captured.value.message.lower()
    assert str(tmp_path) not in captured.value.message
    assert len(captured.value.message) < 5000


def test_invalid_duration_is_a_visible_media_error(tmp_path, monkeypatch):
    import pytest
    from study_http import AppError
    original = movie(tmp_path / 'camera.avi')
    real_run = subprocess.run
    def invoke(arguments, **options):
        result = real_run(arguments, **options)
        if '-show_format' in arguments:
            metadata = json.loads(result.stdout)
            metadata['format']['duration'] = 'not-a-duration'
            result.stdout = json.dumps(metadata).encode()
        return result
    monkeypatch.setattr(subprocess, 'run', invoke)
    with pytest.raises(AppError, match='duration'):
        prepare_viewing_video(original, tmp_path / 'view.mp4')
