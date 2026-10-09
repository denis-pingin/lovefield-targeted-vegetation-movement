// Local software fixture only: real uploader/service, isolated in-memory storage.
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {createPublicationService} from '../../server/publication.mjs';
import {uploadPublication} from '../../scripts/publication-upload.mjs';
import {MemoryStorage} from './service-fixtures.mjs';
import {MemoryBucket, verifyObjectHash} from './publication-fixtures.mjs';
import {PUBLICATION_API_BASE} from '../../web/study-paths.mjs';

const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (job.manifest.softwareTest !== true || job.manifest.environment !== 'test') throw new Error('Only an explicit Test software fixture can use this loopback rehearsal.');
const service = createPublicationService({storage: new MemoryStorage(), bucket: new MemoryBucket(),
  environment: 'test', getInventory: async () => null, verifyObjectHash});
const api = PUBLICATION_API_BASE;
const staged = new Request('http://127.0.0.1' + api + 'software-test/inventory', {method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({seriesId: job.manifest.seriesId, softwareTest: true, inventory: job.manifest.inventory.map(member => Object.fromEntries(
    ['runId', 'tag', 'createdAtMs', 'collectionStartedAtMs', 'recordingStartedAtMs', 'finishedAtMs', 'lifecycle', 'configHash', 'profileHash', 'codeCheckpoint'].map(key => [key, member[key] ?? null])))})});
const stagedResponse = await service.fetch(staged, {id: 'loopback-software-publisher', role: 'publisher'});
if (!stagedResponse.ok) throw new Error('Synthetic inventory staging failed.');
const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {method: incoming.method, headers: incoming.headers,
      ...(['GET', 'HEAD'].includes(incoming.method) ? {} : {body: Readable.toWeb(incoming), duplex: 'half'})});
    const response = [api, '/studies/tree-targeting/app/api/publication/'].some(base => new URL(request.url).pathname.startsWith(base)) ? await service.fetch(request, {id: 'loopback-software-publisher', role: 'publisher'}) : await service.readPublic(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing); else outgoing.end();
  } catch (error) { console.error('Loopback publication request failed:', error.name); outgoing.writeHead(500); outgoing.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const receipt = await uploadPublication({...job, environment: 'test', credentialReader: async () => ({clientId: 'loopback-only', clientSecret: 'software-fixture-only'}),
  fetch: (url, options) => {
    const original = new URL(url);
    if (original.origin !== 'https://test.lab.sourceof.love') throw new Error('Unexpected fixture publication destination.');
    return fetch(`http://127.0.0.1:${server.address().port}${original.pathname}${original.search}`, options)
      .then(response => Object.defineProperty(response, 'url', {value: String(url)}));
  }});
console.log(JSON.stringify({...receipt, port: server.address().port}));
