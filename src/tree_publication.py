"""Retain publication bytes around the existing local calculation and reports."""
import copy
import hashlib
import json
import logging
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
import mimetypes
from pathlib import Path
import re
import subprocess
import time
import uuid
import zipfile

from study_http import AppError

PACKAGE = Path(__file__).resolve().parents[1]
ENVIRONMENT_ORIGINS = {'test': 'https://test.lab.sourceof.love', 'production': 'https://lab.sourceof.love'}
HASH = re.compile(r'[a-f0-9]{64}\Z')
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,80}\Z')


def digest_file(path, progress=None):
    with Path(path).open('rb') as source:
        if progress is None: return hashlib.file_digest(source, 'sha256').hexdigest()
        digest, completed, total = hashlib.sha256(), 0, Path(path).stat().st_size
        progress(stage='Verifying publication files', completed=0, total=total, unit='bytes')
        while part := source.read(8 * 1024 * 1024):
            digest.update(part); completed += len(part)
            progress(stage='Verifying publication files', completed=completed, total=total, unit='bytes')
        return digest.hexdigest()


def _json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def _error(message):
    return AppError(message, operation='publication', status=409)


def _contained(directory, relative):
    candidate = (directory / relative).resolve()
    if not candidate.is_relative_to(directory.resolve()):
        raise _error('A retained publication input escapes its study directory.')
    return candidate


def _source_bytes(name, expected):
    relative = name if '/' in name or name.endswith('.json') else 'src/' + name
    if not re.fullmatch(r'(?:src/[a-z_]+\.py|validation/reference\.py|analysis-profile(?:-area)?\.json)', relative):
        raise _error('An analysis source reference is outside the standalone package.')
    current = _contained(PACKAGE, relative)
    if current.is_file() and digest_file(current) == expected:
        return current.read_bytes(), relative
    # Historical bytes must match the retained identity, never today's source.
    result = subprocess.run(['git', 'log', '--all', '--format=%H', '--', str(current)],
                            cwd=PACKAGE, capture_output=True, text=True)
    if result.returncode == 0:
        root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=PACKAGE, capture_output=True, text=True)
        tracked_package = PACKAGE.relative_to(Path(root.stdout.strip())).as_posix() if root.returncode == 0 else None
        if tracked_package == '.': tracked_package = ''
        for checkpoint in result.stdout.splitlines():
            historical = subprocess.run(['git', 'show', f'{checkpoint}:{(tracked_package + '/') if tracked_package else ''}{relative}'],
                                        cwd=PACKAGE, capture_output=True)
            if historical.returncode == 0 and hashlib.sha256(historical.stdout).hexdigest() == expected:
                return historical.stdout, relative
    raise _error(f'Historical analysis source is unavailable for {name} ({expected}).')


def prepare_publication(application, series_id, environment, *, inventory, job_id=None,
                        correction_reason=None, software_test=False):
    """Snapshot on the application's serialized owner; inventory is publication-only."""
    return application._call(_prepare, application, series_id, environment, inventory, job_id,
                             correction_reason, software_test)


def _prepare(application, series_id, environment, inventory, job_id, correction_reason, software_test):
    if environment not in ENVIRONMENT_ORIGINS:
        raise AppError('Choose the Test or Production publication environment.', operation='publication')
    if software_test and environment != 'test':
        raise _error('Software test data can be published only on protected Test.')
    if not isinstance(series_id, str) or not IDENTIFIER.fullmatch(series_id):
        raise _error('Choose a retained named scored series for publication.')
    application._require_idle(publication_job_id=job_id)
    retained = application.series_store.state['manifests'].get(series_id)
    if not retained or retained['manifest']['config']['purpose'] != 'scored':
        raise _error('Only a retained scored series is eligible for publication.')
    accumulated = application._accumulating_series(series_id)
    accumulated = {key: value for key, value in accumulated.items() if key not in ('series', 'softwareTest')}
    cloud = inventory.get('inventory') if isinstance(inventory, dict) else inventory
    if not isinstance(cloud, list) or not cloud:
        raise _error('Publication requires the destination scored-series inventory.')
    member_by_id = {member['runId']: member for member in retained['manifest']['members']}
    if [item['runId'] for item in cloud] != retained['manifest']['collectionRunIds']:
        raise _error('The collected inventory differs from the retained series bundle; import the latest bundle.')
    for member in cloud:
        local = member_by_id.get(member['runId'])
        if not local or any(member.get(key) != local.get(key) for key in
                            ('createdAtMs', 'collectionStartedAtMs', 'configHash', 'profileHash', 'codeCheckpoint')):
            raise _error('A collected recording differs from its retained series identity.')
    identifier = job_id or str(uuid.uuid4())
    try: uuid.UUID(identifier)
    except (ValueError, TypeError): raise _error('A publication job needs a UUID identity.')
    progress = (lambda **value: application.publication_jobs._progress(identifier, **value)) if application.publication_jobs.active_id == identifier else application._report_progress
    directory = application._hosted_root() / '_publications' / identifier
    if (directory / 'job.json').is_file():
        saved = json.loads((directory / 'job.json').read_text())
        if saved['manifest']['seriesId'] != series_id or saved['manifest']['environment'] != environment:
            raise _error('This publication identity already belongs to another snapshot.')
        verify_publication_files(saved)
        return saved
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    files, local_files, viewing_metadata = {}, {}, {}

    def add(path, role, *, expected=None, run_id=None, content_type=None, derived_from=None):
        path = Path(path)
        if not path.is_file(): raise _error(f'A retained {role} file is missing.')
        digest = digest_file(path, progress)
        if expected is not None and digest != expected: raise _error(f'A retained {role} file changed.')
        metadata = {'sha256': digest, 'size': path.stat().st_size, 'filename': path.name,
                    'contentType': content_type or mimetypes.guess_type(path.name)[0] or 'application/octet-stream', 'role': role}
        if run_id: metadata['runId'] = run_id
        if derived_from: metadata['derivedFrom'] = derived_from
        files.setdefault(digest, metadata)
        local_files[digest] = str(path.resolve())
        return digest

    def save(name, value, role, *, run_id=None):
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_json_bytes(value))
        return add(path, role, run_id=run_id, content_type='application/json')

    def sources(hashes):
        mapping = {}
        for name, expected in hashes.items():
            raw, relative = _source_bytes(name, expected)
            path = directory / 'source' / expected / Path(relative).name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            mapping[relative] = add(path, 'source', expected=expected)
        return mapping

    series_path = application._hosted_root() / '_series_bundles' / series_id / (retained['sha256'] + '.json')
    series_hash = add(series_path, 'series-bundle', expected=retained['sha256'])
    included, cloud_snapshot, analysis_sources, source_packages, package_cache, event_sources = [], [], {}, {}, {}, {}
    from tree_source_release import archive_source_release, analysis_source_checkpoint, runtime_identity

    def source_package(checkpoint=None):
        cache_key = checkpoint or 'working-source'
        if cache_key not in package_cache:
            path = directory / 'source' / (cache_key + '-tree-source.zip')
            try: source_inventory = archive_source_release(path, checkpoint=checkpoint)
            except ValueError as error: raise _error(str(error)) from error
            digest = add(path, 'source', content_type='application/zip')
            identity = checkpoint or source_inventory['contentSha256']
            source_packages[identity] = {'sha256': digest, 'contentSha256': source_inventory['contentSha256'],
                                         'origin': source_inventory['origin']}
            package_cache[cache_key] = digest
        return package_cache[cache_key]

    series_source_checkpoint = retained['manifest']['codeCheckpoint']
    series_source_hash = source_package(series_source_checkpoint)
    for checkpoint in sorted({item['codeCheckpoint'] for item in cloud}): source_package(checkpoint)
    contribution_ids = dict(zip(accumulated['runIds'], accumulated['selectedRevisions']))
    for member in cloud:
        run_id = member['runId']
        selected = application.series_store.state['runs'][run_id]['selectedRevision']
        state = {**copy.deepcopy(member), 'analysisState': 'pending', 'analysisReason': 'Analysis has not completed.',
                 'contributes': run_id in contribution_ids}
        try: run_manifest = application._hosted_manifest(run_id)
        except AppError as error:
            if error.status != 404: raise
            state['analysisReason'] = 'Recording bundle has not been imported locally.'
            cloud_snapshot.append(state)
            continue
        if selected is None:
            analyses = list(run_manifest['analyses'].values())
            if analyses:
                latest = analyses[-1]
                state.update(analysisState=latest['status'], analysisReason=latest.get('qualityReasons') or latest.get('error'))
            cloud_snapshot.append(state)
            continue
        artifact = application._get_hosted_analysis(run_id, selected)
        if artifact['status'] != 'completed':
            state.update(analysisState=artifact['status'], analysisReason=artifact.get('qualityReasons') or artifact.get('error'))
            cloud_snapshot.append(state)
            continue
        associations = artifact.get('inputRecordings')
        if not isinstance(associations, dict) or set(associations) != set(artifact['inputHashes']):
            raise AppError('The selected analysis input associations were not retained.', operation='publication',
                code='analysis_inputs_unavailable', status=409, requiresNewSnapshot=True,
                corrective_action='Run and select a new analysis revision, then prepare a new publication. The existing analysis remains readable.')
        run_directory = application._hosted_directory(run_id)
        selected_metadata = run_manifest['analyses'][selected]
        result = artifact['result']
        analysis_hash = add(_contained(run_directory, selected_metadata['outputPath']), 'analysis',
                            expected=selected_metadata['outputSha256'], run_id=run_id)
        bundle_path = run_directory / 'bundles' / (artifact['bundleSha256'] + '.json')
        bundle_hash = add(bundle_path, 'run-bundle', expected=artifact['bundleSha256'], run_id=run_id)
        original_bundle = json.loads(bundle_path.read_bytes())
        event_sources[run_id] = sorted({event['sourceCheckpoint'] for event in original_bundle['events'] if event.get('sourceCheckpoint')})
        for checkpoint in event_sources[run_id]: source_package(checkpoint)
        report_hash = save(f'{run_id}/{selected}-report.json', artifact['displayReport'], 'report', run_id=run_id)
        profile_path = directory / run_id / (selected + '-profile.json')
        profile_path.write_text(artifact['sealedProfileJson'], encoding='utf-8')
        profile_hash = add(profile_path, 'profile', expected=artifact['profileSha256'], run_id=run_id)
        input_hashes, records, videos = [], {}, []
        for recording_id, expected in artifact['inputHashes'].items():
            record = copy.deepcopy(associations[recording_id])
            retained_record = run_manifest['recordings'].get(recording_id)
            if not isinstance(record, dict) or record.get('sha256') != expected or not retained_record or retained_record['sha256'] != expected:
                raise _error('A selected analysis original is missing or changed.')
            role = 'camera-original' if record['kind'] == 'video' else 'setup-image' if record['kind'] == 'setupImage' else 'measurement'
            original = _contained(run_directory, retained_record['relativePath'])
            input_hashes.append(add(original, role, expected=expected, run_id=run_id))
            if role == 'camera-original':
                from tree_publication_media import prepare_viewing_video
                viewing = prepare_viewing_video(original, directory / 'viewing' / (expected + '.mp4'), progress=progress)
                viewing_hash = add(viewing['path'], 'viewing-video', derived_from=expected, run_id=run_id, content_type='video/mp4') if viewing['derivedFrom'] else expected
                viewing_metadata[viewing_hash] = viewing
                videos.append({'recordingId': recording_id, 'originalSha256': expected, 'viewingSha256': viewing_hash})
            records[recording_id] = record
            if record.get('timelineSha256'):
                timeline_hash = artifact['derivedInputHashes'].get(recording_id + ':timeline')
                if timeline_hash != record['timelineSha256'] or retained_record.get('timelineSha256') != timeline_hash:
                    raise _error('A selected analysis timeline changed.')
                input_hashes.append(add(_contained(run_directory, retained_record['timelinePath']), 'measurement', expected=timeline_hash, run_id=run_id))
                records[recording_id]['frameTimelineSha256'] = timeline_hash
        derived = artifact.get('derivedInputHashes', {})
        for role, collection, identity_key in [('clock-map', 'timeMaps', 'timeMapId'), ('footage-review', 'obstructionReviews', 'reviewId')]:
            for entry in run_manifest.get(collection, []):
                if entry[identity_key] in derived:
                    expected = derived[entry[identity_key]]
                    input_hashes.append(add(_contained(run_directory, entry['relativePath']), role, expected=expected, run_id=run_id))
                    for record in records.values():
                        if record.get(identity_key if identity_key == 'timeMapId' else 'obstructionReviewId') == entry[identity_key]:
                            record['clockMapSha256' if role == 'clock-map' else 'obstructionReviewSha256'] = expected
        for record in records.values():
            if record.get('timeMapId') and not record.get('clockMapSha256') or record.get('obstructionReviewId') and not record.get('obstructionReviewSha256'):
                raise _error('A selected analysis clock map or footage review is missing or changed.')
        missing_inputs = {}
        if result.get('measurementDisposition') is not None:
            disposition, _ = application._verified_missing_measurement_inputs(run_directory, run_manifest, selected_metadata)
            if disposition != result['measurementDisposition']:
                raise _error('The selected missing-measurement disposition changed.')
            disposition_hash = add(_contained(run_directory, selected_metadata['measurementDispositionPath']),
                'measurement', expected=derived['measurementDisposition'], run_id=run_id)
            missing_inputs['measurementDispositionSha256'] = disposition_hash
            input_hashes.append(disposition_hash)
            if disposition['retainedAnalysis']:
                prior = run_manifest['analyses'][disposition['retainedAnalysis']['analysisId']]
                retained_hash = add(_contained(run_directory, prior['outputPath']), 'measurement',
                    expected=derived['retainedAnalysis'], run_id=run_id)
                missing_inputs['retainedAnalysisSha256'] = retained_hash
                input_hashes.append(retained_hash)
        source_files = sources(artifact['codeHashes'])
        try: analysis_checkpoint = analysis_source_checkpoint(artifact['codeHashes'])
        except ValueError as error: raise _error(str(error)) from error
        analysis_sources[selected] = {'codeSha256': artifact['codeSha256'], 'files': source_files,
                                      'packageSha256': source_package(analysis_checkpoint), 'runtime': artifact.get('runtime')}
        reproduction_hash = save(f'{run_id}/{selected}-inputs.json', {'recordings': records, 'sourceFiles': source_files,
                                   'runBundleSha256': bundle_hash, 'profileSha256': profile_hash,
                                   **missing_inputs}, 'reproduction-inputs', run_id=run_id)
        entry = {'runId': run_id, 'analysisId': selected, 'analysisSha256': analysis_hash,
                 'reportSha256': report_hash, 'runBundleSha256': bundle_hash, 'profileSha256': profile_hash,
                 'inputSha256s': sorted(set(input_hashes)), 'reproductionInputsSha256': reproduction_hash,
                 'videos': videos, **missing_inputs, 'status': result['status'], 'qualificationReasons': result.get('qualityReasons', []),
                 'missingReasons': result.get('missingReasons') or sorted({reason for target in result.get('targets', []) for item in target['bins'] for reason in item['reasons']})}
        state.update(analysisState='completed', analysisReason=None, analysis=entry)
        if run_id in contribution_ids:
            if contribution_ids[run_id] != selected: raise _error('The selected analysis revision changed during publication.')
            included.append(entry)
        cloud_snapshot.append(state)
    accumulated_hash = save('accumulated-result.json', accumulated, 'analysis')
    accumulated_report_hash = save('accumulated-report.json', accumulated['report'], 'report')
    from study_app import _analysis_code_hashes
    presentation_sources = sources(_analysis_code_hashes())
    presentation_package = source_package()
    renderer_path = directory / 'source' / 'tree-results.mjs'
    renderer_path.write_bytes((PACKAGE / 'web/tree-results.mjs').read_bytes())
    renderer_hash = add(renderer_path, 'source')
    def document(name):
        path = directory / 'documents' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(local_files[series_source_hash]) as archive:
            try: raw = archive.read(name)
            except KeyError as error: raise _error(f'The frozen {name} document is unavailable for study source {series_source_checkpoint}.') from error
        path.write_bytes(raw)
        return add(path, 'protocol', content_type='text/markdown; charset=utf-8')
    protocol_hash, methods_hash = document('protocol.md'), document('analysis-methods.md')
    manifest = {'schemaVersion': 1, 'experimentSlug': 'tree-targeting', 'purpose': 'scored',
                'environment': environment, 'seriesId': series_id, 'publicationId': identifier,
                'createdAtMs': int(time.time() * 1000),
                'previousPublicationId': inventory.get('previousPublicationId') if isinstance(inventory, dict) else None,
                'correctionReason': correction_reason, 'softwareTest': bool(software_test),
                'seriesBundle': {'sha256': series_hash, 'label': retained['manifest']['label'], 'status': retained['manifest']['status'],
                                 'codeCheckpoint': series_source_checkpoint},
                'sourceReleases': {'collection': sorted({item['codeCheckpoint'] for item in cloud}), 'events': event_sources,
                                   'packages': source_packages, 'analyses': analysis_sources,
                                   'accumulation': {'files': presentation_sources, 'packageSha256': presentation_package,
                                                    'runtime': runtime_identity()}},
                'inventory': cloud_snapshot, 'includedAnalyses': included,
                'accumulated': {'resultSha256': accumulated_hash, 'reportSha256': accumulated_report_hash,
                                'included': [{'runId': run_id, 'analysisId': analysis_id} for run_id, analysis_id in contribution_ids.items()],
                                'seriesBundleSha256': series_hash, 'status': accumulated['status']},
                'files': files, 'reportPresentation': {'generatorSha256': presentation_sources['src/tree_report.py'],
                                                     'rendererSha256': renderer_hash, 'protocolSha256': protocol_hash,
                                                     'methodsSha256': methods_hash}}
    manifest_path = directory / 'manifest.json'
    manifest_path.write_bytes(_json_bytes(manifest))
    job = {'jobId': identifier, 'manifest': manifest, 'manifestPath': str(manifest_path),
           'manifestSha256': digest_file(manifest_path), 'localFiles': local_files, 'viewingMetadata': viewing_metadata, 'status': 'prepared'}
    (directory / 'job.json').write_bytes(_json_bytes(job))
    verify_publication_files(job)
    return job


def verify_publication_files(job):
    manifest_path = Path(job['manifestPath'])
    if not manifest_path.is_file() or digest_file(manifest_path) != job['manifestSha256']:
        raise _error('The retained publication manifest is missing or changed.')
    for digest, metadata in job['manifest']['files'].items():
        path = Path(job['localFiles'][digest])
        if not path.is_file() or path.stat().st_size != metadata['size'] or digest_file(path) != digest:
            raise _error(f'A retained publication file is missing or changed ({metadata["filename"]}).')


def _transport_command(arguments, progress=None):
    node = shutil.which('node')
    if not node: raise _error('The installed Node runtime is required for publication transport.')
    command = [node, str(PACKAGE / 'scripts/publication-upload.mjs'), *arguments, '--credential-source', 'keychain']
    result, failure = None, None
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as process:
        for line in process.stdout:
            try: event = json.loads(line)
            except ValueError: raise _error('Publication transport returned an invalid progress event.')
            if event.get('type') == 'progress' and progress: progress(**event['value'])
            elif event.get('type') == 'result': result = event['value']
            elif event.get('type') == 'error': failure = event
        if process.wait() or result is None:
            raise AppError((failure or {}).get('message') or 'Publication transport did not complete. Resume the same job after resolving the failure.',
                           operation='publication', status=409, code=(failure or {}).get('code', 'publication_failed'),
                           requiresNewSnapshot=(failure or {}).get('requiresNewSnapshot', False))
    return result


def read_destination_inventory(series_id, environment, software_test):
    return _transport_command(['--series', series_id, '--environment', environment, '--software-test', str(software_test).lower()])


def upload_retained_publication(job, progress):
    return _transport_command(['--job', str(Path(job['manifestPath']).parent / 'job.json'),
                               '--environment', job['manifest']['environment']], progress)


class PublicationJobs:
    """One explicit publisher with safe, retained status readable during snapshot hashing."""
    def __init__(self, application):
        self.application, self.lock, self.active_id = application, threading.Lock(), None
        self.path = application._hosted_root() / '_publications' / 'jobs.json'
        self.jobs = json.loads(self.path.read_text()) if self.path.is_file() else {}
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='tree-publication')
        for job in self.jobs.values():
            if job['status'] in ('preparing', 'uploading'):
                logging.warning('Tree publication %s was interrupted; retaining snapshot for explicit resume', job['jobId'])
                job.update(status='failed', error=AppError('Publication was interrupted. Resume this retained job.', operation='publication').public())
        if self.jobs: self._persist()

    def _persist(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        from study_app import _write_json
        _write_json(self.path, self.jobs)

    def require_available(self, job_id=None):
        with self.lock:
            if self.active_id is not None and self.active_id != job_id:
                raise AppError('Wait for the current publication before changing recordings or settings.', operation='publication', status=409)

    def summaries(self, job_id=None):
        with self.lock:
            if job_id is not None:
                if job_id not in self.jobs: raise AppError('Publication job was not found.', operation='publication', status=404)
                return copy.deepcopy(self.jobs[job_id])
            return {'jobs': copy.deepcopy(list(self.jobs.values()))}

    def is_software_test_series(self, series_id):
        with self.lock:
            return any(job['seriesId'] == series_id and job['environment'] == 'test' and job.get('softwareTest') is True
                       for job in self.jobs.values())

    def create(self, payload):
        environment, series_id = payload.get('environment'), payload.get('seriesId')
        fixture = self.is_software_test_series(series_id)
        software_test = payload.get('softwareTest', fixture)
        if fixture and not software_test: raise _error('A retained software-test series must keep its explicit Test marker.')
        if environment not in ENVIRONMENT_ORIGINS or type(software_test) is not bool or software_test and environment != 'test':
            raise _error('Choose the Test or Production publication environment; software tests require Test.')
        retained = self.application.series_store.state['manifests'].get(series_id)
        if not retained or retained['manifest']['config']['purpose'] != 'scored': raise _error('Choose a retained named scored series for publication.')
        reason = payload.get('correctionReason') or None
        if reason is not None and (not isinstance(reason, str) or len(reason) > 2000): raise _error('A correction reason must be bounded text.')
        identifier = str(uuid.uuid4())
        with self.lock:
            if self.active_id is not None: raise _error('Wait for the current publication.')
            self.active_id = identifier
            self.jobs[identifier] = {'jobId': identifier, 'seriesId': series_id, 'environment': environment, 'softwareTest': software_test,
                                     'correctionReason': reason, 'status': 'preparing', 'fileCount': None, 'uploadBytes': None, 'inventory': None,
                                     'progress': {'stage': 'Preparing publication'}, 'error': None}
            self._persist()
        self.application._report_progress(stage='Preparing publication', jobId=identifier)
        return self.summaries(identifier)

    def reserve_start(self, identifier):
        with self.lock:
            if identifier not in self.jobs: raise AppError('Publication job was not found.', operation='publication', status=404)
            job = self.jobs[identifier]
            if job['status'] == 'completed': return copy.deepcopy(job)
            if self.active_id is not None: raise _error('Wait for the current publication.')
            self.active_id = identifier
            job.update(status='uploading' if self._snapshot_path(identifier).is_file() else 'preparing', error=None)
            self._persist()
        self.application._report_progress(stage='Resuming publication', jobId=identifier)
        return self.summaries(identifier)

    def _snapshot_path(self, identifier):
        return self.path.parent / identifier / 'job.json'

    def launch(self, identifier, *, upload):
        self.executor.submit(self._execute, identifier, upload)

    def _progress(self, identifier, **value):
        safe = {key: value[key] for key in ('stage', 'completed', 'total', 'unit', 'attempt', 'operation', 'reason') if key in value}
        self.application._report_progress(**safe, jobId=identifier)
        if 'attempt' in safe:
            logging.warning('Tree publication %s retrying %s after %s (attempt %s)', identifier, safe.get('operation', 'request'), safe.get('reason', 'unavailable service'), safe['attempt'])
        with self.lock:
            self.jobs[identifier]['progress'] = safe

    def _execute(self, identifier, upload):
        job = self.summaries(identifier)
        try:
            snapshot_path = self._snapshot_path(identifier)
            if snapshot_path.is_file():
                snapshot = json.loads(snapshot_path.read_text())
                verify_publication_files(snapshot)
            else:
                inventory = self.application.publication_inventory_reader(job['seriesId'], job['environment'], job['softwareTest'])
                snapshot = prepare_publication(self.application, job['seriesId'], job['environment'], inventory=inventory,
                                               job_id=identifier, correction_reason=job['correctionReason'], software_test=job['softwareTest'])
            with self.lock:
                summary = self.jobs[identifier]
                summary.update(status='uploading' if upload else 'preparing', fileCount=len(snapshot['manifest']['files']),
                               uploadBytes=sum(file['size'] for file in snapshot['manifest']['files'].values()), inventory=snapshot['manifest']['inventory'])
                self._persist()
            if upload:
                receipt = self.application.publication_uploader(snapshot, lambda **value: self._progress(identifier, **value))
                with self.lock:
                    self.jobs[identifier].update({key: receipt[key] for key in ('publicationId', 'status', 'resultsUrl', 'recordingsUrl', 'completedAtMs') if key in receipt})
                    self._persist()
        except Exception as error:
            safe = error.public() if isinstance(error, AppError) else AppError('Publication failed. Resolve the failure and resume this same job.', operation='publication').public()
            logging.warning('Tree publication %s failed (%s); prior publication and retained originals remain available', identifier, type(error).__name__)
            with self.lock:
                self.jobs[identifier].update(status='failed', error=safe); self._persist()
        finally:
            self.application._clear_progress()
            with self.lock:
                if self.jobs[identifier]['status'] == 'preparing': self.jobs[identifier]['status'] = 'prepared'
                self.active_id = None
                self._persist()

    def close(self):
        self.executor.shutdown(wait=True)
