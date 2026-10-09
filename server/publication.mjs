import {PART_SIZE, objectKey, sha256, verifyObjectHash as streamedHash, boundedBytes, servePublishedFile} from './publication-files.mjs';
import {ArtifactIdentityError, selectArtifactIdentity} from './publication-identity.mjs';
import {PUBLICATION_API_BASE, PUBLIC_API_BASE, PUBLIC_BASE, LEGACY_HOSTED_BASE, canonicalHostedStudyPath, publicStudyUrl} from '../web/study-paths.mjs';

const API = PUBLICATION_API_BASE;
const PUBLIC_API = PUBLIC_API_BASE;
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,80}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ROLES = new Set(['camera-original', 'viewing-video', 'setup-image', 'run-bundle', 'series-bundle', 'analysis', 'measurement', 'report', 'profile', 'clock-map', 'footage-review', 'source', 'protocol', 'reproduction-inputs']);
const FIELDS = ['schemaVersion', 'experimentSlug', 'purpose', 'environment', 'seriesId', 'publicationId', 'createdAtMs', 'previousPublicationId', 'correctionReason', 'softwareTest', 'seriesBundle', 'sourceReleases', 'inventory', 'includedAnalyses', 'accumulated', 'files', 'reportPresentation'];
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
class PublicationError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function require(condition, message, status = 400, code = 'invalid_publication') { if (!condition) throw new PublicationError(status, code, message); }
function validJson(value, depth = 0) {
  require(depth < 30, 'Publication JSON is too deeply nested.');
  if (typeof value === 'number') require(Number.isFinite(value), 'Publication values must be finite.');
  if (value && typeof value === 'object') for (const child of Object.values(value)) validJson(child, depth + 1);
}
async function body(request) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await boundedBytes(request, 2 * 1024 * 1024))); }
  catch (error) { if (error.status) throw error; throw new PublicationError(400, 'invalid_json', 'Send a bounded UTF-8 JSON object.'); }
  require(value && typeof value === 'object' && !Array.isArray(value), 'Send a JSON object.'); validJson(value); return value;
}
const memberIdentity = item => Object.fromEntries(['runId', 'createdAtMs', 'collectionStartedAtMs', 'configHash', 'profileHash', 'codeCheckpoint', 'lifecycle', 'recordingStartedAtMs', 'finishedAtMs', 'tag'].map(key => [key, item[key] ?? null]));
function validateInventory(inventory) {
  require(Array.isArray(inventory) && inventory.length > 0 && inventory.length <= 10000, 'A complete collected inventory is required.');
  const seen = new Set(); let previous = -1;
  for (const item of inventory) {
    require(item && ID.test(item.runId) && !seen.has(item.runId), 'Collected recording identities must be unique.'); seen.add(item.runId);
    require(Number.isFinite(item.createdAtMs) && Number.isFinite(item.collectionStartedAtMs) && item.collectionStartedAtMs >= item.createdAtMs && item.collectionStartedAtMs >= previous,
      'Inventory must retain chronological collection order.'); previous = item.collectionStartedAtMs;
    require(HASH.test(item.configHash) && HASH.test(item.profileHash) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.codeCheckpoint), 'Inventory needs frozen configuration, profile and source identities.');
  }
}
function validateManifest(manifest, environment) {
  require(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'The manifest must be an object.'); validJson(manifest);
  require(FIELDS.every(field => Object.hasOwn(manifest, field)) && Object.keys(manifest).every(field => FIELDS.includes(field)), 'Manifest fields differ from schema version one.');
  require(manifest.schemaVersion === 1 && manifest.experimentSlug === 'tree-targeting' && manifest.purpose === 'scored', 'Only scored Tree publications are accepted.');
  require(manifest.environment === environment && ['test', 'production'].includes(environment), 'Publication destination differs from this environment.');
  require(typeof manifest.softwareTest === 'boolean' && (!manifest.softwareTest || environment === 'test'), 'Software test data is permitted only on Test.');
  require(ID.test(manifest.seriesId) && UUID.test(manifest.publicationId) && Number.isSafeInteger(manifest.createdAtMs) && manifest.createdAtMs >= 0, 'Publication identity or creation time is invalid.');
  require(manifest.previousPublicationId === null || UUID.test(manifest.previousPublicationId), 'Previous publication identity is invalid.');
  require(manifest.correctionReason === null || typeof manifest.correctionReason === 'string' && manifest.correctionReason.trim() && manifest.correctionReason.length <= 2000, 'A correction reason must be bounded text.');
  validateInventory(manifest.inventory);
  require(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files) && Object.keys(manifest.files).length <= 20000, 'Publication needs its file inventory.');
  for (const [hash, file] of Object.entries(manifest.files)) {
    require(HASH.test(hash) && file.sha256 === hash && Number.isSafeInteger(file.size) && file.size >= 0 && ROLES.has(file.role), 'A file identity, size or role is invalid.');
    require(file.size <= PART_SIZE * 10000, 'A file exceeds the R2 limit of 10,000 fixed 8 MiB publication parts.', 413, 'file_too_large');
    require(typeof file.filename === 'string' && file.filename.length > 0 && file.filename.length <= 240 && !/[\/\\\x00-\x1f\x7f]/.test(file.filename) && !['.', '..'].includes(file.filename), 'File names must contain one safe component.');
    require(typeof file.contentType === 'string' && /^[a-z]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/.test(file.contentType), 'A file content type is invalid.');
    if (file.derivedFrom) require(HASH.test(file.derivedFrom) && manifest.files[file.derivedFrom], 'A viewing file needs its retained original.');
  }
  function reference(hash, role) { require(HASH.test(hash) && manifest.files[hash] && (!role || manifest.files[hash].role === role), 'A required publication file is missing from the inventory.'); }
  reference(manifest.seriesBundle?.sha256, 'series-bundle');
  reference(manifest.accumulated?.resultSha256, 'analysis'); reference(manifest.accumulated?.reportSha256, 'report');
  require(manifest.accumulated.seriesBundleSha256 === manifest.seriesBundle.sha256, 'Accumulation must identify its retained series bundle.');
  require(Array.isArray(manifest.includedAnalyses) && Array.isArray(manifest.accumulated.included), 'Selected analysis revisions are required.');
  const seen = new Set(), selected = [];
  for (const analysis of manifest.includedAnalyses) {
    require(analysis && ID.test(analysis.runId) && ID.test(analysis.analysisId) && !seen.has(analysis.runId), 'Each recording can contribute once under one analysis revision.'); seen.add(analysis.runId);
    const member = manifest.inventory.find(item => item.runId === analysis.runId);
    require(member && member.contributes === true && member.analysisState === 'completed' && member.analysis?.analysisId === analysis.analysisId, 'A contribution differs from the recording inventory.');
    for (const [field, role] of [['analysisSha256', 'analysis'], ['reportSha256', 'report'], ['runBundleSha256', 'run-bundle'], ['profileSha256', 'profile'], ['reproductionInputsSha256', 'reproduction-inputs']]) reference(analysis[field], role);
    require(Array.isArray(analysis.inputSha256s), 'A selected analysis needs its input references.');
    for (const hash of analysis.inputSha256s) reference(hash);
    selected.push({runId: analysis.runId, analysisId: analysis.analysisId});
  }
  require(selected.length === manifest.accumulated.included.length && selected.every((item, index) =>
    item.runId === manifest.accumulated.included[index]?.runId && item.analysisId === manifest.accumulated.included[index]?.analysisId), 'Accumulated revisions differ from included analyses.');
  require(manifest.inventory.filter(item => item.contributes === true).length === selected.length, 'Inventory contributions differ from accumulated revisions.');
  const order = manifest.inventory.map(item => item.runId);
  require(selected.every((item, index) => order[index] === item.runId), 'A publication cannot skip an earlier unresolved recording.');
}

export function createPublicationService({storage, bucket, getInventory, clock = Date.now, environment = 'test', verifyObjectHash = streamedHash, logger = console}) {
  const queues = new Map();
  function serialize(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation); const settled = result.then(() => {}, () => {}); queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); }); return result;
  }
  async function inventoryFor(seriesId, softwareTest, state = storage) {
    const retained = softwareTest && await state.get(`publication:synthetic:${seriesId}`);
    const inventory = softwareTest ? retained && await storedJson(retained.key, retained.sha256) : await getInventory(seriesId, state);
    const list = Array.isArray(inventory) ? inventory : inventory?.inventory;
    require(list, 'The destination scored series was not found.', 404, 'series_not_found'); validateInventory(list); return list;
  }
  async function coverage(manifest) {
    const inventory = await inventoryFor(manifest.seriesId, manifest.softwareTest);
    require(JSON.stringify(inventory.map(memberIdentity)) === JSON.stringify(manifest.inventory.map(memberIdentity)), 'Collected inventory changed; prepare a new publication from the latest series bundle.', 409, 'inventory_changed');
    return JSON.stringify(inventory.map(memberIdentity));
  }
  async function retainJson(raw) {
    const bytes = new TextEncoder().encode(raw), hash = await sha256(bytes), key = `publication-json/${hash}`;
    if (!await bucket.head(key)) await bucket.put(key, bytes, {httpMetadata: {contentType: 'application/json'}});
    return {key, sha256: hash};
  }
  async function storedJson(key, hash) {
    const object = await bucket.get(key);
    require(object && object.size <= 2 * 1024 * 1024, 'Retained publication JSON is missing or exceeds the request format limit.', 409, 'manifest_unavailable');
    const raw = await object.text();
    require(await sha256(new TextEncoder().encode(raw)) === hash, 'Retained publication JSON changed.', 409, 'manifest_changed');
    try { return JSON.parse(raw); } catch { throw new PublicationError(409, 'manifest_invalid', 'Retained publication JSON is invalid.'); }
  }
  async function hydrate(retained) {
    return {...retained, manifest: await storedJson(retained.manifestKey, retained.manifestSha256)};
  }
  function statusSummary(manifest) {
    return {publicationId: manifest.publicationId, softwareTest: manifest.softwareTest === true,
      runs: manifest.inventory.map(item => ({runId: item.runId, seriesId: manifest.seriesId, configHash: `0x${item.configHash}`,
        sourceCheckpoint: item.codeCheckpoint, publicationId: manifest.publicationId,
        analysisPublished: manifest.files[item.analysis?.analysisSha256]?.role === 'analysis' && manifest.files[item.analysis?.reportSha256]?.role === 'report', analysisState: item.analysisState,
        availableInputCount: Array.isArray(item.analysis?.inputSha256s) ? item.analysis.inputSha256s.filter(hash => manifest.files[hash]).length : 0,
        url: `${PUBLIC_API.slice(0, -4)}recordings/${encodeURIComponent(item.runId)}?publication=${manifest.publicationId}`}))};
  }
  async function statusInventory() {
    const runs = [], latest = await storage.get('publication:latest');
    let latestPublicationId = null;
    for (const [key, retained] of await listed('publication:revision:')) {
      const id = key.slice('publication:revision:'.length);
      let summary = await storage.get(`publication:status:${id}`);
      if (!summary) {
        summary = statusSummary((await hydrate(retained)).manifest);
        await storage.put(`publication:status:${id}`, summary);
      }
      if (!summary.softwareTest) {
        runs.push(...summary.runs);
        if (id === latest) latestPublicationId = id;
      }
    }
    return {latestPublicationId, runs};
  }
  async function savedJob(id) {
    const job = await storage.get(`publication:job:${id}`); require(job, 'Publication job was not found.', 404, 'job_not_found'); return hydrate(job);
  }
  function compact(job) {
    const {manifest, ...retained} = job; return retained;
  }
  async function listed(prefix) {
    const records = new Map(); let startAfter;
    while (true) {
      const page = await storage.list({prefix, limit: 1000, ...(startAfter ? {startAfter} : {})});
      for (const [key, value] of page) records.set(key, value);
      if (page.size < 1000) return records;
      startAfter = [...page.keys()].at(-1);
    }
  }
  const uploadKey = (id, hash) => `publication:upload:${id}:${hash}`;
  const partPrefix = (id, hash) => `publication:part:${id}:${hash}:`;
  const partKey = (id, hash, number) => partPrefix(id, hash) + String(number).padStart(10, '0');
  async function parts(id, hash) { return [...(await listed(partPrefix(id, hash))).values()].sort((left, right) => left.partNumber - right.partNumber); }
  async function summary(job) {
    const verifiedFiles = [], uploads = {};
    for (const hash of Object.keys(job.manifest.files)) if (await storage.get(`publication:file:${hash}`)) verifiedFiles.push(hash);
    for (const [key, upload] of await listed(`publication:upload:${job.manifest.publicationId}:`)) {
      const hash = key.slice(key.lastIndexOf(':') + 1); uploads[hash] = {...upload, parts: await parts(job.manifest.publicationId, hash)};
    }
    return {publicationId: job.manifest.publicationId, status: job.status, manifestSha256: job.manifestSha256,
      verifiedFiles, missingFiles: Object.keys(job.manifest.files).filter(hash => !verifiedFiles.includes(hash)),
      uploads, partSize: PART_SIZE, ...(job.receipt ? {receipt: job.receipt} : {})};
  }
  async function readIdentity(hash, paths) {
    const object = await bucket.get(objectKey(hash)); require(object, 'A retained JSON artifact is missing.', 409, 'artifact_unavailable');
    try { return await selectArtifactIdentity(object.body, paths.map(path => path.split('.'))); }
    catch (error) {
      if (error instanceof ArtifactIdentityError) throw new PublicationError(error.status, error.code, error.message);
      throw error;
    }
  }
  async function artifactIdentities(manifest) {
    const bundle = await readIdentity(manifest.seriesBundle.sha256, ['seriesId', 'config.purpose', 'collectionRunIds']);
    require(bundle.seriesId === manifest.seriesId && bundle.config?.purpose === 'scored' && JSON.stringify(bundle.collectionRunIds) === JSON.stringify(manifest.inventory.map(item => item.runId)), 'The retained series bundle differs from publication coverage.', 409);
    const result = await readIdentity(manifest.accumulated.resultSha256, ['purpose', 'runIds', 'selectedRevisions']);
    require(result.purpose === 'scored' && JSON.stringify(result.runIds) === JSON.stringify(manifest.accumulated.included.map(item => item.runId)) && JSON.stringify(result.selectedRevisions) === JSON.stringify(manifest.accumulated.included.map(item => item.analysisId)), 'The saved accumulated result differs from its declared revisions.', 409);
    for (const selected of manifest.includedAnalyses) {
      const artifact = await readIdentity(selected.analysisSha256, ['runId', 'analysisId', 'result.runId', 'result.revisionId', 'result.purpose', 'inputHashes', 'derivedInputHashes']);
      require(artifact.runId === selected.runId && artifact.analysisId === selected.analysisId && artifact.result?.runId === selected.runId && artifact.result?.revisionId === selected.analysisId && artifact.result?.purpose === 'scored', 'The selected individual artifact has a mismatching identity.', 409);
      require(artifact.inputHashes && typeof artifact.inputHashes === 'object' && !Array.isArray(artifact.inputHashes) && artifact.derivedInputHashes && typeof artifact.derivedInputHashes === 'object' && !Array.isArray(artifact.derivedInputHashes), 'The selected artifact is missing its retained input identity maps.', 409);
      const required = [...Object.values(artifact.inputHashes ?? {}), ...Object.values(artifact.derivedInputHashes ?? {})];
      require(required.every(hash => selected.inputSha256s.includes(hash) && manifest.files[hash]), 'A selected analysis omitted an actual retained input.', 409);
      const runBundle = await readIdentity(selected.runBundleSha256, ['runId', 'config.purpose']);
      require(runBundle.runId === selected.runId && runBundle.config?.purpose === 'scored', 'The recording bundle differs from its scored identity.', 409);
    }
  }
  function receiptForBase(receipt, publicBase) {
    const result = {...receipt};
    for (const name of ['resultsUrl', 'recordingsUrl']) {
      const canonical = canonicalHostedStudyPath(receipt[name]);
      if (canonical.startsWith(PUBLIC_BASE)) result[name] = publicBase + canonical.slice(PUBLIC_BASE.length);
    }
    return result;
  }
  async function apply(request, actor) {
    require(actor?.role === 'publisher' && actor?.id, 'A dedicated publication identity is required.', 403, 'publisher_required');
    require(bucket, 'Publication storage is unavailable.', 503, 'storage_unavailable');
    const url = new URL(request.url), pathname = canonicalHostedStudyPath(url.pathname), path = pathname.slice(API.length);
    const publicBase = url.pathname.startsWith(LEGACY_HOSTED_BASE) ? LEGACY_HOSTED_BASE + 'public/' : PUBLIC_BASE;
    const reply = (value, status) => json(value.receipt ? {...value, receipt: receiptForBase(value.receipt, publicBase)} :
      value.resultsUrl ? receiptForBase(value, publicBase) : value, status);
    require(pathname.startsWith(API), 'Publication route was not found.', 404, 'not_found');
    if (path === 'software-test/inventory' && request.method === 'POST') {
      require(environment === 'test', 'Synthetic inventory is available only on protected Test.', 403);
      const submitted = await body(request);
      require(submitted.softwareTest === true && ID.test(submitted.seriesId) && Object.keys(submitted).every(key => ['softwareTest', 'seriesId', 'inventory'].includes(key)), 'Explicit software-test inventory is required.');
      validateInventory(submitted.inventory);
      require(submitted.inventory.every(item => Object.keys(item).every(key => ['runId', 'tag', 'createdAtMs', 'collectionStartedAtMs', 'recordingStartedAtMs', 'finishedAtMs', 'lifecycle', 'configHash', 'profileHash', 'codeCheckpoint'].includes(key))), 'Synthetic inventory can contain recording identities and state only.');
      await storage.put(`publication:synthetic:${submitted.seriesId}`, await retainJson(JSON.stringify(submitted.inventory.map(memberIdentity))));
      return reply({seriesId: submitted.seriesId, softwareTest: true, inventory: submitted.inventory});
    }
    const inventoryPath = /^series\/([A-Za-z0-9_-]{1,80})\/inventory$/.exec(path);
    if (inventoryPath && request.method === 'GET') {
      const softwareTest = url.searchParams.get('softwareTest') === 'true';
      require(!softwareTest || environment === 'test', 'Software test inventory is unavailable in Production.', 403);
      return reply({seriesId: inventoryPath[1], purpose: 'scored', softwareTest, inventory: await inventoryFor(inventoryPath[1], softwareTest), previousPublicationId: await storage.get('publication:latest') ?? null});
    }
    if (path === 'jobs' && request.method === 'POST') {
      const submitted = await body(request);
      require(typeof submitted.manifestJson === 'string' && HASH.test(submitted.manifestSha256), 'Send exact manifestJson text and manifestSha256.');
      require(await sha256(new TextEncoder().encode(submitted.manifestJson)) === submitted.manifestSha256, 'Manifest bytes do not match their SHA-256.');
      let manifest; try { manifest = JSON.parse(submitted.manifestJson); } catch { throw new PublicationError(400, 'invalid_manifest', 'Manifest JSON is invalid.'); }
      validateManifest(manifest, environment);
      return serialize(manifest.publicationId, async () => {
        const previous = await storage.get(`publication:job:${manifest.publicationId}`);
        if (previous) { require(previous.manifestSha256 === submitted.manifestSha256, 'This publication ID already has different immutable bytes.', 409, 'publication_conflict'); return reply(await summary(await hydrate(previous))); }
        await coverage(manifest);
        const retained = await retainJson(submitted.manifestJson);
        const job = {manifest, manifestKey: retained.key, manifestSha256: submitted.manifestSha256, status: 'uploading', createdAtMs: clock()};
        await storage.put(`publication:job:${manifest.publicationId}`, compact(job)); return reply(await summary(job), 201);
      });
    }
    const route = /^jobs\/([a-f0-9-]{36})(?:\/files\/([a-f0-9]{64})(?:\/(parts\/([1-9]\d*)|complete))?|\/(commit))?$/.exec(path);
    require(route && UUID.test(route[1]), 'Publication route was not found.', 404, 'not_found');
    const [, id, hash, action, numberText, commit] = route;
    if (!hash && !commit && request.method === 'GET') return reply(await summary(await savedJob(id)));
    return serialize(id, async () => {
      const job = await savedJob(id), manifest = job.manifest;
      if (commit && request.method === 'POST') {
        if (job.status === 'completed') return reply(job.receipt);
        const inventoryVersion = await coverage(manifest);
        for (const [digest, metadata] of Object.entries(manifest.files)) {
          const verified = await storage.get(`publication:file:${digest}`);
          const object = verified && await bucket.head(objectKey(digest));
          require(verified && verified.size === metadata.size && object?.size === metadata.size, 'Publication has missing or unverified files.', 409, 'publication_incomplete');
        }
        await artifactIdentities(manifest);
        require(await coverage(manifest) === inventoryVersion, 'Inventory changed during verification.', 409, 'inventory_changed');
        const receipt = {publicationId: id, seriesId: manifest.seriesId, status: 'completed', completedAtMs: clock(),
          resultsUrl: publicStudyUrl('results', id), recordingsUrl: publicStudyUrl('recordings', id)};
        const seriesCurrent = await storage.get(`publication:current:${manifest.seriesId}`);
        const previousSeries = seriesCurrent && await storage.get(`publication:revision:${seriesCurrent}`);
        const previousManifest = previousSeries && await storedJson(previousSeries.manifestKey, previousSeries.manifestSha256);
        const changedRevision = previousManifest?.includedAnalyses.some(previous => !manifest.includedAnalyses.some(next => next.runId === previous.runId && next.analysisId === previous.analysisId));
        if (changedRevision) require(manifest.correctionReason?.trim(), 'A changed previously selected analysis requires its correction reason.', 409, 'correction_reason_required');
        await storage.transaction(async transaction => {
          require(JSON.stringify((await inventoryFor(manifest.seriesId, manifest.softwareTest, transaction)).map(memberIdentity)) === inventoryVersion, 'Inventory changed before atomic promotion.', 409, 'inventory_changed');
          const current = await transaction.get('publication:latest') ?? null;
          require(current === manifest.previousPublicationId, 'The current publication changed; prepare a new revision.', 409, 'publication_stale');
          require((await transaction.get(`publication:current:${manifest.seriesId}`) ?? null) === (seriesCurrent ?? null), 'The series publication changed; prepare a new revision.', 409, 'publication_stale');
          await transaction.put(`publication:revision:${id}`, {manifestKey: job.manifestKey, manifestSha256: job.manifestSha256, receipt});
          await transaction.put(`publication:status:${id}`, statusSummary(manifest));
          await transaction.put(`publication:current:${manifest.seriesId}`, id); await transaction.put('publication:latest', id);
          await transaction.put(`publication:job:${id}`, {...compact(job), status: 'completed', receipt});
        });
        return reply(receipt);
      }
      require(hash && manifest.files[hash], 'File is not part of this publication.', 404, 'file_not_found');
      require((!action && request.method === 'POST') || (numberText && request.method === 'PUT') || (action === 'complete' && request.method === 'POST'), 'This file operation does not support that method.', 405, 'method_not_allowed');
      const metadata = manifest.files[hash], verified = await storage.get(`publication:file:${hash}`);
      if (verified) {
        require(verified.size === metadata.size, 'The retained file size differs from this publication.', 409);
        return reply({sha256: hash, verified: true, parts: await parts(id, hash)});
      }
      if (!action && request.method === 'POST') {
        let upload = await storage.get(uploadKey(id, hash));
        if (!upload) {
          if (metadata.size === 0) {
            require(hash === await sha256(new Uint8Array()), 'Empty file has a wrong identity.', 409);
            await bucket.put(objectKey(hash), new Uint8Array()); await storage.put(`publication:file:${hash}`, {size: 0, verifiedAtMs: clock()});
            return reply({sha256: hash, verified: true, parts: []});
          }
          const started = await bucket.createMultipartUpload(objectKey(hash), {httpMetadata: {contentType: metadata.contentType}});
          upload = {uploadId: started.uploadId}; await storage.put(uploadKey(id, hash), upload);
        }
        return reply({...upload, parts: await parts(id, hash), partSize: PART_SIZE});
      }
      const upload = await storage.get(uploadKey(id, hash)); require(upload, 'Start this file upload first.', 409, 'upload_missing');
      if (numberText && request.method === 'PUT') {
        const number = Number(numberText), count = Math.ceil(metadata.size / PART_SIZE);
        require(Number.isSafeInteger(number) && number <= count, 'Part number is outside this file.', 400);
        const length = Math.min(PART_SIZE, metadata.size - (number - 1) * PART_SIZE), expected = request.headers.get('X-Content-Sha256');
        require(HASH.test(expected), 'Each part needs its expected SHA-256.');
        const bytes = await boundedBytes(request, length);
        require(bytes.byteLength === length && await sha256(bytes) === expected, 'Part bytes differ from their expected length or hash.', 409, 'part_corrupt');
        const prior = await storage.get(partKey(id, hash, number));
        if (prior) { require(prior.sha256 === expected && prior.size === length, 'An accepted part cannot change.', 409, 'part_conflict'); return reply(prior); }
        const accepted = await bucket.resumeMultipartUpload(objectKey(hash), upload.uploadId).uploadPart(number, bytes);
        const receipt = {...accepted, sha256: expected, size: length};
        await storage.put(partKey(id, hash, number), receipt); return reply(receipt);
      }
      if (action === 'complete' && request.method === 'POST') {
        const count = Math.ceil(metadata.size / PART_SIZE), receipts = await parts(id, hash);
        require(receipts.length === count && receipts.every((part, index) => part.partNumber === index + 1), 'The file still has missing parts.', 409, 'parts_missing');
        if (!upload.completedObject) {
          await bucket.resumeMultipartUpload(objectKey(hash), upload.uploadId).complete(receipts.map(({partNumber, etag}) => ({partNumber, etag})));
          upload.completedObject = true; await storage.put(uploadKey(id, hash), upload);
        }
        const object = await bucket.head(objectKey(hash));
        require(object?.size === metadata.size && await verifyObjectHash(bucket, objectKey(hash)) === hash, 'Whole uploaded file failed byte/hash verification.', 409, 'file_corrupt');
        await storage.put(`publication:file:${hash}`, {size: metadata.size, verifiedAtMs: clock()}); return reply({sha256: hash, verified: true});
      }
      throw new PublicationError(405, 'method_not_allowed', 'This publication operation does not support that method.');
    });
  }
  async function safely(operation) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof PublicationError || error.status === 413) return json({code: error.code ?? 'request_too_large', message: error.message}, error.status);
      logger.warn('Tree publication operation failed; prior publication retained.', {errorType: error?.constructor?.name ?? 'Unknown'});
      return json({code: 'publication_unavailable', message: 'Publication storage could not complete the operation. Resume the same job after resolving the failure.'}, 503);
    }
  }
  return {statusInventory, fetch: (request, actor) => safely(() => apply(request, actor)), readPublic: request => safely(async () => {
    if (!['GET', 'HEAD'].includes(request.method)) return json({code: 'method_not_allowed', message: 'Published results are read-only.'}, 405);
    const url = new URL(request.url), pathname = canonicalHostedStudyPath(url.pathname), path = pathname.slice(PUBLIC_API.length);
    require(pathname.startsWith(PUBLIC_API), 'Public route was not found.', 404, 'not_found');
    const latest = path === 'latest', route = /^publications\/([a-f0-9-]{36})(?:\/(reports\/([a-f0-9]{64})|files\/([a-f0-9]{64})\/([^/]+)|manifest))?$/.exec(path);
    require(latest || route && UUID.test(route[1]), 'Published result was not found.', 404, 'not_found');
    const id = latest ? await storage.get('publication:latest') : route[1];
    const retained = id && await storage.get(`publication:revision:${id}`);
    const revision = retained && await hydrate(retained);
    require(revision, 'No scored results have been published yet.', 404, 'publication_not_found');
    if (latest || !route[2]) {
      const response = request.method === 'HEAD' ? new Response(null, {headers: {'Content-Type': 'application/json'}}) : json(revision.manifest);
      response.headers.set('X-Publication-Completed-At-Ms', String(revision.receipt.completedAtMs));
      return response;
    }
    if (route[2] === 'manifest') {
      const object = await bucket.get(revision.manifestKey);
      return new Response(request.method === 'HEAD' ? null : object.body, {headers: {'Content-Type': 'application/json', 'Content-Length': String(object.size), 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="manifest.json"'}});
    }
    const hash = route[3] ?? route[4], metadata = revision.manifest.files[hash];
    require(metadata && (route[3] ? metadata.role === 'report' : decodeURIComponent(route[5]) === metadata.filename), 'File is not part of this completed publication.', 404, 'file_not_found');
    return servePublishedFile(request, bucket, metadata);
  })};
}
