import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createWorkerHandler, DurableStorageAdapter, TreeTargetingSession} from '../../server/worker.mjs';
import {defaultConfig} from '../../web/run-config.mjs';

class MemoryDurableStorage {
  values = new Map();
  alarmAtMs = null;
  queue = Promise.resolve();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async setAlarm(value) { this.alarmAtMs = value; }
  async deleteAlarm() { this.alarmAtMs = null; }
  transaction(operation) {
    const next = this.queue.then(async () => {
      const before = structuredClone(this.values);
      try { return await operation(this); }
      catch (error) { this.values = before; throw error; }
    });
    this.queue = next.then(() => {}, () => {});
    return next;
  }
}

function syntheticRandomService() {
  let ticket = 0;
  let draws = 0;
  return {
    async createTickets(count) {
      return Array.from({length: count}, () => ({ticketId: `runtime-synthetic-${++ticket}`,
        creationTime: '2026-09-24 10:00:00Z', previousTicketId: null, nextTicketId: null}));
    },
    async draw(ticketId, binding) {
      draws++;
      return {value: 1, result: {random: {method: 'generateSignedIntegers', n: 1,
        min: 0, max: 1, replacement: true, base: 10, pregeneratedRandomization: null,
        data: [1], userData: binding, ticketData: {ticketId}, serialNumber: draws,
        completionTime: '2026-09-24 10:00:00Z'}, signature: 'synthetic-test-only'}};
    },
    async verifySignature() {
      return {status: 'pending', error: {code: 'synthetic_test',
        message: 'Synthetic signed results cannot be verified by the real provider.'}};
    },
  };
}

test('worker dispatch authenticates before selecting one experiment object and keeps asset paths scoped', async () => {
  const names = [];
  const requests = [];
  const namespace = {idFromName: name => { names.push(name); return name; },
    get: () => ({fetch: async request => { requests.push(request); return new Response('forwarded'); }})};
  const assets = {fetch: async request => new Response(new URL(request.url).pathname)};
  const handler = createWorkerHandler({authenticate: async request => {
    if (request.headers.get('x-test-access') !== 'yes') throw Object.assign(new Error('Unauthorized'), {status: 403, code: 'access_missing'});
    return {id: 'operator-1'};
  }});
  const env = {TREE_SESSIONS: namespace, ASSETS: assets};
  const noAuth = await handler.fetch(new Request('https://lab.sourceof.love/tree-targeting/api/runs'), env);
  assert.equal(noAuth.status, 403);
  assert.equal(names.length, 0);
  assert.equal((await handler.fetch(new Request('https://lab.sourceof.love/foreign/api/runs', {
    headers: {'x-test-access': 'yes'},
  }), env)).status, 404);
  assert.equal(names.length, 0);
  const asset = await handler.fetch(new Request('https://lab.sourceof.love/tree-targeting/app.mjs', {
    headers: {'x-test-access': 'yes'},
  }), env);
  assert.equal(await asset.text(), '/app.mjs');
  const api = await handler.fetch(new Request('https://lab.sourceof.love/tree-targeting/api/runs', {
    headers: {'x-test-access': 'yes', 'X-Tree-Actor': 'attacker'},
  }), env);
  assert.equal(await api.text(), 'forwarded');
  assert.deepEqual(names, ['tree-targeting']);
  assert.equal(requests[0].headers.get('X-Tree-Actor'), 'operator-1');
});

test('hosted app landing remains under the experiment path when assets canonicalize index.html', async () => {
  const assets = {fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === '/index.html') return Response.redirect('https://lab.sourceof.love/', 307);
    return new Response(path, {headers: {'Content-Type': 'text/html'}});
  }};
  const handler = createWorkerHandler({authenticate: async () => ({id: 'operator-1'})});
  const response = await handler.fetch(new Request('https://lab.sourceof.love/studies/targeted-vegetation-movement/app/'), {ASSETS: assets});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '/');
});

test('the installed asset runtime serves reader HTML at scoped routes without a root redirect', async context => {
  const {createRequire} = await import('node:module');
  const {readFile} = await import('node:fs/promises');
  const {fileURLToPath} = await import('node:url');
  const require = createRequire(import.meta.url);
  const {Miniflare, convertV4MiniflareOptions} = createRequire(require.resolve('wrangler/package.json'))('miniflare');
  const runtime = new Miniflare(convertV4MiniflareOptions({cf: false, modules: true, compatibilityDate: '2026-08-27',
    script: 'export default {fetch(request, env) {return env.ASSETS.fetch(request);}};',
    assets: {directory: fileURLToPath(new URL('../../web/', import.meta.url)), binding: 'ASSETS', run_worker_first: true}}));
  context.after(() => runtime.dispose());
  const bindings = await runtime.getBindings();
  const ASSETS = {fetch: request => bindings.ASSETS.fetch(request.url, {method: request.method, headers: [...request.headers], redirect: 'manual'})};
  const origin = 'https://test.lab.sourceof.love';
  const canonical = await ASSETS.fetch(new Request(`${origin}/public-study.html`));
  assert.ok([301, 307, 308].includes(canonical.status));
  assert.equal(new URL(canonical.headers.get('location'), origin).pathname, '/public-study');
  const handler = createWorkerHandler({authenticate: async () => ({id: 'operator-1'})});
  const env = {ASSETS, RELEASE_ENVIRONMENT: 'test'};
  const exact = await readFile(new URL('../../web/public-study.html', import.meta.url), 'utf8');
  for (const page of ['', 'about', 'results', 'recordings', 'recordings/recording-one', 'methods']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await handler.fetch(new Request(`${origin}/studies/targeted-vegetation-movement/public/${page}?publication=chosen`, {method}), env);
      assert.equal(response.status, 200, `${method} ${page} redirected or failed`);
      assert.equal(response.headers.get('location'), null);
      assert.equal(await response.text(), method === 'HEAD' ? '' : exact);
    }
  }
  const operator = await handler.fetch(new Request(`${origin}/studies/targeted-vegetation-movement/app/`), env);
  assert.equal(operator.status, 200);
  assert.equal(operator.headers.get('location'), null);
  const operatorHtml = await operator.text();
  assert.match(operatorHtml, /<title>Targeted Vegetation Movement<\/title>/);
  assert.match(operatorHtml, /class="app-name"[^>]*>Targeted Vegetation Movement<\/a>/);
});

test('hosted Mac analysis bookmarks return to authenticated recording instructions', async () => {
  const handler = createWorkerHandler({authenticate: async request => {
    if (request.headers.get('x-test-access') !== 'yes') {
      throw Object.assign(new Error('Unauthorized'), {status: 403, code: 'access_missing'});
    }
    return {id: 'operator-1'};
  }});
  for (const suffix of ['analysis', 'analysis/', 'analysis/#results']) {
    const url = `https://test.lab.sourceof.love/tree-targeting/${suffix}`;
    assert.equal((await handler.fetch(new Request(url), {})).status, 403);
    const response = await handler.fetch(new Request(url, {headers: {'x-test-access': 'yes'}}), {});
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), 'https://test.lab.sourceof.love/studies/targeted-vegetation-movement/app/#recordings');
  }
});

test('SQLite-backed Durable Object adapter preserves a run and its audit after reconstruction', async () => {
  const storage = new MemoryDurableStorage();
  const ctx = {storage, getWebSockets: () => []};
  let nowMs = 1000;
  const env = {SYNTHETIC_RANDOM_SERVICE: syntheticRandomService(),
    DEVELOPMENT_CLOCK: () => nowMs};
  const first = new TreeTargetingSession(ctx, env);
  const request = (path, method = 'GET', body = null) => new Request(
    `https://lab.sourceof.love/tree-targeting/api/${path}`, {
      method, headers: {'X-Tree-Actor': 'operator-1', 'Content-Type': 'application/json'},
      body: body == null ? undefined : JSON.stringify(body),
    });
  const config = defaultConfig('tree');
  config.tree.count = 1;
  assert.equal((await first.fetch(request('runs', 'POST', {runId: 'retained-run', config}))).status, 201);
  assert.equal((await first.fetch(request('runs/retained-run/actions', 'POST', {
    actionId: 'prepare-1', kind: 'prepare', deviceId: 'phone-1', data: {},
  }))).status, 200);
  assert.equal(storage.values.size > 0, true);
  const second = new TreeTargetingSession(ctx, env);
  const reopened = await (await second.fetch(request('runs/retained-run'))).json();
  assert.equal(reopened.lifecycle, 'prepared');
  assert.equal((await (await second.fetch(request('runs/retained-run/tickets'))).json()).tickets.length, 1);
  assert.equal(storage.alarmAtMs, null);
  assert.equal(typeof new DurableStorageAdapter(storage).transaction, 'function');
});

test('websocket playback authorization uses the private token and never sends a cue to a helper socket', async () => {
  const storage = new MemoryDurableStorage();
  const ctx = {storage, getWebSockets: () => []};
  const session = new TreeTargetingSession(ctx, {SYNTHETIC_RANDOM_SERVICE: syntheticRandomService(),
    DEVELOPMENT_CLOCK: () => 1000});
  const request = (path, method = 'GET', body = null) => new Request(
    `https://lab.sourceof.love/tree-targeting/api/${path}`, {
      method, headers: {'X-Tree-Actor': 'operator-1', 'Content-Type': 'application/json'},
      body: body == null ? undefined : JSON.stringify(body),
    });
  await session.fetch(request('runs', 'POST', {runId: 'socket-run', config: defaultConfig('tree')}));
  const designation = await session.fetch(request('runs/socket-run/actions', 'POST', {
    actionId: 'designate-1', kind: 'designatePlayback', deviceId: 'phone-1', data: {deviceId: 'phone-1'},
  }));
  const {playbackToken} = await designation.json();
  const sent = [];
  const socket = {attachment: {runId: 'socket-run', actorId: 'operator-1', playback: false},
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(message) { sent.push(JSON.parse(message)); }};
  await session.webSocketMessage(socket, JSON.stringify({kind: 'playbackAuth', deviceId: 'phone-1', playbackToken: 'wrong'}));
  assert.equal(sent.some(message => message.kind === 'cue'), false);
  await session.webSocketMessage(socket, JSON.stringify({kind: 'playbackAuth', deviceId: 'phone-1', playbackToken}));
  assert.equal(sent.some(message => message.kind === 'playbackReady'), true);
  assert.equal(sent.some(message => message.kind === 'cue' && message.cue.kind === 'testAudio'), true);
  const cue = sent.find(message => message.kind === 'cue').cue;
  assert.equal(cue.experimentSlug, 'tree-targeting');
  assert.equal(cue.runId, 'socket-run');
});

test('a retained alarm completes one tree trial once after Durable Object reconstruction', async () => {
  const storage = new MemoryDurableStorage();
  const ctx = {storage, getWebSockets: () => []};
  const randomService = syntheticRandomService();
  let nowMs = 1000;
  const env = {SYNTHETIC_RANDOM_SERVICE: randomService, DEVELOPMENT_CLOCK: () => nowMs};
  const session = new TreeTargetingSession(ctx, env);
  const request = (path, method = 'GET', body = null) => new Request(
    `https://lab.sourceof.love/tree-targeting/api/${path}`, {
      method, headers: {'X-Tree-Actor': 'operator-1', 'Content-Type': 'application/json'},
      body: body == null ? undefined : JSON.stringify(body),
    });
  const act = (target, actionId, kind, data = {}) => target.fetch(request('runs/alarm-run/actions', 'POST',
    {actionId, kind, deviceId: 'phone-1', data}));
  const config = defaultConfig('tree');
  config.tree.count = 1;
  config.tree.preRollSeconds = 1;
  config.tree.postRollSeconds = 1;
  await session.fetch(request('runs', 'POST', {runId: 'alarm-run', config}));
  await act(session, 'prepare', 'prepare');
  const designation = await (await act(session, 'designate', 'designatePlayback',
    {deviceId: 'phone-1'})).json();
  await act(session, 'test', 'testAudioPlayed', {playbackToken: designation.playbackToken});
  await act(session, 'recording', 'recordingReady');
  await act(session, 'start', 'start');
  assert.equal(storage.alarmAtMs, 2000);
  nowMs = 2000;
  await session.alarm();
  const approach = (await session.store.readRun('alarm-run')).state.pendingDelivery;
  assert.equal(approach.stream, 'treeApproach');
  assert.equal((await act(session, 'approach-played', 'cuePlayed', {cueId: approach.cueId,
    playbackToken: designation.playbackToken, playedAtMs: 2000})).status, 200);
  assert.equal((await act(session, 'arrived', 'arrived', {occurredAtMs: 2000})).status, 200);
  const before = await session.store.readRun('alarm-run');
  assert.equal(before.state.pendingDelivery.stream, 'tree');
  assert.equal((await act(session, 'cue-played', 'cuePlayed', {cueId: before.state.pendingDelivery.cueId,
    playbackToken: designation.playbackToken, playedAtMs: 2000})).status, 200);
  assert.equal(storage.alarmAtMs, 17000);
  nowMs = 17000;
  const reopened = new TreeTargetingSession(ctx, env);
  await reopened.alarm();
  const afterTarget = await reopened.store.readRun('alarm-run');
  assert.equal(afterTarget.state.phase, 'TREE_WAIT_DEPART');
  assert.equal(afterTarget.state.completedCount, 1);
  const revision = afterTarget.revision;
  await reopened.alarm();
  assert.equal((await reopened.store.readRun('alarm-run')).revision, revision);
  assert.equal(afterTarget.state.pendingDelivery.text, 'Depart');
  assert.equal((await act(reopened, 'depart-played', 'cuePlayed', {cueId: afterTarget.state.pendingDelivery.cueId,
    playbackToken: designation.playbackToken, playedAtMs: 17000})).status, 200);
  assert.equal((await act(reopened, 'away', 'away', {occurredAtMs: 17000})).status, 200);
  assert.equal(storage.alarmAtMs, 18000);
  nowMs = 18000;
  await reopened.alarm();
  const completed = await reopened.store.readRun('alarm-run');
  assert.equal(completed.state.lifecycle, 'completed');
  assert.equal(completed.state.pendingDelivery.text, 'Run finished');
  assert.equal(storage.alarmAtMs, 28000);
  nowMs = 28000;
  await reopened.alarm();
  const missedEndCue = await reopened.store.readRun('alarm-run');
  assert.equal(missedEndCue.state.lifecycle, 'completed');
  assert.equal(missedEndCue.state.pendingDelivery, null);
  assert.equal(missedEndCue.state.cues.find(cue => cue.stream === 'runFinished').deliveryStatus, 'failed');
  assert.equal(missedEndCue.state.lastError.code, 'cue_timeout');
  assert.equal(storage.alarmAtMs, null);
  const bundle = await (await reopened.fetch(request('runs/alarm-run/export'))).json();
  assert.equal(bundle.cues.filter(cue => cue.stream === 'tree').length, 1);
  assert.equal(bundle.events.filter(event => event.kind === 'assignmentReceived').length, 1);
});

test('a fractional tree deadline survives an early alarm and advances the next target', async () => {
  const storage = new MemoryDurableStorage();
  const ctx = {storage, getWebSockets: () => []};
  let nowMs = 1000;
  const env = {SYNTHETIC_RANDOM_SERVICE: syntheticRandomService(), DEVELOPMENT_CLOCK: () => nowMs};
  const session = new TreeTargetingSession(ctx, env);
  const request = (path, method = 'GET', body = null) => new Request(
    `https://lab.sourceof.love/tree-targeting/api/${path}`, {
      method, headers: {'X-Tree-Actor': 'operator-1', 'Content-Type': 'application/json'},
      body: body == null ? undefined : JSON.stringify(body),
    });
  const act = (actionId, kind, data = {}) => session.fetch(request('runs/fractional-tree/actions', 'POST',
    {actionId, kind, deviceId: 'phone-1', data}));
  const config = defaultConfig('tree');
  config.tree.count = 3;
  config.tree.responseSeconds = 10;
  config.tree.preRollSeconds = 1;
  await session.fetch(request('runs', 'POST', {runId: 'fractional-tree', config}));
  await act('prepare', 'prepare');
  const {playbackToken} = await (await act('designate', 'designatePlayback', {deviceId: 'phone-1'})).json();
  await act('test', 'testAudioPlayed', {playbackToken});
  await act('recording', 'recordingReady');
  await act('start', 'start');
  nowMs = 2000;
  await session.alarm();
  const approach = (await session.store.readRun('fractional-tree')).state.pendingDelivery;
  assert.equal((await act('approach-played', 'cuePlayed', {cueId: approach.cueId,
    playbackToken, playedAtMs: 2000})).status, 200);
  assert.equal((await act('arrived', 'arrived', {occurredAtMs: 2000})).status, 200);
  const first = (await session.store.readRun('fractional-tree')).state.pendingDelivery;
  assert.equal((await act('first-played', 'cuePlayed', {cueId: first.cueId,
    playbackToken, playedAtMs: 2000.5})).status, 200);
  assert.equal(storage.alarmAtMs, 12001);
  nowMs = 12000;
  storage.alarmAtMs = null;
  await session.alarm();
  assert.equal(storage.alarmAtMs, 12001);
  nowMs = 12001;
  await session.alarm();
  const afterFirst = await session.store.readRun('fractional-tree');
  assert.equal(afterFirst.state.completedCount, 1);
  assert.equal(afterFirst.state.pendingDelivery.text, 'Target B');
  assert.equal((await act('second-played', 'cuePlayed', {cueId: afterFirst.state.pendingDelivery.cueId,
    playbackToken, playedAtMs: 12001.5})).status, 200);
  assert.equal(storage.alarmAtMs, 22002);
  nowMs = 22002;
  await session.alarm();
  const afterSecond = await session.store.readRun('fractional-tree');
  assert.equal(afterSecond.state.completedCount, 2);
  assert.equal(afterSecond.state.pendingDelivery.text, 'Target B');
});


test('renamed hosted APIs reopen the same stored run without changing its experiment identity or event history', async () => {
  const storage = new MemoryDurableStorage(), ctx = {storage, getWebSockets: () => []};
  const env = {SYNTHETIC_RANDOM_SERVICE: syntheticRandomService(), DEVELOPMENT_CLOCK: () => 1000};
  const headers = {'X-Tree-Actor': 'operator-1', 'Content-Type': 'application/json'};
  const original = new TreeTargetingSession(ctx, env);
  const create = await original.fetch(new Request('https://test.lab.sourceof.love/tree-targeting/api/runs', {
    method: 'POST', headers, body: JSON.stringify({runId: 'retained-naming-run', config: defaultConfig('tree')}),
  }));
  assert.equal(create.status, 201);
  const before = structuredClone(storage.values);
  const reopened = new TreeTargetingSession(ctx, env);
  for (const base of ['/studies/targeted-vegetation-movement/app/api/', '/studies/tree-targeting/app/api/', '/tree-targeting/api/']) {
    const response = await reopened.fetch(new Request('https://test.lab.sourceof.love' + base + 'runs/retained-naming-run', {headers}));
    assert.equal(response.status, 200, base);
    const result = await response.json();
    assert.equal(result.experimentSlug, 'tree-targeting');
    assert.equal(result.runId, 'retained-naming-run');
  }
  assert.deepEqual(storage.values, before);
});
