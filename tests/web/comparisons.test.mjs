import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonRequestFromFields} from '../../web/app.mjs';
import {renderComparisonSection} from '../../web/tree-comparisons.mjs';
import {renderMacComparisonResultPage} from '../../web/views.mjs';

const candidates = {profiles: [
  {profileId: 'legacy', label: 'Point average', sealedProfileJson: JSON.stringify({version: 'tree-profile-development-1', video: {}})},
  {profileId: 'area', label: 'Area average', sealedProfileJson: JSON.stringify({version: 'tree-profile-development-2', video: {measurement: {method: 'area-grid-mean-v1'}}})},
], runs: [{runId: 'run-one', tag: 'Oak', createdAtMs: 1000,
  analyses: [{analysisId: 'left-one', profileId: 'legacy', status: 'completed'},
             {analysisId: 'right-one', profileId: 'area', status: 'completed'},
             {analysisId: 'unrelated', profileId: 'third', status: 'completed'}]}]};

test('comparison form shows chronological recordings, exact revisions and disabled busy controls', () => {
  const html = renderComparisonSection({candidates, saved: {comparisons: []}, busy: true});
  assert.match(html, /Compare analysis methods/);
  assert.match(html, /Oak/);
  assert.match(html, /left-one/);
  assert.match(html, /right-one/);
  assert.doesNotMatch(html, /unrelated/);
  assert.match(html, /name="left_analysis_0"/);
  assert.match(html, /name="right_analysis_0"/);
  assert.match(html, /Save comparison<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Save comparison/);
});

test('comparison request keeps one ordered inventory and exact revisions', () => {
  const request = comparisonRequestFromFields({comparison_label: 'Oak methods', left_profile_id: 'legacy',
    right_profile_id: 'area', include_0: 'on', left_analysis_0: 'left-one', right_analysis_0: 'right-one'}, candidates);
  assert.deepEqual(request, {label: 'Oak methods', leftProfileId: 'legacy', rightProfileId: 'area',
    rows: [{runId: 'run-one', leftAnalysisId: 'left-one', rightAnalysisId: 'right-one'}]});
  assert.throws(() => comparisonRequestFromFields({...request, comparison_label: ' ', include_0: 'on'}, candidates), /name/);
});

test('saved comparison shows two independent individual summaries and stable side links', () => {
  const saved = {comparisonId: 'a'.repeat(32), label: 'Oak methods', createdAtMs: 1000,
    commonPrefixRunIds: ['run-one'], rows: [{runId: 'run-one', status: 'paired',
      tag: 'Oak at dusk', recordingStartedAtMs: 1000,
      leftAnalysisId: 'left-one', rightAnalysisId: 'right-one',
      leftIndividual: {effect: 2, confidenceRange: [-1, 5], evidence: '1.20', usableBinCount: 3, missingBinCount: 1},
      rightIndividual: {effect: 1, confidenceRange: [-2, 4], evidence: '1.05', usableBinCount: 2, missingBinCount: 2}}],
    left: {runIds: ['run-one'], targetCount: 2}, right: {runIds: ['run-one'], targetCount: 2},
    leftProfile: {profile: {profileId: 'legacy', label: 'Point average'}},
    rightProfile: {profile: {profileId: 'area', label: 'Area average'}}};
  const html = renderComparisonSection({candidates, saved: {comparisons: []}, selected: saved});
  assert.match(html, /Both accumulated results include 1 recording: Oak at dusk/);
  assert.match(html, /1\.20/);
  assert.match(html, /1\.05/);
  assert.match(html, /Oak at dusk/);
  assert.match(html, /Point average/);
  assert.match(html, /Area average/);
  assert.match(html, /side=left/);
  assert.match(html, /side=right/);
  assert.match(html, /analysis=left-one/);
  assert.match(html, /analysis=right-one/);
  assert.match(html, /not counted twice/);
  const side = renderMacComparisonResultPage({comparison: {...saved,
    leftDisplayReport: {counts: {targets: 0}, charts: [], tables: {}, narrative: ['No targets yet']}},
    side: 'left'});
  assert.match(side, /Oak methods/);
  assert.match(side, /This saved result includes the same recordings, in the same order, as the other profile&#39;s result/);
  assert.doesNotMatch(side, /completed recording prefix/);
});

test('saved individual result headings escape free-text profile names', () => {
  const selected = {comparisonId: 'b'.repeat(32), label: 'Oak methods', commonPrefixRunIds: ['run-one'],
    leftProfile: {label: 'Area <canopy> & dusk', profile: {profileId: 'area'}},
    rightProfile: {label: 'Point average', profile: {profileId: 'legacy'}},
    rows: [{runId: 'run-one', tag: 'Oak', status: 'paired', leftAnalysisId: 'left-one',
      rightAnalysisId: 'right-one', leftIndividual: {effect: 2, evidence: '1.20',
        usableBinCount: 3, missingBinCount: 1}}]};
  const html = renderComparisonSection({candidates, selected});
  assert.match(html, /<th scope="row">Area &lt;canopy&gt; &amp; dusk<\/th>/);
  assert.doesNotMatch(html, /<th scope="row">Area <canopy> & dusk<\/th>/);
});

test('saved comparison names included recordings and explains every row without internal status terms', () => {
  const statuses = ['paired', 'paired', 'missing_left', 'missing_right', 'unavailable_left',
    'unavailable_right', 'source_mismatch', 'target_mismatch', 'profile_mismatch',
    'statistical_version_mismatch'];
  const selected = {comparisonId: 'c'.repeat(32), label: 'Oak methods',
    leftProfile: {label: 'Tree point 3000/41', profile: {profileId: 'legacy'}},
    rightProfile: {label: 'Tree area 128/32 - timed', profile: {profileId: 'area'}},
    commonPrefixRunIds: ['oak-one', 'oak-two'],
    rows: statuses.map((status, index) => ({runId: index === 0 ? 'oak-one' : index === 1 ? 'oak-two' : `oak-${index}`,
      tag: index === 0 ? 'North oak' : index === 1 ? 'South oak' : `Oak ${index}`, status}))};
  const html = renderComparisonSection({candidates, selected});
  const visible = html.split('<details class="retained-details">')[0];
  assert.match(visible, /Both accumulated results include 2 recordings: North oak, South oak/);
  assert.match(visible, /Both stop before the first recording with a missing or incompatible analysis pair/);
  assert.match(visible, /Both analyses available/);
  assert.match(visible, /No analysis for Tree point 3000\/41/);
  assert.match(visible, /No analysis for Tree area 128\/32 - timed/);
  assert.match(visible, /Tree point 3000\/41 analysis unavailable/);
  assert.match(visible, /Tree area 128\/32 - timed analysis unavailable/);
  assert.match(visible, /different saved inputs/);
  assert.match(visible, /different target assignments or response intervals/);
  assert.match(visible, /does not match its selected saved profile/);
  assert.match(visible, /different calculation versions/);
  assert.doesNotMatch(visible, /Same completed prefix|missing_right|source_mismatch|statistical_version_mismatch/);
  assert.match(visible, /Effect and 95% simultaneous confidence ranges are in relative-share percentage points/);
  assert.match(visible, /Usable and missing bins count response measurement intervals/);
  assert.match(visible, /<th>Effect<\/th><th>95% range<\/th>/);
  assert.doesNotMatch(visible, /Effect \(points\)/);
  assert.match(html, /&quot;missing_right&quot;/, 'machine detail retains the exact status');
});
