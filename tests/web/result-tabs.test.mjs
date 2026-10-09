import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMacAnalysisPage, renderMacResultPage} from '../../web/views.mjs';
import {startMacAnalysisApplication} from '../../web/app.mjs';

const first = {analysisId: 'first-result', runId: 'same-run', profileId: 'original-profile', status: 'completed',
  sealedProfileJson: JSON.stringify({label: 'Original 3000/41', video: {featureDetection: {maxCorners: 3000}, tracking: {windowSizePixels: [41, 41]}}}),
  displayReport: {counts: {targets: 0}, narrative: ['Original result narrative'], charts: [], tables: {}}};
const second = {...first, analysisId: 'second-result', profileId: 'new-profile',
  sealedProfileJson: JSON.stringify({label: 'New 6000/21', video: {featureDetection: {maxCorners: 6000}, tracking: {windowSizePixels: [21, 21]}}}),
  displayReport: {counts: {targets: 0}, narrative: ['New result narrative'], charts: [], tables: {}}};
const run = {runId: 'same-run', tag: 'DSC_0053', mode: 'tree', purpose: 'preparation', selectedProfileId: 'new-profile',
  analyses: {'first-result': first, 'second-result': second}};

test('every completed analysis has its own new-tab link and profile identity', () => {
  const html = renderMacAnalysisPage({runs: [run], selectedRunId: run.runId, detail: run});
  for (const result of [first, second]) {
    assert.ok(html.includes(`href="/tree-targeting/analysis/#run=same-run&amp;analysis=${result.analysisId}"`));
    assert.match(html, /target="_blank" rel="noopener">Open result in new tab/);
    assert.ok(html.includes(result.profileId));
  }
});

test('area result identifies measured-area meaning and actual spatial coverage', () => {
  const area = {analysisId: 'area-result', status: 'completed', profileId: 'area-profile',
    sealedProfileJson: JSON.stringify({label: 'Area canopy', video: {
      featureDetection: {maxCorners: 3000}, tracking: {windowSizePixels: [41, 41]},
      measurement: {method: 'area-grid-mean-v1', cellSizePixels: 128}}}),
    result: {measurementMethod: 'area-grid-mean-v1', measurements: {pairs: [
      {A_spatial: {coverage_fraction: .75}, B_spatial: {coverage_fraction: 1}},
      {A_spatial: {coverage_fraction: 1}, B_spatial: {coverage_fraction: .5}}]}},
    displayReport: {counts: {targets: 0}, narrative: ['Area result'], charts: [], tables: {}}};
  const html = renderMacResultPage({analysis: area, run});
  assert.match(html, /area-grid-mean-v1/);
  assert.match(html, /measured-area estimate/);
  assert.match(html, /across all decoded frame pairs, including setup and clock filming/i);
  assert.match(html, /A coverage: minimum 75%/);
  assert.match(html, /B coverage: minimum 50%/);
  assert.doesNotMatch(html, /maximum points per region/i);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
async function openResult(analysisId) {
  const elements = new Map(), requests = [];
  const element = () => ({hidden: false, innerHTML: '', textContent: '', listeners: new Map(),
    addEventListener(kind, callback) { this.listeners.set(kind, callback); }, querySelector() { return null; }, querySelectorAll() { return []; }});
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }, querySelector: element};
  const window = {location: {hash: `#run=same-run&analysis=${analysisId}`},
    setInterval() { return 1; }, clearInterval() {}, crypto: globalThis.crypto,
    async fetch(url, options) {
      requests.push({url, method: options?.method ?? 'GET'});
      let value;
      if (url.endsWith('/runs/same-run')) value = run;
      else if (url.endsWith('/analyses/first-result')) value = first;
      else if (url.endsWith('/analyses/second-result')) value = second;
      else return new Response(JSON.stringify({error: {message: 'Analysis not found.'}}), {status: 404});
      return new Response(JSON.stringify(value));
    }};
  const app = startMacAnalysisApplication(document, window);
  await settle(); await settle();
  return {app, elements, document, requests};
}

test('result tabs keep distinct retained analyses on load and refresh without selecting a revision', async () => {
  const older = await openResult('first-result');
  const newer = await openResult('second-result');
  assert.match(older.elements.get('main').innerHTML, /Original result narrative/);
  assert.match(older.elements.get('main').innerHTML, /Original 3000\/41/);
  assert.doesNotMatch(older.elements.get('main').innerHTML, /New result narrative|data-analysis-form=/);
  assert.match(newer.elements.get('main').innerHTML, /New result narrative/);
  assert.match(newer.elements.get('main').innerHTML, /New 6000\/21/);
  assert.match(older.document.title, /first-result/);
  await older.app.refresh();
  assert.match(older.elements.get('main').innerHTML, /Original result narrative/);
  assert.ok([...older.requests, ...newer.requests].every(item => item.method === 'GET'));
  assert.ok(older.requests.every(item => !item.url.includes('second-result')));
});

test('an unavailable result is a visible error, not a different saved analysis', async () => {
  const missing = await openResult('missing-result');
  assert.equal(missing.elements.get('error').hidden, false);
  assert.match(missing.elements.get('error').innerHTML, /Analysis not found/);
  assert.ok(missing.requests.some(item => item.url.endsWith('/runs/same-run/analyses/missing-result')));
  assert.doesNotMatch(missing.elements.get('main').innerHTML, /Original result narrative|New result narrative/);
});
