import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../../web/run-config.mjs';
import {api,harness,action,ready,play} from './service-fixtures.mjs';

for(const recovery of [0,1])test(`full handler Tree rehearsal with ${recovery} recovery and fractional playback`,async()=>{
  const h=harness(),config=defaultConfig('tree');
  Object.assign(config.tree,{preRollSeconds:1,postRollSeconds:1,responseSeconds:2,recoverySeconds:recovery,announceRelease:recovery>0,count:3});
  await ready(h,'rehearsal',config);
  h.setTime(2000);await h.service.advanceDeadline('rehearsal');
  assert.equal((await play(h,'rehearsal',2000.5)).text,'Approach');
  h.setTime(2500);assert.equal((await action(h.service,'rehearsal','arrived','arrived')).status,200);
  for(let index=0;index<3;index++){
    let record=await h.store.readRun('rehearsal');
    const onset=3000.5+index*(3000+recovery*1000);
    const cue=await play(h,'rehearsal',onset);
    assert.equal(cue.text,'Target '+['A','A','B'][index]);
    record=await h.store.readRun('rehearsal');
    assert.equal(record.state.currentTrial.response[0],onset);
    const reconnect=await(await h.service.fetch(api('runs/rehearsal'))).json();
    assert.equal(reconnect.currentInstruction,cue.text);
    const before=h.randomService.drawn.length;
    assert.equal((await action(h.service,'rehearsal','arrived','arrived')).status,200);
    assert.equal(h.randomService.drawn.length,before);
    h.setTime(onset+2000);await h.service.advanceDeadline('rehearsal');
    if(recovery&&index<2){
      await play(h,'rehearsal',onset+2100);
      h.setTime(onset+3000);await h.service.advanceDeadline('rehearsal');
    }
  }
  const record=await h.store.readRun('rehearsal');
  assert.equal(record.state.completedCount,3);
  assert.equal(record.state.phase,'TREE_WAIT_DEPART');
  await play(h,'rehearsal',15000.5);
  h.setTime(16000);await action(h.service,'rehearsal','away','away');
  h.setTime(17000);await h.service.advanceDeadline('rehearsal');
  const exported=await h.service.fetch(api('runs/rehearsal/export'));
  assert.equal(exported.status,200);
  const bundle=await exported.json();
  assert.equal(bundle.experimentSlug,'tree-targeting');
  assert.equal(bundle.state.lifecycle,'completed');
  assert.deepEqual(bundle.tickets.filter(ticket=>ticket.status==='issued').map(ticket=>ticket.rules[String(ticket.result.random.data[0])]),['A','A','B']);
  assert.equal(bundle.cues.filter(cue=>cue.stream==='tree').length,3);
});

test('stopped handler export retains generated undelivered assignment',async()=>{
  const h=harness(['A']),config=defaultConfig('tree');config.tree.preRollSeconds=1;
  await ready(h,'interrupted',config);h.setTime(2000);await h.service.advanceDeadline('interrupted');
  await play(h,'interrupted',2000.5);h.setTime(2500);await action(h.service,'interrupted','arrived','arrived');
  assert.equal((await action(h.service,'interrupted','stop','stopped')).status,200);
  const response=await h.service.fetch(api('runs/interrupted/export'));assert.equal(response.status,200);
  const bundle=await response.json();assert.equal(bundle.state.lifecycle,'stopped');
  assert.equal(bundle.tickets.filter(ticket=>ticket.status==='issued').length,1);
  assert.equal(bundle.cues.find(cue=>cue.stream==='tree').playedAtMs,null);
});
