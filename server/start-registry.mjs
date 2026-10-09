import {SCHEMA_UID, SCHEMA, EAS_ADDRESS, SCHEMA_REGISTRY_ADDRESS, validateRegistryConfiguration, validateStartIdentity, registryError} from './start-chain.mjs';
import {canonicalJson} from './random-service.mjs';
import {terminalEventTime} from './session-store.mjs';

const queues = new WeakMap();
const synchronizationQueues = new WeakMap();
const SYNC_INTERVAL = 60000;
const MAX_BACKOFF = 900000;
const MAX_RPC = 16;
const MAX_LOGS = 2;
const key = name => `start-registry:${name}`;
const runKey = runId => key(`journal:run:${runId}`);
const attestationKey = uid => key(`attestation:${uid}`);
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const safeError = error => ({code: /^[a-z_]+$/.test(error?.code) ? error.code : 'rpc_unavailable', message: 'Start registration needs recovery; the saved transaction and run are retained.'});
const publicRegistration = record => record ? Object.fromEntries(['attestationUid', 'schemaUid', 'transactionHash', 'nonce', 'blockNumber', 'blockHash', 'chainTimestamp', 'identity', 'registeredAtMs'].filter(name => record[name] != null).map(name => [name, structuredClone(record[name])])) : null;
function serialize(storage, operation, operationQueues = queues) {
  const result = (operationQueues.get(storage) ?? Promise.resolve()).then(operation, operation);
  operationQueues.set(storage, result.then(() => {}, () => {}));
  return result;
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || !URL.canParse(value)) throw registryError('stream_invalid', 'Use a valid HTTPS streaming link.', 400);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw registryError('stream_invalid', 'Use a valid HTTPS streaming link without credentials.', 400);
  return url.href;
}

export function createStartRegistry({storage, chain, configuration, clock = Date.now, logger = console} = {}) {
  if (typeof storage?.transaction !== 'function') throw new Error('The start registry requires transactional storage.');
  const enabled = configuration?.enabled === true;
  if (enabled) configuration = validateRegistryConfiguration(configuration);
  const fingerprint = enabled ? {chainId: configuration.chainId, signerAddress: configuration.signerAddress.toLowerCase(), fromBlock: configuration.fromBlock, schemaUid: SCHEMA_UID} : null;
  const explorer = configuration?.chainId === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org';
  async function checkConfiguration(state = storage) {
    const previous = await state.get(key('configuration'));
    if (previous && !same(previous, fingerprint)) throw registryError('registry_configuration_changed', 'The configured registry differs from its retained chain history.');
    if (!previous) await state.put(key('configuration'), fingerprint);
  }
  async function records() {
    const uids = await storage.get(key('attestations')) ?? [];
    return Promise.all(uids.map(uid => storage.get(attestationKey(uid))));
  }
  async function retainRecord(record, state = storage) {
    const uids = await state.get(key('attestations')) ?? [];
    const prior = await state.get(attestationKey(record.attestationUid));
    if (prior) return prior;
    const others = [];
    for (const uid of uids) {
      const other = await state.get(attestationKey(uid));
      if (other.identity.runId === record.identity.runId) others.push(other);
    }
    const duplicate = others.length > 0;
    const saved = {...record, duplicateRun: duplicate, conflict: others.some(other => !same(other.identity, record.identity))};
    for (const other of others) await state.put(attestationKey(other.attestationUid), {...other, duplicateRun: true, conflict: other.conflict || saved.conflict});
    await state.put(attestationKey(saved.attestationUid), saved);
    await state.put(key('attestations'), [...uids, saved.attestationUid]);
    return saved;
  }
  function result(journal, error = journal.error) {
    return {status: journal.status, registration: publicRegistration(journal.registration), ...(error ? {error} : {})};
  }
  async function recover(journalKey, journal) {
    let receipt;
    try {
      receipt = await chain.receipt(journal.transaction.transactionHash, {kind: journal.transaction.kind});
      if (!receipt) {
        await chain.broadcast(journal.transaction.serializedTransaction);
        receipt = await chain.receipt(journal.transaction.transactionHash, {kind: journal.transaction.kind});
      }
      if (!receipt) return result(journal);
      if (receipt.status === 'confirmed' && journal.identity && !same(receipt.identity, journal.identity)) throw registryError('receipt_inconsistent', 'The receipt payload differs from the fixed run.');
      if (!['confirmed', 'failed'].includes(receipt.status)) throw registryError('receipt_inconsistent', 'The registry receipt state is inconsistent.');
      await storage.transaction(async state => {
        const saved = await state.get(journalKey);
        saved.status = receipt.status;
        saved.error = receipt.status === 'failed' ? {code: 'transaction_reverted', message: 'The registry transaction reverted; the same run may be retried.'} : null;
        saved.transaction.receipt = structuredClone(receipt);
        if (receipt.status === 'confirmed') {
          if (saved.identity) {
            saved.registration = publicRegistration({...receipt, nonce: saved.transaction.nonce, registeredAtMs: clock()});
            await retainRecord({...saved.registration, source: 'receipt', finalizedChecked: false}, state);
          } else await state.put(key('schema'), {verified: true, schemaUid: SCHEMA_UID, transactionHash: receipt.transactionHash});
        }
        const pending = await state.get(key('signer:pending'));
        if (pending?.transactionHash === saved.transaction.transactionHash) await state.put(key('signer:pending'), null);
        await state.put(journalKey, saved); journal = saved;
      });
      return result(journal);
    } catch (error) {
      const issue = safeError(error);
      logger.warn('Start registry receipt recovery is pending; identical signed bytes are retained.', {runId: journal.identity?.runId ?? null, code: issue.code});
      await storage.transaction(async state => {
        const saved = await state.get(journalKey); saved.error = issue; await state.put(journalKey, saved);
      });
      return result(journal, issue);
    }
  }
  async function prepare(journalKey, identity = null) {
    return storage.transaction(async state => {
      const pending = await state.get(key('signer:pending'));
      if (pending) throw registryError('signer_busy', 'The dedicated signer has an unresolved saved transaction.');
      const old = await state.get(journalKey);
      const transaction = {...await chain.prepareTransaction(identity ?? {kind: 'schema'}), preparedAtMs: clock()};
      const journal = {identity, status: 'pending', transaction, previousTransactions: [...(old?.previousTransactions ?? []), ...(old?.transaction ? [old.transaction] : [])], registration: null};
      await state.put(journalKey, journal);
      await state.put(key('signer:pending'), {journalKey, transactionHash: transaction.transactionHash});
      return journal;
    });
  }
  async function ensureStart(input) {
    const identity = validateStartIdentity(input);
    if (!enabled || !chain) return {status: 'failed', registration: null, error: {code: 'registry_unconfigured', message: 'Scored start registration is not configured.'}};
    return serialize(storage, async () => {
      await storage.transaction(checkConfiguration);
      const journalKey = runKey(identity.runId);
      let journal = await storage.get(journalKey);
      if (journal?.identity && !same(journal.identity, identity)) throw registryError('start_identity_conflict', 'The run identity differs from its retained start registration.', 409);
      if (journal?.status === 'confirmed') return result(journal);
      if (journal?.status === 'pending') return recover(journalKey, journal);
      const pending = await storage.get(key('signer:pending'));
      if (pending) {
        const recovery = await recover(pending.journalKey, await storage.get(pending.journalKey));
        if (recovery.status === 'pending') return {status: 'pending', registration: null, error: {code: 'signer_busy', message: 'A saved registry transaction is still pending. Retry this same run.'}};
      }
      try {
        await chain.validateNetwork();
        if (!await chain.schema()) {
          const schemaKey = key('journal:schema');
          const setup = await storage.get(schemaKey);
          const recovery = await recover(schemaKey, setup?.status === 'pending' ? setup : await prepare(schemaKey));
          if (recovery.status !== 'confirmed') return {...recovery, error: recovery.error ?? {code: 'schema_pending', message: 'The fixed start schema is pending. Retry this same run.'}};
        }
        journal = await prepare(journalKey, identity);
        return await recover(journalKey, journal);
      } catch (error) {
        logger.warn('Start registry preparation failed; the run remains stopped.', {runId: identity.runId, code: safeError(error).code});
        return {status: 'failed', registration: null, error: safeError(error)};
      }
    });
  }
  let syncInFlight = null;
  async function syncOnce() {
    if (!enabled || !chain) return status();
    const nowMs = clock();
    let sync = await storage.get(key('sync')) ?? {state: 'empty', indexedBlock: String(BigInt(configuration.fromBlock) - 1n), cursorNonce: null, caughtUp: false, failureCount: 0};
    if (sync.nextAllowedAtMs > nowMs) return status();
    let progress = await storage.get(key('sync:progress'));
    sync = {...sync, state: 'catching_up', lastAttemptAtMs: nowMs, nextAllowedAtMs: nowMs + SYNC_INTERVAL, caughtUp: false, error: null};
    await storage.put(key('sync'), sync);
    const budget = {remaining: MAX_RPC, spend() {
      if (this.remaining < 1) throw registryError('rpc_budget', 'The bounded registry synchronization will continue on its next request.');
      this.remaining -= 1;
    }};
    let logRequests = 0;
    const range = BigInt(configuration.maxLogBlockRange ?? 500);
    async function save() {
      await storage.transaction(async state => {
        await state.put(key('sync'), sync);
        await state.put(key('sync:progress'), progress);
      });
    }
    try {
      await storage.transaction(checkConfiguration);
      await chain.validateNetwork(budget);
      const verifiedSchema = await chain.schema(budget);
      if (!progress) {
        const head = await chain.finalizedBlock(budget);
        progress = {head, headNonce: null, search: null, page: null};
        await save();
      }
      const headNumber = BigInt(progress.head.number);
      if (headNumber < BigInt(configuration.fromBlock)) {
        sync.state = 'catching_up'; progress = null; await save(); return status();
      }
      if (sync.cursorNonce === null || sync.cursorNonce === undefined) {
        sync.cursorNonce = await chain.transactionCount(sync.indexedBlock, budget);
        await save();
      }
      if (progress.headNonce === null) {
        progress.headNonce = await chain.transactionCount(progress.head.number, budget);
        await save();
      }
      if (BigInt(progress.headNonce) < BigInt(sync.cursorNonce)) throw registryError('nonce_inconsistent', 'The finalized signer count moved behind the retained boundary.');
      // Sealed receipts are displayed immediately. Check their exact hash when that block becomes finalized.
      for (const record of await records()) {
        if (record.source !== 'receipt' || record.finalizedChecked || BigInt(record.blockNumber) > headNumber) continue;
        if (budget.remaining < 3) {await save(); return status();}
        const receipt = await chain.receipt(record.transactionHash, {budget});
        const valid = receipt?.status === 'confirmed' && receipt.attestationUid === record.attestationUid && receipt.blockNumber === record.blockNumber && receipt.blockHash === record.blockHash && same(receipt.identity, record.identity);
        const receiptIssue = valid ? null : {code: receipt ? 'receipt_inconsistent' : 'receipt_missing', message: receipt ? 'The finalized receipt differs from the recorded sealed start registration.' : 'The recorded sealed start registration has no receipt at the finalized boundary.'};
        if (receiptIssue) logger.warn('A start registration could not be verified at its finalized block; the start registration remains visible.', {runId: record.identity.runId, code: receiptIssue.code});
        await storage.put(attestationKey(record.attestationUid), {...record, finalizedChecked: true, receiptIssue});
      }
      while (BigInt(sync.indexedBlock) < headNumber) {
        if (BigInt(progress.headNonce) === BigInt(sync.cursorNonce)) {
          sync.indexedBlock = progress.head.number;
          sync.indexedChainTimestamp = progress.head.timestamp;
          break;
        }
        if (!verifiedSchema) throw registryError('schema_missing', 'The configured start schema is absent while signer activity needs reconciliation.');
        if (!progress.page) {
          if (!progress.search) {
            let high = headNumber;
            // Exact retained blocks can bound the first activity without searching an entire quiet gap.
            const hint = (await records()).filter(record => !record.receiptIssue && BigInt(record.blockNumber) > BigInt(sync.indexedBlock) && BigInt(record.blockNumber) <= headNumber)
              .sort((left, right) => BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1 : 1)[0];
            if (hint && budget.remaining) {
              const nonce = await chain.transactionCount(hint.blockNumber, budget);
              if (BigInt(nonce) > BigInt(sync.cursorNonce)) high = BigInt(hint.blockNumber);
            }
            progress.search = {low: String(BigInt(sync.indexedBlock) + 1n), high: String(high)};
            await save();
          }
          let low = BigInt(progress.search.low), high = BigInt(progress.search.high);
          while (high - low + 1n > range && budget.remaining) {
            const middle = (low + high) / 2n;
            const nonce = await chain.transactionCount(String(middle), budget);
            if (BigInt(nonce) < BigInt(sync.cursorNonce) || BigInt(nonce) > BigInt(progress.headNonce)) throw registryError('nonce_inconsistent', 'A signer activity probe differs from its fixed finalized boundary.');
            if (BigInt(nonce) === BigInt(sync.cursorNonce)) low = middle + 1n;
            else high = middle;
            progress.search = {low: String(low), high: String(high)};
            await save();
          }
          if (high - low + 1n > range || budget.remaining < 1 || logRequests >= MAX_LOGS) break;
          const to = low + range - 1n < headNumber ? low + range - 1n : headNumber;
          const logs = await chain.logs(String(low), String(to), budget); logRequests += 1;
          if (logs.some(log => BigInt(log.blockNumber) < low || BigInt(log.blockNumber) > to)) throw registryError('attestation_invalid', 'A registry log lies outside its requested range.');
          progress.page = {from: String(low), to: String(to), logs, index: 0, toNonce: to === headNumber ? progress.headNonce : null};
          progress.search = null;
          await save();
        }
        const page = progress.page;
        while (page.index < page.logs.length && budget.remaining) {
          const log = page.logs[page.index];
          const known = await storage.get(attestationKey(log.attestationUid));
          if (!known) {
            const verified = await chain.attestation(log.attestationUid, budget, progress.head.number);
            if (!verified || verified.attestationUid !== log.attestationUid || verified.schemaUid !== SCHEMA_UID || !Number.isSafeInteger(verified.chainTimestamp) || verified.chainTimestamp < 1) throw registryError('attestation_invalid', 'The registry attestation metadata is inconsistent.');
            const identity = validateStartIdentity(verified.identity);
            await storage.transaction(async state => {
              await retainRecord({...verified, identity, ...log, registeredAtMs: clock(), source: 'external', finalizedChecked: true}, state);
              page.index += 1;
              await state.put(key('sync:progress'), progress);
            });
          } else {
            if (known.blockHash !== log.blockHash || known.blockNumber !== log.blockNumber || known.transactionHash !== log.transactionHash) {
              const issue = {code: 'receipt_inconsistent', message: 'The indexed start log differs from the retained receipt.'};
              logger.warn('A registry log differs from a retained start receipt; both evidence and issue remain visible.', {runId: known.identity.runId, code: issue.code});
              await storage.put(attestationKey(known.attestationUid), {...known, receiptIssue: issue});
            }
            page.index += 1; await save();
          }
        }
        if (page.index < page.logs.length) break;
        if (page.toNonce === null) {
          if (!budget.remaining) break;
          page.toNonce = await chain.transactionCount(page.to, budget);
          await save();
        }
        if (BigInt(page.toNonce) < BigInt(sync.cursorNonce) || BigInt(page.toNonce) > BigInt(progress.headNonce)) throw registryError('nonce_inconsistent', 'A completed log page has an inconsistent signer count.');
        sync.indexedBlock = page.to; sync.cursorNonce = page.toNonce;
        sync.indexedAtMs = clock(); sync.indexedChainTimestamp = page.to === progress.head.number ? progress.head.timestamp : null;
        progress.page = null;
        await save();
        if (logRequests >= MAX_LOGS || !budget.remaining) break;
      }
      sync.caughtUp = BigInt(sync.indexedBlock) >= headNumber;
      sync.state = sync.caughtUp ? 'current' : 'catching_up';
      sync.indexedAtMs = clock(); sync.lastSuccessAtMs = clock(); sync.failureCount = 0;
      if (sync.caughtUp) progress = null;
      await save();
    } catch (error) {
      if (error?.code === 'rpc_budget') {sync.state = 'catching_up'; await save();}
      else {
        sync.failureCount = (sync.failureCount ?? 0) + 1;
        sync.state = 'failed'; sync.caughtUp = false;
        sync.error = {code: safeError(error).code, message: 'Blockchain synchronization failed; cached start registrations and completed progress are retained.'};
        sync.nextAllowedAtMs = nowMs + Math.min(SYNC_INTERVAL * 2 ** Math.min(sync.failureCount - 1, 4), MAX_BACKOFF);
        logger.warn('Start registry synchronization failed; cached start registrations and cursor are retained.', {code: sync.error.code, indexedBlock: sync.indexedBlock, nextAllowedAtMs: sync.nextAllowedAtMs});
        await save();
      }
    }
    return status();
  }
  function synchronize() {
    if (!syncInFlight) {
      syncInFlight = serialize(storage, syncOnce, synchronizationQueues).finally(() => {syncInFlight = null;});
    }
    return syncInFlight;
  }
  async function status({runs = [], publications = {latestPublicationId: null, runs: []}} = {}) {
    const sync = await storage.get(key('sync'));
    const all = await records();
    const runMap = new Map(runs.map(run => [run.runId, run]));
    const registrations = all.map(record => {
      const run = runMap.get(record.identity.runId);
      const matched = run && run.config?.purpose === 'scored' && `0x${run.configHash}` === record.identity.configHash && run.config.seriesId === record.identity.seriesId && run.codeCheckpoint === record.identity.sourceCheckpoint;
      const state = matched ? run.state : null;
      const executionState = !state ? 'completion_not_reported' : state.lifecycle === 'running' ? 'in_progress' :
        state.lifecycle === 'completed' ? 'completed' : ['stopped', 'failed'].includes(state.lifecycle) ? 'interrupted' : 'registered';
      return {...publicRegistration(record), ...record.identity, duplicateRun: record.duplicateRun === true, conflict: record.conflict === true || Boolean(run && !matched),
        confirmation: record.receiptIssue ? 'receipt_issue' : record.finalizedChecked ? 'finalized' : 'sealed', registryIssue: record.receiptIssue ?? null,
        execution: {state: executionState, startedAtMs: state?.recordingStartedAtMs ?? null, finishedAtMs: state?.finishedAtMs ?? terminalEventTime(state?.lifecycle, matched ? run.events : []),
          reason: state?.lastError?.message ?? (state?.lifecycle === 'stopped' ? 'The operator stopped the sequence.' : null)},
        issues: [], streamUrl: null, data: {state: 'awaiting_publication', publications: (publications.runs ?? []).filter(item => item.runId === record.identity.runId && item.seriesId === record.identity.seriesId && item.configHash === record.identity.configHash && item.sourceCheckpoint === record.identity.sourceCheckpoint)}};
    });
    for (const registration of registrations) {
      const metadata = await storage.get(key(`metadata:${registration.runId}`));
      registration.issues = (metadata?.issues ?? []).map(({actor, ...issue}) => issue);
      registration.streamUrl = metadata?.streams?.at(-1)?.streamUrl ?? null;
      const open = new Map();
      for (const issue of registration.issues) {
        if (issue.category === 'resolved') open.delete(issue.rootIssueId);
        else if (issue.category !== 'correction') open.set(issue.rootIssueId ?? issue.issueId, issue.affectedCategory ?? issue.category);
      }
      registration.data.reportedStates = [...new Set(open.values())];
      const category = ['recording_unavailable', 'recording_partial', 'analysis_failed', 'publication_failed'].find(item => registration.data.reportedStates.includes(item));
      if (category) registration.data.state = category;
      else if (registration.data.publications.some(item => item.analysisPublished)) registration.data.state = 'published';
      else if (registration.data.publications.length) registration.data.state = 'inventory_published';
    }
    return {registry: {enabled, state: enabled && chain ? 'configured' : 'unconfigured', chainId: configuration?.chainId ?? null,
      network: configuration?.chainId === 8453 ? 'Base' : 'Base Sepolia', signerAddress: configuration?.signerAddress ?? null, fromBlock: configuration?.fromBlock ?? null,
      schemaUid: SCHEMA_UID, schema: SCHEMA, easAddress: EAS_ADDRESS, schemaRegistryAddress: SCHEMA_REGISTRY_ADDRESS,
      explorerUrl: explorer, signerUrl: configuration?.signerAddress ? `${explorer}/address/${configuration.signerAddress}` : null,
      contractUrl: `${explorer}/address/${EAS_ADDRESS}`},
      synchronization: !enabled || !chain ? {state: 'unconfigured', caughtUp: false} : sync ? Object.fromEntries(Object.entries(sync).filter(([name]) => !['cursorNonce', 'failureCount'].includes(name))) : {state: 'empty', caughtUp: false, indexedBlock: null, lastAttemptAtMs: null},
      latestPublicationId: publications.latestPublicationId ?? null, registrations};
  }
  async function metadataFor(runId, operation) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId ?? '') || !(await records()).some(record => record.identity.runId === runId)) throw registryError('registration_not_found', 'Report metadata for a registered scored run.', 404);
    return storage.transaction(async state => {
      const metadataKey = key(`metadata:${runId}`), metadata = await state.get(metadataKey) ?? {issues: [], streams: []};
      const saved = operation(metadata);
      await state.put(metadataKey, metadata); return saved;
    });
  }
  async function reportIssue({runId, category, reason, previousIssueId = null, streamUrl, actor = null}) {
    if (!['recording_partial', 'recording_unavailable', 'analysis_failed', 'publication_failed', 'correction', 'resolved'].includes(category) ||
        typeof reason !== 'string' || !reason.trim() || reason.length > 4000) throw registryError('issue_invalid', 'Choose an issue category and enter a nonempty reason of at most 4000 characters.', 400);
    const url = streamUrl == null || streamUrl === '' ? null : httpsUrl(streamUrl);
    return metadataFor(runId, metadata => {
      const refersToReport = ['correction', 'resolved'].includes(category);
      const previous = refersToReport && metadata.issues.find(item => item.issueId === previousIssueId);
      if (refersToReport && !previous) throw registryError('issue_reference_invalid', 'Choose an existing report for this correction or resolution.', 409);
      const issue = {issueId: crypto.randomUUID(), category, reason: reason.trim(), previousIssueId: previous?.issueId ?? null, reportedAtMs: clock(), actor};
      issue.rootIssueId = previous?.rootIssueId ?? previous?.issueId ?? issue.issueId;
      issue.affectedCategory = previous?.affectedCategory ?? previous?.category ?? category;
      metadata.issues.push(issue);
      if (url) metadata.streams.push({streamUrl: url, recordedAtMs: clock(), actor});
      const {actor: omitted, ...publicIssue} = issue; return publicIssue;
    });
  }
  async function setStream({runId, streamUrl, actor = null}) {
    const url = httpsUrl(streamUrl);
    return metadataFor(runId, metadata => {
      const item = {streamUrl: url, recordedAtMs: clock(), actor}; metadata.streams.push(item);
      return {streamUrl: url, recordedAtMs: item.recordedAtMs};
    });
  }
  return {ensureStart, synchronize, status, reportIssue, setStream,
    readiness: () => ({enabled, ...(chain?.readiness?.() ?? {configured: false, signingAvailable: false})})};
}
