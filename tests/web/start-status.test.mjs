import test from 'node:test';
import assert from 'node:assert/strict';
import {renderStartStatus, updateStartStatus, createStatusPoll} from '../../web/start-status.mjs';

const status = {registry: {state: 'configured', network: 'Base Sepolia', signerAddress: '0x1234', fromBlock: '100', schemaUid: '0xabcd', explorerUrl: 'https://sepolia.basescan.org', signerUrl: 'https://sepolia.basescan.org/address/0x1234', contractUrl: 'https://sepolia.basescan.org/address/0x4321'}, synchronization: {state: 'catching_up', indexedBlock: '1234', indexedAtMs: 1000, caughtUp: false}, latestPublicationId: null, registrations: [{runId: 'zero-target-run', seriesId: 'series', transactionHash: '0xabcd', attestationUid: '0x1111', blockNumber: '1200', chainTimestamp: 1000, confirmation: 'sealed', execution: {state: 'interrupted', finishedAtMs: 2000, reason: 'Stopped before first target'}, data: {state: 'recording_partial', publications: []}, issues: [{issueId: 'issue', category: 'recording_partial', reason: '<script>unsafe</script>', reportedAtMs: 2000}], streamUrl: 'https://stream.example.test/?a=1&b=2'}]};

test('registered runs render independently of publications with safe issue text and optional stream links', () => {
  const html = renderStartStatus(status);
  assert.match(html, /Registered runs/); assert.match(html, /zero-target-run/); assert.match(html, /Interrupted/);
  assert.match(html, /Run and start registration/); assert.match(html, /Live inventory of registered runs/);
  assert.match(html, /Start registration<\/|Start registration ·/);
  assert.doesNotMatch(html, /Registered attempts|Attempt and registration|scored attempts/);
  assert.match(html, /Partial recording reported/); assert.match(html, /Stopped before first target/);
  assert.match(html, /&lt;script&gt;unsafe/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /stream.example.test\/\?a=1&amp;b=2/); assert.match(html, /Indexed through block/);
  assert.match(html, /Catching up/); assert.match(html, /Sealed start registration/);
});

test('empty, unconfigured, catching-up and failed states remain distinct and stale data remains readable', () => {
  assert.match(renderStartStatus({registry: {state: 'unconfigured'}, synchronization: {state: 'unconfigured'}, registrations: []}), /has not been configured/);
  assert.match(renderStartStatus({...status, registrations: [], synchronization: {state: 'current', caughtUp: true}}), /No registered scored runs/);
  assert.match(renderStartStatus({...status, synchronization: {state: 'failed', error: {message: 'RPC unavailable'}}}), /RPC unavailable/);
  assert.match(renderStartStatus(status, {error: 'Status request failed'}), /cached|retained/i);
  assert.match(renderStartStatus(status, {error: 'Status request failed'}), /zero-target-run/);
});

test('unavailable registry configuration keeps already retained registrations and the visible failure readable', () => {
  const html = renderStartStatus({...status, registry: {...status.registry, state: 'unconfigured'}, synchronization: {state: 'failed', error: {message: 'Configured signer unavailable'}}});
  assert.match(html, /has not been configured/); assert.match(html, /Configured signer unavailable/); assert.match(html, /zero-target-run/);
});

test('malicious URLs are omitted while publication identity and receipt issues remain visible', () => {
  const value = structuredClone(status); value.registry.signerUrl = 'javascript:alert(1)'; value.registrations[0].streamUrl = 'javascript:alert(1)';
  value.registrations[0].confirmation = 'receipt_issue'; value.registrations[0].registryIssue = {message: 'Receipt missing at finalized boundary'};
  value.registrations[0].data.publications = [{publicationId: 'retained-publication', analysisPublished: true, url: 'https://example.test/data?publication=retained-publication'}];
  const html = renderStartStatus(value); assert.doesNotMatch(html, /javascript:/); assert.match(html, /Receipt missing/); assert.match(html, /retained-publication/);
});

test('completed execution and published data have separate labels and publication links retain the run revision', () => {
  const value = structuredClone(status), publicationId = 'd116a284-721f-4c75-8cf5-af88cbb0492a';
  value.registrations[0].execution = {state: 'completed'};
  value.registrations[0].data = {state: 'published', publications: [{publicationId, analysisPublished: true,
    url: `/studies/tree-targeting/public/recordings/zero-target-run?publication=${publicationId}`}]};
  const html = renderStartStatus(value);
  assert.match(html, /<td><p>Completed<\/p>/);
  assert.doesNotMatch(html, /Completed; data awaiting publication/);
  assert.match(html, new RegExp(`href="/studies/targeted-vegetation-movement/public/recordings/zero-target-run\\?publication=${publicationId}"[^>]*>Published material</a>`));
  assert.match(html, new RegExp(`<p class="recording-id">${publicationId}</p>`));
});

test('live inventory refresh preserves open disclosures and the matching focused control by attestation identity', () => {
  const document = {activeElement: null}; let disclosures = [], controls = [], markup = '';
  const container = {contains: element => controls.includes(element), querySelectorAll: selector => selector === '[data-start-details]' ? disclosures : controls};
  Object.defineProperty(container, 'innerHTML', {get: () => markup, set: value => {
    if (container.contains(document.activeElement)) document.activeElement = null;
    markup = value;
    disclosures = [...value.matchAll(/<details[^>]+data-start-details="([^"]+)"/g)].map(([, key]) => ({dataset: {startDetails: key}, open: false}));
    controls = [...value.matchAll(/<(?:summary|a)[^>]+data-start-focus="([^"]+)"/g)].map(([, key]) => ({dataset: {startFocus: key}, focus(options) {this.focusOptions = options; document.activeElement = this;}}));
  }});
  updateStartStatus(container, status, {document});
  for (const disclosure of disclosures) disclosure.open = true;
  const focused = controls.find(control => control.dataset.startFocus.endsWith(':identity')); focused.focus();
  const next = structuredClone(status); next.registrations[0].execution.state = 'in_progress';
  updateStartStatus(container, next, {document});
  assert.match(container.innerHTML, /In progress/); assert.ok(disclosures.length >= 3); assert.ok(disclosures.every(disclosure => disclosure.open));
  assert.notEqual(document.activeElement, focused); assert.equal(document.activeElement.dataset.startFocus, focused.dataset.startFocus);
  assert.deepEqual(document.activeElement.focusOptions, {preventScroll: true});
  updateStartStatus(container, {...next, registrations: []}, {document});
  assert.equal(document.activeElement, null); assert.equal(disclosures[0].open, true);
});

function pollHarness() {
  const listeners = new Map(), timers = new Map(), requests = [], delivered = [], errors = [];
  const document = {hidden: false, addEventListener: (event, callback) => listeners.set(event, callback), removeEventListener: event => listeners.delete(event)};
  const window = {setInterval(callback, delay) {timers.set(1, {callback, delay}); return 1;}, clearInterval: id => timers.delete(id)};
  let respond = async () => status;
  const poll = createStatusPoll({document, window, read: async () => {requests.push('status'); return respond();}, onStatus: value => delivered.push(value), onError: error => errors.push(error)});
  return {poll, document, listeners, timers, requests, delivered, errors, respond: value => {respond = value;}};
}

test('one visibility-aware timer prevents overlapping reads and disposes its listener', async () => {
  const h = pollHarness(); assert.equal(h.timers.size, 1); assert.equal(h.timers.get(1).delay, 60000);
  let release; h.respond(() => new Promise(resolve => {release = resolve;}));
  const first = h.poll.refresh(); const overlapping = h.timers.get(1).callback();
  assert.equal(h.requests.length, 1); release(status); await first; await overlapping; assert.equal(h.delivered.length, 1);
  h.document.hidden = true; await h.timers.get(1).callback(); assert.equal(h.requests.length, 1);
  h.respond(async () => status); h.document.hidden = false; await h.listeners.get('visibilitychange')(); assert.equal(h.requests.length, 2);
  h.poll.dispose(); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
});

test('failed and late disposed reads do not erase the cached status', async () => {
  const h = pollHarness(); await h.poll.refresh(); h.respond(async () => {throw new Error('RPC unavailable');}); await h.poll.refresh();
  assert.equal(h.delivered.length, 1); assert.equal(h.errors.length, 1);
  let release; h.respond(() => new Promise(resolve => {release = resolve;})); const pending = h.poll.refresh(); h.poll.dispose(); release(status); await pending;
  assert.equal(h.delivered.length, 1);
});
