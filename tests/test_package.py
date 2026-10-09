import http.client
import json

from study_app import StudyApplication
from study_http import start_http


def test_independent_app_uses_ephemeral_tree_loopback(tmp_path):
    application = StudyApplication(tmp_path / 'tree-data')
    server = start_http(application)
    try:
        assert server.server_address[0] == '127.0.0.1'
        assert server.server_port > 0
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
        connection.request('GET', '/tree-targeting/analysis/')
        response = connection.getresponse()
        assert response.status == 200
        assert b'Tree' in response.read()
        connection.close()
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
        connection.request('GET', '/tree-targeting/api/analysis/runs')
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read()) == {'experimentSlug': 'tree-targeting', 'runs': []}
        connection.close()
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
        connection.request('GET', '/wind-prestudy/analysis/')
        response = connection.getresponse()
        assert response.status == 404
        response.read()
        connection.close()
        assert application.directory == (tmp_path / 'tree-data').resolve()
    finally:
        server.shutdown()
        server.server_close()
        application.close()
