import assert from 'node:assert/strict';
import test from 'node:test';
import {renderMacAnalysisPage} from '../../web/views.mjs';
import {restoreMacFormDrafts} from '../../web/app.mjs';

const profile = {profileId: 'tree-development-1', label: 'Development profile',
  sealedProfileJson: JSON.stringify({video: {featureDetection: {maxCorners: 3000},
    tracking: {windowSizePixels: [41, 41]}}})};

function macPage(selectedVideoRecordingId, videos) {
  const detail = {runId: 'tree-1', mode: 'tree', purpose: 'preparation',
    recordings: Object.fromEntries(videos.map(video => [video.recordingId, video])),
    timeMaps: []};
  const before = structuredClone(detail);
  const html = renderMacAnalysisPage({runs: [{runId: 'tree-1', mode: 'tree', purpose: 'preparation'}],
    selectedRunId: 'tree-1', detail, selectedVideoRecordingId, profiles: [profile],
    selectedProfileId: profile.profileId});
  assert.deepEqual(detail, before);
  return html;
}

function annotationForm(html) {
  const form = html.match(/<form data-analysis-form="export-annotated-clip">([\s\S]*?)<\/form>/)?.[1];
  assert.ok(form, 'annotated export form is visible');
  return form;
}

test('selected camera duration defaults to its complete fractional endpoint and updates on video selection', () => {
  const videos = [
    {recordingId: 'first', name: 'First camera', kind: 'video', videoEndSeconds: 321.48,
      clockMap: {references: [{frameIndex: 0}, {frameIndex: 10}]}, timeMapId: 'clock-first'},
    {recordingId: 'second', name: 'Second camera', kind: 'video', videoEndSeconds: 12.25},
  ];
  const firstPage = macPage('first', videos);
  const first = annotationForm(firstPage);
  assert.match(first, /name="start_seconds" type="number" value="0"[^>]*step="any"[^>]*min="0"[^>]*max="321\.48"/);
  assert.match(first, /name="duration_seconds" type="number" value="321\.48"[^>]*step="any"[^>]*max="321\.48"/);
  assert.match(firstPage, /321\.48 seconds available/);
  assert.match(first, /Export annotated video/);

  const secondPage = macPage('second', videos);
  const second = annotationForm(secondPage);
  assert.match(second, /name="start_seconds" type="number" value="0"[^>]*max="12\.25"/);
  assert.match(second, /name="duration_seconds" type="number" value="12\.25"[^>]*step="any"[^>]*max="12\.25"/);
  assert.match(secondPage, /12\.25 seconds available/);
  assert.match(second, /option value="second" selected>Second camera<\/option>/);
  assert.match(secondPage, /name="profile_id"[^>]*>[\s\S]*?option value="tree-development-1" selected/);
});

test('shorter export draft survives refresh but resets to new video duration on selection', () => {
  const start = {name: 'start_seconds', type: 'number', value: '0'};
  const duration = {name: 'duration_seconds', type: 'number', value: '12.25'};
  const clockFrame = {name: 'before_frame', type: 'number', value: '10'};
  const profileChoice = {name: 'profile_id', type: 'select-one', value: profile.profileId};
  const forms = [{elements: [start, duration]}, {elements: [clockFrame]}, {elements: [profileChoice]}];
  const snapshot = [
    {formName: 'export-annotated-clip', fields: [
      {name: 'start_seconds', type: 'number', value: '3.125'},
      {name: 'duration_seconds', type: 'number', value: '4.5'}]},
    {formName: 'save-time-map', fields: [{name: 'before_frame', type: 'number', value: '310'}]},
    {formName: 'start-analysis', fields: [{name: 'profile_id', type: 'select-one', value: 'old-profile'}]},
  ];
  restoreMacFormDrafts(forms, snapshot);
  assert.equal(start.value, '3.125');
  assert.equal(duration.value, '4.5');
  assert.equal(profileChoice.value, profile.profileId);

  start.value = '0';
  duration.value = '12.25';
  restoreMacFormDrafts(forms, snapshot, {resetVideoForms: true});
  assert.equal(start.value, '0');
  assert.equal(duration.value, '12.25');
  assert.equal(clockFrame.value, '310');
  assert.equal(profileChoice.value, profile.profileId);
});
