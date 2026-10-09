import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publicationFixture, hash, partSize} from './publication-fixtures.mjs';
import {uploadPublication, readPublicationInventory} from '../../scripts/publication-upload.mjs';
import {publicationCredentialReader} from '../../scripts/publication-auth.mjs';

async function uploadFixture(t, {video = Buffer.alloc(partSize + 9, 27)} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tree-upload-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const service = publicationFixture({video}), retained = service.manifest(), localFiles = {};
  for (const [digest, bytes] of retained.bytes) { localFiles[digest] = join(directory, digest); await writeFile(localFiles[digest], bytes); }
  const manifestPath = join(directory, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(retained.manifest));
  const requests = [], progress = [], clientId = 'synthetic-client', clientSecret = 'synthetic-credential-marker';
  const fetch = async (url, options) => {
    const request = new Request(url, options); requests.push(request);
    assert.equal(request.headers.get('CF-Access-Client-Id'), clientId); assert.equal(request.headers.get('CF-Access-Client-Secret'), clientSecret);
    return service.service.fetch(request, {id: 'publisher', role: 'publisher'});
  };
  const options = {manifestPath, manifestSha256: hash(await readFile(manifestPath)), localFiles, environment: 'test',
    credentialReader: async () => ({clientId, clientSecret}), fetch, onProgress: value => progress.push(value), sleep: async () => {}};
  return {service, retained, requests, progress, options, clientSecret};
}

test('resume uses exact saved manifest bytes, skips accepted parts and verified files, and repeats safely', async t => {
  const fixture = await uploadFixture(t), {service, retained} = fixture;
  await service.begin(retained);
  const verified = [...retained.bytes.keys()].find(digest => digest !== retained.original);
  await service.upload(retained, verified);
  const id = retained.manifest.publicationId, first = retained.bytes.get(retained.original).subarray(0, partSize);
  await service.fetch(`jobs/${id}/files/${retained.original}`, 'POST', {});
  await service.fetch(`jobs/${id}/files/${retained.original}/parts/1`, 'PUT', first, {'X-Content-Sha256': hash(first)});
  service.construct(); service.bucket.partCalls.length = 0;
  const receipt = await uploadPublication(fixture.options);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.publicationId, id);
  assert.equal(receipt.resultsUrl, `https://test.lab.sourceof.love/studies/targeted-vegetation-movement/public/results?publication=${id}`);
  assert.ok(fixture.requests.every(request => new URL(request.url).pathname.startsWith('/studies/targeted-vegetation-movement/app/api/publication/')));
  assert.ok(fixture.requests.every(request => request.redirect === 'manual'));
  const uploaded = fixture.requests.filter(request => request.method === 'PUT').map(request => new URL(request.url).pathname);
  assert.ok(uploaded.some(path => path.endsWith(`/files/${retained.original}/parts/2`)));
  assert.ok(!uploaded.some(path => path.includes(`/files/${retained.original}/parts/1`)));
  assert.ok(!uploaded.some(path => path.includes(`/files/${verified}/`)));
  assert.equal(JSON.stringify(fixture.progress).includes(fixture.clientSecret), false);
  assert.ok(fixture.progress.some(item => item.stage === 'Verifying publication files'));
  const count = service.bucket.partCalls.length;
  await uploadPublication(fixture.options); assert.equal(service.bucket.partCalls.length, count);
});

test('transient part failure retries the same bytes; persistent failure is explicit and resumable', async t => {
  const fixture = await uploadFixture(t), realFetch = fixture.options.fetch; let failures = 0;
  fixture.options.fetch = async (url, options) => {
    if (options.method === 'PUT' && failures++ === 0) throw new Error(fixture.clientSecret);
    return realFetch(url, options);
  };
  await uploadPublication(fixture.options);
  assert.ok(fixture.progress.some(item => item.stage === 'Retrying upload part' && item.operation.includes('/parts/') && item.reason === 'Network Error'));
  const other = await uploadFixture(t); let attempts = 0;
  other.options.fetch = async () => { attempts++; throw new Error(other.clientSecret); };
  await assert.rejects(uploadPublication(other.options), error => /Resume/.test(error.message) && !error.message.includes(other.clientSecret));
  assert.equal(attempts, 3);
});

test('changed retained file fails before any credential read or network request', async t => {
  const fixture = await uploadFixture(t); let reads = 0;
  fixture.options.credentialReader = async () => { reads++; throw new Error('must not read'); };
  await writeFile(fixture.options.localFiles[fixture.retained.original], 'changed');
  await assert.rejects(uploadPublication(fixture.options), /changed|missing/);
  assert.equal(reads, 0); assert.equal(fixture.requests.length, 0);
});

test('fixed destinations and redirects cannot transport credentials to another origin', async t => {
  const fixture = await uploadFixture(t);
  await assert.rejects(uploadPublication({...fixture.options, environment: 'custom'}), /environment/);
  await assert.rejects(uploadPublication({...fixture.options, environment: 'production'}), /environment/);
  fixture.options.fetch = async () => new Response(null, {status: 302, headers: {Location: 'https://other.invalid/'}});
  await assert.rejects(uploadPublication(fixture.options), /redirect/);
  const inventory = await readPublicationInventory({seriesId: 'scored-series', environment: 'test',
    credentialReader: fixture.options.credentialReader, fetch: fixture.options.fetch}).catch(error => error);
  assert.match(inventory.message, /redirect/);
});

test('project credentials use the canonical helper with exact selectors and never fall back', async () => {
  const calls = [];
  const reader = publicationCredentialReader({source: 'keychain', loadHelper: async () => ({createMacOSKeychain: () => ({read(service, account) { calls.push([service, account]); return service.endsWith('-id') ? 'fixture-id' : 'fixture-secret'; }})})});
  assert.deepEqual(await reader('test'), {clientId: 'fixture-id', clientSecret: 'fixture-secret'});
  assert.deepEqual(calls, [['lovefield-tree-publication-test-client-id', 'denis'], ['lovefield-tree-publication-test-client-secret', 'denis']]);
  const failed = publicationCredentialReader({source: 'keychain', environmentVariables: {CF_ACCESS_CLIENT_ID: 'unused', CF_ACCESS_CLIENT_SECRET: 'unused'},
    loadHelper: async () => ({createMacOSKeychain: () => ({read() { throw new Error('synthetic-private-marker'); }})})});
  await assert.rejects(failed('production'), error => /lovefield-tree-publication-production-client-id/.test(error.message) && /denis/.test(error.message) && !error.message.includes('synthetic-private-marker'));
  const explicit = publicationCredentialReader({source: 'environment', environmentVariables: {CF_ACCESS_CLIENT_ID: 'independent-id', CF_ACCESS_CLIENT_SECRET: 'independent-secret'}});
  assert.deepEqual(await explicit('test'), {clientId: 'independent-id', clientSecret: 'independent-secret'});
});

test('stale publication and changed inventory require a fresh immutable snapshot', async t => {
  const fixture = await uploadFixture(t);
  for (const code of ['inventory_changed', 'publication_stale']) {
    fixture.options.fetch = async () => new Response(JSON.stringify({code, message: fixture.clientSecret}), {status: 409});
    await assert.rejects(uploadPublication(fixture.options), error => error.requiresNewSnapshot === true && /prepare a new publication/i.test(error.message) && !error.message.includes(fixture.clientSecret));
  }
});


test('publication inventory uses the canonical destination with the exact selected series and fixed credentials', async t => {
  const fixture = await uploadFixture(t), requests = [];
  const inventory = await readPublicationInventory({seriesId: 'scored-series', environment: 'test',
    credentialReader: fixture.options.credentialReader, fetch: async (url, options) => {
      requests.push(new Request(url, options)); return Response.json({seriesId: 'scored-series', inventory: fixture.service.inventory});
    }});
  assert.equal(inventory.seriesId, 'scored-series');
  assert.equal(requests[0].url, 'https://test.lab.sourceof.love/studies/targeted-vegetation-movement/app/api/publication/series/scored-series/inventory');
  assert.equal(requests[0].redirect, 'manual');
  assert.equal(requests[0].headers.get('CF-Access-Client-Id'), 'synthetic-client');
});


test('the new uploader returns canonical links from an unchanged completed historical receipt', async t => {
  const fixture = await uploadFixture(t), id = fixture.retained.manifest.publicationId;
  const savedReceipt = {publicationId: id, status: 'completed', completedAtMs: 10000,
    resultsUrl: '/studies/tree-targeting/public/results?publication=' + id,
    recordingsUrl: '/studies/tree-targeting/public/recordings?publication=' + id};
  const before = structuredClone(savedReceipt);
  fixture.options.fetch = async () => Response.json({publicationId: id, status: 'completed', partSize,
    manifestSha256: fixture.options.manifestSha256, receipt: savedReceipt});
  const result = await uploadPublication(fixture.options);
  assert.equal(result.resultsUrl, 'https://test.lab.sourceof.love/studies/targeted-vegetation-movement/public/results?publication=' + id);
  assert.equal(result.recordingsUrl, 'https://test.lab.sourceof.love/studies/targeted-vegetation-movement/public/recordings?publication=' + id);
  assert.deepEqual(savedReceipt, before);
});
