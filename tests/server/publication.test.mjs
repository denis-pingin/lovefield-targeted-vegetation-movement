import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hash, publicationFixture, partSize} from './publication-fixtures.mjs';

test('multipart resume survives reconstruction and identical retries are idempotent', async () => {
  const f = publicationFixture({video: Buffer.alloc(partSize + 31, 7)}), fixture = f.manifest();
  assert.equal((await f.begin(fixture)).status, 201);
  const id = fixture.manifest.publicationId, digest = fixture.original;
  assert.equal((await f.fetch(`jobs/${id}/files/${digest}`, 'POST', {})).status, 200);
  const bytes = fixture.bytes.get(digest).subarray(0, partSize);
  assert.equal((await f.fetch(`jobs/${id}/files/${digest}/parts/1`, 'PUT', bytes, {'X-Content-Sha256': hash(bytes)})).status, 200);
  f.construct();
  const state = await (await f.fetch(`jobs/${id}`)).json();
  assert.equal(state.uploads[digest].parts[0].partNumber, 1);
  assert.equal((await f.fetch(`jobs/${id}/files/${digest}/parts/1`, 'PUT', bytes, {'X-Content-Sha256': hash(bytes)})).status, 200);
  assert.deepEqual(f.bucket.partCalls, [1]);
  assert.equal((await f.complete(fixture)).status, 200);
  assert.equal((await f.complete(fixture)).status, 200);
  const latest = await (await f.publicRequest('latest')).json();
  assert.equal(latest.publicationId, id);
  assert.equal(latest.includedAnalyses.length, 1);
});

test('failed incomplete and stale publications leave the prior global revision current', async () => {
  const f = publicationFixture(), first = f.manifest();
  assert.equal((await f.complete(first)).status, 200);
  const second = f.manifest(first.manifest.publicationId);
  assert.equal((await f.begin(second)).status, 201);
  assert.equal((await f.fetch(`jobs/${second.manifest.publicationId}/commit`, 'POST', {})).status, 409);
  assert.equal((await f.publicRequest(`publications/${second.manifest.publicationId}/files/${second.original}/camera.mp4`)).status, 404);
  const stale = f.manifest(null);
  assert.equal((await f.complete(stale)).status, 409);
  assert.equal((await (await f.publicRequest('latest')).json()).publicationId, first.manifest.publicationId);
});

test('coverage is checked again when a collected recording is added before commit', async () => {
  const f = publicationFixture(), fixture = f.manifest();
  assert.equal((await f.begin(fixture)).status, 201);
  for (const digest of fixture.bytes.keys()) assert.equal((await f.upload(fixture, digest)).status, 200);
  f.inventory.push({...f.inventory[0], runId: 'new-pending', collectionStartedAtMs: 12000});
  assert.equal((await f.fetch(`jobs/${fixture.manifest.publicationId}/commit`, 'POST', {})).status, 409);
  assert.equal((await f.publicRequest('latest')).status, 404);
});

test('manifest bytes, preparation, corruption and missing supporting inputs are rejected', async () => {
  const f = publicationFixture(), fixture = f.manifest();
  assert.equal((await f.fetch('jobs', 'POST', {manifestJson: JSON.stringify(fixture.manifest), manifestSha256: 'f'.repeat(64)})).status, 400);
  fixture.manifest.purpose = 'preparation'; assert.equal((await f.begin(fixture)).status, 400);
  fixture.manifest.purpose = 'scored'; assert.equal((await f.begin(fixture)).status, 201);
  fixture.manifest.correctionReason = 'different bytes'; assert.equal((await f.begin(fixture)).status, 409);
  const id = fixture.manifest.publicationId, digest = fixture.original;
  await f.fetch(`jobs/${id}/files/${digest}`, 'POST', {});
  assert.equal((await f.fetch(`jobs/${id}/files/${digest}/parts/1`, 'PUT', Buffer.from('corrupt'), {'X-Content-Sha256': digest})).status, 409);
  assert.equal((await f.fetch(`jobs/${id}/files/${digest}/complete`, 'POST', {})).status, 409);
});

test('only a Test publisher can stage explicitly synthetic inventory', async () => {
  const f = publicationFixture();
  const staged = {softwareTest: true, seriesId: 'synthetic-only', inventory: f.inventory};
  assert.equal((await f.service.fetch(f.request('software-test/inventory', 'POST', staged), {id: 'operator', role: 'operator'})).status, 403);
  assert.equal((await f.fetch('software-test/inventory', 'POST', staged)).status, 200);
  const response = await f.fetch('series/synthetic-only/inventory?softwareTest=true');
  assert.equal((await response.json()).softwareTest, true);
  assert.equal(f.inventory.length, 1);
  const production = publicationFixture({environment: 'production'});
  assert.equal((await production.fetch('software-test/inventory', 'POST', staged)).status, 403);
});

test('the existing Tree object persists publication inventory without changing collection records', async () => {
  const {TreeTargetingSession} = await import('../../server/worker.mjs');
  const f = publicationFixture(), ctx = {storage: f.storage, getWebSockets: () => []};
  const env = {TREE_PUBLICATIONS: f.bucket, RELEASE_ENVIRONMENT: 'test'};
  const session = new TreeTargetingSession(ctx, env);
  const request = f.request('software-test/inventory', 'POST', {softwareTest: true, seriesId: 'synthetic-only', inventory: f.inventory});
  request.headers.set('X-Tree-Actor', 'publisher'); request.headers.set('X-Tree-Actor-Role', 'publisher');
  assert.equal((await session.fetch(request)).status, 200);
  assert.deepEqual(await session.store.listRuns(), []);
  const restarted = new TreeTargetingSession(ctx, env);
  const get = f.request('series/synthetic-only/inventory?softwareTest=true');
  get.headers.set('X-Tree-Actor', 'publisher'); get.headers.set('X-Tree-Actor-Role', 'publisher');
  assert.equal((await restarted.fetch(get)).status, 200);
});

test('the actual Tree storage adapter lists scoped progress with a limit and continuation', async () => {
  const {DurableStorageAdapter} = await import('../../server/worker.mjs');
  const {MemoryStorage} = await import('./service-fixtures.mjs');
  const storage = new MemoryStorage(), adapter = new DurableStorageAdapter(storage);
  for (const [key, value] of [['parts:001', {partNumber: 1}], ['parts:002', {partNumber: 2}],
    ['parts:003', {partNumber: 3}], ['other:004', {partNumber: 4}]]) await storage.put(key, value);
  assert.deepEqual(await adapter.list({prefix: 'parts:', limit: 1}), new Map([['parts:001', {partNumber: 1}]]));
  assert.deepEqual(await adapter.list({prefix: 'parts:', limit: 1, startAfter: 'parts:001'}), new Map([['parts:002', {partNumber: 2}]]));
  assert.deepEqual(await storage.get('other:004'), {partNumber: 4});
});

test('the actual Tree object creates, reopens and completes a multipart publication with retained job state', async () => {
  const {DurableStorageAdapter, TreeTargetingSession} = await import('../../server/worker.mjs');
  const {MemoryStorage} = await import('./service-fixtures.mjs');
  const storage = new MemoryStorage();
  const f = publicationFixture({video: Buffer.alloc(partSize + 31, 7), storage: new DurableStorageAdapter(storage)}), fixture = f.manifest();
  fixture.manifest.softwareTest = true;
  const ctx = {storage, getWebSockets: () => []};
  const env = {TREE_PUBLICATIONS: f.bucket, RELEASE_ENVIRONMENT: 'test', DEVELOPMENT_CLOCK: () => 10000};
  let session = new TreeTargetingSession(ctx, env);
  const fetch = (path, method, body, headers = {}) => session.fetch(f.request(path, method, body,
    {'X-Tree-Actor': 'publisher', 'X-Tree-Actor-Role': 'publisher', ...headers}));
  const manifestJson = JSON.stringify(fixture.manifest), submitted = {manifestJson, manifestSha256: hash(manifestJson)};
  const id = fixture.manifest.publicationId, digest = fixture.original;
  const unchanged = {runId: 'retained-collection-record', lifecycle: 'completed'};
  await f.storage.put('retained-collection-record', unchanged);
  assert.equal((await fetch('software-test/inventory', 'POST', {
    softwareTest: true, seriesId: fixture.manifest.seriesId, inventory: f.inventory,
  })).status, 200);
  const created = await fetch('jobs', 'POST', submitted);
  assert.equal(created.status, 201, JSON.stringify(await created.json()));
  assert.equal((await fetch(`jobs/${id}/files/${digest}`, 'POST', {})).status, 200);
  const firstPart = fixture.bytes.get(digest).subarray(0, partSize);
  assert.equal((await fetch(`jobs/${id}/files/${digest}/parts/1`, 'PUT', firstPart, {'X-Content-Sha256': hash(firstPart)})).status, 200);
  session = new TreeTargetingSession(ctx, env);
  const resumed = await fetch('jobs', 'POST', submitted);
  assert.equal(resumed.status, 200);
  const state = await resumed.json();
  assert.equal(state.manifestSha256, submitted.manifestSha256);
  assert.equal(state.uploads[digest].parts[0].partNumber, 1);
  assert.equal((await fetch(`jobs/${id}`)).status, 200);
  // Node lacks Cloudflare DigestStream; the fixture verifies bytes through the real service and storage adapter.
  assert.equal((await f.complete(fixture)).status, 200);
  session = new TreeTargetingSession(ctx, env);
  assert.equal((await (await fetch(`jobs/${id}`)).json()).status, 'completed');
  const latest = await session.fetch(new Request('https://test.lab.sourceof.love/studies/tree-targeting/public/api/latest'));
  assert.equal((await latest.json()).publicationId, id);
  assert.deepEqual(await f.storage.get('retained-collection-record'), unchanged);
  assert.deepEqual(await session.store.listRuns(), []);
});

function updateJsonFile(fixture, oldHash, value) {
  const bytes = Buffer.from(JSON.stringify(value)), digest = hash(bytes), original = fixture.manifest.files[oldHash];
  fixture.bytes.delete(oldHash); delete fixture.manifest.files[oldHash];
  fixture.bytes.set(digest, bytes); fixture.manifest.files[digest] = {...original, sha256: digest, size: bytes.length};
  return digest;
}

test('ordinary accumulation and another series need no correction reason while changed selected revisions do', async () => {
  const f = publicationFixture(), first = f.manifest();
  assert.equal((await f.complete(first)).status, 200);
  f.inventory.push({...f.inventory[0], runId: 'new-recording', collectionStartedAtMs: 12000, createdAtMs: 11000, lifecycle: 'running', finishedAtMs: null});
  const appended = f.manifest(first.manifest.publicationId);
  appended.manifest.correctionReason = null;
  appended.manifest.inventory[1].contributes = false;
  appended.manifest.inventory[1].analysisState = 'pending'; delete appended.manifest.inventory[1].analysis;
  assert.equal((await f.complete(appended)).status, 200);
  const corrected = f.manifest(appended.manifest.publicationId);
  corrected.manifest.correctionReason = null;
  corrected.manifest.inventory[1].contributes = false; corrected.manifest.inventory[1].analysisState = 'pending'; delete corrected.manifest.inventory[1].analysis;
  const entry = corrected.manifest.includedAnalyses[0]; entry.analysisId = 'revised-analysis';
  const artifact = JSON.parse(corrected.bytes.get(entry.analysisSha256)); artifact.analysisId = entry.analysisId; artifact.result.revisionId = entry.analysisId;
  entry.analysisSha256 = updateJsonFile(corrected, entry.analysisSha256, artifact);
  corrected.manifest.accumulated.included[0].analysisId = entry.analysisId;
  const result = JSON.parse(corrected.bytes.get(corrected.manifest.accumulated.resultSha256)); result.selectedRevisions = [entry.analysisId];
  corrected.manifest.accumulated.resultSha256 = updateJsonFile(corrected, corrected.manifest.accumulated.resultSha256, result);
  assert.equal((await f.complete(corrected)).status, 409);
  const other = f.manifest(appended.manifest.publicationId); other.manifest.seriesId = 'other-series'; other.manifest.correctionReason = null;
  other.manifest.inventory[1].contributes = false; other.manifest.inventory[1].analysisState = 'pending'; delete other.manifest.inventory[1].analysis;
  const series = JSON.parse(other.bytes.get(other.manifest.seriesBundle.sha256)); series.seriesId = 'other-series';
  const seriesHash = updateJsonFile(other, other.manifest.seriesBundle.sha256, series);
  other.manifest.seriesBundle.sha256 = seriesHash; other.manifest.accumulated.seriesBundleSha256 = seriesHash;
  assert.equal((await f.complete(other)).status, 200);
  assert.equal((await (await f.publicRequest('latest')).json()).seriesId, 'other-series');
});

test('an accepted large manifest and its completed revision fit the real per-value storage bound', async () => {
  const {MemoryStorage} = await import('./service-fixtures.mjs');
  class BoundedStorage extends MemoryStorage {
    async put(key, value) {
      assert.ok(Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024, 'Durable Object value exceeds 2 MB');
      return super.put(key, value);
    }
  }
  const f = publicationFixture({storage: new BoundedStorage()}), fixture = f.manifest();
  fixture.manifest.sourceReleases.retainedDescription = 'x'.repeat(1100 * 1024);
  assert.equal((await f.begin(fixture)).status, 201);
  f.construct();
  assert.equal((await f.complete(fixture)).status, 200);
  const exact = JSON.stringify(fixture.manifest);
  assert.equal(await (await f.publicRequest(`publications/${fixture.manifest.publicationId}/manifest`)).text(), exact);
});

test('the actual R2 part-count format limit is rejected before a job is retained', async () => {
  const f = publicationFixture(), fixture = f.manifest();
  fixture.manifest.files[fixture.original].size = partSize * 10000 + 1;
  const response = await f.begin(fixture);
  assert.equal(response.status, 413);
  assert.match((await response.json()).message, /10,000.*8 MiB/);
  assert.equal((await f.fetch(`jobs/${fixture.manifest.publicationId}`)).status, 404);
});

test('complete originals larger than 16 MiB retain independent identity validation after numerical subtrees', async () => {
  for (const mismatching of [false, true]) {
    const f = publicationFixture(), fixture = f.manifest(), entry = fixture.manifest.includedAnalyses[0];
    const original = JSON.parse(fixture.bytes.get(entry.analysisSha256));
    const artifact = {measurements: ['x'.repeat(17 * 1024 * 1024)], ...original,
      result: {timeline: [{details: '{escaped \\" text}'}], ...original.result,
        runId: mismatching ? 'wrong-recording' : entry.runId}};
    entry.analysisSha256 = updateJsonFile(fixture, entry.analysisSha256, artifact);
    const response = await f.complete(fixture);
    assert.equal(response.status, mismatching ? 409 : 200);
    if (mismatching) assert.match((await response.json()).message, /mismatching identity/);
  }
});

test('an individual artifact must retain its actual input identity maps', async () => {
  const f = publicationFixture(), fixture = f.manifest(), entry = fixture.manifest.includedAnalyses[0];
  const artifact = JSON.parse(fixture.bytes.get(entry.analysisSha256)); delete artifact.inputHashes;
  entry.analysisSha256 = updateJsonFile(fixture, entry.analysisSha256, artifact);
  const response = await f.complete(fixture);
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /input identit/);
});

test('malformed retained JSON is an invalid-artifact conflict rather than a resumable provider failure', async () => {
  const f = publicationFixture(), fixture = f.manifest(), entry = fixture.manifest.includedAnalyses[0];
  const old = entry.analysisSha256, bytes = Buffer.from('{"runId":"recording-one","result":[1,]}'), digest = hash(bytes);
  fixture.bytes.delete(old); fixture.bytes.set(digest, bytes);
  fixture.manifest.files[digest] = {...fixture.manifest.files[old], sha256: digest, size: bytes.length};
  delete fixture.manifest.files[old]; entry.analysisSha256 = digest;
  const response = await f.complete(fixture);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'artifact_invalid');
});

test('exact Python-style manifest bytes are accepted independently of object key order', async () => {
  const f = publicationFixture(), fixture = f.manifest();
  fixture.manifest.accumulated.included = fixture.manifest.accumulated.included.map(({runId, analysisId}) => ({analysisId, runId}));
  const response = await f.complete(fixture);
  assert.equal(response.status, 200);
  assert.equal(await (await f.publicRequest(`publications/${fixture.manifest.publicationId}/manifest`)).text(), JSON.stringify(fixture.manifest));
});

test('public revision metadata exposes actual completion separately from immutable preparation bytes', async () => {
  const f = publicationFixture(), fixture = f.manifest();
  fixture.manifest.createdAtMs = 9000;
  const exact = JSON.stringify(fixture.manifest);
  const completion = await f.complete(fixture);
  assert.equal(completion.status, 200);
  const receipt = await completion.json();
  assert.equal(receipt.completedAtMs, 10000);
  for (const path of ['latest', `publications/${fixture.manifest.publicationId}`]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await f.publicRequest(path, {method});
      assert.equal(response.headers.get('X-Publication-Completed-At-Ms'), '10000');
      if (method === 'GET') assert.equal((await response.json()).createdAtMs, 9000);
    }
  }
  assert.equal(await (await f.publicRequest(`publications/${fixture.manifest.publicationId}/manifest`)).text(), exact);
});


test('old and canonical publication APIs use the same immutable job, manifest and exact file bytes', async () => {
  const f = publicationFixture({video: Buffer.from(Array.from({length: 16}, (_, index) => index))}), fixture = f.manifest();
  const manifestJson = JSON.stringify(fixture.manifest), manifestSha256 = hash(manifestJson);
  for (const [index, slug] of ['tree-targeting', 'targeted-vegetation-movement'].entries()) {
    const response = await f.service.fetch(new Request('https://test.lab.sourceof.love/studies/' + slug + '/app/api/publication/jobs', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({manifestJson, manifestSha256}),
    }), {id: 'publisher', role: 'publisher'});
    assert.equal(response.status, index === 0 ? 201 : 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal((await response.json()).manifestSha256, manifestSha256);
  }
  const completed = await f.complete(fixture);
  assert.equal(completed.status, 200);
  const receipt = await completed.json(), id = fixture.manifest.publicationId;
  assert.equal(receipt.resultsUrl, '/studies/targeted-vegetation-movement/public/results?publication=' + id);
  const before = structuredClone(f.storage.values);
  for (const slug of ['tree-targeting', 'targeted-vegetation-movement']) {
    const oldClient = await f.service.fetch(new Request('https://test.lab.sourceof.love/studies/' + slug + '/app/api/publication/jobs/' + id), {id: 'publisher', role: 'publisher'});
    assert.equal(oldClient.status, 200);
    assert.equal((await oldClient.json()).receipt.resultsUrl, '/studies/' + slug + '/public/results?publication=' + id);
    const commit = await f.service.fetch(new Request('https://test.lab.sourceof.love/studies/' + slug + '/app/api/publication/jobs/' + id + '/commit', {method: 'POST'}), {id: 'publisher', role: 'publisher'});
    assert.equal((await commit.json()).resultsUrl, '/studies/' + slug + '/public/results?publication=' + id);
    const base = 'https://test.lab.sourceof.love/studies/' + slug + '/public/api/publications/' + id;
    const manifestResponse = await f.service.readPublic(new Request(base + '/manifest'));
    assert.equal(manifestResponse.status, 200); assert.equal(manifestResponse.headers.get('location'), null);
    assert.equal(await manifestResponse.text(), manifestJson);
    const ranged = await f.service.readPublic(new Request(base + '/files/' + fixture.original + '/camera.mp4', {headers: {Range: 'bytes=2-5'}}));
    assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('Content-Range'), 'bytes 2-5/16');
    assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), Uint8Array.of(2, 3, 4, 5));
  }
  assert.deepEqual(f.storage.values, before);
});
