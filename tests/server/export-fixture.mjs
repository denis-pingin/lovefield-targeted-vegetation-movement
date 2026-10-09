// Drive the actual collection API with deterministic provider and device clocks.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {harness,api} from './service-fixtures.mjs';
import {defaultConfig} from '../../web/run-config.mjs';
import {measureClock} from '../../web/clock.mjs';
import {cueEventData} from '../../web/app.mjs';
import {createStartRegistry} from '../../server/start-registry.mjs';
import {registryFixture} from './start-registry-fixtures.mjs';

const [directory,imageSha256,purpose='preparation',codeCheckpoint='a'.repeat(40)]=process.argv.slice(2);
assert.ok(['preparation','scored'].includes(purpose));
let now=1000000,actionSequence=0;
const startFixture=registryFixture();
const broadcast=startFixture.chain.broadcast;
startFixture.chain.broadcast=async bytes=>{
  const hash=await broadcast(bytes),prepared=startFixture.prepared.find(item=>item.result.transactionHash===hash);
  startFixture.receipts.set(hash,{...startFixture.confirmed(hash,prepared.identity),chainTimestamp:Math.floor(now/1000)});
  return hash;
};
const startRegistry=createStartRegistry({...startFixture.options,clock:()=>now});
const h=harness(['A','B'],{codeCheckpoint,scoredCollectionEnabled:purpose==='scored',startRegistry});
const time=value=>{now=value;h.setTime(value);};
async function responseValue(response,status=200){
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
}
time(now);
const setup=await responseValue(await h.service.fetch(api('setups','POST',{
  imageSha256,imageSize:{width:180,height:120},cameraProfile:'Synthetic original 180x120',
  regions:{A:[[5,10],[55,10],[55,110],[5,110]],B:[[65,10],[115,10],[115,110],[65,110]],
    background:[[125,10],[175,10],[175,110],[125,110]]}
})),201);
const config=defaultConfig('tree',purpose);
Object.assign(config.tree,{count:1,preRollSeconds:1,postRollSeconds:1,responseSeconds:2,recoverySeconds:0});
if(purpose==='scored')config.setupId=setup.setupId;
time(999000);
const series=await responseValue(await h.service.fetch(api('series','POST',{label:purpose==='scored'?'Software test only - generated video':'End-to-end preparation',config})),201);
if(purpose==='scored'){
  const key=`tree-targeting:series:${series.seriesId}`,saved=await h.storage.get(key);
  saved.qualification={profileHash:series.profileHash,codeCheckpoint,software:'pass',realFootage:'pass',phone:'pass',clock:'pass'};
  await h.storage.put(key,saved);
  await responseValue(await h.service.fetch(api(`series/${series.seriesId}/freeze`,'POST',{})));
}
time(999001);
await responseValue(await h.service.fetch(api('runs','POST',{runId:'unstarted-configuration',seriesId:series.seriesId})),201);
const cases=purpose==='scored'?[['completed-one',1000000,false],['pending-collected',1020000,false],['missing-stopped',1040000,true]]
  :[['earlier-stopped',1000000,true],['later-completed',1020000,false]];
for(const [runId,base,stopped] of cases){
  time(base-200);
  await responseValue(await h.service.fetch(api('runs','POST',{runId,seriesId:series.seriesId})),201);
  const send=async(kind,data={},clientAtMs=now)=>responseValue(await h.service.fetch(api(`runs/${runId}/actions`,'POST',{
    actionId:`${kind}-${++actionSequence}`,kind,deviceId:'phone',clientAtMs,data
  })));
  await send('attachSetup',{setupId:setup.setupId});
  await send('prepare');
  const designated=await send('designatePlayback',{deviceId:'phone'});
  const token=designated.playbackToken;
  await send('testAudioPlayed',{deviceId:'phone',playbackToken:token});
  let wallSequence=0,monotonicSequence=0;
  const reference=await measureClock({
    wallNow:()=>base-100+wallSequence++*.1,
    monotonicNow:()=>monotonicSequence++*.1,
    exchange:async({clientSentAtMs})=>{time(clientSentAtMs+.05);return responseValue(await h.service.fetch(api('clock')));}
  });
  assert.equal(reference.valid,true);
  time(base-90);await send('saveClockReference',{reference,deviceId:'phone'});
  time(base);await send('recordingReady');await send('start');
  async function play(at){
    time(at);const cue=(await h.store.readRun(runId)).state.pendingDelivery;
    for(const kind of ['cuePlayed','cueEnded']){
      const event={kind,cueId:cue.cueId,clientAtMs:at-reference.offsetMs};
      await send(kind,cueEventData(event,reference,'phone',token),event.clientAtMs);
    }
  }
  time(base+1000);await h.service.advanceDeadline(runId);
  await play(base+1000.5);
  time(base+1500);await send('arrived');
  if(stopped){await send('stop');}
  else{
    await play(base+1600.5);
    time(base+3600.5);await h.service.advanceDeadline(runId);
    await play(base+3700.5);
    time(base+4000);await send('away');
    time(base+5000);await h.service.advanceDeadline(runId);
  }
  const exported=await h.service.fetch(api(`runs/${runId}/export`));
  assert.equal(exported.status,200);
  const raw=await exported.text();
  assert.ok(!raw.includes(token));assert.ok(!raw.includes('"playbackToken"'));
  await writeFile(join(directory,runId+'.json'),raw);
}
const retainedSeries=await responseValue(await h.service.fetch(api(`series/${series.seriesId}/export`)));
assert.deepEqual(retainedSeries.collectionRunIds,cases.map(([runId])=>runId));
for(const member of retainedSeries.members){
  const run=await h.store.readRun(member.runId);
  assert.equal(member.configHash,run.configHash);
  assert.equal(member.profileHash,run.profileHash);
}
await writeFile(join(directory,'series.json'),JSON.stringify(retainedSeries));
