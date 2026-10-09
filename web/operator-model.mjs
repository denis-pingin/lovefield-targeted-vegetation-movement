import {STUDY_NAME} from './study-paths.mjs';

export const ACTIONS = Object.freeze([
  'start_global', 'approach_started', 'arrived', 'departure_started', 'departed',
  'local_ready', 'report_execution', 'start_tree', 'postpone_tree', 'incident', 'stop_session', 'close_group',
  'configure', 'attachSetup', 'prepare', 'designatePlayback', 'recordingReady', 'start',
  'ready', 'approachStarted', 'departureStarted', 'away', 'stop', 'saveClockReference',
]);

const displayText = value => typeof value === 'string' ? value : '';
const publicResult = result => ({
  status: displayText(result?.status) || 'pending',
  reasons: Array.isArray(result?.reasons) ? result.reasons.map(displayText) : [],
  details: result?.details ?? null,
});

/** Project only the fields needed by the operator. Never carry a whole service object into a view. */
export function operatorModel(state = {}) {
  if (Object.hasOwn(state, 'runId')) return hostedOperatorModel(state);
  const connected = state.connected !== false;
  const eligible = state.eligible_actions ?? [];
  const reasons = state.action_reasons ?? {};
  const localReason = displayText(state.local_ineligible_reason ?? state.local?.reason);
  const availableGlobalVisits = Array.isArray(state.available_global_visits) ? state.available_global_visits.filter(value => Number.isInteger(value) && value > 0) : [];
  const actions = Object.fromEntries(ACTIONS.map(action => {
    const entry = Array.isArray(eligible) ? eligible.includes(action) : eligible[action];
    const allowed = typeof entry === 'object' ? entry?.enabled === true : entry === true;
    const enabled = connected && allowed && (action !== 'start_global' || availableGlobalVisits.length > 0);
    const reason = !connected ? 'Connection lost. Reconnect before sending an action.'
      : enabled ? '' : displayText(entry?.reason ?? reasons[action])
        || (action === 'local_ready' ? localReason : '')
        || (action === 'start_global' && !availableGlobalVisits.length ? 'No unconsumed global visit is available to start.' : '')
        || 'This action is not available in the current study state.';
    return [action, {enabled, reason}];
  }));
  return {
    studyId: displayText(state.study_id),
    name: displayText(state.name) || STUDY_NAME,
    mode: displayText(state.mode),
    phase: displayText(state.phase) || 'Not running',
    cue: connected ? displayText(state.current_instruction) || null : null,
    running: state.running === true,
    sessionKind: displayText(state.session_kind),
    reportOpen: connected && (state.report_available === true || state.local?.report_open === true || state.tree?.report_open === true),
    localCount: Number.isInteger(state.local_trial_count) ? state.local_trial_count : 0,
    treeCount: Number.isInteger(state.tree_trial_count) ? state.tree_trial_count : 0,
    availableGlobalVisits,
    actions,
    modules: Object.fromEntries(['global', 'local', 'tree'].map(name => {
      const module = state.modules?.[name] ?? state.modules?.[name === 'tree' ? 'tree' : 'global-local'] ?? {};
      const frozen = state.frozen_modules ?? state.setup?.frozen ?? [];
      const isFrozen = Array.isArray(frozen) ? frozen.includes(name) : Boolean(frozen[name]);
      return [name, {
        status: displayText(module.status) || (module.complete ? 'complete' : module.closed ? 'closed' : isFrozen ? 'frozen' : 'pending'),
        reason: displayText(module.reason),
        sealed: module.sealed === true,
      }];
    })),
    results: Object.fromEntries(['global', 'local', 'tree'].map(name => [name, publicResult(state.results?.[name])])),
    evaluation: Object.fromEntries(['global', 'local', 'tree'].map(name => {
      const sealed = state.modules?.[name === 'tree' ? 'tree' : 'global-local']?.sealed === true;
      const reason = !connected ? 'Reconnect to the local service before evaluating.'
        : !state.study_id ? 'Open a study before evaluating.'
          : state.running ? 'Finish the current field session before evaluating.'
            : !sealed ? `Review and seal the ${name === 'tree' ? 'tree' : 'global and local'} measurements in Recordings before evaluating.` : '';
      return [name, {enabled: reason === '', reason}];
    })),
    connection: {
      connected,
      message: connected ? 'Connected to the local study service.' : 'Connection lost. The current instruction is unknown; the local service may still be running. Reconnect to check it.',
    },
  };
}

function hostedOperatorModel(state) {
  const connected = state.connected !== false;
  const nowMs = Number.isFinite(state.nowMs) ? state.nowMs : Date.now();
  const runId = displayText(state.runId);
  const lifecycle = displayText(state.lifecycle) || 'draft';
  const phase = displayText(state.phase) || 'Not started';
  const ready = state.ready ?? {};
  const readyRemaining = Number.isFinite(ready.readyAtMs) ? Math.max(0, Math.ceil((ready.readyAtMs - nowMs) / 1000)) : null;
  const readyReason = !connected ? 'Connection lost. Reconnect before sending Ready.'
    : ready.reason === 'baseline_incomplete' && readyRemaining !== null ? `The preceding baseline has ${readyRemaining} second${readyRemaining === 1 ? '' : 's'} remaining.`
      : ready.reason === 'comparison_open' ? 'The current comparison is still in progress.'
        : ready.reason === 'completion_cue_pending' ? 'Wait for the spoken response-end cue.'
        : ready.reason === 'count_complete' ? 'The planned comparisons are complete.'
          : ready.reason === 'not_active' ? 'Ready is available during active practice.'
            : ready.reason === 'active_cutoff' ? 'There is no time for another complete comparison before departure.'
              : ready.reason === 'not_running' ? 'Start the run before sending Ready.'
                : displayText(ready.reason) || 'Ready is not available now.';
  const running = lifecycle === 'running';
  const terminal = ['completed', 'stopped', 'failed'].includes(lifecycle);
  const action = (enabled, reason) => ({enabled: connected && enabled, reason: connected ? enabled ? '' : reason : 'Connection lost. Reconnect before sending an action.'});
  const actions = {
    ready: action(running && ready.allowed === true, readyReason),
    prepare: action(lifecycle === 'draft', 'Only a draft run can be prepared.'),
    start: action(lifecycle === 'prepared' && state.recordingReady === true && state.testAudioPlayed === true && Boolean(state.playbackDeviceId),
      lifecycle !== 'prepared' ? 'Prepare the run before Start.' : 'Confirm recording and the designated phone audio test before Start.'),
    recordingReady: action(lifecycle === 'prepared', 'Confirm recording before Start.'),
    designatePlayback: action(!terminal && !running, 'Choose the instruction phone before Start.'),
    approachStarted: action(running && phase === 'APPROACH', 'Approach can be marked during the approach phase.'),
    arrived: action(running && ['APPROACH', 'TREE_APPROACH'].includes(phase), 'Arrival can be marked during approach.'),
    departureStarted: action(running && phase === 'DEPARTURE', 'Departure can be marked during the departure phase.'),
    departed: action(running && ['DEPARTURE', 'TREE_DEPARTURE'].includes(phase), 'Away can be marked during departure.'),
    stop: action(running || state.startRegistration?.status === 'pending', 'A running or pending registered run can be stopped.'),
  };
  return {
    hosted: true, runId, tag: displayText(state.tag), mode: displayText(state.mode), purpose: displayText(state.purpose),
    lifecycle, phase, running, terminal, config: state.config ? structuredClone(state.config) : null,
    siteId: displayText(state.siteId ?? state.config?.siteId),
    setupId: displayText(state.setupId ?? state.config?.setupId),
    seriesId: displayText(state.seriesId ?? state.config?.seriesId),
    currentInstruction: connected ? displayText(state.currentInstruction) : '',
    completedCount: Number.isInteger(state.completedCount) ? state.completedCount : 0,
    playbackDeviceId: displayText(state.playbackDeviceId),
    recordingReady: state.recordingReady === true,
    clockReferenceCount: Number.isSafeInteger(state.clockReferenceCount) ? state.clockReferenceCount : 0,
    testAudioPlayed: state.testAudioPlayed === true,
    setupStatus: displayText(state.setupStatus) || (state.setupId || state.config?.setupId ? 'prospective' : 'missing'),
    actions,
    connection: {connected, message: connected ? 'Connected to the study service.' : 'Connection lost. Current instruction and timing are unconfirmed. Reconnecting automatically.'},
    lastError: displayText(state.lastError?.message ?? state.lastError),
    startRegistration: structuredClone(state.startRegistration ?? null), startIssues: structuredClone(state.startIssues ?? []), streamUrl: state.streamUrl ?? null,
  };
}

function canonical(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Payload numbers must be finite.');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new Error('Payload must contain only finite JSON values.');
}

const receiptsByTransport = new WeakMap();

export async function dispatchAction(action, payload, send, requestId) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}`);
  if (typeof requestId !== 'string' || !requestId) throw new Error('A request ID is required.');
  const identity = canonical({action, payload});
  let receipts = receiptsByTransport.get(send);
  if (!receipts) receiptsByTransport.set(send, receipts = new Map());
  const retained = receipts.get(requestId);
  if (retained && retained.identity !== identity) throw new Error('Request ID belongs to a different action or payload.');
  if (retained?.promise) return retained.promise;
  const receipt = retained ?? {identity};
  receipts.set(requestId, receipt);
  try {
    // Invoke synchronously: Ready never waits for a browser countdown or acknowledgement sound.
    receipt.promise = Promise.resolve(send(action, payload, requestId));
    return await receipt.promise;
  } catch (error) {
    receipt.promise = null;
    throw error;
  }
}

export function createActionRunner(send, makeId = () => crypto.randomUUID(), initialPending = null, onPending = () => {}) {
  let pending = initialPending;
  let inFlight = null;
  let cancellationInFlight = null;
  const cancel = () => {
    if (cancellationInFlight) return cancellationInFlight;
    const cancellation = pending.cancellation;
    cancellationInFlight = dispatchAction('stop', cancellation.payload, send, cancellation.requestId)
      .then(result => {
        if (pending?.action === 'stop' && pending.requestId === cancellation.requestId) pending = null;
        else if (pending) delete pending.cancellation;
        onPending(pending); return result;
      })
      .finally(() => {cancellationInFlight = null;});
    return cancellationInFlight;
  };
  const execute = () => {
    if (inFlight) return inFlight;
    const retained = pending;
    inFlight = dispatchAction(retained.action, retained.payload, send, retained.requestId)
      .then(result => {pending = retained.cancellation ? {action: 'stop', ...retained.cancellation} : null; onPending(pending); return result;})
      .catch(error => {if (error.definitive) {pending = retained.cancellation ? {action: 'stop', ...retained.cancellation} : null; onPending(pending);} throw error;})
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    pending: () => pending ? structuredClone(pending) : null,
    run(action, payload) {
      if (pending) {
        if (action === 'stop' && pending.action === 'start') {
          if (!pending.cancellation) {pending.cancellation = {payload: structuredClone(payload), requestId: makeId()}; onPending(pending);}
          return cancel();
        }
        if (canonical({action, payload}) !== canonical({action: pending.action, payload: pending.payload})) {
          return Promise.reject(new Error('Resolve the unconfirmed action before sending another action.'));
        }
        return execute();
      }
      pending = {action, payload: structuredClone(payload), requestId: makeId()};
      try { onPending(pending); }
      catch (error) { pending = null; throw error; }
      return execute();
    },
    retry() {
      if (!pending) return Promise.reject(new Error('There is no unconfirmed action to retry.'));
      if (pending.cancellation) return cancel();
      return execute();
    },
  };
}
