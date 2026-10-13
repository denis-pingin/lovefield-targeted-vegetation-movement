import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunState} from '../../server/run-engine.mjs';
import {createService} from '../../server/worker.mjs';
import {defaultConfig} from '../../web/run-config.mjs';
import {api,harness,ready,play,action} from './service-fixtures.mjs';
import areaProfile from '../../analysis-profile-area.json' with {type: 'json'};
const unsupportedProfile = structuredClone(areaProfile);
unsupportedProfile.version = 'tree-profile-development-1';
unsupportedProfile.profileId = 'unsupported-settings';
delete unsupportedProfile.video.measurement;

async function profileHash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Buffer.from(bytes).toString('hex');
}

const qualification = series => ({profileHash: series.profileHash, codeCheckpoint: series.codeCheckpoint,
  software: 'pass', realFootage: 'pass', phone: 'pass', clock: 'pass'});

test('preparation cannot prepare an unsupported saved profile or request tickets', async () => {
  const h = harness(['A']);
  const config = defaultConfig('tree'); config.analysisProfileId = unsupportedProfile.profileId;
  await h.store.createRun({runId: 'unsupported-preparation', experimentSlug: 'tree-targeting', config,
    profile: unsupportedProfile, state: {...createRunState(config, 1000, 'unsupported-preparation'), lifecycle: 'draft'},
    codeCheckpoint: 'a'.repeat(40), tickets: []});
  const before = structuredClone(h.storage.values);
  const response = await action(h.service, 'unsupported-preparation', 'prepare', 'reject-prepare');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_profile');
  assert.deepEqual(h.storage.values, before);
  assert.equal(h.randomService.drawn.length, 0);
});

test('grid scored draft freezes exact settings and source through prepare, registered Start and export', async () => {
  const registrations = [];
  const h = harness(['A'], {scoredCollectionEnabled: true, startRegistry: {async ensureStart(identity) {
    registrations.push(identity);
    return {status: 'confirmed', registration: {identity}};
  }}});
  const setup = await (await h.service.fetch(api('setups', 'POST', {imageSha256: 'a'.repeat(64),
    imageSize: {width: 180, height: 120}, cameraProfile: 'Synthetic grid camera', regions: {
      A: [[5,10],[55,10],[55,110],[5,110]], B: [[65,10],[115,10],[115,110],[65,110]],
      background: [[125,10],[175,10],[175,110],[125,110]]}}))).json();
  const config = defaultConfig('tree', 'scored');
  config.setupId = setup.setupId;
  Object.assign(config.tree, {preRollSeconds: 1, postRollSeconds: 1, count: 1});
  const created = await h.service.fetch(api('series', 'POST', {config}));
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const series = await created.json();
  assert.equal(series.profile.video.measurement.method, 'area-grid-mean-v1');
  assert.equal(JSON.parse(series.sealedProfileJson).profileId, config.analysisProfileId);
  assert.equal(series.profileHash, await profileHash(series.profile));
  const key = `tree-targeting:series:${series.seriesId}`;
  assert.equal((await h.service.fetch(api(`series/${series.seriesId}/freeze`, 'POST', {}))).status, 409);
  const saved = await h.storage.get(key);
  saved.qualification = {...qualification(series), profileHash: 'b'.repeat(64)};
  await h.storage.put(key, saved);
  assert.equal((await h.service.fetch(api(`series/${series.seriesId}/freeze`, 'POST', {}))).status, 409);
  saved.qualification = qualification(series);
  await h.storage.put(key, saved);
  assert.equal((await h.service.fetch(api(`series/${series.seriesId}/freeze`, 'POST', {}))).status, 200);
  const member = await h.service.fetch(api('runs', 'POST', {runId: 'grid-scored', seriesId: series.seriesId}));
  assert.equal(member.status, 201, JSON.stringify(await member.clone().json()));
  assert.equal((await action(h.service, 'grid-scored', 'attachSetup', 'setup', {setupId: setup.setupId})).status, 200);
  await ready(h, 'grid-scored', config, {existing: true});
  h.setTime(2000); await h.service.advanceDeadline('grid-scored');
  await play(h, 'grid-scored', 2000.5);
  h.setTime(2100); await action(h.service, 'grid-scored', 'arrived', 'arrived');
  await action(h.service, 'grid-scored', 'stop', 'stop');
  const exported = await h.service.fetch(api('runs/grid-scored/export'));
  assert.equal(exported.status, 200);
  const bundle = await exported.json();
  assert.equal(bundle.sealedProfileJson, series.sealedProfileJson);
  assert.equal(bundle.profileHash, series.profileHash);
  assert.equal(bundle.configHash, series.configHash);
  assert.equal(bundle.codeCheckpoint, series.codeCheckpoint);
  assert.equal(bundle.startRegistration.registration.identity.configHash, `0x${series.configHash}`);
  assert.deepEqual(registrations, [bundle.startRegistration.registration.identity]);
  assert.equal(h.randomService.drawn.length, 1);
});

test('named tuned grid profiles are scored by method and retain every supplied setting', async () => {
  const h = harness(['A'], {scoredCollectionEnabled: true});
  const profile = structuredClone(areaProfile);
  profile.profileId = 'custom-grid'; profile.label = 'My canopy';
  Object.assign(profile.video.measurement, {cellSizePixels: 96, pointsPerCell: 24,
    minimumTracksPerCell: 4, minimumSpatialCoverageFraction: .98, refreshPolicy: 'continuous'});
  const config = defaultConfig('tree', 'scored'); config.analysisProfileId = profile.profileId;
  const created = await h.service.fetch(api('series', 'POST', {config, profile}));
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const series = await created.json(); assert.deepEqual(series.profile, profile);
  const key = `tree-targeting:series:${series.seriesId}`, saved = await h.storage.get(key);
  saved.qualification = qualification(series); await h.storage.put(key, saved);
  assert.equal((await h.service.fetch(api(`series/${series.seriesId}/freeze`, 'POST', {}))).status, 200);
  assert.equal((await h.service.fetch(api('runs', 'POST', {runId: 'custom-member', seriesId: series.seriesId}))).status, 201);
  assert.deepEqual((await h.store.readRun('custom-member')).profile, profile);
});

for (const purpose of ['preparation', 'scored']) test(`new unsupported ${purpose} drafts are rejected before any retained state is written`, async () => {
  const h = harness(['A'], {scoredCollectionEnabled: true});
  const config = defaultConfig('tree', purpose); config.analysisProfileId = unsupportedProfile.profileId;
  const response = await h.service.fetch(api('series', 'POST', {config, profile: unsupportedProfile}));
  assert.equal(response.status, 400);
  const failure = await response.json();
  assert.equal(failure.code, 'invalid_profile');
  assert.equal(failure.message, 'Unsupported motion profile. Use area-weighted motion.');
  assert.equal(h.storage.values.size, 0);
});

async function retainedScored(h, profile, status = 'frozen', lifecycle = 'draft') {
  const config = defaultConfig('tree', 'scored');
  config.seriesId = 'retained-series'; config.analysisProfileId = profile.profileId;
  const series = {seriesId: config.seriesId, config, status, profile,
    sealedProfileJson: JSON.stringify(profile), profileHash: await profileHash(profile),
    sealedConfigJson: JSON.stringify(config), configHash: await profileHash(config),
    codeCheckpoint: 'a'.repeat(40), runIds: ['retained-run'],
    members: [{runId: 'retained-run', collectionStartedAtMs: null}]};
  series.qualification = qualification(series);
  await h.storage.put('tree-targeting:series:retained-series', series);
  const state = {...createRunState(config, 1000, 'retained-run'), lifecycle,
    phase: lifecycle === 'prepared' ? 'TREE_READY' : 'DRAFT', recordingReady: true,
    testAudioPlayed: true, playbackDeviceId: 'phone', setupSnapshot: {retrospective: false}, cues: []};
  await h.store.createRun({runId: 'retained-run', experimentSlug: 'tree-targeting', config,
    profile, state, codeCheckpoint: series.codeCheckpoint, tickets: []});
  return series;
}

for (const boundary of ['freeze', 'member', 'prepare', 'start']) {
  test(`retained unsupported scored ${boundary} is rejected without writes, randomness or registration`, async () => {
    let tickets = 0, registrations = 0;
    const h = harness(['A'], {scoredCollectionEnabled: true, startRegistry: {ensureStart() {registrations++; throw new Error('No unsupported registration');}}});
    h.randomService.createTickets = () => {tickets++; throw new Error('No unsupported tickets');};
    const series = await retainedScored(h, unsupportedProfile, boundary === 'freeze' ? 'draft' : 'frozen', boundary === 'start' ? 'prepared' : 'draft');
    const before = structuredClone(h.storage.values);
    const response = boundary === 'freeze' ? await h.service.fetch(api(`series/${series.seriesId}/freeze`, 'POST', {}))
      : boundary === 'member' ? await h.service.fetch(api('runs', 'POST', {runId: 'new-member', seriesId: series.seriesId}))
      : await action(h.service, 'retained-run', boundary, boundary);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_profile');
    assert.deepEqual(h.storage.values, before);
    assert.equal(tickets, 0); assert.equal(registrations, 0); assert.equal(h.randomService.drawn.length, 0);
    assert.equal((await h.service.fetch(api(`series/${series.seriesId}/export`))).status, 200);
    assert.equal((await action(h.service, 'retained-run', 'stop', 'safe-stop')).status, 200);
    const exported = await h.service.fetch(api('runs/retained-run/export'));
    assert.equal(exported.status, 200);
    assert.deepEqual((await exported.json()).profile, unsupportedProfile);
  });
}

for (const boundary of ['freeze', 'member', 'prepare', 'start']) {
  test(`changed frozen grid profile is rejected at ${boundary} before mutation`, async () => {
    const h = harness(['A'], {scoredCollectionEnabled: true, startRegistry: {ensureStart() {throw new Error('No changed-profile registration');}}});
    const series = await retainedScored(h, areaProfile, boundary === 'freeze' ? 'draft' : 'frozen', boundary === 'start' ? 'prepared' : 'draft');
    if (['freeze', 'member'].includes(boundary)) {
      series.sealedProfileJson += ' '; await h.storage.put('tree-targeting:series:retained-series', series);
    } else {
      const run = await h.store.readRun('retained-run'); run.sealedProfileJson += ' ';
      await h.storage.put('experiment:tree-targeting:run:retained-run', run);
    }
    const before = structuredClone(h.storage.values);
    const response = boundary === 'freeze' ? await h.service.fetch(api(`series/${series.seriesId}/freeze`, 'POST', {}))
      : boundary === 'member' ? await h.service.fetch(api('runs', 'POST', {runId: 'new-member', seriesId: series.seriesId}))
      : await action(h.service, 'retained-run', boundary, boundary);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'frozen_profile_changed');
    assert.deepEqual(h.storage.values, before);
  });
}

test('open series appends recordings after completion without a finite slot inventory', async()=>{
  const h=harness();const config=defaultConfig('tree');
  Object.assign(config.tree,{preRollSeconds:1,postRollSeconds:1,recoverySeconds:0,count:1});
  const created=await h.service.fetch(api('series','POST',{label:'Preparation sequence',config}));
  assert.equal(created.status,201);
  const series=await created.json();
  assert.equal(series.status,'open');assert.deepEqual(series.runIds,[]);
  for(const [index,responseSeconds] of [2,8,15].entries()){
    const run=await h.service.fetch(api('runs','POST',{runId:`run-${index}`,seriesId:series.seriesId,
      config:{...config,tree:{...config.tree,responseSeconds}}}));
    assert.equal(run.status,201,JSON.stringify(await run.clone().json()));
    const base=10000*(index+1);h.setTime(base);
    await ready(h,`run-${index}`,config,{existing:true});
    h.setTime(base+1000);await h.service.advanceDeadline(`run-${index}`);
    await play(h,`run-${index}`,base+1000.5);
    h.setTime(base+1100);await action(h.service,`run-${index}`,'arrived','arrived');
    await play(h,`run-${index}`,base+1200.5);
    h.setTime(base+1200.5+responseSeconds*1000);await h.service.advanceDeadline(`run-${index}`);
    await play(h,`run-${index}`,base+1300.5+responseSeconds*1000);
    h.setTime(base+1400+responseSeconds*1000);await action(h.service,`run-${index}`,'away','away');
    h.setTime(base+2400+responseSeconds*1000);await h.service.advanceDeadline(`run-${index}`);
    assert.equal((await h.store.readRun(`run-${index}`)).state.lifecycle,'completed');
  }
  const saved=await(await h.service.fetch(api(`series/${series.seriesId}`))).json();
  assert.deepEqual(saved.runIds,['run-0','run-1','run-2']);
  assert.deepEqual(saved.config,series.config);
  assert.equal(saved.profileHash,series.profileHash);
  assert.equal(saved.codeCheckpoint,series.codeCheckpoint);
  const exported=await h.service.fetch(api(`series/${series.seriesId}/export`));assert.equal(exported.status,200);
  assert.deepEqual((await exported.json()).runIds,saved.runIds);
});

test('new preparation members retain the current hosted source after a series crosses releases',async()=>{
  const sourceA='a'.repeat(40),sourceB='b'.repeat(40);
  let now=1000;
  const h=harness(['A'],{codeCheckpoint:sourceA,clock:()=>now});
  const config=defaultConfig('tree');
  Object.assign(config.tree,{preRollSeconds:1,postRollSeconds:1,count:1});
  const created=await h.service.fetch(api('series','POST',{config}));
  assert.equal(created.status,201);
  const series=await created.json();
  assert.equal((await h.service.fetch(api('runs','POST',{runId:'old-member',seriesId:series.seriesId}))).status,201);
  await ready(h,'old-member',config,{existing:true});
  assert.equal((await action(h.service,'old-member','stop','stop')).status,200);
  const oldExport=await h.service.fetch(api('runs/old-member/export'));
  assert.equal(oldExport.status,200);
  const oldBundle=await oldExport.json();
  assert.equal(oldBundle.codeCheckpoint,sourceA);
  assert.equal((await h.service.fetch(api('runs','POST',{runId:'deferred-member',seriesId:series.seriesId}))).status,201);
  now=2000;
  const newer={...h,service:createService({store:h.store,storage:h.storage,randomService:h.randomService,
    authenticate:async()=>({id:'operator'}),clock:()=>now,codeCheckpoint:sourceB})};
  const tuned={...config,tree:{...config.tree,responseSeconds:2.5}};
  assert.equal((await newer.service.fetch(api('runs','POST',{
    runId:'new-member',seriesId:series.seriesId,config:tuned}))).status,201);
  await ready(newer,'new-member',tuned,{existing:true});
  assert.equal((await action(newer.service,'new-member','stop','stop')).status,200);
  const newExport=await newer.service.fetch(api('runs/new-member/export'));
  assert.equal(newExport.status,200);
  const newBundle=await newExport.json();
  assert.equal(newBundle.codeCheckpoint,sourceB);
  assert.equal(newBundle.config.tree.responseSeconds,2.5);
  const retainedOld=await(await newer.service.fetch(api('runs/old-member/export'))).json();
  assert.equal(retainedOld.codeCheckpoint,sourceA);
  assert.equal(retainedOld.configHash,oldBundle.configHash);
  assert.equal(retainedOld.profileHash,oldBundle.profileHash);
  await ready(newer,'deferred-member',config,{existing:true});
  assert.equal((await action(newer.service,'deferred-member','stop','stop')).status,200);
  const deferred=await newer.service.fetch(api('runs/deferred-member/export'));
  assert.equal(deferred.status,200);
  const deferredBundle=await deferred.json();
  assert.equal(deferredBundle.codeCheckpoint,sourceA);
  assert.ok(deferredBundle.events.some(event=>event.kind==='start'));
  assert.ok(deferredBundle.events.every(event=>event.sourceCheckpoint===sourceB));
  const retainedSeries=await(await newer.service.fetch(api(`series/${series.seriesId}/export`))).json();
  assert.equal(retainedSeries.codeCheckpoint,sourceA);
  assert.equal(retainedSeries.configHash,series.configHash);
  assert.equal(retainedSeries.profileHash,series.profileHash);
  assert.deepEqual(retainedSeries.members.map(({runId,codeCheckpoint})=>({runId,codeCheckpoint})),[
    {runId:'old-member',codeCheckpoint:sourceA},{runId:'deferred-member',codeCheckpoint:sourceA},
    {runId:'new-member',codeCheckpoint:sourceB},
  ]);
});

test('scored members retain their frozen source and cannot prepare under a newer hosted release',async()=>{
  const sourceA='a'.repeat(40),sourceB='b'.repeat(40);
  const h=harness(['A'],{codeCheckpoint:sourceA,scoredCollectionEnabled:true});
  const created=await h.service.fetch(api('series','POST',{config:defaultConfig('tree','scored')}));
  assert.equal(created.status,201);
  const series=await created.json();
  const key=`tree-targeting:series:${series.seriesId}`;
  const saved=await h.storage.get(key);
  saved.qualification={profileHash:series.profileHash,codeCheckpoint:sourceA,
    software:'pass',realFootage:'pass',phone:'pass',clock:'pass'};
  await h.storage.put(key,saved);
  assert.equal((await h.service.fetch(api(`series/${series.seriesId}/freeze`,'POST',{}))).status,200);
  const newer=createService({store:h.store,storage:h.storage,randomService:h.randomService,
    authenticate:async()=>({id:'operator'}),codeCheckpoint:sourceB,scoredCollectionEnabled:true});
  assert.equal((await newer.fetch(api('runs','POST',{runId:'scored-member',seriesId:series.seriesId}))).status,201);
  assert.equal((await h.store.readRun('scored-member')).codeCheckpoint,sourceA);
  const response=await action(newer,'scored-member','prepare','prepare');
  assert.equal(response.status,409);
  assert.equal((await response.json()).code,'series_manifest_mismatch');
  assert.equal((await h.store.readRun('scored-member')).state.lifecycle,'draft');
  assert.equal(h.randomService.drawn.length,0);
});

for(const providerFailure of [false,true])test(`new events retain their handler source across releases and provider ${providerFailure?'failure':'success'}`,async()=>{
  const sourceA='a'.repeat(40),sourceB='b'.repeat(40);
  let now=1000;
  const h=harness(['A'],{codeCheckpoint:sourceA,clock:()=>now});
  h.setTime=value=>{now=value;};
  const config=defaultConfig('tree');
  Object.assign(config.tree,{preRollSeconds:1,postRollSeconds:1,responseSeconds:2,count:1});
  await ready(h,'cross-release',config);
  const oldEvents=(await h.store.readRun('cross-release')).events;
  assert.ok(oldEvents.length>0);
  assert.ok(oldEvents.every(event=>event.sourceCheckpoint===sourceA));
  const newer={...h,service:createService({store:h.store,storage:h.storage,randomService:h.randomService,
    authenticate:async()=>({id:'operator'}),clock:()=>now,codeCheckpoint:sourceB})};
  h.setTime(2000);
  assert.equal((await newer.service.advanceDeadline('cross-release')).status,200);
  await play(newer,'cross-release',2000.5);
  if(providerFailure)h.randomService.draw=async()=>{throw new Error('Synthetic provider unavailable');};
  h.setTime(2500);
  assert.equal((await action(newer.service,'cross-release','arrived','arrived')).status,200);
  if(!providerFailure){
    await play(newer,'cross-release',3000.5);
    h.setTime(5000.5);
    assert.equal((await newer.service.advanceDeadline('cross-release')).status,200);
    await play(newer,'cross-release',5100.5);
    assert.equal((await action(newer.service,'cross-release','stop','stop')).status,200);
  }
  const exported=await newer.service.fetch(api('runs/cross-release/export'));
  assert.equal(exported.status,200);
  const bundle=await exported.json();
  assert.equal(bundle.codeCheckpoint,sourceA);
  assert.deepEqual(bundle.events.slice(0,oldEvents.length),oldEvents);
  const newEvents=bundle.events.slice(oldEvents.length);
  assert.ok(newEvents.length>0);
  assert.ok(newEvents.every(event=>event.sourceCheckpoint===sourceB));
  for(const kind of ['deadlineReached','cueIssued','cuePlayed','cueEnded','arrived',
    ...(providerFailure?['providerFailed']:['assignmentReceived','assignmentRecorded','signatureVerification','stop'])]){
    assert.ok(newEvents.some(event=>event.kind===kind),`Expected retained ${kind} event`);
  }
  assert.equal((await h.service.fetch(api('runs/cross-release/tag','POST',{tag:'Earlier handler'}))).status,200);
  const later=await(await newer.service.fetch(api('runs/cross-release/export'))).json();
  assert.equal(later.events.at(-1).kind,'runTagUpdated');
  assert.equal(later.events.at(-1).sourceCheckpoint,sourceA);
  assert.deepEqual(later.events.slice(0,bundle.events.length),bundle.events);
});

test('unlocked Test cannot create or start scored collection',async()=>{
  const h=harness();const config=defaultConfig('tree','scored');
  const response=await h.service.fetch(api('runs','POST',{config}));
  assert.equal(response.status,409);assert.equal((await response.json()).code,'scored_locked');
});


test('series inventory and export follow first generated assignment order, excluding unused configurations',async()=>{
  const h=harness();const config=defaultConfig('tree');config.tree.preRollSeconds=1;
  const series=await(await h.service.fetch(api('series','POST',{config}))).json();
  for(const runId of ['created-first','collected-first','unstarted']){
    h.setTime(1000);assert.equal((await h.service.fetch(api('runs','POST',{runId,seriesId:series.seriesId}))).status,201);
  }
  for(const [runId,base] of [['collected-first',10000],['created-first',20000]]){
    h.setTime(base);await ready(h,runId,config,{existing:true});
    h.setTime(base+1000);await h.service.advanceDeadline(runId);
    await play(h,runId,base+1000.5);h.setTime(base+1100);await action(h.service,runId,'arrived','arrived');
    await action(h.service,runId,'stop','stop');
  }
  const saved=await(await h.service.fetch(api(`series/${series.seriesId}`))).json();
  assert.deepEqual(saved.collectionRunIds,['collected-first','created-first']);
  assert.equal(saved.members.find(item=>item.runId==='created-first').createdAtMs,1000);
  assert.equal(saved.members.find(item=>item.runId==='created-first').collectionStartedAtMs,21100);
  const exported=await(await h.service.fetch(api(`series/${series.seriesId}/export`))).json();
  assert.deepEqual(exported.collectionRunIds,saved.collectionRunIds);
  const inventory=await(await h.service.fetch(api('runs'))).json();
  assert.equal(inventory.runs.find(item=>item.runId==='collected-first').collectionStartedAtMs,11100);
});

test('Test cannot start a retained prepared scored run even with setup and audio ready',async()=>{
  const h=harness();const config=defaultConfig('tree','scored');
  await h.store.createRun({runId:'retained-scored',experimentSlug:'tree-targeting',config,
    state:{...createRunState(config,1000,'retained-scored'),lifecycle:'prepared',phase:'TREE_READY',recordingReady:true,
      testAudioPlayed:true,playbackDeviceId:'phone',setupSnapshot:{retrospective:false},cues:[]},tickets:[]});
  const response=await action(h.service,'retained-scored','start','start');
  assert.equal(response.status,409);assert.equal((await response.json()).code,'scored_locked');
});
