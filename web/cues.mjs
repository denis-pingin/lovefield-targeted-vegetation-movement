const failureMessage = reason => `Cue delivery failed (${reason}). Stop and check the phone audio and connection.`;
const cueAudioFiles = new Map([
  ['Test audio', 'test-audio.mp3'], ['Approach', 'approach.mp3'],
  ['Start practice', 'start-practice.mp3'], ['Depart', 'depart.mp3'],
  ['CHANGE', 'change.mp3'], ['HOLD', 'hold.mp3'],
  ['Continue practice', 'continue-practice.mp3'], ['Release', 'release.mp3'],
  ['Response complete', 'response-complete.mp3'], ['Run finished', 'run-finished.mp3'],
  ['Target A', 'target-a.mp3'], ['Target B', 'target-b.mp3'],
]);

export function createCuePlayer({createAudio, now, record, display, warn = console.warn,
  experimentSlug, runId, storage = null, maxCueWaitMs = 10000,
  scheduleTimeout = globalThis.setTimeout, cancelTimeout = globalThis.clearTimeout}) {
  if (typeof createAudio !== 'function' || typeof now !== 'function'
    || typeof record !== 'function' || typeof display !== 'function'
    || typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function'
    || !Number.isFinite(maxCueWaitMs) || maxCueWaitMs <= 0) {
    throw new TypeError('Audio, clock, recording and display functions are required.');
  }
  const deliveries = new Map();
  const persistedByScope = new Map();
  const scopeFor = cue => ({
    experimentSlug: cue.experimentSlug ?? experimentSlug,
    runId: cue.runId ?? runId,
  });
  const keyFor = cue => JSON.stringify([scopeFor(cue).experimentSlug, scopeFor(cue).runId, cue.cueId]);
  const storageKey = scope => `tree-targeting:delivered-cues:${scope.experimentSlug}:${scope.runId}`;

  function deliveredIds(scope) {
    const key = storageKey(scope);
    if (!persistedByScope.has(key)) {
      let ids = [];
      if (storage) {
        try {
          const raw = storage.getItem(key);
          if (raw) {
            ids = JSON.parse(raw);
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
              throw new Error('Stored cue IDs must be an array of strings.');
            }
          }
        } catch (error) {
          warn(`Run ${scope.runId}: stored cue IDs could not be read; relying on server state.`, error);
          ids = [];
        }
      }
      persistedByScope.set(key, new Set(ids));
    }
    return persistedByScope.get(key);
  }

  function rememberDelivery(scope, cueId) {
    const ids = deliveredIds(scope);
    ids.add(cueId);
    if (!storage) return;
    try {
      storage.setItem(storageKey(scope), JSON.stringify([...ids]));
    } catch (error) {
      warn(`Run ${scope.runId}: delivered cue ${cueId} could not be retained locally; server acknowledgement still applies.`, error);
    }
  }

  function recordEvent(event, entry, failedMessage) {
    try {
      Promise.resolve(record(event)).catch(error => {
        warn(`Cue ${event.cueId} in run ${event.runId ?? 'unspecified'}: ${event.kind} could not be recorded.`, error);
        if (failedMessage) {
          entry.status = 'unconfirmed';
          display(failedMessage, {status: 'unconfirmed', cueId: event.cueId});
        }
      });
    } catch (error) {
      warn(`Cue ${event.cueId} in run ${event.runId ?? 'unspecified'}: ${event.kind} could not be recorded.`, error);
      if (failedMessage) {
        entry.status = 'unconfirmed';
        display(failedMessage, {status: 'unconfirmed', cueId: event.cueId});
      }
    }
  }

  function play(cue) {
    if (!cue || typeof cue.cueId !== 'string' || !cue.cueId || typeof cue.text !== 'string' || !cue.text) {
      throw new TypeError('A cue ID and spoken text are required.');
    }
    const key = keyFor(cue);
    if (deliveries.has(key)) return false;
    const scope = scopeFor(cue);
    if (deliveredIds(scope).has(cue.cueId)) return false;
    const entry = {status: 'queued'};
    deliveries.set(key, entry);
    const base = {cueId: cue.cueId, ...(scope.experimentSlug ? {experimentSlug: scope.experimentSlug} : {}),
      ...(scope.runId ? {runId: scope.runId} : {})};

    function fail(reason) {
      if (entry.status === 'failed' || entry.status === 'ended') return;
      cancelTimeout(entry.startTimer);
      const afterStart = entry.status === 'played' || entry.status === 'unconfirmed';
      entry.status = 'failed';
      entry.audio = null;
      display(failureMessage(reason), {status: 'failed', cueId: cue.cueId});
      recordEvent({kind: 'cueFailed', ...base, clientAtMs: now(), reason, ...(afterStart ? {afterStart: true} : {})}, entry);
    }

    const filename = cueAudioFiles.get(cue.text);
    if (!filename) {
      fail('unsupported_audio_cue');
      return true;
    }
    try {
      const audio = createAudio(new URL(`./${filename}`, import.meta.url).href);
      entry.audio = audio;
      audio.addEventListener('playing', () => {
        if (entry.status !== 'queued') return;
        cancelTimeout(entry.startTimer);
        entry.status = 'played';
        const clientAtMs = now();
        rememberDelivery(scope, cue.cueId);
        display(cue.text, {status: 'played', cueId: cue.cueId});
        recordEvent({kind: 'cuePlayed', ...base, clientAtMs}, entry,
          'The cue was played, but delivery could not be confirmed. Stop and reconnect.');
      }, {once: true});
      audio.addEventListener('ended', () => {
        if (entry.status !== 'played') return;
        entry.status = 'ended';
        entry.audio = null;
        recordEvent({kind: 'cueEnded', ...base, clientAtMs: now()}, entry);
      }, {once: true});
      audio.addEventListener('error', () => fail(`media_error_${audio.error?.code ?? 'unknown'}`), {once: true});
      entry.startTimer = scheduleTimeout(() => {
        if (entry.status === 'queued') fail('audio_start_timeout');
      }, maxCueWaitMs);
      Promise.resolve(audio.play()).catch(error => fail(`audio_play_${error?.name ?? 'failed'}`));
    } catch (error) {
      fail(error?.name ? `audio_play_${error.name}` : 'audio_play_failed');
    }
    return true;
  }

  return {
    play,
    delivery(cueId, scope = {}) {
      const key = JSON.stringify([scope.experimentSlug ?? experimentSlug, scope.runId ?? runId, cueId]);
      const entry = deliveries.get(key);
      return entry ? {status: entry.status} : null;
    },
  };
}

export function createInstructionScreenLock({document, wakeLock, deviceId, onWarning, warn = console.warn}) {
  let selectedRun = null;
  let requestedRunId = null;
  let sentinel = null;
  let pending = null;
  let generation = 0;
  let stopped = false;
  const warning = (runId, reason, error) => {
    warn(`Run ${runId}: ${reason}; the screen may sleep.`, error);
    onWarning(`Cannot keep this phone screen awake: ${reason}. Keep the instruction page visible and check the phone's screen settings.`);
  };
  const release = async (lock, runId) => {
    try { await lock.release(); }
    catch (error) { warning(runId, 'screen wake lock could not be released', error); }
  };
  function update(state = selectedRun) {
    selectedRun = state;
    const runId = !stopped && (state?.lifecycle === 'running' || state?.instructionAudioPending === true)
      && state.playbackDeviceId === deviceId
      && document.visibilityState !== 'hidden' ? state.runId : null;
    if (runId === requestedRunId) return pending;
    const previousRunId = requestedRunId;
    requestedRunId = runId;
    const currentGeneration = ++generation;
    if (sentinel) {
      const previous = sentinel;
      sentinel = null;
      void release(previous, previousRunId);
    }
    if (!runId) return null;
    pending = (async () => {
      if (!wakeLock?.request) { warning(runId, 'screen wake lock is not supported'); return; }
      try {
        const acquired = await wakeLock.request('screen');
        if (currentGeneration !== generation) { await release(acquired, runId); return; }
        sentinel = acquired;
        acquired.addEventListener('release', () => {
          if (sentinel !== acquired) return;
          sentinel = null;
          if (document.visibilityState !== 'hidden' && !stopped) warning(runId, 'the phone released its screen wake lock');
        }, {once: true});
        if (acquired.released) {
          sentinel = null;
          warning(runId, 'the phone released its screen wake lock');
        }
      } catch (error) {
        if (currentGeneration === generation) warning(runId, 'the phone denied its screen wake lock', error);
        else warn(`Run ${runId}: an obsolete screen wake-lock request failed; no lock is held for that request.`, error);
      }
    })();
    return pending;
  }
  const visibilityChanged = () => { void update(); };
  document.addEventListener('visibilitychange', visibilityChanged);
  return {update, stop() {
    stopped = true;
    document.removeEventListener('visibilitychange', visibilityChanged);
    void update(null);
  }};
}

export function createRunConnection({connect, experimentSlug, runId, onState, onStatus, onCue = () => {},
  warn = console.warn, storage = null,
  scheduleTimeout = globalThis.setTimeout, cancelTimeout = globalThis.clearTimeout}) {
  if (typeof connect !== 'function' || typeof onState !== 'function' || typeof onStatus !== 'function'
    || typeof onCue !== 'function'
    || !experimentSlug || !runId) throw new TypeError('Run connection parameters are required.');
  let connection = null;
  let state = null;
  let generation = 0;
  let connected = false;
  let enabled = false;
  let opening = false;
  let retryTimer = null;
  let synchronizationTimer = null;
  let retryDelay = 1000;
  const currentRunKey = `tree-targeting:current-run:${experimentSlug}`;
  const notify = (isConnected, message) => {
    connected = isConnected;
    onStatus({connected, message});
  };
  const disconnect = message => {
    state = null;
    onState(null);
    notify(false, message);
  };
  function close() {
    generation += 1;
    opening = false;
    cancelTimeout(retryTimer);
    cancelTimeout(synchronizationTimer);
    retryTimer = null;
    synchronizationTimer = null;
    const previous = connection;
    connection = null;
    previous?.close();
  }
  function failed(currentGeneration, error) {
    if (currentGeneration !== generation) return;
    close();
    warn(`Run ${runId}: event connection failed; reconnecting automatically and waiting for current server state.`, error);
    disconnect('Connection lost. The current instruction is unconfirmed; reconnecting automatically.');
    if (!enabled) return;
    retryTimer = scheduleTimeout(() => { retryTimer = null; void open(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }
  async function open() {
    if (!enabled || connection || opening) return;
    opening = true;
    const currentGeneration = ++generation;
    notify(false, 'Connecting to the run.');
    synchronizationTimer = scheduleTimeout(() => failed(currentGeneration,
      new Error('The live connection did not supply current run state within ten seconds.')), 10000);
    try {
      const opened = await connect({experimentSlug, runId,
        onCue(cue) {
          if (currentGeneration !== generation) return;
          if (cue?.runId !== runId || (cue.experimentSlug && cue.experimentSlug !== experimentSlug)) {
            warn(`Run ${runId}: ignored cue for another experiment or run.`, cue?.runId);
            return;
          }
          onCue(structuredClone(cue));
        },
        onState(nextState) {
          if (currentGeneration !== generation) return;
          if (nextState?.runId !== runId
            || (nextState.experimentSlug && nextState.experimentSlug !== experimentSlug)) {
            warn(`Run ${runId}: ignored state for another experiment or run.`, nextState?.runId);
            return;
          }
          state = structuredClone(nextState);
          cancelTimeout(synchronizationTimer);
          synchronizationTimer = null;
          retryDelay = 1000;
          onState(structuredClone(state));
          notify(true, 'Connected to the run.');
        },
        onClose() {
          failed(currentGeneration, new Error('The live socket closed.'));
        },
        onError(error) {
          failed(currentGeneration, error);
        },
      });
      if (currentGeneration !== generation) {
        opened?.close();
        return;
      }
      opening = false;
      connection = opened;
    } catch (error) {
      failed(currentGeneration, error);
    }
  }
  return {
    start() {
      enabled = true;
      if (storage) {
        try { storage.setItem(currentRunKey, runId); }
        catch (error) { warn(`Run ${runId}: current-run identity could not be retained locally.`, error); }
      }
      return open();
    },
    reconnect() {
      if (!enabled) return;
      close();
      disconnect('Reconnecting. The current instruction is unconfirmed until server state arrives.');
      return open();
    },
    current: () => connected && state ? structuredClone(state) : null,
    stop() {
      enabled = false;
      close();
      if (storage) {
        try {
          storage.removeItem(currentRunKey);
        } catch (error) {
          warn(`Run ${runId}: current-run identity could not be removed from local storage.`, error);
        }
      }
      disconnect('Disconnected from the run.');
    },
  };
}
