import assert from 'node:assert/strict';
import test from 'node:test';
import {RandomService} from '../../server/random-service.mjs';

const binding = {experimentSlug: 'tree-targeting', runId: 'run-1', stream: 'local', opportunityId: 'comparison-1', configHash: 'config-hash', actionId: 'ready-1'};
const ticketId = 'synthetic-ticket-1';

function signedResult(changes = {}) {
  return {
    random: {
      method: 'generateSignedIntegers', n: 1, min: 0, max: 1, replacement: true,
      base: 10, pregeneratedRandomization: null, data: [1], userData: binding,
      ticketData: {ticketId, previousTicketId: null, nextTicketId: null},
      completionTime: '2026-09-24 09:00:00Z', serialNumber: 12,
      hashedApiKey: 'synthetic-hash', license: {type: 'developer'}, ...changes,
    },
    signature: 'synthetic-not-a-provider-signature', advisoryDelay: 0,
  };
}

function provider(handler) {
  const calls = [];
  const warnings = [];
  const service = new RandomService({
    apiKey: 'synthetic-development-key',
    fetcher: async (url, options) => {
      const request = JSON.parse(options.body);
      calls.push({url, ...request});
      const value = await handler(request);
      return {ok: true, json: async () => ({jsonrpc: '2.0', id: request.id, ...value})};
    },
    logger: {warn: (...args) => warnings.push(args)},
  });
  return {service, calls, warnings};
}

test('default transport calls the platform fetch with its global receiver', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async function (_url, options) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    requests += 1;
    const request = JSON.parse(options.body);
    return Response.json({jsonrpc: '2.0', id: request.id, result: [
      {ticketId, previousTicketId: null, nextTicketId: null},
    ]});
  });
  const service = new RandomService({apiKey: 'synthetic-development-key', logger: {warn() {}}});
  assert.deepEqual(await service.createTickets(1), [{ticketId, previousTicketId: null, nextTicketId: null}]);
  assert.equal(requests, 1);
});

test('fresh binary draw binds its ticket and preserves exact signed evidence as pending audit', async () => {
  const result = signedResult();
  const {service, calls} = provider(() => ({result}));
  const evidence = await service.draw(ticketId, binding);
  assert.deepEqual(evidence.result, result);
  assert.equal(evidence.value, 1);
  assert.equal(evidence.verification.status, 'pending');
  assert.equal(calls[0].url, 'https://api.random.org/json-rpc/4/invoke');
  assert.deepEqual(calls[0].params, {
    apiKey: 'synthetic-development-key', n: 1, min: 0, max: 1,
    replacement: true, base: 10, pregeneratedRandomization: null, ticketId, userData: binding,
  });
  assert.equal(calls[0].id, binding.actionId);
  assert.equal(JSON.stringify(evidence).includes('synthetic-development-key'), false);
});

test('ticket creation uses private independent tickets in provider batches of at most fifty', async () => {
  let sequence = 0;
  const {service, calls} = provider(request => ({result: Array.from({length: request.params.n}, () => ({
    ticketId: `synthetic-${++sequence}`, creationTime: '2026-09-24 09:00:00Z', previousTicketId: null, nextTicketId: null,
  }))}));
  assert.equal((await service.createTickets(53)).length, 53);
  assert.deepEqual(calls.map(call => call.params.n), [50, 3]);
  assert.ok(calls.every(call => call.method === 'createTickets' && call.params.showResult === false));
  await assert.rejects(service.createTickets(0));
});

test('wrong bindings and non-fresh or non-binary signed results cannot issue a cue value', async () => {
  const changes = [
    {method: 'generateIntegers'}, {min: 1}, {max: 2}, {n: 2}, {replacement: false},
    {base: 2}, {pregeneratedRandomization: {date: '2026-09-24'}}, {data: [2]}, {data: [0, 1]},
    {ticketData: {ticketId: 'another-ticket'}},
    ...['experimentSlug', 'runId', 'stream', 'opportunityId', 'configHash', 'actionId'].map(key => ({userData: {...binding, [key]: 'wrong'}})),
  ];
  for (const change of changes) {
    const {service, calls} = provider(() => ({result: signedResult(change)}));
    await assert.rejects(service.draw(ticketId, binding), {code: 'provider_result_mismatch'});
    assert.equal(calls.length, 1);
  }
});

test('foreign experiment input is rejected before any provider call', async () => {
  const {service, calls} = provider(() => ({result: signedResult()}));
  await assert.rejects(service.draw(ticketId, {...binding, experimentSlug: 'another-experiment'}), {code: 'experiment_mismatch'});
  assert.equal(calls.length, 0);
});

test('lost and consumed-ticket responses recover the same serial without a second draw', async () => {
  for (const failure of ['lost', 'used']) {
    const {service, calls, warnings} = provider(request => {
      if (request.method === 'generateSignedIntegers') {
        if (failure === 'lost') throw new Error('synthetic transport loss');
        return {error: {code: 422, message: 'already used'}};
      }
      if (request.method === 'getTicket') return {result: {ticketId, showResult: false, serialNumber: 12, usedTime: '2026-09-24 09:00:00Z'}};
      assert.equal(request.params.serialNumber, 12);
      return {result: signedResult()};
    });
    const recovered = await service.draw(ticketId, binding);
    assert.equal(recovered.value, 1);
    assert.equal(recovered.recovered, true);
    assert.deepEqual(calls.map(call => call.method), ['generateSignedIntegers', 'getTicket', 'getResult']);
    assert.deepEqual(calls[1].params, {ticketId});
    assert.equal(warnings.length, 1);
  }
});

test('uncertain unused or expired recovery stops with a reason and never replaces the ticket', async () => {
  const {service, calls, warnings} = provider(request => {
    if (request.method === 'generateSignedIntegers') throw new Error('synthetic transport loss');
    return {result: {ticketId, showResult: false, serialNumber: null, usedTime: null}};
  });
  await assert.rejects(service.draw(ticketId, binding), {code: 'provider_recovery_pending'});
  assert.deepEqual(calls.map(call => call.method), ['generateSignedIntegers', 'getTicket']);
  assert.equal(warnings.length, 1);
});

test('recovery after service recreation validates the original durable binding', async () => {
  const {service} = provider(request => request.method === 'getTicket'
    ? {result: {ticketId, showResult: false, serialNumber: 12, usedTime: '2026-09-24 09:00:00Z'}}
    : {result: signedResult({userData: {...binding, runId: 'another-run'}})});
  await assert.rejects(service.recover(ticketId, binding), {code: 'provider_result_mismatch'});
});

test('provider advisory delay serializes subsequent calls', async () => {
  let now = 0;
  const callTimes = [];
  const waits = [];
  const service = new RandomService({
    apiKey: 'synthetic-development-key', now: () => now,
    sleep: async delay => { waits.push(delay); now += delay; },
    fetcher: async (_url, options) => {
      callTimes.push(now);
      const request = JSON.parse(options.body);
      return {ok: true, json: async () => ({jsonrpc: '2.0', id: request.id, result: {...signedResult(), advisoryDelay: 250}})};
    },
  });
  await Promise.all([service.draw(ticketId, binding), service.draw(ticketId, binding)]);
  assert.deepEqual(callTimes, [0, 250]);
  assert.deepEqual(waits, [250]);
});

test('audit retains verifySignature response and distinguishes invalid and unavailable verification', async () => {
  for (const authenticity of [true, false]) {
    const {service, calls} = provider(() => ({result: {authenticity}}));
    const audit = await service.verifySignature(signedResult(), ticketId, binding);
    assert.equal(audit.status, authenticity ? 'verified' : 'invalid');
    assert.equal(audit.response.result.authenticity, authenticity);
    assert.deepEqual(calls[0].params, {random: signedResult().random, signature: signedResult().signature});
  }
  const {service, warnings} = provider(() => { throw new Error('offline'); });
  assert.equal((await service.verifySignature(signedResult(), ticketId, binding)).status, 'pending');
  assert.equal(warnings.length, 1);
});
