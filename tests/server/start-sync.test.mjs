import test from 'node:test';
import assert from 'node:assert/strict';
import {createStartRegistry} from '../../server/start-registry.mjs';
import {SCHEMA_UID} from '../../server/start-chain.mjs';
import {registryFixture, startIdentity, fixtureHash} from './start-registry-fixtures.mjs';
const make = h => createStartRegistry(h.options);
const syncKey = 'start-registry:sync';
const progressKey = 'start-registry:sync:progress';
function history(h, {head = 1000, activity = [100], starts = 1} = {}) {
  const logs = [], ranges = [], probes = [];
  for (let index = 0; index < starts; index++) {
    const uid = fixtureHash(10000 + index), block = activity[Math.min(index, activity.length - 1)];
    logs.push({attestationUid: uid, transactionHash: fixtureHash(20000 + index), blockNumber: String(block), blockHash: fixtureHash(block), logIndex: String(index)});
    h.attestations.set(uid, {attestationUid: uid, schemaUid: SCHEMA_UID, identity: {...startIdentity, runId: `external-${index}`}, chainTimestamp: block});
  }
  h.chain.finalizedBlock = async budget => {budget.spend(); h.calls.push('head'); return {number: String(head), timestamp: head};};
  h.chain.transactionCount = async (block, budget) => {budget.spend(); h.calls.push('nonce'); probes.push(String(block)); return String(7 + activity.filter(value => value <= Number(block)).length);};
  h.chain.logs = async (from, to, budget) => {budget.spend(); h.calls.push('logs'); ranges.push([BigInt(from), BigInt(to)]); return logs.filter(log => BigInt(log.blockNumber) >= BigInt(from) && BigInt(log.blockNumber) <= BigInt(to));};
  return {ranges, probes, logs};
}
async function next(h, registry) {h.setTime((await registry.status()).synchronization.nextAllowedAtMs + 1); return registry.synchronize();}

test('the explicit first block initializes at its preceding signer nonce and never scans genesis', async () => {
  const h = registryFixture(), scan = history(h), registry = make(h);
  await registry.synchronize();
  assert.equal(scan.probes[0], '99'); assert.ok(scan.ranges.every(([from]) => from >= 100n));
  assert.equal((await registry.status()).registrations.length, 1);
  assert.equal((await registry.status()).synchronization.indexedBlock, '1000');
});

test('quiet weeks jump to the finalized head with zero log requests', async () => {
  const h = registryFixture(), scan = history(h, {head: 9000000, activity: [], starts: 0});
  await h.storage.put(syncKey, {indexedBlock: '100', cursorNonce: '7', nextAllowedAtMs: 0});
  const registry = make(h); await registry.synchronize();
  assert.deepEqual(scan.ranges, []); assert.equal((await registry.status()).synchronization.indexedBlock, '9000000');
  assert.equal((await registry.status()).synchronization.caughtUp, true); assert.ok(h.calls.length <= 16);
});

test('long quiet gaps use persisted nonce narrowing and at most sixteen reads per sync', async () => {
  const h = registryFixture(), scan = history(h, {head: 900000000, activity: [800000000]});
  let registry = make(h);
  await registry.synchronize(); assert.ok(h.calls.length <= 16); assert.ok(await h.storage.get(progressKey));
  for (let index = 0; index < 6 && !(await registry.status()).synchronization.caughtUp; index++) {
    const before = h.calls.length; registry = make(h); await next(h, registry); assert.ok(h.calls.length - before <= 16);
  }
  const status = await registry.status(); assert.equal(status.synchronization.caughtUp, true); assert.equal(status.registrations.length, 1);
  assert.equal(scan.ranges.length, 1); assert.ok(scan.ranges[0][0] > 799999000n);
  assert.ok(scan.ranges.every(([from, to]) => to - from + 1n <= 500n));
});

test('busy history uses at most two 500-block log pages per shared sync', async () => {
  const h = registryFixture(); const activity = Array.from({length: 2000}, (_, index) => 100 + index); const scan = history(h, {head: 2099, activity, starts: 2000});
  const registry = make(h); await registry.synchronize();
  assert.ok(h.calls.length <= 16); assert.ok(scan.ranges.length <= 2); assert.ok(scan.ranges.every(([from, to]) => to - from + 1n <= 500n));
  assert.equal((await registry.status()).synchronization.caughtUp, false);
});

test('a retained receipt is a search hint and is checked before it becomes finalized', async () => {
  const h = registryFixture(); const registry = make(h);
  await registry.ensureStart(startIdentity); const receipt = h.confirmed(fixtureHash(1), startIdentity, '8000000'); h.receipts.set(fixtureHash(1), receipt); await registry.ensureStart(startIdentity);
  const scan = history(h, {head: 9000000, activity: [8000000], starts: 0});
  h.calls.length = 0; await registry.synchronize();
  assert.ok(scan.probes.includes('8000000')); assert.ok(h.calls.includes('receipt'));
  assert.equal((await registry.status()).registrations[0].confirmation, 'finalized'); assert.ok(h.calls.length <= 16);
});

test('a sealed receipt that disappears remains visible as an issue even during a quiet nonce jump', async () => {
  const h = registryFixture(), registry = make(h);
  await registry.ensureStart(startIdentity); h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1))); await registry.ensureStart(startIdentity);
  h.receipts.clear(); history(h, {head: 1000, activity: [], starts: 0});
  await registry.synchronize(); const registration = (await registry.status()).registrations[0];
  assert.equal(registration.confirmation, 'receipt_issue'); assert.equal(registration.registryIssue.code, 'receipt_missing'); assert.ok(h.warnings.length);
});

test('partial log pages retain each validated record and resume unread items after restart', async () => {
  const h = registryFixture(); history(h, {head: 100, activity: [100], starts: 25});
  let registry = make(h); await registry.synchronize(); const first = await registry.status();
  assert.ok(first.registrations.length > 0 && first.registrations.length < 25); assert.equal(first.synchronization.indexedBlock, '99');
  const fetched = h.calls.filter(name => name === 'attestation').length;
  registry = make(h); await next(h, registry); await next(h, registry);
  const final = await registry.status(); assert.equal(final.registrations.length, 25); assert.equal(final.synchronization.indexedBlock, '100');
  assert.equal(h.calls.filter(name => name === 'attestation').length, 25); assert.ok(fetched < 25);
  assert.equal(h.calls.filter(name => name === 'logs').length, 1);
});

test('no cursor advances across an unread or invalid attestation', async () => {
  const h = registryFixture(), scan = history(h, {head: 100, activity: [100], starts: 2});
  h.attestations.set(scan.logs[1].attestationUid, {attestationUid: scan.logs[1].attestationUid, schemaUid: SCHEMA_UID, identity: {...startIdentity, study: 'other'}, chainTimestamp: 100});
  const registry = make(h); await registry.synchronize(); const status = await registry.status();
  assert.equal(status.registrations.length, 1); assert.equal(status.synchronization.indexedBlock, '99'); assert.equal(status.synchronization.state, 'failed');
});

test('conflicting external starts retain both UIDs and flag fixed-data conflicts', async () => {
  const h = registryFixture(), scan = history(h, {head: 100, activity: [100], starts: 2});
  h.attestations.set(scan.logs[0].attestationUid, {attestationUid: scan.logs[0].attestationUid, schemaUid: SCHEMA_UID, identity: startIdentity, chainTimestamp: 100});
  h.attestations.set(scan.logs[1].attestationUid, {attestationUid: scan.logs[1].attestationUid, schemaUid: SCHEMA_UID, identity: {...startIdentity, configHash: `0x${'a'.repeat(64)}`}, chainTimestamp: 100});
  const registry = make(h); await registry.synchronize(); const registrations = (await registry.status()).registrations;
  assert.equal(registrations.length, 2); assert.ok(registrations.every(registration => registration.conflict));
});

test('concurrent public synchronization shares one persisted sixty-second throttle across restarts', async () => {
  const h = registryFixture(); history(h, {activity: [], starts: 0}); const registry = make(h);
  await Promise.all([registry.synchronize(), registry.synchronize(), registry.synchronize()]); const count = h.calls.length;
  await make(h).synchronize(); assert.equal(h.calls.length, count);
  h.setTime(61000); await make(h).synchronize(); assert.ok(h.calls.length > count);
});

test('RPC failures retain cached data and progress with exponential backoff up to fifteen minutes', async () => {
  const h = registryFixture(), registry = make(h); history(h, {head: 100, activity: [100]}); await registry.synchronize();
  h.chain.finalizedBlock = async budget => {budget.spend(); h.calls.push('head'); throw new Error('sensitive-rate-limit');};
  for (let index = 0; index < 6; index++) {
    await next(h, registry); const status = await registry.status();
    assert.equal(status.registrations.length, 1); assert.equal(status.synchronization.state, 'failed');
    const expected = Math.min(60000 * 2 ** index, 900000);
    assert.equal(status.synchronization.nextAllowedAtMs - status.synchronization.lastAttemptAtMs, expected);
    const count = h.calls.length; await registry.synchronize(); assert.equal(h.calls.length, count);
  }
  assert.equal(JSON.stringify(h.warnings).includes('sensitive-rate-limit'), false);
});

test('a first block ahead of the finalized head retries a fresh head after the throttle', async () => {
  const h = registryFixture(), scan = history(h, {head: 100, activity: [100]});
  let first = true;
  h.chain.finalizedBlock = async budget => {budget.spend(); h.calls.push('head'); const number = first ? '90' : '100'; first = false; return {number, timestamp: Number(number)};};
  const registry = make(h); await registry.synchronize(); assert.equal((await registry.status()).registrations.length, 0);
  await next(h, registry); assert.equal((await registry.status()).registrations.length, 1); assert.equal(scan.ranges.length, 1);
});

test('a slow background finalized read does not delay signing a scored Start', async () => {
  const h = registryFixture(), registry = make(h); let entered, release;
  const reading = new Promise(resolve => {entered = resolve;});
  const waiting = new Promise(resolve => {release = resolve;});
  h.chain.finalizedBlock = async budget => {budget.spend(); entered(); await waiting; return {number: '1000', timestamp: 1000};};
  const synchronization = registry.synchronize(); await reading;
  const starting = registry.ensureStart(startIdentity);
  await new Promise(resolve => setImmediate(resolve));
  const preparedBeforeHead = h.prepared.length;
  release(); await synchronization; await starting;
  assert.equal(preparedBeforeHead, 1);
});
