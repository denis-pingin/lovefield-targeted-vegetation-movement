import test from 'node:test';
import assert from 'node:assert/strict';
import {TreeTargetingSession, createWorkerHandler} from '../../server/worker.mjs';
import {publicationFixture} from './publication-fixtures.mjs';
import {MemoryStorage, harness} from './service-fixtures.mjs';
import {registryConfiguration} from './start-registry-fixtures.mjs';
import {defaultConfig} from '../../web/run-config.mjs';

const statusRequest = () => new Request('https://test.lab.sourceof.love/studies/tree-targeting/public/api/status');

test('public status returns cached registrations promptly while one background registry sync waits for RPC', async () => {
  const storage = new MemoryStorage(), pending = []; let release, syncCalls = 0;
  const stalled = new Promise(resolve => {release = resolve;});
  const registry = {readiness: () => ({}), synchronize: async () => {syncCalls++; await stalled;}, status: async () => ({registry: {state: 'configured'}, synchronization: {state: 'catching_up'}, registrations: [{runId: 'cached'}], latestPublicationId: null})};
  const session = new TreeTargetingSession({storage, waitUntil: promise => pending.push(promise)}, {RELEASE_ENVIRONMENT: 'test', SYNTHETIC_START_REGISTRY: registry});
  const response = await session.fetch(statusRequest()); assert.equal(response.status, 200);
  const status = await response.json(); assert.equal(status.registrations[0].runId, 'cached'); assert.equal(Object.hasOwn(status, 'attempts'), false);
  assert.equal(syncCalls, 1); assert.equal(pending.length, 1); release(); await pending[0];
});

test('both unconfigured status routes return only the registrations collection', async () => {
  const service = harness().service;
  const session = new TreeTargetingSession({storage: new MemoryStorage(), waitUntil() {}}, {RELEASE_ENVIRONMENT: 'test'});
  for (const handler of [service, session]) {
    const response = await handler.fetch(statusRequest()); assert.equal(response.status, 200);
    const status = await response.json(); assert.deepEqual(status.registrations, []);
    assert.equal(Object.hasOwn(status, 'attempts'), false);
    assert.deepEqual(Object.keys(status).sort(), ['latestPublicationId', 'registrations', 'registry', 'synchronization']);
  }
  const rejected = await session.fetch(new Request(statusRequest(), {method: 'POST'}));
  assert.equal(rejected.status, 405); assert.equal((await rejected.json()).message, 'Start registrations are read-only.');
});

test('public-reader status is GET only and issue routes stay protected by the operator boundary', async () => {
  const forwarded = []; const handler = createWorkerHandler({authenticate: async () => {throw new Error('reader should not authenticate');}});
  const env = {RELEASE_ENVIRONMENT: 'production', PUBLIC_STUDY_ENABLED: 'true', TREE_SESSIONS: {idFromName: name => name, get: () => ({fetch: request => {forwarded.push(request); return new Response('{}');}})}};
  assert.equal((await handler.fetch(statusRequest(), env)).status, 200); assert.equal(forwarded[0].headers.get('X-Tree-Actor-Role'), 'reader');
  assert.equal((await handler.fetch(new Request(statusRequest(), {method: 'POST'}), env)).status, 405);
  assert.equal((await handler.fetch(new Request('https://test.lab.sourceof.love/studies/tree-targeting/app/api/runs/run/issues', {method: 'POST'}), env)).status, 503);
});

test('committed publication status inventory is compact, identity-bound and preserves the previous snapshot on upload failure', async () => {
  const h = publicationFixture(); const first = h.manifest(); await h.complete(first);
  const inventory = await h.service.statusInventory();
  assert.equal(inventory.latestPublicationId, first.manifest.publicationId); assert.equal(inventory.runs.length, 1);
  assert.equal(inventory.runs[0].configHash, `0x${h.inventory[0].configHash}`); assert.equal(inventory.runs[0].sourceCheckpoint, h.inventory[0].codeCheckpoint);
  assert.equal(inventory.runs[0].analysisPublished, true); assert.equal('files' in inventory.runs[0], false);
  const next = h.manifest(first.manifest.publicationId); await h.begin(next);
  assert.equal((await h.fetch(`jobs/${next.manifest.publicationId}/commit`, 'POST', {})).status, 409);
  const retained = await h.service.statusInventory(); assert.equal(retained.latestPublicationId, inventory.latestPublicationId); assert.deepEqual(retained.runs, inventory.runs);
});

test('hosted scored activation stays separately disabled even with a ready injected registry', async () => {
  let registryCalls = 0;
  const session = new TreeTargetingSession({storage: new MemoryStorage()}, {START_REGISTRY_CONFIG: JSON.stringify(registryConfiguration), RELEASE_ENVIRONMENT: 'test', SYNTHETIC_START_REGISTRY: {readiness: () => ({configured: true}), ensureStart: () => {registryCalls++;}}});
  const request = new Request('https://test.lab.sourceof.love/studies/tree-targeting/app/api/runs', {method: 'POST', headers: {'X-Tree-Actor': 'operator', 'Content-Type': 'application/json'}, body: JSON.stringify({config: defaultConfig('tree', 'scored')})});
  const response = await session.fetch(request);
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'scored_locked'); assert.equal(registryCalls, 0);
});

test('synthetic Test publications stay readable by identity without becoming the public latest status', async () => {
  const h = publicationFixture(), fixture = h.manifest(); fixture.manifest.softwareTest = true;
  assert.equal((await h.fetch('software-test/inventory', 'POST', {softwareTest: true, seriesId: fixture.manifest.seriesId, inventory: h.inventory})).status, 200);
  assert.equal((await h.complete(fixture)).status, 200);
  assert.deepEqual(await h.service.statusInventory(), {latestPublicationId: null, runs: []});
  const pinned = await h.publicRequest(`publications/${fixture.manifest.publicationId}`);
  assert.equal(pinned.status, 200); assert.equal((await pinned.json()).publicationId, fixture.manifest.publicationId);
});

test('a published inventory can retain a failed analysis without claiming nonexistent analysis files', async () => {
  const h = publicationFixture();
  h.inventory.push({...h.inventory[0], runId: 'failed-analysis', createdAtMs: 10000, collectionStartedAtMs: 12000});
  const fixture = h.manifest();
  Object.assign(fixture.manifest.inventory[1], {analysisState: 'failed', contributes: false, analysis: {analysisId: 'failed-revision'}});
  assert.equal((await h.complete(fixture)).status, 200);
  const inventory = await h.service.statusInventory();
  assert.equal(inventory.runs[0].analysisPublished, true);
  assert.equal(inventory.runs[1].analysisPublished, false); assert.equal(inventory.runs[1].availableInputCount, 0);
});
