import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultConfig} from '../../web/run-config.mjs';
import {createRunState, applyEvent, nextDeadline, publicRunState, localEligibility} from '../../server/run-engine.mjs';

const at = (kind, time, additional = {}) => ({kind, serverAtMs: time, ...additional});

function readyTree(config) {
  let state = applyEvent(createRunState(config, -31000), at('start', -31000), config).state;
  state = applyEvent(state, at('deadlineReached', -1000), config).state;
  state = applyEvent(state, at('cuePlayed', -900, {stream: 'treeApproach'}), config).state;
  return applyEvent(state, at('arrived', -800), config).state;
}

test('tree start records an absent pre-roll and waits for arrival before drawing a target', () => {
  const config = defaultConfig('tree');
  const state = createRunState(config, 0);
  assert.equal(state.phase, 'TREE_READY');
  assert.equal(config.tree.preRollSeconds, 30);
  const started = applyEvent(state, at('start', 0), config);
  assert.equal(started.state.phase, 'TREE_PREROLL');
  assert.equal(started.state.recordingStartedAtMs, 0);
  assert.equal(nextDeadline(started.state).atMs, 30000);
  assert.equal(started.effects.some(effect => effect.kind === 'requestAssignment'), false);
  const due = applyEvent(started.state, at('deadlineReached', 30000), config);
  assert.deepEqual(due.effects, [{kind: 'deliverCue', stream: 'treeApproach', text: 'Approach'}]);
  assert.equal(due.state.phase, 'TREE_WAIT_APPROACH');
  const spoken = applyEvent(due.state, at('cuePlayed', 30100, {stream: 'treeApproach'}), config);
  assert.equal(spoken.state.phase, 'TREE_APPROACH');
  const arrived = applyEvent(spoken.state, at('arrived', 40000), config);
  assert.equal(arrived.state.phase, 'TREE_WAIT_CUE');
  assert.deepEqual(arrived.effects, [{kind: 'requestAssignment', stream: 'tree'}]);
});

test('tree final target waits for Away, then records a separate post-roll before finishing', () => {
  const config = defaultConfig('tree');
  config.tree.count = 1;
  config.tree.postRollSeconds = 45;
  let state = applyEvent(createRunState(config, 0), at('start', 0), config).state;
  state = applyEvent(state, at('deadlineReached', 30000), config).state;
  state = applyEvent(state, at('cuePlayed', 30100, {stream: 'treeApproach'}), config).state;
  state = applyEvent(state, at('arrived', 40000), config).state;
  state = applyEvent(state, at('assignmentReceived', 40100, {stream: 'tree', value: 'A'}), config).state;
  state = applyEvent(state, at('cuePlayed', 40200, {stream: 'tree', playedAtMs: 40200}), config).state;
  const responseEnd = applyEvent(state, at('responseEnded', 55200), config);
  assert.equal(responseEnd.state.phase, 'TREE_WAIT_DEPART');
  assert.equal(responseEnd.state.lifecycle, 'running');
  assert.deepEqual(responseEnd.effects, [{kind: 'deliverCue', stream: 'treeDepart', text: 'Depart'}]);
  state = applyEvent(responseEnd.state, at('cuePlayed', 55300, {stream: 'treeDepart'}), config).state;
  assert.equal(state.phase, 'TREE_DEPARTURE');
  state = applyEvent(state, at('away', 60000), config).state;
  assert.equal(state.phase, 'TREE_POSTROLL');
  assert.equal(nextDeadline(state).atMs, 105000);
  const finished = applyEvent(state, at('deadlineReached', 105000), config);
  assert.equal(finished.state.phase, 'COMPLETE');
  assert.equal(finished.state.lifecycle, 'completed');
  assert.deepEqual(finished.effects, [{kind: 'deliverCue', stream: 'runFinished', text: 'Run finished'}]);
});

test('tree mode never accepts local Ready or requests a local assignment', () => {
  const config = defaultConfig('tree');
  const running = readyTree(config);
  assert.equal(localEligibility(running, config, 30000).allowed, false);
  const ready = applyEvent(running, at('ready', 30000), config);
  assert.equal(ready.state.phase, 'TREE_WAIT_CUE');
  assert.equal(ready.state.currentComparison, null);
  assert.equal(ready.effects.length, 0);
});

test('A,A,B creates three distinct consecutive measurements with zero recovery', () => {
  const config = defaultConfig('tree');
  config.tree.count = 3;
  let state = readyTree(config);
  for (const [index, target] of ['A', 'A', 'B'].entries()) {
    const received = applyEvent(state, at('assignmentReceived', index * 16000, {stream: 'tree', value: target, cueId: `cue-${index}`}), config);
    assert.equal(received.effects[0].text, `Target ${target}`);
    state = received.state;
    assert.equal(publicRunState(state).currentInstruction, null);
    const playedAt = index * 16000 + 100;
    const played = applyEvent(state, at('cuePlayed', playedAt, {stream: 'tree', playedAtMs: playedAt, cueId: `cue-${index}`}), config);
    state = played.state;
    assert.equal(state.currentInstruction, `Target ${target}`);
    assert.deepEqual(state.currentTrial.response, [playedAt, playedAt + 15000]);
    assert.equal(nextDeadline(state).atMs, playedAt + 15000);
    const ended = applyEvent(state, at('responseEnded', playedAt + 15000), config);
    state = ended.state;
    assert.equal(state.completedCount, index + 1);
    assert.equal(ended.effects.some(effect => effect.kind === 'announceRelease'), false);
    assert.equal(ended.effects.some(effect => effect.kind === 'requestAssignment'), index < 2);
  }
  assert.equal(state.phase, 'TREE_WAIT_DEPART');
  assert.deepEqual(state.trials.map(trial => trial.target), ['A', 'A', 'B']);
  assert.deepEqual(state.trials.map(trial => trial.cueId), ['cue-0', 'cue-1', 'cue-2']);
});

test('positive recovery delays the next tree target but adds no final recovery', () => {
  const config = defaultConfig('tree');
  config.tree.count = 2;
  config.tree.recoverySeconds = 10;
  config.tree.announceRelease = true;
  let state = readyTree(config);
  state = applyEvent(state, at('assignmentReceived', 0, {stream: 'tree', value: 'A'}), config).state;
  state = applyEvent(state, at('cuePlayed', 100, {stream: 'tree', playedAtMs: 100}), config).state;
  const ended = applyEvent(state, at('responseEnded', 15100), config);
  state = ended.state;
  assert.equal(ended.effects.some(effect => effect.kind === 'requestAssignment'), false);
  assert.deepEqual(ended.effects.find(effect => effect.kind === 'deliverCue'),
    {kind: 'deliverCue', stream: 'treeRelease', text: 'Release'});
  assert.equal(nextDeadline(state).atMs, 25100);
  state = applyEvent(state, at('cueEnded', 20000, {stream: 'treeRelease'}), config).state;
  const recovered = applyEvent(state, at('recoveryEnded', 25100), config);
  state = recovered.state;
  assert.deepEqual(recovered.effects, [{kind: 'requestAssignment', stream: 'tree'}]);
  state = applyEvent(state, at('assignmentReceived', 25200, {stream: 'tree', value: 'B'}), config).state;
  state = applyEvent(state, at('cuePlayed', 25300, {stream: 'tree', playedAtMs: 25300}), config).state;
  const final = applyEvent(state, at('responseEnded', 40300), config);
  assert.equal(final.state.phase, 'TREE_WAIT_DEPART');
  assert.deepEqual(final.effects, [{kind: 'deliverCue', stream: 'treeDepart', text: 'Depart'}]);
});

test('tree target waits for an unfinished recovery announcement before drawing the next assignment', () => {
  const config = defaultConfig('tree');
  config.tree.count = 2;
  config.tree.recoverySeconds = 5;
  config.tree.announceRelease = true;
  let state = readyTree(config);
  state = applyEvent(state, at('assignmentReceived', 0, {stream: 'tree', value: 'A'}), config).state;
  state = applyEvent(state, at('cuePlayed', 100, {stream: 'tree', playedAtMs: 100}), config).state;
  state = applyEvent(state, at('responseEnded', 15100), config).state;
  const recovered = applyEvent(state, at('recoveryEnded', 20100), config);
  assert.equal(recovered.state.phase, 'TREE_WAIT_RELEASE');
  assert.equal(recovered.effects.some(effect => effect.kind === 'requestAssignment'), false);
  const released = applyEvent(recovered.state, at('cueEnded', 20200, {stream: 'treeRelease'}), config);
  assert.equal(released.state.phase, 'TREE_WAIT_CUE');
  assert.deepEqual(released.effects, [{kind: 'requestAssignment', stream: 'tree'}]);
});

test('Tree speaks response completion during recovery even when Release is off', () => {
  const config = defaultConfig('tree');
  config.tree.count = 2;
  config.tree.recoverySeconds = 5;
  config.tree.announceRelease = false;
  let state = readyTree(config);
  state = applyEvent(state, at('assignmentReceived', 0, {stream: 'tree', value: 'A'}), config).state;
  state = applyEvent(state, at('cuePlayed', 100, {stream: 'tree', playedAtMs: 100}), config).state;
  const ended = applyEvent(state, at('responseEnded', 15100), config);
  assert.deepEqual(ended.effects.find(effect => effect.kind === 'deliverCue'),
    {kind: 'deliverCue', stream: 'treeRelease', text: 'Response complete'});
});

test('the final Tree target announces departure without adding a recovery interval', () => {
  const config = defaultConfig('tree');
  config.tree.count = 1;
  config.tree.recoverySeconds = 5;
  let state = readyTree(config);
  state = applyEvent(state, at('assignmentReceived', 0, {stream: 'tree', value: 'A'}), config).state;
  state = applyEvent(state, at('cuePlayed', 100, {stream: 'tree', playedAtMs: 100}), config).state;
  const ended = applyEvent(state, at('responseEnded', 15100), config);
  assert.equal(ended.state.lifecycle, 'running');
  assert.equal(ended.effects.some(effect => effect.kind === 'scheduleDeadline'), false);
  assert.deepEqual(ended.effects.find(effect => effect.kind === 'deliverCue'),
    {kind: 'deliverCue', stream: 'treeDepart', text: 'Depart'});
});
