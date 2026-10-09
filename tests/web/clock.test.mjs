import test from 'node:test';
import assert from 'node:assert/strict';
import {measureClock, clockReferenceDisplay} from '../../web/clock.mjs';
import * as clock from '../../web/clock.mjs';

test('filmed clock redraws on consecutive browser frames and cancels on stop', () => {
  const pending = new Map();
  const drawn = [];
  let sequence = 0;
  const stop = clock.startClockRedraw({
    requestAnimationFrame: callback => { pending.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => pending.delete(id),
    draw: timestamp => drawn.push(timestamp),
  });
  for (const timestamp of [10, 26, 42]) {
    const [id, callback] = pending.entries().next().value;
    pending.delete(id);
    callback(timestamp);
  }
  assert.deepEqual(drawn, [10, 26, 42]);
  assert.equal(pending.size, 1);
  stop();
  assert.equal(pending.size, 0);
});

function sampleClock(wallPairs, monotonicPairs, replies, options = {}) {
  const walls = wallPairs.flat();
  const monos = monotonicPairs.flat();
  return measureClock({
    exchange: async () => replies.shift(),
    wallNow: () => walls.shift(),
    monotonicNow: () => monos.shift(),
    count: wallPairs.length,
    ...options,
  });
}

test('five exchanges retain raw times and select the valid lowest-delay offset', async () => {
  const wall = [[1000, 1100], [2000, 2040], [3000, 3070], [4000, 4080], [5000, 5090]];
  const mono = [[0, 100], [1000, 1040], [2000, 2070], [3000, 3080], [4000, 4090]];
  const replies = wall.map(([sent, received], index) => ({
    serverReceivedAtMs: sent + 200 + (received - sent) / 2,
    serverSentAtMs: sent + 200 + (received - sent) / 2,
    exchangeId: `e-${index + 1}`,
  }));
  const result = await sampleClock(wall, mono, replies);
  assert.equal(result.samples.length, 5);
  assert.equal(result.valid, true);
  assert.equal(result.selected.exchangeId, 'e-2');
  assert.equal(result.offsetMs, 200);
  assert.equal(result.uncertaintyMs, 20);
  assert.equal(result.selected.clientSentAtMs, 2000);
  assert.equal(result.selected.clientReceivedAtMs, 2040);
  assert.equal(result.selected.clientSentMonotonicMs, 1000);
});

test('negative network delay is rejected even if another exchange succeeds', async () => {
  const result = await sampleClock(
    [[1000, 1010], [2000, 2100]], [[0, 10], [100, 200]],
    [{serverReceivedAtMs: 1100, serverSentAtMs: 1200, exchangeId: 'bad'},
      {serverReceivedAtMs: 2050, serverSentAtMs: 2050, exchangeId: 'good'}],
  );
  assert.equal(result.samples[0].valid, false);
  assert.match(result.samples[0].reason, /negative/i);
  assert.equal(result.selected.exchangeId, 'good');
});

test('a wall-clock jump within an exchange invalidates that sample', async () => {
  const result = await sampleClock(
    [[1000, 2000]], [[0, 40]],
    [{serverReceivedAtMs: 1500, serverSentAtMs: 1500, exchangeId: 'jump'}],
    {jumpThresholdMs: 100},
  );
  assert.equal(result.valid, false);
  assert.equal(result.selected, null);
  assert.equal(result.samples[0].reason, 'wall_clock_jump');
  assert.equal(result.clockJump, true);
  assert.equal(result.segment, 1);
});

test('a wall-clock jump between reference groups begins a new mapping segment', async () => {
  const previousReference = {selected: {clientReceivedAtMs: 1040, clientReceivedMonotonicMs: 40}, segment: 0};
  const result = await sampleClock(
    [[5000, 5040]], [[1000, 1040]],
    [{serverReceivedAtMs: 5020, serverSentAtMs: 5020, exchangeId: 'after'}],
    {previousReference, jumpThresholdMs: 100},
  );
  assert.equal(result.clockJump, true);
  assert.equal(result.segment, 1);
  assert.equal(result.selected.exchangeId, 'after');
});

test('a jump between exchanges selects only a post-jump clock offset', async () => {
  const result = await sampleClock(
    [[1000, 1020], [5000, 5040]], [[0, 20], [100, 140]],
    [{serverReceivedAtMs: 1110, serverSentAtMs: 1110, exchangeId: 'before'},
      {serverReceivedAtMs: 5220, serverSentAtMs: 5220, exchangeId: 'after'}],
    {jumpThresholdMs: 100},
  );
  assert.equal(result.valid, true);
  assert.equal(result.clockJump, true);
  assert.equal(result.segment, 1);
  assert.equal(result.selected.exchangeId, 'after');
  assert.equal(result.offsetMs, 200);
});

test('the reference display contains actual phone and estimated server times and uncertainty', () => {
  const reference = {valid: true, selected: {exchangeId: 'e-2'}, offsetMs: 200, uncertaintyMs: 20};
  const display = clockReferenceDisplay(reference, Date.UTC(2026, 8, 24, 10, 0, 0, 123));
  assert.equal(display.exchangeId, 'e-2');
  assert.match(display.phoneTimeText, /10:00:00\.123Z/);
  assert.match(display.serverTimeText, /10:00:00\.323Z/);
  assert.equal(display.uncertaintyMs, 20);
});
