"""A deliberately small HTTP surface bound to one loopback service instance."""
import json
import logging
import math
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APPLICATION_HEADER = 'X-Study-App'
APPLICATION_VALUE = 'tree-targeting-v2'
MAX_BODY_BYTES = 1024 * 1024
GET_ROUTES = {'/api/state', '/api/studies', '/api/recordings', '/api/results'}
POST_ROUTES = {'/api/actions', '/api/studies', '/api/setup', '/api/choose-files',
               '/api/import', '/api/extract', '/api/seal', '/api/evaluate',
               '/api/export', '/api/quit'}
ASSETS = {'/':'index.html', '/index.html':'index.html', '/app.css':'app.css',
          '/app.mjs':'app.mjs', '/operator-model.mjs':'operator-model.mjs',
          '/views.mjs':'views.mjs', '/tree-results.mjs':'tree-results.mjs',
          '/tree-comparisons.mjs':'tree-comparisons.mjs', '/study-paths.mjs':'study-paths.mjs',
          '/run-config.mjs':'run-config.mjs',
          '/cues.mjs':'cues.mjs', '/clock.mjs':'clock.mjs'}
ANALYSIS_ASSETS = {'/tree-targeting/analysis/':'index.html',
    **{f'/tree-targeting/analysis/{path[1:]}':asset for path,asset in ASSETS.items() if path != '/'}}
ANALYSIS_API = '/tree-targeting/api/analysis/'
CONTENT_TYPES = {'.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
                 '.mjs':'text/javascript; charset=utf-8'}


class AppError(ValueError):
    def __init__(self, message, *, operation='application', code='invalid_request', status=400,
                 corrective_action='Review the setup and request, then retry with a new request ID.', **context):
        super().__init__(message)
        self.message, self.operation, self.code, self.status = message, operation, code, status
        self.corrective_action, self.context = corrective_action, context

    def public(self):
        return {'operation':self.operation, 'code':self.code, 'message':self.message,
                'corrective_action':self.corrective_action, **self.context}


def finite_json(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError('JSON numbers must be finite')
    if isinstance(value, dict):
        for nested in value.values():
            finite_json(nested)
    elif isinstance(value, list):
        for nested in value:
            finite_json(nested)
    return value


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def start_http(application, *, web_directory=None):
    """Start an ephemeral loopback listener; its application owns all mutations."""
    root = Path(web_directory or Path(__file__).parent.parent / 'web')

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            # Access URLs and submitted body contents are intentionally not logged.
            return

        def send_data(self, status, content, content_type='application/json; charset=utf-8'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            self.wfile.write(content)

        def json_response(self, status, value):
            self.send_data(status, json.dumps(value, allow_nan=False, separators=(',', ':')).encode())

        def reject(self, status, code, message):
            self.json_response(status, {'error':{'operation':'http', 'code':code,
                'message':message, 'corrective_action':'Reopen this application from its installed launcher.'}})

        def guards(self, mutation=False):
            authority = f'127.0.0.1:{self.server.server_port}'
            if self.headers.get_all('Host') != [authority]:
                self.reject(403, 'wrong_host', 'The request does not address this local application.')
                return False
            origins = self.headers.get_all('Origin')
            if origins is not None and origins != [f'http://{authority}']:
                self.reject(403, 'wrong_origin', 'The request originated outside this application.')
                return False
            if mutation:
                if origins != [f'http://{authority}'] or self.headers.get_all(APPLICATION_HEADER) != [APPLICATION_VALUE]:
                    self.reject(403, 'missing_application_header', 'The application request headers are missing.')
                    return False
                if self.headers.get_content_type() != 'application/json':
                    self.reject(415, 'content_type', 'Application changes require JSON.')
                    return False
            return True

        def do_GET(self):
            if not self.guards():
                return
            if self.path == '/tree-targeting/analysis':
                self.send_response(308)
                self.send_header('Location', '/tree-targeting/analysis/')
                self.send_header('Content-Length', '0')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
                return
            annotation = re.fullmatch(r'/tree-targeting/api/analysis/annotations/([a-f0-9]{32})/clip\.avi', self.path)
            if annotation:
                try:
                    artifact = application.get_annotation_artifact(annotation.group(1))
                    self.send_response(200)
                    self.send_header('Content-Type', 'video/x-msvideo')
                    self.send_header('Content-Length', str(artifact.stat().st_size))
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.send_header('Content-Disposition', f'attachment; filename="{artifact.name}"')
                    self.end_headers()
                    with artifact.open('rb') as source:
                        while chunk := source.read(1024 * 1024):
                            self.wfile.write(chunk)
                except AppError as error:
                    self.json_response(error.status, {'error':error.public()})
                return
            image = re.fullmatch(r'/tree-targeting/api/analysis/setup-images/([a-f0-9]{64})\.png', self.path)
            if image:
                try:
                    self.send_data(200, application.get_setup_png(image.group(1)), 'image/png')
                except AppError as error:
                    self.json_response(error.status, {'error':error.public()})
                return
            if self.path in GET_ROUTES or self.path.startswith(ANALYSIS_API):
                self.delegate('GET')
            elif self.path in ASSETS or self.path in ANALYSIS_ASSETS:
                asset = root / (ASSETS.get(self.path) or ANALYSIS_ASSETS[self.path])
                try:
                    data = asset.read_bytes()
                except FileNotFoundError:
                    self.reject(404, 'asset_unavailable', 'The application asset is missing; repair the installation.')
                    return
                self.send_data(200, data, CONTENT_TYPES[asset.suffix])
            else:
                self.reject(404, 'unknown_route', 'That resource is not exposed by this application.')

        def do_POST(self):
            if not self.guards(mutation=True):
                return
            if self.path not in POST_ROUTES and not self.path.startswith(ANALYSIS_API):
                self.reject(404, 'unknown_route', 'That operation is not exposed by this application.')
                return
            lengths = self.headers.get_all('Content-Length')
            if self.headers.get('Transfer-Encoding') or not lengths or len(lengths) != 1:
                self.reject(400, 'body_length', 'Provide one fixed JSON request length.')
                return
            try:
                length = int(lengths[0])
                if length < 0:
                    raise ValueError()
            except ValueError:
                self.reject(400, 'body_length', 'The request length is invalid.')
                return
            if length > MAX_BODY_BYTES:
                self.reject(413, 'body_too_large', 'The request exceeds the local application size limit.')
                return
            try:
                self.connection.settimeout(5)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError()
                payload = finite_json(json.loads(raw, object_pairs_hook=_object))
                if not isinstance(payload, dict):
                    raise ValueError()
            except (ValueError, UnicodeError, RecursionError, TimeoutError):
                self.reject(400, 'invalid_json', 'Provide one JSON object with finite numbers and unique keys.')
                return
            self.delegate('POST', payload)

        def delegate(self, method, payload=None):
            try:
                result = application.dispatch(method, self.path, payload)
                self.json_response(202 if result.get('status') in ('queued', 'running') and
                    ('job_id' in result or 'analysisId' in result or 'evaluationId' in result) else 200, result)
            except AppError as error:
                self.json_response(error.status, {'error':error.public()})
            except Exception as error:
                logging.error('Local HTTP operation %s failed (%s); returning an incomplete-operation error', self.path, type(error).__name__)
                self.reject(500, 'operation_failed', 'The operation failed. Existing records were retained.')

        def do_OPTIONS(self):
            self.reject(405, 'method_not_allowed', 'Cross-origin requests are not supported.')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    server.application = application
    threading.Thread(target=server.serve_forever, name='study-http', daemon=True).start()
    return server
