"""Local study lifecycle, opaque file selection and serialized controller ownership."""
import argparse
import base64
import copy
import csv
import fcntl
import hashlib
import http.client
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit
from study_http import AppError

DEFAULT_DATA_DIRECTORY = Path.home() / 'Library/Application Support/Lovefield Tree Study'
ACTIONS = {'start_global', 'approach_started', 'arrived', 'departure_started', 'departed',
           'local_ready', 'report_execution', 'start_tree', 'postpone_tree', 'incident', 'stop_session', 'close_group'}
GROUPS = {'global-local', 'tree'}
EXPERIMENT_SLUG = 'tree-targeting'
HOSTED_API = '/tree-targeting/api/analysis/'
SAFE_IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z')
RUN_DISPLAY_FIELDS = ('tag', 'lifecycle', 'createdAtMs', 'recordingStartedAtMs', 'finishedAtMs')


class StudyApplication:
    """Serialized Tree import and analysis lifecycle with retained originals."""
    def __init__(self, data_directory=None, *, picker=None, hosted_analyzer=None, profile_resolver=None,
                 publication_inventory_reader=None, publication_uploader=None):
        self.directory = Path(data_directory or DEFAULT_DATA_DIRECTORY).expanduser().resolve()
        if any((parent / '.git').exists() for parent in (self.directory, *self.directory.parents)):
            raise AppError('Store study recordings outside Git checkouts.', operation='launch')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.picker = picker or NativePicker()
        from tree_series import SeriesStore
        from tree_comparisons import ComparisonStore
        self.series_store = SeriesStore(self.directory / 'tree-targeting' / '_series')
        self.comparison_store = ComparisonStore(self.directory / 'tree-targeting' / '_comparisons')
        self._annotation_path = self._hosted_root() / '_annotations.json'
        self._annotation_jobs = _read_json(self._annotation_path, {})
        self.hosted_analyzer = hosted_analyzer or (lambda bundle, recordings, profile:
            __import__('study_analysis').analyze_tree_run(bundle, recordings, profile, progress=self._report_progress))
        self.profile_resolver = profile_resolver or self._resolve_hosted_profile
        self.instance_id, self.quit_requested = _identifier(), False
        self._hosted_request_lock, self._progress_lock = threading.Lock(), threading.Lock()
        self._progress = None
        self._commands, self._closed = queue.Queue(), False
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='tree-analysis')
        self._thread = threading.Thread(target=self._run, name='tree-application', daemon=True)
        self._thread.start()
        self._call(self._recover)
        from tree_publication import PublicationJobs, read_destination_inventory, upload_retained_publication
        self.publication_inventory_reader = publication_inventory_reader or read_destination_inventory
        self.publication_uploader = publication_uploader or upload_retained_publication
        self.publication_jobs = PublicationJobs(self)

    def _recover(self):
        for job in self._annotation_jobs.values():
            if job['status'] == 'running':
                logging.warning('Tree annotation %s was interrupted; marked failed for retry', job['jobId'])
                job.update(status='failed', error='The service stopped before annotation completed.')
        if self._annotation_jobs:
            _write_json(self._annotation_path, self._annotation_jobs)
        for run in self._list_hosted_runs()['runs']:
            manifest = self._hosted_manifest(run['runId'])
            for analysis in manifest['analyses'].values():
                if analysis['status'] == 'running':
                    logging.warning('Tree analysis %s for %s was interrupted; marked failed for explicit retry', analysis['analysisId'], run['runId'])
                    analysis.update(status='failed', error=AppError('The service stopped before analysis completed.', code='interrupted_job').public())
                    _write_json(self._hosted_directory(run['runId']) / 'manifest.json', manifest)

    def _run(self):
        while True:
            task = self._commands.get()
            if task is False:
                return
            future, function, arguments = task
            try:
                future.set_result(function(*arguments))
            except Exception as error:
                future.set_exception(error)

    def _require_idle(self, publication_job_id=None):
        if hasattr(self, 'publication_jobs'): self.publication_jobs.require_available(publication_job_id)
        if any(run['analysisRunning'] for run in self._list_hosted_runs()['runs']):
            raise AppError('Wait for the current analysis before changing recordings or settings.', status=409)

    def dispatch(self, method, route, payload=None):
        if route.startswith(HOSTED_API):
            return self._dispatch_hosted_route(method, route, payload)
        if method == 'GET' and route == '/api/state':
            return {'service': {'instance_id': self.instance_id, 'version': 2}, 'experimentSlug': EXPERIMENT_SLUG}
        if method == 'POST' and route == '/api/quit':
            self.quit_requested = True
            return {'quitting': True}
        raise AppError('Unknown Tree application route.', status=404)

    def get_public_analysis(self, run_id, analysis_id):
        return self.get_analysis(run_id, analysis_id)

    def close(self):
        if self._closed:
            return
        self.publication_jobs.close()
        self._executor.shutdown(wait=True)
        self._call(lambda: None)
        self._closed = True
        self._commands.put(False)
        self._thread.join(timeout=5)

    def _report_progress(self, *, stage, completed=None, total=None, unit=None, **context):
        with self._progress_lock:
            self._progress = {'status':'running', 'stage':stage, 'completed':completed,
                              'total':total, 'unit':unit, **context}


    def operation_progress(self):
        # This read must not wait behind the owning thread's long file import.
        with self._progress_lock:
            return copy.deepcopy(self._progress) or {'status':'idle'}


    def _clear_progress(self):
        with self._progress_lock:
            self._progress = None


    def _call(self, function, *args):
        if threading.current_thread() is self._thread:
            return function(*args)
        if self._closed:
            raise AppError('The study service is closed.', status=503)
        future = Future()
        self._commands.put((future, function, args))
        return future.result()


    def _hosted_root(self):
        return self.directory / EXPERIMENT_SLUG


    def _setup_clip_directory(self):
        return self._hosted_root() / '_setup_clips'


    def _setup_frame_directory(self):
        return self._hosted_root() / '_setup_frames'

    def import_retained_setup(self, source_directory):
        return self._call(self._import_retained_setup, Path(source_directory))

    def _import_retained_setup(self, source_directory):
        """Copy exact setup bytes and their sidecars; never write to the source store."""
        import cv2
        if not source_directory.is_dir():
            raise AppError('Choose the retained setup-image folder.', operation='import_setup')
        prepared = []
        for metadata_path in sorted(source_directory.glob('*.json')):
            if not re.fullmatch(r'[a-f0-9]{64}', metadata_path.stem):
                continue
            metadata = _read_json(metadata_path, None)
            image_path = metadata_path.with_suffix('.png')
            if (not isinstance(metadata, dict) or metadata.get('sha256') != metadata_path.stem
                or not image_path.is_file() or _digest(image_path) != metadata_path.stem):
                raise AppError('The source setup image or identity changed.', operation='import_setup', status=409)
            image = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
            if image is None or metadata.get('imageSize') != {'width': image.shape[1], 'height': image.shape[0]}:
                raise AppError('The source setup dimensions differ from its retained record.', operation='import_setup')
            for source in metadata.get('sources', []):
                if (not re.fullmatch(r'[a-f0-9]{64}', source.get('sourceVideoSha256', ''))
                    or type(source.get('frameIndex')) is not int or source['frameIndex'] < 0):
                    raise AppError('The source setup frame provenance is invalid.', operation='import_setup')
            prepared.append((image_path, metadata_path))
        if not prepared:
            raise AppError('No retained setup image records were found.', operation='import_setup')
        destination = self._setup_frame_directory()
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        for pair in prepared:
            for source in pair:
                target = destination / source.name
                if target.exists():
                    if target.read_bytes() != source.read_bytes():
                        raise AppError('A retained Tree setup record has different bytes.', operation='import_setup', status=409)
                else:
                    with target.open('xb') as output:
                        output.write(source.read_bytes())
        for run in self._list_hosted_runs()['runs']:
            manifest = self._hosted_manifest(run['runId'])
            bundle = self._verified_hosted_bundle(self._hosted_directory(run['runId']), manifest)
            self._attach_retained_setup(run['runId'], manifest, bundle)
        return {'experimentSlug': EXPERIMENT_SLUG, 'importedImages': len(prepared)}


    def get_setup_clip(self):
        return self._call(self._get_setup_clip)


    def _get_setup_clip(self):
        record = _read_json(self._setup_clip_directory() / 'current.json', None)
        if not record:
            return {'experimentSlug':EXPERIMENT_SLUG, 'clipId':None}
        return {key:record[key] for key in ('experimentSlug','clipId','name','sha256','width','height')}


    def _verified_setup_clip_path(self, record):
        if record.get('experimentSlug') != EXPERIMENT_SLUG or not re.fullmatch(r'[a-f0-9]{64}', record.get('clipId','')):
            raise AppError('The retained setup clip identity changed.', operation='setup_clip', status=409)
        path = self._setup_clip_directory() / record['relativePath']
        if not path.is_file() or _digest(path) != record['sha256']:
            raise AppError('The retained setup clip is missing or changed.', operation='setup_clip', status=409)
        return path


    def import_setup_clip(self, path):
        try:
            return self._call(self._import_setup_clip, Path(path))
        finally:
            self._clear_progress()


    def _import_setup_clip(self, path):
        if not path.is_file() or path.suffix.lower() not in ('.mov','.mp4','.m4v','.avi'):
            raise AppError('Choose an existing setup camera clip in MOV, MP4, M4V or AVI format.', operation='setup_clip')
        self._report_progress(stage='Decoding first frame')
        preview = video_preview(path)
        digest = _digest(path, self._report_progress)
        directory = self._setup_clip_directory()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = directory / f'{digest}{path.suffix.lower()}'
        if destination.exists():
            if _digest(destination) != digest:
                raise AppError('The retained setup clip changed.', operation='setup_clip', status=409)
        else:
            _copy_original(path, destination, self._report_progress)
            if _digest(destination, self._report_progress) != digest:
                destination.unlink(missing_ok=True)
                raise AppError('The setup clip changed while it was retained.', operation='setup_clip', status=409)
        record = {'experimentSlug':EXPERIMENT_SLUG, 'clipId':digest, 'name':path.name,
                  'sha256':digest, 'relativePath':destination.name,
                  'width':preview['width'], 'height':preview['height']}
        _write_json(directory / 'current.json', record)
        self._clear_progress()
        return {key:record[key] for key in ('experimentSlug','clipId','name','sha256','width','height')}


    def preview_setup_clip(self, clip_id, frame_index):
        return self._call(self._preview_setup_clip, clip_id, frame_index)


    def _preview_setup_clip(self, clip_id, frame_index):
        record = _read_json(self._setup_clip_directory() / 'current.json', None)
        if not record or clip_id != record['clipId']:
            raise AppError('Select the current setup camera clip.', operation='setup_clip', status=404)
        path = self._verified_setup_clip_path(record)
        frame = read_video_frame(path, frame_index)
        import cv2
        capture = cv2.VideoCapture(str(path))
        try:
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            success, _ = capture.read()
            if not success:
                raise AppError('The selected camera frame could not be decoded.', operation='setup_clip')
            pts_seconds = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        finally:
            capture.release()
        height, width = frame.shape[:2]
        scale = min(1, 960/max(width,height))
        preview = cv2.resize(frame,(round(width*scale),round(height*scale))) if scale < 1 else frame
        success, encoded = cv2.imencode('.png',preview)
        if not success:
            raise AppError('The setup clip frame preview could not be encoded.', operation='setup_clip')
        return {'experimentSlug':EXPERIMENT_SLUG, 'clipId':clip_id, 'frameIndex':frame_index,
                'width':width, 'height':height, 'ptsSeconds':pts_seconds, 'frameCount':frame_count,
                'previewImage':'data:image/png;base64,'+base64.b64encode(encoded).decode()}


    def export_setup_clip_frame(self, clip_id, frame_index, destination_folder, source_kind='setup'):
        return self._call(self._export_setup_clip_frame, clip_id, frame_index, Path(destination_folder), source_kind)


    def _export_setup_clip_frame(self, clip_id, frame_index, destination_folder, source_kind):
        record = _read_json(self._setup_clip_directory() / 'current.json', None)
        if not record or clip_id != record['clipId']:
            raise AppError('Select the current setup camera clip.', operation='setup_clip', status=404)
        if source_kind not in ('setup', 'main'):
            raise AppError('Choose whether this is a separate setup video or the main recording.', operation='setup_clip')
        if not destination_folder.is_dir():
            raise AppError('Choose an existing folder for the setup PNG.', operation='setup_clip')
        frame = read_video_frame(self._verified_setup_clip_path(record), frame_index)
        destination = _export_frame_png(frame, record['name'], destination_folder)
        height, width = frame.shape[:2]
        digest = _digest(destination)
        frame_directory = self._setup_frame_directory()
        frame_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        retained = frame_directory / f'{digest}.png'
        if retained.exists():
            if _digest(retained) != digest:
                raise AppError('The retained setup PNG changed.', operation='setup_clip', status=409)
        else:
            with destination.open('rb') as original, retained.open('xb') as saved:
                shutil.copyfileobj(original, saved)
                saved.flush()
                os.fsync(saved.fileno())
            if _digest(retained) != digest:
                retained.unlink(missing_ok=True)
                raise AppError('The setup PNG changed while it was retained.', operation='setup_clip', status=409)
        metadata_path = frame_directory / f'{digest}.json'
        metadata = _read_json(metadata_path, {'sha256':digest, 'imageSize':{'width':width, 'height':height}, 'sources':[]})
        source = {'sourceKind':source_kind, 'sourceVideoName':record['name'],
                  'sourceVideoSha256':record['sha256'], 'frameIndex':frame_index}
        if source not in metadata['sources']:
            metadata['sources'].append(source)
            _write_json(metadata_path, metadata)
        return {'experimentSlug':EXPERIMENT_SLUG, 'clipId':clip_id, 'frameIndex':frame_index,
                'name':destination.name, 'width':width, 'height':height, 'sha256':digest}


    def get_setup_png(self, digest):
        return self._call(self._get_setup_png, digest)


    def _get_setup_png(self, digest):
        if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise AppError('The setup image was not retained on this Mac.', operation='setup_frame', status=404)
        path = self._setup_frame_directory() / f'{digest}.png'
        if not path.is_file():
            raise AppError('The setup image was not retained on this Mac.', operation='setup_frame', status=404)
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise AppError('The retained setup image changed.', operation='setup_frame', status=409)
        return data


    def _saved_setup(self, run_id, manifest):
        if manifest['mode'] != 'tree':
            return None
        bundle = self._verified_hosted_bundle(self._hosted_directory(run_id), manifest)
        setup = bundle.get('state', {}).get('setupSnapshot') or {}
        digest = setup.get('imageSha256')
        if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest) or not setup.get('regions'):
            return None
        metadata = _read_json(self._setup_frame_directory() / f'{digest}.json', None)
        if not metadata or metadata.get('imageSize') != setup.get('imageSize'):
            return None
        self._get_setup_png(digest)
        sources = metadata.get('sources', [])
        source = sources[0] if len(sources) == 1 else {}
        return {'imageSha256':digest, 'imageUrl':f'{HOSTED_API}setup-images/{digest}.png',
                'imageSize':setup['imageSize'], 'regions':setup['regions'],
                'retrospective':setup.get('retrospective', False), **source}


    def _attach_retained_setup(self, run_id, manifest, bundle):
        if manifest['mode'] != 'tree':
            return
        setup = bundle.get('state', {}).get('setupSnapshot') or {}
        digest = setup.get('imageSha256')
        if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            return
        if any(record['kind'] == 'setupImage' and record['sha256'] == digest
               for record in manifest['recordings'].values()):
            return
        metadata = _read_json(self._setup_frame_directory() / f'{digest}.json', None)
        if not metadata or metadata.get('imageSize') != setup.get('imageSize'):
            return
        self._get_setup_png(digest)
        self._import_hosted_recording(run_id, self._setup_frame_directory() / f'{digest}.png', 'setupImage')


    def _hosted_directory(self, run_id):
        if not isinstance(run_id, str) or not SAFE_IDENTIFIER.fullmatch(run_id) or run_id in ('.', '..'):
            raise AppError('Select a valid hosted run ID.', operation='analysis', code='invalid_run_id')
        return self._hosted_root() / run_id


    def _hosted_manifest(self, run_id):
        manifest_path = self._hosted_directory(run_id) / 'manifest.json'
        if not manifest_path.is_file():
            raise AppError('The hosted run was not imported.', operation='analysis', code='run_not_found', status=404)
        manifest = _read_json(manifest_path, None)
        if manifest.get('experimentSlug') != EXPERIMENT_SLUG or manifest.get('runId') != run_id:
            raise AppError('The retained run identity does not match this experiment.', operation='analysis', status=409)
        if any(key not in manifest for key in RUN_DISPLAY_FIELDS):
            bundle = self._verified_hosted_bundle(self._hosted_directory(run_id), manifest)
            manifest.update(_run_display_metadata(bundle))
        if 'purpose' not in manifest:
            bundle = self._verified_hosted_bundle(self._hosted_directory(run_id),manifest)
            manifest['purpose'] = bundle.get('config',{}).get('purpose')
        if manifest.get('purpose') == 'scored' and 'frozenProfile' not in manifest:
            bundle = self._verified_hosted_bundle(self._hosted_directory(run_id),manifest)
            manifest['frozenProfile'] = {'profileId':bundle['profile']['profileId'],
                'label':bundle['profile']['profileId'], 'sealedProfileJson':bundle['sealedProfileJson']}
        return manifest


    def get_run(self, run_id):
        return self._call(self._get_hosted_run, run_id)


    def _get_hosted_run(self, run_id):
        from study_timing import video_end_seconds
        manifest = self._hosted_manifest(run_id)
        recordings = copy.deepcopy(manifest['recordings'])
        for recording_id, record in recordings.items():
            record['available'] = (self._hosted_directory(run_id) / record['relativePath']).is_file()
            if not record['available']:
                continue
            if record['kind'] == 'video':
                timeline_path = self._hosted_directory(run_id) / record['timelinePath']
                if not timeline_path.is_file() or _digest(timeline_path) != record['timelineSha256']:
                    raise AppError('The retained camera timeline is missing or changed.', operation='annotation',
                        code='timeline_changed', status=409, recordingId=recording_id)
                try:
                    record['videoEndSeconds'] = video_end_seconds(_read_json(timeline_path, None))
                except ValueError as error:
                    raise AppError(f'The retained camera timeline has no usable endpoint: {error}.',
                        operation='annotation', code='video_endpoint_unavailable', status=409,
                        recordingId=recording_id) from error
            review_id = record.get('obstructionReviewId')
            if not review_id:
                continue
            entry = next((item for item in manifest.get('obstructionReviews', [])
                if item['reviewId'] == review_id), None)
            path = self._hosted_directory(run_id) / entry['relativePath'] if entry else None
            if path is None or not path.is_file() or _digest(path) != entry['sha256']:
                raise AppError('The retained obstruction review is missing or changed.',
                    operation='analysis', code='obstruction_review_changed', status=409,
                    recordingId=recording_id)
            review = _read_json(path, None)
            if not isinstance(review, dict) or review.get('reviewId') != review_id or (
                review.get('videoRecordingId') != recording_id or
                review.get('recordingSha256') != record['sha256']
            ):
                raise AppError('The obstruction review does not match the retained camera recording.',
                    operation='analysis', code='obstruction_review_changed', status=409,
                    recordingId=recording_id)
            record['savedObstructionReview'] = review
        return {**manifest, 'recordings':recordings, 'savedSetup':self._saved_setup(run_id, manifest)}


    def list_runs(self):
        return self._call(self._list_hosted_runs)


    def _list_hosted_runs(self):
        root = self._hosted_root()
        if not root.is_dir():
            return {'experimentSlug':EXPERIMENT_SLUG, 'runs':[]}
        runs = []
        for directory in sorted(root.iterdir()):
            if directory.is_dir() and (directory / 'manifest.json').is_file():
                manifest = self._hosted_manifest(directory.name)
                runs.append({'runId':manifest['runId'], 'experimentSlug':EXPERIMENT_SLUG,
                    'seriesId':manifest.get('seriesId'),
                    **{key: manifest.get(key) for key in RUN_DISPLAY_FIELDS},
                    'mode':manifest['mode'], 'purpose':manifest.get('purpose'),
                    'analysisRunning':any(item['status'] == 'running' for item in manifest['analyses'].values()) or any(job['status'] == 'running' and job['runId'] == manifest['runId'] for job in self._annotation_jobs.values()),
                    'bundleSha256':manifest['bundles'][-1]['sha256'],
                    'recordingCount':len(manifest['recordings']), 'analysisCount':len(manifest['analyses'])})
        return {'experimentSlug':EXPERIMENT_SLUG, 'runs':runs}


    def import_run_bundle(self, path):
        return self._call(self._import_run_bundle, Path(path))

    def import_collection_bundle(self, path):
        try:
            return self._call(self._import_collection_bundle, Path(path))
        finally:
            self._clear_progress()

    def _import_collection_bundle(self, path):
        from study_bundle import _load_json, load_series_bundle
        try:
            content = _load_json(path.read_bytes())
            if isinstance(content, dict) and content.get('seriesId') and 'runId' not in content:
                manifest = load_series_bundle(path)
                digest = _digest(path)
                destination = self._hosted_root() / '_series_bundles' / manifest['seriesId'] / f'{digest}.json'
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.exists():
                    _copy_original(path, destination, self._report_progress)
                if _digest(destination) != digest:
                    raise ValueError('The series bundle changed while it was retained')
                self.series_store.retain_manifest(manifest, digest)
                return {'experimentSlug': EXPERIMENT_SLUG, 'bundleKind': 'series',
                        'seriesId': manifest['seriesId'], 'sha256': digest, 'label': manifest['label']}
        except (ValueError, OSError) as error:
            raise AppError(f'The selected Tree series bundle did not pass validation: {error}',
                           operation='import_bundle', code='invalid_series_bundle',
                           corrective_action='Export the latest series bundle on hosted Series and select its unchanged JSON file.') from error
        return self._import_run_bundle(path)


    def _import_run_bundle(self, path):
        from study_bundle import load_run_bundle
        if not path.is_file():
            raise AppError('Select an existing downloaded run bundle.', operation='import_bundle')
        try:
            bundle = load_run_bundle(path)
        except (ValueError, OSError) as error:
            raise AppError(f'The selected Tree run bundle did not pass validation: {error}', operation='import_bundle',
                code='invalid_bundle', corrective_action='Export the terminal run again and select its unchanged JSON file.') from error
        if bundle.get('experimentSlug') not in (EXPERIMENT_SLUG, 'wind-prestudy'):
            raise AppError('This run bundle belongs to another experiment.', operation='import_bundle',
                code='wrong_experiment', status=409)
        run_id = bundle.get('runId')
        directory = self._hosted_directory(run_id)
        digest = _digest(path)
        manifest_path = directory / 'manifest.json'
        if manifest_path.exists():
            manifest = self._hosted_manifest(run_id)
        else:
            manifest = {'experimentSlug':EXPERIMENT_SLUG, 'runId':run_id,
                'provenance':{'experimentSlug':bundle.get('experimentSlug'), 'runId':run_id},
                'mode':bundle.get('config',{}).get('mode'),
                'purpose':bundle.get('config',{}).get('purpose'), 'bundles':[], 'recordings':{},
                'timeMaps':[], 'obstructionReviews':[], 'analyses':{}, 'configHash':bundle.get('configHash'),
                'profileHash':bundle.get('profileHash')}
        if manifest['mode'] != bundle.get('config',{}).get('mode'):
            raise AppError('The run identity is already associated with another mode.', operation='import_bundle', status=409)
        if manifest.get('purpose') not in (None,bundle.get('config',{}).get('purpose')):
            raise AppError('The run identity is already associated with another purpose.',
                operation='import_bundle', status=409)
        manifest['purpose'] = bundle.get('config',{}).get('purpose')
        manifest['seriesId'] = bundle['config'].get('seriesId')
        if manifest.get('configHash') != bundle.get('configHash') or manifest.get('profileHash') != bundle.get('profileHash'):
            raise AppError('The run revision changed its frozen configuration or profile.',
                operation='import_bundle', code='frozen_record_changed', status=409)
        if manifest['bundles'] and not any(item['sha256'] == digest for item in manifest['bundles']):
            previous_revision = manifest['bundles'][-1].get('bundleRevision')
            current_revision = bundle.get('bundleRevision')
            if type(previous_revision) is int and type(current_revision) is int and current_revision <= previous_revision:
                raise AppError('A new run bundle needs a later immutable revision.',
                    operation='import_bundle', code='non_increasing_revision', status=409)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = directory / 'bundles' / f'{digest}.json'
        destination.parent.mkdir(exist_ok=True)
        if destination.exists():
            if _digest(destination) != digest:
                raise AppError('The retained run bundle changed.', operation='import_bundle', status=409)
        else:
            with path.open('rb') as original, destination.open('xb') as copied:
                shutil.copyfileobj(original, copied)
            if _digest(destination) != digest:
                destination.unlink(missing_ok=True)
                raise AppError('The run bundle changed while being retained.', operation='import_bundle', status=409)
        if not any(item['sha256'] == digest for item in manifest['bundles']):
            manifest.update(_run_display_metadata(bundle))
            manifest['frozenProfile'] = ({'profileId':bundle['profile']['profileId'],
                'label':bundle['profile']['profileId'], 'sealedProfileJson':bundle['sealedProfileJson']}
                if bundle.get('config',{}).get('purpose') == 'scored' else None)
            manifest['bundles'].append({'sha256':digest, 'relativePath':str(destination.relative_to(directory)),
                'bundleRevision':bundle.get('bundleRevision')})
        _write_json(manifest_path, manifest)
        from study_analysis import generated_assignments
        assignments = generated_assignments(bundle)
        collected = [item['generatedAtMs'] for item in assignments if isinstance(item['generatedAtMs'], (int, float))]
        self.series_store.declare(run_id, bundle['state'].get('createdAtMs', 0), purpose=manifest['purpose'],
                                  collection_started_at_ms=min(collected) if collected else None,
                                  series_id=manifest['seriesId'], config_hash=bundle['configHash'],
                                  collection_profile_hash=bundle['profileHash'], source_release=bundle.get('codeCheckpoint'))
        self._attach_retained_setup(run_id, manifest, bundle)
        manifest = self._hosted_manifest(run_id)
        return {'experimentSlug':EXPERIMENT_SLUG, 'bundleKind':'run', 'runId':run_id, 'sha256':digest,
            'seriesId':manifest['seriesId'],
            'bundleRevision':bundle.get('bundleRevision'), 'recordings':len(manifest['recordings'])}


    def _verified_hosted_bundle(self, directory, manifest):
        from study_bundle import load_run_bundle
        latest = manifest['bundles'][-1]
        path = directory / latest['relativePath']
        if not path.is_file() or _digest(path) != latest['sha256']:
            raise AppError('The retained run bundle is missing or changed.', operation='analysis',
                code='bundle_changed', status=409)
        bundle = load_run_bundle(path)
        if bundle.get('experimentSlug') not in (EXPERIMENT_SLUG, 'wind-prestudy') or bundle.get('runId') != manifest['runId']:
            raise AppError('The retained run bundle identity changed.', operation='analysis', status=409)
        return bundle


    def import_recording(self, run_id, path, kind):
        try:
            return self._call(self._import_hosted_recording, run_id, Path(path), kind)
        finally:
            self._clear_progress()


    def _import_hosted_recording(self, run_id, path, kind):
        manifest = self._hosted_manifest(run_id)
        if kind not in ('video', 'setupImage'):
            raise AppError('Select a camera recording or setup PNG.', operation='import_recording')
        if not path.is_file():
            raise AppError('The selected original recording is unavailable.', operation='import_recording')
        suffix = path.suffix.lower()
        if ((kind == 'wind' and suffix != '.csv') or
            (kind == 'video' and suffix not in ('.mov', '.mp4', '.m4v', '.avi')) or
            (kind == 'setupImage' and suffix != '.png')):
            raise AppError('Select a supported original recording for this kind.', operation='import_recording')
        directory = self._hosted_directory(run_id)
        original_hash = _digest(path, self._report_progress)
        missing_original = next((record for record in manifest['recordings'].values()
            if record['kind'] == kind and record['sha256'] == original_hash and
            not (directory / record['relativePath']).exists()), None)
        if missing_original is not None:
            destination = directory / missing_original['relativePath']
            _copy_original(path, destination, self._report_progress)
            if _digest(destination, self._report_progress) != original_hash:
                destination.unlink(missing_ok=True)
                raise AppError('The recovered original changed while it was retained.', operation='import_recording', status=409)
            self._verified_hosted_recordings(directory, {**manifest,
                'recordings': {missing_original['recordingId']: missing_original}}, self._report_progress)
            preview = video_preview(destination) if kind == 'video' else None
            self._clear_progress()
            return {**missing_original, **({'previewImage': preview['preview_image']} if preview else {})}
        dimensions = None
        if kind == 'setupImage':
            bundle = self._verified_hosted_bundle(directory, manifest)
            snapshot = bundle.get('state',{}).get('setupSnapshot') or {}
            if bundle.get('config',{}).get('mode') != 'tree' or original_hash != snapshot.get('imageSha256'):
                raise AppError('The setup image does not match the recorded tree setup.',
                    operation='import_recording', code='setup_image_mismatch', status=409)
            import cv2
            image = cv2.imread(str(path),cv2.IMREAD_UNCHANGED)
            if image is None:
                raise AppError('The setup image cannot be decoded.', operation='import_recording',
                    code='setup_image_invalid')
            height,width = image.shape[:2]
            dimensions = {'width':width,'height':height}
            if dimensions != snapshot.get('imageSize'):
                raise AppError('The setup image size differs from the recorded tree setup.',
                    operation='import_recording', code='setup_image_size_mismatch', status=409)
        recording_id = _identifier()
        destination = directory / 'originals' / f'{recording_id}{suffix}'
        destination.parent.mkdir(exist_ok=True)
        _copy_original(path, destination, self._report_progress)
        if _digest(destination, self._report_progress) != original_hash:
            destination.unlink(missing_ok=True)
            raise AppError('The recording changed while it was retained.', operation='import_recording', status=409)
        record = {'experimentSlug':EXPERIMENT_SLUG, 'runId':run_id, 'recordingId':recording_id,
            'kind':kind, 'name':path.name, 'sha256':original_hash, 'sizeBytes':destination.stat().st_size,
            'relativePath':str(destination.relative_to(directory)), 'clockMap':None}
        if dimensions:
            record.update(dimensions)
        if kind == 'video':
            from study_timing import inspect_video_timeline
            try:
                self._report_progress(stage='Decoding first frame')
                preview = video_preview(destination)
            except AppError as error:
                destination.unlink(missing_ok=True)
                logging.warning('Camera import for run %s failed while decoding its first frame: %s',
                                run_id, error.message)
                raise AppError(error.message, operation='import_recording', code='video_frame_unavailable',
                    corrective_action='Check that this camera format can be decoded on the Mac; keep the original recording unchanged.') from error
            try:
                timeline = inspect_video_timeline(destination, progress=self._report_progress)
            except ValueError as error:
                destination.unlink(missing_ok=True)
                logging.warning('Camera import for run %s failed while reading its frame timeline: %s',
                                run_id, error)
                raise AppError(f'The camera frame timeline could not be read: {error}.',
                    operation='import_recording', code='video_timeline_unavailable',
                    corrective_action='Check the reported timeline issue; keep the original recording unchanged.') from error
            timeline_path = directory / 'timelines' / f'{recording_id}.json'
            timeline_path.parent.mkdir(exist_ok=True)
            _write_json(timeline_path, timeline)
            record.update(width=preview['width'], height=preview['height'],
                timelinePath=str(timeline_path.relative_to(directory)),
                timelineSha256=_digest(timeline_path),
                timelineSummary={'frameRate':timeline['frameRate'],
                    'decodedFrameCount':timeline['decodedFrameCount'],
                    'declaredFrameCount':timeline.get('declaredFrameCount'),
                    'timecodeSource':timeline.get('timecodeSource')})
        manifest['recordings'][recording_id] = record
        _write_json(directory / 'manifest.json', manifest)
        self._clear_progress()
        return {**record, **({'previewImage':preview['preview_image']} if kind == 'video' else {})}


    def _verified_hosted_recordings(self, directory, manifest, progress=None):
        verified = {}
        for recording_id, record in manifest['recordings'].items():
            path = directory / record['relativePath']
            if not path.is_file() or _digest(path, progress) != record['sha256']:
                raise AppError('A retained recording is missing or changed.', operation='analysis',
                    code='original_changed', status=409, recordingId=recording_id)
            verified[recording_id] = {**record, 'path':str(path)}
            if record['kind'] == 'video':
                timeline_path = directory / record['timelinePath']
                if not timeline_path.is_file() or _digest(timeline_path) != record['timelineSha256']:
                    raise AppError('The retained camera timeline is missing or changed.', operation='analysis',
                        code='timeline_changed', status=409,
                        recordingId=recording_id)
                verified[recording_id]['frameTimeline'] = _read_json(timeline_path, None)
            if record.get('timeMapId'):
                entry = next((item for item in manifest.get('timeMaps',[]) if item['timeMapId'] == record['timeMapId']), None)
                time_map_path = directory / entry['relativePath'] if entry else None
                if time_map_path is None or not time_map_path.is_file() or _digest(time_map_path) != entry['sha256']:
                    raise AppError('The retained recording clock map is missing or changed.', operation='analysis',
                        code='time_map_changed', status=409, recordingId=recording_id)
                saved = _read_json(time_map_path, None)
                map_kind = 'video' if record['kind'] == 'video' else 'csv'
                if not isinstance(saved,dict) or saved.get('mapping',{}).get(map_kind) != record['clockMap']:
                    raise AppError('The recording clock map differs from its saved reference.', operation='analysis',
                        code='time_map_changed', status=409, recordingId=recording_id)
            if record.get('obstructionReviewId'):
                entry = next((item for item in manifest.get('obstructionReviews',[])
                    if item['reviewId'] == record['obstructionReviewId']), None)
                review_path = directory / entry['relativePath'] if entry else None
                if review_path is None or not review_path.is_file() or _digest(review_path) != entry['sha256']:
                    raise AppError('The retained obstruction review is missing or changed.', operation='analysis',
                        code='obstruction_review_changed', status=409, recordingId=recording_id)
                review = _read_json(review_path, None)
                if not isinstance(review, dict) or review.get('reviewId') != entry['reviewId'] or (
                    review.get('videoRecordingId') != recording_id or review.get('recordingSha256') != record['sha256']
                ):
                    raise AppError('The obstruction review does not match the retained camera recording.',
                        operation='analysis', code='obstruction_review_changed', status=409,
                        recordingId=recording_id)
                verified[recording_id]['obstructionReview'] = review
        return verified


    def save_recording_time_map(self, run_id, video_recording_id, wind_recording_id,
                                references, csv_metadata=None):
        return self._call(self._save_recording_time_map, run_id, video_recording_id,
            wind_recording_id, references, csv_metadata)


    def _save_recording_time_map(self, run_id, video_recording_id, wind_recording_id,
                                 references, csv_metadata):
        from study_timing import map_recording_times
        manifest = self._hosted_manifest(run_id)
        directory = self._hosted_directory(run_id)
        recordings = self._verified_hosted_recordings(directory, manifest)
        video = recordings.get(video_recording_id)
        if not video or video['kind'] != 'video':
            raise AppError('Select the retained clock-reference camera recording.', operation='time_map')
        if wind_recording_id is not None and (wind_recording_id not in recordings or
                                              recordings[wind_recording_id]['kind'] != 'wind'):
            raise AppError('Select a retained wind CSV recording for the clock map.', operation='time_map')
        if wind_recording_id is None and csv_metadata is not None:
            raise AppError('CSV timing metadata requires a selected wind recording.', operation='time_map')
        try:
            mapping = map_recording_times(references, video['frameTimeline'], csv_metadata)
        except ValueError as error:
            raise AppError('The filmed clock references or CSV time format are invalid.',
                operation='time_map', code='invalid_time_reference',
                corrective_action='Choose two distinct visible reference frames and enter their displayed clock values exactly.') from error
        time_map_id = _identifier()
        record = {'experimentSlug':EXPERIMENT_SLUG, 'runId':run_id, 'timeMapId':time_map_id,
            'videoRecordingId':video_recording_id, 'windRecordingId':wind_recording_id,
            'references':copy.deepcopy(references), 'csvMetadata':copy.deepcopy(csv_metadata),
            'mapping':mapping}
        time_map_path = directory / 'time-maps' / f'{time_map_id}.json'
        time_map_path.parent.mkdir(exist_ok=True)
        _write_json(time_map_path, record)
        manifest['timeMaps'].append({'timeMapId':time_map_id,
            'relativePath':str(time_map_path.relative_to(directory)),
            'sha256':_digest(time_map_path),
            'videoRecordingId':video_recording_id, 'windRecordingId':wind_recording_id,
            'qualified':mapping['qualified'], 'qualityReasons':mapping['quality_reasons']})
        for identifier, kind in ((video_recording_id,'video'), (wind_recording_id,'csv')):
            if identifier is not None:
                manifest['recordings'][identifier].update(clockMap=mapping[kind],
                    timeMapId=time_map_id, timeMappingQualified=mapping['qualified'],
                    timeMappingQualityReasons=mapping['quality_reasons'])
        _write_json(directory / 'manifest.json', manifest)
        return {'experimentSlug':EXPERIMENT_SLUG, 'runId':run_id, 'timeMapId':time_map_id, **mapping}


    def save_obstruction_review(self, run_id, video_recording_id, decision, spans):
        return self._call(self._save_obstruction_review, run_id, video_recording_id, decision, spans)


    def _save_obstruction_review(self, run_id, video_recording_id, decision, spans):
        from study_timing import map_video_time
        manifest = self._hosted_manifest(run_id)
        if manifest['mode'] != 'tree':
            raise AppError('Obstruction review belongs to a tree recording.', operation='obstruction_review')
        directory = self._hosted_directory(run_id)
        recordings = self._verified_hosted_recordings(directory, manifest)
        video = recordings.get(video_recording_id)
        if not video or video['kind'] != 'video':
            raise AppError('Select the retained tree camera recording.', operation='obstruction_review')
        if decision not in ('clear', 'obstructed') or not isinstance(spans, list) or (
            decision == 'clear' and spans or decision == 'obstructed' and not spans
        ):
            raise AppError('Mark the recording clear or supply its obstructed frame ranges.',
                operation='obstruction_review')
        frames = video['frameTimeline']['frames']
        frame_positions = {frame['frameIndex']:index for index,frame in enumerate(frames)}
        mapped_spans = []
        previous_end = -1
        if spans and not video.get('clockMap'):
            raise AppError('Map the camera clock before marking obstructed frames.',
                operation='obstruction_review', code='clock_map_missing')
        for span in spans:
            if not isinstance(span, dict) or set(span) != {'startFrameIndex', 'endFrameIndex'}:
                raise AppError('Each obstruction needs its first and last frame.', operation='obstruction_review')
            first_index, last_index = span['startFrameIndex'], span['endFrameIndex']
            if (type(first_index) is not int or type(last_index) is not int or
                first_index not in frame_positions or last_index not in frame_positions or
                frame_positions[first_index] > frame_positions[last_index] or
                frame_positions[first_index] <= previous_end):
                raise AppError('Obstructed frame ranges must be ordered, valid and disjoint.',
                    operation='obstruction_review')
            first_position, last_position = frame_positions[first_index], frame_positions[last_index]
            first_pts = frames[first_position]['ptsSeconds']
            if last_position + 1 < len(frames):
                end_pts = frames[last_position + 1]['ptsSeconds']
                estimated = False
            else:
                step = (frames[last_position]['ptsSeconds'] - frames[last_position-1]['ptsSeconds']
                    if last_position else 1 / video['frameTimeline']['frameRate'])
                if step <= 0:
                    raise AppError('The camera frame timeline has no positive end interval.',
                        operation='obstruction_review', code='invalid_frame_timeline')
                end_pts = frames[last_position]['ptsSeconds'] + step
                estimated = True
            mapped_spans.append({'startFrameIndex':first_index, 'endFrameIndex':last_index,
                'startAtMs':round(map_video_time(first_pts, video['clockMap']) * 1000),
                'endAtMs':round(map_video_time(end_pts, video['clockMap']) * 1000),
                'endBoundaryEstimated':estimated})
            previous_end = last_position
        review_id = _identifier()
        review = {'experimentSlug':EXPERIMENT_SLUG, 'runId':run_id, 'reviewId':review_id,
            'videoRecordingId':video_recording_id, 'recordingSha256':video['sha256'],
            'timeMapId':video.get('timeMapId') if mapped_spans else None,
            'decision':decision, 'spans':mapped_spans, 'reviewedAtMs':round(time.time() * 1000),
            'source':'manual_post_recording_review'}
        review_path = directory / 'obstruction-reviews' / f'{review_id}.json'
        review_path.parent.mkdir(exist_ok=True)
        _write_json(review_path, review)
        manifest.setdefault('obstructionReviews',[]).append({'reviewId':review_id,
            'videoRecordingId':video_recording_id, 'sha256':_digest(review_path),
            'relativePath':str(review_path.relative_to(directory)), 'decision':decision,
            'timeMapId':review['timeMapId']})
        manifest['recordings'][video_recording_id]['obstructionReviewId'] = review_id
        _write_json(directory / 'manifest.json', manifest)
        return review


    def original_hash(self, run_id, recording_id):
        return self._call(self._original_hosted_hash, run_id, recording_id)


    def _original_hosted_hash(self, run_id, recording_id):
        manifest = self._hosted_manifest(run_id)
        record = manifest['recordings'].get(recording_id)
        if record is None:
            raise AppError('The recording was not imported for this run.', operation='analysis', status=404)
        self._verified_hosted_recordings(self._hosted_directory(run_id), manifest)
        return record['sha256']


    def _resolve_hosted_profile(self, profile_id):
        from study_profiles import BUILTIN_PROFILE_PATHS, load_profile
        if profile_id in BUILTIN_PROFILE_PATHS:
            return load_profile(BUILTIN_PROFILE_PATHS[profile_id])
        if not isinstance(profile_id, str) or not SAFE_IDENTIFIER.fullmatch(profile_id):
            raise AppError('Select a saved analysis profile ID.', operation='analysis')
        profile_path = self.directory / 'profiles' / f'{profile_id}.json'
        if not profile_path.is_file():
            raise AppError('The selected analysis profile is unavailable.', operation='analysis', status=404)
        return load_profile(profile_path)


    def _list_hosted_profiles(self):
        from study_profiles import BUILTIN_PROFILE_PATHS, PROFILE_LABELS, load_profile
        paths = [*BUILTIN_PROFILE_PATHS.values(), *sorted((self.directory / 'profiles').glob('*.json'))]
        profiles = []
        for path in paths:
            loaded = load_profile(path)
            identifier = loaded['profile']['profileId']
            if path not in BUILTIN_PROFILE_PATHS.values() and (identifier in BUILTIN_PROFILE_PATHS or path.stem != identifier):
                raise AppError('A saved profile filename does not match its profile ID.', operation='profiles')
            profiles.append({'profileId':identifier,
                'label':loaded['profile'].get('label', PROFILE_LABELS.get(identifier, identifier)),
                'sealedProfileJson':loaded['sealedProfileJson']})
        return {'profiles':profiles}


    def start_analysis(self, run_id, profile_id):
        return self._call(self._start_hosted_analysis, run_id, profile_id)


    def _finalize_missing_measurements(self, run_id, profile_id, reason):
        from study_missing import missing_measurement_reason
        try:
            reason = missing_measurement_reason(reason)
        except ValueError as error:
            raise AppError(str(error), operation='analysis', code='missing_measurement_reason_required') from error
        return self._start_hosted_analysis(run_id, profile_id, missing_reason=reason)


    def _missing_measurement_inputs(self, directory, manifest, bundle, profile, profile_hash, reason):
        from study_missing import analyze_missing_measurements
        if manifest['mode'] != 'tree':
            raise AppError('Only Tree runs can be finalized with missing measurements.', operation='analysis')
        available, missing = {}, []
        for recording_id, record in manifest['recordings'].items():
            if (directory / record['relativePath']).is_file():
                if record['kind'] == 'video':
                    raise AppError('The camera original is available. Analyze its retained footage.',
                        operation='analysis', code='video_recording_available', status=409)
                available[recording_id] = record
            else:
                missing.append({key: record[key] for key in ('recordingId', 'kind', 'name', 'sha256', 'sizeBytes')})
        verified = self._verified_hosted_recordings(directory, {**manifest, 'recordings': available})
        # The retained list preserves completion order across restart; UUID-keyed manifests do not.
        completed = [manifest['analyses'][revision['revisionId']]
            for revision in reversed(self.series_store.state['runs'][manifest['runId']]['revisions'])
            if revision['revisionId'] in manifest['analyses'] and
            manifest['analyses'][revision['revisionId']]['status'] == 'completed']
        originals = [entry for entry in completed if 'measurementDisposition' not in entry]
        candidates = originals or completed
        retained = next((entry for entry in candidates if entry['bundleSha256'] == manifest['bundles'][-1]['sha256'] and
            entry['profileSha256'] == profile_hash), candidates[0] if candidates else None)
        artifact = None
        if retained:
            self._get_hosted_analysis(manifest['runId'], retained['analysisId'])
            artifact = _read_json(directory / retained['outputPath'], None)
        disposition = {'schemaVersion': 1, 'kind': 'video_recording_missing', 'runId': manifest['runId'],
            'reason': reason, 'recordedAtMs': int(time.time() * 1000),
            'bundleSha256': manifest['bundles'][-1]['sha256'], 'profileSha256': profile_hash,
            'collectionStartedAtMs': self.series_store.state['runs'][manifest['runId']].get('collectionStartedAtMs'),
            'missingRecordings': missing,
            'retainedAnalysis': {'analysisId': retained['analysisId'], 'sha256': retained['outputSha256']} if retained else None,
            'videoExtractionRepeatable': False}
        try:
            # Check eligibility before saving a new analysis; the worker checks these sealed inputs again.
            analyze_missing_measurements(bundle, profile, disposition,
                bundle_sha256=disposition['bundleSha256'], profile_sha256=profile_hash,
                input_hashes={identifier: record['sha256'] for identifier, record in verified.items()},
                retained_artifact=artifact, retained_sha256=retained['outputSha256'] if retained else None)
        except (ValueError, KeyError, TypeError) as error:
            raise AppError(str(error), operation='analysis', code='retained_measurements_mismatch', status=409) from error
        return available, disposition


    def _verified_missing_measurement_inputs(self, directory, manifest, analysis):
        path = directory / analysis['measurementDispositionPath']
        if not path.is_file() or _digest(path) != analysis['derivedInputHashes']['measurementDisposition']:
            raise AppError('The retained missing-measurement disposition is missing or changed.',
                operation='analysis', code='measurement_disposition_changed', status=409)
        disposition = _read_json(path, None)
        if disposition != analysis['measurementDisposition']:
            raise AppError('The retained missing-measurement disposition changed.', operation='analysis', status=409)
        for record in disposition['missingRecordings']:
            original = manifest['recordings'].get(record['recordingId'])
            if original is None or any(original.get(key) != value for key, value in record.items()) or (
                directory / original['relativePath']).exists():
                raise AppError('A declared missing original changed or became available; analyze the recovered recording.',
                    operation='analysis', status=409)
        retained = disposition['retainedAnalysis']
        artifact = None
        if retained:
            entry = manifest['analyses'].get(retained['analysisId'])
            if not entry or entry['status'] != 'completed' or entry.get('outputSha256') != retained['sha256']:
                raise AppError('The retained measurement analysis identity changed.', operation='analysis', status=409)
            path = directory / entry['outputPath']
            if not path.is_file() or _digest(path) != retained['sha256']:
                raise AppError('The retained measurement artifact is missing or changed.', operation='analysis', status=409)
            artifact = _read_json(path, None)
        return disposition, artifact


    def _start_hosted_analysis(self, run_id, profile_id, *, missing_reason=None):
        manifest = self._hosted_manifest(run_id)
        directory = self._hosted_directory(run_id)
        bundle = self._verified_hosted_bundle(directory, manifest)
        if bundle.get('config',{}).get('purpose') == 'scored':
            profile = bundle.get('profile')
            sealed_profile = bundle.get('sealedProfileJson')
            profile_hash = bundle.get('profileHash')
            if not isinstance(profile, dict) or not isinstance(sealed_profile, str) or (
                profile.get('profileId') != profile_id or
                bundle['config'].get('analysisProfileId') != profile_id or
                hashlib.sha256(sealed_profile.encode('utf-8')).hexdigest() != profile_hash or
                json.loads(sealed_profile) != profile):
                raise AppError('The scored run profile differs from its frozen record.',
                    operation='analysis', code='frozen_profile_changed', status=409)
        else:
            resolved = self.profile_resolver(profile_id)
            profile = resolved['profile'] if isinstance(resolved,dict) and 'profile' in resolved else resolved
            if not isinstance(profile, dict) or profile.get('profileId') != profile_id:
                raise AppError('The saved analysis profile identity does not match the request.', operation='analysis', status=409)
            sealed_profile = (resolved.get('sealedProfileJson') if isinstance(resolved,dict) else None)
            if sealed_profile is None:
                sealed_profile = json.dumps(profile, sort_keys=True, separators=(',', ':'), allow_nan=False)
            profile_hash = hashlib.sha256(sealed_profile.encode('utf-8')).hexdigest()
            if isinstance(resolved,dict) and resolved.get('sha256') not in (None, profile_hash):
                raise AppError('The saved analysis profile hash does not match its bytes.', operation='analysis', status=409)
        from study_profiles import AREA_GRID_MEAN, measurement_method
        if bundle.get('config', {}).get('purpose') == 'scored' and measurement_method(profile) == AREA_GRID_MEAN:
            raise AppError('The area-grid method is available for preparation only.', operation='analysis', status=409)
        disposition = None
        if missing_reason is not None:
            available, disposition = self._missing_measurement_inputs(directory, manifest, bundle, profile, profile_hash, missing_reason)
        else:
            available = manifest['recordings']
        analysis_id = _identifier()
        code_hashes = _analysis_code_hashes()
        code_hash = hashlib.sha256(json.dumps(code_hashes, sort_keys=True,
            separators=(',', ':')).encode()).hexdigest()
        derived_input_hashes = {f'{identifier}:timeline':record['timelineSha256']
            for identifier,record in available.items() if record['kind'] == 'video'}
        active_maps = {record.get('timeMapId') for record in available.values()}
        active_reviews = {record.get('obstructionReviewId') for record in available.values()}
        derived_input_hashes.update({item['timeMapId']:item['sha256'] for item in manifest.get('timeMaps',[])
            if item['timeMapId'] in active_maps})
        derived_input_hashes.update({item['reviewId']:item['sha256']
            for item in manifest.get('obstructionReviews',[]) if item['reviewId'] in active_reviews})
        required_kind = 'video' if manifest['mode'] == 'tree' else 'wind'
        quality_reasons = [] if any(item['kind'] == required_kind for item in manifest['recordings'].values()) else [f'{required_kind}_recording_missing']
        if manifest['mode'] == 'tree' and not quality_reasons:
            for record in manifest['recordings'].values():
                if record['kind'] != 'video':
                    continue
                entry = next((item for item in manifest.get('obstructionReviews',[])
                    if item['reviewId'] == record.get('obstructionReviewId')), None)
                if entry is None:
                    quality_reasons.append('obstruction_review_missing')
                elif entry['decision'] == 'obstructed' and entry['timeMapId'] != record.get('timeMapId'):
                    quality_reasons.append('obstruction_review_time_map_changed')
        analysis = {'experimentSlug':EXPERIMENT_SLUG, 'runId':run_id, 'analysisId':analysis_id,
            'profileId':profile_id, 'profileSha256':profile_hash,
            'bundleSha256':manifest['bundles'][-1]['sha256'],
            'codeHashes':code_hashes, 'codeSha256':code_hash,
            'inputHashes':{identifier:record['sha256'] for identifier,record in available.items()},
            'derivedInputHashes':derived_input_hashes,
            'status':'pending' if quality_reasons else 'running', 'qualityReasons':quality_reasons,
            'outputPath':None, 'error':None}
        if disposition is not None:
            disposition_path = directory / 'dispositions' / f'{analysis_id}.json'
            disposition_path.parent.mkdir(exist_ok=True)
            _write_json(disposition_path, disposition)
            derived_input_hashes['measurementDisposition'] = _digest(disposition_path)
            if disposition['retainedAnalysis']:
                derived_input_hashes['retainedAnalysis'] = disposition['retainedAnalysis']['sha256']
            analysis.update(status='running', qualityReasons=['video_recording_missing'],
                measurementDisposition=disposition,
                measurementDispositionPath=str(disposition_path.relative_to(directory)))
        manifest['analyses'][analysis_id] = analysis
        _write_json(directory / 'manifest.json', manifest)
        if quality_reasons and disposition is None:
            return copy.deepcopy(analysis)
        self._report_progress(stage='Verifying retained originals', analysisId=analysis_id, runId=run_id)
        future = self._executor.submit(self._work_hosted_analysis, directory, copy.deepcopy(manifest),
            copy.deepcopy(bundle), copy.deepcopy(profile), sealed_profile, analysis_id)
        future.add_done_callback(lambda completed:self._commands.put((Future(),self._finish_hosted_analysis,
            (run_id, analysis_id, completed))))
        return copy.deepcopy(analysis)


    def _work_hosted_analysis(self, directory, manifest, bundle, profile, sealed_profile, analysis_id):
        analysis = manifest['analyses'][analysis_id]
        verified_bundle = self._verified_hosted_bundle(directory, manifest)
        if verified_bundle != bundle:
            raise AppError('The retained run bundle changed before analysis.', operation='analysis', status=409)
        input_manifest = {**manifest, 'recordings': {identifier: manifest['recordings'][identifier]
            for identifier in analysis['inputHashes']}}
        recordings = self._verified_hosted_recordings(directory, input_manifest, self._report_progress)
        if _analysis_code_hashes() != analysis['codeHashes']:
            raise AppError('Analysis code changed after this job was started.', operation='analysis',
                code='analysis_code_changed', status=409)
        if 'measurementDisposition' in analysis:
            from study_missing import analyze_missing_measurements
            disposition, retained = self._verified_missing_measurement_inputs(directory, manifest, analysis)
            self._report_progress(stage='Finalizing missing measurements')
            result = analyze_missing_measurements(bundle, profile, disposition,
                bundle_sha256=analysis['bundleSha256'], profile_sha256=analysis['profileSha256'],
                input_hashes=analysis['inputHashes'], retained_artifact=retained,
                retained_sha256=disposition['retainedAnalysis']['sha256'] if retained else None)
        else:
            self._report_progress(stage='Analyzing retained recordings')
            result = self.hosted_analyzer(bundle, recordings, profile)
        if not isinstance(result, dict):
            raise AppError('Analysis did not return a result object.', operation='analysis')
        self._verified_hosted_bundle(directory, manifest)
        self._verified_hosted_recordings(directory, input_manifest, self._report_progress)
        if 'measurementDisposition' in analysis:
            self._verified_missing_measurement_inputs(directory, manifest, analysis)
        if result.get('status') == 'pending':
            return {'status':'pending', 'qualityReasons':result.get('qualityReasons',[])}
        if _analysis_code_hashes() != analysis['codeHashes']:
            raise AppError('Analysis code changed while this result was calculated.', operation='analysis',
                code='analysis_code_changed', status=409)
        from tree_report import build_tree_report
        from tree_source_release import runtime_identity
        result.update(revisionId=analysis_id, profileHash=analysis['profileSha256'])
        result['report'] = build_tree_report(result)
        artifact = {**{key:analysis[key] for key in ('experimentSlug','runId','analysisId','profileId',
            'profileSha256','bundleSha256','inputHashes','derivedInputHashes','codeHashes','codeSha256')},
            'sealedProfileJson':sealed_profile,
            'inputRecordings':{identifier:{key:copy.deepcopy(value) for key,value in record.items()
                if key not in ('path','relativePath','timelinePath','sourcePath','filename','frameTimeline','obstructionReview')}
                for identifier,record in recordings.items()},
            'runtime':runtime_identity(),
            'status':'completed', 'result':result}
        destination = directory / 'analysis' / f'{analysis_id}.json'
        destination.parent.mkdir(exist_ok=True)
        with destination.open('x', encoding='utf-8') as stream:
            json.dump(artifact, stream, allow_nan=False, sort_keys=True, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        return {'status':'completed', 'outputPath':str(destination.relative_to(directory)),
            'outputSha256':_digest(destination)}


    def _finish_hosted_analysis(self, run_id, analysis_id, future):
        directory = self._hosted_directory(run_id)
        manifest = self._hosted_manifest(run_id)
        analysis = manifest['analyses'][analysis_id]
        try:
            outcome = future.result()
            analysis.update(outcome)
            if analysis['status'] == 'completed':
                retained = _read_json(directory / analysis['outputPath'], None)
                self.series_store.accept(retained['result'])
        except Exception as error:
            logging.warning('Hosted analysis %s for run %s failed (%s); retained results remain available',
                analysis_id, run_id, type(error).__name__)
            public = error if isinstance(error, AppError) else AppError('The recording analysis failed.',
                operation='analysis', code='analysis_failed',
                corrective_action='Check the unchanged run bundle, original recordings and analysis profile, then start a new analysis.')
            analysis.update(status='failed', error=public.public())
        _write_json(directory / 'manifest.json', manifest)
        self._clear_progress()


    def preview_hosted_frame(self, run_id, recording_id, frame_index):
        return self._call(self._preview_hosted_frame, run_id, recording_id, frame_index)


    def _preview_hosted_frame(self, run_id, recording_id, frame_index):
        from study_timing import frame_selection_uncertainty_ms
        record = self._hosted_manifest(run_id)['recordings'].get(recording_id)
        if not record or record['kind'] != 'video':
            raise AppError('Select an imported camera recording.', operation='preview_frame', status=404)
        path = self._hosted_directory(run_id) / record['relativePath']
        if not path.is_file() or _digest(path) != record['sha256']:
            raise AppError('The retained camera recording changed.', operation='preview_frame', status=409)
        timeline = _read_json(self._hosted_directory(run_id) / record['timelinePath'], None)
        if not isinstance(timeline,dict):
            raise AppError('The retained camera timeline is unavailable.', operation='preview_frame', status=409)
        mark = next((item for item in timeline['frames'] if item['frameIndex'] == frame_index), None)
        if mark is None:
            raise AppError('The selected camera frame is outside the decoded timeline.', operation='preview_frame')
        frame = read_video_frame(path, frame_index)
        import cv2
        height, width = frame.shape[:2]
        scale = min(1, 960/max(width,height))
        preview = cv2.resize(frame,(round(width*scale),round(height*scale))) if scale < 1 else frame
        success, encoded = cv2.imencode('.png',preview)
        if not success:
            raise AppError('The camera frame preview could not be encoded.', operation='preview_frame')
        return {'experimentSlug':EXPERIMENT_SLUG, 'runId':run_id, 'recordingId':recording_id,
            'frameIndex':frame_index, 'width':width, 'height':height,
            'frameCount':len(timeline['frames']),
            'frameSelectionUncertaintyMs':(frame_selection_uncertainty_ms(timeline['frames'], frame_index)
                if len(timeline['frames']) > 1 else None),
            'ptsSeconds':mark['ptsSeconds'], 'timecode':mark.get('timecode'),
            'timecodeSource':timeline.get('timecodeSource'),
            'previewImage':'data:image/png;base64,'+base64.b64encode(encoded).decode()}


    def get_analysis(self, run_id, analysis_id):
        return self._call(self._get_hosted_analysis, run_id, analysis_id)




    def _get_hosted_analysis(self, run_id, analysis_id):
        manifest = self._hosted_manifest(run_id)
        if not isinstance(analysis_id, str) or not SAFE_IDENTIFIER.fullmatch(analysis_id):
            raise AppError('Select a valid analysis ID.', operation='analysis')
        analysis = manifest['analyses'].get(analysis_id)
        if not analysis:
            raise AppError('The analysis was not found.', operation='analysis', status=404)
        if analysis['status'] != 'completed':
            return copy.deepcopy(analysis)
        artifact_path = self._hosted_directory(run_id) / analysis['outputPath']
        if not artifact_path.is_file():
            raise AppError('The retained analysis artifact is unavailable.', operation='analysis', status=409)
        if not analysis.get('outputSha256') or _digest(artifact_path) != analysis['outputSha256']:
            raise AppError('The retained analysis artifact changed.', operation='analysis',
                code='analysis_artifact_changed', status=409)
        from tree_report import build_tree_report
        artifact = _read_json(artifact_path, None)
        artifact['displayReport'] = build_tree_report(artifact['result'])
        artifact['displayReportSourceHash'] = _digest(Path(__file__).parent / 'tree_report.py')
        return artifact

    def _comparison_candidates(self):
        runs = []
        for item in self._list_hosted_runs()['runs']:
            if item.get('mode') != 'tree' or item.get('purpose') != 'preparation':
                continue
            manifest = self._hosted_manifest(item['runId'])
            runs.append({**{key: item.get(key) for key in ('runId', 'tag', 'createdAtMs', 'recordingStartedAtMs', 'seriesId')},
                         'analyses': [{key: analysis.get(key) for key in
                                       ('analysisId', 'profileId', 'profileSha256', 'status', 'qualityReasons', 'error')}
                                      for analysis in manifest['analyses'].values()]})
        runs.sort(key=lambda item: (item['recordingStartedAtMs'] if item['recordingStartedAtMs'] is not None else item['createdAtMs'],
                                    item['createdAtMs'], item['runId']))
        return {'runs': runs, 'profiles': self._list_hosted_profiles()['profiles']}

    def _saved_comparisons(self):
        return {'comparisons': self.comparison_store.list()}

    def _saved_comparison(self, comparison_id):
        from tree_report import build_tree_report
        try:
            saved = self.comparison_store.get(comparison_id)
        except (ValueError, OSError) as error:
            raise AppError('The saved method comparison was not found.', operation='comparison', status=404) from error
        return {**saved, 'leftDisplayReport': build_tree_report(saved['left']),
                'rightDisplayReport': build_tree_report(saved['right'])}

    def _save_comparison(self, payload):
        from study_profiles import ProfileRepository
        repository = ProfileRepository(self.directory / 'profiles')
        try:
            left_profile = repository.load(payload.get('leftProfileId'))
            right_profile = repository.load(payload.get('rightProfileId'))
            names = {item['profileId']: item['label'] for item in self._list_hosted_profiles()['profiles']}
            for profile in (left_profile, right_profile):
                profile['label'] = names[profile['profile']['profileId']]
            selected = payload.get('rows')
            if not isinstance(selected, list) or not selected:
                raise ValueError('Select at least one recording for comparison')
            candidate_runs = self._comparison_candidates()['runs']
            order = {run['runId']: index for index, run in enumerate(candidate_runs)}
            by_id = {run['runId']: run for run in candidate_runs}
            rows = []
            seen = set()
            for row in selected:
                if not isinstance(row, dict) or set(row) != {'runId', 'leftAnalysisId', 'rightAnalysisId'}:
                    raise ValueError('Select exact left and right analysis revisions for each recording')
                run_id = row['runId']
                if run_id not in order or run_id in seen:
                    raise ValueError('Choose each preparation Tree recording once')
                seen.add(run_id)
                sides = {}
                for side in ('left', 'right'):
                    analysis_id = row[f'{side}AnalysisId']
                    sides[side] = self._get_hosted_analysis(run_id, analysis_id) if analysis_id else None
                rows.append({'runId': run_id, 'tag': by_id[run_id].get('tag'),
                             'createdAtMs': by_id[run_id].get('createdAtMs'),
                             'recordingStartedAtMs': by_id[run_id].get('recordingStartedAtMs'), **sides})
            rows.sort(key=lambda row: order[row['runId']])
            return self.comparison_store.create(payload.get('label'), left_profile, right_profile, rows)
        except (ValueError, OSError, KeyError) as error:
            raise AppError(str(error), operation='comparison') from error






    def _record_hosted_request(self, route, payload, result):
        root = self._hosted_root()
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        requests = _read_json(root / 'requests.json', {})
        requests[payload['requestId']] = {'fingerprint':self._hosted_request_fingerprint(route, payload),
            'result':copy.deepcopy(result)}
        _write_json(root / 'requests.json', requests)


    def _dispatch_hosted_route(self, method, route, payload):
        endpoint = route.removeprefix(HOSTED_API)
        if endpoint == 'publication' or endpoint.startswith('publication/'):
            return self._dispatch_publication(method, route, endpoint, payload)
        if method == 'GET':
            if endpoint == 'progress':
                return self.operation_progress()
            if endpoint == 'profiles':
                return self._call(self._list_hosted_profiles)
            if endpoint == 'comparison-candidates':
                return self._call(self._comparison_candidates)
            if endpoint == 'comparisons':
                return self._call(self._saved_comparisons)
            match = re.fullmatch(r'comparisons/([a-f0-9]{32})', endpoint)
            if match:
                return self._call(self._saved_comparison, match.group(1))
            if endpoint == 'setup-clip':
                return self.get_setup_clip()
            if endpoint == 'runs':
                return self.list_runs()
            match = re.fullmatch(r'annotations/([a-f0-9]{32})', endpoint)
            if match:
                return self._call(self._get_annotation, match.group(1))
            if endpoint == 'annotations':
                return self._call(lambda: {'jobs': copy.deepcopy(list(self._annotation_jobs.values()))})
            if endpoint == 'series':
                return self._call(self._accumulating_series)
            match = re.fullmatch(r'series/([A-Za-z0-9_-]{1,80})', endpoint)
            if match:
                return self._call(self._accumulating_series, match.group(1))
            match = re.fullmatch(r'runs/([A-Za-z0-9][A-Za-z0-9._-]{0,127})', endpoint)
            if match:
                return self.get_run(match.group(1))
            match = re.fullmatch(r'runs/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/analyses/([A-Za-z0-9][A-Za-z0-9._-]{0,127})', endpoint)
            if match:
                return self.get_public_analysis(match.group(1), match.group(2))
            raise AppError('Unknown Mac analysis route.', operation='analysis', status=404)
        if method != 'POST' or endpoint not in ('import-bundle', 'import-recording', 'start-analysis',
                                                'import-setup-clip', 'preview-setup-clip', 'export-setup-clip-frame',
                                                'preview-frame', 'save-time-map',
                                                'save-obstruction-review', 'save-profile', 'select-profile', 'select-revision',
                                                'import-retained-setup', 'export-report', 'export-annotated-clip',
                                                'save-comparison', 'finalize-missing-measurements'):
            raise AppError('Unknown Mac analysis route.', operation='analysis', status=404)
        from study_http import finite_json
        if not isinstance(payload, dict):
            raise AppError('An analysis request needs one JSON object.', operation='analysis')
        try:
            finite_json(payload)
        except ValueError as error:
            raise AppError('Analysis request numbers must be finite.', operation='analysis') from error
        if endpoint == 'finalize-missing-measurements' and set(payload) != {'requestId', 'runId', 'profileId', 'reason'}:
            raise AppError('Finalization needs only requestId, runId, profileId and reason fields.', operation='analysis')
        forbidden = {'path','sourcePath','destination','destinationPath','folder','file'}
        if forbidden & set(payload):
            raise AppError('Choose local files and folders through the native Mac picker.', operation='analysis')
        self.publication_jobs.require_available()
        with self._hosted_request_lock:
            previous = self._call(self._prior_hosted_request, route, payload)
            if previous is not None:
                return previous
            self._call(self._require_idle)
            if any(item['status'] == 'running' for run in self.list_runs()['runs']
                   for item in self.get_run(run['runId'])['analyses'].values()):
                raise AppError('Wait for the current analysis before changing recordings or settings.', status=409)
            if endpoint == 'import-setup-clip':
                paths = self.picker.choose('video')
                if len(paths) > 1:
                    raise AppError('Choose one setup camera clip.', operation='setup_clip')
                result = self.import_setup_clip(paths[0]) if paths else {'cancelled':True}
            elif endpoint == 'preview-setup-clip':
                result = self.preview_setup_clip(payload.get('clipId'), payload.get('frameIndex'))
            elif endpoint == 'export-setup-clip-frame':
                paths = self.picker.choose('folder')
                result = self.export_setup_clip_frame(payload.get('clipId'), payload.get('frameIndex'),
                    paths[0], payload.get('sourceKind', 'setup')) if paths else {'cancelled':True}
            elif endpoint == 'import-retained-setup':
                paths = self.picker.choose('folder')
                result = self.import_retained_setup(paths[0]) if paths else {'cancelled': True}
            elif endpoint == 'save-profile':
                result = self._call(self._save_profile, payload.get('runId'), payload.get('profile'))
            elif endpoint == 'select-profile':
                result = self._call(self._select_profile, payload.get('runId'), payload.get('profileId'))
            elif endpoint == 'select-revision':
                result = self._call(self._select_revision, payload.get('runId'), payload.get('analysisId'))
            elif endpoint == 'save-comparison':
                result = self._call(self._save_comparison, payload)
            elif endpoint == 'export-report':
                paths = self.picker.choose('folder')
                result = self._call(self._export_report, paths[0], payload.get('seriesId')) if paths else {'cancelled': True}
            elif endpoint == 'export-annotated-clip':
                paths = self.picker.choose('folder')
                result = self._call(self._start_annotation, payload, paths[0]) if paths else {'cancelled': True}
            elif endpoint == 'import-bundle':
                paths = self.picker.choose('bundle')
                if len(paths) > 1:
                    raise AppError('Choose one downloaded run bundle.', operation='import_bundle')
                result = self.import_collection_bundle(paths[0]) if paths else {'cancelled':True}
            elif endpoint == 'import-recording':
                kind = payload.get('kind')
                if kind not in ('video','setupImage'):
                    raise AppError('Choose a camera video or setup image before selecting an original.', operation='import_recording')
                run_id = payload.get('runId')
                self.get_run(run_id)
                paths = self.picker.choose(kind)
                if kind == 'setupImage' and len(paths) > 1:
                    raise AppError('Choose one exact tree setup image.', operation='import_recording')
                result = {'cancelled':False, 'recordings':[self.import_recording(run_id, path, kind) for path in paths]} if paths else {'cancelled':True, 'recordings':[]}
            elif endpoint == 'finalize-missing-measurements':
                result = self._call(self._finalize_missing_measurements, payload.get('runId'), payload.get('profileId'), payload.get('reason'))
            elif endpoint == 'start-analysis':
                result = self.start_analysis(payload.get('runId'), payload.get('profileId'))
            elif endpoint == 'preview-frame':
                result = self.preview_hosted_frame(payload.get('runId'), payload.get('recordingId'), payload.get('frameIndex'))
            elif endpoint == 'save-time-map':
                result = self.save_recording_time_map(payload.get('runId'), payload.get('videoRecordingId'),
                    payload.get('windRecordingId'), payload.get('references'), payload.get('csvMetadata'))
            elif endpoint == 'save-obstruction-review':
                result = self.save_obstruction_review(payload.get('runId'), payload.get('videoRecordingId'),
                    payload.get('decision'), payload.get('spans'))
            if not result.get('cancelled'):
                self._call(self._record_hosted_request, route, payload, result)
            return result



    def _dispatch_publication(self, method, route, endpoint, payload):
        if method == 'GET':
            if endpoint == 'publication': return self.publication_jobs.summaries()
            match = re.fullmatch(r'publication/([a-f0-9-]{36})', endpoint)
            if match: return self.publication_jobs.summaries(match.group(1))
        start = re.fullmatch(r'publication/([a-f0-9-]{36})/start', endpoint)
        if method != 'POST' or not (endpoint == 'publication/prepare' or start):
            raise AppError('Unknown publication route.', operation='publication', status=404)
        if not isinstance(payload, dict) or set(payload) - ({'requestId', 'seriesId', 'environment', 'correctionReason', 'softwareTest'} if not start else {'requestId'}):
            raise AppError('Publication needs one bounded request object.', operation='publication')
        from study_http import finite_json
        try: finite_json(payload)
        except ValueError: raise AppError('Publication request numbers must be finite.', operation='publication')
        with self._hosted_request_lock:
            previous = self._prior_hosted_request(route, payload)
            if previous is not None: return previous
            self.publication_jobs.require_available()
            self._call(self._require_idle)
            result = self._call(self.publication_jobs.reserve_start, start.group(1)) if start else self._call(self.publication_jobs.create, payload)
            self._call(self._record_hosted_request, route, payload, result)
            if result['status'] != 'completed': self.publication_jobs.launch(result['jobId'], upload=bool(start))
            return result


    def _get_annotation(self, identifier):
        if identifier not in self._annotation_jobs:
            raise AppError('The annotated clip was not found.', operation='annotation', status=404)
        return copy.deepcopy(self._annotation_jobs[identifier])

    def get_annotation_artifact(self, identifier):
        job = self._call(self._get_annotation, identifier)
        if job['status'] != 'completed':
            raise AppError('The annotated clip is not complete.', operation='annotation', status=409)
        path = Path(job['artifactPath'])
        if not path.is_file() or _digest(path) != job['artifactSha256']:
            raise AppError('The saved annotated clip is missing or changed.', operation='annotation', status=409)
        return path

    def _start_annotation(self, payload, folder):
        from study_analysis import _regions
        from tree_annotations import export_annotated_clip, validate_annotation_range
        manifest = self._hosted_manifest(payload.get('runId'))
        directory = self._hosted_directory(manifest['runId'])
        bundle = self._verified_hosted_bundle(directory, manifest)
        recordings = self._verified_hosted_recordings(directory, manifest)
        video = recordings.get(payload.get('recordingId'))
        if not video or video['kind'] != 'video':
            raise AppError('Select a retained camera video.', operation='annotation')
        setup = bundle['state'].get('setupSnapshot')
        if not setup or not setup.get('regions'):
            raise AppError('The retained run has no A/B/background regions.', operation='annotation')
        regions = _regions(setup, video)
        profile = self._resolve_hosted_profile(payload.get('profileId'))
        if manifest['purpose'] == 'scored' and profile['sha256'] != manifest['profileHash']:
            raise AppError('The scored annotation uses its frozen profile.', operation='annotation')
        start, duration = payload.get('startSeconds'), payload.get('durationSeconds')
        try:
            validate_annotation_range(video, start, duration)
        except ValueError as error:
            raise AppError(str(error), operation='annotation') from error
        display_magnification = payload.get('displayMagnification', 10)
        if type(display_magnification) not in (int, float) or not 0 < display_magnification <= 100:
            raise AppError('Choose a display vector magnification between zero and 100.', operation='annotation')
        identifier = _identifier()
        path = Path(folder) / f'tree-tracking-{identifier}.avi'
        job = {'jobId': identifier, 'runId': manifest['runId'], 'status': 'running', 'profileId': profile['profile']['profileId']}
        self._annotation_jobs[identifier] = job
        _write_json(self._annotation_path, self._annotation_jobs)
        self._report_progress(stage='Preparing annotated clip', jobId=identifier)
        future = self._executor.submit(export_annotated_clip, video, regions, profile['profile'], start, duration,
                                       path, self._report_progress, display_magnification)
        future.add_done_callback(lambda completed: self._commands.put((Future(), self._finish_annotation, (identifier, profile['sha256'], completed))))
        return copy.deepcopy(job)

    def _finish_annotation(self, identifier, profile_sha256, future):
        job = self._annotation_jobs[identifier]
        try:
            job.update(future.result(), profileHash=profile_sha256, artifactUrl=f'{HOSTED_API}annotations/{identifier}/clip.avi')
        except Exception as error:
            logging.warning('Tree annotation %s for run %s failed: %s; no completed artifact is advertised', identifier, job['runId'], error)
            job.update(status='failed', error=str(error))
        _write_json(self._annotation_path, self._annotation_jobs)
        self._clear_progress()

    def _accumulating_series(self, series_id=None):
        from tree_report import build_tree_report
        from study_profiles import development_profile
        from study_bundle import load_series_bundle
        if series_id is not None and not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', series_id):
            raise AppError('Choose a retained Tree series.', operation='series')
        retained = self.series_store.state['manifests'].get(series_id)
        if retained:
            path = self._hosted_root() / '_series_bundles' / series_id / (retained['sha256'] + '.json')
            try:
                if _digest(path) != retained['sha256'] or load_series_bundle(path) != retained['manifest']:
                    raise ValueError('The retained series manifest changed')
            except (ValueError, OSError) as error:
                raise AppError('The retained series bundle is missing or changed.', operation='series',
                               code='series_bundle_changed', status=409) from error
        value = self.series_store.evaluate(development_profile(), series_id=series_id)
        value['series'] = self.series_store.list_series()
        value['report'] = build_tree_report(value)
        if self.publication_jobs.is_software_test_series(series_id): value['softwareTest'] = True
        return value

    def _save_profile(self, run_id, profile):
        from study_profiles import ProfileRepository
        manifest = self._hosted_manifest(run_id)
        try:
            retained = ProfileRepository(self.directory / 'profiles').save_new(profile, purpose=manifest['purpose'])
        except (ValueError, OSError) as error:
            raise AppError(str(error), operation='save_profile') from error
        self._select_profile(run_id, retained['profile']['profileId'])
        return retained

    def _select_profile(self, run_id, profile_id):
        manifest = self._hosted_manifest(run_id)
        if manifest['purpose'] != 'preparation':
            raise AppError('The scored analysis profile is frozen.', operation='select_profile')
        self._resolve_hosted_profile(profile_id)
        manifest['selectedProfileId'] = profile_id
        _write_json(self._hosted_directory(run_id) / 'manifest.json', manifest)
        return {'runId': run_id, 'selectedProfileId': profile_id}

    def _select_revision(self, run_id, analysis_id):
        artifact = self._get_hosted_analysis(run_id, analysis_id)
        if artifact['status'] != 'completed':
            raise AppError('Select a completed retained analysis revision.', operation='select_revision')
        self.series_store.select_revision(run_id, analysis_id)
        return self._accumulating_series(self._hosted_manifest(run_id).get('seriesId'))

    def _export_report(self, folder, series_id=None):
        report = self._accumulating_series(series_id)
        identifier = _identifier()
        path = Path(folder) / f'tree-result-{identifier}.json'
        with path.open('x') as output:
            json.dump(report, output, indent=2, allow_nan=False)
        text = path.with_suffix('.txt')
        with text.open('x') as output:
            output.write(report['report']['status'] + '\n\n' + '\n\n'.join(report['report']['narrative']) + '\n\n' + report['report']['caveat'] + '\n')
        return {'status': 'completed', 'filename': path.name, 'textFilename': text.name, 'sha256': _digest(path)}

    def _hosted_request_fingerprint(self, route, payload):
        encoded = json.dumps({'route':route, 'payload':payload}, sort_keys=True, separators=(',', ':'), allow_nan=False)
        return hashlib.sha256(encoded.encode()).hexdigest()


    def _prior_hosted_request(self, route, payload):
        request_id = payload.get('requestId')
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            raise AppError('A bounded requestId is required for an analysis change.', operation='analysis')
        requests = _read_json(self._hosted_root() / 'requests.json', {})
        previous = requests.get(request_id)
        if previous:
            if previous['fingerprint'] != self._hosted_request_fingerprint(route, payload):
                raise AppError('This requestId was already used for a different analysis change.',
                    operation='analysis', status=409)
            return copy.deepcopy(previous['result'])
        return None



def _run_display_metadata(bundle):
    state = bundle.get('state', {})
    lifecycle = state.get('lifecycle')
    finished = state.get('finishedAtMs')
    if finished is None:
        terminal_kinds = {'completed': ('deadlineReached',), 'stopped': ('stop', 'stopped'),
            'failed': ('providerFailed', 'failed', 'cueFailed')}.get(lifecycle, ())
        finished = next((event['serverAtMs'] for event in reversed(bundle.get('events', []))
            if event.get('kind') in terminal_kinds and event.get('serverAtMs') is not None), None)
    return {'tag': bundle.get('tag'), 'lifecycle': lifecycle,
        'createdAtMs': state.get('createdAtMs'), 'recordingStartedAtMs': state.get('recordingStartedAtMs'),
        'finishedAtMs': finished}



def _identifier():
    return uuid.uuid4().hex



def _digest(path, progress=None, stage='Verifying original bytes'):
    with Path(path).open('rb') as source:
        if progress is None:
            return hashlib.file_digest(source, 'sha256').hexdigest()
        digest, completed, total = hashlib.sha256(), 0, Path(path).stat().st_size
        progress(stage=stage, completed=0, total=total, unit='bytes')
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            completed += len(chunk)
            progress(stage=stage, completed=completed, total=total, unit='bytes')
        return digest.hexdigest()



def _copy_original(path, destination, progress):
    completed, total = 0, path.stat().st_size
    progress(stage='Copying original', completed=0, total=total, unit='bytes')
    with path.open('rb') as original, destination.open('xb') as copied:
        while chunk := original.read(1024 * 1024):
            copied.write(chunk)
            completed += len(chunk)
            progress(stage='Copying original', completed=completed, total=total, unit='bytes')



def _write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + _identifier() + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, allow_nan=False, sort_keys=True, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)



def _read_json(path, default):
    return json.loads(Path(path).read_text()) if Path(path).exists() else copy.deepcopy(default)



def _export_frame_png(frame, source_name, destination_folder):
    import cv2
    success, encoded = cv2.imencode('.png', frame)
    if not success:
        raise AppError('The original-size setup frame could not be encoded.', operation='setup_frame')
    stem = 'tree-setup-' + Path(source_name).stem
    sequence = 1
    while True:
        destination = destination_folder / f'{stem}{"" if sequence == 1 else "-" + str(sequence)}.png'
        try:
            with destination.open('xb') as output:
                output.write(encoded.tobytes())
                output.flush()
                os.fsync(output.fileno())
            return destination
        except FileExistsError:
            sequence += 1



def _analysis_code_hashes():
    directory = Path(__file__).parent
    names = ('study_app.py', 'study_bundle.py', 'study_timing.py', 'study_video.py', 'study_tree_time.py',
             'study_profiles.py', 'study_analysis.py', 'study_missing.py', 'study_geometry.py', 'tree_calculator.py', 'tree_series.py',
             'tree_report.py', 'tree_annotations.py', 'tree_spatial.py', 'tree_comparisons.py')
    return {**{name:_digest(directory / name) for name in names},
            'validation/reference.py': _digest(directory.parent / 'validation' / 'reference.py'),
            'analysis-profile-area.json': _digest(directory.parent / 'analysis-profile-area.json')}



class NativePicker:
    """Native selections only; no unverified path-entry fallback."""
    def __init__(self, invoke=subprocess.run):
        self.invoke = invoke
        self.lock = threading.Lock()

    def choose(self, kind):
        if kind not in ('wind', 'video', 'setupImage', 'bundle', 'folder'):
            raise AppError('Choose a run bundle, original recording, setup image or a destination folder.')
        command = ('set chosen to {choose folder with prompt "Choose a local study folder"}' if kind == 'folder'
                   else 'set chosen to choose file with prompt "Choose original study recordings" with multiple selections allowed')
        script = '\n'.join([command, 'set output to ""', 'repeat with itemPath in chosen',
            'set output to output & POSIX path of itemPath & linefeed', 'end repeat', 'return output'])
        with self.lock:
            try:
                result = self.invoke(['/usr/bin/osascript', '-e', script], capture_output=True, text=True, check=False)
            except OSError as error:
                raise AppError('The native file chooser could not open.', operation='choose-files',
                    corrective_action='Restore the installed macOS chooser and retry.') from error
        if result.returncode:
            if '(-128)' in result.stderr:
                return []
            raise AppError('The native file chooser failed or lacks permission.', operation='choose-files',
                corrective_action='Allow the application to use macOS file selection, then retry.')
        return [Path(line) for line in result.stdout.splitlines() if line]



def video_preview(path):
    import cv2
    frame=read_video_frame(path,0)
    height,width=frame.shape[:2]
    scale=min(1,960/max(width,height))
    preview=cv2.resize(frame,(round(width*scale),round(height*scale))) if scale<1 else frame
    success,encoded=cv2.imencode('.png',preview)
    if not success:
        raise AppError('The camera setup preview could not be encoded.',operation='choose-files')
    return {'width':width,'height':height,'preview_image':'data:image/png;base64,'+base64.b64encode(encoded).decode()}



def read_video_frame(path, frame_index):
    import cv2
    if type(frame_index) is not int or frame_index < 0:
        raise AppError('Choose a nonnegative camera frame index.', operation='preview_frame')
    capture=cv2.VideoCapture(str(path),cv2.CAP_FFMPEG)
    try:
        if not capture.isOpened():
            raise AppError('The camera recording could not be opened.', operation='preview_frame')
        if frame_index:
            capture.set(cv2.CAP_PROP_POS_FRAMES,frame_index)
        success,frame=capture.read()
        if not success:
            raise AppError('The selected camera frame could not be decoded.', operation='preview_frame')
        return frame
    finally:
        capture.release()



def rasterize_mask(shape,region):
    """Convert validated native-pixel mask geometry to the scoring array."""
    import cv2
    import numpy as np
    from study_geometry import validate_mask
    try:
        validate_mask(region,reference_dimensions=shape)
    except ValueError as error:
        raise AppError(str(error),operation='tree_masks') from error
    if not isinstance(region,dict):
        return np.asarray(region,dtype=bool)
    raster=np.zeros(shape,dtype=np.uint8)
    if 'points' in region:
        cv2.fillPoly(raster,[np.asarray(region['points'],dtype=np.int32)],1)
    else:
        x,y,width,height=(int(region[key]) for key in ('x','y','width','height'))
        raster[y:y+height,x:x+width]=1
    return raster.astype(bool)



def _validate_runtime(installation):
    runtime,source=Path(installation.get('runtime','')),Path(installation.get('source',''))
    if not runtime.is_file() or not source.is_file():
        raise AppError('The provisioned Python runtime or application source is missing.',operation='launch',
            corrective_action='Repair the installed application paths; no packages will be downloaded.')
    result=subprocess.run([str(runtime),'-c','import sys,numpy,cv2,scipy; assert sys.version_info[:2] == (3,13); assert hasattr(cv2,"CAP_PROP_PTS")'],
                          capture_output=True,check=False)
    if result.returncode:
        raise AppError('The provisioned runtime is incompatible or a required installed dependency is missing.',operation='launch')



def _probe(identity):
    try:
        address=urlsplit(identity['url'])
        if address.scheme!='http' or address.hostname!='127.0.0.1' or not address.port or address.path:
            return False
        connection=http.client.HTTPConnection(address.hostname,address.port,timeout=1)
        try:
            connection.request('GET','/api/state')
            response=connection.getresponse()
            state=json.loads(response.read(1024*1024))
            if not isinstance(state,dict):
                logging.warning('Saved local service returned non-object JSON; treating it as unrelated and starting a fresh service')
                return False
            return response.status==200 and state['service']=={'instance_id':identity['instance_id'],'version':2}
        finally:
            connection.close()
    except (KeyError,ValueError,OSError,http.client.HTTPException):
        logging.warning('Saved local service identity could not be verified; a fresh service is required')
        return False



def _start_service(installation,directory):
    log=(directory/'service.log').open('ab')
    try:
        process=subprocess.Popen([installation['runtime'],installation['source'],'--serve','--data-dir',str(directory)],
                                 stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    finally:
        log.close()
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        if process.poll() is not None:
            raise AppError('The local study service could not start.',operation='launch')
        identity=_read_json(directory/'service.json',{})
        if identity.get('process_id')==process.pid and _probe(identity):
            return identity
        time.sleep(0.1)
    raise AppError('The local study service did not become available.',operation='launch')



class NativeChromeWindowAccess:
    """Address the operator-bound existing window without launching a browser."""
    def _run(self,body,*arguments):
        script='''on run arguments
if application "Google Chrome" is not running then error "Chrome must already be running."
tell application "Google Chrome"
'''+body+'''
end tell
end run'''
        try:
            result=subprocess.run(['/usr/bin/osascript','-e',script,*arguments],capture_output=True,text=True,check=False)
        except OSError as error:
            raise AppError(f'The existing private Chrome window could not be accessed: {error}',operation='launch',
                corrective_action='Review the operating system error and retry the installed launcher.') from error
        if result.returncode:
            diagnostic=result.stderr.strip() or f'osascript exited with status {result.returncode}.'
            raise AppError(f'The existing private Chrome window could not be accessed: {diagnostic}',operation='launch',
                corrective_action='Review the native error and the configured existing private-profile Chrome window.')
        return result.stdout

    def named_windows(self,name):
        output=self._run('''set output to ""
repeat with chromeWindow in windows
if given name of chromeWindow is item 1 of arguments then
set output to output & (id of chromeWindow as text) & (character id 9) & (mode of chromeWindow as text) & linefeed
end if
end repeat
return output''',name)
        result=[]
        for line in output.splitlines():
            if line:
                fields=line.split('\t')
                if len(fields)!=2:
                    raise AppError('The existing private Chrome window identity could not be verified.',operation='launch')
                result.append({'id':fields[0],'mode':fields[1]})
        return result

    def open_tab(self,identifier,url,name):
        self._run('''set matchingWindows to {}
repeat with chromeWindow in windows
if given name of chromeWindow is item 3 of arguments then set end of matchingWindows to chromeWindow
end repeat
if count of matchingWindows is not 1 then error "The bound window is missing or ambiguous."
set targetWindow to item 1 of matchingWindows
if mode of targetWindow is not "normal" then error "The bound window must use the existing private profile."
if (id of targetWindow as text) is not item 1 of arguments then error "The bound window changed."
make new tab at end of tabs of targetWindow with properties {URL:item 2 of arguments}
set active tab index of targetWindow to count of tabs of targetWindow
set index of targetWindow to 1
activate''',identifier,url,name)



def _open_existing_chrome(url,*,chrome=None,window_name=None):
    access=chrome or NativeChromeWindowAccess()
    name=window_name
    if not isinstance(name,str) or not name.strip():
        raise AppError('The installation needs its verified private Chrome window name.',operation='launch')
    windows=access.named_windows(name)
    if len(windows)!=1 or windows[0]['mode']!='normal':
        raise AppError('The uniquely named existing private Chrome window is unavailable.',operation='launch',
            corrective_action='Keep the explicitly configured private-profile window open without changing its name.')
    access.open_tab(windows[0]['id'],url,name)



def launch_service(installation,data_directory=None,*,probe=None,starter=None,browser_open=None,runtime_check=None):
    """Validate installation, attach once to the correct service, and reopen its UI."""
    directory=Path(data_directory or installation.get('data_directory') or DEFAULT_DATA_DIRECTORY).expanduser().resolve()
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    (runtime_check or _validate_runtime)(installation)
    with (directory/'launcher.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        identity=_read_json(directory/'service.json',{})
        if not identity or not (probe or _probe)(identity):
            identity=(starter or _start_service)(installation,directory)
            _write_json(directory/'service.json',identity)
        url=identity['url'] + '/tree-targeting/analysis/'
        try:
            if browser_open:
                browser_open(url)
            else:
                _open_existing_chrome(url,window_name=installation.get('chrome_window_name'))
        except AppError as error:
            log_path=directory/'service.log'
            try:
                with log_path.open('a',encoding='utf-8') as log:
                    log.write(f'Tree launcher could not open Chrome window {installation.get("chrome_window_name")!r}: '
                              f'{error.message} {error.corrective_action}\n')
            except OSError as log_error:
                logging.warning('Tree launch failure could not be saved to %s: %s; original launch error remains visible: %s',
                                log_path,log_error,error.message)
            raise
        return identity



def main(arguments=None):
    parser=argparse.ArgumentParser(description='Local Tree study application')
    parser.add_argument('--launch',action='store_true')
    parser.add_argument('--installation',type=Path)
    parser.add_argument('--serve',action='store_true')
    parser.add_argument('--data-dir',type=Path,default=DEFAULT_DATA_DIRECTORY)
    options=parser.parse_args(arguments)
    if options.launch:
        if options.installation is None:
            parser.error('--launch requires --installation')
        launch_service(_read_json(options.installation,{}))
        return
    if not options.serve:
        parser.error('Choose --launch or --serve')
    from study_http import start_http
    options.data_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (options.data_dir/'service.lock').open('a') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise AppError('A study service already owns this data directory.',operation='launch') from error
        application=StudyApplication(options.data_dir)
        server=start_http(application)
        identity={'process_id':os.getpid(),'instance_id':application.instance_id,'version':2,
                  'url':f'http://127.0.0.1:{server.server_port}'}
        _write_json(options.data_dir/'service.json',identity)
        try:
            while not application.quit_requested:
                time.sleep(0.1)
        finally:
            server.shutdown()
            server.server_close()
            application.close()
            if _read_json(options.data_dir/'service.json',{}).get('instance_id')==application.instance_id:
                (options.data_dir/'service.json').unlink()



if __name__ == '__main__':
    try:
        main()
    except AppError as error:
        print(f'{error.message} {error.corrective_action}', file=sys.stderr)
        raise SystemExit(1)
