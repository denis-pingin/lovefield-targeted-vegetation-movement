const DEFAULT_JUMP_THRESHOLD_MS = 500;

export function startClockRedraw({requestAnimationFrame, cancelAnimationFrame, draw}) {
  let stopped = false;
  let frame;
  const redraw = timestamp => {
    if (stopped) return;
    draw(timestamp);
    frame = requestAnimationFrame(redraw);
  };
  frame = requestAnimationFrame(redraw);
  return () => { stopped = true; cancelAnimationFrame(frame); };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function evaluateSample(raw, jumpThresholdMs) {
  const {clientSentAtMs: c1, serverReceivedAtMs: s2, serverSentAtMs: s3,
    clientReceivedAtMs: c4, clientSentMonotonicMs: m1, clientReceivedMonotonicMs: m4} = raw;
  if (![c1, s2, s3, c4, m1, m4].every(isFiniteNumber) || !raw.exchangeId) {
    return {...raw, valid: false, reason: 'missing_or_invalid_timestamp'};
  }
  if (c4 < c1 || s3 < s2 || m4 < m1) return {...raw, valid: false, reason: 'negative_elapsed_time'};
  if (Math.abs((c4 - c1) - (m4 - m1)) > jumpThresholdMs) {
    return {...raw, valid: false, reason: 'wall_clock_jump'};
  }
  const networkRoundTripMs = (c4 - c1) - (s3 - s2);
  if (networkRoundTripMs < 0) return {...raw, valid: false, reason: 'negative_network_delay'};
  const offsetMs = ((s2 - c1) + (s3 - c4)) / 2;
  return {...raw, valid: true, networkRoundTripMs, offsetMs, uncertaintyMs: networkRoundTripMs / 2};
}

export async function measureClock({exchange, wallNow = Date.now, monotonicNow = () => performance.now(),
  count = 5, previousReference = null, jumpThresholdMs = DEFAULT_JUMP_THRESHOLD_MS, warn = console.warn}) {
  if (typeof exchange !== 'function' || typeof wallNow !== 'function' || typeof monotonicNow !== 'function'
    || !Number.isInteger(count) || count < 1 || !isFiniteNumber(jumpThresholdMs) || jumpThresholdMs < 0) {
    throw new TypeError('A clock exchange and valid measurement settings are required.');
  }
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const clientSentAtMs = wallNow();
    const clientSentMonotonicMs = monotonicNow();
    try {
      const reply = await exchange({clientSentAtMs, clientSentMonotonicMs, index});
      const clientReceivedAtMs = wallNow();
      const clientReceivedMonotonicMs = monotonicNow();
      samples.push(evaluateSample({clientSentAtMs, clientSentMonotonicMs,
        clientReceivedAtMs, clientReceivedMonotonicMs,
        serverReceivedAtMs: reply?.serverReceivedAtMs,
        serverSentAtMs: reply?.serverSentAtMs,
        exchangeId: reply?.exchangeId}, jumpThresholdMs));
    } catch (error) {
      const clientReceivedAtMs = wallNow();
      const clientReceivedMonotonicMs = monotonicNow();
      warn(`Clock exchange ${index + 1} failed; retaining an invalid sample.`, error);
      samples.push({clientSentAtMs, clientSentMonotonicMs, clientReceivedAtMs,
        clientReceivedMonotonicMs, valid: false, reason: 'exchange_failed', error: String(error?.message ?? error)});
    }
  }
  let lastJumpIndex = -1;
  for (let index = 0; index < samples.length; index += 1) {
    if (samples[index].reason === 'wall_clock_jump') lastJumpIndex = index;
    if (index === 0) continue;
    const prior = samples[index - 1];
    const currentSample = samples[index];
    if ([prior.clientSentAtMs, currentSample.clientSentAtMs,
      prior.clientSentMonotonicMs, currentSample.clientSentMonotonicMs].every(isFiniteNumber)
      && (currentSample.clientSentMonotonicMs < prior.clientSentMonotonicMs
        || Math.abs((currentSample.clientSentAtMs - prior.clientSentAtMs)
          - (currentSample.clientSentMonotonicMs - prior.clientSentMonotonicMs)) > jumpThresholdMs)) {
      lastJumpIndex = Math.max(lastJumpIndex, index - 1);
    }
  }
  const selected = samples.slice(lastJumpIndex + 1).filter(sample => sample.valid)
    .sort((left, right) => left.networkRoundTripMs - right.networkRoundTripMs)[0] ?? null;
  const previous = previousReference?.selected;
  const current = selected;
  const withinExchangeJump = lastJumpIndex >= 0;
  const betweenReferencesJump = Boolean(previous && current && (
    current.clientReceivedMonotonicMs < previous.clientReceivedMonotonicMs
    || Math.abs((current.clientReceivedAtMs - previous.clientReceivedAtMs)
      - (current.clientReceivedMonotonicMs - previous.clientReceivedMonotonicMs)) > jumpThresholdMs));
  const clockJump = withinExchangeJump || betweenReferencesJump;
  const segment = (previousReference?.segment ?? 0) + Number(clockJump);
  return {
    samples, selected, valid: Boolean(selected),
    offsetMs: selected?.offsetMs ?? null,
    uncertaintyMs: selected?.uncertaintyMs ?? null,
    clockJump, segment,
    ...(selected ? {} : {error: 'No valid clock exchange. Repeat before relying on timed events.'}),
  };
}

export function clockReferenceDisplay(reference, phoneAtMs = Date.now()) {
  if (!reference?.valid || !reference.selected || !isFiniteNumber(reference.offsetMs)
    || !isFiniteNumber(reference.uncertaintyMs) || !isFiniteNumber(phoneAtMs)) {
    throw new TypeError('A valid clock reference and phone time are required.');
  }
  const estimatedServerAtMs = phoneAtMs + reference.offsetMs;
  return {
    phoneAtMs,
    estimatedServerAtMs,
    phoneTimeText: new Date(phoneAtMs).toISOString(),
    serverTimeText: new Date(estimatedServerAtMs).toISOString(),
    uncertaintyMs: reference.uncertaintyMs,
    exchangeId: reference.selected.exchangeId,
    segment: reference.segment ?? 0,
  };
}
