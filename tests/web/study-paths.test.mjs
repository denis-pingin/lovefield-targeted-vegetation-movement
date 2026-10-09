import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applicationSurface, hostedApiPath} from '../../web/app.mjs';
import {labPageUrl, publicStudyUrl} from '../../web/study-paths.mjs';

test('the five sections and retained recording and scientific-document URLs keep the selected publication', () => {
  const publicationId = '12345678-1234-4234-8234-123456789012';
  for (const [page, path] of [['about', ''], ['methods', 'methods'], ['results', 'results'],
    ['recordings', 'recordings'], ['reproducibility', 'reproducibility'], ['protocol', 'protocol'], ['analysis', 'methods/analysis']]) {
    assert.equal(publicStudyUrl(page, publicationId), `/studies/targeted-vegetation-movement/public/${path}?publication=${publicationId}`);
  }
  assert.equal(publicStudyUrl('recording', publicationId, 'run-one'), `/studies/targeted-vegetation-movement/public/recordings/run-one?publication=${publicationId}`);
  assert.equal(publicStudyUrl('about'), '/studies/targeted-vegetation-movement/public/');
  for (const page of ['index', 'legal', 'privacy', 'reuse', 'research-notice']) {
    const path = `/studies/${page === 'index' ? '' : `${page}/`}`;
    assert.equal(labPageUrl(page, publicationId), `${path}?publication=${publicationId}`);
    assert.equal(labPageUrl(page), path);
  }
});

test('hosted transport uses the new operator route while local Mac analysis keeps its path', () => {
  assert.equal(hostedApiPath('runs'), '/studies/targeted-vegetation-movement/app/api/runs');
  assert.equal(applicationSurface('/studies/targeted-vegetation-movement/app/'), 'hosted');
  assert.equal(applicationSurface('/studies/tree-targeting/app/'), 'hosted');
  assert.equal(applicationSurface('/tree-targeting/analysis/'), 'analysis');
  assert.equal(applicationSurface('/tree-targeting/'), 'hosted');
});

test('a selected-run bookmark takes precedence over the retained browser selection', async () => {
  const {hostedBookmarkRun} = await import('../../web/app.mjs');
  assert.equal(hostedBookmarkRun({search: '?run=chosen'}, 'previous'), 'chosen');
  assert.equal(hostedBookmarkRun({search: ''}, 'previous'), 'previous');
});

test('shared Lab page resolution recognizes only the index and four named articles', async () => {
  const {labPageForPath} = await import('../../web/study-paths.mjs');
  for (const [path, page] of [['/studies', 'index'], ['/studies/', 'index'], ['/studies/legal', 'legal'],
    ['/studies/privacy/', 'privacy'], ['/studies/reuse', 'reuse'], ['/studies/research-notice/', 'research-notice']]) {
    assert.equal(labPageForPath(path), page, path);
  }
  for (const path of ['/', '/studies/private', '/studies/legal/private', '/studies-other', '/studies//',
    '/studies/targeted-vegetation-movement/public/']) assert.equal(labPageForPath(path), null, path);
});


test('current materials and publication downloads use the canonical name without changing file identities', async () => {
  const {currentStudyFileUrl, publicFileUrl} = await import('../../web/study-paths.mjs');
  const study = {files: {protocol: {filename: 'protocol.md'}, methods: {filename: 'analysis-methods.md'}, source: {filename: 'source.zip'}}};
  for (const [kind, filename] of [['protocol', 'protocol.md'], ['methods', 'analysis-methods.md'], ['source', 'source.zip']]) {
    assert.equal(currentStudyFileUrl(study, kind), '/studies/targeted-vegetation-movement/public/current-study/' + filename);
  }
  assert.equal(currentStudyFileUrl(study, 'private'), null);
  const digest = 'a'.repeat(64), publicationId = '12345678-1234-4234-8234-123456789012';
  assert.equal(publicFileUrl({publicationId, files: {[digest]: {filename: 'camera original.mp4'}}}, digest),
    '/studies/targeted-vegetation-movement/public/api/publications/' + publicationId + '/files/' + digest + '/camera%20original.mp4');
  assert.equal(publicFileUrl({publicationId, files: {}}, digest), null);
});
