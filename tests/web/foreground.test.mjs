import test from 'node:test';
import assert from 'node:assert/strict';
import * as cues from '../../web/cues.mjs';
import {startHostedApplication, createHostedTransport, reconnectionNotice} from '../../web/app.mjs';
import {operatorModel} from '../../web/operator-model.mjs';

const settle = async () => { for (let index = 0; index < 120; index += 1) await Promise.resolve(); };

function timers() {
  const pending = new Map();
  let nextId = 0;
  return {
    pending,
    scheduleTimeout(callback, delay) { const id = ++nextId; pending.set(id, {callback, delay}); return id; },
    cancelTimeout(id) { pending.delete(id); },
    async next() {
      const [id, timer] = [...pending].sort((first, second) => first[1].delay - second[1].delay)[0];
      pending.delete(id);
      await timer.callback();
      await settle();
      return timer.delay;
    },
  };
}

function connectionFixture(connectOverride) {
  const clock = timers();
  const sockets = [], states = [], statuses = [], receivedCues = [], warnings = [];
  const connection = cues.createRunConnection({
    experimentSlug: 'tree-targeting', runId: 'run-1', ...clock,
    connect: handlers => {
      const socket = {handlers, closed: false, close() { this.closed = true; }};
      sockets.push(socket);
      return connectOverride ? connectOverride(socket) : socket;
    },
    onState: state => states.push(state), onStatus: status => statuses.push(status),
    onCue: cue => receivedCues.push(cue), warn: (...args) => warnings.push(args),
  });
  return {connection, clock, sockets, states, statuses, receivedCues, warnings};
}

test('a lost socket reconnects automatically and waits for authoritative state including a missed cue', async () => {
  const {connection, clock, sockets, statuses, states, warnings} = connectionFixture();
  await connection.start();
  sockets[0].handlers.onState({runId: 'run-1', lifecycle: 'running', currentInstruction: 'HOLD'});
  sockets[0].handlers.onClose();
  assert.equal(connection.current(), null);
  assert.equal(statuses.at(-1).connected, false);
  assert.equal(warnings.length, 1);
  assert.equal(await clock.next(), 1000);
  assert.equal(sockets.length, 2);
  assert.equal(connection.current(), null, 'An open socket is not yet synchronized');
  const failed = {runId: 'run-1', lifecycle: 'failed', lastError: {code: 'cue_timeout', message: 'Instruction audio did not start within ten seconds.'}};
  sockets[1].handlers.onState(failed);
  assert.deepEqual(connection.current(), failed);
  assert.deepEqual(states.at(-1), failed);
  assert.equal(clock.pending.size, 0);
  connection.stop();
});

test('connection failures back off to fifteen seconds and stop cancels further attempts', async () => {
  const {connection, clock, sockets} = connectionFixture(() => { throw new Error('Offline'); });
  await connection.start();
  const delays = [];
  for (let index = 0; index < 6; index += 1) delays.push(await clock.next());
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(sockets.length, 7);
  connection.stop();
  assert.equal(clock.pending.size, 0);
});

test('resuming replaces an apparently open socket and ignores its stale states and cues', async () => {
  const {connection, sockets, receivedCues} = connectionFixture();
  await connection.start();
  sockets[0].handlers.onState({runId: 'run-1', lifecycle: 'running'});
  await connection.reconnect();
  assert.equal(sockets[0].closed, true);
  assert.equal(connection.current(), null);
  sockets[0].handlers.onState({runId: 'run-1', lifecycle: 'running', phase: 'ACTIVE'});
  sockets[0].handlers.onCue({runId: 'run-1', cueId: 'stale', text: 'CHANGE'});
  assert.equal(connection.current(), null);
  assert.deepEqual(receivedCues, []);
  sockets[1].handlers.onState({runId: 'run-1', lifecycle: 'completed'});
  assert.equal(connection.current().lifecycle, 'completed');
  connection.stop();
});

test('a socket that never supplies current state times out and retries without overlapping starts', async () => {
  let resolveConnection;
  const {connection, clock, sockets} = connectionFixture(socket => new Promise(resolve => { resolveConnection = () => resolve(socket); }));
  const first = connection.start();
  void connection.start();
  assert.equal(sockets.length, 1);
  assert.equal(await clock.next(), 10000);
  assert.equal(connection.current(), null);
  resolveConnection();
  await first;
  assert.equal(sockets[0].closed, true);
  assert.equal(await clock.next(), 1000);
  assert.equal(sockets.length, 2);
  connection.stop();
  resolveConnection();
  await settle();
  assert.equal(sockets[1].closed, true);
  assert.equal(clock.pending.size, 0);
});

function screenFixture(requestOverride) {
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const locks = [], requests = [], warnings = [], displayed = [];
  const wakeLock = {request(type) {
    requests.push(type);
    const lock = new EventTarget();
    lock.released = false;
    lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
    locks.push(lock);
    return requestOverride ? requestOverride(lock) : Promise.resolve(lock);
  }};
  const manager = cues.createInstructionScreenLock({document, wakeLock, deviceId: 'phone',
    warn: (...args) => warnings.push(args), onWarning: message => displayed.push(message)});
  const running = {runId: 'run-1', lifecycle: 'running', playbackDeviceId: 'phone'};
  const visibility = async value => { document.visibilityState = value; document.dispatchEvent(new Event('visibilitychange')); await settle(); };
  return {document, manager, locks, requests, warnings, displayed, running, visibility};
}

test('only the designated instruction phone holds one screen lock throughout a running session', async () => {
  const {manager, locks, requests, running} = screenFixture();
  await manager.update({...running, lifecycle: 'prepared'});
  await manager.update({...running, playbackDeviceId: 'helper'});
  assert.deepEqual(requests, []);
  await manager.update(running);
  await manager.update({...running, connected: false});
  assert.deepEqual(requests, ['screen']);
  assert.equal(locks[0].released, false, 'Connection recovery must not let the screen sleep');
  await manager.update({...running, lifecycle: 'completed'});
  assert.equal(locks[0].released, true);
  manager.stop();
});

test('the instruction phone stays awake until a final spoken cue ends', async () => {
  const {manager, locks, running} = screenFixture();
  await manager.update(running);
  await manager.update({...running, lifecycle: 'completed', instructionAudioPending: true});
  assert.equal(locks[0].released, false);
  await manager.update({...running, lifecycle: 'completed', instructionAudioPending: false});
  assert.equal(locks[0].released, true);
  manager.stop();
});

test('screen lock is released while hidden and reacquired only when the run is visible again', async () => {
  const {manager, locks, requests, running, visibility} = screenFixture();
  await manager.update(running);
  await visibility('hidden');
  assert.equal(locks[0].released, true);
  assert.equal(requests.length, 1);
  await visibility('visible');
  assert.equal(requests.length, 2);
  assert.equal(locks[1].released, false);
  await manager.update({...running, lifecycle: 'failed'});
  assert.equal(locks[1].released, true);
  await visibility('hidden');
  await visibility('visible');
  assert.equal(requests.length, 2);
  manager.stop();
});

test('a late wake-lock acquisition is released after the selected run ends or the application stops', async () => {
  for (const stop of [false, true]) {
    let grant;
    const {manager, locks, running} = screenFixture(lock => new Promise(resolve => { grant = () => resolve(lock); }));
    const acquiring = manager.update(running);
    if (stop) manager.stop();
    else void manager.update({...running, lifecycle: 'stopped'});
    grant();
    await acquiring;
    assert.equal(locks[0].released, true);
    manager.stop();
  }
});

test('denied or unsupported screen locks are visibly reported without repeated requests on each state update', async () => {
  const {manager, requests, warnings, displayed, running} = screenFixture(() => Promise.reject(new Error('Battery saver')));
  await manager.update(running);
  await manager.update(running);
  assert.equal(requests.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /run-1/);
  assert.match(displayed[0], /screen awake/i);
  manager.stop();
  const unsupported = cues.createInstructionScreenLock({document: new EventTarget(), deviceId: 'phone',
    warn: (...args) => warnings.push(args), onWarning: message => displayed.push(message)});
  await unsupported.update(running);
  assert.equal(warnings.length, 2);
  assert.match(displayed[1], /not supported/i);
  unsupported.stop();
});

test('an operating-system wake-lock release warns the operator without an automatic acquisition loop', async () => {
  const {manager, locks, requests, warnings, displayed, running} = screenFixture();
  await manager.update(running);
  await locks[0].release();
  await manager.update(running);
  assert.equal(warnings.length, 1);
  assert.match(displayed[0], /screen awake/i);
  assert.equal(requests.length, 1);
  manager.stop();
});

function hostedFixture() {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, Object.assign(new EventTarget(), {
      innerHTML: '', textContent: '', hidden: false,
      querySelectorAll: () => [], querySelector: () => null,
      classList: {toggle() {}}, focus() {},
    }));
    return nodes.get(key);
  };
  const document = Object.assign(new EventTarget(), {visibilityState: 'visible', getElementById: node, querySelectorAll: () => []});
  const saved = new Map([['tree-targeting:device:tree-targeting', 'phone'], ['tree-targeting:selected-run:tree-targeting', 'run-1'],
    ['tree-targeting:playback:tree-targeting:run-1', 'test-playback-identity']]);
  const storage = {getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)};
  const sockets = [], audios = [], locks = [], requests = [];
  class Socket extends EventTarget {
    constructor() { super(); this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    message(value) { this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(value)})); }
  }
  const clock = timers();
  const window = Object.assign(new EventTarget(), {
    localStorage: storage, sessionStorage: storage, URL, WebSocket: Socket,
    location: {hash: '#tree', origin: 'https://example.test', protocol: 'https:'},
    navigator: {wakeLock: {request: async () => {
      const lock = new EventTarget();
      lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
      locks.push(lock); return lock;
    }}},
    Audio: class extends EventTarget { constructor() { super(); audios.push(this); } play() { return Promise.resolve(); } },
    setTimeout: clock.scheduleTimeout, clearTimeout: clock.cancelTimeout, setInterval() {}, clearInterval() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    crypto: {randomUUID: () => `request-${requests.length}`}, performance: {now: Date.now},
    fetch: async (path, options) => {
      requests.push({path, body: options?.body ? JSON.parse(options.body) : null});
      return {ok: true, json: async () => path.endsWith('/runs/run-1')
        ? {runId: 'run-1', mode: 'tree', lifecycle: 'prepared', playbackDeviceId: 'phone'}
        : path.endsWith('/clock') ? {exchangeId: `exchange-${requests.length}`, serverReceivedAtMs: Date.now(), serverSentAtMs: Date.now()}
        : path.endsWith('/actions') ? {accepted: true} : {runs: [], sites: [], series: []}};
    },
  });
  return {document, window, sockets, audios, locks, node, clock, requests};
}

test('hosted connection status identifies the study service',async t=>{
  const {document,window,sockets,node}=hostedFixture();
  const application=startHostedApplication(document,window);
  t.after(()=>application.stop());
  await settle();
  sockets[0].open();
  sockets[0].message({kind:'state',state:{runId:'run-1',mode:'tree',lifecycle:'prepared',playbackDeviceId:'phone'}});
  await settle();
  assert.equal(node('connection').textContent,'Connected to the study service.');
  sockets[0].close();
  await settle();
  assert.match(node('connection').textContent,/Current instruction and timing are unconfirmed/);
  assert.doesNotMatch(node('connection').textContent,/wind/i);
});

test('hosted footer describes the camera video and phone instructions',async t=>{
  const {document,window,node}=hostedFixture();
  const application=startHostedApplication(document,window);
  t.after(()=>application.stop());
  await settle();
  assert.equal(node('footer-message').textContent,
    'Original camera video remains on the Mac. This phone handles the shared run and spoken instructions.');
});

test('the designated speaker retains clock measurements on connection, before Start and on reconnect', async () => {
  const {document, window, sockets, requests, node} = hostedFixture();
  const application = startHostedApplication(document, window);
  await settle();
  const exchanges = () => requests.filter(item => item.path.endsWith('/clock'));
  const saved = () => requests.filter(item => item.body?.kind === 'saveClockReference');
  assert.equal(exchanges().length, 5);
  assert.equal(saved().length, 1);
  assert.equal(saved()[0].body.data.deviceId, 'phone');
  assert.equal(saved()[0].body.data.reference.valid, true);
  sockets[0].open();
  sockets[0].message({kind: 'state', state: {runId: 'run-1', mode: 'tree', lifecycle: 'prepared', playbackDeviceId: 'phone'}});
  node('main').closest = () => ({dataset: {hostedAction: 'start'}, type: 'button', textContent: 'Start'});
  node('main').dispatchEvent(new Event('click'));
  await settle();
  assert.equal(exchanges().length, 10);
  assert.equal(saved().length, 2);
  assert.equal(requests.filter(item => item.body).at(-1).body.kind, 'start');
  window.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(exchanges().length, 15);
  assert.equal(saved().length, 3);
  assert.equal(sockets.length, 2);
  application.stop();
});

test('the hosted page locks on a helper-started run and safely resynchronizes after being hidden', async () => {
  const {document, window, sockets, locks, node, clock} = hostedFixture();
  const application = startHostedApplication(document, window);
  await settle();
  sockets[0].open();
  await settle();
  sockets[0].message({kind: 'state', state: {runId: 'run-1', mode: 'tree', lifecycle: 'running', playbackDeviceId: 'phone'}});
  await settle();
  assert.equal(locks.length, 1);
  node('error').hidden = false;
  node('error').textContent = 'An earlier cue failed.';
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].readyState, 3);
  assert.match(node('connection').textContent, /unconfirmed/);
  sockets[1].open();
  sockets[1].message({kind: 'state', state: {runId: 'run-1', mode: 'tree', lifecycle: 'failed', playbackDeviceId: 'phone',
    lastError: {code: 'cue_timeout', message: 'Instruction audio did not start within ten seconds.'}}});
  await settle();
  assert.match(node('main').innerHTML, /Instruction audio did not start within ten seconds/);
  assert.equal(node('error').hidden, false);
  assert.equal(node('error').textContent, 'An earlier cue failed.');
  assert.equal(locks.at(-1).released, true);
  application.stop();
  assert.equal(clock.pending.size, 0);
  window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(sockets.length, 2);
});

for (const trigger of ['online', 'manual']) test(`${trigger} recovery reauthenticates the speaker while retaining failed-cue deduplication`, async () => {
  const {document, window, sockets, audios, node} = hostedFixture();
  const application = startHostedApplication(document, window);
  await settle();
  sockets[0].open();
  const state = {runId: 'run-1', mode: 'tree', lifecycle: 'running', playbackDeviceId: 'phone'};
  sockets[0].message({kind: 'state', state});
  const cue = {runId: 'run-1', deviceId: 'phone', cueId: 'failed-on-phone', text: 'CHANGE'};
  sockets[0].message({kind: 'cue', cue});
  audios[0].error = {code: 4};
  audios[0].dispatchEvent(new Event('error'));
  await settle();
  assert.match(node('error').textContent, /media_error_4/);
  if (trigger === 'online') window.dispatchEvent(new Event('online'));
  else {
    node('main').closest = () => ({dataset: {hostedOperation: 'reconnect'}});
    node('main').dispatchEvent(new Event('click'));
  }
  await settle();
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, sockets[0].sent, 'The recovered socket authenticates the same instruction phone');
  sockets[0].message({kind: 'cue', cue: {...cue, cueId: 'obsolete-socket-cue'}});
  sockets[1].message({kind: 'state', state});
  sockets[1].message({kind: 'cue', cue});
  assert.equal(audios.length, 1, 'Neither the stale socket nor a repeated failed cue can play');
  assert.match(node('error').textContent, /media_error_4/);
  assert.equal(node('error').hidden, false);
  application.stop();
});

test('an online event can recover a saved run when the initial page load was offline', async () => {
  const {document, window, sockets, node} = hostedFixture();
  const fetch = window.fetch;
  window.fetch = async (...args) => {
    if (window.offline) throw new Error('Offline');
    return fetch(...args);
  };
  window.offline = true;
  const application = startHostedApplication(document, window);
  await settle();
  assert.equal(sockets.length, 0);
  assert.match(node('error').textContent,/The study service did not acknowledge GET/);
  assert.doesNotMatch(node('error').textContent,/wind|CSV/i);
  window.offline = false;
  window.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(sockets.length, 1);
  application.stop();
});

test('an unnamed study uses the selected name while preserving a saved study name', () => {
  const saved = {study_id: 'saved-study', name: 'Tree study at the park'};
  assert.equal(operatorModel(saved).name, 'Tree study at the park');
  assert.deepEqual(saved, {study_id: 'saved-study', name: 'Tree study at the park'});
  assert.equal(operatorModel({study_id: 'unnamed-study'}).name, 'Targeted Vegetation Movement');
});

for (const [description, response, message] of [
  ['an unreadable response', {ok: true, json: async () => { throw new Error('Incomplete JSON'); }},
    'The study service returned an unreadable response for POST runs/run-1/actions.'],
  ['an HTTP failure without server detail', {ok: false, status: 503, json: async () => ({})},
    'Study request failed (503).'],
]) test(`hosted transport identifies the study service after ${description}`, async () => {
  const request = createHostedTransport(async () => response);
  await assert.rejects(request('POST', 'runs/run-1/actions', {kind: 'ready'}), error => {
    assert.equal(error.message, message);
    assert.equal(error.uncertain, true);
    return true;
  });
});

test('reconnecting without a selected run identifies the study service', () => {
  assert.equal(reconnectionNotice(null, null), 'Study service reconnected.');
  assert.equal(reconnectionNotice('run-1', null), null);
  assert.equal(reconnectionNotice('run-1', 'run-1'), 'Shared run reconnected. Check the current instruction before acting.');
});
