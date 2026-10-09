import assert from 'node:assert/strict';
import test from 'node:test';
import {buildReportView, mountTreeCharts, renderTreeChart, renderTreeResults} from '../../web/tree-results.mjs';

const chart = (kind, title, series = [{key: 'A', label: 'A', values: [{x: .5, y: 2, start: 0, end: 1}]}]) => ({
  kind, title, description: title,
  xLabel: kind === 'timeline' ? 'Recording time (seconds)' : kind === 'history' || kind === 'evidence' ? 'Accepted recordings' : 'Time from cue (seconds)',
  yLabel: kind === 'effect' || kind === 'history' ? 'relative-share percentage points' : kind === 'evidence' ? 'Natural logarithm of evidence E' : 'Pixels/second',
  xDomain: [0, 1], markers: [], series,
});

function recordingReport() {
  return {report: {
    title: 'Tree run result', status: 'Preparation result',
    caveat: 'Preparation results are exploratory.', narrative: ['The estimated full-response shift is 2.73 relative-share percentage points.'],
    counts: {runs: 1, targets: 3, usableBins: 5, missingBins: 1},
    charts: [
      chart('effect', 'Targeting effect by elapsed second'),
      chart('regional', 'Raw regional targeting differences'),
      chart('timeline', 'A and B motion around targeting', [{key: 'A', label: 'A', values: [{x: .5, y: null, start: 0, end: 1}]}]),
      ...['A-to-A', 'A-to-B', 'B-to-A', 'B-to-B'].map((name, count) => chart('transition', `${name} switch/repeat motion`,
        [{key: 'A', label: 'A', values: count === 0 ? [] : [{x: .5, y: 2}]}])),
    ],
    tables: {
      effects: [{second: 'Full response', estimate: 2.73, 'estimate bounds': [2.73, 2.73],
        'simultaneous confidence range': [-10, 15], targets: 3, 'bounded missing': 0,
        durations: [2, 3, 4], unit: 'relative-share percentage points'}],
      regional: [], absent: [],
      transitions: ['A-to-A', 'A-to-B', 'B-to-A', 'B-to-B'].map((transition, count) =>
        ({transition, count, a: count === 0 ? null : count / 10, b: null, unit: 'pixels/second'})),
      history: [],
    },
  }};
}

function seriesReport() {
  const retained = recordingReport();
  retained.report.title = 'Accumulating Tree result';
  retained.report.counts = {runs: 2, targets: 8, usableBins: 15, missingBins: 1};
  retained.report.evidence = {logValue: Math.log(2), maxLogValue: Math.log(10),
    sequentialLogPValue: -Math.log(10), sequentialPValueLabel: '0.1', threshold: 20};
  retained.report.charts.push(chart('evidence', 'Evidence over accepted recordings'));
  retained.report.tables.history = [
    {runId: 'a1b2c3d4-1111-2222-3333', runCount: 1, targetCount: 3,
      logEvidence: Math.log(1.5), full: {estimate: 2.73, confidenceRange: [-10, 15]},
      individual: {tag: 'First <tag&>', targetCount: 3, logEvidence: Math.log(.75),
        full: {estimate: -1.25, estimateBounds: [-1.25, -1.25], confidenceRange: [-20, 17]}}},
    {runId: 'b2c3d4e5-4444-5555-6666', runCount: 2, targetCount: 8,
      logEvidence: Math.log(2), full: {estimate: 1.25, confidenceRange: [-6, 9]},
      individual: {tag: 'Second recording', targetCount: 5, logEvidence: Math.log(2.5),
        full: {estimate: 4.5, estimateBounds: [4.5, 4.5], confidenceRange: [-2, 11]}}},
  ];
  return retained;
}

test('report view preserves saved plotted values, counts, units and accessible table rows', () => {
  const retained = {report: {status: 'Preparation result', effectUnits: 'relative-share percentage points',
    full: {estimate: 2.73}, elapsed: [{index: 0, estimate: 20.05}], counts: {missingBins: 1},
    charts: [{title: 'Elapsed targeting differences', series: [{key: 'A', values: [{x: .5, y: 20.05}]}]}],
    tables: {effects: [{second: 0, estimate: 20.05, unit: 'relative-share percentage points'}]}}};
  const view = buildReportView(retained);
  assert.equal(view.status, 'Preparation result');
  assert.equal(view.elapsed[0].estimate, retained.report.elapsed[0].estimate);
  assert.equal(view.charts[0].series[0].values[0].y, retained.report.charts[0].series[0].values[0].y);
  assert.deepEqual(view.tables.effects, retained.report.tables.effects);
  assert.equal(view.effectUnits, 'relative-share percentage points');
  assert.equal(view.counts.missingBins, 1);
});

test('every recording chart identifies its result and explains how to read it without changing measurements', () => {
  const retained = recordingReport();
  const before = structuredClone(retained);
  const html = renderTreeResults(retained);

  assert.match(html, /This recording/);
  assert.match(html, /What do the movement units mean\?/);
  assert.match(html, /one percentage point/);
  assert.match(html, /Preparation results are exploratory/);
  for (const title of [
    'Estimated targeting difference, second by second',
    'Movement in each region: targeted versus not targeted',
    'Movement and target instructions throughout this recording',
    'After repeating target A', 'After switching from A to B',
    'After switching from B to A', 'After repeating target B',
  ]) assert.ok(html.includes(`<figcaption>${title}`), `Missing visible chart title: ${title}`);
  assert.equal((html.match(/<summary>How to read this chart<\/summary>/g) ?? []).length, retained.report.charts.length);
  assert.match(html, /After switching from A to B[\s\S]*?1 occurrence/);
  assert.match(html, /After repeating target B[\s\S]*?3 occurrences/);
  assert.match(html, /No recorded occurrences; no response curve is available/);
  assert.match(html, /Zero seconds marks the new instruction/);
  assert.match(html, /Zero occurrences is not a flat zero response/);
  assert.match(html, /1 recording · 3 generated targets/);
  assert.doesNotMatch(renderTreeChart(retained.report.charts[2]), /data-value-y="0"/);
  assert.deepEqual(retained, before);
});

test('public preparation reports omit development context while preserving values, uncertainty, scientific cautions and operator text', () => {
  const retained = seriesReport();
  retained.report.caveat = 'Preparation results are exploratory. Settings and retrospective region choices can affect the result. Relative-share percentage points describe A/B motion balance, not raw-speed percent or an explanation of a mechanism.';
  retained.report.narrative.push('1 missing elapsed bin remains bounded unknown.', 'The saved randomization is unverified; this output cannot establish a qualified scored conclusion.');
  const before = structuredClone(retained);
  const publicHtml = renderTreeResults(retained, {audience: 'public'});
  const operatorHtml = renderTreeResults(retained);
  assert.doesNotMatch(publicHtml, /Preparation result|Preparation results|Preparation remains exploratory|Scored result/);
  assert.doesNotMatch(publicHtml, /Settings and retrospective region choices can affect the result/);
  for (const html of [publicHtml, operatorHtml]) {
    assert.match(html, /The estimated full-response shift is 2\.73 relative-share percentage points/);
    assert.match(html, /not raw-speed percent or an explanation of a mechanism/);
    assert.match(html, /1 missing elapsed bin remains bounded unknown/);
    assert.match(html, /saved randomization is unverified/);
    assert.match(html, /2 recordings · 8 generated targets · 15 qualified bins · 1 missing bin/);
    assert.match(html, /Sequential p-value[\s\S]*?0\.1/);
    assert.match(html, /95% simultaneous confidence range: -20 to 17/);
    assert.doesNotMatch(html, /data-value-y="0"/);
  }
  assert.match(operatorHtml, /Preparation result/);
  assert.match(operatorHtml, /Preparation results are exploratory/);
  assert.match(operatorHtml, /Settings and retrospective region choices can affect the result/);
  assert.match(operatorHtml, /Preparation remains exploratory even above the boundary/);
  assert.match(operatorHtml, /Preparation results remain exploratory/);
  assert.match(operatorHtml, /Preparation remains exploratory\./);
  assert.deepEqual([...publicHtml.matchAll(/data-value-x="([^\"]+)" data-value-y="([^\"]+)"/g)].map(match => match.slice(1)),
    [...operatorHtml.matchAll(/data-value-x="([^\"]+)" data-value-y="([^\"]+)"/g)].map(match => match.slice(1)));
  assert.deepEqual(retained, before);
});

test('a genuine scored or unqualified caveat remains visible for both audiences', () => {
  for (const status of ['Scored result', 'Unqualified result']) {
    const retained = recordingReport();
    retained.report.status = status;
    retained.report.caveat = 'Interpretation requires verified randomization, frozen settings and qualified measurements. Relative shares do not establish absolute increases. Settings and retrospective region choices can affect the result.';
    const before = structuredClone(retained);
    for (const options of [{}, {audience: 'public'}]) {
      const html = renderTreeResults(retained, options);
      assert.ok(html.includes(`<p>${status}</p>`));
      assert.ok(html.includes(`<p>${retained.report.caveat}</p>`));
    }
    assert.deepEqual(retained, before);
  }
});

test('an empty public report retains its pending explanation without operator import instructions', () => {
  const retained = recordingReport();
  retained.report.counts.targets = 0;
  retained.report.narrative = ['No analyzed targets yet. Import and analyze a Tree recording to start the series.',
    'The chronological series is waiting for 2 pending runs.',
    'Import the latest hosted series bundle to retain its complete collected recording inventory.'];
  const before = structuredClone(retained);
  const publicHtml = renderTreeResults(retained, {audience: 'public'});
  assert.match(publicHtml, /No analyzed targets yet/);
  assert.match(publicHtml, /waiting for 2 pending runs/);
  assert.doesNotMatch(publicHtml, /Import|hosted series bundle|<svg/);
  assert.match(renderTreeResults(retained), /Import and analyze a Tree recording/);
  assert.deepEqual(retained, before);
});

test('evidence charts label E values while retaining logarithmic point coordinates', () => {
  const evidence = chart('evidence', 'Evidence over accepted recordings', [
    {key: 'A', label: 'log E', values: [{x: 1, y: 0}, {x: 2, y: Math.log(20)}]},
    {key: 'B', label: 'log 20', values: [{x: 1, y: Math.log(20)}, {x: 2, y: Math.log(20)}]},
  ]);
  evidence.yLabel = 'Natural logarithm of evidence E';
  evidence.xLabel = 'Accepted recordings';
  evidence.xDomain = [1, 2];
  evidence.yDomain = [0, Math.log(20)];
  const html = renderTreeChart(evidence);

  assert.match(html, /data-value-y="0"/);
  assert.match(html, new RegExp(`data-value-y="${Math.log(20)}"`));
  assert.match(html, /class="tree-y-tick"[^>]*>1<\/text>/);
  assert.match(html, /class="tree-y-tick"[^>]*>20<\/text>/);
  assert.match(html, /E: 20 at 2 Accepted recordings/);
  assert.match(html, /<text class="axis-title" data-axis="y"[^>]*>Evidence E<\/text>/);
  assert.doesNotMatch(html, /Natural logarithm of evidence E/);

  evidence.series[0].values = [{x: 1, y: -1000}, {x: 2, y: 1000}];
  evidence.yDomain = [-1000, 1000];
  const extreme = renderTreeChart(evidence, 740);
  assert.match(extreme, /10\^-435/);
  assert.match(extreme, /10\^434/);
  assert.doesNotMatch(extreme, /Infinity|NaN/);
});

test('evidence labels remain actual E values after resize and y-axis decluttering', () => {
  const evidence = chart('evidence', 'Evidence over accepted recordings', [
    {key: 'A', label: 'log E', values: [{x: 1, y: 0}, {x: 2, y: Math.log(20)}]},
    {key: 'B', label: 'log 20', values: [{x: 1, y: Math.log(20)}, {x: 2, y: Math.log(20)}]},
  ]);
  evidence.yDomain = [0, Math.log(20)];
  const host = {
    dataset: {treeChart: JSON.stringify(evidence)}, width: 320,
    getBoundingClientRect() { return {width: this.width}; },
    set innerHTML(html) {
      this.html = html;
      this.yTicks = [...html.matchAll(/<text class="tree-y-tick" data-tick-value="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
        .map(([, value, label]) => ({dataset: {tickValue: value}, textContent: label,
          getBoundingClientRect() { return {left: 74 - this.textContent.length * 8, right: 74}; }}));
    },
    querySelectorAll(selector) {
      if (selector === '.tree-x-tick') return [];
      if (selector === '[data-axis="y"]') return [{getBoundingClientRect: () => ({right: 58})}];
      if (selector === '.tree-y-tick') return this.yTicks;
      return [];
    },
  };
  const root = {querySelectorAll: () => [host]};
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; FakeResizeObserver.current = this; }
    observe() {}
    disconnect() {}
  }
  const unmount = mountTreeCharts(root, FakeResizeObserver);
  assert.equal(host.yTicks[0].textContent, '1');
  assert.equal(host.yTicks[2].textContent, '20');
  host.width = 700;
  FakeResizeObserver.current.callback([{target: host}]);
  assert.match(host.html, /viewBox="0 0 700 260"/);
  assert.equal(host.yTicks[0].textContent, '1');
  assert.equal(host.yTicks[2].textContent, '20');
  assert.doesNotMatch(host.yTicks.map(item => item.textContent).join(' '), /NaN|Infinity|2\.995/);
  unmount();
});

test('recording timeline renders separate accessible target durations and minute-second ticks at desktop widths', () => {
  const timeline = chart('timeline', 'A and B motion around targeting', [
    {key: 'A', label: 'A', values: [{x: .5, y: 1, start: 0, end: 1},
      {x: 2.5, y: 2, start: 2, end: 3}, {x: 3.5, y: null, start: 3, end: 4},
      {x: 5, y: 3, start: 4.5, end: 5.5}]},
    {key: 'B', label: 'B', values: [{x: .5, y: 2, start: 0, end: 1}]},
  ]);
  timeline.xLabel = 'Recording time (minutes:seconds)';
  timeline.xDomain = [0, 125];
  timeline.targetIntervals = [
    {index: 1, label: 'A', start: 2, end: 18},
    {index: 2, label: 'A', start: 20, end: 36},
    {index: 3, label: 'B', start: 38, end: 54},
  ];
  timeline.markers = [2, 18, 20, 36, 38, 54].map(value => ({x: value, label: 'Timing'}));
  const original = structuredClone(timeline);

  for (const width of [740, 1070]) {
    const html = renderTreeChart(timeline, width);
    const bars = [...html.matchAll(/<g class="tree-target-interval tree-target-[AB]"[^>]*data-target-start="([^"]+)" data-target-end="([^"]+)"[^>]*>\s*<title>[^<]+<\/title>\s*<rect x="([^"]+)"[^>]*width="([^"]+)"/g)]
      .map(([, start, end, x, barWidth]) => ({start: Number(start), end: Number(end), x: Number(x), width: Number(barWidth)}));
    assert.deepEqual(bars.map(({start, end}) => [start, end]), [[2, 18], [20, 36], [38, 54]]);
    for (const [index, label] of ['A1', 'A2', 'B3'].entries()) {
      assert.match(html, new RegExp(`aria-label="Target ${label}[^\"]*"`));
      assert.match(html, new RegExp(`>${label}<\\/text>`));
      const startMarker = Number(html.match(new RegExp(`data-cue-time="${timeline.targetIntervals[index].start}" x1="([^\"]+)"`))[1]);
      const endMarker = Number(html.match(new RegExp(`data-cue-time="${timeline.targetIntervals[index].end}" x1="([^\"]+)"`))[1]);
      assert.equal(bars[index].x, startMarker);
      assert.ok(Math.abs(bars[index].x + bars[index].width - endMarker) <= .002);
    }
    assert.ok(bars[0].x + bars[0].width < bars[1].x);
    assert.ok(bars[1].x + bars[1].width < bars[2].x);
    const ticks = [...html.matchAll(/<text class="tree-x-tick"[^>]*>([^<]+)<\/text>/g)].map(([, label]) => label);
    assert.ok(ticks.every(label => /^\d+:\d{2}$/.test(label)));
    assert.ok(ticks.some(label => Number(label.split(':')[0]) >= 1));
    assert.match(html, /Recording time \(minutes:seconds\)/);
  }
  assert.deepEqual(timeline, original);

  const effect = renderTreeChart(chart('effect', 'Unchanged effect chart'), 740);
  assert.match(effect, /<rect data-chart-frame x="80" y="28"/);
  assert.match(effect, /class="tree-x-tick"[^>]*>0<\/text>/);
  assert.doesNotMatch(effect, /tree-target-interval/);
});

test('a narrow multi-digit target keeps its full accessible label without overflowing the bar', () => {
  const timeline = chart('timeline', 'A and B motion around targeting');
  timeline.xDomain = [0, 125];
  timeline.targetIntervals = [{index: 10, label: 'A', start: 100, end: 103}];
  const narrow = renderTreeChart(timeline, 740);
  const wide = renderTreeChart(timeline, 1070);
  const interval = narrow.match(/<g class="tree-target-interval tree-target-A"[^>]*data-target-start="100"[^>]*>[\s\S]*?<\/g>/)?.[0];

  assert.ok(interval);
  assert.match(interval, /aria-label="Target A10, 100 to 103 recording seconds"/);
  assert.doesNotMatch(interval, />A10<\/text>/);
  assert.match(narrow, /<desc>[^<]*Target A10, 100 to 103 recording seconds/);
  assert.match(wide, />A10<\/text>/);
});

test('timeline keeps plotted breaks and target alignment after a Mac panel resize', () => {
  const timeline = chart('timeline', 'A and B motion around targeting', [
    {key: 'A', label: 'A', values: [
      {x: .5, y: 2, start: 0, end: 1}, {x: 1.5, y: 3, start: 1, end: 2},
      {x: 2.5, y: null, start: 2, end: 3}, {x: 4.5, y: 4, start: 4, end: 5},
      {x: 7.5, y: 5, start: 7, end: 8},
    ]},
  ]);
  timeline.xLabel = 'Recording time (minutes:seconds)';
  timeline.xDomain = [0, 10];
  timeline.targetIntervals = [{index: 1, label: 'A', start: 4, end: 6},
    {index: 2, label: 'A', start: 7, end: 9}];
  timeline.markers = [{x: 4, label: 'A1'}, {x: 7, label: 'A2'}];
  const host = {dataset: {treeChart: JSON.stringify(timeline)}, width: 740,
    getBoundingClientRect() { return {width: this.width}; },
    set innerHTML(html) { this.html = html; },
    querySelectorAll() { return []; }};
  const root = {querySelectorAll: () => [host]};
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; FakeResizeObserver.current = this; }
    observe() {}
    disconnect() {}
  }
  const unmount = mountTreeCharts(root, FakeResizeObserver);
  const originalBar = Number(host.html.match(/data-target-start="4"[^>]*>\s*<title>[^<]+<\/title>\s*<rect x="([^"]+)"/)[1]);
  host.width = 1070;
  FakeResizeObserver.current.callback([{target: host}]);
  const resizedBar = Number(host.html.match(/data-target-start="4"[^>]*>\s*<title>[^<]+<\/title>\s*<rect x="([^"]+)"/)[1]);
  const resizedMarker = Number(host.html.match(/data-cue-time="4" x1="([^"]+)"/)[1]);
  assert.notEqual(originalBar, resizedBar);
  assert.equal(resizedBar, resizedMarker);
  assert.match(host.html, /viewBox="0 0 1070 260"/);
  const path = host.html.match(/<path class="tree-series-A" data-series="A" d="([^"]+)"/)[1];
  assert.equal((path.match(/M/g) ?? []).length, 3);
  assert.equal((path.match(/L/g) ?? []).length, 1);
  assert.deepEqual(JSON.parse(host.dataset.treeChart), timeline);
  unmount();
});

test('connected timeline measurements keep hover values without painting dots while lone measurements remain visible', () => {
  const series = [
    {key: 'A', label: 'A', values: [
      {x: .5, y: 2, start: 0, end: 1}, {x: 1.5, y: 3, start: 1, end: 2},
      {x: 2.5, y: null, start: 2, end: 3}, {x: 3.5, y: 4, start: 3, end: 4},
      {x: 6.5, y: 5, start: 6, end: 7},
    ]},
    {key: 'B', label: 'B', values: [
      {x: .5, y: 1, start: 0, end: 1}, {x: 1.5, y: 2, start: 1, end: 2},
      {x: 2.5, y: null, start: 2, end: 3}, {x: 3.5, y: 3, start: 3, end: 4},
      {x: 6.5, y: 4, start: 6, end: 7},
    ]},
  ];
  const timeline = chart('timeline', 'A and B motion around targeting', series);
  timeline.xDomain = [0, 8];
  timeline.yDomain = [0, 6];
  const original = structuredClone(timeline);
  const html = renderTreeChart(timeline, 1070);
  const markers = [...html.matchAll(/<circle class="tree-series-([AB])" cx="([^"]+)" cy="([^"]+)" r="2" data-value-x="([^"]+)" data-value-y="([^"]+)"([^>]*)><title>([^<]+)<\/title><\/circle>/g)]
    .map(([, key, cx, cy, x, y, attributes, title]) => ({key, cx: Number(cx), cy: Number(cy), x: Number(x), y: Number(y), attributes, title}));
  assert.equal(markers.length, 8);
  for (const key of ['A', 'B']) {
    const current = markers.filter(marker => marker.key === key);
    assert.deepEqual(current.map(marker => marker.x), [.5, 1.5, 3.5, 6.5]);
    assert.deepEqual(current.map(marker => marker.y), key === 'A' ? [2, 3, 4, 5] : [1, 2, 3, 4]);
    assert.deepEqual(current.map(marker => marker.cx), [142.625, 263.875, 506.375, 870.125]);
    assert.ok(current.every(marker => Number.isFinite(marker.cy) && marker.title.includes(`${key}: ${marker.y} Pixels/second at recording time`)));
    assert.ok(current.slice(0, 2).every(marker => marker.attributes.includes('opacity="0"') && marker.attributes.includes('pointer-events="all"')));
    assert.ok(current.slice(2).every(marker => !marker.attributes.includes('opacity="0"')));
    const path = html.match(new RegExp(`<path class="tree-series-${key}" data-series="${key}" d="([^"]+)"`))[1];
    assert.equal((path.match(/M/g) ?? []).length, 3);
    assert.equal((path.match(/L/g) ?? []).length, 1);
  }
  assert.deepEqual(timeline, original);

  const regional = chart('regional', 'Unchanged sparse comparison', series);
  regional.xDomain = [0, 8];
  regional.yDomain = [0, 6];
  const otherHtml = renderTreeChart(regional, 1070);
  assert.equal((otherHtml.match(/<circle class="tree-series-[AB]"/g) ?? []).length, 8);
  assert.doesNotMatch(otherHtml, /<circle[^>]*opacity="0"/);
});

test('cumulative charts label unique whole recording counts without moving their points', () => {
  for (const kind of ['evidence', 'history']) {
    for (const recordings of [1, 2, 7]) {
      const values = Array.from({length: recordings}, (_, index) => ({x: index + 1, y: index + 1}));
      const cumulative = chart(kind, 'Saved cumulative result', [{key: 'A', label: 'Estimate', values}]);
      cumulative.xDomain = [1, recordings];
      const html = renderTreeChart(cumulative);
      const labels = [...html.matchAll(/<text class="tree-x-tick"[^>]*>([^<]+)<\/text>/g)].map(([, label]) => label);
      const pointCounts = [...html.matchAll(/data-value-x="([^"]+)"/g)].map(([, count]) => count);

      assert.deepEqual(pointCounts, values.map(point => String(point.x)));
      assert.deepEqual(labels, [...new Set(labels)]);
      assert.ok(labels.every(label => /^\d+$/.test(label) && Number(label) >= 1 && Number(label) <= recordings));
      assert.equal(labels[0], '1');
      assert.equal(labels.at(-1), String(recordings));
      assert.ok(labels.length <= 4);
    }
  }
});

test('retained tables show explicit numerical fields, uncertainty bounds and escaped unavailable values', () => {
  const retained = recordingReport();
  retained.report.tables.effects.push({second: 4, estimate: null, 'estimate bounds': [-3, 8],
    'simultaneous confidence range': [-100, 100], targets: 1, 'bounded missing': 1,
    durations: [.5], unit: 'relative-share percentage points'});
  retained.report.tables.regional = [{second: 1, 'A targeting difference': .25, 'B targeting difference': null,
    'relative difference': null, 'A assignments': 2, 'B assignments': 1,
    means: {A: {a: 1.5, b: .8}, B: {a: 1.25, b: null}}, unit: 'pixels/second'}];
  retained.report.tables.absent = [
    {period: 'preRoll', A: null, B: null, reasons: ['outside_video_clock_references', '<masked&'],
      'targeting minus absent': {a: null, b: null}, unit: 'pixels/second'},
    {period: 'targeting', A: 1.5, B: 2.5, reasons: [], 'targeting minus absent': null, unit: 'pixels/second'},
  ];
  retained.report.tables.history = [{runId: 'run<alpha&full-id>', revisionId: 'revision-one', runCount: 1,
    targetCount: 3, logEvidence: Math.log(20), evidenceLabel: '20.00',
    full: {estimate: 2.73, confidenceRange: [-10, 15]},
    individual: {tag: 'Test', targetCount: 3, logEvidence: Math.log(20),
      full: {estimate: 2.73, confidenceRange: [-10, 15]}}}];
  retained.report.title = 'Accumulating Tree result';
  const before = structuredClone(retained);
  const html = renderTreeResults(retained);

  assert.match(html, /All included recordings/);
  for (const caption of [
    'Targeting estimates and uncertainty',
    'Movement in each region under A and B instructions',
    'Movement before, during, and after targeting',
    'Movement changes immediately after switches and repetitions',
    'Recordings and accumulated results',
  ]) assert.ok(html.includes(`<caption>${caption}</caption>`), `Missing table caption: ${caption}`);
  assert.match(html, /<th scope="col"[^>]*>Lower confidence limit/);
  assert.match(html, /<th scope="col"[^>]*>Upper confidence limit/);
  assert.match(html, /<th scope="col"[^>]*>Lower estimate bound/);
  assert.match(html, /<th scope="col"[^>]*>Upper estimate bound/);
  assert.match(html, /<th scope="col"[^>]*>Estimate \(relative-share percentage points\)<\/th>/);
  assert.match(html, /<th scope="col"[^>]*>Lower confidence limit \(relative-share percentage points\)<\/th>/);
  assert.match(html, /<td[^>]*>Second 4<\/td>[\s\S]*?<td[^>]*>Unavailable<\/td>[\s\S]*?<td[^>]*>-3<\/td>[\s\S]*?<td[^>]*>8<\/td>/);
  assert.match(html, /<th scope="col"[^>]*>A under A/);
  assert.match(html, /<th scope="col"[^>]*>B under A/);
  assert.match(html, /<th scope="col"[^>]*>A instructions with both regions measured/);
  assert.match(html, /<th scope="col"[^>]*>B instructions with both regions measured/);
  assert.match(html, /Counts include targets with paired A and B movement measurements/);
  assert.match(html, /<td[^>]*>1\.5<\/td>[\s\S]*?<td[^>]*>1\.25<\/td>[\s\S]*?<td[^>]*>0\.25<\/td>/);
  assert.match(html, /<td[^>]*>Unavailable<\/td>/);
  assert.match(html, /Before targeting/);
  assert.match(html, /outside video clock references; &lt;masked&amp;/);
  assert.match(html, /After switching from A to B/);
  assert.match(html, /aria-label="Full recording ID: run&lt;alpha&amp;full-id&gt;"/);
  assert.match(html, /<td[^>]*>20<\/td>/);
  assert.doesNotMatch(html, /<td[^>]*>\{&quot;/);
  assert.doesNotMatch(html, /effects values|history values/);
  assert.deepEqual(retained, before);
});

test('series shows one visible grouped comparison below summary and before charts', () => {
  const retained = seriesReport();
  const before = structuredClone(retained);
  const html = renderTreeResults(retained);
  const tableStart = html.indexOf('<caption>Recordings and accumulated results</caption>');

  assert.ok(tableStart > html.indexOf('Sequential p-value'));
  assert.ok(tableStart < html.indexOf('<figure class="tree-figure">'));
  assert.match(html, /<th rowspan="2" scope="col">Recording<\/th>/);
  assert.match(html, /<th colspan="3" scope="colgroup">This recording<\/th>/);
  assert.match(html, /<th colspan="3" scope="colgroup">All recordings so far<\/th>/);
  assert.equal((html.match(/<caption>Recordings and accumulated results<\/caption>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<summary>Accumulated results after each recording<\/summary>/);
  assert.match(html, /First &lt;tag&amp;&gt;[\s\S]*?a1b2c3d4/);
  assert.match(html, /Second recording[\s\S]*?b2c3d4e5/);
  assert.match(html, /aria-label="Full recording ID: a1b2c3d4-1111-2222-3333"/);
  assert.match(html, /relative-share percentage points/);
  assert.match(html, /95% simultaneous confidence range/);
  assert.match(html, /<td[^>]*>3<\/td>[\s\S]*?-1\.25[\s\S]*?-20 to 17[\s\S]*?0\.75[\s\S]*?<td[^>]*>3<\/td>/);
  assert.match(html, /<td[^>]*>5<\/td>[\s\S]*?4\.5[\s\S]*?-2 to 11[\s\S]*?2\.5[\s\S]*?<td[^>]*>8<\/td>/);
  assert.doesNotMatch(html, /<td[^>]*>\{&quot;/);
  assert.deepEqual(retained, before);
});

test('series evidence summary and closed help explain effect, uncertainty, E and peak-derived p', () => {
  const html = renderTreeResults(seriesReport());
  assert.match(html, /Current cumulative E[\s\S]*?2/);
  assert.match(html, /Highest cumulative E so far[\s\S]*?10/);
  assert.match(html, /Sequential p-value[\s\S]*?0\.1/);
  assert.match(html, /<details class="retained-details tree-evidence-help"><summary>What do effect size, E, and p mean\?<\/summary>/);
  assert.match(html, /effect size[\s\S]*?magnitude/i);
  assert.match(html, /toward[\s\S]*?away/i);
  assert.match(html, /uncertainty/i);
  assert.match(html, /multiple response times and repeated series updates/i);
  assert.match(html, /does not assign a 95% probability to the true effect lying in this observed range/i);
  assert.match(html, /no-effect claim is that the randomized target has no effect on the measured A\/B movement balance/i);
  assert.match(html, /Higher E is stronger evidence against that claim/);
  assert.match(html, /Under a locked, valid procedure with no target effect, the chance of ever reaching sequential p ≤ 0\.05 at the declared recording updates is at most 5%/);
  assert.match(html, /not the probability that the no-effect explanation is true/i);
  assert.match(html, /longer responses do not create extra independent instructions/i);
  assert.match(html, /not the average or product of individual E values/i);
  assert.match(html, /Small E does not prove absence of an effect/);
  assert.match(html, /Preparation remains exploratory/);
});

test('comparison keeps unavailable individual values and retained bounds visible', () => {
  const retained = seriesReport();
  retained.report.tables.history[0].individual.full = {
    estimate: null, estimateBounds: [-12, 8], confidenceRange: [-100, 100],
  };
  retained.report.tables.history[1].individual = {tag: null, targetCount: null, logEvidence: null, full: null};
  const html = renderTreeResults(retained);
  const comparison = html.slice(html.indexOf('<caption>Recordings and accumulated results</caption>'), html.indexOf('</table>'));
  assert.match(html, /Unavailable[\s\S]*?Estimate bounds: -12 to 8[\s\S]*?95% simultaneous confidence range: -100 to 100/);
  assert.match(comparison, /b2c3d4e5[\s\S]*?<td[^>]*>Unavailable<\/td>/);
  assert.doesNotMatch(comparison, /<td[^>]*>0<\/td>/);
});

test('an exact estimate has no redundant bound columns and evidence legend names its threshold', () => {
  const retained = recordingReport();
  retained.report.charts.push(chart('evidence', 'Evidence over accepted recordings', [
    {key: 'A', label: 'log E', values: [{x: 1, y: 0}]},
    {key: 'B', label: 'log 20', values: [{x: 1, y: Math.log(20)}]},
  ]));
  const html = renderTreeResults(retained);
  assert.doesNotMatch(html, /Lower estimate bound/);
  assert.match(html, /Threshold E = 20/);
  assert.match(html, /<details class="retained-details tree-table-details"><summary>Targeting estimates and uncertainty<\/summary>/);
});

test('recording URLs are injected only for public report rows and preserve the default Mac renderer', () => {
  const retained = seriesReport(), before = structuredClone(retained);
  const plain = renderTreeResults(retained);
  const linked = renderTreeResults(retained, {recordingUrl: runId => `/recordings/${runId}?publication=saved`});
  assert.doesNotMatch(plain, /href="\/recordings\//);
  assert.match(linked, /href="\/recordings\/a1b2c3d4-1111-2222-3333\?publication=saved"/);
  assert.match(linked, /First &lt;tag&amp;&gt;/);
  assert.match(linked, /Full recording ID: a1b2c3d4-1111-2222-3333/);
  assert.deepEqual(retained, before);
});
