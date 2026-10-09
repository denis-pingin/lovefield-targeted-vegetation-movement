import hashlib

import pytest

from study_app import StudyApplication
from study_http import AppError
from tree_fixtures import tree_bundle, write_bundle


def test_tree_import_preserves_identity_and_is_idempotent(tmp_path):
    source = write_bundle(tmp_path / 'original.json', tree_bundle())
    original_bytes = source.read_bytes()
    app = StudyApplication(tmp_path / 'tree-data')
    try:
        first = app.import_run_bundle(source)
        second = app.import_run_bundle(source)
        assert first['runId'] == second['runId'] == 'tree-1'
        assert len(app.list_runs()['runs']) == 1
        retained = app.get_run('tree-1')
        assert retained['provenance']['experimentSlug'] == 'wind-prestudy'
        assert len(retained['bundles']) == 1
        assert source.read_bytes() == original_bytes
        assert first['sha256'] == hashlib.sha256(original_bytes).hexdigest()
    finally:
        app.close()


@pytest.mark.parametrize('mode', ['local', 'global'])
def test_non_tree_import_is_rejected_before_store_write(tmp_path, mode):
    source = write_bundle(tmp_path / 'original.json', tree_bundle(mode=mode))
    app = StudyApplication(tmp_path / 'tree-data')
    try:
        with pytest.raises(AppError, match='Tree|tree'):
            app.import_run_bundle(source)
        assert app.list_runs()['runs'] == []
    finally:
        app.close()


def test_read_only_setup_import_resolves_source_frame_without_png_metadata(tmp_path):
    import cv2
    import json
    import numpy as np
    source = tmp_path / 'retained-setup'
    source.mkdir()
    encoded = cv2.imencode('.png', np.zeros((80, 120, 3), dtype=np.uint8))[1].tobytes()
    digest = hashlib.sha256(encoded).hexdigest()
    (source / f'{digest}.png').write_bytes(encoded)
    metadata = {'sha256': digest, 'imageSize': {'width': 120, 'height': 80},
                'sources': [{'sourceKind': 'setup', 'sourceVideoName': 'DSC_0056.MOV',
                             'sourceVideoSha256': 'a' * 64, 'frameIndex': 4, 'ptsSeconds': .16}]}
    (source / f'{digest}.json').write_text(json.dumps(metadata))
    original_metadata = (source / f'{digest}.json').read_bytes()
    bundle = tree_bundle()
    bundle['state']['setupSnapshot'] = {'imageSha256': digest, 'imageSize': metadata['imageSize'],
                                      'regions': {'A': [0, 0, 35, 35], 'B': [40, 0, 35, 35],
                                                  'background': [80, 0, 35, 35]}}
    path = write_bundle(tmp_path / 'original.json', bundle)
    app = StudyApplication(tmp_path / 'tree-data')
    try:
        app.import_retained_setup(source)
        app.import_retained_setup(source)
        app.import_run_bundle(path)
        setup = app.get_run('tree-1')['savedSetup']
        assert setup['frameIndex'] == 4
        assert setup['ptsSeconds'] == .16
        assert setup['sourceVideoSha256'] == 'a' * 64
        assert app.get_setup_png(digest) == encoded
        assert (source / f'{digest}.json').read_bytes() == original_metadata
        assert (source / f'{digest}.png').read_bytes() == encoded
    finally:
        app.close()


def test_finite_fractional_playback_and_event_milliseconds_are_retained(tmp_path):
    bundle = tree_bundle(slug='tree-targeting')
    for event in bundle['events']:
        event['serverAtMs'] += .5
    for cue in bundle['cues']:
        for field in ('issuedAtMs', 'dueAtMs', 'playedAtMs'):
            cue[field] += .5
    path = write_bundle(tmp_path / 'fractional.json', bundle)
    app = StudyApplication(tmp_path / 'tree-data')
    try:
        retained = app.import_run_bundle(path)
        assert retained['runId'] == 'tree-1'
        assert app.get_run('tree-1')['bundles'][0]['sha256'] == hashlib.sha256(path.read_bytes()).hexdigest()
        from study_bundle import load_run_bundle
        assert load_run_bundle(path)['cues'][0]['playedAtMs'] == 2000.5
    finally:
        app.close()
