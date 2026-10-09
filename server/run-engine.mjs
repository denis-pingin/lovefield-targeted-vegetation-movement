import {validateConfig} from '../web/run-config.mjs';

const INITIAL_DELIVERY_MARGIN_MS = 10000;
const TERMINAL_PHASES = new Set(['COMPLETE', 'STOPPED', 'FAILED']);

export function createRunState(config, startedAtMs, runId = null) {
  const frozenConfig = validateConfig(config);
  if (!Number.isFinite(startedAtMs)) throw new Error('A finite run creation time is required.');
  return {
    runId,
    config: frozenConfig,
    mode: config.mode,
    purpose: config.purpose,
    lifecycle: 'prepared',
    phase: config.mode === 'global' ? 'GLOBAL_READY' : config.mode === 'tree' ? 'TREE_READY' : 'LOCAL_READY',
    createdAtMs: startedAtMs,
    recordingStartedAtMs: null,
    activeStartedAtMs: null,
    phaseStartedAtMs: null,
    deliveryMarginMs: INITIAL_DELIVERY_MARGIN_MS,
    completedCount: 0,
    currentComparison: null,
    currentTrial: null,
    currentInstruction: null,
    localCompletionFinished: true,
    finalLocalRunCuePending: false,
    treeReleaseFinished: true,
    deadline: null,
    localDeadline: null,
    privateDurations: {},
    trials: [],
    physicalEvents: [],
  };
}

export function nextDeadline(state) {
  if (!state.deadline && !state.localDeadline) return null;
  if (!state.deadline) return structuredClone(state.localDeadline);
  if (!state.localDeadline) return structuredClone(state.deadline);
  return structuredClone(state.localDeadline.atMs <= state.deadline.atMs ? state.localDeadline : state.deadline);
}

export function publicRunState(state, nowMs = state.lastEventAtMs ?? Date.now()) {
  const config = state.config;
  const readiness = config && (state.mode === 'local' || state.mode === 'global')
    ? localEligibility(state, config, nowMs) : null;
  return {
    runId: state.runId ?? null,
    mode: state.mode ?? config?.mode ?? null,
    purpose: state.purpose ?? config?.purpose ?? null,
    lifecycle: state.lifecycle ?? null,
    phase: state.phase ?? null,
    currentInstruction: state.currentInstruction ?? null,
    completedCount: state.completedCount ?? 0,
    ready: readiness,
    lastError: state.lastError ?? null,
  };
}

export function localEligibility(state, config, nowMs) {
  if (config.mode !== 'local' && config.mode !== 'global') {
    return {allowed: false, readyAtMs: null, reason: 'not_local_mode'};
  }
  if (state.lifecycle !== 'running' || (config.mode === 'local' && state.phase !== 'LOCAL_RUNNING')) {
    return {allowed: false, readyAtMs: null, reason: 'not_running'};
  }
  if (!Number.isFinite(state.recordingStartedAtMs)) {
    return {allowed: false, readyAtMs: null, reason: 'recording_not_started'};
  }
  const historyStartMs = Math.max(
    state.recordingStartedAtMs,
    state.activeStartedAtMs ?? state.recordingStartedAtMs,
    state.baselineRestartAtMs ?? 0,
    state.previousResponseEndMs == null ? 0 : state.previousResponseEndMs + config.local.recoverySeconds * 1000,
  );
  const readyAtMs = historyStartMs + config.local.baselineSeconds * 1000;
  if (config.mode === 'global' && state.phase !== 'ACTIVE') {
    return {allowed: false, readyAtMs, reason: 'not_active'};
  }
  if (state.currentComparison) {
    return {allowed: false, readyAtMs, reason: 'comparison_open'};
  }
  if (state.localCompletionFinished === false || state.pendingDelivery?.stream === 'localComplete') {
    return {allowed: false, readyAtMs, reason: 'completion_cue_pending'};
  }
  if ((state.completedCount ?? 0) >= config.local.count) {
    return {allowed: false, readyAtMs, reason: 'count_complete'};
  }
  let cutoffAtMs = null;
  if (config.mode === 'global') {
    cutoffAtMs = state.activeStartedAtMs + Math.min(...config.global.activeSeconds) * 1000
      - config.local.responseSeconds * 1000
      - config.local.recoverySeconds * 1000
      - (state.deliveryMarginMs ?? INITIAL_DELIVERY_MARGIN_MS);
    if (nowMs > cutoffAtMs) return {allowed: false, readyAtMs, cutoffAtMs, reason: 'active_cutoff'};
  }
  if (nowMs < readyAtMs) {
    return {allowed: false, readyAtMs, reason: 'baseline_incomplete'};
  }
  return {allowed: true, readyAtMs, ...(cutoffAtMs === null ? {} : {cutoffAtMs}), reason: null};
}

function setDeadline(state, kind, atMs) {
  const slot = kind.startsWith('local') ? 'localDeadline' : 'deadline';
  state[slot] = {kind, atMs};
  return {kind: 'scheduleDeadline', deadline: kind, atMs};
}

function receivedDuration(state, event, config, effects) {
  const settings = {
    absentDuration: {phase: 'ABSENT', choices: config.global.absentSeconds, next: 'approachDue'},
    passiveDuration: {phase: 'PASSIVE', choices: config.global.passiveSeconds, next: 'practiceDue'},
    activeDuration: {phase: 'ACTIVE', choices: config.global.activeSeconds, next: 'departDue'},
  }[event.stream];
  if (!settings || state.phase !== settings.phase || !settings.choices.includes(event.value)) {
    throw new Error('Duration assignment does not match the current phase and configured choices.');
  }
  state.privateDurations[event.stream] = event.value;
  effects.push(setDeadline(state, settings.next, state.phaseStartedAtMs + event.value * 1000));
}

function completeLocalRun(state, config, effects) {
  if (config.mode === 'local' && state.completedCount >= config.local.count) {
    state.phase = 'COMPLETE';
    state.lifecycle = 'completed';
    if (state.finalLocalRunCuePending && state.localCompletionFinished) {
      state.finalLocalRunCuePending = false;
      effects.push({kind: 'deliverCue', stream: 'runFinished', text: 'Run finished'});
    }
  }
}

function closeLocalResponse(state, event, config, effects) {
  if (!state.currentComparison?.response) throw new Error('Local response has not started.');
  const responseEndMs = state.currentComparison.response[1];
  if (event.serverAtMs < responseEndMs) throw new Error('Local response is still in progress.');
  state.previousResponseEndMs = responseEndMs;
  state.completedCount = (state.completedCount ?? 0) + 1;
  state.lastComparison = state.currentComparison;
  state.currentComparison = null;
  state.localDeadline = null;
  state.currentInstruction = null;
  state.localCompletionFinished = false;
  const finalLocalResponse = config.mode === 'local' && state.completedCount >= config.local.count;
  state.finalLocalRunCuePending = finalLocalResponse && config.local.recoverySeconds > 0;
  effects.push({kind: 'deliverCue', stream: 'localComplete',
    text: config.local.recoverySeconds > 0
      ? config.local.announceRelease ? 'Release' : 'Response complete'
      : finalLocalResponse ? 'Run finished' : 'Continue practice'});
  if (config.local.recoverySeconds > 0) {
    const recoveryEndMs = responseEndMs + config.local.recoverySeconds * 1000;
    effects.push(setDeadline(state, 'localRecoveryEnd', recoveryEndMs));
  } else {
    completeLocalRun(state, config, effects);
  }
}

function closeTreeResponse(state, event, config, effects) {
  if (!state.currentTrial?.response) throw new Error('Tree response has not started.');
  const responseEndMs = state.currentTrial.response[1];
  if (event.serverAtMs < responseEndMs) throw new Error('Tree response is still in progress.');
  state.trials.push(state.currentTrial);
  state.currentTrial = null;
  state.completedCount += 1;
  state.currentInstruction = null;
  state.deadline = null;
  if (state.completedCount >= config.tree.count) {
    if (state.config.tree.postRollSeconds == null) {
      state.phase = 'COMPLETE';
      state.lifecycle = 'completed';
      effects.push({kind: 'deliverCue', stream: 'runFinished', text: 'Run finished'});
    } else {
      state.phase = 'TREE_WAIT_DEPART';
      effects.push({kind: 'deliverCue', stream: 'treeDepart', text: 'Depart'});
    }
    return;
  }
  if (config.tree.recoverySeconds > 0) {
    state.phase = 'TREE_RECOVERY';
    state.treeReleaseFinished = false;
    effects.push({kind: 'deliverCue', stream: 'treeRelease',
      text: config.tree.announceRelease ? 'Release' : 'Response complete'});
    effects.push(setDeadline(state, 'treeRecoveryEnd', responseEndMs + config.tree.recoverySeconds * 1000));
  } else {
    state.phase = 'TREE_WAIT_CUE';
    effects.push({kind: 'requestAssignment', stream: 'tree'});
  }
}

function reachedDeadline(state, event, config, effects) {
  const slot = state.localDeadline && (!state.deadline || state.localDeadline.atMs <= state.deadline.atMs)
    ? 'localDeadline' : 'deadline';
  if (!state[slot] || event.serverAtMs < state[slot].atMs) {
    throw new Error('No operational deadline is due.');
  }
  const {kind} = state[slot];
  state[slot] = null;
  const cue = {
    approachDue: {stream: 'approach', text: 'Approach'},
    practiceDue: {stream: 'startPractice', text: 'Start practice'},
    departDue: {stream: 'depart', text: 'Depart'},
  }[kind];
  if (cue) {
    state.pendingCue = cue;
    effects.push({kind: 'deliverCue', ...cue});
  } else if (kind === 'settlementEnd') {
    state.phase = 'COMPLETE';
    state.lifecycle = 'completed';
  } else if (kind === 'treeResponseEnd') {
    closeTreeResponse(state, event, config, effects);
  } else if (kind === 'treePreRollEnd') {
    state.phase = 'TREE_WAIT_APPROACH';
    effects.push({kind: 'deliverCue', stream: 'treeApproach', text: 'Approach'});
  } else if (kind === 'treePostRollEnd') {
    state.phase = 'COMPLETE';
    state.lifecycle = 'completed';
    effects.push({kind: 'deliverCue', stream: 'runFinished', text: 'Run finished'});
  } else if (kind === 'localResponseEnd') {
    closeLocalResponse(state, event, config, effects);
  } else if (kind === 'treeRecoveryEnd') {
    if (state.treeReleaseFinished === false) state.phase = 'TREE_WAIT_RELEASE';
    else {
      state.phase = 'TREE_WAIT_CUE';
      effects.push({kind: 'requestAssignment', stream: 'tree'});
    }
  } else if (kind === 'localRecoveryEnd') {
    completeLocalRun(state, config, effects);
  } else {
    throw new Error(`Unknown operational deadline: ${kind}`);
  }
}

export function applyEvent(state, event, config) {
  const next = structuredClone(state);
  const effects = [];
  if (event.kind === 'stop') {
    if (!TERMINAL_PHASES.has(next.phase)) {
      next.phase = 'STOPPED';
      next.lifecycle = 'stopped';
      next.deadline = null;
      next.localDeadline = null;
    }
    return {state: next, effects};
  }
  const completingSpeech = next.phase === 'COMPLETE' && (
    event.kind === 'cuePlayed' && ['localComplete', 'runFinished'].includes(event.stream) ||
    event.kind === 'cueEnded' && event.stream === 'localComplete'
  );
  if (TERMINAL_PHASES.has(next.phase) && !completingSpeech) return {state: next, effects};
  next.lastEventAtMs = event.serverAtMs;

  if (event.kind === 'start') {
    if (next.lifecycle !== 'prepared') throw new Error('Run has already started.');
    next.lifecycle = 'running';
    next.recordingStartedAtMs = event.serverAtMs;
    next.phaseStartedAtMs = event.serverAtMs;
    if (config.mode === 'global') {
      next.phase = 'ABSENT';
      effects.push({kind: 'requestAssignment', stream: 'absentDuration'});
    } else if (config.mode === 'tree') {
      if (next.config.tree.preRollSeconds == null) {
        next.phase = 'TREE_WAIT_CUE';
        effects.push({kind: 'requestAssignment', stream: 'tree'});
      } else {
        next.phase = 'TREE_PREROLL';
        effects.push(setDeadline(next, 'treePreRollEnd', event.serverAtMs + next.config.tree.preRollSeconds * 1000));
      }
    } else {
      next.phase = 'LOCAL_RUNNING';
    }
    return {state: next, effects};
  }

  if (event.kind === 'ready') {
    const eligibility = localEligibility(next, config, event.serverAtMs);
    if (!eligibility.allowed) {
      next.lastEligibilityReason = eligibility.reason;
      return {state: next, effects};
    }
    next.lastEligibilityReason = null;
    next.currentComparison = {
      index: (next.completedCount ?? 0) + 1,
      readyAtMs: event.serverAtMs,
      baseline: [event.serverAtMs - config.local.baselineSeconds * 1000, event.serverAtMs],
      response: null,
    };
    next.currentInstruction = null;
    effects.push({kind: 'requestAssignment', stream: 'local'});
    return {state: next, effects};
  }

  if (event.kind === 'assignmentReceived') {
    if (config.mode === 'global' && ['absentDuration', 'passiveDuration', 'activeDuration'].includes(event.stream)) {
      receivedDuration(next, event, config, effects);
    } else if (event.stream === 'tree' && config.mode === 'tree' && next.phase === 'TREE_WAIT_CUE') {
      if (!['A', 'B'].includes(event.value)) throw new Error('Tree target must be A or B.');
      next.currentTrial = {index: next.completedCount + 1, target: event.value, cueId: event.cueId ?? null, response: null};
      effects.push({kind: 'deliverCue', stream: 'tree', text: `Target ${event.value}`, cueId: event.cueId ?? null});
    } else if (event.stream === 'local' && next.currentComparison && ['CHANGE', 'HOLD'].includes(event.value)) {
      next.currentComparison.assignment = event.value;
      effects.push({kind: 'deliverCue', stream: 'local', text: event.value, cueId: event.cueId ?? null});
    } else {
      throw new Error('Assignment does not match a pending opportunity.');
    }
    return {state: next, effects};
  }

  if (event.kind === 'deadlineReached') {
    reachedDeadline(next, event, config, effects);
    return {state: next, effects};
  }

  if (event.kind === 'cuePlayed' && event.stream === 'local') {
    if (!next.currentComparison || next.currentComparison.response) {
      throw new Error('No pending local comparison can receive this cue.');
    }
    const playedAtMs = event.playedAtMs ?? event.serverAtMs;
    const responseEndMs = playedAtMs + config.local.responseSeconds * 1000;
    next.currentComparison.response = [playedAtMs, responseEndMs];
    next.currentComparison.cueId = event.cueId ?? null;
    next.currentInstruction = next.currentComparison.assignment ?? null;
    effects.push(setDeadline(next, 'localResponseEnd', responseEndMs));
    return {state: next, effects};
  }

  if (event.kind === 'cuePlayed' && event.stream === 'tree') {
    if (next.phase !== 'TREE_WAIT_CUE' || !next.currentTrial || next.currentTrial.response) {
      throw new Error('No pending tree target can receive this cue.');
    }
    const playedAtMs = event.playedAtMs ?? event.serverAtMs;
    const responseEndMs = playedAtMs + config.tree.responseSeconds * 1000;
    next.currentTrial.response = [playedAtMs, responseEndMs];
    next.currentTrial.cueId = event.cueId ?? next.currentTrial.cueId;
    next.phase = 'TREE_RESPONSE';
    next.currentInstruction = `Target ${next.currentTrial.target}`;
    effects.push(setDeadline(next, 'treeResponseEnd', responseEndMs));
    return {state: next, effects};
  }

  if (event.kind === 'cuePlayed' && event.stream === 'treeApproach' && next.phase === 'TREE_WAIT_APPROACH') {
    next.phase = 'TREE_APPROACH';
    next.currentInstruction = 'Approach';
    return {state: next, effects};
  }

  if (event.kind === 'cuePlayed' && event.stream === 'treeDepart' && next.phase === 'TREE_WAIT_DEPART') {
    next.phase = 'TREE_DEPARTURE';
    next.currentInstruction = 'Leave the area';
    return {state: next, effects};
  }

  if (event.kind === 'cuePlayed' && event.stream === 'localComplete') {
    next.currentInstruction = event.text ?? (config.local.recoverySeconds > 0 ? 'Response complete' : 'Continue practice');
    return {state: next, effects};
  }

  if (event.kind === 'cuePlayed' && event.stream === 'treeRelease') {
    next.currentInstruction = event.text ?? 'Response complete';
    return {state: next, effects};
  }

  if (event.kind === 'cuePlayed' && event.stream === 'runFinished') {
    next.currentInstruction = 'Run finished';
    return {state: next, effects};
  }

  if (event.kind === 'cueEnded' && event.stream === 'localComplete') {
    next.localCompletionFinished = true;
    if (next.lifecycle === 'completed' && next.finalLocalRunCuePending) {
      next.finalLocalRunCuePending = false;
      effects.push({kind: 'deliverCue', stream: 'runFinished', text: 'Run finished'});
    }
    return {state: next, effects};
  }

  if (event.kind === 'cueEnded' && event.stream === 'treeRelease') {
    next.treeReleaseFinished = true;
    if (next.phase === 'TREE_WAIT_RELEASE') {
      next.phase = 'TREE_WAIT_CUE';
      effects.push({kind: 'requestAssignment', stream: 'tree'});
    }
    return {state: next, effects};
  }

  if (event.kind === 'cuePlayed' && ['approach', 'startPractice', 'depart'].includes(event.stream)) {
    if (next.pendingCue?.stream !== event.stream) throw new Error('Global cue was not due.');
    const playedAtMs = event.playedAtMs ?? event.serverAtMs;
    next.currentInstruction = next.pendingCue.text;
    next.pendingCue = null;
    next.phaseStartedAtMs = playedAtMs;
    if (event.stream === 'approach') next.phase = 'APPROACH';
    if (event.stream === 'startPractice') {
      next.phase = 'ACTIVE';
      next.activeStartedAtMs = playedAtMs;
      effects.push({kind: 'requestAssignment', stream: 'activeDuration'});
    }
    if (event.stream === 'depart') next.phase = 'DEPARTURE';
    return {state: next, effects};
  }

  if (event.kind === 'approachStarted' || event.kind === 'departureStarted') {
    next.physicalEvents ??= [];
    next.physicalEvents.push({kind: event.kind, occurredAtMs: event.occurredAtMs ?? event.serverAtMs});
    return {state: next, effects};
  }
  if (event.kind === 'arrived' && next.phase === 'APPROACH') {
    next.physicalEvents ??= [];
    next.physicalEvents.push({kind: 'arrived', occurredAtMs: event.occurredAtMs ?? event.serverAtMs});
    next.phase = 'PASSIVE';
    next.phaseStartedAtMs = event.occurredAtMs ?? event.serverAtMs;
    next.currentInstruction = null;
    effects.push({kind: 'requestAssignment', stream: 'passiveDuration'});
    return {state: next, effects};
  }
  if (event.kind === 'arrived' && next.phase === 'TREE_APPROACH') {
    next.physicalEvents ??= [];
    next.physicalEvents.push({kind: 'arrived', occurredAtMs: event.occurredAtMs ?? event.serverAtMs});
    next.phase = 'TREE_WAIT_CUE';
    next.currentInstruction = null;
    effects.push({kind: 'requestAssignment', stream: 'tree'});
    return {state: next, effects};
  }
  if (event.kind === 'away' && next.phase === 'DEPARTURE') {
    next.physicalEvents ??= [];
    next.physicalEvents.push({kind: 'away', occurredAtMs: event.occurredAtMs ?? event.serverAtMs});
    next.phase = 'SETTLEMENT';
    next.phaseStartedAtMs = event.occurredAtMs ?? event.serverAtMs;
    next.currentInstruction = null;
    effects.push(setDeadline(next, 'settlementEnd', next.phaseStartedAtMs + config.global.settlementSeconds * 1000));
    return {state: next, effects};
  }
  if (event.kind === 'away' && next.phase === 'TREE_DEPARTURE') {
    next.physicalEvents ??= [];
    next.physicalEvents.push({kind: 'away', occurredAtMs: event.occurredAtMs ?? event.serverAtMs});
    next.phase = 'TREE_POSTROLL';
    next.currentInstruction = null;
    effects.push(setDeadline(next, 'treePostRollEnd', event.serverAtMs + next.config.tree.postRollSeconds * 1000));
    return {state: next, effects};
  }

  if (event.kind === 'responseEnded') {
    if (next.mode === 'tree' && next.currentTrial) closeTreeResponse(next, event, config, effects);
    else if (next.currentComparison) closeLocalResponse(next, event, config, effects);
    return {state: next, effects};
  }
  if (event.kind === 'recoveryEnded' && next.mode === 'tree' && next.phase === 'TREE_RECOVERY') {
    if (!next.deadline || event.serverAtMs < next.deadline.atMs) throw new Error('Tree recovery has not ended.');
    next.deadline = null;
    if (next.treeReleaseFinished === false) next.phase = 'TREE_WAIT_RELEASE';
    else {
      next.phase = 'TREE_WAIT_CUE';
      effects.push({kind: 'requestAssignment', stream: 'tree'});
    }
    return {state: next, effects};
  }
  if (event.kind === 'baselineRestart') {
    next.baselineRestartAtMs = event.serverAtMs;
    return {state: next, effects};
  }
  throw new Error(`Unexpected event in ${next.phase}: ${event.kind}`);
}
