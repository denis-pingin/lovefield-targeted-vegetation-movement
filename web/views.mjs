import {STUDY_NAME, HOSTED_APP_BASE, HOSTED_API_BASE, LOCAL_ANALYSIS_BASE} from './study-paths.mjs';
import {EXPERIMENT, validateConfig} from './run-config.mjs';
import {renderTreeResults} from './tree-results.mjs';
import {renderComparisonSection} from './tree-comparisons.mjs';

export const PAGES = ['study', 'setup', 'tree', 'history', 'clock', 'series', 'recordings', 'results'];
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const humanize = value => String(value).replaceAll('_', ' ').replaceAll('-', ' ');
const selected = (value, current) => String(value) === String(current) ? ' selected' : '';
const checked = value => value ? ' checked' : '';
const unavailable = value => value ? ' disabled' : '';
let fieldSequence = 0;
const fieldId = name => `${name.replaceAll('.', '-')}-${++fieldSequence}`;
const options = (values, current) => values.map(value => {
  const [key, label] = Array.isArray(value) ? value : [value, value];
  return `<option value="${escapeHtml(key)}"${selected(key, current)}>${escapeHtml(label)}</option>`;
}).join('');

function field(label, name, value = '', {type = 'text', help = '', required = false, step = 'any', min = null, max = null} = {}) {
  const id = fieldId(name);
  return `<div class="field"><label for="${id}">${escapeHtml(label)}</label><input id="${id}" name="${name}" type="${type}" value="${escapeHtml(value)}"${required ? ' required' : ''}${type === 'number' ? ` step="${step}"${min === null ? '' : ` min="${escapeHtml(min)}"`}${max === null ? '' : ` max="${escapeHtml(max)}"`}` : ''}${help ? ` aria-describedby="${id}-help"` : ''}>${help ? `<p class="field-help" id="${id}-help">${escapeHtml(help)}</p>` : ''}</div>`;
}
const noteField = (label, name, value = '', help = '', {required = false} = {}) => { const id = fieldId(name); return `<div class="field"><label for="${id}">${escapeHtml(label)}</label><textarea id="${id}" name="${name}" rows="3"${required ? ' required' : ''}>${escapeHtml(value)}</textarea>${help ? `<p class="field-help">${escapeHtml(help)}</p>` : ''}</div>`; };
const selectField = (label, name, values, current) => { const id = fieldId(name); return `<div class="field"><label for="${id}">${escapeHtml(label)}</label><select id="${id}" name="${name}">${options(values, current)}</select></div>`; };
const checkbox = (label, name, value = false, required = false) => `<label class="check"><input type="checkbox" name="${name}"${checked(value)}${required ? ' required' : ''}> <span>${escapeHtml(label)}</span></label>`;

function actionButton(model, action, label, {primary = false, busy = false} = {}) {
  const item = model.actions[action];
  return `<button type="button" data-action="${action}" class="${primary ? 'primary' : 'secondary'}"${unavailable(!item.enabled || busy)} aria-describedby="reason-${action}">${label}</button><p class="field-help action-reason" id="reason-${action}">${escapeHtml(item.reason)}</p>`;
}

function pageTitle(eyebrow, title, description) {
  return `<header class="page-heading"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="intro">${escapeHtml(description)}</p></header>`;
}

function qualityList(issues) {
  if (!issues?.length) return '';
  return `<ul class="quality-issues">${issues.map(issue => `<li>${escapeHtml(typeof issue === 'string' ? issue : `${issue.recording_id ?? ''}: ${issue.message ?? issue.reason ?? 'Quality issue'}`)}</li>`).join('')}</ul>`;
}

export function detailsTable(value, caption = 'Retained details') {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return `<p>${escapeHtml(value)}</p>`;
  const entries = Array.isArray(value) ? value.map((item, index) => [index + 1, item]) : Object.entries(value);
  return `<details class="retained-details"><summary>${escapeHtml(caption)}</summary><dl>${entries.map(([key, item]) => `<div><dt>${escapeHtml(humanize(key))}</dt><dd>${item !== null && typeof item === 'object' ? detailsTable(item, Array.isArray(item) ? `${item.length} retained entries` : 'View values') : escapeHtml(item ?? 'Not recorded')}</dd></div>`).join('')}</dl></details>`;
}

const resultReasonLabels = {
  primary_probability_threshold_not_reached: 'The exact randomization probability did not meet the predefined threshold.',
  primary_evidence_threshold_not_reached: 'The evidence score did not reach the predefined threshold.',
  positive_direction_not_present_in_every_visit_and_shift: 'Wind dynamics were not higher during active practice in every visit and timing check.',
  positive_direction_not_present_for_every_required_comparison_and_shift: 'The required direction was not present in every comparison and timing check.',
  two_complete_global_visits_required: 'The global comparison requires two complete visits.',
  incomplete_global_collection: 'The planned global recordings were not completed.',
  all_eight_unique_candidate_schedules_required: 'All eight possible schedules must be checked for each global visit.',
  unquantifiable_candidate_window: 'At least one possible schedule includes a window that could not be measured reliably.',
  incomplete_planned_count: 'The planned number of comparisons was not completed.',
  incomplete_per_visit_collection: 'At least one visit is missing planned local comparisons.',
  unquantifiable_assigned_outcome: 'One or more assigned comparisons could not be measured reliably.',
  missing_assigned_measurement: 'A disclosed assignment has no retained measurement.',
  invalid_or_nonchronological_assignment_identity: 'The retained assignment identities are invalid or out of order.',
  duplicate_trial_identity: 'The same comparison identity appears more than once.',
  invalid_negative_magnitude: 'A wind-change magnitude is invalid because it is negative.',
  missing_frozen_setup_scale: 'The fixed setup reference values needed for evaluation are missing.',
  global_cue_onset_not_verified: 'The actual audible onset of one or more global cues has not been verified.',
  audible_onset_not_verified: 'Actual command and release onsets still need verification from the recording.',
  unverified_audible_timing: 'Actual command and release onsets still need verification from the recording.',
  global_cue_delivery_outside_qualification: 'A global cue was delivered outside the qualified timing tolerance.',
  cue_delivery_outside_qualification: 'A cue was delivered outside the qualified timing tolerance.',
  playback_time_unqualified: 'Playback time unqualified: a server receipt or unmeasured timestamp cannot qualify scored timing.',
  playback_clock_reference_missing: 'Playback clock reference missing: retain the instruction phone\'s measured clock exchange with the run.',
  playback_clock_reference_mismatch: 'The playback timestamp does not match its retained instruction-phone clock measurement.',
  playback_alignment_uncertainty_exceeds_limit: 'Combined recording and playback clock uncertainty exceeds the scored timing limit.',
  release_before_response_end: 'The release cue occurred before the response window ended.',
  operator_stop: 'The operator stopped the session; its assigned comparisons and limitations are retained.',
  missing_seconds: 'The recording is missing required one-second measurements.',
  duplicate_seconds: 'The recording contains more than one measurement for a required second.',
  outside_clock_references: 'Measurements fall outside the retained clock-reference interval.',
  module_group_not_evaluated: 'This module group has not been evaluated yet.',
};

function resultReason(reason) {
  return Object.hasOwn(resultReasonLabels, reason) ? resultReasonLabels[reason] : humanize(reason);
}

export function renderPage(page, context) {
  fieldSequence = 0;
  return renderHostedPage(page, context);
}

const modeName = mode => ({global: 'Global', local: 'Local', tree: 'Tree'}[mode] ?? humanize(mode));
const purposeName = purpose => purpose === 'scored' ? 'Scored' : 'Preparation';

function hostedSettings(config, sites = [], series = []) {
  return `<input type="hidden" name="mode" value="tree"><input type="hidden" name="purpose" value="preparation">${selectField('Saved site', 'site_id', [['', 'No saved site'], ...sites.map(site => [site.siteId, site.label])], config.siteId ?? '')}${selectField('Preparation series', 'series_id', [['', 'Independent preparation recording'], ...series.filter(item => item.status === 'open').map(item => [item.seriesId, item.label])], config.seriesId ?? '')}
    <details class="panel" open><summary>Tree targets</summary><div class="form-grid">${field('Absent pre-roll before Approach (seconds)', 'tree_pre_roll', config.tree.preRollSeconds, {type: 'number', min: .01})}${field('Response per target (seconds)', 'tree_response', config.tree.responseSeconds, {type: 'number', min: .01})}${field('Recovery between targets (seconds)', 'tree_recovery', config.tree.recoverySeconds, {type: 'number', min: 0})}${field('Absent post-roll after Away (seconds)', 'tree_post_roll', config.tree.postRollSeconds, {type: 'number', min: .01})}${field('Planned targets', 'tree_count', config.tree.count, {type: 'number', min: 1, step: 1})}</div><input type="hidden" name="tree_release" value="">${checkbox('Announce release when recovery is used', 'tree_release', config.tree.announceRelease)}</details>`;
}

const hostedPhaseNames = {
  ABSENT: 'Practitioner absent', APPROACH: 'Approach', PASSIVE: 'Passive presence',
  ACTIVE: 'Active practice', DEPARTURE: 'Departure', SETTLEMENT: 'Settlement',
  LOCAL_RUNNING: 'Local comparisons', TREE_RESPONSE: 'Tree target response',
  TREE_RECOVERY: 'Recovery between tree targets', TREE_WAIT_CUE: 'Next tree target pending',
  TREE_WAIT_RELEASE: 'Finishing response announcement',
  TREE_PREROLL: 'Absent pre-roll', TREE_WAIT_APPROACH: 'Approach cue pending',
  TREE_APPROACH: 'Approach', TREE_WAIT_DEPART: 'Departure cue pending',
  TREE_DEPARTURE: 'Departure', TREE_POSTROLL: 'Absent post-roll',
};

const hostedPhaseInstruction = {
  ABSENT: 'Record absent baseline', APPROACH: 'Approach the practice position',
  PASSIVE: 'Passive presence - read the printed material',
  ACTIVE: 'Continue active practice', DEPARTURE: 'Leave the site',
  SETTLEMENT: 'Record settlement while away', LOCAL_RUNNING: 'Continue practice',
  TREE_RECOVERY: 'Recovery between tree targets', TREE_WAIT_CUE: 'Wait for the next tree target',
  TREE_WAIT_RELEASE: 'Wait for the response-end announcement',
  TREE_PREROLL: 'Record absent pre-roll', TREE_WAIT_APPROACH: 'Wait for the Approach cue',
  TREE_APPROACH: 'Approach the tree position', TREE_WAIT_DEPART: 'Wait for the departure cue',
  TREE_DEPARTURE: 'Leave the tree area', TREE_POSTROLL: 'Record absent post-roll',
};

function hostedCurrentAction(model, busy) {
  if (!model.runId) return '<section class="panel cue-panel"><p class="eyebrow">Start here</p><h2>Create or open a Tree run</h2><p>Choose the settings for a new Tree run or open a saved run. Each run keeps its own configuration and outcome.</p></section>';
  const instruction = model.currentInstruction || (model.lifecycle === 'draft' ? 'Prepare this run' : model.lifecycle === 'prepared' ? 'Confirm recording, then Start' : model.lifecycle === 'failed' ? 'Run failed' : model.lifecycle === 'stopped' ? 'Run stopped' : model.terminal ? 'Run finished' : hostedPhaseInstruction[model.phase] ?? 'Check the current run state');
  const phaseName = hostedPhaseNames[model.phase] ?? model.phase;
  return `<section class="panel cue-panel"><p class="eyebrow">Current phase · ${escapeHtml(modeName(model.mode))} · ${escapeHtml(phaseName)}</p><h2 id="current-cue" aria-live="polite">${escapeHtml(instruction)}</h2><p>${model.completedCount} ${model.mode === 'tree' ? 'targets' : 'comparisons'} completed. ${escapeHtml(model.lastError)}</p>${model.terminal ? '' : model.mode !== 'tree' ? hostedActionButton(model, 'ready', 'Ready', true, busy) : '<p class="field-help">Targets continue automatically until the planned count is complete.</p>'}</section>`;
}

function hostedActionButton(model, action, label, primary = false, busy = false) {
  const item = model.actions[action] ?? {enabled: false, reason: 'Unavailable in this phase.'};
  const error = model.actionError?.action === action ? model.actionError.message : null;
  return `<div class="action-control"><button type="button" data-hosted-action="${action}" class="${primary ? 'primary' : 'secondary'}"${unavailable(busy || !item.enabled)} aria-describedby="hosted-${action}-reason">${escapeHtml(label)}</button><p class="field-help action-reason${error ? ' error-text' : ''}" id="hosted-${action}-reason"${error ? ' role="alert"' : ''}>${escapeHtml(error ?? item.reason)}</p></div>`;
}

function hostedStudyPage({model, runs = [], sites = [], config, series = [], busy}) {
  return pageTitle(STUDY_NAME, 'Current action', 'The instruction phone and helper open the same run. The camera records separately. Test collection is preparation only.')
    + hostedCurrentAction(model, busy)
    + `<section class="panel"><h2>New preparation run</h2><form data-hosted-form="create-run"><fieldset${unavailable(busy)}>${field('Run tag (optional)', 'tag', '', {help: 'A short label for finding this run. Its permanent ID remains unchanged.'})}${hostedSettings(config, sites, series)}<button class="primary" type="submit">Save new run</button></fieldset></form><p class="field-help">Repeat from History copies settings into a new run. Preparation settings may vary between saved recordings; results remain exploratory.</p></section>`
    + `<section class="panel"><h2>Current run</h2>${model.runId ? `<p><strong>${escapeHtml(model.tag ? `${model.tag} · ${model.runId}` : model.runId)}</strong> · ${escapeHtml(purposeName(model.purpose))} ${escapeHtml(modeName(model.mode))} · ${escapeHtml(model.lifecycle)}</p><div class="button-row"><a href="#${escapeHtml(model.mode)}">Open ${escapeHtml(modeName(model.mode))}</a><a href="#history">History and other devices</a></div>` : '<p class="empty-state">No run selected on this device.</p>'}${runs.length ? `<p>${runs.length} saved runs.</p>` : ''}</section>`;
}

function hostedRunControls(model, busy, clockDisplay) {
  if (!model.runId) return '<p class="empty-state">Open a run from History or create one on Study.</p>';
  const prepared = model.lifecycle === 'prepared';
  const pending = model.startRegistration?.status === 'pending';
  const actions = model.lifecycle === 'draft'
    ? hostedActionButton(model, 'designatePlayback', 'Use this phone for instructions', false, busy) + hostedActionButton(model, 'prepare', 'Prepare run', false, busy)
    : prepared ? hostedActionButton(model, 'designatePlayback', 'Use this phone for instructions', false, busy) + (pending ? hostedActionButton(model, 'stop', 'Stop and retain run', false, false) : '')
      : model.running ? hostedActionButton(model, 'stop', 'Stop and retain run', false, busy) : '';
  const registrationStatus = pending ? model.terminal
    ? '<p role="status">Start registration is pending; the sequence is stopped. Retain the recording and retry the saved Start to recover registration without restarting timing.</p>'
    : '<p role="status">Start registration is pending. Keep the camera recording running. Retry the saved Start to recover the same transaction, or stop this sequence.</p>'
    : model.startRegistration?.status === 'failed' ? `<p class="error-text" role="status">${escapeHtml(model.startRegistration.error?.message ?? 'Start registration failed before a confirmed start. Retry after resolving the error.')}</p>`
      : model.startRegistration?.status === 'confirmed' ? `<p>Start registration confirmed in block ${escapeHtml(model.startRegistration.registration?.blockNumber)}.</p>` : '';
  return `<section class="panel"><h2>Run controls</h2>${model.tag ? `<p><strong>${escapeHtml(model.tag)}</strong> · ${escapeHtml(model.runId)}</p>` : ''}<p>${escapeHtml(purposeName(model.purpose))} · ${escapeHtml(model.lifecycle)}. The selected instruction phone speaks each cue once.</p>${registrationStatus}${actions ? `<div class="button-row">${actions}</div>` : ''}${prepared ? `<p class="field-help">${model.playbackDeviceId ? 'Instruction phone selected.' : 'Select the instruction phone and complete its test cue before Start.'}</p>` : ''}</section>`
    + (prepared ? hostedClockPanel('Opening clock reference', {clockDisplay, model, busy})
      + `<section class="panel"><h2>Start recording sequence</h2><p>After filming and saving the opening clock, keep the camera recording running. Confirm recording, then start the timed run.</p><div class="button-row">${hostedActionButton(model, 'recordingReady', 'Recording ready', false, busy)}${hostedActionButton(model, 'start', pending ? 'Retry saved Start' : 'Start', true, busy)}</div></section>` : '');
}

function hostedStartMetadata(model, busy) {
  if (model.startRegistration?.status !== 'confirmed') return '';
  const issues = model.startIssues ?? [];
  const categories = [['recording_partial', 'Partial recording'], ['recording_unavailable', 'Recording unavailable'], ['analysis_failed', 'Analysis failed'], ['publication_failed', 'Publication failed'], ...(issues.length ? [['correction', 'Correct a saved report'], ['resolved', 'Resolve a reported issue']] : [])];
  const run = `<input type="hidden" name="run_id" value="${escapeHtml(model.runId)}">`;
  const reference = issues.length ? selectField('Report to correct or resolve', 'previous_issue_id', [['', 'Select a saved report'], ...issues.map(issue => [issue.issueId, `${localRunDateFormatter().format(issue.reportedAtMs)}: ${humanize(issue.category)} - ${issue.reason.slice(0, 80)}`])], '') : '';
  return `<section class="panel"><h2>Report issue</h2><p>Record camera, offline analysis or publication problems here. Dated reports preserve the run's start registration and leave available published material accessible.</p><form data-hosted-form="start-issue">${run}${selectField('Category', 'category', categories, 'recording_partial')}${reference}${noteField('Reason', 'reason', '', 'Describe the missing material or failed operation. Choose a saved report for a correction or resolution; each new problem is recorded separately.', {required: true})}${field('Optional streaming link', 'stream_url', '', {type: 'url', help: 'HTTPS only. A stream is optional.'})}<button type="submit"${unavailable(busy)}>Save dated issue report</button></form>${issues.length ? `<details class="retained-details"><summary>Dated reports (${issues.length})</summary><ul>${issues.map(issue => `<li><p>${escapeHtml(localRunDateFormatter().format(issue.reportedAtMs))}: ${escapeHtml(humanize(issue.category))}</p><p>${escapeHtml(issue.reason)}</p></li>`).join('')}</ul></details>` : ''}</section>`
    + `<section class="panel"><h2>Optional stream</h2><p>Attach a streaming link independently of an issue report.</p><form data-hosted-form="start-stream">${run}${field('HTTPS streaming link', 'stream_url', model.streamUrl ?? '', {type: 'url', required: true})}<button type="submit"${unavailable(busy)}>Save streaming link</button></form></section>`;
}

function hostedTreePage({model, clockDisplay, busy}) {
  return pageTitle('Independent tree block', 'Tree targets', 'Start when conditions are suitable. A or B is assigned one target at a time; the next cue follows automatically.')
    + hostedRunControls(model, busy, clockDisplay)
    + `<section class="panel"><h2>Approach and arrival</h2><p>Stay away during pre-roll. Approach when instructed, then tap Arrived at the tree position.</p><div class="event-grid">${hostedActionButton(model, 'arrived', 'Arrived at tree position', false, busy)}</div></section>`
    + hostedCurrentAction(model, busy)
    + `<section class="panel"><h2>Departure and away</h2><p>After the last target, leave the area and tap Away to start post-roll.</p><div class="event-grid">${hostedActionButton(model, 'departed', 'Away from tree area', false, busy)}</div></section>`
    + `<section class="panel"><h2>Fixed camera regions</h2><p>Saved setup: ${escapeHtml(model.setupId || 'Not selected')}. ${escapeHtml(model.setupStatus)}.</p><a href="#setup">Review A, B and stationary background regions</a></section>`
    + (model.terminal ? hostedClockPanel('Closing clock reference', {clockDisplay, model, busy}) : '')
    + hostedStartMetadata(model, busy);
}

function localRunDateFormatter() {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

function runDateLines(run, dateFormatter) {
  const dateLine = (label, timestamp) => Number.isFinite(timestamp)
    ? `<p class="field-help">${label}: <time datetime="${new Date(timestamp).toISOString()}">${escapeHtml(dateFormatter.format(timestamp))}</time></p>` : '';
  const endLabel = {completed: 'Completed', stopped: 'Stopped', failed: 'Failed'}[run?.lifecycle];
  return dateLine('Created', run?.createdAtMs) + dateLine('Started', run?.recordingStartedAtMs)
    + (endLabel ? dateLine(endLabel, run?.finishedAtMs) : '');
}

function hostedHistoryPage({model, runs = [], busy, editingTagRunId = null}) {
  const dateFormatter = localRunDateFormatter();
  const timeZone = dateFormatter.resolvedOptions().timeZone;
  return pageTitle('Saved runs', 'History', 'Newest runs first. Select the same run on the practitioner and helper devices. Creating a run with saved settings leaves the original unchanged.')
    + `<p class="field-help">Times shown in ${escapeHtml(timeZone)}.</p>`
    + (runs.length ? `<div class="result-list">${[...runs].reverse().map(run => {
      const config = run.config ?? {};
      const summary = run.mode === 'tree' ? `${config.tree?.count ?? '?'} targets · ${config.tree?.responseSeconds ?? '?'} seconds each`
        : run.mode === 'local' ? `${config.local?.count ?? '?'} comparisons · ${config.local?.responseSeconds ?? '?'} seconds each`
          : `Absent ${config.global?.absentSeconds?.join('/') ?? '?'} seconds · active ${config.global?.activeSeconds?.join('/') ?? '?'} seconds`;
      const dates = runDateLines(run, dateFormatter);
      return `<article class="panel"><h2>${run.tag ? `${escapeHtml(run.tag)} · ` : ''}${escapeHtml(modeName(run.mode))} · ${escapeHtml(run.runId)}</h2><p>${escapeHtml(purposeName(run.purpose))} · ${escapeHtml(run.lifecycle)} · ${escapeHtml(summary)}</p>${dates}${editingTagRunId === run.runId ? `<form data-hosted-form="edit-tag"><input type="hidden" name="run_id" value="${escapeHtml(run.runId)}">${field('Run tag (optional)', 'tag', run.tag ?? '')}<div class="button-row"><button type="submit"${unavailable(busy)}>Save</button><button type="button" data-hosted-operation="cancel-tag"${unavailable(busy)}>Cancel</button></div></form>` : `<div class="button-row"><button type="button" data-hosted-operation="edit-tag" data-run-id="${escapeHtml(run.runId)}"${unavailable(busy)}>Edit tag</button></div>`}<div class="button-row"><button type="button" data-hosted-operation="open-run" data-run-id="${escapeHtml(run.runId)}"${unavailable(busy)}>Select this run</button><button type="button" data-hosted-operation="repeat" data-run-id="${escapeHtml(run.runId)}"${unavailable(busy)}>Create new run with these settings</button><a href="${HOSTED_APP_BASE}#${escapeHtml(run.mode)}">${escapeHtml(modeName(run.mode))} page</a></div></article>`;
    }).join('')}</div>` : '<p class="empty-state">No runs saved yet.</p>')
    + (model.runId ? `<p class="field-help">Current run: ${escapeHtml(model.runId)}. Select “Use this phone for instructions” on the practitioner phone. The helper opens the same run without becoming a second speaker.</p>` : '');
}

function hostedSetupPage({model, state = {}, sites = [], selectedImage, savedSetup, siteDraft = {}, siteDistances = {}, busy}) {
  const image = selectedImage;
  const site = sites.find(item => item.siteId === model.siteId || item.id === model.siteId);
  return pageTitle('Site and camera', 'Setup', 'Save measured positions and fixed image regions. A scored tree block needs a saved prospective setup before Start.')
    + `<section class="panel"><h2>Named positions</h2><p>Saved positions can be reused across runs. On a scored first-arrival day, the helper records the practice position and the practitioner records waiting and departure positions without visiting the site early.</p><form data-hosted-form="save-site">${field('Site name for a new site', 'site_label', siteDraft.label ?? site?.label ?? '')}${selectField('Reuse site', 'site_id', [['', 'New site'], ...sites.map(item => [item.siteId ?? item.id, item.label ?? item.siteId ?? item.id])], model.siteId)}<div class="button-row">${[['practice', 'Practice position'], ['waiting', 'Waiting position'], ['departure', 'Departure position']].map(([role, label]) => `<button type="button" data-hosted-operation="capture-position" data-role="${role}"${unavailable(busy)}>Save here as ${label}</button>`).join('')}</div><p class="field-help">${Object.entries(siteDraft.positions ?? {}).map(([role, point]) => `${humanize(role)}: ${Number(point.latitude).toFixed(5)}, ${Number(point.longitude).toFixed(5)} (±${Math.round(point.accuracyMetres)} m)`).join(' · ') || 'No position captured on this device yet.'}</p>${siteDistances.waitingToPractice != null || siteDistances.departureToPractice != null ? `<p class="field-help">Approximate straight-line distance: ${siteDistances.waitingToPractice == null ? '' : `Waiting to practice: ${escapeHtml(siteDistances.waitingToPractice)} m.`} ${siteDistances.departureToPractice == null ? '' : `Departure to practice: ${escapeHtml(siteDistances.departureToPractice)} m.`}</p>` : ''}<button type="submit"${unavailable(busy)}>Use saved site for this run</button></form></section>`
    + (model.mode === 'global' ? `<section class="panel"><h2>Passive reading</h2><p>Read a printed article or book during PASSIVE, keeping attention away from the scene. Keep the study page visible on the instruction phone throughout the run.</p><form data-hosted-form="save-reading"><fieldset${unavailable(busy || model.lifecycle !== 'draft')}>${field('Reading title', 'reading_title', state.passiveReading?.title ?? '', {required: true})}${field('Reading link (optional)', 'reading_url', state.passiveReading?.url ?? '', {type: 'url'})}<button type="submit">Save reading reference</button></fieldset></form></section>` : '')
    + `<section class="panel"><h2>Fixed tree regions</h2><p>On the Mac, export a PNG frame from the setup clip. Use that exact frame and locked camera profile to draw A, B and a stationary background before scored Start. Preparation regions saved afterward are marked retrospective.</p>${model.setupId ? `<p class="field-help">Current run setup: ${escapeHtml(model.setupId)} (${escapeHtml(model.setupStatus)}).</p>` : ''}<label class="field">Setup PNG <input type="file" accept="image/png" data-hosted-input="setup-image"${unavailable(busy)}></label>${image ? `<form data-hosted-form="save-camera-setup"><fieldset${unavailable(busy)}>${field('Locked camera profile', 'camera_profile', '', {required: true})}<input type="hidden" name="image_sha256" value="${escapeHtml(image.sha256)}"><input type="hidden" name="image_width" value="${escapeHtml(image.width)}"><input type="hidden" name="image_height" value="${escapeHtml(image.height)}">${selectField('Region to draw', 'mask_region', [['A', 'A'], ['B', 'B'], ['background_1', 'Background 1']], 'A')}<div class="mask-frame" data-width="${image.width}" data-height="${image.height}"><img src="${escapeHtml(image.url)}" alt="Selected setup frame for A, B and stationary background polygons" draggable="false"><div class="mask-overlays" aria-hidden="true"></div></div><p class="field-help" data-mask-status role="status" aria-live="polite">Click the frame to add vertices, or enter them below.</p><div class="button-row"><button type="button" data-mask-command="undo">Remove last vertex</button><button type="button" data-mask-command="clear">Clear selected region</button></div><div class="form-grid">${['A', 'B', 'background_1'].map(region => noteField(`${region === 'background_1' ? 'Background 1' : region} polygon vertices`, `masks.${region}.points`, '', 'One x, y pixel pair per line. At least three vertices.')).join('')}</div><button type="submit">Save fixed setup</button>${savedSetup?.runId === (model.runId ?? null) && savedSetup?.imageSha256 === image.sha256 ? `<p class="field-help" role="status">Setup ${escapeHtml(savedSetup.setupId)} saved ${savedSetup.runId ? 'and linked to this run. Save again after further edits.' : 'without a run link. Open a draft Tree run to attach it.'}</p>` : ''}</fieldset></form>` : '<p class="empty-state">Choose the exported PNG to draw fixed regions.</p>'}</section>`;
}

function hostedClockPanel(title, {clockDisplay, model, busy}) {
  const serverDate = clockDisplay?.serverTimeText.slice(0, 10) ?? 'Not measured';
  const serverTime = clockDisplay?.serverTimeText.slice(11, -1) ?? 'Measure server clock';
  const phoneDate = clockDisplay?.phoneTimeText.slice(0, 10) ?? 'Not measured';
  const phoneTime = clockDisplay?.phoneTimeText.slice(11, -1) ?? 'Not measured';
  return `<section class="panel cue-panel"><p class="eyebrow">${escapeHtml(title)}</p><p class="recording-id"><strong>Run ID: ${escapeHtml(model.runId ?? 'No run selected')}</strong></p><p class="eyebrow">Reference ${escapeHtml(clockDisplay?.exchangeId ?? 'Not measured')}</p><p>Server UTC date: <span data-clock-field="server-date">${escapeHtml(serverDate)}</span></p><h2 class="clock-time" data-clock-field="server-time">${escapeHtml(serverTime)}${clockDisplay ? ' UTC' : ''}</h2><p>Phone UTC date: <span data-clock-field="phone-date">${escapeHtml(phoneDate)}</span></p><p>Phone UTC time:<span class="clock-detail-time" data-clock-field="phone-time">${escapeHtml(phoneTime)}${clockDisplay ? ' UTC' : ''}</span></p><p>Phone monotonic: <span data-clock-field="phone-monotonic">${clockDisplay ? `${escapeHtml(clockDisplay.phoneMonotonicAtMs)} ms` : 'Not measured'}</span></p><p>Clock uncertainty: ${clockDisplay ? `${escapeHtml(clockDisplay.uncertaintyMs)} ms` : 'Unknown'}</p><div class="button-row"><button type="button" data-hosted-operation="measure-clock"${unavailable(busy)}>Measure clock</button>${model.runId ? `<button type="button" data-hosted-operation="save-clock"${unavailable(busy || !clockDisplay)}>Save reference to run</button>` : ''}</div><p class="field-help" role="status">${model.clockReferenceCount ?? 0} clock reference${model.clockReferenceCount === 1 ? '' : 's'} saved to this run. Repeated saves add another reference; they do not overwrite earlier ones.</p></section>`;
}

function hostedClockPage(context) {
  return pageTitle('Clock reference', 'Film this display', 'Show this phone to the camera at the start and end of a recording. Phone and estimated server times stay visible together.')
    + hostedClockPanel('Clock reference', context);
}

function hostedSeriesPage({series = [], busy}) {
  return pageTitle('Preparation collection', 'Tree series', 'Append recordings to one retained sequence. There is no final inventory of slots.')
    + `<section class="panel"><h2>New preparation series</h2><form data-hosted-form="create-series"><fieldset${unavailable(busy)}>${field('Series label', 'label', '', {required: true})}<button type="submit">Save preparation series</button></fieldset></form></section>`
    + `<section class="panel"><h2>Saved series</h2>${series.length ? series.map(item => `<article class="job"><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.seriesId)} · ${escapeHtml(item.status)} · ${escapeHtml(item.runIds.length)} recordings</p><div class="button-row"><button type="button" data-hosted-operation="append-series-run" data-series-id="${escapeHtml(item.seriesId)}"${unavailable(busy || item.status !== 'open')}>Append preparation run</button><a href="${HOSTED_API_BASE}series/${encodeURIComponent(item.seriesId)}/export" download>Export series manifest</a></div><details class="retained-details"><summary>Saved settings and identities</summary>${detailsTable(item)}</details></article>`).join('') : '<p class="empty-state">No preparation series saved.</p>'}</section>`;
}

function hostedRecordingsPage({model}) {
  return pageTitle('Original recordings', 'Recordings and analysis', 'Keep the original camera video on the Mac. The hosted run retains instructions, event times and configuration.')
    + `<section class="panel"><h2>Run bundle</h2>${model.runId ? model.terminal ? `<a href="${HOSTED_API_BASE}runs/${encodeURIComponent(model.runId)}/export" download>Export run</a>` : '<p>Export becomes available after the run ends.</p>' : '<p>Open a run first.</p>'}<p class="field-help">On the Mac, import this bundle with the original camera video. Each analysis remains linked to the run.</p><p>Open <strong>Lovefield Tree Study</strong> in your Mac's Applications folder. Its local analysis page opens in Chrome on your Mac. Import the completed, stopped or failed run bundle and original recordings there, then run the analysis and inspect its results.</p></section>`;
}

function renderHostedPage(page, context) {
  const views = {
    study: hostedStudyPage, setup: hostedSetupPage,
    tree: hostedTreePage, history: hostedHistoryPage, clock: hostedClockPage,
    series: hostedSeriesPage, recordings: hostedRecordingsPage,
    results: () => pageTitle('Measured outcomes', 'Results', 'Import the completed or stopped run bundle and original recording on the Mac to inspect retained measurements and results.') + '<section class="panel"><p>Open <strong>Lovefield Tree Study</strong> in your Mac\'s Applications folder. Select the imported run on your Mac, then open its completed analysis to inspect the results.</p></section>',
  };
  if (['global', 'local', 'tree'].includes(page) && context.model.runId && context.model.mode !== page) {
    return pageTitle('Run and page differ', modeName(page) + ' page', 'This page does not switch runs.')
      + '<section class="panel"><h2>The selected run is ' + escapeHtml(modeName(context.model.mode))
      + '</h2><p>Its mode was saved when the run was created. Select a run in History for this page, or choose '
      + escapeHtml(modeName(page)) + ' on Study and save a new run.</p><div class="button-row"><a href="#'
      + escapeHtml(context.model.mode) + '">Open selected run</a><a href="#history">Select a run in History</a><a href="#study">Create a new run</a></div></section>';
  }
  return (views[page] ?? hostedStudyPage)({...context, busy: context.busy || !context.model.connection.connected});
}

function framePicker(id, {name = 'frame_index', preview = null, initialFrameIndex = 0, frameCount = null,
  busy = false, exportOperation = null} = {}) {
  const frameIndex = preview?.frameIndex ?? initialFrameIndex;
  const knownFrameCount = preview?.frameCount ?? frameCount;
  return `<div data-frame-picker="${id}" data-frame-name="${name}"${knownFrameCount == null ? '' : ` data-frame-count="${escapeHtml(knownFrameCount)}"`}>${field('Frame number', name, frameIndex, {type: 'number', min: 0, step: 1})}<div class="button-row"><button type="button" data-analysis-operation="show-frame" data-frame-step="-1"${unavailable(busy || frameIndex === 0)}>Previous frame</button><button type="button" data-analysis-operation="show-frame" data-frame-step="0"${unavailable(busy)}>Show frame</button><button type="button" data-analysis-operation="show-frame" data-frame-step="1"${unavailable(busy || knownFrameCount != null && frameIndex >= knownFrameCount - 1)}>Next frame</button>${exportOperation ? `<button type="button" data-analysis-operation="${exportOperation}"${unavailable(busy || !preview)}>Export full-size setup PNG</button>` : ''}</div><p class="field-help">${preview ? `Frame ${escapeHtml(preview.frameIndex)} · video time ${escapeHtml(Number(preview.ptsSeconds).toFixed(3))} seconds${preview.frameCount ? ` · ${escapeHtml(preview.frameCount)} frames` : ''}` : 'Enter a frame number and press Enter or Show frame.'}</p>${preview?.previewImage ? `<div class="mask-frame"><img src="${escapeHtml(preview.previewImage)}" alt="${id === 'before' ? 'Opening clock' : id === 'after' ? 'Closing clock' : 'Selected camera'} frame preview"></div>` : ''}</div>`;
}

export function selectedClockVideo(videos, detail, recordingId = null) {
  const latestMappedId = detail?.timeMaps?.at(-1)?.videoRecordingId;
  return videos.find(item => (item.recordingId ?? item.id) === recordingId)
    ?? videos.find(item => (item.recordingId ?? item.id) === latestMappedId)
    ?? videos.find(item => item.timeMapId && item.clockMap?.references?.length === 2)
    ?? videos[0];
}

const savedUtc = milliseconds => Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';

function macClockMapping({selectedRunId, videos, wind, tree, detail, framePreviews, busy, selectedVideo}) {
  const videoChoices = videos.map(item => [item.recordingId ?? item.id, item.name ?? item.recordingId ?? item.id]);
  const selectedVideoId = selectedVideo.recordingId ?? selectedVideo.id;
  const references = selectedVideo.timeMapId && selectedVideo.clockMap?.references?.length === 2
    ? selectedVideo.clockMap.references : null;
  const frameCount = selectedVideo.timelineSummary?.decodedFrameCount;
  const lastFrameIndex = Number.isSafeInteger(frameCount) && frameCount > 0 ? frameCount - 1 : 0;
  const selectedWind = selectedVideo.timeMapId
    ? wind.find(item => item.timeMapId === selectedVideo.timeMapId)
    : wind[0];
  const csvMetadata = selectedWind?.clockMap;
  return `<section class="panel"><h2>Two filmed clock references</h2><p>${tree ? 'Select a readable opening and closing frame, then copy the visible server UTC timestamp and measured clock uncertainty. The frame selection allowance is derived from the decoded video cadence. For older clocks that changed once per second, use the first frame of a timestamp transition.' : 'Select opening and closing frames and read the phone and server UTC times, phone monotonic milliseconds and uncertainty. The software checks camera and CSV alignment.'}</p><form data-analysis-form="save-time-map"><input type="hidden" name="run_id" value="${escapeHtml(selectedRunId)}"><input type="hidden" name="mode" value="${tree ? 'tree' : 'wind'}">${selectField('Video', 'video_recording_id', videoChoices, selectedVideoId)}${tree ? '' : selectField('Wind CSV', 'wind_recording_id', [['', 'None'], ...wind.map(item => [item.recordingId ?? item.id, item.name ?? item.recordingId ?? item.id])], selectedWind?.recordingId ?? selectedWind?.id ?? '')}${['before', 'after'].map((side, index) => {
    const reference = references?.[index];
    const preview = framePreviews[side]?.recordingId === selectedVideoId ? framePreviews[side] : null;
    return `<fieldset class="panel"><legend>${index ? 'Closing' : 'Opening'} reference</legend>${framePicker(side, {name: `${side}_frame`, preview, initialFrameIndex: reference?.frameIndex ?? (index ? lastFrameIndex : 0), frameCount, busy})}<div class="form-grid">${field('Server UTC shown in frame', `${side}_server`, savedUtc(reference?.serverDisplayedAtMs), {required: true, help: 'Exact ISO UTC timestamp, including the date, or epoch milliseconds.'})}${field('Clock uncertainty (ms)', `${side}_clock_uncertainty`, reference?.clockUncertaintyMs ?? '', {type: 'number', min: 0, step: 'any', required: true})}${tree ? '' : field('Phone UTC shown in frame', `${side}_phone`, savedUtc(reference?.phoneDisplayedAtMs), {required: true}) + field('Phone monotonic shown in frame (ms)', `${side}_monotonic`, reference?.phoneMonotonicAtMs ?? '', {type: 'number', min: 0, step: 'any'}) + field('Frame selection uncertainty (ms)', `${side}_frame_uncertainty`, reference?.frameSelectionUncertaintyMs ?? '', {type: 'number', min: 0, step: 1, required: true})}</div>${tree && preview?.frameSelectionUncertaintyMs != null ? `<p class="field-help">Automatic frame allowance: ${escapeHtml(Number(preview.frameSelectionUncertaintyMs.toFixed(3)))} ms.</p>` : ''}</fieldset>`;
  }).join('')}${tree ? '' : `<details><summary>Wind CSV timestamp format</summary><div class="form-grid">${field('Timestamp format', 'timestamp_format', csvMetadata?.timestampFormat ?? '%Y-%m-%d %H:%M:%S.%f')}${field('UTC offset in minutes', 'utc_offset_minutes', csvMetadata?.utcOffsetMinutes ?? 0, {type: 'number', step: 1})}${field('Timestamp resolution (ms)', 'timestamp_resolution_ms', csvMetadata?.timestampResolutionMs ?? 1000, {type: 'number', min: 1, step: 1})}</div></details>`}<button type="submit"${unavailable(busy)}>Save and check time mapping</button></form>${detail?.timeMaps?.length ? `<p>${detail.timeMaps.length} time mapping${detail.timeMaps.length === 1 ? '' : 's'} retained.</p>` : ''}</section>`;
}

export function progressText(progress) {
  if (!progress) return '';
  const count = progress.completed == null ? '' : `${progress.completed.toLocaleString()}${progress.total == null ? '' : ` / ${progress.total.toLocaleString()}`} ${progress.unit ?? ''}`;
  return [progress.stage, count, progress.videoSeconds == null ? '' : `${Number(progress.videoSeconds).toFixed(3)} seconds of video`].filter(Boolean).join(' · ');
}

export function renderMacProgress(progress, description) {
  const {completed, total} = progress ?? {};
  const measured = Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= 0 && completed <= total;
  const label = progress?.stage ?? description;
  const text = progressText(progress);
  return `<progress aria-label="${escapeHtml(label)}" aria-valuetext="${escapeHtml(text || label)}"${measured ? ` max="${total}" value="${completed}"` : ''}></progress><span>${escapeHtml(text)}</span>`;
}

function savedTreeSetup(setup) {
  if (!setup) return '<section class="panel"><h2>Saved regions</h2><p class="empty-state">Setup incomplete. Export a setup PNG and define regions on Test Lab.</p></section>';
  const {width, height} = setup.imageSize;
  const regions = ['A', 'B', 'background'].map(name => {
    const points = setup.regions[name];
    if (!Array.isArray(points) || !points.length) return '';
    const vertices = points.map(([x, y]) => `${x},${y}`).join(' ');
    return `<polygon class="mask-polygon" data-region="${name}" points="${escapeHtml(vertices)}"></polygon><text class="mask-label" x="${escapeHtml(points[0][0])}" y="${escapeHtml(points[0][1])}">${name}</text>`;
  }).join('');
  const source = setup.sourceKind === 'main' ? 'Main recording' : setup.sourceKind === 'setup' ? 'Separate setup video' : 'Source video unavailable';
  const provenance = setup.sourceVideoName && Number.isSafeInteger(setup.frameIndex)
    ? `${source} · ${setup.sourceVideoName} · frame ${setup.frameIndex}` : source;
  return `<section class="panel"><h2>Saved regions</h2><p>${escapeHtml(provenance)}</p><p>${setup.retrospective ? 'Regions defined after the preparation run.' : 'Regions saved before the run.'}</p><div class="mask-frame"><img src="${escapeHtml(setup.imageUrl)}" alt="Exact saved Tree setup PNG with A, B and stationary background regions"><div class="mask-overlays"><svg class="mask-shapes" viewBox="0 0 ${escapeHtml(width)} ${escapeHtml(height)}" aria-hidden="true">${regions}</svg></div></div></section>`;
}

export function renderMacError(message) {
  return `<strong>Action could not be completed</strong><p>${escapeHtml(message)}</p><button type="button" data-dismiss-mac-error>Dismiss</button>`;
}

function macAnalysisResult(analysis, runId, tag) {
  const profile = analysis.sealedProfileJson ? JSON.parse(analysis.sealedProfileJson) : analysis.result?.profile;
  const name = profile?.label ?? analysis.profileId ?? 'Unavailable';
  const area = profile?.video?.measurement?.method === 'area-grid-mean-v1';
  const settings = profile?.video
    ? `<p>Measurement method: ${escapeHtml(profile.video.measurement?.method ?? 'feature-mean-v1')} · ${area ? `${escapeHtml(profile.video.measurement.cellSizePixels)}-pixel grid cells` : `${escapeHtml(profile.video.featureDetection.maxCorners)} maximum points per region`} · ${escapeHtml(profile.video.tracking.windowSizePixels.join(' × '))}-pixel tracking window</p>` : '';
  const percentage = value => `${Number((value * 100).toFixed(1))}%`;
  const coverage = area ? ['A', 'B'].map(region => {
    const values = (analysis.result?.measurements?.pairs ?? []).map(pair => pair[`${region}_spatial`]?.coverage_fraction)
      .filter(value => typeof value === 'number' && Number.isFinite(value));
    return values.length ? `${region} coverage: minimum ${percentage(Math.min(...values))}, mean ${percentage(values.reduce((sum, value) => sum + value, 0) / values.length)}`
      : `${region} coverage unavailable`;
  }) : [];
  const meaning = area ? `<p>Area-grid speed is a measured-area estimate over cells with accepted tracks, not a census of every leaf or wind speed. Coverage across all decoded frame pairs, including setup and clock filming: ${escapeHtml(coverage.join(' · '))}.</p>` : '';
  return `<section class="panel"><h2 class="publication-identity">Retained result ${escapeHtml(analysis.analysisId)}</h2><p>${escapeHtml([tag, runId].filter(Boolean).join(' · '))}</p><p>Analysis profile: ${escapeHtml(name)}</p>${settings}${meaning}<p>Status: ${escapeHtml(analysis.status)}</p>${qualityList((analysis.result?.qualityReasons ?? analysis.qualityReasons ?? []).map(resultReason))}${renderTreeResults(analysis.displayReport ? {report: analysis.displayReport} : analysis.result)}<details class="retained-details"><summary>Full retained result</summary><div class="table-scroll"><pre>${escapeHtml(JSON.stringify(analysis, null, 2))}</pre></div></details></section>`;
}

export function renderMacResultPage({analysis, run}) {
  return pageTitle('Saved analysis', run.tag ?? run.runId, 'This tab shows this saved analysis. Running another analysis or selecting another profile does not replace it.')
    + macAnalysisResult(analysis, run.runId, run.tag);
}

export function renderMacComparisonResultPage({comparison, side}) {
  if (!['left', 'right'].includes(side)) throw new Error('Choose one saved comparison side.');
  const pinnedProfile = comparison[`${side}Profile`];
  const profile = pinnedProfile?.profile;
  const report = comparison[`${side}DisplayReport`];
  return pageTitle('Saved comparison', comparison.label,
    `${side === 'left' ? 'First' : 'Second'} accumulated result · ${pinnedProfile?.label ?? profile?.label ?? profile?.profileId ?? 'Unknown profile'}. This saved result includes the same recordings, in the same order, as the other profile's result.`)
    + `<section class="panel"><h2>${escapeHtml(pinnedProfile?.label ?? profile?.label ?? profile?.profileId ?? 'Accumulated result')}</h2><p>Measurement method: ${escapeHtml(profile?.video?.measurement?.method ?? 'feature-mean-v1')}. Matching footage was analyzed twice for method development; each accumulation counts every recording once.</p>${renderTreeResults({report})}</section>`;
}

function profileEditor(selectedProfile, busy, open) {
  const profile = JSON.parse(selectedProfile.sealedProfileJson);
  const video = profile.video;
  const grid = video.measurement?.method === 'area-grid-mean-v1';
  const methodFields = grid
    ? field('Cell size (pixels)', 'cell_size', video.measurement.cellSizePixels,
        {type: 'number', step: '1', min: 1, required: true})
      + field('Maximum points per full cell', 'points_per_cell', video.measurement.pointsPerCell,
        {type: 'number', step: '1', min: 1, required: true})
      + field('Minimum accepted tracks per full cell', 'minimum_tracks_per_cell', video.measurement.minimumTracksPerCell,
        {type: 'number', step: '1', min: 1, required: true})
      + field('Required measured area coverage (fraction)', 'spatial_coverage', video.measurement.minimumSpatialCoverageFraction,
        {type: 'number', step: 'any', min: 0, max: 1, required: true})
      + selectField('Refresh policy', 'refresh_policy', [['timed', 'Timed, one-second refresh'],
        ['continuous', 'Continuous, retain valid tracks within each cell budget and fill deficits']], video.measurement.refreshPolicy)
      + '<p class="field-help">Boundary-cell point budgets and minimum track counts scale with the selected region area.</p>'
    : field('Maximum points per region', 'maximum_points', video.featureDetection.maxCorners,
        {type: 'number', step: '1', min: 1, required: true});
  return `<details class="retained-details"${open ? ' open' : ''}><summary>Preparation motion settings</summary><form data-analysis-form="save-profile">${field('Profile name', 'profile_name', '', {required: true, help: 'Choose a name you recognize, for example Tree 6000/21 - mean-track analysis.'})}<p>Measurement: ${escapeHtml(grid ? 'Area-weighted grid of measured image cells' : 'Average of accepted feature points')}.</p>${methodFields}${field('Minimum spacing between points (pixels)', 'min_distance', video.featureDetection.minDistancePixels, {type: 'number', min: 0, required: true})}${field('Feature strength (fraction)', 'feature_strength', video.featureDetection.qualityLevel, {type: 'number', min: 0, max: 1, required: true})}${field('Tracking window width (pixels)', 'window_width', video.tracking.windowSizePixels[0], {type: 'number', step: '2', min: 1, required: true})}<p class="field-help">Solver, matching, timing and shake constants remain fixed here and are visible in View saved settings. Each analysis retains the full profile and hash.</p><button type="submit"${unavailable(busy)}>Save as new profile</button></form></details>`;
}

function publicationControls({selectedSeriesId, seriesDetail, publicationJobs, busy}) {
  if (!selectedSeriesId || seriesDetail?.purpose !== 'scored') return '<section class="panel"><h2>Publish results</h2><p class="empty-state">Choose a retained named scored series to prepare a publication. Preparation recordings remain local.</p></section>';
  const job = [...publicationJobs].reverse().find(item => item.seriesId === selectedSeriesId);
  const softwareTest = seriesDetail.softwareTest || job?.softwareTest;
  const included = job?.inventory?.filter(item => item.contributes).length;
  const pending = job?.inventory?.length - included;
  const resumable = job?.status === 'failed' && Number.isSafeInteger(job.fileCount) && !job.error?.requiresNewSnapshot;
  return `<section class="panel" data-publication-panel><h2>Publish results</h2><p>Prepare the selected series, check its retained files, then explicitly publish the prepared result. Local analysis does not publish automatically.</p>`
    + (softwareTest ? '<div class="callout rehearsal"><p><strong>Software test data. These recordings verify the application and are not research observations. Publication is restricted to Test.</strong></p></div>' : '')
    + `<form data-analysis-form="prepare-publication">${selectField('Destination', 'environment', softwareTest ? [['test', 'Test']] : [['test', 'Test'], ['production', 'Production']], job?.environment ?? 'test')}${noteField('Correction reason (if replacing a published analysis)', 'correction_reason', job?.correctionReason ?? '', 'Explain a replacement of a previously published analysis. Newly appended recordings do not need a correction reason.')}<div class="button-row"><button type="submit"${unavailable(busy)}>Prepare publication</button></div></form>`
    + (job ? `<div class="publication-summary"><p><strong>${escapeHtml(job.status === 'completed' ? 'Publication completed' : `Publication ${job.status}`)}</strong> · ${escapeHtml(job.environment === 'test' ? 'Test' : 'Production')}</p><p class="publication-identity">Job: ${escapeHtml(job.jobId)}</p>`
      + (Number.isSafeInteger(job.fileCount) && Number.isSafeInteger(job.uploadBytes) ? `<p>${job.fileCount} files · ${job.uploadBytes.toLocaleString('en-US')} bytes</p>` : '<p>The file count and total size will appear when preparation finishes.</p>')
      + (Array.isArray(job.inventory) ? `<p>${included} included · ${pending} pending recordings</p><details class="retained-details"><summary>View publication recording inventory</summary><ul>${job.inventory.map(item => `<li>${escapeHtml(item.tag || item.runId)}: ${item.contributes ? 'included' : 'pending'}${item.analysisReason ? ` - ${escapeHtml(item.analysisReason)}` : ''}</li>`).join('')}</ul></details>` : '')
      + (['preparing', 'uploading'].includes(job.status) ? `<div role="status" data-publication-progress>${renderMacProgress(job.progress, job.status === 'preparing' ? 'Preparing publication' : 'Publishing retained results')}</div>` : '')
      + (job.error ? `<div class="error-text" role="alert"><p>${escapeHtml(job.error.message ?? 'Publication failed.')}</p><p>${escapeHtml(job.error.corrective_action ?? '')}</p>${job.error.requiresNewSnapshot ? '<p>Prepare a new publication after resolving this issue.</p>' : job.fileCount == null ? '<p>Preparation did not finish. Resolve the failure, then use Prepare publication before publishing.</p>' : ''}</div>` : '')
      + (job.status === 'prepared' || resumable ? `<div class="button-row"><button type="button" class="primary" data-analysis-operation="${resumable ? 'resume-publication' : 'publish-publication'}" data-job-id="${escapeHtml(job.jobId)}"${unavailable(busy)}>${resumable ? 'Resume publication' : 'Publish results'}</button></div>` : '')
      + (job.status === 'completed' ? `<div class="button-row">${job.resultsUrl ? `<a href="${escapeHtml(job.resultsUrl)}" target="_blank" rel="noopener">Published Results</a>` : ''}${job.recordingsUrl ? `<a href="${escapeHtml(job.recordingsUrl)}" target="_blank" rel="noopener">Videos and analyses</a>` : ''}</div>` : '') + '</div>' : '<p class="empty-state">No publication has been prepared for this series.</p>') + '</section>';
}

export function renderMacAnalysisPage({runs = [], selectedRunId = null, detail = null, previewImage = null,
  setupClip = null, setupPreviewImage = null, selectedAnalysis = null,
  series = [], selectedSeriesId = null, seriesDetail = null, selectedEvaluation = null, busy = false,
  activeOperation = null, framePreviews = {}, profiles = [], selectedProfileId = null, profileSettingsOpen = false,
  selectedVideoRecordingId = null, annotationJobs = [], comparisonCandidates = null,
  savedComparisons = null, selectedComparison = null, publicationJobs = [],
  comparisonLeftProfileId = null, comparisonRightProfileId = null} = {}) {
  fieldSequence = 0;
  const selectedRun = runs.find(run => run.runId === selectedRunId);
  const currentSeries = seriesDetail ?? series;
  const seriesOptions = [['', 'Independent preparation recordings'], ...(series?.series ?? []).map(item =>
    [item.seriesId, `${item.label}${item.manifestImported ? '' : ' - manifest missing'}`])];
  const scored = selectedRun?.purpose === 'scored' || detail?.purpose === 'scored';
  const tree = selectedRun?.mode === 'tree' || detail?.mode === 'tree';
  const selectedProfile = scored ? detail?.frozenProfile : profiles.find(item => item.profileId === selectedProfileId) ?? profiles[0];
  const tag = detail?.tag ?? selectedRun?.tag;
  const recordings = Array.isArray(detail?.recordings) ? detail.recordings : Object.values(detail?.recordings ?? {});
  const videos = recordings.filter(item => item.kind === 'video' && item.available !== false);
  const selectedVideo = selectedClockVideo(videos, detail, selectedVideoRecordingId);
  const annotationEndSeconds = Number.isFinite(selectedVideo?.videoEndSeconds) && selectedVideo.videoEndSeconds > 0
    ? selectedVideo.videoEndSeconds : null;
  const wind = recordings.filter(item => item.kind === 'wind');
  const analyses = Array.isArray(detail?.analyses) ? detail.analyses : Object.values(detail?.analyses ?? {});
  const dateFormatter = localRunDateFormatter();
  const runOptions = runs.map(item => {
    const timestamp = item.recordingStartedAtMs ?? item.createdAtMs;
    const date = Number.isFinite(timestamp)
      ? `${item.recordingStartedAtMs != null ? 'Started' : 'Created'} ${dateFormatter.format(timestamp)}` : 'Date unavailable';
    return [item.runId, `${item.tag ? item.tag + ' · ' : ''}${modeName(item.mode)} · ${item.runId} · ${date}`];
  });
  return pageTitle('Mac analysis', 'Tree recordings and results', 'Prepare a setup frame before targeting, or import a completed, stopped or interrupted Tree recording with its original camera video. Field instructions remain on the hosted phones.')
    + (activeOperation ? `<div class="mac-operation-status" role="status" data-mac-operation-status><strong>${escapeHtml(activeOperation.description)}</strong><span data-mac-operation-progress>${renderMacProgress(activeOperation.progress, activeOperation.description)}</span>${activeOperation.elapsedSeconds == null ? '' : `<span data-mac-operation-elapsed aria-hidden="true">${escapeHtml(activeOperation.elapsedSeconds)} seconds elapsed</span>`}<span>Other controls are unavailable until this finishes. Keep this page open.</span></div>` : '')
    + `<section class="panel"><h2>Tree setup image</h2><p>Choose a separate setup video before a scored run, or the main recording after a preparation run. Select one frame and export its full-size PNG. On Test Lab, define regions using that PNG.</p><button type="button" data-analysis-operation="import-setup-clip"${unavailable(busy)}>Choose camera clip</button>${setupClip?.clipId ? `<p>Selected clip: ${escapeHtml(setupClip.name)} · ${escapeHtml(setupClip.width)} × ${escapeHtml(setupClip.height)} pixels</p>` : '<p class="empty-state">No camera clip selected.</p>'}<form data-analysis-form="preview-setup-clip">${selectField('Video source', 'source_kind', [['setup', 'Separate setup video'], ['main', 'Main recording']], 'setup')}${framePicker('setup', {preview: framePreviews.setup, busy: busy || !setupClip?.clipId, exportOperation: 'export-setup-clip-frame'})}</form></section>`
    + `<section class="panel cue-panel"><h2>${selectedRunId ? `Run ${escapeHtml(tag ? `${tag} · ${selectedRunId}` : selectedRunId)}` : 'Import a completed or stopped Tree run'}</h2><div class="button-row"><button type="button" data-analysis-operation="import-bundle" class="primary"${unavailable(busy)}>Choose run or series bundle</button><button type="button" data-analysis-operation="import-retained-setup"${unavailable(busy)}>Import retained setup images</button></div><p class="field-help">The original bundle is retained with its identity and hash. For a named series, import its latest hosted series bundle to retain all collected members. A later analysis never changes these originals.</p></section>`
    + `<section class="panel"><h2>Imported runs</h2>${runs.length ? `<p class="field-help">Times shown in ${escapeHtml(dateFormatter.resolvedOptions().timeZone)}.</p><form data-analysis-form="select-run">${selectField('Open run', 'run_id', runOptions, selectedRunId ?? runs[0].runId)}<button type="submit"${unavailable(busy)}>Open run</button></form>${selectedRunId ? runDateLines({...selectedRun, ...detail}, dateFormatter) : ''}` : '<p class="empty-state">No completed or stopped Tree bundles imported yet.</p>'}</section>`
    + (selectedRunId && tree ? savedTreeSetup(detail?.savedSetup) : '')
    + (selectedRunId ? `<section class="panel"><h2>Original recordings</h2><div class="button-row">${tree ? '' : `<button type="button" data-analysis-operation="import-recording" data-kind="wind"${unavailable(busy)}>Choose original wind CSV</button>`}<button type="button" data-analysis-operation="import-recording" data-kind="video"${unavailable(busy)}>Choose original camera video</button></div>${recordings.length ? `<div class="table-scroll"><table><caption>Retained originals</caption><thead><tr><th>File</th><th>Kind</th><th>Identity</th></tr></thead><tbody>${recordings.map(item => `<tr><td>${escapeHtml(item.name ?? item.originalName ?? item.recordingId)}</td><td>${escapeHtml(item.kind)}${item.available === false ? ' · Original unavailable' : ''}</td><td>${escapeHtml(item.recordingId ?? item.id)}${item.sha256 ? ` · ${escapeHtml(item.sha256.slice(0, 12))}…` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-state">Choose the original recording files for this run.</p>'}</section>` : '')
    + (selectedRunId && videos.length ? macClockMapping({selectedRunId, videos, wind, tree, detail, framePreviews, busy, selectedVideo}) : '')
    + (selectedRunId && videos.length && (selectedRun?.mode === 'tree' || detail?.mode === 'tree') ? `<section class="panel"><h2>Tree footage review</h2><p>Check that the saved A and B regions stay visible. If something crosses either region, record every affected frame span. This review excludes obstructed frames; it does not correct the video.</p><form data-analysis-form="save-obstruction-review"><input type="hidden" name="run_id" value="${escapeHtml(selectedRunId)}">${selectField('Camera video', 'video_recording_id', videos.map(item => [item.recordingId ?? item.id, item.name ?? item.recordingId ?? item.id]), selectedVideo.recordingId ?? selectedVideo.id)}${selectField('Review decision', 'decision', [['clear', 'Clear footage'], ['obstructed', 'Obstructed frames']], selectedVideo.savedObstructionReview?.decision ?? 'clear')}${noteField('Obstructed frame spans', 'spans', selectedVideo.savedObstructionReview?.spans?.map(item => `${item.startFrameIndex}, ${item.endFrameIndex}`).join('\n') ?? '', 'For obstructed footage, enter one first, last frame pair per line, for example 150, 180. Leave blank for clear footage.')}<button type="submit"${unavailable(busy)}>Save footage review</button></form>${selectedVideo.savedObstructionReview ? `<p>Saved review restored: ${escapeHtml(selectedVideo.savedObstructionReview.decision === 'clear' ? 'Clear footage' : 'Obstructed frames')}.</p>` : ''}${detail.obstructionReviews?.length ? `<p>${detail.obstructionReviews.length} retained footage review${detail.obstructionReviews.length === 1 ? '' : 's'}.</p>` : ''}</section>` : '')
    + (selectedRunId ? `<section class="panel"><h2>Analyze this run</h2><form data-analysis-form="start-analysis"><input type="hidden" name="run_id" value="${escapeHtml(selectedRunId)}">${scored ? `<input type="hidden" name="profile_id" value="${escapeHtml(selectedProfile?.profileId)}"><p>Frozen analysis profile: ${escapeHtml(selectedProfile?.label ?? selectedProfile?.profileId ?? 'Unavailable')}</p>` : selectField('Analysis profile', 'profile_id', profiles.map(item => [item.profileId, item.label]), selectedProfile?.profileId)}${selectedProfile ? `<details class="retained-details"><summary>View saved settings</summary><div class="table-scroll"><pre>${escapeHtml(selectedProfile.sealedProfileJson)}</pre></div></details>` : '<p class="error-text">No analysis profile available.</p>'}<button type="submit"${unavailable(busy || !selectedProfile)}>Analyze retained originals</button></form>${!scored && selectedProfile ? profileEditor(selectedProfile, busy, profileSettingsOpen) : ''}${analyses.length ? `<div class="jobs">${analyses.map(item => `<article class="job"><h3 class="publication-identity">${escapeHtml(item.analysisId ?? item.id)}</h3><p>Analysis profile: ${escapeHtml(profiles.find(profile => profile.profileId === item.profileId)?.label ?? item.profileId ?? 'Unavailable')}</p><p>${escapeHtml(item.status ?? 'pending')}</p>${item.status === 'completed' ? `<p><a href="${escapeHtml(`${LOCAL_ANALYSIS_BASE}#run=${encodeURIComponent(selectedRunId)}&analysis=${encodeURIComponent(item.analysisId ?? item.id)}`)}" target="_blank" rel="noopener">Open result in new tab</a></p>` : ''}${qualityList((item.qualityReasons ?? []).map(resultReason))}${item.error ? `<p class="error-text">${escapeHtml(item.error.message ?? item.error)}</p>` : ''}<div class="button-row"><button type="button" data-analysis-operation="view-result" data-analysis-id="${escapeHtml(item.analysisId ?? item.id)}"${unavailable(busy)}>View result</button><button type="button" data-analysis-operation="select-revision" data-analysis-id="${escapeHtml(item.analysisId ?? item.id)}"${unavailable(busy || item.status !== 'completed')}>Use this revision in series</button></div></article>`).join('')}</div>` : '<p class="empty-state">No analysis result yet. Each run produces a separate retained result.</p>'}</section>` : '')
    + (selectedRunId && tree && !videos.length ? `<section class="panel"><h2>Finalize with missing measurements</h2><p>Use this when the original camera file is permanently unavailable. Every generated target stays in the calculation. Surviving measurements remain; unavailable portions stay bounded unknown. The original video extraction cannot be repeated without the camera file.</p><form data-analysis-form="finalize-missing-measurements"><input type="hidden" name="run_id" value="${escapeHtml(selectedRunId)}"><input type="hidden" name="profile_id" value="${escapeHtml(selectedProfile?.profileId ?? '')}">${noteField('Reason', 'reason', '', 'Explain why the original camera file is unavailable. The dated reason is retained with this immutable analysis revision.', {required: true})}<button type="submit"${unavailable(busy || !selectedProfile)}>Finalize with missing measurements</button></form></section>` : '')
    + (selectedAnalysis ? macAnalysisResult(selectedAnalysis, selectedRunId, tag) : '')
    + (selectedRunId && videos.length ? `<section class="panel"><h2>Annotated tracking video</h2><p>Export all or part of the selected camera video using the saved profile and original source cadence. Dots and lines show actual accepted tracks; red crosses show rejected matches.</p>${annotationEndSeconds === null ? '<p class="error-text">The selected video length is unavailable. Reopen the run to load its retained frame timeline.</p>' : `<p class="field-help">${escapeHtml(annotationEndSeconds)} seconds available in the selected video.</p>`}<form data-analysis-form="export-annotated-clip">${selectField('Camera video', 'recording_id', videos.map(item => [item.recordingId, item.name]), selectedVideo?.recordingId)}${field('Start in video (seconds)', 'start_seconds', 0, {type: 'number', min: 0, max: annotationEndSeconds, required: true})}${field('Duration (seconds)', 'duration_seconds', annotationEndSeconds ?? '', {type: 'number', min: 0, max: annotationEndSeconds, required: true, help: 'Enter a positive duration. The selected range must stay within the video.'})}${field('Display vector magnification (times)', 'display_magnification', 10, {type: 'number', min: 0, max: 100, required: true, help: 'Display only. Actual tracked positions and scientific results do not change.'})}<button type="submit"${unavailable(busy || annotationEndSeconds === null)}>Export annotated video</button></form>${annotationJobs.filter(item => item.runId === selectedRunId).map(item => `<article class="job"><p>${escapeHtml(item.status)} · ${escapeHtml(item.profileId)}</p>${item.error ? `<p class="error-text">${escapeHtml(item.error)}</p>` : ''}${item.artifactUrl ? `<a href="${escapeHtml(item.artifactUrl)}" download>Save annotated clip</a><p>${escapeHtml(item.frames)} frames · ${escapeHtml(item.frameRate)} frames/second</p>` : ''}</article>`).join('')}</section>` : '')
    + `<section class="panel"><h2>Accumulating Tree series</h2><form data-analysis-form="select-series">${selectField('Accumulating series', 'series_id', seriesOptions, selectedSeriesId ?? '')}<button type="submit"${unavailable(busy)}>Open series</button></form><p>${escapeHtml(currentSeries?.seriesLabel ?? 'Independent preparation recordings')}</p><p>One selected revision per recording contributes in actual collection order. Every generated target remains, including undelivered instructions. A named series uses its imported hosted inventory to hold later results behind missing earlier recordings. Independent recordings include only locally imported runs.</p><div class="button-row"><button type="button" data-analysis-operation="export-report"${unavailable(busy)}>Export readable results</button></div>${currentSeries?.action ? `<p class="error-text">${escapeHtml(currentSeries.action)}</p>` : ''}${currentSeries?.report ? renderTreeResults(currentSeries) : '<p class="empty-state">No analyzed recording yet.</p>'}</section>`
    + publicationControls({selectedSeriesId, seriesDetail, publicationJobs, busy})
    + renderComparisonSection({candidates: comparisonCandidates, saved: savedComparisons, selected: selectedComparison,
        leftProfileId: comparisonLeftProfileId, rightProfileId: comparisonRightProfileId, busy});
}
