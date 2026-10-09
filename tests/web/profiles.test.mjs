import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {profileFromFields, persistChangedProfileSelection, startMacAnalysisApplication} from '../../web/app.mjs';
import {renderMacAnalysisPage} from '../../web/views.mjs';
const saved = JSON.parse(fs.readFileSync(new URL('../../analysis-profile.json', import.meta.url)));
const area = JSON.parse(fs.readFileSync(new URL('../../analysis-profile-area.json', import.meta.url)));

test('Mac controls create a new full profile and retain advanced settings', () => {
  const changed = profileFromFields(saved, {profile_name: 'Tree 2000/31', maximum_points: '2000', window_width: '31'}, 'tree-2000-31');
  assert.equal(changed.profileId, 'tree-2000-31');
  assert.equal(changed.video.featureDetection.maxCorners, 2000);
  assert.deepEqual(changed.video.tracking.windowSizePixels, [31, 31]);
  assert.equal(changed.video.tracking.maximumForwardBackwardErrorPixels, saved.video.tracking.maximumForwardBackwardErrorPixels);
  assert.equal(saved.video.featureDetection.maxCorners, 3000);
});
for (const [points, width] of [['0','31'], ['2000','30'], ['2.5','31'], ['NaN','31']]) {
  test(`invalid profile settings ${points}/${width} are visible errors`, () => {
    assert.throws(() => profileFromFields(saved, {profile_name: 'New settings', maximum_points: points, window_width: width}), /integer|odd|points/);
  });
}

test('a friendly profile name is saved independently of its internal identifier', () => {
  const profile = profileFromFields(saved, {
    profile_name: 'Tree 6000/21 - mean-track analysis', maximum_points: '6000', window_width: '21',
  }, 'tree-generated-id');
  assert.equal(profile.profileId, 'tree-generated-id');
  assert.equal(profile.label, 'Tree 6000/21 - mean-track analysis');
});

test('blank profile names have a useful error', () => {
  assert.throws(() => profileFromFields(saved, {
    profile_name: '   ', maximum_points: '6000', window_width: '21',
  }, 'tree-generated-id'), /Enter a profile name/);
});

test('grid profile form saves exact spatial and common tracking settings', () => {
  const changed = profileFromFields(area, {profile_name: 'Continuous canopy', window_width: '31',
    min_distance: '9', feature_strength: '0.02', cell_size: '96', points_per_cell: '24',
    minimum_tracks_per_cell: '4', spatial_coverage: '0.98', refresh_policy: 'continuous'}, 'grid-copy');
  assert.deepEqual(changed.video.measurement, {method: 'area-grid-mean-v1', cellSizePixels: 96,
    pointsPerCell: 24, minimumTracksPerCell: 4, minimumSpatialCoverageFraction: .98,
    refreshPolicy: 'continuous'});
  assert.equal(changed.video.featureDetection.minDistancePixels, 9);
  assert.equal(changed.video.featureDetection.qualityLevel, .02);
  assert.deepEqual(changed.video.tracking.windowSizePixels, [31, 31]);
  assert.equal(area.video.measurement.refreshPolicy, 'timed');
  assert.throws(() => profileFromFields(area, {profile_name: 'Bad', window_width: '31',
    cell_size: '96', points_per_cell: '3', minimum_tracks_per_cell: '4',
    spatial_coverage: '0.98', refresh_policy: 'continuous'}, 'invalid'), /tracks|points/i);
});

test('preparation controls show method-specific settings and fixed saved constants', () => {
  const profiles = [saved, area].map(profile => ({profileId: profile.profileId,
    label: profile.profileId, sealedProfileJson: JSON.stringify(profile)}));
  const run = {runId: 'tree-1', mode: 'tree', purpose: 'preparation', analyses: {}};
  const html = renderMacAnalysisPage({runs: [run], detail: run, selectedRunId: 'tree-1', profiles,
    selectedProfileId: area.profileId});
  assert.match(html, /Cell size \(pixels\)/);
  assert.match(html, /Minimum accepted tracks per full cell/);
  assert.match(html, /Boundary-cell point budgets and minimum track counts scale with the selected region area/);
  assert.match(html, /Continuous, retain valid tracks within each cell budget and fill deficits/);
  assert.match(html, /Refresh policy/);
  assert.match(html, /Feature strength/);
  assert.match(html, /Minimum spacing/);
  assert.match(html, /solver.*timing.*shake/i);
  assert.doesNotMatch(html, /name="maximum_points"/);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
async function profileFormHarness(saveResponse) {
  const elements = new Map(), requests = [];
  const element = () => ({hidden: false, innerHTML: '', textContent: '', listeners: new Map(),
    addEventListener(kind, callback) { this.listeners.set(kind, callback); },
    querySelector() { return null; }, querySelectorAll() { return []; }});
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }, querySelector: element};
  class Form {
    constructor(kind, fields) { this.dataset = {analysisForm: kind}; this.fields = fields; }
    reportValidity() { return true; }
  }
  const record = profile => ({profileId: profile.profileId, label: profile.label ?? profile.profileId, sealedProfileJson: JSON.stringify(profile)});
  const profiles = [record(saved)];
  const annotationJobs = [];
  const run = {runId: 'retained-run', mode: 'tree', purpose: 'preparation', selectedProfileId: saved.profileId};
  const window = {HTMLFormElement: Form,
    FormData: class extends Map { constructor(form) { super(Object.entries(form.fields)); } },
    crypto: globalThis.crypto, setInterval() { return 1; }, clearInterval() {},
    async fetch(url, options) {
      const body = options?.body ? JSON.parse(options.body) : null;
      requests.push({url, body});
      let value;
      if (url.endsWith('/save-profile')) {
        const response = await saveResponse(body);
        if (response.ok) {
          profiles.push(record(body.profile)); run.selectedProfileId = body.profile.profileId;
        }
        return response;
      }
      if (url.endsWith('/runs')) value = {runs: [run]};
      else if (url.endsWith('/runs/retained-run')) value = run;
      else if (url.endsWith('/series')) value = {report: null};
      else if (url.endsWith('/profiles')) value = {profiles};
      else if (url.endsWith('/annotations')) value = {jobs: annotationJobs};
      else if (url.endsWith('/publication')) value = {jobs: []};
      else if (url.endsWith('/comparison-candidates')) value = {runs: [], profiles};
      else if (url.endsWith('/comparisons')) value = {comparisons: []};
      else if (url.endsWith('/setup-clip')) value = {};
      else throw new Error(`Unexpected route ${url}`);
      return new Response(JSON.stringify(value));
    }};
  const application = startMacAnalysisApplication(document, window);
  const main = elements.get('main');
  function submit(kind, fields) {
    main.listeners.get('submit')({target: new Form(kind, fields), preventDefault() {}});
  }
  await settle(); await settle();
  submit('select-run', {run_id: run.runId});
  await settle(); await settle();
  return {application, main, elements, requests, submit, run, annotationJobs,
    settings() {
      const section = main.innerHTML.match(/<details([^>]*)><summary>Preparation motion settings<\/summary>([\s\S]*?)<\/details>/);
      assert.ok(section, 'Preparation motion settings are available');
      return {attributes: section[1], html: section[2]};
    }};
}

test('an invalid profile save keeps settings open and displays a dismissible alert', async () => {
  const app = await profileFormHarness(() => { throw new Error('Invalid settings must not reach the server'); });
  assert.match(app.settings().html, /Profile name/);
  app.submit('save-profile', {profile_name: 'Tree 6000/21 - mean-track analysis', maximum_points: '6000', window_width: '20'});
  await settle();
  assert.match(app.settings().attributes, /\bopen\b/);
  const error = app.elements.get('error');
  assert.equal(error.hidden, false);
  assert.match(error.innerHTML, /positive odd integer/);
  assert.match(error.innerHTML, /Dismiss/);
  assert.equal(app.requests.filter(request => request.url.endsWith('/save-profile')).length, 0);
  await app.application.refresh();
  assert.equal(error.hidden, false, 'polling must not hide the error');
  error.listeners.get('click')({target: {closest: () => ({dataset: {dismissMacError: ''}})}});
  assert.equal(error.hidden, true);
});

test('profile saving shows pending status then confirms the selected friendly name', async () => {
  let finishSave;
  const app = await profileFormHarness(body => new Promise(resolve => {
    finishSave = () => resolve(new Response(JSON.stringify({profile: body.profile})));
  }));
  app.submit('save-profile', {profile_name: 'Tree 6000/21 - mean-track analysis', maximum_points: '6000', window_width: '21'});
  assert.match(app.settings().attributes, /\bopen\b/);
  assert.match(app.settings().html, /<button[^>]*disabled[^>]*>Save as new profile/);
  assert.match(app.main.innerHTML, /Saving the new analysis profile/);
  await settle(); finishSave(); await settle(); await settle();
  assert.match(app.settings().attributes, /\bopen\b/);
  assert.match(app.elements.get('notice').textContent, /Tree 6000\/21 - mean-track analysis.*saved and selected/);
  const body = app.requests.find(request => request.url.endsWith('/save-profile')).body;
  assert.equal(body.runId, 'retained-run');
  assert.match(body.profile.profileId, /^tree-[a-f0-9-]{36}$/);
  assert.equal(body.profile.label, 'Tree 6000/21 - mean-track analysis');
  assert.equal(body.profile.video.featureDetection.maxCorners, 6000);
  assert.deepEqual(body.profile.video.tracking.windowSizePixels, [21, 21]);
  assert.ok(app.main.innerHTML.includes(`<option value="${body.profile.profileId}" selected>`));
});

test('a rejected save shows the server error and enables retry without hiding the settings', async () => {
  const app = await profileFormHarness(() => new Response(JSON.stringify({error: {message: 'The profile could not be stored.'}}), {status: 400}));
  app.submit('save-profile', {profile_name: 'My settings', maximum_points: '6000', window_width: '21'});
  await settle(); await settle();
  assert.match(app.settings().attributes, /\bopen\b/);
  assert.match(app.settings().html, /<button type="submit">Save as new profile<\/button>/);
  assert.match(app.elements.get('error').innerHTML, /The profile could not be stored/);
  assert.equal(app.elements.get('error').hidden, false);
});

for (const kind of ['analysis', 'annotation']) for (const observedRunning of [true, false]) {
  test(`a failed background ${kind} is announced with observed running state ${observedRunning}`, async () => {
    const app = await profileFormHarness(() => { throw new Error('No save expected'); });
    const job = {analysisId: 'job-one', jobId: 'job-one', runId: app.run.runId, status: 'running'};
    if (kind === 'analysis') app.run.analyses = {'job-one': job};
    else app.annotationJobs.push(job);
    if (observedRunning) await app.application.refresh();
    job.status = 'failed'; job.error = {message: 'The original video could not be decoded.'};
    await app.application.refresh();
    assert.equal(app.elements.get('error').hidden, false);
    assert.match(app.elements.get('error').innerHTML, /original video could not be decoded/);
    const error = app.elements.get('error');
    error.listeners.get('click')({target: {closest: () => ({dataset: {dismissMacError: ''}})}});
    await app.application.refresh();
    assert.equal(error.hidden, true, 'the same retained failure must not reappear after dismissal');
  });
}

const profileControl = (tagName, formName, value) => ({tagName, name: 'profile_id', value, closest: () => ({dataset: {analysisForm: formName}})});
test('drafting a new profile performs no selection mutation before Save', async () => {
  const selected = [];
  assert.equal(await persistChangedProfileSelection(profileControl('INPUT', 'save-profile', 'draft-profile'), id => selected.push(id)), false);
  assert.deepEqual(selected, []);
  assert.equal(await persistChangedProfileSelection(profileControl('SELECT', 'start-analysis', 'saved-profile'), id => selected.push(id)), true);
  assert.deepEqual(selected, ['saved-profile']);
});

test('draft restoration preserves the authoritative selected profile and refreshes its actual settings', async()=>{
  const {restoreMacFormDrafts}=await import('../../web/app.mjs');
  const selected={name:'profile_id',type:'select-one',value:'new-profile'};
  const identifier={name:'profile_id',type:'text',value:''};
  const points={name:'maximum_points',type:'number',value:'1500'};
  const forms=[{elements:[selected]},{elements:[identifier,points]}];
  const snapshot=[{formName:'start-analysis',fields:[{name:'profile_id',type:'select-one',value:'tree-development-1'}]},
    {formName:'save-profile',fields:[{name:'profile_id',type:'text',value:'draft'},{name:'maximum_points',type:'number',value:'2000'}]}];
  restoreMacFormDrafts(forms,snapshot,{profileChanged:true});
  assert.equal(selected.value,'new-profile');assert.equal(points.value,'1500');assert.equal(identifier.value,'');
  restoreMacFormDrafts(forms,snapshot,{profileChanged:false});
  assert.equal(selected.value,'new-profile');assert.equal(identifier.value,'draft');assert.equal(points.value,'2000');
});

test('a newly saved clock mapping replaces stale clock fields without clearing other drafts', async () => {
  const {restoreMacFormDrafts} = await import('../../web/app.mjs');
  const frame = {name: 'before_frame', type: 'number', value: '310'};
  const timestamp = {name: 'before_server', type: 'text', value: '2026-09-25T15:16:47.365Z'};
  const uncertainty = {name: 'before_clock_uncertainty', type: 'number', value: '30.5'};
  const review = {name: 'spans', type: 'textarea', value: ''};
  const forms = [{elements: [frame, timestamp, uncertainty]}, {elements: [review]}];
  const snapshot = [
    {formName: 'save-time-map', fields: [
      {name: 'before_frame', type: 'number', value: '0'},
      {name: 'before_server', type: 'text', value: ''},
      {name: 'before_clock_uncertainty', type: 'number', value: ''},
    ]},
    {formName: 'save-obstruction-review', fields: [{name: 'spans', type: 'textarea', value: '150, 180'}]},
  ];
  restoreMacFormDrafts(forms, snapshot, {clockMapChanged: true});
  assert.equal(frame.value, '310');
  assert.equal(timestamp.value, '2026-09-25T15:16:47.365Z');
  assert.equal(uncertainty.value, '30.5');
  assert.equal(review.value, '150, 180');

  restoreMacFormDrafts(forms, snapshot, {clockMapChanged: false});
  assert.equal(frame.value, '0');
  assert.equal(timestamp.value, '');
  assert.equal(uncertainty.value, '');
});
