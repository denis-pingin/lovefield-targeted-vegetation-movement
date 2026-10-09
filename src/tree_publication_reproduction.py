"""Verify downloaded publication bytes and invoke the retained scientific engine."""
import copy
import hashlib
import json
import logging
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qs, quote, urlsplit, urlunsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request
from urllib.error import HTTPError, URLError
import zipfile

from tree_source_release import allowed_source_path, runtime_identity

PACKAGE = Path(__file__).resolve().parents[1]
HASH = re.compile(r'[a-f0-9]{64}\Z')
IDENTITY = re.compile(r'[A-Za-z0-9_-]{1,80}\Z')
PUBLIC = '/studies/targeted-vegetation-movement/public/'
LEGACY_PUBLIC = '/studies/tree-targeting/public/'


def _json(path):
    return json.loads(Path(path).read_bytes())


def _write(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False), encoding='utf-8')


def _digest(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def _manifest(path):
    value = _json(path)
    if value.get('schemaVersion') != 1 or value.get('experimentSlug') != 'tree-targeting' or value.get('purpose') != 'scored':
        raise ValueError('Select a scored Tree publication manifest with schema version one.')
    for identity, metadata in value.get('files', {}).items():
        name = metadata.get('filename')
        if not HASH.fullmatch(identity) or metadata.get('sha256') != identity:
            raise ValueError('A publication file identity is invalid.')
        if not isinstance(name, str) or not name or name in ('.', '..') or re.search(r'[/\\\x00-\x1f\x7f]', name):
            raise ValueError('A publication filename escapes its download directory.')
        if type(metadata.get('size')) is not int or metadata['size'] < 0: raise ValueError('A publication file size is invalid.')
    if not value.get('files'): raise ValueError('The publication has no retained file inventory.')
    return value


def verify_downloaded_files(manifest, directory):
    directory = Path(directory).resolve()
    names = [file['filename'] for file in manifest['files'].values()]
    verified = {}
    for identity, metadata in manifest['files'].items():
        candidates = [directory / identity, directory / identity / metadata['filename']]
        if names.count(metadata['filename']) == 1: candidates.append(directory / metadata['filename'])
        original = next((path for path in candidates if path.is_file()), None)
        if original is None: raise ValueError(f'A downloaded input is missing: {metadata["filename"]} ({identity}).')
        if original.is_symlink() or not original.resolve().is_relative_to(directory):
            raise ValueError('A downloaded file escapes its input directory.')
        if original.stat().st_size != metadata['size'] or _digest(original) != identity:
            raise ValueError(f'A downloaded input changed: {metadata["filename"]} ({identity}).')
        verified[identity] = original.resolve()
    return verified


def extract_source_package(archive_path, destination):
    destination = Path(destination).resolve()
    if destination.exists() and any(destination.iterdir()): raise ValueError('Source extraction requires an empty destination.')
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or 'source-inventory.json' not in names: raise ValueError('The source package inventory is unavailable or duplicated.')
        inventory = json.loads(archive.read('source-inventory.json'))
        hashes = inventory.get('files', {})
        if set(names) != {*hashes, 'source-inventory.json'}: raise ValueError('Source package files differ from their inventory.')
        encoded = json.dumps(hashes, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
        if hashlib.sha256(encoded).hexdigest() != inventory.get('contentSha256'): raise ValueError('The source package content identity changed.')
        for name, digest in hashes.items():
            information = archive.getinfo(name)
            if not allowed_source_path(name) or (information.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('A source package path or symlink escapes the standalone package.')
            raw = archive.read(name)
            if hashlib.sha256(raw).hexdigest() != digest: raise ValueError(f'Retained source changed: {name}.')
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        (destination / 'source-inventory.json').write_bytes(archive.read('source-inventory.json'))
    return inventory


def _source(release, files, destination):
    digest = release.get('packageSha256')
    if digest not in files: raise ValueError('Historical analysis source package is unavailable in the downloaded publication.')
    extract_source_package(files[digest], destination)
    for name, identity in release.get('files', {}).items():
        if not allowed_source_path(name) or identity not in files:
            raise ValueError('Historical source reference escapes or is unavailable in this publication.')
        target = destination / name
        if not target.is_file() or _digest(target) != identity: raise ValueError(f'The source package differs from the exact analysis source: {name}.')
    return destination


def _worker(kind, configuration, output):
    configuration_path = output.with_suffix('.inputs.json')
    _write(configuration_path, configuration)
    result = subprocess.run([sys.executable, '-I', str(PACKAGE / 'scripts/reproduce-publication.py'),
                             '--worker', kind, '--worker-input', str(configuration_path), '--output', str(output)],
                            cwd=Path(configuration['source']), capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f'Retained {kind} engine failed. Check the downloaded source and recorded runtime dependencies. {result.stderr.strip()[-2000:]}')
    return _json(output)


def run_worker(kind, configuration, output):
    """Internal isolated process: import only this publication's retained engine."""
    source = Path(configuration['source']).resolve()
    sys.path.insert(0, str(source / 'src'))
    if kind == 'analysis':
        from study_analysis import analyze_tree_run
        from tree_report import build_tree_report
        bundle, profile = _json(configuration['bundle']), _json(configuration['profile'])
        if configuration.get('measurementDisposition'):
            from study_missing import analyze_missing_measurements
            disposition = _json(configuration['measurementDisposition'])
            retained = _json(configuration['retainedAnalysis']) if configuration.get('retainedAnalysis') else None
            result = analyze_missing_measurements(bundle, profile, disposition,
                bundle_sha256=configuration['bundleSha256'], profile_sha256=configuration['profileSha256'],
                input_hashes={identifier: record['sha256'] for identifier, record in configuration['recordings'].items()},
                retained_artifact=retained, retained_sha256=configuration.get('retainedAnalysisSha256'))
        else:
            result = analyze_tree_run(bundle, configuration['recordings'], profile)
        if result.get('status') != 'completed': raise ValueError('The selected recording remains pending under its retained scientific code.')
        result.update(revisionId=configuration['analysisId'], profileHash=configuration['profileSha256'])
        result['report'] = build_tree_report(result)
        value = {'result': result, 'runtime': runtime_identity()}
    elif kind == 'report':
        from tree_report import build_tree_report
        value = build_tree_report(_json(configuration['result']))
    elif kind == 'series':
        from tree_series import SeriesStore
        from study_profiles import development_profile
        from tree_report import build_tree_report
        store = SeriesStore(output.parent / 'series-state')
        series = _json(configuration['seriesBundle'])
        store.retain_manifest(series, configuration['seriesBundleSha256'])
        for path in configuration['individualResults']:
            result = _json(path)['result']
            store.accept(result)
            store.select_revision(result['runId'], result['revisionId'])
        value = store.evaluate(development_profile(), series_id=series['seriesId'])
        value['report'] = build_tree_report(value)
    else: raise ValueError('Unknown reproduction engine operation.')
    _write(output, value)


def reproduce_publication(publication, downloads, output, *, verify_only=False):
    manifest = _manifest(publication)
    files = verify_downloaded_files(manifest, downloads)
    output = Path(output).resolve()
    if output.exists() and (not output.is_dir() or any(output.iterdir())): raise ValueError('Reproduction requires a new or empty output directory.')
    output.mkdir(parents=True, exist_ok=True)
    summary = {'publicationId': manifest['publicationId'], 'softwareTest': manifest['softwareTest'], 'hashesVerified': True,
               'fileCount': len(files), 'runtime': runtime_identity(), 'warnings': [],
               'comparison': {'matched': None, 'missingInputs': [], 'individualAnalyses': [], 'accumulated': None}}
    if verify_only:
        _write(output / 'reproduction.json', summary)
        return summary
    releases = manifest.get('sourceReleases', {})
    presentation = _source(releases.get('accumulation', {}), files, output / 'source' / 'accumulation')
    results = []
    for member in manifest['inventory']:
        selected = member.get('analysis')
        if member.get('analysisState') != 'completed' or not selected: continue
        identifier = selected['analysisId']
        if not IDENTITY.fullmatch(identifier): raise ValueError('The retained analysis identity escapes its reproduction directory.')
        release = releases.get('analyses', {}).get(identifier)
        if not release: raise ValueError('Historical analysis source package is unavailable for a selected revision.')
        original = _json(files[selected['analysisSha256']])
        if original['runId'] != selected['runId'] or original['analysisId'] != identifier:
            raise ValueError('The selected original analysis has a different recording or revision identity.')
        expected_sources = {name if '/' in name or name.endswith('.json') else 'src/' + name: digest
                            for name, digest in original['codeHashes'].items()}
        if release.get('codeSha256') != original['codeSha256'] or release.get('files') != expected_sources:
            raise ValueError('The retained source release identities differ from the actual selected analysis source identity.')
        source = _source(release, files, output / 'source' / identifier)
        inputs = _json(files[selected['reproductionInputsSha256']])
        if inputs['runBundleSha256'] != original['bundleSha256'] or inputs['profileSha256'] != original['profileSha256'] or (
            selected['runBundleSha256'] != inputs['runBundleSha256'] or selected['profileSha256'] != inputs['profileSha256']
        ):
            raise ValueError('The reproduction bundle or profile differs from the selected analysis identity.')
        recordings = copy.deepcopy(inputs['recordings'])
        if set(recordings) != set(original['inputHashes']):
            raise ValueError('The reproduction originals differ from the selected analysis input inventory.')
        for recording_id, record in recordings.items():
            if record['sha256'] != original['inputHashes'].get(recording_id) or record['sha256'] not in files:
                raise ValueError('The reproduction original differs from its actual analysis input identity.')
            record['path'] = str(files[record['sha256']])
            if record.get('frameTimelineSha256'):
                if original['derivedInputHashes'].get(recording_id + ':timeline') != record['frameTimelineSha256']:
                    raise ValueError('The reproduction camera timeline differs from its actual analysis input.')
                record['frameTimeline'] = _json(files[record['frameTimelineSha256']])
            if record.get('clockMapSha256'):
                if original['derivedInputHashes'].get(record['timeMapId']) != record['clockMapSha256']:
                    raise ValueError('The reproduction clock map differs from its actual analysis input.')
                mapping = _json(files[record['clockMapSha256']])['mapping']['video']
                if mapping != record.get('clockMap'): raise ValueError('The retained clock map differs from its saved references.')
                record['clockMap'] = mapping
            if record.get('obstructionReviewSha256'):
                if original['derivedInputHashes'].get(record['obstructionReviewId']) != record['obstructionReviewSha256']:
                    raise ValueError('The reproduction footage review differs from its actual analysis input.')
                record['obstructionReview'] = _json(files[record['obstructionReviewSha256']])
        missing_configuration = {}
        disposition = original['result'].get('measurementDisposition')
        if disposition is not None:
            identity = inputs.get('measurementDispositionSha256')
            if identity != original['derivedInputHashes'].get('measurementDisposition') or (
                identity != selected.get('measurementDispositionSha256') or identity not in files or
                _json(files[identity]) != disposition
            ):
                raise ValueError('The reproduction missing-measurement disposition differs from its sealed analysis input.')
            missing_configuration['measurementDisposition'] = str(files[identity])
            retained = disposition.get('retainedAnalysis')
            if retained:
                identity = inputs.get('retainedAnalysisSha256')
                if identity != retained['sha256'] or identity != original['derivedInputHashes'].get('retainedAnalysis') or (
                    identity != selected.get('retainedAnalysisSha256') or identity not in files
                ):
                    raise ValueError('The reproduction retained measurements differ from their sealed analysis input.')
                missing_configuration.update(retainedAnalysis=str(files[identity]), retainedAnalysisSha256=identity)
            elif inputs.get('retainedAnalysisSha256') is not None or original['derivedInputHashes'].get('retainedAnalysis') is not None:
                raise ValueError('Undeclared retained measurements cannot enter reproduction.')
        elif inputs.get('measurementDispositionSha256') is not None or inputs.get('retainedAnalysisSha256') is not None:
            raise ValueError('Undeclared missing-measurement inputs cannot replace an original-video analysis.')
        artifact_path = output / (identifier + '-result.json')
        computed = _worker('analysis', {'source': str(source), 'bundle': str(files[selected['runBundleSha256']]),
                          'profile': str(files[selected['profileSha256']]), 'recordings': recordings,
                          'analysisId': identifier, 'profileSha256': selected['profileSha256'],
                          'bundleSha256': selected['runBundleSha256'], **missing_configuration}, artifact_path)
        individual = computed['result'] == original['result']
        # Current publication presentation can differ from the original immutable report.
        result_path = output / (identifier + '-scientific.json')
        _write(result_path, computed['result'])
        report = _worker('report', {'source': str(presentation), 'result': str(result_path)}, output / (identifier + '-report.json'))
        displayed = report == _json(files[selected['reportSha256']])
        runtime_matches = original.get('runtime') == computed['runtime'] if original.get('runtime') else None
        if runtime_matches is not True:
            warning = f'Analysis {identifier}: original runtime metadata was not retained.' if runtime_matches is None else f'Analysis {identifier}: runtime differs; numerical comparison remains exact without tolerance.'
            summary['warnings'].append(warning); logging.warning(warning)
        summary['comparison']['individualAnalyses'].append({'runId': selected['runId'], 'analysisId': identifier,
                                                           'matched': individual, 'reportMatched': displayed, 'runtimeMatched': runtime_matches})
        results.append(str(artifact_path))
    series = _worker('series', {'source': str(presentation), 'seriesBundle': str(files[manifest['seriesBundle']['sha256']]),
                     'seriesBundleSha256': manifest['seriesBundle']['sha256'], 'individualResults': results}, output / 'accumulated-result.json')
    accumulated = series == _json(files[manifest['accumulated']['resultSha256']])
    report_matches = series['report'] == _json(files[manifest['accumulated']['reportSha256']])
    summary['comparison'].update(accumulated=accumulated, accumulatedReport=report_matches,
        matched=accumulated and report_matches and all(item['matched'] and item['reportMatched'] for item in summary['comparison']['individualAnalyses']))
    _write(output / 'reproduction.json', summary)
    return summary


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url): return None


def download_publication(url, destination):
    parsed = urlsplit(url)
    if parsed.username or parsed.password or parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost')):
        raise ValueError('Use a public HTTPS publication URL, or a loopback software rehearsal URL.')
    if not parsed.path.startswith((PUBLIC, LEGACY_PUBLIC)): raise ValueError('Use the public Targeted Vegetation Movement publication URL.')
    origin = urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))
    path = parsed.path.removesuffix('/manifest').rstrip('/')
    identity = path.split('/')[-1] if '/api/publications/' in path else parse_qs(parsed.query).get('publication', [None])[0]
    opener = build_opener(_NoRedirect())
    def open_file(route):
        try: return opener.open(Request(origin + route, headers={'Accept': 'application/json, application/octet-stream'}), timeout=60)
        except HTTPError as error:
            if error.code in (301, 302, 303, 307, 308, 401, 403):
                raise ValueError(f'Publication download requires public access (HTTP {error.code}). For protected Test, use files already downloaded through the authenticated browser with --publication and --files.') from error
            raise ValueError(f'Publication download failed (HTTP {error.code}).') from error
        except URLError as error: raise ValueError('Publication download transport failed; retry the same public publication.') from error
    if identity is None:
        with open_file(PUBLIC + 'api/latest') as response: identity = json.load(response)['publicationId']
    if not IDENTITY.fullmatch(identity): raise ValueError('The public publication identity is invalid.')
    destination = Path(destination).resolve()
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())): raise ValueError('Downloads require a new or empty destination directory.')
    destination.mkdir(parents=True, exist_ok=True)
    base = PUBLIC + 'api/publications/' + identity
    manifest_path = destination / 'manifest.json'
    with open_file(base + '/manifest') as response:
        raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024: raise ValueError('The publication manifest exceeds its 2 MiB format bound.')
    manifest_path.write_bytes(raw)
    manifest = _manifest(manifest_path)
    if manifest['publicationId'] != identity: raise ValueError('The downloaded manifest has a different publication identity.')
    for digest, metadata in manifest['files'].items():
        target = destination / digest
        with open_file(base + '/files/' + digest + '/' + quote(metadata['filename'], safe='')) as response, target.open('xb') as output:
            count, checksum = 0, hashlib.sha256()
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > metadata['size']: raise ValueError(f'A public file changed size: {metadata["filename"]}.')
                checksum.update(chunk); output.write(chunk)
        if count != metadata['size'] or checksum.hexdigest() != digest: raise ValueError(f'A public file changed: {metadata["filename"]}.')
    return manifest_path
