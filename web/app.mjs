import {HOSTED_APP_BASE, LEGACY_HOSTED_BASE, HOSTED_API_BASE, LOCAL_ANALYSIS_BASE, LOCAL_ANALYSIS_API} from './study-paths.mjs';
import {operatorModel, createActionRunner} from './operator-model.mjs';
import {PAGES, renderPage, renderMacAnalysisPage, renderMacResultPage, renderMacComparisonResultPage, renderMacProgress, renderMacError, selectedClockVideo} from './views.mjs';
import {EXPERIMENT, defaultConfig, validateConfig, copyForRepeat} from './run-config.mjs';
import {createCuePlayer, createRunConnection, createInstructionScreenLock} from './cues.mjs';
import {measureClock, clockReferenceDisplay, startClockRedraw} from './clock.mjs';
import {mountTreeCharts} from './tree-results.mjs';

export function hostedApiPath(path) {
  if (typeof path !== 'string' || /^(?:\/|[a-z]+:)/i.test(path) || path.split('/').includes('..')) {
    throw new Error('Use an experiment-relative API path.');
  }
  return `${HOSTED_API_BASE}${path}`;
}

export function hostedBookmarkRun(location, savedRunId) {
  return new URLSearchParams(location.search ?? '').get('run') || savedRunId || null;
}

export function applicationSurface(pathname) {
  if ([HOSTED_APP_BASE, HOSTED_APP_BASE.slice(0, -1), LEGACY_HOSTED_BASE + 'app/', LEGACY_HOSTED_BASE + 'app', EXPERIMENT.basePath, EXPERIMENT.basePath.slice(0, -1)].includes(pathname)) return 'hosted';
  if (pathname.startsWith(LOCAL_ANALYSIS_BASE)) return 'analysis';
  return 'legacy';
}

export function createHostedTransport(fetcher = globalThis.fetch) {
  return async (method, path, body) => {
    const url = hostedApiPath(path);
    let response;
    try {
      response = await fetcher(url, {
        method, credentials: 'same-origin', cache: 'no-store',
        ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
      });
    } catch (cause) {
      const error = new Error(`The study service did not acknowledge ${method} ${path}. Check the connection and retry the same action.`, {cause});
      error.uncertain = method !== 'GET';
      throw error;
    }
    let result;
    try { result = await response.json(); }
    catch (cause) {
      const error = new Error(`The study service returned an unreadable response for ${method} ${path}.`, {cause});
      error.uncertain = method !== 'GET';
      throw error;
    }
    if (!response.ok) {
      const details = result?.error ?? result;
      const error = new Error(details?.message ?? `Study request failed (${response.status}).`);
      error.code = details?.code ?? null;
      error.status = response.status;
      error.definitive = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
      error.uncertain = !error.definitive && method !== 'GET';
      throw error;
    }
    return result;
  };
}

export function registrationRecoveryNotice(receipt) {
  return receipt?.accepted === false && !receipt.pending && !receipt.error && receipt.registration?.status === 'confirmed' &&
    ['stopped', 'failed', 'completed'].includes(receipt.state?.lifecycle)
    ? 'Start registration recovered. The sequence remains stopped; timing will not restart.' : null;
}

export function createHostedActionSender(request, runId) {
  if (!runId) throw new Error('Open a run before sending an action.');
  return async (kind, payload, actionId) => {
    const receipt = await request('POST', `runs/${encodeURIComponent(runId)}/actions`, {
      actionId, kind, clientAtMs: payload.clientAtMs, deviceId: payload.deviceId, data: payload.data ?? {},
    });
    const recoveryNotice = kind === 'start' && registrationRecoveryNotice(receipt);
    if (recoveryNotice) return {...receipt, notice: recoveryNotice};
    if (receipt?.accepted === false) {
      const error = new Error(receipt.error?.message ?? (receipt.pending ? 'The action is pending on the server. Retry the retained action.' : receipt.reason || 'The action was rejected.'));
      error.uncertain = receipt.pending === true;
      error.definitive = !error.uncertain;
      error.pendingRegistration = kind === 'start' && Boolean(receipt.registration);
      error.receipt = receipt;
      throw error;
    }
    return receipt;
  };
}

export function cueEventData(event, clockReference, deviceId, playbackToken) {
  const data = {cueId: event.cueId, deviceId, playbackToken};
  if (event.reason) data.reason = event.reason;
  if (event.afterStart) data.afterStart = true;
  if (clockReference?.valid && Number.isFinite(clockReference.offsetMs) && Number.isFinite(event.clientAtMs)) {
    const serverAtMs = event.clientAtMs + clockReference.offsetMs;
    if (event.kind === 'cuePlayed') data.playedAtMs = serverAtMs;
    if (event.kind === 'cueEnded') data.endedAtMs = serverAtMs;
    data.clockExchangeId = clockReference.selected.exchangeId;
    data.clockUncertaintyMs = clockReference.uncertaintyMs;
    data.clockSegment = clockReference.segment ?? 0;
  }
  return data;
}

export function cueReceiptActionId(cueId, kind) {
  if (!['testAudioPlayed', 'cuePlayed', 'cueEnded', 'cueFailed'].includes(kind)) {
    throw new Error('Unknown spoken cue receipt type.');
  }
  const actionId = `${cueId}-${kind}`;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(actionId)) throw new Error('Spoken cue receipt needs a valid server action ID.');
  return actionId;
}

export function createCueReceiptQueue({request, storage, keyFor, onReceipt = () => {}, onChanged = () => {}}) {
  if (typeof request !== 'function' || !storage?.getItem || !storage?.setItem || typeof keyFor !== 'function') {
    throw new TypeError('Cue receipts need a request service and persistent storage.');
  }
  const active = new Map();
  const pending = runId => {
    let saved;
    try { saved = storage.getItem(keyFor(runId)); }
    catch { throw new Error(`Run ${runId}: retained cue receipts could not be read from this phone. Keep this run open and resolve storage access.`); }
    if (!saved) return [];
    let parsed;
    try { parsed = JSON.parse(saved); }
    catch { throw new Error(`Run ${runId}: retained cue receipts could not be decoded. Keep the original data and inspect this run before continuing.`); }
    if (!Array.isArray(parsed) || parsed.some(record => !record || typeof record.actionId !== 'string')) {
      throw new Error(`Run ${runId} has unreadable retained cue receipts.`);
    }
    return parsed;
  };
  const save = (runId, records) => {
    if (records.length) storage.setItem(keyFor(runId), JSON.stringify(records));
    else storage.removeItem(keyFor(runId));
    onChanged(runId);
  };
  const flush = runId => {
    if (active.has(runId)) return active.get(runId);
    const task = (async () => {
      while (true) {
        const first = pending(runId)[0];
        if (!first) return;
        const receipt = await request('POST', `runs/${encodeURIComponent(runId)}/actions`, first);
        onReceipt(receipt);
        save(runId, pending(runId).filter(record => record.actionId !== first.actionId));
      }
    })();
    active.set(runId, task);
    const release = () => { if (active.get(runId) === task) active.delete(runId); };
    void task.then(release, release);
    return task;
  };
  const append = (runId, record) => {
    const records = pending(runId);
    const previous = records.find(item => item.actionId === record.actionId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
      throw new Error(`Run ${runId} cue receipt ${record.actionId} changed after it was retained.`);
    }
    if (!previous) save(runId, [...records, record]);
    return flush(runId);
  };
  return {append, flush, pending};
}

export function readyRefreshDelay(ready, serverNowMs) {
  const boundary = ready?.reason === 'baseline_incomplete' ? ready.readyAtMs
    : ready?.allowed === true ? ready.cutoffAtMs : null;
  if (!Number.isFinite(boundary)) return null;
  return Number.isFinite(serverNowMs) ? Math.max(1000, boundary - serverNowMs + 250) : 1000;
}

export function shouldOfferEventRetry(pending, busy) {
  return Boolean(pending) && !busy;
}

export function filmedClockDisplay(reference, phoneAtMs, phoneMonotonicAtMs) {
  if (!Number.isFinite(phoneMonotonicAtMs) || phoneMonotonicAtMs < 0) {
    throw new Error('The phone monotonic clock is unavailable for the filmed reference.');
  }
  return {...clockReferenceDisplay(reference, phoneAtMs),
    phoneMonotonicAtMs: Math.round(phoneMonotonicAtMs * 1000) / 1000};
}

export function refreshFilmedClock(root, display) {
  if (!display) return;
  const values = {
    'server-date': display.serverTimeText.slice(0, 10),
    'server-time': `${display.serverTimeText.slice(11, -1)} UTC`,
    'phone-date': display.phoneTimeText.slice(0, 10),
    'phone-time': `${display.phoneTimeText.slice(11, -1)} UTC`,
    'phone-monotonic': `${display.phoneMonotonicAtMs} ms`,
  };
  for (const element of root.querySelectorAll('[data-clock-field]')) {
    element.textContent = values[element.dataset.clockField] ?? element.textContent;
  }
}

export function loadStored(storage, key) {
  try { return storage.getItem(key); }
  catch (cause) {
    console.warn(`Tree study storage read failed for ${key}.`, cause);
    throw new Error(`Recovery data ${key} could not be read. Keep this run open and resolve storage access.`, {cause});
  }
}

export function persistStored(storage, key, value) {
  try { if (value == null) storage.removeItem(key); else storage.setItem(key, value); }
  catch (cause) {
    console.warn(`Tree study storage write failed for ${key}.`, cause);
    throw new Error(`Recovery data ${key} could not be ${value == null ? 'removed' : 'saved'}. Keep this run open and resolve storage access.`, {cause});
  }
}

export function missingRunRecovery(error, selectedRunId, storage, selectionKey) {
  if (error?.status !== 404 || error?.code !== 'run_not_found') return null;
  persistStored(storage, selectionKey, null);
  return {runId: null, connected: true, lifecycle: 'draft',
    notice: `Previously selected run ${selectedRunId} is no longer on the service. Open another saved run or create a new run.`};
}

export function reconnectionNotice(previousRunId, currentRunId) {
  if (previousRunId && !currentRunId) return null;
  return currentRunId ? 'Shared run reconnected. Check the current instruction before acting.' : 'Study service reconnected.';
}

export function updateRunHistory(runs, currentRun) {
  if (!currentRun?.runId) return runs;
  return runs.map(run => run.runId === currentRun.runId ? {...run, ...currentRun} : run);
}

function settingSeconds(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a nonnegative finite number of seconds.`);
  return number;
}

export function runConfigFromFields(fields, previous = defaultConfig(fields.mode || 'tree')) {
  const mode = fields.mode || previous.mode;
  const purpose = fields.purpose || previous.purpose;
  const config = structuredClone(previous);
  config.mode = mode;
  config.purpose = purpose;
  const seconds = (name, fallback, label) => settingSeconds(fields[name], fallback, label);
  config.tree.preRollSeconds = seconds('tree_pre_roll', config.tree.preRollSeconds, 'Tree pre-roll');
  config.tree.responseSeconds = seconds('tree_response', config.tree.responseSeconds, 'Tree response');
  config.tree.recoverySeconds = seconds('tree_recovery', config.tree.recoverySeconds, 'Tree recovery');
  config.tree.postRollSeconds = seconds('tree_post_roll', config.tree.postRollSeconds, 'Tree post-roll');
  config.tree.count = fields.tree_count === undefined ? config.tree.count : wholeField(fields.tree_count, 'Tree count', 1);
  config.tree.announceRelease = config.tree.recoverySeconds > 0 && (fields.tree_release === undefined ? config.tree.announceRelease : fields.tree_release === 'on');
  for (const [field, key] of [['site_id', 'siteId'], ['setup_id', 'setupId'], ['series_id', 'seriesId']]) {
    if (Object.hasOwn(fields, field)) config[key] = fields[field] || null;
  }
  return validateConfig(config);
}

export function repeatRunRequest(previousRun, changes = {}) {
  if (!previousRun?.config) throw new Error('A saved run configuration is required for Repeat.');
  return {config: copyForRepeat(previousRun.config, changes)};
}

export function positionRecord(role, position, deviceId) {
  if (!['practice', 'waiting', 'departure'].includes(role)) throw new Error('Choose a named site position.');
  const {latitude, longitude, accuracy} = position?.coords ?? {};
  const capturedAtMs = position?.timestamp;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(accuracy) || accuracy < 0 || !Number.isFinite(capturedAtMs)) {
    throw new Error('The browser did not return a valid position with accuracy and time.');
  }
  if (!deviceId) throw new Error('A device identity is required for a saved position.');
  return {role, latitude, longitude, accuracyMetres: accuracy, capturedAtMs, deviceId};
}

export async function saveSitePosition({role, label, siteId, deviceId, getPosition, request}) {
  if (typeof getPosition !== 'function' || typeof request !== 'function') throw new Error('Location and site service are required.');
  const position = positionRecord(role, await getPosition(), deviceId);
  if (!siteId && !label?.trim()) throw new Error('Name the site before saving its first position.');
  return request('POST', siteId ? `sites/${encodeURIComponent(siteId)}/revisions` : 'sites',
    siteId ? {positions: {[role]: position}} : {label: label.trim(), positions: {[role]: position}});
}

export function distanceMetres(first, second) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitude = radians(second.latitude - first.latitude);
  const longitude = radians(second.longitude - first.longitude);
  const middle = Math.sin(latitude / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitude / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(middle)));
}

export function namedSiteDistances(positions = {}) {
  const practice = positions.practice;
  return {
    waitingToPractice: practice && positions.waiting ? Math.round(distanceMetres(positions.waiting, practice)) : null,
    departureToPractice: practice && positions.departure ? Math.round(distanceMetres(positions.departure, practice)) : null,
  };
}

export function siteDraftForRun(previousRunId, nextRunId, draft) {
  return previousRunId === nextRunId ? draft : {label: '', positions: {}};
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  return cross(a, b, p) === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

function edgesIntersect(a, b, c, d) {
  const first = cross(a, b, c); const second = cross(a, b, d);
  const third = cross(c, d, a); const fourth = cross(c, d, b);
  return (first === 0 && onSegment(a, b, c)) || (second === 0 && onSegment(a, b, d)) ||
    (third === 0 && onSegment(c, d, a)) || (fourth === 0 && onSegment(c, d, b)) ||
    (first > 0 !== second > 0 && third > 0 !== fourth > 0);
}

function containsPoint(polygon, point) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous], b = polygon[index];
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function polygonsOverlap(first, second) {
  for (let left = 0; left < first.length; left++) for (let right = 0; right < second.length; right++) {
    if (edgesIntersect(first[left], first[(left + 1) % first.length], second[right], second[(right + 1) % second.length])) return true;
  }
  return containsPoint(first, second[0]) || containsPoint(second, first[0]);
}

export function cameraSetupFromFields({imageSha256, imageSize, cameraProfile, regions, retrospective = false}) {
  if (!/^[a-f0-9]{64}$/i.test(imageSha256 ?? '')) throw new Error('A hashed setup image is required.');
  const {width, height} = imageSize ?? {};
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) throw new Error('The setup image needs its pixel dimensions.');
  if (!cameraProfile?.trim()) throw new Error('Record the locked camera setup.');
  const normalized = {};
  for (const [source, target] of [['A', 'A'], ['B', 'B'], ['background_1', 'background']]) {
    const points = regions?.[source]?.points ?? regions?.[source] ?? regions?.[target]?.points ?? regions?.[target];
    if (!Array.isArray(points) || points.length < 3) throw new Error(`${target} needs at least three polygon vertices.`);
    if (points.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isSafeInteger) || point[0] < 0 || point[0] >= width || point[1] < 0 || point[1] >= height)) throw new Error(`${target} polygon is outside image bounds.`);
    const area = points.reduce((sum, point, index) => sum + point[0] * points[(index + 1) % points.length][1] - points[(index + 1) % points.length][0] * point[1], 0);
    if (area === 0) throw new Error(`${target} polygon has zero area.`);
    normalized[target] = points.map(point => [...point]);
  }
  for (const [first, second] of [['A', 'B'], ['A', 'background'], ['B', 'background']]) {
    if (polygonsOverlap(normalized[first], normalized[second])) throw new Error(`${first} and ${second} polygons overlap.`);
  }
  return {imageSha256, imageSize: {width, height}, cameraProfile: cameraProfile.trim(), regions: normalized, retrospective: Boolean(retrospective)};
}

export function hostedRegionsFromFields(fields) {
  const regions = {};
  for (const name of ['A', 'B', 'background_1']) {
    const parsed = maskPointDraft(fields[`masks.${name}.points`]);
    if (parsed.error) throw new Error(`${name}: ${parsed.error}`);
    if (parsed.points.length < 3) throw new Error(`${name} needs at least three vertices.`);
    regions[name] = {points: parsed.points};
  }
  return regions;
}

function wholeField(value, label, minimum = 0) {
  const parsed = Number(value);
  if (String(value ?? '').trim() === '' || !Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} must be a whole number of at least ${minimum}.`);
  return parsed;
}

function timeMsField(value, label) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return wholeField(text, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error(`${label} needs the filmed UTC timestamp or epoch milliseconds.`);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp.`);
  return parsed;
}

export function timeMapFromFields(fields) {
  const tree = fields.mode === 'tree';
  const windRecordingId = tree ? null : fields.wind_recording_id || null;
  const phoneMonotonicAtMs = side => {
    const text = String(fields[`${side}_monotonic`] ?? '').trim();
    if (!text) {
      if (windRecordingId) throw new Error(`${side} phone monotonic reading is required for wind timing.`);
      return null;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${side} phone monotonic reading must be a nonnegative number of milliseconds.`);
    return value;
  };
  const reference = side => ({
    frameIndex: wholeField(fields[`${side}_frame`], `${side} frame`),
    serverDisplayedAtMs: timeMsField(fields[`${side}_server`], `${side} server time`),
    clockUncertaintyMs: nonnegativeField(fields[`${side}_clock_uncertainty`], `${side} clock uncertainty`),
    ...(tree ? {} : {
      phoneDisplayedAtMs: timeMsField(fields[`${side}_phone`], `${side} phone time`),
      frameSelectionUncertaintyMs: wholeField(fields[`${side}_frame_uncertainty`], `${side} frame uncertainty`),
      phoneMonotonicAtMs: phoneMonotonicAtMs(side),
    }),
  });
  const references = [reference('before'), reference('after')];
  if (references[1].frameIndex <= references[0].frameIndex) throw new Error('The closing clock reference needs a later frame.');
  return {
    runId: fields.run_id, videoRecordingId: fields.video_recording_id,
    windRecordingId, references,
    csvMetadata: windRecordingId ? {
      timestampFormat: fields.timestamp_format || '%Y-%m-%d %H:%M:%S.%f',
      utcOffsetMinutes: wholeField(fields.utc_offset_minutes, 'CSV UTC offset', -840),
      timestampResolutionMs: wholeField(fields.timestamp_resolution_ms, 'CSV timestamp resolution', 1),
    } : null,
  };
}

function nonnegativeField(value, label) {
  const number = Number(value);
  if (String(value ?? '').trim() === '' || !Number.isFinite(number) || number < 0) throw new Error(`${label} must be a nonnegative number.`);
  return number;
}

export function framePickerSelection(value, step, frameCount = null) {
  const index = wholeField(value, 'Frame number') + step;
  if (!Number.isSafeInteger(index) || index < 0 || frameCount != null && index >= frameCount) throw new Error('Choose a frame within this camera recording.');
  return index;
}

export function obstructionReviewFromFields(fields) {
  if (!fields.run_id || !fields.video_recording_id) throw new Error('Choose the run and camera video for this review.');
  if (!['clear', 'obstructed'].includes(fields.decision)) throw new Error('Choose whether the target regions remained clear.');
  const lines = String(fields.spans ?? '').trim().split(/\r?\n/).filter(Boolean);
  if (fields.decision === 'clear' && lines.length) throw new Error('Clear footage cannot include obstructed spans.');
  if (fields.decision === 'obstructed' && !lines.length) throw new Error('Enter each obstructed frame span.');
  const spans = lines.map((line, index) => {
    const pair = line.split(',').map(value => value.trim());
    if (pair.length !== 2) throw new Error(`Obstructed span ${index + 1} needs start and end frame numbers.`);
    const startFrameIndex = wholeField(pair[0], `Span ${index + 1} start frame`);
    const endFrameIndex = wholeField(pair[1], `Span ${index + 1} end frame`);
    if (endFrameIndex < startFrameIndex) throw new Error(`Span ${index + 1} end frame must follow its start frame.`);
    return {startFrameIndex, endFrameIndex};
  });
  return {runId: fields.run_id, videoRecordingId: fields.video_recording_id, decision: fields.decision, spans};
}

export function seriesRequestFromFields(fields) {
  return {label: String(fields.label ?? '').trim() || 'Tree sequence', config: defaultConfig('tree')};
}

export function startStreamFromFields(fields) {
  const value = String(fields.stream_url ?? '').trim();
  if (!URL.canParse(value)) throw new Error('Enter a valid HTTPS streaming link.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Enter a valid HTTPS streaming link without credentials.');
  return {streamUrl: url.href};
}

export function startIssueFromFields(fields) {
  const category = fields.category, reason = String(fields.reason ?? '').trim();
  if (!['recording_partial', 'recording_unavailable', 'analysis_failed', 'publication_failed', 'correction', 'resolved'].includes(category)) throw new Error('Select an issue category.');
  if (!reason || reason.length > 4000) throw new Error('Enter a nonempty reason of at most 4000 characters.');
  const previousIssueId = ['correction', 'resolved'].includes(category) ? fields.previous_issue_id || null : null;
  if (['correction', 'resolved'].includes(category) && !previousIssueId) throw new Error('A correction or resolution needs a saved report reference.');
  return {category, reason, ...(String(fields.stream_url ?? '').trim() ? startStreamFromFields(fields) : {}), previousIssueId};
}

export function createTransport(fetcher = globalThis.fetch, basePath = '/api/') {
  return async (path, body) => {
    const requestPath = basePath === '/api/' ? path : `${basePath}${path.replace(/^\/api\//, '')}`;
    let response;
    try {
      response = await fetcher(requestPath, body === undefined ? {cache: 'no-store'} : {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-Study-App': 'tree-targeting-v2'},
        body: JSON.stringify(body),
      });
    } catch (cause) {
      const error = new Error('The local service did not acknowledge this request. Reconnect and retry the retained request; its outcome is unconfirmed.', {cause});
      error.uncertain = body !== undefined;
      throw error;
    }
    let result;
    try { result = await response.json(); }
    catch (cause) { throw new Error('The local service returned an unreadable response. The request outcome is unconfirmed; reconnect before continuing.', {cause}); }
    const failedPublicationJob = body === undefined && typeof result.jobId === 'string' &&
      path === `/api/publication/${result.jobId}` && result.status === 'failed';
    if (!response.ok || result.error && !failedPublicationJob) {
      const details = result.error ?? {};
      const error = new Error([details.message ?? `The request failed (${response.status}).`, details.corrective_action, details.recording_id ? `Recording: ${details.recording_id}.` : '', details.session_id ? `Session: ${details.session_id}.` : ''].filter(Boolean).join(' '));
      error.definitive = true;
      error.operation = details.operation;
      throw error;
    }
    return result;
  };
}

function finiteNumber(value, label) {
  if (String(value).trim() === '') throw new Error(`${label} is required.`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`);
  return number;
}

export function mappingFromFields(fields) {
  const timestampFormat = fields.timestamp_format === 'custom' ? fields.time_pattern?.trim() : fields.timestamp_format;
  const mapping = {
    timestamp_column: fields.timestamp_column?.trim(), speed_column: fields.speed_column?.trim(),
    speed_unit: fields.speed_unit, timestamp_format: timestampFormat, timezone: fields.timezone?.trim(),
  };
  for (const [key, value] of Object.entries(mapping)) if (!value) throw new Error(`${key.replaceAll('_', ' ')} is required. Verify it against the original CSV.`);
  for (const [column, values] of [['status_column', 'valid_statuses'], ['freshness_column', 'fresh_values']]) {
    if (fields[column]?.trim()) {
      mapping[column] = fields[column].trim();
      mapping[values] = String(fields[values] ?? '').split(/[,;\n]+/).map(value => value.trim()).filter(Boolean);
      if (!mapping[values].length) throw new Error(`Declare the accepted values for ${mapping[column]}.`);
    }
  }
  return mapping;
}

function referenceTime(value, label) {
  const text = String(value ?? '').trim();
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return finiteNumber(text, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error(`${label} needs a dated UTC or explicit-timezone timestamp, or epoch seconds. No local timezone is assumed.`);
  const result = Date.parse(text) / 1000;
  if (!Number.isFinite(result)) throw new Error(`${label} is not a valid timestamp.`);
  return result;
}

export function clockMapFromFields(fields) {
  return {
    references: [
      {device_time: referenceTime(fields.before_device, 'Before device time'), study_time: referenceTime(fields.before_study, 'Before study time')},
      {device_time: referenceTime(fields.after_device, 'After device time'), study_time: referenceTime(fields.after_study, 'After study time')},
    ],
    residual_uncertainty_seconds: finiteNumber(fields.uncertainty, 'Reference uncertainty'),
  };
}

export function globalAudioAnnotationFromFields(fields) {
  if (!fields.cue_id?.trim()) throw new Error('Choose a previously emitted global cue.');
  if (!fields.provenance?.trim()) throw new Error('Identify the original recording and timing reference used.');
  return {cue_id: fields.cue_id, cue_at: referenceTime(fields.cue_at, 'Actual global cue onset'), provenance: {reference: fields.provenance.trim()}};
}

export function masksFromFields(fields) {
  return Object.fromEntries(['A', 'B', 'background_1', 'background_2'].map(region => {
    if (Object.hasOwn(fields, `masks.${region}.points`)) {
      const draft = maskPointDraft(fields[`masks.${region}.points`]);
      if (draft.error) throw new Error(`${region}: ${draft.error}`);
      if (draft.points.length < 3) throw new Error(`${region} needs at least three polygon vertices.`);
      return [region, {points: draft.points}];
    }
    return [region, Object.fromEntries(['x', 'y', 'width', 'height'].map(key => {
      const value = finiteNumber(fields[`masks.${region}.${key}`], `${region} ${key}`);
      if (!Number.isInteger(value) || value < 0 || (['width', 'height'].includes(key) && value === 0)) throw new Error('Mask coordinates must be nonnegative whole pixels, with positive width and height.');
      return [key, value];
    }))];
  }));
}

function maskPointDraft(text) {
  const points = [];
  for (const line of String(text ?? '').split(/[\n;]+/).map(value => value.trim()).filter(Boolean)) {
    const pair = line.split(/[,\s]+/).filter(Boolean).map(Number);
    if (pair.length !== 2 || pair.some(value => !Number.isInteger(value) || value < 0)) return {points: [], error: 'Enter one x, y pair per line using nonnegative whole pixels.'};
    points.push(pair);
  }
  return {points, error: ''};
}

export function renderMaskOverlays(overlays, masks, width, height) {
  const nodes = [];
  let drawing;
  for (const [region, rectangle] of Object.entries(masks)) {
    if (Array.isArray(rectangle.points)) {
      if (!rectangle.points.length || !(width > 0 && height > 0)) continue;
      if (!drawing) {
        drawing = overlays.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
        drawing.setAttribute('class', 'mask-shapes');
        drawing.setAttribute('viewBox', `0 0 ${width} ${height}`);
        drawing.setAttribute('aria-hidden', 'true');
        nodes.push(drawing);
      }
      const shape = overlays.ownerDocument.createElementNS('http://www.w3.org/2000/svg', rectangle.points.length >= 3 ? 'polygon' : 'polyline');
      shape.setAttribute('class', rectangle.points.length >= 3 ? 'mask-polygon' : 'mask-polyline');
      shape.setAttribute('points', rectangle.points.map(point => point.join(',')).join(' '));
      shape.dataset.region = region;
      drawing.append(shape);
      for (const [x, y] of rectangle.points) {
        const vertex = overlays.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
        vertex.setAttribute('class', 'mask-vertex');
        vertex.setAttribute('cx', x); vertex.setAttribute('cy', y); vertex.setAttribute('r', Math.max(2, width / 180));
        vertex.dataset.region = region;
        drawing.append(vertex);
      }
      const label = overlays.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('class', 'mask-label');
      label.setAttribute('x', rectangle.points[0][0]); label.setAttribute('y', rectangle.points[0][1]);
      label.style.fontSize = `${Math.max(12, width / 55)}px`;
      label.textContent = region;
      drawing.append(label);
      continue;
    }
    if (!(rectangle.width > 0 && rectangle.height > 0 && width > 0 && height > 0)) continue;
    const element = overlays.ownerDocument.createElement('span');
    element.className = 'mask-outline';
    element.dataset.region = region;
    element.textContent = region;
    element.style.left = `${rectangle.x / width * 100}%`;
    element.style.top = `${rectangle.y / height * 100}%`;
    element.style.width = `${rectangle.width / width * 100}%`;
    element.style.height = `${rectangle.height / height * 100}%`;
    nodes.push(element);
  }
  overlays.replaceChildren(...nodes);
}

function writeNested(target, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let current = target;
  for (const key of keys) current = current[key] ??= {};
  current[last] = value;
}

function setupFromForm(form, current) {
  const result = structuredClone(current);
  for (const control of form.elements) {
    if (!control.name || control.disabled || control.matches(':disabled')) continue;
    const value = control.type === 'checkbox' ? control.checked : control.type === 'number'
      ? control.value === '' ? null : finiteNumber(control.value, control.name) : control.value.trim() || null;
    writeNested(result, control.name, value);
  }
  return result;
}

export function restoreControlValue(control, saved) {
  if (control.type === 'radio' || control.type === 'checkbox') control.checked = saved.checked;
  else if (control.type !== 'select-one' || Array.from(control.options).some(option => option.value === saved.value)) control.value = saved.value;
}

export function startHostedApplication(document, window) {
  const request = createHostedTransport(window.fetch.bind(window));
  const main = document.getElementById('main');
  const localStorage = window.localStorage;
  const sessionStorage = window.sessionStorage;
  const selectedRunKey = `tree-targeting:selected-run:${EXPERIMENT.slug}`;
  const deviceKey = `tree-targeting:device:${EXPERIMENT.slug}`;
  const playbackKey = runId => `tree-targeting:playback:${EXPERIMENT.slug}:${runId}`;
  const pendingActionKey = runId => `tree-targeting:pending-action:${EXPERIMENT.slug}:${runId}`;
  const pendingCueKey = runId => `tree-targeting:pending-cue:${EXPERIMENT.slug}:${runId}`;
  const readStored = (storage, key) => {
    try { return loadStored(storage, key); }
    catch (error) { showError(error); throw error; }
  };
  const writeStored = (storage, key, value) => {
    try { persistStored(storage, key, value); }
    catch (error) { showError(error); throw error; }
  };
  let deviceId = readStored(localStorage, deviceKey);
  if (!deviceId) { deviceId = window.crypto.randomUUID(); writeStored(localStorage, deviceKey, deviceId); }
  let runId = hostedBookmarkRun(window.location, readStored(localStorage, selectedRunKey));
  let state = {runId, connected: false, lifecycle: 'draft'};
  let page = route();
  let runs = [], sites = [], series = [];
  let editingTagRunId = null;
  let selectedImage = null;
  let savedSetup = null;
  let siteDraft = {label: '', positions: {}};
  let configDraft = defaultConfig('tree');
  let clockReference = null;
  let busy = false, busyOperations = 0;
  let html = '';
  let renderedContext = '';
  let runConnection = null;
  let actionRunner = null;
  let cuePlayer = null;
  let eventSocket = null;
  const cueMetadata = new Map();
  const cueReceipts = createCueReceiptQueue({request, storage: localStorage, keyFor: pendingCueKey,
    onReceipt: acceptReceipt, onChanged: updateRetry});
  let readyRefreshTimer = null;
  let readyRefreshKey = '';
  let inlineError = null;
  const screenLock = createInstructionScreenLock({document, wakeLock: window.navigator?.wakeLock, deviceId,
    onWarning: message => {
      const error = document.getElementById('error');
      if (error.hidden) showError(new Error(message));
      else if (!error.textContent.includes(message)) error.textContent += `\n${message}`;
    }});

  document.querySelectorAll('[data-hosted-only]').forEach(element => { element.hidden = false; });
  document.getElementById('quit').hidden = true;
  document.getElementById('footer-message').textContent = 'Original camera video remains on the Mac. This phone handles the shared run and spoken instructions.';

  function route() { return PAGES.includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'study'; }
  function errorAnchor(source) {
    if (!source) return null;
    const {hostedAction, hostedOperation, hostedInput, runId: sourceRunId, seriesId, slotId, role} = source.dataset;
    if (hostedAction) return {kind: 'action', name: hostedAction};
    if (hostedOperation) return {kind: 'operation', name: hostedOperation, sourceRunId, seriesId, slotId, role};
    if (hostedInput) return {kind: 'input', name: hostedInput};
    const form = source.closest('form[data-hosted-form]');
    return form ? {kind: 'form', name: form.dataset.hostedForm} : null;
  }
  function showError(error, source = null) {
    const message = error?.message ?? String(error);
    const anchor = errorAnchor(source);
    if (anchor) {
      inlineError = {...anchor, message};
      document.getElementById('error').hidden = true;
      html = '';
      return;
    }
    const element = document.getElementById('error');
    element.textContent = message;
    element.hidden = false;
  }
  function clearError() {
    inlineError = null;
    html = '';
    document.getElementById('error').hidden = true;
  }
  function notice(message) { document.getElementById('notice').textContent = message; }
  function actionPayload(data = {}, clientAtMs = Date.now()) { return {clientAtMs, deviceId, data}; }
  function model() { return operatorModel({...state, runId, nowMs: Date.now() + (clockReference?.valid ? clockReference.offsetMs : 0)}); }

  function captureForms() {
    return [...main.querySelectorAll('form')].map(form => [...form.elements].filter(element => element.name).map(element => ({name: element.name, value: element.value, checked: element.checked, type: element.type})));
  }
  function restoreForms(snapshot) {
    [...main.querySelectorAll('form')].forEach((form, index) => snapshot[index]?.forEach(saved => {
      const control = [...form.elements].find(element => element.name === saved.name && element.type === saved.type && (element.type !== 'radio' || element.value === saved.value));
      if (control && control.type !== 'file') restoreControlValue(control, saved);
    }));
  }
  function render() {
    const current = model();
    current.actionError = inlineError?.kind === 'action' ? {action: inlineError.name, message: inlineError.message} : null;
    void screenLock.update(state);
    scheduleReadyRefresh();
    document.getElementById('study-identity').textContent = runId ? [current.tag, runId].filter(Boolean).join(' · ') : 'No run selected';
    document.getElementById('mode-label').textContent = current.mode ? `${current.mode} · ${current.purpose}` : 'Study';
    const connection = document.getElementById('connection');
    connection.textContent = current.connection.message;
    connection.classList.toggle('disconnected', !current.connection.connected);
    document.querySelectorAll('.app-navigation a').forEach(link => {
      if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const clockDisplay = clockReference?.valid ? filmedClockDisplay(clockReference, Date.now(), window.performance.now()) : null;
    const selectedSiteId = siteDraft.siteId ?? state.config?.siteId;
    const selectedSite = sites.find(site => site.siteId === selectedSiteId);
    const sitePositions = {...selectedSite?.revisions?.at(-1)?.positions, ...siteDraft.positions};
    const next = renderPage(page, {hosted: true, model: current, state, runs, sites, series, config: configDraft,
      selectedImage, savedSetup, editingTagRunId, siteDraft, siteDistances: namedSiteDistances(sitePositions), clockDisplay, busy});
    const context = `${runId ?? ''}|${page}|${editingTagRunId ?? ''}`;
    if (next === html) return;
    const snapshot = renderedContext === context ? captureForms() : null;
    main.innerHTML = next;
    html = next;
    renderedContext = context;
    if (snapshot) restoreForms(snapshot);
    bindHostedMasks();
    if (inlineError && inlineError.kind !== 'action') {
      const target = [...main.querySelectorAll('button, input')].find(element => {
        const data = element.dataset;
        if (inlineError.kind === 'operation') return data.hostedOperation === inlineError.name &&
          data.runId === inlineError.sourceRunId && data.seriesId === inlineError.seriesId &&
          data.slotId === inlineError.slotId && data.role === inlineError.role;
        if (inlineError.kind === 'input') return data.hostedInput === inlineError.name;
        return element.type === 'submit' && element.form?.dataset.hostedForm === inlineError.name;
      });
      if (target) {
        const message = document.createElement('p');
        message.className = 'field-help error-text inline-action-error';
        message.setAttribute('role', 'alert');
        message.textContent = inlineError.message;
        target.insertAdjacentElement('afterend', message);
      } else {
        const element = document.getElementById('error');
        element.textContent = inlineError.message;
        element.hidden = false;
      }
    }
  }

  function scheduleReadyRefresh() {
    const serverNowMs = clockReference?.valid ? Date.now() + clockReference.offsetMs : null;
    const delay = state.connected && runId ? readyRefreshDelay(state.ready, serverNowMs) : null;
    const key = delay === null ? '' : `${runId}:${state.ready.readyAtMs}:${state.ready.reason}`;
    if (key === readyRefreshKey && readyRefreshTimer !== null) return;
    if (readyRefreshTimer !== null) window.clearTimeout(readyRefreshTimer);
    readyRefreshTimer = null;
    readyRefreshKey = key;
    if (delay === null) return;
    const selectedId = runId;
    readyRefreshTimer = window.setTimeout(async () => {
      readyRefreshTimer = null;
      readyRefreshKey = '';
      try {
        const latest = await request('GET', `runs/${encodeURIComponent(selectedId)}`);
        if (runId === selectedId) { state = {...state, ...latest}; render(); }
      } catch (error) {
        console.warn(`Run ${selectedId}: Ready eligibility could not be refreshed; retrying from server state.`, error);
        if (runId === selectedId) { showError(error); scheduleReadyRefresh(); }
      }
    }, delay);
  }

  function updateRetry() {
    const element = document.getElementById('retry');
    const pending = actionRunner?.pending() || (runId ? readStored(localStorage, pendingCueKey(runId)) : null);
    const offer = shouldOfferEventRetry(pending, busy);
    element.hidden = !offer;
    element.innerHTML = offer ? '<p>A run event has not been acknowledged. Retry keeps its original identity.</p><button type="button" id="retry-request">Retry unconfirmed event</button>' : '';
    element.querySelector('button')?.addEventListener('click', () => void perform(async () => {
      let receipt;
      if (actionRunner?.pending()) {receipt = await actionRunner.retry(); acceptReceipt(receipt);}
      else await retryCueEvents();
      notice(receipt?.notice ?? 'Retained event acknowledged.');
    }));
  }

  function newActionRunner(selectedId) {
    let pending = null;
    const stored = readStored(sessionStorage, pendingActionKey(selectedId));
    if (stored) {
      try { pending = JSON.parse(stored); }
      catch (error) { console.warn(`Run ${selectedId}: retained action could not be parsed.`, error); showError(new Error('An unconfirmed action could not be recovered. Check the run history before proceeding.')); }
    }
    actionRunner = createActionRunner(createHostedActionSender(request, selectedId), () => window.crypto.randomUUID(), pending,
      next => { writeStored(sessionStorage, pendingActionKey(selectedId), next ? JSON.stringify(next) : null); updateRetry(); });
    updateRetry();
  }

  function acceptReceipt(receipt) {
    if (receipt?.state?.runId === runId) state = {...state, ...receipt.state, connected: true};
    if (receipt?.playbackToken && runId) {
      writeStored(localStorage, playbackKey(runId), receipt.playbackToken);
      if (eventSocket?.readyState === 1) eventSocket.send(JSON.stringify({kind: 'playbackAuth', deviceId, playbackToken: receipt.playbackToken}));
    }
    if (receipt?.accepted === false && !registrationRecoveryNotice(receipt)) throw new Error(receipt.reason || 'The action was not accepted.');
    render();
  }

  async function submitAction(kind, data = {}, clientAtMs = Date.now()) {
    if (!actionRunner) throw new Error('Open a run before sending an action.');
    const receipt = await actionRunner.run(kind, actionPayload(data, clientAtMs));
    acceptReceipt(receipt);
    return receipt;
  }

  async function measureRunClock(retain = false) {
    clockReference = await measureClock({exchange: () => request('GET', 'clock'), wallNow: Date.now,
      monotonicNow: () => window.performance.now(), previousReference: clockReference});
    if (!clockReference.valid) throw new Error(clockReference.error);
    if (retain) await submitAction('saveClockReference', {reference: clockReference, deviceId});
  }

  async function recordCueEvent(event) {
    const selectedId = event.runId;
    const metadata = cueMetadata.get(event.cueId);
    const token = readStored(localStorage, playbackKey(selectedId));
    if (!token || !metadata || metadata.deviceId !== deviceId || metadata.runId !== selectedId) {
      throw new Error('This phone is not the designated speaker for this cue.');
    }
    const kind = metadata.kind === 'testAudio' && event.kind === 'cuePlayed' ? 'testAudioPlayed' : event.kind;
    const record = {
      actionId: cueReceiptActionId(event.cueId, kind), kind, clientAtMs: event.clientAtMs, deviceId,
      data: cueEventData(event, clockReference, deviceId, token),
    };
    await cueReceipts.append(selectedId, record);
  }

  async function retryCueEvents() {
    if (!runId) return;
    await cueReceipts.flush(runId);
    updateRetry();
  }

  function connectEvents(selectedId) {
    return ({onCue, onState, onClose, onError}) => {
      const url = new window.URL(hostedApiPath(`runs/${encodeURIComponent(selectedId)}/events`), window.location.origin);
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new window.WebSocket(url);
      let active = true;
      eventSocket = socket;
      socket.addEventListener('open', () => {
        if (!active) return;
        try {
          const playbackToken = readStored(localStorage, playbackKey(selectedId));
          if (playbackToken) socket.send(JSON.stringify({kind: 'playbackAuth', deviceId, playbackToken}));
        } catch (error) { onError(error); }
      });
      socket.addEventListener('message', message => {
        if (!active) return;
        let event;
        try { event = JSON.parse(message.data); }
        catch (error) { console.warn(`Run ${selectedId}: unreadable event message.`, error); showError(new Error('The live run sent an unreadable event. Reconnect before acting.')); return; }
        if (event.kind === 'state') onState(event.state);
        else if (event.kind === 'cue') onCue(event.cue);
        else if (event.kind === 'playbackReady') notice('This phone is ready to speak run instructions.');
      });
      socket.addEventListener('close', () => { if (eventSocket === socket) eventSocket = null; if (active) onClose(); });
      socket.addEventListener('error', error => { if (active) onError(error); });
      return {close() { active = false; if (eventSocket === socket) eventSocket = null; socket.close(); }};
    };
  }

  async function selectRun(selectedId) {
    if (!selectedId) throw new Error('Select a saved run.');
    runConnection?.stop();
    runConnection = null;
    siteDraft = siteDraftForRun(runId, selectedId, siteDraft);
    if (runId !== selectedId) {
      if (selectedImage?.url) window.URL.revokeObjectURL(selectedImage.url);
      selectedImage = null;
      savedSetup = null;
    }
    runId = selectedId;
    writeStored(localStorage, selectedRunKey, selectedId);
    let opened;
    try { opened = await request('GET', `runs/${encodeURIComponent(selectedId)}`); }
    catch (error) {
      const recovery = missingRunRecovery(error, selectedId, localStorage, selectedRunKey);
      if (!recovery) throw error;
      const {notice: message, ...freshState} = recovery;
      runId = null;
      state = freshState;
      actionRunner = null;
      cuePlayer = null;
      cueMetadata.clear();
      siteDraft = {label: '', positions: {}};
      configDraft = defaultConfig('tree');
      if (selectedImage?.url) window.URL.revokeObjectURL(selectedImage.url);
      selectedImage = null;
      notice(message);
      render();
      return;
    }
    state = {...opened, connected: true};
    runs = updateRunHistory(runs, state);
    configDraft = state.config ? structuredClone(state.config) : defaultConfig(state.mode || 'tree');
    newActionRunner(selectedId);
    cuePlayer = createCuePlayer({createAudio: source => new window.Audio(source),
      now: () => Date.now(), record: recordCueEvent, display: (text, delivery) => {
        if (delivery.status === 'played') state.currentInstruction = text;
        else showError(new Error(text));
        render();
      }, experimentSlug: EXPERIMENT.slug, runId: selectedId, storage: localStorage});
    const openEvents = connectEvents(selectedId);
    runConnection = createRunConnection({connect: async handlers => {
      if (state.playbackDeviceId === deviceId && readStored(localStorage, playbackKey(selectedId))) {
        await measureRunClock(true);
      }
      return openEvents(handlers);
    }, experimentSlug: EXPERIMENT.slug,
      runId: selectedId, storage: localStorage,
      scheduleTimeout: window.setTimeout.bind(window), cancelTimeout: window.clearTimeout.bind(window),
      onState: next => { if (next) { state = {...state, ...next, connected: true}; runs = updateRunHistory(runs, state); render(); } },
      onStatus: status => { state.connected = status.connected; render(); },
      onCue: cue => {
        if (cue.deviceId !== deviceId || !readStored(localStorage, playbackKey(selectedId))) return;
        cueMetadata.set(cue.cueId, cue);
        cuePlayer.play({...cue, experimentSlug: EXPERIMENT.slug, runId: selectedId});
      }});
    await runConnection.start();
    render();
    await retryCueEvents();
  }

  async function refreshLists() {
    const [runList, siteList, seriesList] = await Promise.all([
      request('GET', 'runs'), request('GET', 'sites'), request('GET', 'series'),
    ]);
    runs = runList.runs ?? [];
    sites = siteList.sites ?? [];
    series = seriesList.series ?? [];
    render();
  }

  async function perform(operation, source = null) {
    if (busy && !(source?.dataset?.hostedAction === 'stop' && state.startRegistration?.status === 'pending')) return;
    busyOperations += 1; busy = true;
    clearError();
    render();
    try { await operation(); await refreshLists(); }
    catch (error) {
      if (error.receipt?.state?.runId === runId) state = {...state, ...error.receipt.state};
      showError(error, source); if (error.uncertain && !error.pendingRegistration) state.connected = false;
    }
    finally { busyOperations -= 1; busy = busyOperations > 0; render(); updateRetry(); }
  }

  function bindHostedMasks() {
    const frame = main.querySelector('.mask-frame');
    if (!frame) return;
    const form = frame.closest('form');
    const width = Number(frame.dataset.width), height = Number(frame.dataset.height);
    const overlays = frame.querySelector('.mask-overlays');
    const input = region => form.elements.namedItem(`masks.${region}.points`);
    const status = form.querySelector('[data-mask-status]');
    const draw = () => {
      const regions = {};
      for (const name of ['A', 'B', 'background_1']) regions[name] = {points: maskPointDraft(input(name).value).points};
      renderMaskOverlays(overlays, regions, width, height);
      const selected = form.elements.namedItem('mask_region').value;
      status.textContent = `${selected}: ${regions[selected].points.length} vertices. Click the image or edit the coordinate list.`;
    };
    frame.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const selected = form.elements.namedItem('mask_region').value;
      const draft = maskPointDraft(input(selected).value);
      if (draft.error) { status.textContent = draft.error; return; }
      const bounds = frame.getBoundingClientRect();
      draft.points.push([
        Math.round(Math.max(0, Math.min(width - 1, (event.clientX - bounds.left) / bounds.width * width))),
        Math.round(Math.max(0, Math.min(height - 1, (event.clientY - bounds.top) / bounds.height * height))),
      ]);
      input(selected).value = draft.points.map(point => point.join(', ')).join('\n');
      event.preventDefault(); draw();
    });
    form.addEventListener('click', event => {
      const command = event.target.closest('[data-mask-command]');
      if (!command) return;
      const selected = form.elements.namedItem('mask_region').value;
      input(selected).value = command.dataset.maskCommand === 'clear' ? '' : input(selected).value.trim().split('\n').slice(0, -1).join('\n');
      draw();
    });
    form.addEventListener('input', draw); draw();
  }

  main.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || button.type === 'submit' && button.form) return;
    const run = operation => void perform(operation, button);
    if (button.dataset.hostedAction) return run(async () => {
      const kind = button.dataset.hostedAction === 'departed' ? 'away' : button.dataset.hostedAction;
      if (kind === 'start' && state.startRegistration?.status === 'pending' && actionRunner?.pending()?.action === 'start') {
        const receipt = await actionRunner.retry(); acceptReceipt(receipt); notice(receipt.notice ?? 'Saved Start registration recovered.'); return;
      }
      if (kind === 'designatePlayback' || kind === 'start' && state.playbackDeviceId === deviceId) {
        await measureRunClock(true);
      }
      const receipt = await submitAction(kind, kind === 'designatePlayback' ? {deviceId} : {});
      notice(receipt.notice ?? `${button.textContent.trim()} recorded.`);
    });
    const operation = button.dataset.hostedOperation;
    if (operation === 'edit-tag' || operation === 'cancel-tag') {
      editingTagRunId = operation === 'edit-tag' ? button.dataset.runId : null;
      render(); return;
    }
    if (operation === 'reconnect') return reconnect();
    if (operation === 'open-run') return run(async () => { await selectRun(button.dataset.runId); page = state.mode || 'study'; window.location.hash = page; });
    if (operation === 'repeat') return run(async () => {
      const previous = runs.find(run => run.runId === button.dataset.runId);
      const created = await request('POST', 'runs', repeatRunRequest(previous));
      await selectRun(created.runId);
      page = 'study'; window.location.hash = page;
      notice('A new run was created with the saved settings.');
    });
    if (operation === 'capture-position') return run(async () => {
      const role = button.dataset.role;
      const label = main.querySelector('[name="site_label"]')?.value;
      const selectedSiteId = main.querySelector('[name="site_id"]')?.value || siteDraft.siteId || null;
      const getPosition = () => new Promise((resolve, reject) => window.navigator.geolocation.getCurrentPosition(resolve, reject,
        {enableHighAccuracy: true, timeout: 15000, maximumAge: 0}));
      const position = positionRecord(role, await getPosition(), deviceId);
      const response = await saveSitePosition({role, label, siteId: selectedSiteId, deviceId, getPosition: async () => ({coords: {latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracyMetres}, timestamp: position.capturedAtMs}), request});
      siteDraft = {label, siteId: response.siteId ?? response.id ?? selectedSiteId, positions: {...siteDraft.positions, [role]: position}};
      notice(`${role} position saved with the site record.`);
    });
    if (operation === 'measure-clock') return run(async () => {
      await measureRunClock();
      notice('Clock reference measured. Film the displayed phone and server time together.');
    });
    if (operation === 'save-clock') return run(async () => {
      if (!clockReference?.valid) throw new Error('Measure the clock before saving a reference.');
      await submitAction('saveClockReference', {reference: clockReference, deviceId});
      notice('Clock reference retained with the run.');
    });
    if (operation === 'append-series-run') return run(async () => {
      const created = await request('POST', 'runs', {seriesId: button.dataset.seriesId});
      await selectRun(created.runId);
      page = 'study'; window.location.hash = page;
      notice('A new preparation recording was appended to this series.');
    });
  });

  main.addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.hostedInput !== 'setup-image' || !input.files?.[0]) return;
    void perform(async () => {
      const file = input.files[0];
      if (file.type !== 'image/png') throw new Error('Choose the exported PNG setup frame.');
      const bytes = await file.arrayBuffer();
      const hash = await window.crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const url = window.URL.createObjectURL(file);
      const image = new window.Image();
      try { await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('The PNG could not be read.')); image.src = url; }); }
      catch (error) { window.URL.revokeObjectURL(url); throw error; }
      if (selectedImage?.url) window.URL.revokeObjectURL(selectedImage.url);
      selectedImage = {url, sha256, width: image.naturalWidth, height: image.naturalHeight};
      savedSetup = null;
      notice('Setup image loaded locally. Draw A, B and stationary background; the original remains on the Mac.');
    }, input);
  });

  main.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof window.HTMLFormElement) || !form.dataset.hostedForm) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const fields = Object.fromEntries(new window.FormData(form));
    void perform(async () => {
      if (form.dataset.hostedForm === 'create-run') {
        const config = runConfigFromFields(fields, configDraft);
        const created = await request('POST', 'runs', {config, tag: fields.tag, ...(fields.series_id ? {seriesId: fields.series_id} : config.seriesId ? {seriesId: config.seriesId} : {})});
        await selectRun(created.runId);
        configDraft = config;
        notice('New run saved.');
      } else if (form.dataset.hostedForm === 'edit-tag') {
        const updated = await request('POST', `runs/${encodeURIComponent(fields.run_id)}/tag`, {tag: fields.tag});
        runs = updateRunHistory(runs, updated);
        if (fields.run_id === runId) state = {...state, tag: updated.tag};
        editingTagRunId = null;
        notice('Run tag saved. Its permanent ID and settings are unchanged.');
      } else if (form.dataset.hostedForm === 'start-issue' || form.dataset.hostedForm === 'start-stream') {
        const issue = form.dataset.hostedForm === 'start-issue';
        await request('POST', `runs/${encodeURIComponent(fields.run_id)}/${issue ? 'issues' : 'stream'}`, issue ? startIssueFromFields(fields) : startStreamFromFields(fields));
        const current = await request('GET', `runs/${encodeURIComponent(fields.run_id)}`);
        if (runId === fields.run_id) state = {...state, ...current};
        notice(issue ? 'Dated issue report saved. The run\'s start registration is retained.' : 'Optional streaming link saved.');
      } else if (form.dataset.hostedForm === 'save-site') {
        const siteId = fields.site_id || siteDraft.siteId;
        if (!siteId) throw new Error('Capture at least one named position before saving a site.');
        siteDraft.siteId = siteId;
        if (runId && state.lifecycle === 'draft') {
          const config = structuredClone(state.config);
          config.siteId = siteId;
          await submitAction('configure', {config});
          notice('Saved site attached to this draft run.');
        } else notice('Saved site selected for the next run.');
      } else if (form.dataset.hostedForm === 'save-reading') {
        if (!runId || state.lifecycle !== 'draft') throw new Error('Open a draft global run before saving its passive reading.');
        await submitAction('configure', {passiveReading: {title: fields.reading_title.trim(), url: fields.reading_url.trim()}});
        notice('Passive reading title and link saved with the draft run.');
      } else if (form.dataset.hostedForm === 'save-camera-setup') {
        if (!selectedImage) throw new Error('Choose an exported setup PNG first.');
        const retrospective = ['running', 'completed', 'stopped', 'failed'].includes(state.lifecycle);
        const setup = cameraSetupFromFields({imageSha256: selectedImage.sha256,
          imageSize: {width: selectedImage.width, height: selectedImage.height}, cameraProfile: fields.camera_profile,
          regions: hostedRegionsFromFields(fields), retrospective});
        const saved = await request('POST', 'setups', setup);
        const setupId = saved.setupId ?? saved.id;
        savedSetup = {setupId, runId: null, imageSha256: selectedImage.sha256};
        if (runId && (state.lifecycle === 'draft' || retrospective && state.purpose === 'preparation' && state.mode === 'tree')) {
          await submitAction('attachSetup', {setupId});
          savedSetup.runId = runId;
          notice(retrospective ? 'Retrospective preparation regions saved and linked to this run.' : 'Prospective fixed regions saved and linked to this run.');
        } else {
          notice(`Setup ${setupId} saved without a run link. Open a draft Tree run to attach it.`);
        }
      } else if (form.dataset.hostedForm === 'create-series') {
        const created = await request('POST', 'series', seriesRequestFromFields(fields));
        notice(`Preparation series ${created.seriesId ?? created.id} saved. Add new recordings from Study.`);
      }
    }, form.querySelector('button[type="submit"]'));
  });

  window.addEventListener('hashchange', () => { page = route(); html = ''; renderedContext = ''; render(); main.focus({preventScroll: true}); });
  function reconnect() {
    if (runConnection) { void runConnection.reconnect(); return; }
    void perform(async () => {
      await refreshLists();
      if (runId) await selectRun(runId);
      else { state.connected = true; notice(reconnectionNotice(null, null)); }
    });
  }
  const resume = () => { if (document.visibilityState === 'visible') reconnect(); };
  window.addEventListener('online', reconnect);
  document.addEventListener('visibilitychange', resume);
  const stopClockRedraw = startClockRedraw({
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    draw: () => {
    if (clockReference?.valid && (page === 'clock' || ['global', 'local', 'tree'].includes(page) &&
      ['prepared', 'completed', 'stopped', 'failed'].includes(state.lifecycle))) {
      refreshFilmedClock(main, filmedClockDisplay(clockReference, Date.now(), window.performance.now()));
    }
    },
  });
  void (async () => {
    try { await refreshLists(); if (runId) await selectRun(runId); else { state.connected = true; render(); } }
    catch (error) { state.connected = false; showError(error); render(); }
  })();
  render();
  return {refreshLists, selectRun, stop: () => {
    window.removeEventListener('online', reconnect);
    document.removeEventListener('visibilitychange', resume);
    screenLock.stop();
    runConnection?.stop();
    stopClockRedraw();
    if (readyRefreshTimer !== null) window.clearTimeout(readyRefreshTimer);
    if (selectedImage?.url) window.URL.revokeObjectURL(selectedImage.url);
  }};
}

export function profileFromFields(saved, fields, identifier) {
  const grid = saved.video.measurement?.method === 'area-grid-mean-v1';
  const maximumPoints = Number(fields.maximum_points), width = Number(fields.window_width);
  if (!grid && (!Number.isSafeInteger(maximumPoints) || maximumPoints <= 0)) throw new Error('Maximum points must be a positive integer.');
  if (!Number.isSafeInteger(width) || width <= 0 || width % 2 !== 1) throw new Error('Tracking window width must be a positive odd integer.');
  const distance = Number(fields.min_distance ?? saved.video.featureDetection.minDistancePixels);
  const strength = Number(fields.feature_strength ?? saved.video.featureDetection.qualityLevel);
  if (!Number.isFinite(distance) || distance <= 0) throw new Error('Minimum spacing must be positive pixels.');
  if (!Number.isFinite(strength) || strength <= 0 || strength > 1) throw new Error('Feature strength must be between zero and one.');
  const name = fields.profile_name?.trim();
  if (!name) throw new Error('Enter a profile name, for example Tree 6000/21 - mean-track analysis.');
  const profile = structuredClone(saved);
  profile.profileId = identifier;
  profile.label = name;
  if (grid) {
    const cellSize = Number(fields.cell_size), points = Number(fields.points_per_cell);
    const minimum = Number(fields.minimum_tracks_per_cell), coverage = Number(fields.spatial_coverage);
    if (![cellSize, points, minimum].every(value => Number.isSafeInteger(value) && value > 0))
      throw new Error('Cell size, points per cell and minimum tracks must be positive integers.');
    if (minimum > points) throw new Error('Minimum tracks per cell cannot exceed points per cell.');
    if (!Number.isFinite(coverage) || coverage <= 0 || coverage > 1)
      throw new Error('Required measured area coverage must be between zero and one.');
    if (!['timed', 'continuous'].includes(fields.refresh_policy)) throw new Error('Choose a valid refresh policy.');
    Object.assign(profile.video.measurement, {cellSizePixels: cellSize, pointsPerCell: points,
      minimumTracksPerCell: minimum, minimumSpatialCoverageFraction: coverage, refreshPolicy: fields.refresh_policy});
  } else profile.video.featureDetection.maxCorners = maximumPoints;
  profile.video.featureDetection.minDistancePixels = distance;
  profile.video.featureDetection.qualityLevel = strength;
  profile.video.tracking.windowSizePixels = [width, width];
  return profile;
}

export function comparisonRequestFromFields(fields, candidates) {
  const label = fields.comparison_label?.trim();
  if (!label) throw new Error('Enter a comparison name.');
  const profiles = candidates?.profiles ?? [];
  const leftProfileId = fields.left_profile_id, rightProfileId = fields.right_profile_id;
  if (!profiles.some(item => item.profileId === leftProfileId) ||
      !profiles.some(item => item.profileId === rightProfileId) || leftProfileId === rightProfileId)
    throw new Error('Choose two distinct saved profiles.');
  const rows = (candidates?.runs ?? []).flatMap((run, index) => {
    if (!fields[`include_${index}`]) return [];
    const leftAnalysisId = fields[`left_analysis_${index}`] || null;
    const rightAnalysisId = fields[`right_analysis_${index}`] || null;
    for (const analysisId of [leftAnalysisId, rightAnalysisId]) {
      if (analysisId && !run.analyses.some(item => item.analysisId === analysisId))
        throw new Error(`Choose a retained analysis revision for ${run.runId}.`);
    }
    if (leftAnalysisId && !run.analyses.some(item => item.analysisId === leftAnalysisId && item.profileId === leftProfileId) ||
        rightAnalysisId && !run.analyses.some(item => item.analysisId === rightAnalysisId && item.profileId === rightProfileId))
      throw new Error(`Choose revisions from the selected profiles for ${run.runId}.`);
    return [{runId: run.runId, leftAnalysisId, rightAnalysisId}];
  });
  if (!rows.length) throw new Error('Include at least one preparation recording.');
  return {label, leftProfileId, rightProfileId, rows};
}

export async function persistChangedProfileSelection(input, selectProfile) {
  if (input.tagName !== 'SELECT' || input.name !== 'profile_id' ||
      input.closest('form')?.dataset.analysisForm !== 'start-analysis') return false;
  await selectProfile(input.value);
  return true;
}

export function restoreMacFormDrafts(forms, snapshot, {profileChanged=false, resetVideoForms=false,
  clockMapChanged=false, comparisonProfileChanged=null}={}) {
  snapshot?.forEach(({formName, fields}, index) => {
    if (resetVideoForms && ['save-time-map', 'save-obstruction-review', 'export-annotated-clip'].includes(formName) ||
        profileChanged && formName === 'save-profile' ||
        clockMapChanged && formName === 'save-time-map') return;
    fields.forEach(saved => {
      if (formName === 'start-analysis' && saved.name === 'profile_id') return;
      if (formName === 'save-comparison' && comparisonProfileChanged &&
          (saved.name === `${comparisonProfileChanged}_profile_id` ||
           saved.name.startsWith(`${comparisonProfileChanged}_analysis_`))) return;
      const control = [...(forms[index]?.elements ?? [])].find(item => item.name === saved.name && item.type === saved.type);
      if (control) restoreControlValue(control, saved);
    });
  });
}

export function startMacAnalysisApplication(document, window) {
  const request = createTransport(window.fetch.bind(window), LOCAL_ANALYSIS_API);
  const main = document.getElementById('main');
  let runs = [], selectedRunId = null, detail = null, previewImage = null, selectedAnalysis = null, busy = false;
  let busyDescription = '', busyStartedAt = 0;
  let backgroundBusy = false, currentProgress = null, pollingProgress = false;
  let framePreviews = {}, profiles = [], selectedProfileId = null;
  let profileSettingsOpen = false;
  let selectedVideoRecordingId = null, loadedSavedPreviewKey = null;
  let setupClip = null, setupPreviewImage = null;
  let series = null, selectedSeriesId = null, seriesDetail = null, selectedEvaluation = null;
  let publicationJobs = [];
  let comparisonCandidates = {runs: [], profiles: []}, savedComparisons = {comparisons: []}, selectedComparison = null;
  let comparisonLeftProfileId = null, comparisonRightProfileId = null;
  let annotationJobs = [];
  let renderedContext = null, renderedProfileId = null, renderedClockMapId = null, html = '';
  let unmountTreeCharts = () => {};
  document.getElementById('quit').hidden = true;
  document.getElementById('footer-message').textContent = 'This Mac retains originals and results. Field instructions remain on the shared hosted run.';
  const navigation = document.querySelector('.app-navigation');
  navigation.innerHTML = `<a href="https://test.lab.sourceof.love${HOSTED_APP_BASE}">Test field app</a><a href="${LOCAL_ANALYSIS_BASE}" aria-current="page">Mac analysis</a>`;
  document.getElementById('mode-label').textContent = 'Analysis';
  document.getElementById('connection').textContent = 'Connected to the local Mac analysis service.';

  const errorPanel = document.getElementById('error');
  errorPanel.className = 'error mac-operation-status';
  document.getElementById('notice').className = 'notice mac-operation-status';
  errorPanel.addEventListener('click', event => {
    if (event.target.closest('[data-dismiss-mac-error]')) clearError();
  });
  function showError(error) {
    document.getElementById('notice').textContent = '';
    errorPanel.innerHTML = renderMacError(error?.message ?? String(error)); errorPanel.hidden = false;
  }
  function clearError() { document.getElementById('error').hidden = true; }
  function notice(message) { document.getElementById('notice').textContent = message; }
  const resultParameters = new URLSearchParams((window.location?.hash ?? '').replace(/^#/, ''));
  if (resultParameters.has('comparison')) {
    const comparisonId = resultParameters.get('comparison'), side = resultParameters.get('side');
    const refreshComparison = async () => {
      clearError();
      const comparison = await request(`/api/comparisons/${encodeURIComponent(comparisonId)}`);
      unmountTreeCharts();
      main.innerHTML = renderMacComparisonResultPage({comparison, side});
      unmountTreeCharts = mountTreeCharts(main, window.ResizeObserver);
      document.title = `${comparison.label} · ${side} accumulated result`;
      document.getElementById('study-identity').textContent = comparison.label;
    };
    void refreshComparison().catch(showError);
    return {refresh: refreshComparison};
  }
  if (resultParameters.has('analysis')) {
    const resultRunId = resultParameters.get('run'), resultId = resultParameters.get('analysis');
    const refreshResult = async () => {
      clearError();
      const [run, analysis] = await Promise.all([
        request(`/api/runs/${encodeURIComponent(resultRunId)}`),
        request(`/api/runs/${encodeURIComponent(resultRunId)}/analyses/${encodeURIComponent(resultId)}`),
      ]);
      unmountTreeCharts();
      main.innerHTML = renderMacResultPage({analysis, run});
      unmountTreeCharts = mountTreeCharts(main, window.ResizeObserver);
      document.title = `${run.tag ?? run.runId} · ${analysis.profileId} · ${analysis.analysisId}`;
      document.getElementById('study-identity').textContent = [run.tag, run.runId].filter(Boolean).join(' · ');
    };
    void refreshResult().catch(showError);
    return {refresh: refreshResult};
  }
  selectedSeriesId = resultParameters.get('series') || null;
  const activePublication = () => publicationJobs.find(job => ['preparing', 'uploading'].includes(job.status));
  const controlsBusy = () => busy || backgroundBusy || Boolean(activePublication());
  const publicationDescription = job => job.status === 'preparing' ? 'Preparing publication' : 'Publishing retained results';
  function rememberSeries() {
    if (window.location) window.location.hash = selectedSeriesId ? `series=${encodeURIComponent(selectedSeriesId)}` : '';
  }
  function retainPublication(job) {
    publicationJobs = [...publicationJobs.filter(item => item.jobId !== job.jobId), job];
  }
  function operationDescription(operation, kind) {
    if (operation === 'import-recording') return kind === 'video'
      ? 'Choosing and importing the original camera video. The Mac will retain it and check its frame timeline; this can take several minutes.'
      : `Choosing and importing the original setup PNG`;
    return ({
      'import-setup-clip': 'Choosing and importing a camera clip. Large videos can take several minutes.',
      'export-setup-clip-frame': 'Exporting the setup PNG',
      'import-bundle': 'Choosing and importing a run or series bundle',
      'view-result': 'Opening the retained result',
      'import-series': 'Choosing and importing a frozen series',
      'evaluate-series': 'Starting the combined evaluation',
      'view-series-result': 'Opening the combined result',
      'select-run': 'Opening the imported run',
      'select-series': 'Opening the selected Tree series',
      'preview-setup-clip': 'Decoding the selected setup frame',
      'save-time-map': 'Checking and saving the camera clock mapping',
      'save-obstruction-review': 'Saving the tree footage review',
      'save-profile': 'Saving the new analysis profile',
      'save-comparison': 'Saving the exact paired comparison',
      'start-analysis': 'Starting the analysis job',
      'finalize-missing-measurements': 'Finalizing missing measurements',
      'prepare-publication': 'Preparing publication. Retaining files, verifying hashes and preparing viewing video can take several minutes.',
    })[operation] ?? 'Processing the Mac analysis request';
  }
  function render({resetVideoForms = false, comparisonProfileChanged = null} = {}) {
    document.getElementById('study-identity').textContent = selectedRunId ? [detail?.tag, selectedRunId].filter(Boolean).join(' · ') : selectedSeriesId ?? 'No imported run or series';
    const publication = activePublication();
    const next = renderMacAnalysisPage({runs, selectedRunId, detail, previewImage,
      setupClip, setupPreviewImage, selectedAnalysis,
      series, selectedSeriesId, seriesDetail, selectedEvaluation, publicationJobs, busy: controlsBusy(),
      profiles, selectedProfileId, profileSettingsOpen, framePreviews, selectedVideoRecordingId, annotationJobs,
      comparisonCandidates, savedComparisons, selectedComparison,
      comparisonLeftProfileId, comparisonRightProfileId,
      activeOperation: controlsBusy() ? {description: busy ? busyDescription : publication ? publicationDescription(publication) : 'Analyzing retained originals', progress: publication?.progress ?? currentProgress,
        elapsedSeconds: busy ? Math.floor((Date.now() - busyStartedAt) / 1000) : null} : null});
    if (next === html) return;
    const context = `${selectedRunId ?? ''}|${selectedSeriesId ?? ''}`;
    const snapshot = renderedContext === context ? [...main.querySelectorAll('form')].map(form => ({
      formName: form.dataset.analysisForm,
      fields: [...form.elements].filter(control => control.name).map(control =>
        ({name: control.name, type: control.type, value: control.value, checked: control.checked})),
    })) : null;
    unmountTreeCharts();
    main.innerHTML = next;
    unmountTreeCharts = mountTreeCharts(main, window.ResizeObserver);
    if (controlsBusy()) for (const control of main.querySelectorAll('button, input, select, textarea')) control.disabled = true;
    html = next;
    renderedContext = context;
    const clockMapId = currentClockVideo()?.timeMapId ?? null;
    restoreMacFormDrafts(main.querySelectorAll('form'), snapshot, {
      resetVideoForms, profileChanged: renderedProfileId !== selectedProfileId,
      clockMapChanged: renderedClockMapId !== clockMapId,
      comparisonProfileChanged,
    });
    renderedProfileId = selectedProfileId;
    renderedClockMapId = clockMapId;
  }
  function currentClockVideo() {
    const recordings = Array.isArray(detail?.recordings) ? detail.recordings : Object.values(detail?.recordings ?? {});
    return selectedClockVideo(recordings.filter(item => item.kind === 'video' && item.available !== false), detail, selectedVideoRecordingId);
  }
  async function loadSavedFramePreviews() {
    const video = currentClockVideo();
    const references = video?.timeMapId && video.clockMap?.references;
    if (!selectedRunId || references?.length !== 2) return;
    const recordingId = video.recordingId ?? video.id;
    const key = `${selectedRunId}:${recordingId}:${video.timeMapId}`;
    if (key === loadedSavedPreviewKey) return;
    loadedSavedPreviewKey = key;
    for (const [index, side] of ['before', 'after'].entries()) {
      const frameIndex = references[index].frameIndex;
      const preview = await mutation('preview-frame', {runId: selectedRunId, recordingId, frameIndex});
      const currentVideo = currentClockVideo();
      if ((currentVideo?.recordingId ?? currentVideo?.id) !== recordingId) return;
      framePreviews[side] = preview;
    }
  }
  async function refresh() {
    const previousAnalyses = detail?.analyses ?? {};
    const previousAnnotations = annotationJobs;
    const [runList, seriesList, currentSetupClip, availableProfiles, comparisonInventory, comparisonList, publications] = await Promise.all([
      request('/api/runs'), request('/api/series'), request('/api/setup-clip'), request('/api/profiles'),
      request('/api/comparison-candidates'), request('/api/comparisons'), request('/api/publication')]);
    publicationJobs = publications.jobs ?? [];
    profiles = availableProfiles.profiles ?? [];
    comparisonCandidates = comparisonInventory;
    savedComparisons = comparisonList;
    const availableComparisonIds = new Set(comparisonCandidates.profiles.map(item => item.profileId));
    if (!availableComparisonIds.has(comparisonLeftProfileId)) comparisonLeftProfileId = comparisonCandidates.profiles[0]?.profileId ?? null;
    if (!availableComparisonIds.has(comparisonRightProfileId)) comparisonRightProfileId = comparisonCandidates.profiles.find(item => item.profileId !== comparisonLeftProfileId)?.profileId ?? null;
    if (!profiles.some(item => item.profileId === selectedProfileId)) selectedProfileId = profiles[0]?.profileId ?? null;
    runs = runList.runs ?? [];
    series = seriesList;
    annotationJobs = (await request('/api/annotations')).jobs;
    setupClip = currentSetupClip;
    if (selectedRunId) {
      detail = await request(`/api/runs/${encodeURIComponent(selectedRunId)}`);
      selectedProfileId = detail.selectedProfileId ?? selectedProfileId;
      await loadSavedFramePreviews();
      if (selectedAnalysis?.status === 'running') {
        selectedAnalysis = await request(`/api/runs/${encodeURIComponent(selectedRunId)}/analyses/${encodeURIComponent(selectedAnalysis.analysisId)}`);
      }
    }
    for (const [label, previous, current] of [
      ['Analysis', Object.values(previousAnalyses), Object.values(detail?.analyses ?? {})],
      ['Annotated video export', previousAnnotations, annotationJobs ?? []],
    ]) {
      const failed = current.find(item => item.status === 'failed' && !previous.some(before =>
        before.status === 'failed' && (before.analysisId ?? before.jobId) === (item.analysisId ?? item.jobId)));
      if (failed) showError(new Error(`${label} ${failed.analysisId ?? failed.jobId} failed: ${failed.error?.message ?? failed.error ?? 'See the retained job details.'}`));
    }
    seriesDetail = selectedSeriesId ? await request(`/api/series/${encodeURIComponent(selectedSeriesId)}`) : null;
    const wasBackgroundBusy = backgroundBusy;
    backgroundBusy = runs.some(item => item.analysisRunning) || Object.values(detail?.analyses ?? {}).some(item => item.status === 'running');
    if (backgroundBusy && !wasBackgroundBusy) busyStartedAt = Date.now();
    if (!busy && !backgroundBusy) currentProgress = null;
    render();
  }
  async function perform(operation, description, {profileSave = false} = {}) {
    if (controlsBusy()) return;
    if (profileSave) profileSettingsOpen = true;
    notice('');
    busy = true; currentProgress = null; busyDescription = description; busyStartedAt = Date.now(); clearError(); render();
    const elapsedTimer = window.setInterval(() => {
      const elapsed = main.querySelector('[data-mac-operation-elapsed]');
      if (elapsed) elapsed.textContent = `${Math.floor((Date.now() - busyStartedAt) / 1000)} seconds elapsed`;
    }, 1000);
    try { await operation(); await refresh(); }
    catch (error) { showError(error); }
    finally { window.clearInterval(elapsedTimer); busy = false; busyDescription = ''; if (!backgroundBusy) currentProgress = null; render(); }
  }
  const mutation = (path, body) => request(`/api/${path}`, {requestId: window.crypto.randomUUID(), ...body});

  async function showFrame(picker, step = 0) {
    if (!picker || controlsBusy()) return;
    const id = picker.dataset.framePicker;
    const form = picker.closest('form');
    const fields = Object.fromEntries(new window.FormData(form));
    const name = picker.dataset.frameName;
    await perform(async () => {
      const recordingId = fields.recording_id || fields.video_recording_id;
      const current = framePreviews[id];
      const sameVideo = id === 'setup' ? current?.clipId === setupClip?.clipId : current?.recordingId === recordingId;
      const knownFrameCount = Number(picker.dataset.frameCount);
      const frameCount = sameVideo ? current?.frameCount : Number.isSafeInteger(knownFrameCount) && knownFrameCount > 0 ? knownFrameCount : null;
      const frameIndex = framePickerSelection(fields[name], step, frameCount);
      if (id === 'setup' && !setupClip?.clipId) throw new Error('Choose a setup camera clip first.');
      const preview = await mutation(id === 'setup' ? 'preview-setup-clip' : 'preview-frame', id === 'setup'
        ? {clipId: setupClip.clipId, frameIndex} : {runId: selectedRunId, recordingId, frameIndex});
      framePreviews[id] = preview;
      const live = main.querySelector(`[data-frame-picker="${id}"] input[name="${name}"]`);
      if (live) live.value = String(frameIndex);
      notice(`Frame ${frameIndex} shown at ${Number(preview.ptsSeconds).toFixed(3)} seconds.`);
    }, 'Decoding the selected camera frame');
  }
  function requireShownFrame(id, fields, name = 'frame_index') {
    const preview = framePreviews[id];
    const expectedVideo = id === 'setup' ? setupClip?.clipId : fields.recording_id || fields.video_recording_id;
    if (!preview || preview.frameIndex !== wholeField(fields[name], 'Frame number') ||
        (id === 'setup' ? preview.clipId : preview.recordingId) !== expectedVideo) {
      throw new Error('Show the selected frame before exporting it or saving its clock reference.');
    }
    return preview.frameIndex;
  }
  main.addEventListener('keydown', event => {
    const picker = event.target.closest('[data-frame-picker]');
    if (event.key !== 'Enter' || !picker || event.target.name !== picker.dataset.frameName) return;
    event.preventDefault(); void showFrame(picker);
  });
  main.addEventListener('input', event => {
    const picker = event.target.closest('[data-frame-picker]');
    if (!picker || event.target.name !== picker.dataset.frameName) return;
    const value = Number(event.target.value);
    const preview = framePreviews[picker.dataset.framePicker];
    const knownFrameCount = Number(picker.dataset.frameCount);
    const frameCount = preview?.frameCount ?? (Number.isSafeInteger(knownFrameCount) && knownFrameCount > 0 ? knownFrameCount : null);
    for (const button of picker.querySelectorAll('[data-frame-step]')) {
      const next = value + Number(button.dataset.frameStep);
      button.disabled = controlsBusy() || !Number.isSafeInteger(next) || next < 0 || frameCount != null && next >= frameCount;
    }
  });
  main.addEventListener('change', event => {
    if (event.target.name === 'left_profile_id' || event.target.name === 'right_profile_id') {
      if (event.target.name === 'left_profile_id') comparisonLeftProfileId = event.target.value;
      else comparisonRightProfileId = event.target.value;
      render({comparisonProfileChanged: event.target.name.slice(0, -'_profile_id'.length)});
      return;
    }
    void persistChangedProfileSelection(event.target, profileId => perform(async () => {
      await mutation('select-profile', {runId: selectedRunId, profileId});
      selectedProfileId = profileId;
    }, 'Saving analysis profile selection'));
    if (['recording_id', 'video_recording_id'].includes(event.target.name)) {
      const form = event.target.closest('form');
      for (const picker of form.querySelectorAll('[data-frame-picker]')) delete framePreviews[picker.dataset.framePicker];
      selectedVideoRecordingId = event.target.value;
      loadedSavedPreviewKey = null;
      delete framePreviews.before;
      delete framePreviews.after;
      render({resetVideoForms: true});
      if (currentClockVideo()?.timeMapId) void perform(loadSavedFramePreviews, 'Restoring saved clock frames');
    }
  });

  main.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || button.type === 'submit' && button.form) return;
    const operation = button.dataset.analysisOperation;
    if (['publish-publication', 'resume-publication'].includes(operation)) {
      const job = [...publicationJobs].reverse().find(item => item.seriesId === selectedSeriesId);
      const allowed = job?.status === 'prepared' && operation === 'publish-publication' ||
        job?.status === 'failed' && Number.isSafeInteger(job.fileCount) && !job.error?.requiresNewSnapshot && operation === 'resume-publication';
      if (!allowed || job.jobId !== button.dataset.jobId || seriesDetail?.purpose !== 'scored') return;
      return void perform(async () => {
        retainPublication(await mutation(`publication/${job.jobId}/start`, {}));
      }, operation === 'resume-publication' ? 'Resuming the retained publication' : 'Publishing the prepared results');
    }
    if (operation === 'show-frame') return void showFrame(button.closest('[data-frame-picker]'), Number(button.dataset.frameStep));
    if (operation === 'import-setup-clip') return void perform(async () => {
      const imported = await mutation('import-setup-clip', {});
      if (imported.clipId) { setupClip = imported; setupPreviewImage = null; delete framePreviews.setup; }
      notice(imported.cancelled ? 'No camera clip selected.' : 'Camera clip retained. Choose a frame and export its full-size PNG.');
    }, operationDescription(operation));
    if (operation === 'export-setup-clip-frame') return void perform(async () => {
      if (!setupClip?.clipId) throw new Error('Choose a camera clip first.');
      const fields = Object.fromEntries(new window.FormData(button.closest('form')));
      const exported = await mutation('export-setup-clip-frame', {clipId: setupClip.clipId,
        frameIndex: requireShownFrame('setup', fields), sourceKind: fields.source_kind});
      notice(exported.cancelled ? 'Setup PNG export cancelled.' : `Full-size setup PNG saved as ${exported.name}. Select it on hosted Setup before targeting.`);
    }, operationDescription(operation));
    if (operation === 'import-bundle') return void perform(async () => {
      const imported = await mutation('import-bundle', {});
      if (imported.runId) {
        selectedRunId = imported.runId; selectedAnalysis = null; framePreviews = {setup: framePreviews.setup};
        selectedVideoRecordingId = null; loadedSavedPreviewKey = null;
      }
      if (!imported.cancelled) selectedSeriesId = imported.seriesId ?? null;
      notice(imported.cancelled ? 'No bundle selected.' : imported.bundleKind === 'series'
        ? 'Series inventory imported and retained.' : 'Run bundle imported and retained.');
    }, operationDescription(operation));
    if (operation === 'import-recording') return void perform(async () => {
      if (!selectedRunId) throw new Error('Open an imported run before selecting original files.');
      const imported = await mutation('import-recording', {runId: selectedRunId, kind: button.dataset.kind});
      notice(imported.cancelled ? 'No recording selected.' : 'Original recording imported with its hash.');
    }, operationDescription(operation, button.dataset.kind));
    if (operation === 'view-result') return void perform(async () => {
      if (!selectedRunId) throw new Error('Open an imported run first.');
      selectedAnalysis = await request(`/api/runs/${encodeURIComponent(selectedRunId)}/analyses/${encodeURIComponent(button.dataset.analysisId)}`);
      notice(`Retained result ${button.dataset.analysisId} opened below the job list.`);
    }, operationDescription(operation));
    if (operation === 'open-comparison') return void perform(async () => {
      selectedComparison = await request(`/api/comparisons/${encodeURIComponent(button.dataset.comparisonId)}`);
      notice(`Saved comparison ${selectedComparison.label} opened below.`);
    }, 'Opening the saved method comparison');
    if (operation === 'import-retained-setup') return void perform(async () => {
      const imported = await mutation(operation, {});
      notice(imported.cancelled ? 'No setup folder selected.' : `${imported.importedImages} setup images copied into the Tree store.`);
    }, 'Importing retained setup images');
    if (operation === 'export-report') return void perform(async () => {
      const exported = await mutation(operation, {seriesId: selectedSeriesId});
      notice(exported.cancelled ? 'Report export cancelled.' : `Results saved as ${exported.filename} and ${exported.textFilename}.`);
    }, 'Exporting the accumulating report');
    if (operation === 'select-revision') return void perform(async () => {
      await mutation(operation, {runId: selectedRunId, analysisId: button.dataset.analysisId});
      notice('Selected retained revision now contributes once to the accumulating series.');
    }, 'Selecting the retained revision');
  });

  main.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof window.HTMLFormElement) || !form.dataset.analysisForm) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (['preview-frame', 'preview-setup-clip'].includes(form.dataset.analysisForm)) {
      void showFrame(form.querySelector('[data-frame-picker]')); return;
    }
    const fields = Object.fromEntries(new window.FormData(form));
    void perform(async () => {
      if (form.dataset.analysisForm === 'select-run') {
        profileSettingsOpen = false;
        selectedRunId = fields.run_id;
        selectedSeriesId = runs.find(item => item.runId === selectedRunId)?.seriesId ?? null;
        framePreviews = {setup: framePreviews.setup};
        selectedVideoRecordingId = null; loadedSavedPreviewKey = null;
        previewImage = null;
        selectedAnalysis = null;
      } else if (form.dataset.analysisForm === 'select-series') {
        selectedSeriesId = fields.series_id || null;
        selectedEvaluation = null;
        rememberSeries();
      } else if (form.dataset.analysisForm === 'prepare-publication') {
        if (!selectedSeriesId || seriesDetail?.purpose !== 'scored') throw new Error('Choose a retained named scored series to prepare a publication. Preparation recordings remain local.');
        retainPublication(await mutation('publication/prepare', {seriesId: selectedSeriesId, environment: fields.environment,
          ...(fields.correction_reason?.trim() ? {correctionReason: fields.correction_reason.trim()} : {})}));
      } else if (form.dataset.analysisForm === 'save-time-map') {
        requireShownFrame('before', fields, 'before_frame');
        requireShownFrame('after', fields, 'after_frame');
        const mapping = timeMapFromFields(fields);
        const result = await mutation('save-time-map', mapping);
        notice(result.qualified ? (fields.mode === 'tree' ? 'Camera clock mapping qualified.' : 'Camera and wind clock mapping qualified.') : `Timing remains unqualified: ${(result.quality_reasons ?? []).join('; ')}`);
      } else if (form.dataset.analysisForm === 'save-obstruction-review') {
        await mutation('save-obstruction-review', obstructionReviewFromFields(fields));
        notice('Tree footage review retained with the original video.');
      } else if (form.dataset.analysisForm === 'save-profile') {
        const saved = profiles.find(item => item.profileId === selectedProfileId);
        const retained = await mutation('save-profile', {runId: selectedRunId,
          profile: profileFromFields(JSON.parse(saved.sealedProfileJson), fields, `tree-${window.crypto.randomUUID()}`)});
        selectedProfileId = retained.profile.profileId;
        notice(`Profile ${retained.profile.label} saved and selected for this run. Use Analyze retained originals to run it.`);
      } else if (form.dataset.analysisForm === 'save-comparison') {
        selectedComparison = await mutation('save-comparison', comparisonRequestFromFields(fields, comparisonCandidates));
        notice(`Comparison ${selectedComparison.label} saved with exact retained revisions.`);
      } else if (form.dataset.analysisForm === 'export-annotated-clip') {
        await mutation('export-annotated-clip', {runId: selectedRunId, recordingId: fields.recording_id,
          profileId: selectedProfileId, startSeconds: Number(fields.start_seconds), durationSeconds: Number(fields.duration_seconds),
          displayMagnification: Number(fields.display_magnification)});
        notice('Annotated video export started. Its status and saved link appear below.');
      } else if (form.dataset.analysisForm === 'finalize-missing-measurements') {
        const reason = fields.reason?.trim();
        if (!reason || reason.length > 2000) throw new Error('Enter a missing-measurement reason of at most 2,000 characters.');
        selectedAnalysis = await mutation('finalize-missing-measurements', {runId: fields.run_id, profileId: fields.profile_id, reason});
        notice('A new analysis revision retains the dated missing-measurement reason. Its result appears below.');
      } else if (form.dataset.analysisForm === 'start-analysis') {
        await mutation('start-analysis', {runId: fields.run_id, profileId: fields.profile_id});
        notice('A new analysis job was retained. Its status appears below.');
      }
    }, operationDescription(form.dataset.analysisForm), {profileSave: form.dataset.analysisForm === 'save-profile'});
  });

  void refresh().catch(error => { showError(error); document.getElementById('connection').textContent = 'Local analysis service connection failed.'; });
  window.setInterval(() => {
    if (pollingProgress) return;
    pollingProgress = true;
    void (async () => {
      try {
        const publication = activePublication();
        if (publication && !busy) {
          const updated = await request(`/api/publication/${publication.jobId}`);
          retainPublication(updated);
          if (updated.status !== publication.status) {
            if (updated.error) showError(new Error([updated.error.message, updated.error.corrective_action].filter(Boolean).join(' ')));
            render();
          } else {
            for (const selector of ['[data-mac-operation-progress]', '[data-publication-progress]']) {
              const status = main.querySelector(selector);
              if (status) status.innerHTML = renderMacProgress(updated.progress, publicationDescription(updated));
            }
          }
          return;
        }
        if (busy || backgroundBusy) {
          currentProgress = await request('/api/progress');
          const status = main.querySelector('[data-mac-operation-progress]');
          if (status) status.innerHTML = renderMacProgress(currentProgress, busyDescription || 'Analyzing retained originals');
        }
        if (!busy && (backgroundBusy || selectedRunId || selectedSeriesId)) await refresh();
      } catch (error) { (window.console ?? console).warn('Mac Tree analysis or publication status refresh failed.', {type: error.name}); showError(error); }
      finally { pollingProgress = false; }
    })();
  }, 1000);
  render();
  return {refresh};
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const surface = applicationSurface(window.location.pathname);
  if (surface === 'hosted') startHostedApplication(document, window);
  else if (surface === 'analysis') startMacAnalysisApplication(document, window);
  else throw new Error('Open the Tree collection or Mac analysis path.');
}
