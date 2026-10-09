import test from 'node:test';
import assert from 'node:assert/strict';
import {createStartRegistry} from '../../server/start-registry.mjs';
import {registryFixture, startIdentity, registryConfiguration, fixtureHash} from './start-registry-fixtures.mjs';

const make = h => createStartRegistry(h.options);
test('lost broadcast replies retain identical bytes and recover after a registry restart', async () => {
  const h = registryFixture(); let registry = make(h);
  h.chain.broadcast = async bytes => {h.broadcasts.push(bytes); throw new Error('sensitive-provider-error');};
  const pending = await registry.ensureStart(startIdentity); assert.equal(pending.status, 'pending');
  assert.equal(h.prepared.length, 1);
  const saved = [...h.storage.values.values()].find(value => value.transaction?.serializedTransaction);
  assert.equal(saved.transaction.serializedTransaction, h.prepared[0].result.serializedTransaction);
  h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1)));
  registry = make(h);
  const result = await registry.ensureStart(startIdentity); assert.equal(result.status, 'confirmed');
  assert.equal(h.prepared.length, 1); assert.equal((await registry.status()).registrations.length, 1);
  assert.equal(JSON.stringify(result).includes('synthetic-signed'), false);
  assert.equal(JSON.stringify(h.warnings).includes('sensitive-provider-error'), false);
});

test('concurrent starts and retries allocate only one unresolved signer transaction', async () => {
  const h = registryFixture(), registry = make(h);
  const second = {...startIdentity, runId: 'run-two'};
  const results = await Promise.all([registry.ensureStart(startIdentity), registry.ensureStart(startIdentity), registry.ensureStart(second)]);
  assert.ok(results.every(result => result.status === 'pending')); assert.equal(h.prepared.length, 1);
  assert.ok(h.broadcasts.every(bytes => bytes === h.prepared[0].result.serializedTransaction));
  h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1)));
  await registry.ensureStart(second); assert.equal(h.prepared.length, 2);
});

test('confirmed registration retains the allocated nonce in its public run metadata', async () => {
  const h = registryFixture(), registry = make(h);
  await registry.ensureStart(startIdentity); h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1)));
  const result = await registry.ensureStart(startIdentity);
  assert.equal(result.registration.nonce, '0');
  const status = await registry.status();
  assert.equal(status.registrations[0].nonce, '0');
  assert.equal(Object.hasOwn(status, 'attempts'), false);
});

test('unknown transactions stay pending and immutable logical identity cannot be replaced', async () => {
  const h = registryFixture(), registry = make(h);
  await registry.ensureStart(startIdentity);
  await assert.rejects(registry.ensureStart({...startIdentity, configHash: `0x${'a'.repeat(64)}`}), {code: 'start_identity_conflict'});
  assert.equal((await registry.ensureStart(startIdentity)).status, 'pending'); assert.equal(h.prepared.length, 1);
  assert.equal((await registry.status()).registrations.length, 0);
});

test('a definitively reverted transaction is retained and a later retry uses a new transaction for that run', async () => {
  const h = registryFixture(), registry = make(h);
  await registry.ensureStart(startIdentity);
  h.receipts.set(fixtureHash(1), {status: 'failed', transactionHash: fixtureHash(1), error: {code: 'transaction_reverted', message: 'Reverted'}});
  assert.equal((await registry.ensureStart(startIdentity)).status, 'failed');
  const retry = await registry.ensureStart(startIdentity); assert.equal(retry.status, 'pending'); assert.equal(h.prepared.length, 2);
  h.receipts.set(fixtureHash(2), h.confirmed(fixtureHash(2)));
  assert.equal((await registry.ensureStart(startIdentity)).status, 'confirmed');
  assert.equal((await registry.status()).registrations.length, 1);
});

test('schema setup has the same durable recovery and blocks run transaction allocation until verified', async () => {
  const h = registryFixture(), registry = make(h); h.setSchema(false);
  assert.equal((await registry.ensureStart(startIdentity)).status, 'pending');
  assert.equal(h.prepared[0].identity.kind, 'schema');
  const restarted = make(h); await restarted.ensureStart(startIdentity); assert.equal(h.prepared.length, 1);
  h.receipts.set(fixtureHash(1), {status: 'confirmed', transactionHash: fixtureHash(1), schemaUid: 'fixture', blockNumber: '100', blockHash: fixtureHash(100), chainTimestamp: 1000});
  assert.equal((await restarted.ensureStart(startIdentity)).status, 'pending'); assert.equal(h.prepared.length, 2);
  assert.equal(h.prepared[1].identity.runId, startIdentity.runId);
});

test('a mismatching receipt never acknowledges a different fixed run', async () => {
  const h = registryFixture(), registry = make(h);
  await registry.ensureStart(startIdentity); h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1), {...startIdentity, runId: 'other'}));
  const result = await registry.ensureStart(startIdentity);
  assert.equal(result.status, 'pending'); assert.equal(result.error.code, 'receipt_inconsistent');
  assert.equal((await registry.status()).registrations.length, 0);
});

test('disabled registry has distinct unconfigured status and performs no chain operations', async () => {
  const h = registryFixture(), registry = createStartRegistry({...h.options, configuration: {...registryConfiguration, enabled: false}});
  const status = await registry.status();
  assert.equal(status.synchronization.state, 'unconfigured');
  assert.deepEqual(status.registrations, []); assert.equal(Object.hasOwn(status, 'attempts'), false);
  assert.equal((await registry.ensureStart(startIdentity)).error.code, 'registry_unconfigured');
  await registry.synchronize(); assert.deepEqual(h.calls, []);
});

test('manual issue and stream history append dates without removing the start registration', async () => {
  const h = registryFixture(), registry = make(h);
  await registry.ensureStart(startIdentity); h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1))); await registry.ensureStart(startIdentity);
  h.setTime(2000);
  const issue = await registry.reportIssue({runId: startIdentity.runId, category: 'recording_partial', reason: 'First minute unavailable', actor: 'private-operator'});
  h.setTime(3000); await registry.setStream({runId: startIdentity.runId, streamUrl: 'https://stream.example.test/live', actor: 'private-operator'});
  await registry.reportIssue({runId: startIdentity.runId, category: 'resolved', reason: 'Recovered original', previousIssueId: issue.issueId, actor: 'private-operator'});
  const status = await registry.status(); assert.equal(status.registrations.length, 1);
  assert.equal(status.registrations[0].issues.length, 2); assert.equal(status.registrations[0].issues[0].reportedAtMs, 2000);
  assert.equal(status.registrations[0].streamUrl, 'https://stream.example.test/live');
  assert.equal(JSON.stringify(status).includes('private-operator'), false);
  await assert.rejects(registry.reportIssue({runId: startIdentity.runId, category: 'analysis_failed', reason: ' '}), {code: 'issue_invalid'});
  await assert.rejects(registry.setStream({runId: startIdentity.runId, streamUrl: 'javascript:alert(1)'}), {code: 'stream_invalid'});
  await assert.rejects(registry.reportIssue({runId: startIdentity.runId, category: 'resolved', reason: 'Correction', previousIssueId: 'missing'}), {code: 'issue_reference_invalid'});
  await assert.rejects(registry.reportIssue({runId: 'unregistered-run', category: 'analysis_failed', reason: 'No analysis'}), {code: 'registration_not_found', message: 'Report metadata for a registered scored run.'});
});

test('corrections preserve an unresolved category and resolving analysis does not clear missing recording', async () => {
  const h = registryFixture(), registry = make(h); await registry.ensureStart(startIdentity);
  h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1))); await registry.ensureStart(startIdentity);
  const recording = await registry.reportIssue({runId: startIdentity.runId, category: 'recording_unavailable', reason: 'Original unavailable'});
  const correction = await registry.reportIssue({runId: startIdentity.runId, category: 'correction', reason: 'One original clip unavailable', previousIssueId: recording.issueId});
  assert.equal((await registry.status()).registrations[0].data.state, 'recording_unavailable');
  const analysis = await registry.reportIssue({runId: startIdentity.runId, category: 'analysis_failed', reason: 'Offline analysis stopped'});
  await registry.reportIssue({runId: startIdentity.runId, category: 'resolved', reason: 'Analysis completed', previousIssueId: analysis.issueId});
  const data = (await registry.status()).registrations[0].data;
  assert.equal(data.state, 'recording_unavailable'); assert.deepEqual(data.reportedStates, ['recording_unavailable']);
  assert.equal(correction.affectedCategory, 'recording_unavailable');
});

test('publication and authoritative execution join only the identical fixed start, preserving orphan and conflicting records', async () => {
  const h = registryFixture(), registry = make(h); await registry.ensureStart(startIdentity);
  h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1))); await registry.ensureStart(startIdentity);
  const runs = [{runId: startIdentity.runId, config: {purpose: 'scored', seriesId: startIdentity.seriesId}, configHash: startIdentity.configHash.slice(2), codeCheckpoint: startIdentity.sourceCheckpoint, state: {lifecycle: 'completed', finishedAtMs: 9000}, events: [], playbackActorId: 'private'}];
  const publications = {latestPublicationId: 'new-publication', runs: [{runId: startIdentity.runId, seriesId: startIdentity.seriesId, configHash: startIdentity.configHash, sourceCheckpoint: startIdentity.sourceCheckpoint, publicationId: 'old-publication', analysisPublished: true}]};
  let registration = (await registry.status({runs, publications})).registrations[0]; assert.equal(registration.execution.state, 'completed'); assert.equal(registration.data.state, 'published');
  const wrong = {...publications, runs: publications.runs.map(item => ({...item, configHash: `0x${'a'.repeat(64)}`}))};
  registration = (await registry.status({runs, publications: wrong})).registrations[0]; assert.equal(registration.data.publications.length, 0);
  assert.equal((await registry.status()).registrations[0].execution.state, 'completion_not_reported');
});
