import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectArtifactIdentity} from '../../server/publication-identity.mjs';

function chunks(text, size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({start(controller) {
    for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.subarray(offset, offset + size));
    controller.close();
  }});
}
const paths = [['runId'], ['result', 'revisionId'], ['inputHashes']];

test('identity selection handles UTF-8, escaped strings, numbers and nested skipped values across every byte boundary', async () => {
  const text = '{"skip":[{"text":"quotes \\\" and braces } ] and \\u0022","n":-1.25e+4},true,null],"runId":"recording-☀","result":{"measurements":[[1,2],{}],"revisionId":"analysis\\u002done"},"inputHashes":{"video":"abc"}}';
  assert.deepEqual(await selectArtifactIdentity(chunks(text), paths), {
    runId: 'recording-☀', result: {revisionId: 'analysis-one'}, inputHashes: {video: 'abc'},
  });
});

test('large unselected strings and arrays do not consume the selected metadata allowance', async () => {
  const text = JSON.stringify({measurements: ['x'.repeat(100000), [1, 2, 3]], runId: 'recording-one'});
  assert.deepEqual(await selectArtifactIdentity(chunks(text, 4096), [['runId']], {maximumBytes: 40}), {runId: 'recording-one'});
  await assert.rejects(selectArtifactIdentity(chunks(JSON.stringify({inputHashes: {video: 'x'.repeat(100)}})), paths, {maximumBytes: 40}), /identity metadata exceeds/);
});

test('malformed JSON, duplicate identity branches and invalid UTF-8 are rejected while missing fields remain missing', async () => {
  for (const text of ['{"skip":[1,],"runId":"one"}', '{"runId":"unterminated}', '{"runId":"bad\\q"}', '{"skip":01,"runId":"one"}', '{"skip":tru,"runId":"one"}', '{"runId":"one"} garbage', '{"result":{"revisionId":"one"},"result":{}}']) {
    await assert.rejects(selectArtifactIdentity(chunks(text), paths), /invalid|duplicate/i, text);
  }
  assert.deepEqual(await selectArtifactIdentity(chunks('{"skip":{"runId":"nested"}}'), paths), {});
  const invalid = new ReadableStream({start(controller) { controller.enqueue(Uint8Array.of(0xff)); controller.close(); }});
  await assert.rejects(selectArtifactIdentity(invalid, paths), /UTF-8|invalid/i);
});
