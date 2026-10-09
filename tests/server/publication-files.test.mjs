import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publicationFixture} from './publication-fixtures.mjs';

test('published files support HEAD and single byte ranges and reject unpublished hashes', async () => {
  const f = publicationFixture(), fixture = f.manifest(), id = fixture.manifest.publicationId;
  const path = `publications/${id}/files/${fixture.original}/camera.mp4`;
  assert.equal((await f.publicRequest(path)).status, 404);
  assert.equal((await f.complete(fixture)).status, 200);
  const head = await f.publicRequest(path, {method: 'HEAD'});
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(fixture.bytes.get(fixture.original).length));
  assert.equal(await head.text(), '');
  for (const [range, expected] of [['bytes=1-3', 'ame'], ['bytes=-3', 'nal'], ['bytes=7-', 'original']]) {
    const result = await f.publicRequest(path, {headers: {Range: range}});
    assert.equal(result.status, 206); assert.equal(await result.text(), expected);
  }
  for (const range of ['bytes=999-', 'bytes=3-1', 'bytes=0-1,4-5', 'other=0-2']) {
    assert.equal((await f.publicRequest(path, {headers: {Range: range}})).status, 416);
  }
  assert.equal((await f.publicRequest(path, {method: 'POST'})).status, 405);
  assert.equal((await f.publicRequest(`publications/${id}/files/${fixture.original}/wrong.mp4`)).status, 404);
  assert.equal((await f.publicRequest(`publications/${id}/reports/${fixture.original}`)).status, 404);
});
