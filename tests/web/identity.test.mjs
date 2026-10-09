import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPERIMENT} from '../../web/run-config.mjs';

test('Tree transport uses its independent path and API identity', () => {
  assert.equal(EXPERIMENT.slug, 'tree-targeting');
  assert.equal(EXPERIMENT.path, '/tree-targeting/');
  assert.equal(EXPERIMENT.apiPath, '/tree-targeting/api/');
  assert.equal(EXPERIMENT.basePath, EXPERIMENT.path);
  assert.equal(EXPERIMENT.apiBasePath, EXPERIMENT.apiPath);
});
