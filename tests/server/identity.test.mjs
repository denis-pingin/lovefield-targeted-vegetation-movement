import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig, validateConfig} from '../../web/run-config.mjs';
import {createWorkerHandler} from '../../server/worker.mjs';

for (const mode of ['local','global']) test(`Tree collection rejects ${mode}`, () => {
  assert.throws(() => defaultConfig(mode), /Tree|tree/);
  assert.throws(() => validateConfig({...defaultConfig('tree'), mode}), /Tree|tree/);
});
test('Tree configuration is independent and permits fractional response seconds', () => {
  const config = defaultConfig('tree');
  assert.equal(config.analysisProfileId, 'tree-development-1');
  assert.equal(config.global, undefined);
  assert.equal(config.local, undefined);
  assert.equal(validateConfig({...config, tree: {...config.tree, responseSeconds: 2.4}}).tree.responseSeconds, 2.4);
});
test('Tree root selector authenticates and lists both registered studies', async () => {
  const worker = createWorkerHandler({authenticate: async request => {
    if (!request.headers.get('X-Test-Access')) throw Object.assign(new Error('Missing'), {status:403,code:'access_missing'});
    return {id:'operator'};
  }});
  assert.equal((await worker.fetch(new Request('https://test.lab.sourceof.love/'), {})).status,403);
  const response = await worker.fetch(new Request('https://test.lab.sourceof.love/', {headers:{'X-Test-Access':'yes'}}), {});
  assert.equal(response.status,200);
  const page = await response.text();
  const links = [...page.matchAll(/<a href="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(links, ['/wind-prestudy/', '/studies/targeted-vegetation-movement/app/']);
  assert.match(page, /<link rel="stylesheet" href="\/tree-targeting\/app.css">/);
  assert.match(page, /<div class="button-row">/);
  assert.match(page, />Targeted Vegetation Movement<\/a>/);
});
