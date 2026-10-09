import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMacAnalysisPage} from '../../web/views.mjs';
import {createTransport, startMacAnalysisApplication} from '../../web/app.mjs';

const seriesId = 'scored-tree-series', jobId = '12345678-1234-4234-8234-123456789012';
const retained = (status = 'prepared', extra = {}) => ({jobId, seriesId, environment: 'test', softwareTest: true, status,
  fileCount: 43, uploadBytes: 123456, inventory: [{runId: 'completed', contributes: true}, {runId: 'pending', contributes: false}],
  progress: {stage: 'Prepared publication'}, error: null, ...extra});
const series = {seriesId, seriesLabel: 'Generated-video software test', purpose: 'scored', softwareTest: true,
  report: {title: 'Accumulating Tree result', counts: {targets: 0}, narrative: ['No analyzed targets yet.'], charts: [], tables: {}}};
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };

function harness({jobs = [], scored = true, prepareResponse, startResponse} = {}) {
  let retainedJobs = jobs;
  const elements = new Map(), requests = [], timers = [], warnings = [];
  const element = () => ({hidden: false, textContent: '', writes: 0, value: '', listeners: new Map(),
    get innerHTML() { return this.html ?? ''; }, set innerHTML(value) { this.html = value; this.writes++; },
    addEventListener(kind, callback) { this.listeners.set(kind, callback); }, querySelector() { return null; }, querySelectorAll() { return []; }});
  const main = element(), progress = element(), navigation = element();
  main.querySelector = selector => selector === '[data-mac-operation-progress]' || selector === '[data-publication-progress]' ? progress : null;
  elements.set('main', main);
  const document = {getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, querySelector: selector => selector === '.app-navigation' ? navigation : element()};
  class Form {
    constructor(kind, fields) { this.dataset = {analysisForm: kind}; this.fields = fields; }
    reportValidity() { return true; }
  }
  const location = {hash: `#series=${seriesId}`};
  const window = {location, HTMLFormElement: Form, FormData: class extends Map {constructor(form) {super(Object.entries(form.fields));}},
    crypto: globalThis.crypto, console: {warn(...args) {warnings.push(args);}},
    setInterval(callback) { timers.push(callback); return timers.length; }, clearInterval() {},
    async fetch(url, options = {}) {
      const body = options.body ? JSON.parse(options.body) : undefined, method = options.method ?? 'GET';
      requests.push({url, method, body});
      let value;
      if (url.endsWith('/publication/prepare')) {
        value = prepareResponse ? await prepareResponse(body) : retained('preparing');
        retainedJobs = [...retainedJobs.filter(job => job.jobId !== value.jobId), value];
      } else if (url.endsWith(`/publication/${jobId}/start`)) {
        value = startResponse ? await startResponse(body) : retained('uploading', {progress: {stage: 'Uploading original camera video', completed: 1, total: 5}});
        retainedJobs = retainedJobs.map(job => job.jobId === value.jobId ? value : job);
      } else if (url.endsWith('/publication')) value = {jobs: retainedJobs};
      else if (url.endsWith(`/publication/${jobId}`)) value = retainedJobs.find(job => job.jobId === jobId);
      else if (url.endsWith('/runs')) value = {runs: []};
      else if (url.endsWith('/series')) value = {series: [{seriesId, label: series.seriesLabel, manifestImported: true}], report: null};
      else if (url.endsWith(`/series/${seriesId}`)) value = {...series, purpose: scored ? 'scored' : 'preparation'};
      else if (url.endsWith('/profiles')) value = {profiles: []};
      else if (url.endsWith('/comparison-candidates')) value = {runs: [], profiles: []};
      else if (url.endsWith('/comparisons')) value = {comparisons: []};
      else if (url.endsWith('/annotations')) value = {jobs: []};
      else if (url.endsWith('/setup-clip')) value = {};
      else if (url.endsWith('/progress')) value = retainedJobs.find(job => ['preparing', 'uploading'].includes(job.status))?.progress ?? {};
      else throw new Error(`Unexpected route ${url}`);
      return Response.json(value);
    }};
  const app = startMacAnalysisApplication(document, window);
  const submit = (kind, fields = {}) => main.listeners.get('submit')({target: new Form(kind, fields), preventDefault() {}});
  const click = (operation, id = jobId) => main.listeners.get('click')({target: {closest() {return {type: 'button', disabled: false, dataset: {analysisOperation: operation, jobId: id}};}}});
  return {app, main, elements, progress, navigation, requests, timers, warnings, submit, click,
    jobs(value) { retainedJobs = value; }, async poll() { timers[0](); await settle(); }};
}

test('a selected named scored series uses existing publication controls with exact retained totals and Test marker', () => {
  const html = renderMacAnalysisPage({seriesDetail: series, selectedSeriesId: seriesId, publicationJobs: [retained()]});
  assert.match(html, /Prepare publication/);
  assert.match(html, /Publish results/);
  assert.match(html, /43 files/);
  assert.match(html, /123,456 bytes/);
  assert.match(html, /Software test data/);
  assert.match(html, /1 included.*1 pending/s);
  assert.match(html, /data-job-id="12345678-1234-4234-8234-123456789012"/);
});

test('preparation and unnamed series remain ineligible even when a publication form event is forged', async () => {
  for (const selectedSeriesId of [null, seriesId]) {
    const html = renderMacAnalysisPage({seriesDetail: {...series, purpose: 'preparation'}, selectedSeriesId});
    assert.match(html, /named scored series/);
    assert.doesNotMatch(html, /data-analysis-form="prepare-publication"/);
  }
  const h = harness({scored: false}); await settle();
  h.submit('prepare-publication', {environment: 'test'}); await settle();
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 0);
  assert.match(h.elements.get('error').innerHTML, /named scored series/);
});

test('opening, reopening and polling restore the same selected-series job without a publication mutation', async () => {
  const h = harness({jobs: [retained()]}); await settle(); await h.poll();
  assert.match(h.main.innerHTML, /43 files/);
  assert.match(h.main.innerHTML, new RegExp(jobId));
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 0);
});

test('prepare and publish are distinct explicit actions with duplicate clicks disabled during initial snapshot preparation', async () => {
  let finishPreparation;
  const h = harness({prepareResponse: () => new Promise(resolve => {finishPreparation = resolve;})}); await settle();
  h.submit('prepare-publication', {environment: 'test', correction_reason: 'Changed saved analysis'});
  await settle();
  assert.match(h.main.innerHTML, /Preparing publication/);
  assert.match(h.main.innerHTML, /Other controls are unavailable/);
  h.submit('prepare-publication', {environment: 'test'});
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 1);
  const preparedRequest = h.requests.find(item => item.method === 'POST');
  assert.equal(preparedRequest.body.seriesId, seriesId);
  assert.equal(preparedRequest.body.environment, 'test');
  assert.equal(preparedRequest.body.correctionReason, 'Changed saved analysis');
  assert.ok(preparedRequest.body.requestId);
  finishPreparation(retained('preparing')); await settle();
  assert.equal(h.requests.filter(item => item.url.endsWith('/start')).length, 0);
  h.jobs([retained()]); await h.poll();
  assert.match(h.main.innerHTML, /43 files/);
  h.click('publish-publication'); h.click('publish-publication'); await settle();
  assert.equal(h.requests.filter(item => item.url.endsWith(`/publication/${jobId}/start`)).length, 1);
  assert.match(h.main.innerHTML, /Uploading original camera video/);
});

test('reopened uploads disable conflicting controls and update progress without rebuilding the report on every poll', async () => {
  const h = harness({jobs: [retained('uploading', {progress: {stage: 'Verifying publication files', completed: 10, total: 100, unit: 'bytes'}})]}); await settle();
  assert.match(h.main.innerHTML, /Other controls are unavailable/);
  assert.match(h.main.innerHTML, /Verifying publication files/);
  const writes = h.main.writes;
  h.jobs([retained('uploading', {progress: {stage: 'Uploading camera part', completed: 20, total: 100, unit: 'bytes'}})]);
  await h.poll();
  assert.equal(h.main.writes, writes);
  assert.match(h.progress.innerHTML, /Uploading camera part/);
  h.submit('start-analysis', {run_id: 'different-run', profile_id: 'frozen'}); await settle();
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 0);
});

test('transient failure resumes the same immutable job, while a fresh-snapshot error gives useful guidance without Resume', async () => {
  const h = harness({jobs: [retained('failed', {error: {message: 'Connection failed.', corrective_action: 'Resume this retained publication.'}})]}); await settle();
  assert.match(h.main.innerHTML, /Connection failed/);
  assert.match(h.main.innerHTML, /Resume publication/);
  h.click('resume-publication'); await settle();
  assert.equal(h.requests.find(item => item.method === 'POST').url, `/tree-targeting/api/analysis/publication/${jobId}/start`);
  const stale = harness({jobs: [retained('failed', {error: {message: 'The inventory changed.', requiresNewSnapshot: true,
    corrective_action: 'Import the latest series bundle and prepare a new publication.'}})]}); await settle();
  assert.match(stale.main.innerHTML, /Import the latest series bundle/);
  assert.match(stale.main.innerHTML, /Prepare publication/);
  assert.doesNotMatch(stale.main.innerHTML, />Resume publication</);
  stale.click('resume-publication'); await settle();
  assert.equal(stale.requests.filter(item => item.method === 'POST').length, 0);
});

test('polling a retained failed job with its nested error unlocks controls and resumes the same publication', async () => {
  const h = harness({jobs: [retained('uploading', {progress: {stage: 'Retrying publication', completed: 1, total: 4}})]});
  await settle();
  assert.match(h.main.innerHTML, /Other controls are unavailable/);
  h.jobs([retained('failed', {progress: {stage: 'Retrying publication', completed: 1, total: 4},
    error: {operation: 'publication', code: 'publication_failed', message: 'Publication storage could not complete the operation.',
      corrective_action: 'Resume the same retained publication after resolving the failure.'}})]);
  await h.poll();
  assert.match(h.main.innerHTML, /Publication failed/);
  assert.match(h.main.innerHTML, /Resume publication/);
  assert.match(h.elements.get('error').innerHTML, /Publication storage could not complete the operation/);
  assert.doesNotMatch(h.main.innerHTML, /Other controls are unavailable/);
  assert.deepEqual(h.warnings, []);
  h.click('resume-publication'); await settle();
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(h.requests.find(item => item.method === 'POST').url, `/tree-targeting/api/analysis/publication/${jobId}/start`);
});

test('publication job reads still reject HTTP failures, error envelopes and mismatching job identities', async () => {
  const details = {operation: 'publication', message: 'Actual request failure.'};
  const failed = retained('failed', {error: details});
  for (const [path, value, status] of [
    [`/api/publication/${jobId}`, failed, 503],
    [`/api/publication/${jobId}`, {error: details}, 200],
    [`/api/publication/${jobId}`, {...failed, jobId: 'other-job'}, 200],
    ['/api/progress', failed, 200],
  ]) {
    const request = createTransport(async () => Response.json(value, {status}));
    await assert.rejects(request(path), error => {
      assert.equal(error.definitive, true);
      assert.equal(error.operation, details.operation);
      assert.match(error.message, /Actual request failure/);
      return true;
    });
  }
});

test('wrong-series publication jobs are never rendered or started for the selected series', async () => {
  const h = harness({jobs: [retained('prepared', {seriesId: 'other-series', fileCount: 987})]}); await settle();
  assert.doesNotMatch(h.main.innerHTML, /987 files/);
  assert.doesNotMatch(h.main.innerHTML, new RegExp(`data-job-id="${jobId}"`));
  h.click('publish-publication'); await settle();
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 0);
});

test('completed publication shows fixed Results and Videos links without silently publishing again', async () => {
  const resultsUrl = `https://test.lab.sourceof.love/studies/tree-targeting/public/results?publication=${jobId}`;
  const recordingsUrl = `https://test.lab.sourceof.love/studies/tree-targeting/public/recordings?publication=${jobId}`;
  const h = harness({jobs: [retained('completed', {resultsUrl, recordingsUrl})]}); await settle(); await h.poll();
  assert.ok(h.main.innerHTML.includes(resultsUrl)); assert.ok(h.main.innerHTML.includes(recordingsUrl));
  assert.match(h.main.innerHTML, /Publication completed/);
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 0);
});

test('a failed initial preparation cannot resume directly into publishing before its file summary was reviewed', async () => {
  const h = harness({jobs: [retained('failed', {fileCount: null, uploadBytes: null, inventory: null,
    error: {message: 'Viewing conversion failed.', corrective_action: 'Resolve the media failure and prepare again.'}})]});
  await settle();
  assert.match(h.main.innerHTML, /Preparation did not finish/);
  assert.match(h.main.innerHTML, /Prepare publication/);
  assert.doesNotMatch(h.main.innerHTML, />Resume publication</);
  h.click('resume-publication'); await settle();
  assert.equal(h.requests.filter(item => item.method === 'POST').length, 0);
});


test('the local Mac points outward to the canonical field app and keeps its local analysis route', async () => {
  const h = harness(); await settle();
  assert.match(h.navigation.innerHTML, /href="https:\/\/test\.lab\.sourceof\.love\/studies\/targeted-vegetation-movement\/app\/"/);
  assert.match(h.navigation.innerHTML, /href="\/tree-targeting\/analysis\/" aria-current="page"/);
  assert.ok(h.requests.every(request => request.url.startsWith('/tree-targeting/api/analysis/')));
});

test('a canonical completed publication retains its selected result links without another upload', async () => {
  const resultsUrl = 'https://test.lab.sourceof.love/studies/targeted-vegetation-movement/public/results?publication=' + jobId;
  const recordingsUrl = 'https://test.lab.sourceof.love/studies/targeted-vegetation-movement/public/recordings?publication=' + jobId;
  const h = harness({jobs: [retained('completed', {resultsUrl, recordingsUrl})]}); await settle(); await h.poll();
  assert.ok(h.main.innerHTML.includes(resultsUrl)); assert.ok(h.main.innerHTML.includes(recordingsUrl));
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 0);
});
