import test from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../../server/worker.mjs';
import {createRunState} from '../../server/run-engine.mjs';
import {createStartRegistry} from '../../server/start-registry.mjs';
import {defaultConfig} from '../../web/run-config.mjs';
import {harness, action, api, ready} from './service-fixtures.mjs';
import {registryFixture, fixtureHash} from './start-registry-fixtures.mjs';

async function scored(h, runId = 'scored-run') {
  const config = defaultConfig('tree', 'scored'); config.seriesId = 'scored-series'; config.tree.preRollSeconds = 1;
  const state = {...createRunState(config, 1000, runId), lifecycle: 'prepared', phase: 'TREE_READY', recordingReady: true,
    testAudioPlayed: true, playbackDeviceId: 'phone', setupSnapshot: {setupId: 'setup', retrospective: false}, cues: []};
  const record = await h.store.createRun({runId, experimentSlug: 'tree-targeting', config, profile: {}, codeCheckpoint: 'a'.repeat(40), state, tickets: []});
  await h.storage.put('tree-targeting:series:scored-series', {seriesId: 'scored-series', status: 'frozen', config, members: [{runId, collectionStartedAtMs: null}], runIds: [runId]});
  return record;
}
const confirmed = identity => ({status: 'confirmed', registration: {identity, attestationUid: fixtureHash(500), transactionHash: fixtureHash(1), blockNumber: '100', blockHash: fixtureHash(100), chainTimestamp: 1000}});

test('scored Start remains stopped while registration is pending, and a saved retry can recover', async () => {
  const calls = []; let available = false;
  const startRegistry = {ensureStart: async identity => {calls.push(identity); return available ? confirmed(identity) : {status: 'pending', registration: null};}};
  const h = harness(['A'], {startRegistry, scoredCollectionEnabled: true}); await scored(h);
  const pending = await (await action(h.service, 'scored-run', 'start', 'start-one')).json();
  assert.equal(pending.pending, true); assert.equal((await h.store.readRun('scored-run')).state.recordingStartedAtMs, null);
  assert.equal((await h.store.readRun('scored-run')).state.deadline, null); assert.equal(h.randomService.drawn.length, 0);
  available = true; h.setTime(9000);
  const resumed = await (await action(h.service, 'scored-run', 'start', 'start-one')).json();
  assert.equal(resumed.accepted, true); const run = await h.store.readRun('scored-run');
  assert.equal(run.state.recordingStartedAtMs, 9000); assert.equal(run.state.deadline.atMs, 10000);
  assert.equal(run.startRegistration.status, 'confirmed'); assert.equal(calls.length, 2);
});

test('registration latency never consumes pre-roll and a different retry ID cannot restart it', async () => {
  let calls = 0, h;
  const startRegistry = {ensureStart: async identity => {calls++; h.setTime(9000); return confirmed(identity);}};
  h = harness(['A'], {startRegistry, scoredCollectionEnabled: true}); await scored(h);
  assert.equal((await action(h.service, 'scored-run', 'start', 'start-one')).status, 200);
  assert.equal((await h.store.readRun('scored-run')).state.recordingStartedAtMs, 9000);
  h.setTime(10000); const repeated = await (await action(h.service, 'scored-run', 'start', 'different-id')).json();
  assert.equal(repeated.accepted, true); assert.equal((await h.store.readRun('scored-run')).state.recordingStartedAtMs, 9000);
  assert.equal((await h.store.readRun('scored-run')).events.filter(event => event.kind === 'start').length, 1); assert.equal(calls, 1);
});

test('Stop during pending registration retains a later confirmed start registration without starting timing or assignments', async () => {
  let available = false; const startRegistry = {ensureStart: async identity => available ? confirmed(identity) : {status: 'pending', registration: null}};
  const h = harness(['A'], {startRegistry, scoredCollectionEnabled: true}); await scored(h);
  await action(h.service, 'scored-run', 'start', 'start-one'); await action(h.service, 'scored-run', 'stop', 'stop');
  available = true;
  const retry = await action(h.service, 'scored-run', 'start', 'retry-after-stop');
  assert.equal(retry.status, 200); assert.equal((await retry.json()).accepted, false);
  const run = await h.store.readRun('scored-run'); assert.equal(run.state.lifecycle, 'stopped'); assert.equal(run.state.recordingStartedAtMs, null);
  assert.equal(run.startRegistration.status, 'confirmed'); assert.equal(h.randomService.drawn.length, 0);
  const exported = await (await h.service.fetch(api('runs/scored-run/export'))).json(); assert.equal(exported.startRegistration.registration.attestationUid, fixtureHash(500));
  const series = await h.storage.get('tree-targeting:series:scored-series'); assert.equal(series.members[0].collectionStartedAtMs, null);
});

test('a new service and action ID recover the same durable run registration', async () => {
  const f = registryFixture(), h = harness(['A'], {scoredCollectionEnabled: true});
  const options = {...f.options, storage: h.storage}; const registry = createStartRegistry(options);
  h.service = createService({store: h.store, storage: h.storage, randomService: h.randomService, authenticate: async () => ({id: 'operator'}), codeCheckpoint: 'a'.repeat(40), scoredCollectionEnabled: true, startRegistry: registry, clock: () => 1000});
  const run = await scored(h); await action(h.service, run.runId, 'start', 'first');
  const identity = f.prepared[0].identity; f.receipts.set(fixtureHash(1), f.confirmed(fixtureHash(1), identity));
  const restarted = createService({store: h.store, storage: h.storage, randomService: h.randomService, authenticate: async () => ({id: 'operator'}), codeCheckpoint: 'a'.repeat(40), scoredCollectionEnabled: true, startRegistry: createStartRegistry(options), clock: () => 9000});
  assert.equal((await action(restarted, run.runId, 'start', 'second')).status, 200);
  assert.equal(f.prepared.length, 1); assert.equal((await h.store.readRun(run.runId)).state.recordingStartedAtMs, 9000);
});

test('preparation starts without blockchain configuration and mismatching scored source never registers', async () => {
  const h = harness(); await ready(h, 'preparation', defaultConfig('tree'));
  assert.equal((await h.store.readRun('preparation')).state.lifecycle, 'running');
  let calls = 0; const enabled = harness(['A'], {scoredCollectionEnabled: true, startRegistry: {ensureStart: async identity => {calls++; return confirmed(identity);}}});
  const run = await scored(enabled); run.codeCheckpoint = 'b'.repeat(40); await enabled.storage.put('experiment:tree-targeting:run:scored-run', run);
  const response = await action(enabled.service, run.runId, 'start', 'bad-source'); assert.equal(response.status, 409); assert.equal(calls, 0);
});

test('protected issue routes require operator authorization and append exportable reports', async () => {
  const f = registryFixture(), h = harness(['A'], {scoredCollectionEnabled: true}); const registry = createStartRegistry({...f.options, storage: h.storage});
  h.service = createService({store: h.store, storage: h.storage, randomService: h.randomService, authenticate: async () => ({id: 'operator'}), codeCheckpoint: 'a'.repeat(40), scoredCollectionEnabled: true, startRegistry: registry});
  const run = await scored(h); await action(h.service, run.runId, 'start', 'start');
  f.receipts.set(fixtureHash(1), f.confirmed(fixtureHash(1), f.prepared[0].identity)); await action(h.service, run.runId, 'start', 'start');
  const issue = await h.service.fetch(api('runs/scored-run/issues', 'POST', {category: 'recording_unavailable', reason: 'Camera stopped', streamUrl: 'https://stream.example.test/live'})); assert.equal(issue.status, 201);
  const stream = await h.service.fetch(api('runs/scored-run/stream', 'POST', {streamUrl: 'https://stream.example.test/new'})); assert.equal(stream.status, 201);
  await action(h.service, run.runId, 'stop', 'stop'); const exported = await (await h.service.fetch(api('runs/scored-run/export'))).json();
  assert.ok(exported.events.some(event => event.kind === 'startIssueReported' && event.data.reason === 'Camera stopped'));
  const denied = createService({store: h.store, storage: h.storage, randomService: h.randomService, authenticate: async () => null, startRegistry: registry});
  assert.equal((await denied.fetch(api('runs/scored-run/issues', 'POST', {category: 'analysis_failed', reason: 'No file'}))).status, 403);
});

test('Stop is accepted while a first receipt is in flight and confirmation cannot begin the canceled sequence', async () => {
  let release, entered;
  const registering = new Promise(resolve => {entered = resolve;});
  const receipt = new Promise(resolve => {release = resolve;});
  const h = harness(['A'], {scoredCollectionEnabled: true, startRegistry: {ensureStart: async identity => {entered(identity); await receipt; return confirmed(identity);}}});
  await scored(h);
  const starting = action(h.service, 'scored-run', 'start', 'start'); await registering;
  const stopping = action(h.service, 'scored-run', 'stop', 'stop');
  await new Promise(resolve => setImmediate(resolve));
  const during = await h.store.readRun('scored-run');
  release(); await starting; await stopping;
  assert.equal(during.state.lifecycle, 'stopped');
  const run = await h.store.readRun('scored-run'); assert.equal(run.state.recordingStartedAtMs, null);
  assert.equal(run.startRegistration.status, 'confirmed'); assert.equal(run.events.filter(event => event.kind === 'start').length, 0);
});
