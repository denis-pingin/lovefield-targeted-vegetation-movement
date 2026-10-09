import test from 'node:test';
import assert from 'node:assert/strict';
import {startMacAnalysisApplication} from '../../web/app.mjs';
import {renderMacAnalysisPage, renderMacResultPage} from '../../web/views.mjs';
import {renderTreeResults} from '../../web/tree-results.mjs';

const runId = 'missing-camera', profileId = 'frozen-profile', seriesId = 'scored-series';
const report = {title: 'Tree result', status: 'Scored result', counts: {runs: 1, targets: 2, missingBins: 4},
  narrative: ['Camera file was lost. The original video extraction cannot be repeated.'], charts: [], tables: {}};
const artifact = {runId, analysisId: 'missing-revision', profileId, status: 'completed', displayReport: report,
  result: {report, measurementDisposition: {reason: 'Camera file was lost.', recordedAtMs: 1000,
    videoExtractionRepeatable: false, missingRecordings: []}}};
const detail = {runId, purpose: 'scored', mode: 'tree', recordings: {}, analyses: {},
  frozenProfile: {profileId, label: 'Frozen Tree profile', sealedProfileJson: '{}'}};
const context = extra => ({runs: [{runId, purpose: 'scored', mode: 'tree'}], selectedRunId: runId,
  detail, profiles: [], ...extra});
const settle = async () => {for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve));};

function harness({response, failure = false} = {}) {
  const elements = new Map(), requests = [], timers = [];
  let retainedDetail = structuredClone(detail);
  const element = () => ({hidden: false, textContent: '', innerHTML: '', listeners: new Map(),
    addEventListener(kind, callback) {this.listeners.set(kind, callback);}, querySelector() {return null;}, querySelectorAll() {return [];}});
  const main = element();
  elements.set('main', main);
  const document = {getElementById(id) {if (!elements.has(id)) elements.set(id, element()); return elements.get(id);}, querySelector: element};
  class Form {
    constructor(kind, fields) {this.dataset = {analysisForm: kind}; this.fields = fields;}
    reportValidity() {return true;}
  }
  const window = {location: {hash: ''}, crypto: globalThis.crypto, HTMLFormElement: Form,
    FormData: class extends Map {constructor(form) {super(Object.entries(form.fields));}},
    setInterval(callback) {timers.push(callback); return timers.length;}, clearInterval() {},
    async fetch(url, options = {}) {
      requests.push({url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null});
      let value;
      if (url.endsWith('/finalize-missing-measurements')) {
        if (failure) return Response.json({error: {message: 'The camera original is available.'}}, {status: 409});
        value = response ? await response() : artifact;
        retainedDetail.analyses[value.analysisId] = {analysisId: value.analysisId, profileId, status: value.status};
      } else if (url.endsWith('/select-revision')) value = {runIds: [runId], selectedRevisions: ['recovered-revision']};
      else if (url.includes(`/runs/${runId}/analyses/`)) value = artifact;
      else if (url.endsWith(`/runs/${runId}`)) value = retainedDetail;
      else if (url.endsWith('/runs')) value = {runs: [{runId, purpose: 'scored', mode: 'tree', seriesId, analysisRunning: Object.values(retainedDetail.analyses).some(item => item.status === 'running')}]};
      else if (url.endsWith('/series')) value = {series: [{seriesId, label: 'Scored series', manifestImported: true}], report: null};
      else if (url.endsWith(`/series/${seriesId}`)) value = {seriesId, purpose: 'scored', report};
      else if (url.endsWith('/profiles')) value = {profiles: []};
      else if (url.endsWith('/comparison-candidates')) value = {runs: [], profiles: []};
      else if (url.endsWith('/comparisons')) value = {comparisons: []};
      else if (url.endsWith('/annotations') || url.endsWith('/publication')) value = {jobs: []};
      else if (url.endsWith('/setup-clip')) value = {};
      else if (url.endsWith('/progress')) value = {stage: 'Finalizing missing measurements'};
      else throw new Error(`Unexpected request ${url}`);
      return Response.json(value);
    }};
  startMacAnalysisApplication(document, window);
  const submit = (kind, fields) => main.listeners.get('submit')({target: new Form(kind, fields), preventDefault() {}});
  const click = (operation, analysisId) => main.listeners.get('click')({target: {closest() {return {type: 'button', disabled: false, dataset: {analysisOperation: operation, analysisId}};}}});
  return {main, elements, requests, timers, submit, click,
    async open() {await settle(); submit('select-run', {run_id: runId}); await settle();},
    async complete() {retainedDetail.analyses[artifact.analysisId] = artifact; timers[0](); await settle();}};
}

test('a missing original exposes an existing styled form with a required reason and frozen profile', () => {
  const html = renderMacAnalysisPage(context());
  const panel = html.match(/<section class="panel"><h2>Finalize with missing measurements(.*?)<\/section>/s)?.[0];
  assert.ok(panel);
  const form = html.match(/<form data-analysis-form="finalize-missing-measurements">(.*?)<\/form>/s)?.[1];
  assert.ok(form);
  assert.match(form, /name="reason"[^>]*required/);
  assert.match(form, /name="run_id" value="missing-camera"/);
  assert.match(form, /name="profile_id" value="frozen-profile"/);
  assert.match(form, />Finalize with missing measurements<\/button>/);
  assert.match(panel, /bounded|unknown/i);
  const busy = renderMacAnalysisPage(context({busy: true})).match(/<form data-analysis-form="finalize-missing-measurements">(.*?)<\/form>/s)?.[1];
  assert.match(busy, /<button[^>]*disabled/);
});

test('the finalization form is unavailable for an available original and reachable for a lost imported original', () => {
  const video = {recordingId: 'camera', kind: 'video', name: 'camera.avi', available: true};
  assert.doesNotMatch(renderMacAnalysisPage(context({detail: {...detail, recordings: {camera: video}}})), /data-analysis-form="finalize-missing-measurements"/);
  assert.match(renderMacAnalysisPage(context({detail: {...detail, recordings: {camera: {...video, available: false}}}})), /data-analysis-form="finalize-missing-measurements"/);
});

test('reason validation blocks an empty declaration and successful finalization refreshes its visible result', async () => {
  const h = harness(); await h.open();
  h.submit('finalize-missing-measurements', {run_id: runId, profile_id: profileId, reason: '  '}); await settle();
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 0);
  assert.match(h.elements.get('error').innerHTML, /reason/i);
  h.submit('finalize-missing-measurements', {run_id: runId, profile_id: profileId, reason: ' Camera file was lost. '}); await settle();
  const request = h.requests.find(item => item.method === 'POST');
  assert.ok(request);
  assert.equal(request.url, '/tree-targeting/api/analysis/finalize-missing-measurements');
  assert.deepEqual(Object.keys(request.body).sort(), ['profileId', 'reason', 'requestId', 'runId']);
  assert.equal(request.body.reason, 'Camera file was lost.');
  assert.equal(request.body.profileId, profileId);
  assert.equal(request.body.runId, runId);
  assert.ok(request.body.requestId);
  assert.match(h.main.innerHTML, /Camera file was lost/);
  assert.match(h.main.innerHTML, /original video extraction cannot be repeated/);
});

test('finalization uses busy/error handling and follows async completion without duplicate submissions', async () => {
  let finish;
  const h = harness({response: () => new Promise(resolve => {finish = resolve;})}); await h.open();
  const fields = {run_id: runId, profile_id: profileId, reason: 'Camera file was lost.'};
  h.submit('finalize-missing-measurements', fields); await settle();
  assert.match(h.main.innerHTML, /Finalizing missing measurements/);
  assert.match(h.main.innerHTML, /Other controls are unavailable/);
  h.submit('finalize-missing-measurements', fields);
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 1);
  finish({...artifact, status: 'running', result: undefined, displayReport: undefined}); await settle();
  await h.complete();
  assert.match(h.main.innerHTML, /Camera file was lost/);
  assert.doesNotMatch(h.main.innerHTML, /Other controls are unavailable/);
  const failed = harness({failure: true}); await failed.open();
  failed.submit('finalize-missing-measurements', fields); await settle();
  assert.match(failed.elements.get('error').innerHTML, /camera original is available/);
  assert.doesNotMatch(failed.main.innerHTML, /Other controls are unavailable/);
});

test('scored completed revisions have reachable view and selection controls for recovered originals', async () => {
  const html = renderMacAnalysisPage(context({detail: {...detail, analyses: {
    missing: {...artifact}, recovered: {...artifact, analysisId: 'recovered-revision'}}}}));
  assert.match(html, /data-analysis-operation="select-revision" data-analysis-id="recovered-revision"/);
  assert.match(html, /Use this revision in series/);
  const h = harness(); await h.open();
  h.click('select-revision', 'recovered-revision'); await settle();
  const request = h.requests.find(item => item.method === 'POST');
  assert.equal(request.url, '/tree-targeting/api/analysis/select-revision');
  assert.equal(request.body.analysisId, 'recovered-revision');
});

test('missing-measurement explanation is retained for local and public result readers', () => {
  const local = renderMacResultPage({analysis: artifact, run: detail});
  const publicResult = renderTreeResults({report}, {audience: 'public'});
  for (const html of [local, publicResult]) {
    assert.match(html, /Camera file was lost/);
    assert.match(html, /original video extraction cannot be repeated/);
  }
});
