import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../../web/run-config.mjs';
import {runConfigFromFields,repeatRunRequest,seriesRequestFromFields,applicationSurface} from '../../web/app.mjs';
import {PAGES,renderPage} from '../../web/views.mjs';

test('field settings create only Tree and retain exact fractional timing',()=>{
  const config=runConfigFromFields({tree_response:'2.4',tree_recovery:'0',tree_count:'3',purpose:'preparation'},defaultConfig('tree'));
  assert.equal(config.mode,'tree');assert.equal(config.tree.responseSeconds,2.4);assert.equal(config.tree.count,3);
  assert.equal(config.global,undefined);assert.equal(config.local,undefined);
  const repeated=repeatRunRequest({config,runId:'one',tag:'Oak'});
  assert.deepEqual(repeated.config,config);assert.equal(repeated.runId,undefined);
  assert.equal(PAGES.includes('global'),false);assert.equal(PAGES.includes('local'),false);
  assert.equal(applicationSurface('/tree-targeting/'),'hosted');
});

test('series field request declares open preparation identity without planned slots',()=>{
  const request=seriesRequestFromFields({label:'Oak sequence'});
  assert.equal(request.label,'Oak sequence');assert.equal(request.config.purpose,'preparation');
  assert.equal(request.config.mode,'tree');assert.equal(request.plannedTreeBlocks,undefined);
});

test('Tree instructions refer to the one camera and the available run actions',()=>{
  const config=defaultConfig('tree');
  const model={runId:null,mode:'tree',purpose:'preparation',actions:{},completedCount:0,connection:{connected:true}};
  const connection={connected:true};
  const first=renderPage('study',{model,config,connection});
  assert.match(first,/Create or open a Tree run/);
  const prepared=renderPage('tree',{model:{...model,runId:'one',lifecycle:'prepared'},connection});
  assert.match(prepared,/keep the camera recording running/);
  const recordings=renderPage('recordings',{model:{...model,runId:'one',terminal:true},connection});
  assert.match(recordings,/>Export run<\/a>/);
});
