import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {SessionStore} from '../../server/session-store.mjs';
import {RandomService} from '../../server/random-service.mjs';

// This storage double models atomic transactions and process recreation, not run logic.
class MemoryStorage {
  values = new Map();
  queue = Promise.resolve();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
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

async function setup(experimentSlug = 'tree-targeting', storage = new MemoryStorage()) {
  const store = new SessionStore({storage, experimentSlug});
  const run = await store.createRun({
    experimentSlug, runId: 'run-1', config: {experimentSlug, mode: 'tree', purpose: 'preparation'},
    profile: {id: 'development-1'}, codeCheckpoint: 'synthetic-checkpoint',
    state: {lifecycle: 'running'},
    tickets: [1, 2].map(index => ({ticketId: `${experimentSlug}-ticket-${index}`, stream: 'tree', opportunityId: `trial-${index}`, rules: {0: 'A', 1: 'B'}})),
  });
  const binding = {experimentSlug, runId: run.runId, stream: 'tree', opportunityId: 'trial-1', configHash: run.configHash};
  return {store, storage, run, binding};
}

function resultFor(reservation) {
  return {
    random: {
      method: 'generateSignedIntegers', n: 1, min: 0, max: 1, replacement: true,
      base: 10, pregeneratedRandomization: null, data: [1], userData: reservation.binding,
      ticketData: {ticketId: reservation.ticketId}, completionTime: '2026-09-24 09:00:00Z',
      serialNumber: 42, hashedApiKey: 'synthetic-hash',
    }, signature: 'synthetic-not-a-provider-signature',
  };
}

test('concurrent duplicate actions reserve one durable ticket and replay the completed receipt', async () => {
  const {store, storage, binding} = await setup();
  const reopened = new SessionStore({storage, experimentSlug: 'tree-targeting'});
  const requests = Array.from({length: 8}, (_, index) => (index % 2 ? store : reopened).reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding}));
  const reservations = await Promise.all(requests);
  assert.equal(new Set(reservations.map(value => value.ticketId)).size, 1);
  assert.equal(reservations.filter(value => value.shouldDraw).length, 1);
  assert.equal((await reopened.readRun('run-1')).tickets.filter(value => value.status === 'reserved').length, 1);
  const receipt = {accepted: true, actionId: 'ready-1'};
  await store.completeAction('run-1', 'ready-1', {receipt, providerResult: resultFor(reservations[0]), serverAtMs: 123});
  assert.deepEqual((await reopened.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding})).receipt, receipt);
  await assert.rejects(store.reserveAction('run-1', 'ready-1', {kind: 'stop'}, {binding}), {code: 'action_conflict'});
});

test('different Ready IDs for the same opportunity never allocate a second ticket', async () => {
  const {store, binding} = await setup();
  const reservations = await Promise.all(['ready-1', 'ready-2'].map(actionId => store.reserveAction('run-1', actionId, {kind: 'ready'}, {binding})));
  assert.equal(reservations[0].ticketId, reservations[1].ticketId);
  assert.equal(reservations.filter(value => value.shouldDraw).length, 1);
  assert.deepEqual(reservations[1].binding, reservations[0].binding);
});

test('canonical payload equality is independent of object property ordering', async () => {
  const {store} = await setup();
  await store.reserveAction('run-1', 'clock-1', {kind: 'clock', data: {a: 1, b: 2}});
  assert.equal((await store.reserveAction('run-1', 'clock-1', {data: {b: 2, a: 1}, kind: 'clock'})).replay, true);
});

test('a failed delivery retains the issued result and forbids replacement', async () => {
  const {store, binding} = await setup();
  const reserved = await store.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding});
  const result = resultFor(reserved);
  await store.completeAction('run-1', 'ready-1', {providerResult: result, receipt: {accepted: true}, serverAtMs: 100});
  await store.appendEvent('run-1', {kind: 'failed', serverAtMs: 200, actionId: 'delivery-1', actor: 'server', data: {reason: 'cue_failed'}});
  const bundle = await store.exportRun('run-1');
  assert.deepEqual(bundle.tickets[0].result, result);
  assert.equal(bundle.tickets[1].status, 'unused');
  await assert.rejects(store.completeAction('run-1', 'ready-1', {providerResult: {...result, signature: 'replacement'}, receipt: {accepted: true}, serverAtMs: 300}), {code: 'assignment_conflict'});
  assert.equal(bundle.events[0].sequence, 1);
  assert.equal(bundle.events[1].sequence, 2);
});

test('first terminal transition retains its time through later run updates', async () => {
  for (const lifecycle of ['completed', 'stopped', 'failed']) {
    const {store, run} = await setup();
    const eventKind = lifecycle === 'completed' ? 'deadlineReached' : lifecycle === 'stopped' ? 'stop' : 'failed';
    await store.reserveAction('run-1', 'finish-1', {kind: eventKind});
    await store.completeAction('run-1', 'finish-1', {
      state: {...run.state, lifecycle}, serverAtMs: 250,
      events: [{kind: eventKind, serverAtMs: 200, actor: 'operator'}],
      receipt: {actionId: 'finish-1', accepted: lifecycle !== 'failed'},
    });
    assert.equal((await store.readRun('run-1')).state.finishedAtMs, 200, lifecycle);
    await store.appendEvent('run-1', {kind: 'saveClockReference', serverAtMs: 300, actor: 'operator'});
    assert.equal((await store.readRun('run-1')).state.finishedAtMs, 200, lifecycle);
  }
});

test('signature verification retains the provider response and creates a new terminal export revision', async () => {
  const {store, binding} = await setup();
  const reserved = await store.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding});
  await store.completeAction('run-1', 'ready-1', {
    providerResult: resultFor(reserved), receipt: {accepted: true}, serverAtMs: 100,
  });
  await store.appendEvent('run-1', {kind: 'stop', serverAtMs: 200});
  const before = await store.exportRun('run-1');
  assert.equal(before.tickets[0].verification.status, 'pending');
  const verification = {status: 'verified', response: {jsonrpc: '2.0', id: 'verify-1',
    result: {authenticity: true, source: 'synthetic-test-response'}}};
  await store.recordVerification('run-1', reserved.ticketId, verification, 300);
  const after = await store.exportRun('run-1');
  assert.equal(after.bundleRevision, before.bundleRevision + 1);
  assert.deepEqual(after.tickets[0].verification, verification);
  assert.deepEqual(after.tickets[0].result, resultFor(reserved));
  assert.equal(after.events.at(-1).kind, 'signatureVerification');
  await store.recordVerification('run-1', reserved.ticketId, verification, 301);
  assert.deepEqual(await store.exportRun('run-1'), after);
  await assert.rejects(store.recordVerification('run-1', reserved.ticketId,
    {status: 'invalid', response: {result: {authenticity: false}}}, 302), {code: 'verification_conflict'});
});

test('a result arriving after Stop is retained in a new immutable revision without delivery or restart', async () => {
  const {store, storage, binding} = await setup();
  const reservation = await store.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding});
  await store.appendEvent('run-1', {kind: 'stop', serverAtMs: 10, actionId: 'stop-1', actor: 'operator'});
  const before = await store.exportRun('run-1');
  const completion = await store.completeAction('run-1', 'ready-1', {providerResult: resultFor(reservation), state: {lifecycle: 'running'}, receipt: {accepted: true}, serverAtMs: 20});
  assert.equal(completion.allowDelivery, false);
  assert.equal((await store.readRun('run-1')).state.lifecycle, 'stopped');
  const after = await store.exportRun('run-1');
  assert.equal(after.bundleRevision, before.bundleRevision + 1);
  assert.equal(before.tickets[0].result, undefined);
  assert.deepEqual(after.tickets[0].result, resultFor(reservation));
  const reopened = new SessionStore({storage, experimentSlug: 'tree-targeting'});
  assert.deepEqual(await reopened.exportRun('run-1', before.bundleRevision), before);
  assert.deepEqual(await reopened.exportRun('run-1'), after);
});

test('full active exports are refused and public ticket manifests reveal only fixed mappings', async () => {
  const {store, binding} = await setup();
  const reservation = await store.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding});
  await store.completeAction('run-1', 'ready-1', {providerResult: resultFor(reservation), receipt: {accepted: true}, serverAtMs: 10});
  await assert.rejects(store.exportRun('run-1'), {code: 'run_not_terminal'});
  const manifest = await store.ticketManifest('run-1');
  assert.equal(manifest.experimentSlug, 'tree-targeting');
  assert.equal(manifest.tickets.length, 2);
  assert.deepEqual(Object.keys(manifest.tickets[0]).sort(), ['binding', 'rules', 'ticketId']);
  assert.equal(JSON.stringify(manifest).includes('signature'), false);
  assert.equal(JSON.stringify(manifest).includes('serialNumber'), false);
  assert.equal(JSON.stringify(manifest).includes('data'), false);
});

test('separate experiments retain isolated runs, actions, histories and tickets with matching identifiers', async () => {
  const storage = new MemoryStorage();
  const a = await setup('tree-targeting', storage);
  const b = await setup('synthetic-other', storage);
  await a.store.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding: a.binding});
  await b.store.reserveAction('run-1', 'ready-1', {kind: 'stop'});
  await a.store.appendEvent('run-1', {kind: 'stop', serverAtMs: 10, actor: 'operator', actionId: 'stop-1'});
  assert.equal((await b.store.readRun('run-1')).events.length, 0);
  assert.equal((await b.store.readRun('run-1')).tickets[0].status, 'unused');
  assert.equal((await a.store.readRun('run-1')).tickets[0].status, 'reserved');
  assert.throws(() => { a.store.experimentSlug = 'synthetic-other'; }, TypeError);
});

test('foreign slug payloads are rejected without mutating any records', async () => {
  const {store, storage, binding} = await setup();
  const before = structuredClone(storage.values);
  await assert.rejects(store.reserveAction('run-1', 'ready-1', {experimentSlug: 'foreign', kind: 'ready'}, {binding}), {code: 'experiment_mismatch'});
  await assert.rejects(store.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding: {...binding, experimentSlug: 'foreign'}}), {code: 'experiment_mismatch'});
  await assert.rejects(store.appendEvent('run-1', {experimentSlug: 'foreign', kind: 'stop', serverAtMs: 1}), {code: 'experiment_mismatch'});
  assert.deepEqual(storage.values, before);
});

test('sealed UTF-8 configuration and profile hashes and export revisions survive caller mutation', async () => {
  const {store, run} = await setup();
  run.config.mode = 'changed';
  await store.appendEvent('run-1', {kind: 'stop', serverAtMs: 10, actionId: 'stop-1', actor: 'operator'});
  const bundle = await store.exportRun('run-1');
  assert.equal(bundle.configHash, createHash('sha256').update(bundle.sealedConfigJson).digest('hex'));
  assert.equal(bundle.profileHash, createHash('sha256').update(bundle.sealedProfileJson).digest('hex'));
  assert.equal(bundle.config.mode, 'tree');
  const {hash, ...content} = bundle;
  assert.equal(hash, createHash('sha256').update(JSON.stringify(content)).digest('hex'));
  await store.appendEvent('run-1', {kind: 'saveClockReference', serverAtMs: 20, actionId: 'clock-1', actor: 'operator', data: {offsetMs: 20}});
  const later = await store.exportRun('run-1');
  assert.equal(later.bundleRevision, bundle.bundleRevision + 1);
  assert.equal(later.clockReferences.length, 1);
  assert.notEqual(later.hash, bundle.hash);
});

test('an uncertain provider request remains reserved on a visibly failed attempt', async () => {
  const {store, storage, binding} = await setup();
  const reservation = await store.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding});
  await store.completeAction('run-1', 'ready-1', {failure: {code: 'provider_recovery_pending', message: 'Same ticket has no recoverable result.'}, serverAtMs: 10, receipt: {accepted: false}});
  const reopened = new SessionStore({storage, experimentSlug: 'tree-targeting'});
  const run = await reopened.readRun('run-1');
  assert.equal(run.state.lifecycle, 'failed');
  assert.equal(run.state.lastError.code, 'provider_recovery_pending');
  assert.equal(run.tickets[0].ticketId, reservation.ticketId);
  assert.equal(run.tickets[0].status, 'reserved');
  assert.equal((await reopened.exportRun('run-1')).actions.length, 1);
});

test('Tree reservation is durable before transport and result is saved before delivery', async () => {
  const {store, storage, binding} = await setup();
  const reservation = await store.reserveAction('run-1', 'ready-1', {kind: 'ready'}, {binding});
  const reopened = new SessionStore({storage, experimentSlug: 'tree-targeting'});
  const service = new RandomService({apiKey: 'synthetic-development-key', fetcher: async (_url, options) => {
    const request = JSON.parse(options.body);
    const run = await reopened.readRun('run-1');
    assert.equal(run.tickets[0].status, 'reserved');
    assert.equal(run.tickets[0].ticketId, request.params.ticketId);
    assert.deepEqual(run.tickets[0].binding, request.params.userData);
    return {ok: true, json: async () => ({jsonrpc: '2.0', id: request.id, result: resultFor(reservation)})};
  }});
  const evidence = await service.draw(reservation.ticketId, reservation.binding);
  const completed = await store.completeAction('run-1', 'ready-1', {providerResult: evidence.result, serverAtMs: 10});
  assert.equal(completed.allowDelivery, true);
  assert.deepEqual((await reopened.readRun('run-1')).tickets[0].result, evidence.result);
});

test('draft configuration can change before preparation attaches a frozen ordered ticket manifest', async () => {
  const storage = new MemoryStorage();
  const store = new SessionStore({storage, experimentSlug: 'tree-targeting'});
  const config = {experimentSlug: 'tree-targeting', mode: 'tree', purpose: 'preparation', tree: {count: 2}};
  const created = await store.createRun({runId: 'run-draft', config});
  await store.reserveAction('run-draft', 'config-1', {kind: 'configure'});
  const changed = {...config, tree: {count: 3}};
  await store.completeAction('run-draft', 'config-1', {state: {lifecycle: 'draft', config: changed}});
  const configured = await store.readRun('run-draft');
  assert.notEqual(configured.configHash, created.configHash);
  assert.deepEqual(JSON.parse(configured.sealedConfigJson), changed);
  const tickets = [{ticketId: 'draft-ticket-1', stream: 'tree', opportunityId: 'trial-1', rules: {0: 'A', 1: 'B'}}];
  await store.attachTickets('run-draft', tickets);
  await store.attachTickets('run-draft', tickets);
  assert.equal((await store.ticketManifest('run-draft')).tickets[0].binding.configHash, configured.configHash);
  await assert.rejects(store.attachTickets('run-draft', [{...tickets[0], ticketId: 'replacement'}]), {code: 'ticket_manifest_frozen'});
  await store.reserveAction('run-draft', 'config-2', {kind: 'configure'});
  await assert.rejects(store.completeAction('run-draft', 'config-2', {state: {lifecycle: 'draft', config}}), {code: 'config_immutable'});
  await store.reserveAction('run-draft', 'prepare-1', {kind: 'prepare'});
  await store.completeAction('run-draft', 'prepare-1', {state: {lifecycle: 'prepared', config: changed}});
  await store.reserveAction('run-draft', 'config-3', {kind: 'configure'});
  await assert.rejects(store.completeAction('run-draft', 'config-3', {state: {lifecycle: 'draft', config}}), {code: 'config_immutable'});
});

test('run history survives reopening and remains experiment scoped', async () => {
  const storage = new MemoryStorage();
  const {store} = await setup('tree-targeting', storage);
  await setup('synthetic-other', storage);
  const reopened = new SessionStore({storage, experimentSlug: 'tree-targeting'});
  const listed = await reopened.listRuns();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].experimentSlug, 'tree-targeting');
  assert.deepEqual(listed[0], await store.readRun('run-1'));
});

test('ticket identities cannot be reused across runs and nested foreign records never mutate storage', async () => {
  const {store, storage} = await setup();
  const before = structuredClone(storage.values);
  await assert.rejects(store.createRun({runId: 'run-2', config: {experimentSlug: 'tree-targeting'}, tickets: [{ticketId: 'tree-targeting-ticket-1', stream: 'tree', opportunityId: 'trial-1'}]}), {code: 'ticket_binding_conflict'});
  await assert.rejects(store.reserveAction('run-1', 'config-1', {kind: 'configure', config: {experimentSlug: 'foreign'}}), {code: 'experiment_mismatch'});
  assert.deepEqual(storage.values, before);
});

test('prepared configuration cannot be reopened as a draft and exported ticket metadata is retained', async () => {
  const storage = new MemoryStorage();
  const store = new SessionStore({storage, experimentSlug: 'tree-targeting'});
  await store.createRun({runId: 'prepared-1', config: {experimentSlug: 'tree-targeting'}, state: {lifecycle: 'prepared'}});
  await store.reserveAction('prepared-1', 'reopen-1', {kind: 'configure'});
  await assert.rejects(store.completeAction('prepared-1', 'reopen-1', {state: {lifecycle: 'draft'}}), {code: 'invalid_lifecycle'});
  const providerTicket = {ticketId: 'unused-1', creationTime: '2026-09-24 09:00:00Z', previousTicketId: null, nextTicketId: null};
  await store.attachTickets('prepared-1', [{...providerTicket, stream: 'tree', opportunityId: 'trial-1'}]);
  await store.appendEvent('prepared-1', {kind: 'stop', serverAtMs: 10});
  assert.deepEqual((await store.exportRun('prepared-1')).tickets[0].providerTicket, providerTicket);
});

test('terminal bundles expose retained cue records from the last controller state', async () => {
  const {store} = await setup();
  const cues = [{cueId: 'cue-1', trialId: 'trial-1', text: 'B', dueAtMs: 10, issuedAtMs: 10, playedAtMs: 20, status: 'played'}];
  await store.reserveAction('run-1', 'cue-1', {kind: 'cuePlayed'});
  await store.completeAction('run-1', 'cue-1', {state: {lifecycle: 'running', cues}});
  await store.appendEvent('run-1', {kind: 'stop', serverAtMs: 30});
  assert.deepEqual((await store.exportRun('run-1')).cues, cues);
});

test('ticket freeze rejects contradictory outer and nested stream or opportunity bindings without mutation', async () => {
  for (const field of ['stream', 'opportunityId']) {
    for (const operation of ['create', 'attach']) {
      const storage = new MemoryStorage();
      const store = new SessionStore({storage, experimentSlug: 'tree-targeting'});
      const config = {experimentSlug: 'tree-targeting'};
      if (operation === 'attach') await store.createRun({runId: 'run-1', config});
      const before = structuredClone(storage.values);
      const ticket = {
        ticketId: 'conflicting-ticket', stream: 'tree', opportunityId: 'trial-1',
        binding: {stream: 'tree', opportunityId: 'trial-1', [field]: 'conflicting-value'},
      };
      const freeze = operation === 'create'
        ? () => store.createRun({runId: 'run-1', config, tickets: [ticket]})
        : () => store.attachTickets('run-1', [ticket]);
      await assert.rejects(freeze, {code: 'ticket_binding_conflict'});
      assert.deepEqual(storage.values, before);
    }
  }
});
