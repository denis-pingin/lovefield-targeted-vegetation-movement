import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWorkerHandler} from '../../server/worker.mjs';

function fixture(environment = 'test', enabled = false, assetFiles = new Map(), apiResponse = () => new Response('api')) {
  const forwarded = [], assets = [], names = [];
  const handler = createWorkerHandler({authenticate: async request => {
    const role = request.headers.get('X-Test-Role');
    if (!role) throw Object.assign(new Error('Denied'), {status: 403, code: 'access_missing'});
    return {id: role + '-fixture', role};
  }});
  const env = {RELEASE_ENVIRONMENT: environment, PUBLIC_STUDY_ENABLED: enabled ? 'true' : 'false',
    ASSETS: {fetch: async request => {const path = new URL(request.url).pathname; assets.push(path); return new Response(assetFiles.get(path) ?? 'asset');}},
    TREE_SESSIONS: {idFromName: name => {names.push(name); return name;}, get: () => ({fetch: async request => {forwarded.push(request); return apiResponse(request);}})}};
  const fetch = (path, role, method = 'GET', headers = {}, body) => handler.fetch(new Request(`https://test.lab.sourceof.love${path}`, {
    method, headers: {...headers, ...(role ? {'X-Test-Role': role} : {})}, ...(body === undefined ? {} : {body})}), env);
  return {fetch, forwarded, assets, names};
}

test('Test public pages, shared assets and direct files all require operator sign-in', async () => {
  const f = fixture();
  for (const path of ['/studies/targeted-vegetation-movement/', '/studies/targeted-vegetation-movement/public/',
    '/studies/targeted-vegetation-movement/public/tree-results.mjs', '/studies/targeted-vegetation-movement/public/api/latest',
    '/studies/targeted-vegetation-movement/public/api/publications/11111111-1111-4111-8111-111111111111/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/video.mp4']) assert.equal((await f.fetch(path)).status, 403);
  assert.equal((await f.fetch('/studies/targeted-vegetation-movement/public/', 'operator')).status, 200);
  assert.equal((await f.fetch('/studies/targeted-vegetation-movement/public/app.mjs', 'operator')).status, 404);
  assert.equal((await f.fetch('/studies/targeted-vegetation-movement/public/api/runs/next-assignment', 'operator')).status, 404);
  assert.equal((await f.fetch('/studies/targeted-vegetation-movement/public/api/latest', 'operator', 'POST')).status, 405);
});

test('publisher and operator routes remain distinct and internal actor headers are replaced', async () => {
  const f = fixture();
  assert.equal((await f.fetch('/studies/targeted-vegetation-movement/app/api/publication/jobs', 'operator', 'POST')).status, 403);
  assert.equal((await f.fetch('/studies/targeted-vegetation-movement/app/api/runs/run-1/actions', 'publisher', 'POST')).status, 403);
  assert.equal((await f.fetch('/studies/targeted-vegetation-movement/app/api/publication/jobs', 'publisher', 'POST', {'X-Tree-Actor': 'forged', 'X-Tree-Actor-Role': 'operator'})).status, 200);
  assert.equal(f.forwarded[0].headers.get('X-Tree-Actor'), 'publisher-fixture');
  assert.equal(f.forwarded[0].headers.get('X-Tree-Actor-Role'), 'publisher');
  assert.equal((await f.fetch('/tree-targeting/api/runs', 'operator')).status, 200);
});

test('Production public reading requires an explicit release flag and never opens controls', async () => {
  const inactive = fixture('production');
  assert.equal((await inactive.fetch('/studies/targeted-vegetation-movement/public/')).status, 403);
  const active = fixture('production', true);
  assert.equal((await active.fetch('/studies/targeted-vegetation-movement/public/')).status, 200);
  assert.equal((await active.fetch('/studies/targeted-vegetation-movement/public/api/latest')).status, 200);
  assert.equal((await active.fetch('/studies/targeted-vegetation-movement/app/')).status, 403);
  assert.equal((await active.fetch('/studies/targeted-vegetation-movement/public/api/latest', null, 'POST')).status, 405);
});

test('legacy bookmarks preserve selected run query and fragments while the bare study opens public reading', async () => {
  const f = fixture();
  assert.equal((await f.fetch('/tree-targeting/?run=chosen#tree', 'operator')).headers.get('location'),
    'https://test.lab.sourceof.love/studies/targeted-vegetation-movement/app/?run=chosen#tree');
  assert.equal((await f.fetch('/studies/targeted-vegetation-movement/', 'operator')).headers.get('location'),
    'https://test.lab.sourceof.love/studies/targeted-vegetation-movement/public/');
});

test('approved nested public delivery assets reach their exact package path and arbitrary private paths stay unavailable', async () => {
  const names = ['lab-public.mjs', 'public-study.css', 'public-study-figure.mjs', 'public-study-illustration.mjs',
    'public-study-navigation.mjs', 'public-study-document.mjs', 'vendor/marked.mjs',
    'visual-identity/visual-identity.css', 'visual-identity/global.css', 'visual-identity/site-page.css', 'visual-identity/reading.css',
    'visual-identity/archivo.woff2', 'visual-identity/OFL.txt', 'visual-identity/identity-mark.svg',
    'visual-identity/energy-branches-magenta.webp', 'visual-identity/energy-branches-cyan.webp',
    'study-media/tree-tracking.webp', 'study-media/tree-tracking-1600.webp',
    'current-study/study.json', 'current-study/protocol.md', 'current-study/analysis-methods.md', 'current-study/source.zip'];
  const files = new Map(names.map((name, index) => [`/${name}`, Uint8Array.of(0, index, 255, 64)]));
  const f = fixture('test', false, files);
  for (const name of names) {
    const path = `/studies/targeted-vegetation-movement/public/${name}`;
    assert.equal((await f.fetch(path)).status, 403);
    const response = await f.fetch(path, 'operator');
    assert.equal(response.status, 200, name);
    assert.equal(f.assets.at(-1), `/${name}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), files.get(`/${name}`));
  }
  const before = f.assets.length;
  for (const path of ['visual-identity/private.svg', 'visual-identity/private.txt', 'study-media/private.webp', 'vendor/private.mjs', 'app.mjs', 'source-inventory.json', 'current-study/private.json']) {
    assert.equal((await f.fetch(`/studies/targeted-vegetation-movement/public/${path}`, 'operator')).status, 404, path);
  }
  assert.equal(f.assets.length, before);
});

test('shared Lab pages use the reader shell with protected Test and explicitly enabled read-only Production access', async () => {
  const protectedLab = fixture(), inactiveLab = fixture('production'), publicLab = fixture('production', true);
  for (const path of ['/studies', '/studies/', '/studies/legal', '/studies/legal/', '/studies/privacy',
    '/studies/privacy/', '/studies/reuse', '/studies/reuse/', '/studies/research-notice', '/studies/research-notice/']) {
    assert.equal((await protectedLab.fetch(path)).status, 403, path);
    assert.equal((await protectedLab.fetch(path, 'operator')).status, 200, path);
    assert.equal(protectedLab.assets.at(-1), '/public-study');
    assert.equal((await inactiveLab.fetch(path)).status, 403, path);
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await publicLab.fetch(path, null, method)).status, 200, path);
      assert.equal(publicLab.assets.at(-1), '/public-study');
    }
    assert.equal((await publicLab.fetch(path, null, 'POST')).status, 405, path);
  }
  for (const path of ['/studies/private', '/studies/legal/private', '/studies/privacy-other', '/studies/api/latest',
    '/studies/lab-public.mjs', '/studies//', '/studies/targeted-vegetation-movement/public/app.mjs']) {
    assert.equal((await publicLab.fetch(path)).status, 404, path);
  }
  assert.equal((await publicLab.fetch('/')).status, 403);
  assert.equal((await publicLab.fetch('/studies/targeted-vegetation-movement/app/')).status, 403);
});

test('scientific document routes use the public reader shell under the existing access rules', async () => {
  const protectedStudy = fixture(), publicStudy = fixture('production', true);
  for (const path of ['protocol', 'protocol/', 'methods/analysis', 'methods/analysis/']) {
    const url = `/studies/targeted-vegetation-movement/public/${path}?publication=11111111-1111-4111-8111-111111111111`;
    assert.equal((await protectedStudy.fetch(url)).status, 403);
    assert.equal((await protectedStudy.fetch(url, 'operator')).status, 200);
    assert.equal(protectedStudy.assets.at(-1), '/public-study');
    assert.equal((await publicStudy.fetch(url)).status, 200);
    assert.equal(publicStudy.assets.at(-1), '/public-study');
  }
  assert.equal((await publicStudy.fetch('/studies/targeted-vegetation-movement/public/methods/private')).status, 404);
  assert.equal((await publicStudy.fetch('/studies/targeted-vegetation-movement/app/')).status, 403);
});

test('Reproducibility uses the existing reader with protected Test, inactive Production and explicit read-only public activation', async () => {
  const protectedStudy = fixture(), inactiveStudy = fixture('production'), publicStudy = fixture('production', true);
  for (const path of ['reproducibility', 'reproducibility/']) {
    const url = `/studies/targeted-vegetation-movement/public/${path}?publication=11111111-1111-4111-8111-111111111111`;
    assert.equal((await protectedStudy.fetch(url)).status, 403);
    assert.equal((await protectedStudy.fetch(url, 'operator')).status, 200);
    assert.equal(protectedStudy.assets.at(-1), '/public-study');
    assert.equal((await inactiveStudy.fetch(url)).status, 403);
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await publicStudy.fetch(url, null, method)).status, 200);
      assert.equal(publicStudy.assets.at(-1), '/public-study');
    }
    assert.equal((await publicStudy.fetch(url, null, 'POST')).status, 405);
  }
  assert.equal((await publicStudy.fetch('/studies/targeted-vegetation-movement/public/reproducibility/private')).status, 404);
  assert.equal((await publicStudy.fetch('/studies/targeted-vegetation-movement/app/')).status, 403);
  assert.equal(publicStudy.forwarded.length, 0);
});


const canonicalBase = '/studies/targeted-vegetation-movement/', oldHostedBase = '/studies/tree-targeting/';

test('old reader bookmarks and current-material links redirect only after the same access and method checks', async () => {
  const publicationId = '11111111-1111-4111-8111-111111111111';
  const selected = '?publication=' + publicationId + '&kept=value#recording-one';
  const pages = ['', 'results', 'recordings/recording-one', 'protocol', 'methods/analysis',
    'reproducibility', 'current-study/protocol.md', 'visual-identity/archivo.woff2'];
  for (const f of [fixture(), fixture('production', true)]) {
    for (const page of pages) {
      const path = oldHostedBase + 'public/' + page + selected;
      const response = await f.fetch(path, 'operator');
      assert.equal(response.status, 308, page);
      assert.equal(response.headers.get('location'), 'https://test.lab.sourceof.love' + canonicalBase + 'public/' + page + selected);
      assert.equal((await f.fetch(path, 'operator', 'HEAD')).status, 308, page);
      assert.equal((await f.fetch(path, 'operator', 'POST')).status, 405, page);
    }
  }
  const protectedStudy = fixture();
  for (const page of pages) assert.equal((await protectedStudy.fetch(oldHostedBase + 'public/' + page)).status, 403, page);
  const publicStudy = fixture('production', true);
  for (const page of pages) assert.equal((await publicStudy.fetch(oldHostedBase + 'public/' + page)).status, 308, page);
  for (const base of [canonicalBase, oldHostedBase]) {
    const response = await protectedStudy.fetch(base + selected, 'operator');
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://test.lab.sourceof.love' + canonicalBase + 'public/' + selected);
  }
  const operator = await protectedStudy.fetch(oldHostedBase + 'app/?run=retained#tree', 'operator');
  assert.equal(operator.status, 308);
  assert.equal(operator.headers.get('location'), 'https://test.lab.sourceof.love' + canonicalBase + 'app/?run=retained#tree');
  assert.equal((await protectedStudy.fetch(oldHostedBase + 'app/')).status, 403);
});

test('old and canonical publication uploads preserve method, exact bytes and publisher actor without a redirect', async () => {
  const response = new Response('uploaded', {status: 201});
  const f = fixture('test', false, new Map(), () => response);
  const body = Uint8Array.of(0, 255, 11, 32, 64);
  for (const base of [canonicalBase, oldHostedBase]) {
    const path = base + 'app/api/publication/jobs/11111111-1111-4111-8111-111111111111/files/' + 'a'.repeat(64) + '/parts/1?kept=value';
    assert.equal(await f.fetch(path, 'publisher', 'PUT', {'X-Tree-Actor': 'forged', 'X-Tree-Actor-Role': 'operator',
      'CF-Access-Client-Id': 'synthetic-client-id', 'CF-Access-Client-Secret': 'synthetic-secret', 'Cf-Access-Jwt-Assertion': 'synthetic-assertion'}, body), response);
    const forwarded = f.forwarded.at(-1);
    assert.equal(new URL(forwarded.url).pathname, path.split('?')[0]);
    assert.equal(new URL(forwarded.url).search, '?kept=value');
    assert.equal(forwarded.method, 'PUT');
    assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), body);
    assert.equal(forwarded.headers.get('X-Tree-Actor'), 'publisher-fixture');
    assert.equal(forwarded.headers.get('X-Tree-Actor-Role'), 'publisher');
    for (const name of ['CF-Access-Client-Id', 'CF-Access-Client-Secret', 'Cf-Access-Jwt-Assertion']) assert.equal(forwarded.headers.get(name), null);
    assert.equal((await f.fetch(path, 'operator', 'PUT', {}, body)).status, 403);
  }
  for (const base of [canonicalBase, oldHostedBase]) {
    assert.equal(await f.fetch(base + 'app/api/publication/jobs', 'publisher', 'POST', {'Content-Type': 'application/json'}, '{"saved":"bytes"}'), response);
    const forwarded = f.forwarded.at(-1);
    assert.equal(forwarded.method, 'POST'); assert.equal(await forwarded.text(), '{"saved":"bytes"}');
  }
  assert.deepEqual(f.names, ['tree-targeting', 'tree-targeting', 'tree-targeting', 'tree-targeting']);
});

test('legacy and canonical public downloads retain byte ranges and the same retained session', async () => {
  const response = new Response(Uint8Array.of(255, 11, 32), {status: 206, headers: {'Content-Range': 'bytes 1-3/5'}});
  const f = fixture('production', true, new Map(), () => response);
  for (const base of [canonicalBase, oldHostedBase]) {
    const path = base + 'public/api/publications/11111111-1111-4111-8111-111111111111/files/' + 'a'.repeat(64) + '/camera.mp4';
    assert.equal(await f.fetch(path, null, 'GET', {Range: 'bytes=1-3'}), response);
    assert.equal(f.forwarded.at(-1).headers.get('Range'), 'bytes=1-3');
    assert.equal(new URL(f.forwarded.at(-1).url).pathname, path);
    assert.equal(f.forwarded.at(-1).headers.get('X-Tree-Actor-Role'), 'reader');
    assert.equal((await f.fetch(path, null, 'PUT', {}, 'denied')).status, 405);
  }
  assert.deepEqual(f.names, ['tree-targeting', 'tree-targeting']);
});

test('old and canonical controls keep role separation and event upgrades intact', async () => {
  const response = {status: 101, webSocket: {}};
  const f = fixture('test', false, new Map(), () => response);
  for (const base of [canonicalBase, oldHostedBase]) {
    assert.equal((await f.fetch(base + 'app/api/runs/run-one/actions', 'publisher', 'POST', {}, '{}')).status, 403);
    assert.equal((await f.fetch(base + 'app/api/publication/jobs', 'operator', 'POST', {}, '{}')).status, 403);
    assert.equal(await f.fetch(base + 'app/api/events?run=retained', 'operator', 'GET', {Upgrade: 'websocket'}), response);
    assert.equal(f.forwarded.at(-1).headers.get('Upgrade'), 'websocket');
    assert.equal(f.forwarded.at(-1).headers.get('X-Tree-Actor'), 'operator-fixture');
  }
  assert.equal(await f.fetch('/tree-targeting/api/events?run=retained', 'operator', 'GET', {Upgrade: 'websocket'}), response);
  assert.deepEqual(f.names, ['tree-targeting', 'tree-targeting', 'tree-targeting']);
  for (const path of ['/studies/targeted-vegetation-movement-other/public/', '/studies/tree-targetings/public/',
    canonicalBase + 'public/private', oldHostedBase + 'public/private']) {
    assert.equal((await f.fetch(path, 'operator')).status, 404, path);
  }
});
