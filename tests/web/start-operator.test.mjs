import test from 'node:test';
import assert from 'node:assert/strict';
import {startIssueFromFields, startStreamFromFields, createHostedActionSender} from '../../web/app.mjs';
import {createActionRunner, operatorModel} from '../../web/operator-model.mjs';
import {renderPage} from '../../web/views.mjs';
import {createStartRegistry} from '../../server/start-registry.mjs';
import {registryFixture, fixtureHash, startIdentity} from '../server/start-registry-fixtures.mjs';

const fields = {run_id: 'registered-run', category: 'recording_partial', reason: ' First clip missing ', stream_url: 'https://stream.example.test/live'};

test('operator issue fields require a reason, validate HTTPS, and carry explicit saved report references', () => {
  assert.deepEqual(startIssueFromFields(fields), {category: 'recording_partial', reason: 'First clip missing', streamUrl: 'https://stream.example.test/live', previousIssueId: null});
  assert.throws(() => startIssueFromFields({...fields, reason: ' '}), /reason/);
  assert.throws(() => startIssueFromFields({...fields, category: 'correction'}), /saved report/);
  assert.throws(() => startStreamFromFields({...fields, stream_url: 'http://stream.example.test/live'}), /HTTPS/);
  assert.deepEqual(startStreamFromFields(fields), {streamUrl: 'https://stream.example.test/live'});
});

test('pending scored controls offer retained retry and Stop, and confirmed start registrations show protected issue and stream forms', () => {
  const state = {runId: 'registered-run', mode: 'tree', purpose: 'scored', lifecycle: 'prepared', connected: true, recordingReady: true, testAudioPlayed: true, playbackDeviceId: 'phone', startRegistration: {status: 'pending'}};
  const model = operatorModel(state);
  assert.equal(model.actions.stop.enabled, true);
  let html = renderPage('tree', {model, state, busy: false});
  assert.match(html, /Retry saved Start/); assert.match(html, /Stop and retain run/); assert.match(html, /registration is pending/i);
  state.startRegistration.status = 'confirmed'; state.startIssues = [{issueId: 'preceding', category: 'recording_partial', reason: '<script>bad</script>', reportedAtMs: 1000}];
  html = renderPage('tree', {model: operatorModel(state), state, busy: false});
  assert.match(html, /Report issue/); assert.match(html, /data-hosted-form="start-issue"/); assert.match(html, /data-hosted-form="start-stream"/);
  assert.match(html, /preserve the run(?:'|&#39;)s start registration/);
  assert.match(html, /&lt;script&gt;bad/); assert.doesNotMatch(html, /<script>/);
});

test('a stopped run with pending registration asks to retain its recording and recover without restarting timing', () => {
  const state = {runId: 'registered-run', mode: 'tree', purpose: 'scored', lifecycle: 'stopped', connected: true, startRegistration: {status: 'pending'}};
  const html = renderPage('tree', {model: operatorModel(state), state, busy: false});
  assert.match(html, /sequence is stopped/i); assert.match(html, /Retain the recording/); assert.match(html, /without restarting timing/);
  assert.doesNotMatch(html, /Keep the camera recording running/);
});

test('uncertain scored registration retains its Start request while cancellation sends a separate recoverable Stop', async () => {
  const calls = [], saved = [];
  const send = createHostedActionSender(async (method, path, body) => {
    calls.push(body);
    if (body.kind === 'start') return {accepted: false, pending: true, registration: {status: 'pending'}, state: {runId: 'registered-run'}};
    return {accepted: true, state: {runId: 'registered-run', lifecycle: 'stopped'}};
  }, 'registered-run');
  let nextId = 0; const runner = createActionRunner(send, () => `action-${++nextId}`, null, pending => saved.push(pending));
  await assert.rejects(runner.run('start', {clientAtMs: 1000}), error => error.pendingRegistration === true && error.receipt.state.runId === 'registered-run');
  assert.equal((await runner.run('stop', {clientAtMs: 2000})).accepted, true);
  assert.equal(runner.pending().action, 'start'); assert.equal(calls.length, 2); assert.notEqual(calls[0].actionId, calls[1].actionId);
  await assert.rejects(runner.retry()); assert.equal(calls[2].actionId, calls[0].actionId);
  assert.ok(saved.length > 0);
});

test('recovering a canceled Start acknowledges the registration while preserving rejected timing and clearing retained retry', async () => {
  const calls = []; let confirmed = false;
  const send = createHostedActionSender(async (_method, _path, body) => {
    calls.push(body);
    if (body.kind === 'stop') return {accepted: true, state: {runId: 'registered-run', lifecycle: 'stopped'}};
    return {accepted: false, pending: !confirmed, registration: {status: confirmed ? 'confirmed' : 'pending'}, state: {runId: 'registered-run', lifecycle: 'stopped', completedCount: 0}};
  }, 'registered-run');
  let nextId = 0; const runner = createActionRunner(send, () => `action-${++nextId}`);
  await assert.rejects(runner.run('start', {clientAtMs: 1000}), error => error.pendingRegistration === true);
  await runner.run('stop', {clientAtMs: 2000}); confirmed = true;
  const receipt = await runner.retry();
  assert.equal(receipt.accepted, false); assert.equal(receipt.state.lifecycle, 'stopped'); assert.equal(receipt.state.completedCount, 0);
  assert.match(receipt.notice, /registration recovered/i); assert.match(receipt.notice, /sequence remains stopped/i);
  assert.equal(runner.pending(), null); assert.equal(calls[2].actionId, calls[0].actionId);
  await assert.rejects(send('arrived', {clientAtMs: 3000}, 'other-action'), /rejected/);
});

test('operator form reports independent problems and can resolve an older problem without reopening it through a correction', async () => {
  const h = registryFixture(), registry = createStartRegistry(h.options);
  await registry.ensureStart(startIdentity); h.receipts.set(fixtureHash(1), h.confirmed(fixtureHash(1))); await registry.ensureStart(startIdentity);
  async function formFields() {
    const registration = (await registry.status()).registrations[0];
    const state = {runId: startIdentity.runId, mode: 'tree', purpose: 'scored', lifecycle: 'completed', connected: true,
      startRegistration: {status: 'confirmed'}, startIssues: registration.issues};
    const html = renderPage('tree', {model: operatorModel(state), state, busy: false});
    const form = /<form data-hosted-form="start-issue">([\s\S]*?)<\/form>/.exec(html)[1];
    const fields = Object.fromEntries([...form.matchAll(/<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"/g)].map(([, name, value]) => [name, value]));
    for (const [, name, options] of form.matchAll(/<select[^>]+name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      fields[name] = /<option value="([^"]*)"[^>]* selected/.exec(options)?.[1] ?? /<option value="([^"]*)"/.exec(options)?.[1] ?? '';
    }
    return fields;
  }
  const send = async fields => registry.reportIssue({runId: startIdentity.runId, ...startIssueFromFields(fields)});
  const recording = await send({...await formFields(), category: 'recording_unavailable', reason: 'Camera original missing'});
  const analysis = await send({...await formFields(), category: 'analysis_failed', reason: 'Analysis stopped'});
  let data = (await registry.status()).registrations[0].data;
  assert.deepEqual(data.reportedStates, ['recording_unavailable', 'analysis_failed']);
  assert.notEqual(recording.rootIssueId, analysis.rootIssueId);
  const resolution = await send({...await formFields(), category: 'resolved', previous_issue_id: recording.issueId, reason: 'Original recovered'});
  assert.deepEqual((await registry.status()).registrations[0].data.reportedStates, ['analysis_failed']);
  await send({...await formFields(), category: 'correction', previous_issue_id: resolution.issueId, reason: 'Original recovered from backup'});
  assert.deepEqual((await registry.status()).registrations[0].data.reportedStates, ['analysis_failed']);
  await send({...await formFields(), category: 'resolved', previous_issue_id: analysis.issueId, reason: 'Analysis completed'});
  assert.deepEqual((await registry.status()).registrations[0].data.reportedStates, []);
});
