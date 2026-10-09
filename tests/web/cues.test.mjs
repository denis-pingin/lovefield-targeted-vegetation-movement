import test from 'node:test';
import assert from 'node:assert/strict';
import {createCuePlayer, createRunConnection} from '../../web/cues.mjs';

class TestAudio extends EventTarget {
  constructor(source) {
    super();
    this.src = source;
    this.playCalls = 0;
  }

  play() { this.playCalls += 1; return Promise.resolve(); }
}

function fixture() {
  const audios = [];
  const records = [];
  const displays = [];
  const warnings = [];
  let time = 1000;
  const player = createCuePlayer({
    createAudio: source => { const audio = new TestAudio(source); audios.push(audio); return audio; },
    now: () => time,
    record: value => records.push(value),
    display: (...args) => displays.push(args),
    warn: (...args) => warnings.push(args),
    experimentSlug: 'tree-targeting',
    runId: 'run-1',
    scheduleTimeout: () => 1,
    cancelTimeout: () => {},
  });
  return {player, audios, records, displays, warnings, setTime: value => { time = value; }};
}

test('a cue is neither displayed nor acknowledged until audio starts', () => {
  const {player, audios, records, displays, setTime} = fixture();
  assert.equal(player.play({cueId: 'cue-1', text: 'CHANGE'}), true);
  assert.equal(audios.length, 1);
  assert.match(audios[0].src, /\/change\.mp3$/);
  assert.equal(audios[0].playCalls, 1);
  assert.deepEqual(displays, []);
  assert.deepEqual(records, []);
  setTime(1325);
  audios[0].dispatchEvent(new Event('playing'));
  assert.equal(displays[0][0], 'CHANGE');
  assert.deepEqual(records[0], {
    kind: 'cuePlayed', cueId: 'cue-1', experimentSlug: 'tree-targeting',
    runId: 'run-1', clientAtMs: 1325,
  });
  assert.equal(player.delivery('cue-1').status, 'played');
});

test('each study instruction selects its own fixed audio clip', () => {
  const {player, audios} = fixture();
  const cues = [
    ['Test audio', 'test-audio.mp3'], ['Approach', 'approach.mp3'],
    ['Start practice', 'start-practice.mp3'], ['Depart', 'depart.mp3'],
    ['CHANGE', 'change.mp3'], ['HOLD', 'hold.mp3'],
    ['Continue practice', 'continue-practice.mp3'], ['Response complete', 'response-complete.mp3'],
    ['Release', 'release.mp3'], ['Run finished', 'run-finished.mp3'],
    ['Target A', 'target-a.mp3'], ['Target B', 'target-b.mp3'],
  ];
  for (const [index, [instruction, filename]] of cues.entries()) {
    assert.equal(player.play({cueId: `fixed-${index}`, text: instruction}), true);
    assert.equal(audios[index].src.endsWith(`/${filename}`), true);
  }
});

test('repeated delivery of one ID is ignored, but consecutive A targets with new IDs both play', () => {
  const {player, audios, records, displays} = fixture();
  assert.equal(player.play({cueId: 'target-1', text: 'Target A'}), true);
  assert.equal(player.play({cueId: 'target-1', text: 'Target A'}), false);
  assert.equal(player.play({cueId: 'target-2', text: 'Target A'}), true);
  assert.equal(audios.length, 2);
  audios[0].dispatchEvent(new Event('playing'));
  audios[1].dispatchEvent(new Event('playing'));
  assert.deepEqual(displays.map(([text]) => text), ['Target A', 'Target A']);
  assert.deepEqual(records.map(record => record.cueId), ['target-1', 'target-2']);
});

test('one cue ID in another run is a separate delivery', () => {
  const {player, audios} = fixture();
  assert.equal(player.play({cueId: 'first', text: 'HOLD', runId: 'run-1'}), true);
  assert.equal(player.play({cueId: 'first', text: 'HOLD', runId: 'run-2'}), true);
  assert.equal(audios.length, 2);
});

test('delivered IDs persist by experiment and run without storing assignment text', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const audios = [];
  const options = {createAudio: source => { const audio = new TestAudio(source); audios.push(audio); return audio; },
    now: () => 1000, record: () => {}, display: () => {},
    storage, experimentSlug: 'tree-targeting', runId: 'run-1',
    scheduleTimeout: () => 1, cancelTimeout: () => {}};
  const first = createCuePlayer(options);
  first.play({cueId: 'cue-1', text: 'CHANGE'});
  audios[0].dispatchEvent(new Event('playing'));
  const reopened = createCuePlayer(options);
  assert.equal(reopened.play({cueId: 'cue-1', text: 'CHANGE'}), false);
  assert.equal(audios.length, 1);
  assert.equal([...values.values()].some(value => value.includes('CHANGE')), false);
  const otherRun = createCuePlayer({...options, runId: 'run-2'});
  assert.equal(otherRun.play({cueId: 'cue-1', text: 'CHANGE'}), true);
});

test('audio failure never invents an audible onset or displays the assignment', () => {
  const {player, audios, records, displays, setTime} = fixture();
  player.play({cueId: 'cue-2', text: 'Target B'});
  setTime(1500);
  audios[0].error = {code: 4};
  audios[0].dispatchEvent(new Event('error'));
  assert.deepEqual(records, [{kind: 'cueFailed', cueId: 'cue-2', experimentSlug: 'tree-targeting', runId: 'run-1', clientAtMs: 1500, reason: 'media_error_4'}]);
  assert.equal(displays[0][1].status, 'failed');
  assert.match(displays[0][0], /media_error_4/);
  assert.doesNotMatch(displays[0][0], /\bB\b/);
  audios[0].dispatchEvent(new Event('playing'));
  assert.equal(records.length, 1);
  assert.equal(player.delivery('cue-2').status, 'failed');
});

test('silent audio does not advance, and audio-end is retained after a real onset', () => {
  const {player, audios, records, setTime} = fixture();
  player.play({cueId: 'cue-3', text: 'Target A'});
  assert.equal(player.delivery('cue-3').status, 'queued');
  assert.deepEqual(records, []);
  audios[0].dispatchEvent(new Event('playing'));
  setTime(1670);
  audios[0].dispatchEvent(new Event('ended'));
  assert.deepEqual(records.map(value => value.kind), ['cuePlayed', 'cueEnded']);
  assert.equal(records[1].clientAtMs, 1670);
});

test('audio that never starts fails after ten seconds without exposing its assignment', () => {
  const records = [];
  const displays = [];
  const audios = [];
  let scheduled;
  let time = 1000;
  const player = createCuePlayer({
    createAudio: source => { const audio = new TestAudio(source); audios.push(audio); return audio; },
    now: () => time, record: value => records.push(value), display: (...args) => displays.push(args),
    scheduleTimeout: (callback, delay) => { scheduled = {callback, delay}; return 1; },
    cancelTimeout: () => {},
  });
  player.play({cueId: 'silent-1', text: 'CHANGE'});
  assert.equal(scheduled.delay, 10000);
  time = 11050;
  scheduled.callback();
  assert.deepEqual(records, [{kind: 'cueFailed', cueId: 'silent-1', clientAtMs: 11050, reason: 'audio_start_timeout'}]);
  assert.equal(displays[0][1].status, 'failed');
  assert.match(displays[0][0], /audio_start_timeout/);
  assert.doesNotMatch(displays[0][0], /CHANGE/);
  audios[0].dispatchEvent(new Event('playing'));
  assert.equal(records.length, 1);
});

test('a real audio start cancels the no-start timer', () => {
  const audios = [];
  const records = [];
  let scheduled;
  let cancelled = false;
  const player = createCuePlayer({createAudio: source => { const audio = new TestAudio(source); audios.push(audio); return audio; },
    now: () => 1000, record: value => records.push(value), display: () => {},
    scheduleTimeout: callback => { scheduled = callback; return 1; },
    cancelTimeout: () => { cancelled = true; }});
  player.play({cueId: 'heard-1', text: 'HOLD'});
  audios[0].dispatchEvent(new Event('playing'));
  scheduled();
  assert.equal(cancelled, true);
  assert.deepEqual(records.map(record => record.kind), ['cuePlayed']);
});

test('a rejected browser audio play reports failure without an onset', async () => {
  const records = [];
  const displays = [];
  const audio = new TestAudio('');
  audio.play = () => Promise.reject(Object.assign(new Error('Playback blocked'), {name: 'NotAllowedError'}));
  const player = createCuePlayer({createAudio: () => audio, now: () => 1200,
    record: value => records.push(value), display: (...args) => displays.push(args),
    scheduleTimeout: () => 1, cancelTimeout: () => {}});
  player.play({cueId: 'blocked', text: 'Test audio'});
  await Promise.resolve();
  assert.deepEqual(records, [{kind: 'cueFailed', cueId: 'blocked', clientAtMs: 1200,
    reason: 'audio_play_NotAllowedError'}]);
  assert.equal(displays[0][1].status, 'failed');
  assert.doesNotMatch(displays[0][0], /Test audio/);
});

test('a failed delivery acknowledgement is visible and never treated as confirmed', async () => {
  const warnings = [];
  const displayed = [];
  const audios = [];
  const player = createCuePlayer({
    createAudio: source => { const audio = new TestAudio(source); audios.push(audio); return audio; },
    now: () => 2000, record: () => Promise.reject(new Error('Offline')),
    display: (...args) => displayed.push(args), warn: (...args) => warnings.push(args),
  });
  player.play({cueId: 'cue-4', text: 'CHANGE'});
  audios[0].dispatchEvent(new Event('playing'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.delivery('cue-4').status, 'unconfirmed');
  assert.equal(displayed.at(-1)[1].status, 'unconfirmed');
  assert.equal(warnings.length, 1);
});

test('shared run connection reports lost connectivity and does not treat stale state as current', async t => {
  let handlers;
  const states = [];
  const statuses = [];
  const connection = createRunConnection({
    experimentSlug: 'tree-targeting', runId: 'run-1',
    connect: input => { handlers = input; return {close() {}}; },
    onState: state => states.push(state), onStatus: status => statuses.push(status), warn: () => {},
  });
  t.after(() => connection.stop());
  await connection.start();
  handlers.onState({runId: 'run-1', phase: 'ACTIVE'});
  assert.equal(connection.current().phase, 'ACTIVE');
  handlers.onClose();
  assert.equal(connection.current(), null);
  assert.equal(statuses.at(-1).connected, false);
  assert.match(statuses.at(-1).message, /Connection lost/);
  assert.equal(states.at(-1), null);
});

test('a run connection retains only the scoped current-run identity', async () => {
  const values = new Map();
  const storage = {setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const connection = createRunConnection({experimentSlug: 'tree-targeting', runId: 'run-1', storage,
    connect: async () => ({close() {}}), onState: () => {}, onStatus: () => {}});
  await connection.start();
  assert.deepEqual([...values.values()], ['run-1']);
  assert.match([...values.keys()][0], /tree-targeting/);
  connection.stop();
  assert.equal(values.size, 0);
});

test('a run connection passes an assigned cue only for its own run', async t => {
  let handlers;
  const cues = [];
  const connection = createRunConnection({experimentSlug: 'tree-targeting', runId: 'run-1',
    connect: input => { handlers = input; return {close() {}}; },
    onState: () => {}, onStatus: () => {}, onCue: cue => cues.push(cue),
    warn: () => {}});
  t.after(() => connection.stop());
  await connection.start();
  handlers.onCue({runId: 'run-1', cueId: 'c-1', text: 'A'});
  handlers.onCue({runId: 'run-2', cueId: 'c-2', text: 'B'});
  assert.deepEqual(cues, [{runId: 'run-1', cueId: 'c-1', text: 'A'}]);
});

test('foreign experiment cues and states cannot enter the current run', async t => {
  let handlers;
  const states = [];
  const cues = [];
  const connection = createRunConnection({experimentSlug: 'tree-targeting', runId: 'run-1',
    connect: input => { handlers = input; return {close() {}}; },
    onState: value => states.push(value), onStatus: () => {}, onCue: cue => cues.push(cue), warn: () => {}});
  t.after(() => connection.stop());
  await connection.start();
  handlers.onState({experimentSlug: 'another-study', runId: 'run-1', phase: 'ACTIVE'});
  handlers.onCue({experimentSlug: 'another-study', runId: 'run-1', cueId: 'c-1', text: 'A'});
  assert.equal(connection.current(), null);
  assert.deepEqual(states, []);
  assert.deepEqual(cues, []);
});

test('a connection stopped before connect resolves closes the late socket', async () => {
  let resolveConnection;
  let closed = 0;
  const connection = createRunConnection({experimentSlug: 'tree-targeting', runId: 'run-1',
    connect: () => new Promise(resolve => { resolveConnection = resolve; }),
    onState: () => {}, onStatus: () => {}});
  const started = connection.start();
  connection.stop();
  resolveConnection({close() { closed += 1; }});
  await started;
  assert.equal(closed, 1);
  assert.equal(connection.current(), null);
});

test('callbacks from a closed socket cannot reactivate stale state', async t => {
  let handlers;
  const statuses = [];
  const connection = createRunConnection({experimentSlug: 'tree-targeting', runId: 'run-1',
    connect: input => { handlers = input; return {close() {}}; },
    onState: () => {}, onStatus: status => statuses.push(status), warn: () => {}});
  t.after(() => connection.stop());
  await connection.start();
  handlers.onState({runId: 'run-1', phase: 'ACTIVE'});
  handlers.onClose();
  handlers.onState({runId: 'run-1', phase: 'SETTLEMENT'});
  assert.equal(connection.current(), null);
  assert.equal(statuses.at(-1).connected, false);
});
