import {createHash, randomUUID} from 'node:crypto';
import {createPublicationService} from '../../server/publication.mjs';
import {MemoryStorage} from './service-fixtures.mjs';
import {PUBLICATION_API_BASE, PUBLIC_API_BASE} from '../../web/study-paths.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const partSize = 8 * 1024 * 1024;
export class MemoryBucket {
  objects = new Map(); uploads = new Map(); partCalls = [];
  async createMultipartUpload(key) {
    const uploadId = randomUUID(); this.uploads.set(uploadId, {key, parts: new Map()});
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key, uploadId) {
    const owner = this;
    return {key, uploadId, async uploadPart(number, bytes) {
      const saved = owner.uploads.get(uploadId); if (!saved || saved.key !== key) throw new Error('Upload missing');
      const body = Buffer.from(bytes); saved.parts.set(number, body); owner.partCalls.push(number);
      return {partNumber: number, etag: `multipart-etag-${number}`};
    }, async complete(parts) {
      const saved = owner.uploads.get(uploadId);
      owner.objects.set(key, Buffer.concat(parts.map(part => saved.parts.get(part.partNumber))));
      owner.uploads.delete(uploadId); return {key};
    }};
  }
  async get(key, options = {}) {
    const body = this.objects.get(key); if (!body) return null;
    const offset = options.range?.offset ?? 0, length = options.range?.length ?? body.length;
    const selected = body.subarray(offset, offset + length);
    return {size: body.length, body: new Blob([selected]).stream(), text: async () => selected.toString(),
      arrayBuffer: async () => selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength)};
  }
  async head(key) { const value = this.objects.get(key); return value ? {size: value.length} : null; }
  async put(key, bytes) { this.objects.set(key, Buffer.from(bytes)); }
}
export async function verifyObjectHash(bucket, key) {
  const object = await bucket.get(key); if (!object) throw new Error('Object missing');
  const digest = createHash('sha256'); for await (const part of object.body) digest.update(part);
  return digest.digest('hex');
}
export function publicationFixture({video = Buffer.from('camera-original'), environment = 'test', storage = new MemoryStorage()} = {}) {
  const bucket = new MemoryBucket();
  const inventory = [{runId: 'recording-one', tag: 'software-test', createdAtMs: 1000, collectionStartedAtMs: 2000,
    recordingStartedAtMs: 1500, finishedAtMs: 9000, lifecycle: 'completed', configHash: 'c'.repeat(64),
    profileHash: 'd'.repeat(64), codeCheckpoint: 'e'.repeat(40)}];
  let service;
  const construct = () => service = createPublicationService({storage, bucket, getInventory: async () => inventory,
    environment, clock: () => 10000, verifyObjectHash}); construct();
  const request = (path, method = 'GET', body, headers = {}) => new Request(`https://test.lab.sourceof.love${PUBLICATION_API_BASE}${path}`, {
    method, headers: {'Content-Type': 'application/json', ...headers}, ...(body === undefined ? {} : {body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)})});
  const fetch = (path, method, body, headers) => service.fetch(request(path, method, body, headers), {id: 'publisher', role: 'publisher'});
  const publicRequest = (path, options) => service.readPublic(new Request(`https://test.lab.sourceof.love${PUBLIC_API_BASE}${path}`, options));
  function manifest(previousPublicationId = null) {
    const publicationId = randomUUID(), files = {}, bytes = new Map();
    function add(value, role, filename) {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)), digest = hash(body);
      bytes.set(digest, body); files[digest] = {sha256: digest, size: body.length, filename, role,
        contentType: filename.endsWith('.json') ? 'application/json' : 'video/mp4'}; return digest;
    }
    const original = add(video, 'camera-original', 'camera.mp4');
    const report = add({kind: 'series', full: {estimate: null}, evidenceLabel: '1.00', publicationId}, 'report', 'report.json');
    const runBundle = add({runId: inventory[0].runId, config: {purpose: 'scored'}}, 'run-bundle', 'run.json');
    const profile = add({profileId: 'frozen'}, 'profile', 'profile.json');
    const inputs = add({recordings: {}}, 'reproduction-inputs', 'inputs.json');
    const analysisId = 'analysis-one';
    const analysis = add({runId: inventory[0].runId, analysisId, inputHashes: {video: original}, derivedInputHashes: {},
      result: {runId: inventory[0].runId, revisionId: analysisId, purpose: 'scored'}}, 'analysis', 'analysis.json');
    const seriesBundle = add({seriesId: 'scored-series', config: {purpose: 'scored'}, collectionRunIds: inventory.map(item => item.runId)}, 'series-bundle', 'series.json');
    const result = add({purpose: 'scored', runIds: [inventory[0].runId], selectedRevisions: [analysisId]}, 'analysis', 'accumulated.json');
    const included = {runId: inventory[0].runId, analysisId, analysisSha256: analysis, reportSha256: report,
      runBundleSha256: runBundle, profileSha256: profile, reproductionInputsSha256: inputs, inputSha256s: [original],
      status: 'completed', missingReasons: [], qualificationReasons: []};
    return {manifest: {schemaVersion: 1, experimentSlug: 'tree-targeting', purpose: 'scored', environment,
      seriesId: 'scored-series', publicationId, createdAtMs: 10000, previousPublicationId, correctionReason: previousPublicationId ? 'Updated analysis' : null,
      softwareTest: false, seriesBundle: {sha256: seriesBundle, label: 'Scored', status: 'open'},
      sourceReleases: {}, reportPresentation: {}, inventory: inventory.map(item => ({...item, analysisState: 'completed', contributes: true, analysis: included})),
      includedAnalyses: [included], accumulated: {resultSha256: result, reportSha256: report, seriesBundleSha256: seriesBundle,
        included: [{runId: inventory[0].runId, analysisId}], status: 'completed'}, files}, bytes, original};
  }
  const begin = async fixture => { const manifestJson = JSON.stringify(fixture.manifest); return fetch('jobs', 'POST', {manifestJson, manifestSha256: hash(manifestJson)}); };
  async function upload(fixture, digest) {
    const id = fixture.manifest.publicationId, body = fixture.bytes.get(digest);
    const start = await fetch(`jobs/${id}/files/${digest}`, 'POST', {}); if (!start.ok) return start;
    for (let index = 0; index < Math.ceil(body.length / partSize); index++) {
      const part = body.subarray(index * partSize, (index + 1) * partSize);
      const response = await fetch(`jobs/${id}/files/${digest}/parts/${index + 1}`, 'PUT', part, {'X-Content-Sha256': hash(part)});
      if (!response.ok) return response;
    }
    return fetch(`jobs/${id}/files/${digest}/complete`, 'POST', {});
  }
  async function complete(fixture) {
    const response = await begin(fixture); if (!response.ok) return response;
    for (const digest of fixture.bytes.keys()) { const uploaded = await upload(fixture, digest); if (!uploaded.ok) return uploaded; }
    return fetch(`jobs/${fixture.manifest.publicationId}/commit`, 'POST', {});
  }
  return {storage, bucket, inventory, get service() { return service; }, construct, request, fetch, publicRequest, manifest, begin, upload, complete};
}
