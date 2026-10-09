// Present retained Tree measurements; inference remains in the Python evaluator.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? Number(value.toPrecision(6)).toString() : 'Unavailable';
const tick = (value, precision = 3) => {
  if (!finite(value)) return 'Unavailable';
  const label = Number(value.toPrecision(precision)).toString();
  return label.length <= 7 ? label : value.toExponential(0);
};
const recordingTime = value => {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const evidenceTick = (logValue, precision = 3) => {
  if (!finite(logValue)) return 'Unavailable';
  if (Math.abs(logValue) < 1e-14) return '1';
  const exponent = Math.floor(logValue / Math.LN10);
  if (exponent >= -2 && exponent <= 5) return tick(Math.exp(logValue), precision);
  const coefficient = Number(Math.exp(logValue - exponent * Math.LN10).toPrecision(precision));
  return coefficient === 10 ? `1 × 10^${exponent + 1}` : `${coefficient} × 10^${exponent}`;
};
const reason = value => String(value).replaceAll('_', ' ');
const displayValue = value => value === null || value === undefined ? 'Unavailable'
  : typeof value === 'number' ? number(value)
  : typeof value === 'string' ? value : 'Unavailable';
const countLabel = (count, label) => `${escapeHtml(count)} ${label}${count === 1 ? '' : 's'}`;
function publicReportText(text, preparation = false) {
  let description = String(text ?? '');
  for (const sentence of [
    'Preparation results are exploratory.',
    'Preparation remains exploratory even above the boundary.',
    'Import and analyze a Tree recording to start the series.',
    'Import the latest hosted series bundle to retain its complete collected recording inventory.',
    ...(preparation ? ['Settings and retrospective region choices can affect the result.'] : []),
  ]) description = description.replaceAll(`${sentence} `, '').replaceAll(sentence, '');
  return description.trim();
}

export function presentTreeReport(report, {audience = 'operator'} = {}) {
  return {
    status: audience === 'public' && report.status === 'Preparation result' ? null : report.status,
    caveat: audience === 'public' ? publicReportText(report.caveat, report.status === 'Preparation result') : report.caveat,
    narrative: audience === 'public' ? (report.narrative ?? []).map(text => publicReportText(text)).filter(Boolean) : report.narrative ?? [],
  };
}

const periodName = value => ({preRoll: 'Before targeting', targeting: 'During targeting', postRoll: 'After targeting'})[value] ?? displayValue(value);
const transitionTitle = value => TRANSITION_TITLES[value] ?? displayValue(value);
const intervalName = value => typeof value === 'number' ? `Second ${value}` : displayValue(value);
const reasons = values => Array.isArray(values) ? values.length ? values.map(reason).join('; ') : 'None recorded' : 'Unavailable';
const table = (caption, columns, rows, note) => `<div class="table-scroll"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${columns.map(column => `<th scope="col"${column.numeric ? ' class="tree-number"' : ''}>${escapeHtml(column.heading)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => {
  const value = column.value(row);
  const content = column.identity && value != null
    ? `<span class="tree-run-id" title="${escapeHtml(value)}" aria-label="Full recording ID: ${escapeHtml(value)}">${escapeHtml(String(value).slice(0, 12))}</span>`
    : escapeHtml(displayValue(value));
  return `<td${column.numeric ? ' class="tree-number"' : ''}>${content}</td>`;
}).join('')}</tr>`).join('')}</tbody></table>${note ? `<p class="tree-table-note">${escapeHtml(note)}</p>` : ''}</div>`;
const CHART_DETAILS = {
  effect: {
    title: 'Estimated targeting difference, second by second',
    explanation: 'Does movement balance shift toward the instructed region, and when? Each point summarizes one second since the cue across available targets. Later seconds can contain fewer targets when saved response durations vary. Above zero means toward the instructed region; below zero means the opposite. Confidence limits show uncertainty. A range spanning zero does not settle direction or prove no effect. The simultaneous sequential ranges rely on the stated randomization and measurement assumptions; they are not probabilities that a hypothesis is true.',
  },
  regional: {
    title: 'Movement in each region: targeted versus not targeted',
    explanation: 'A compares movement in region A under A instructions with movement in A under B instructions. B compares movement in region B under B instructions with movement in B under A instructions. Positive means that region moved more when targeted; negative means less. Values are image pixels per second. These raw comparisons complement the normalized primary result and use a different scale.',
  },
  timeline: {
    title: 'Movement and target instructions throughout this recording',
    explanation: 'The target strip shows each A or B instruction from actual playback to the saved response end; repeated instructions have separate numbers, and spaces between bars are real gaps. The two traces show saved one-second response measurements and duration-weighted one-second context before, between, and after instructions. Missing measurements and unmeasured time remain gaps. The clock runs in recording minutes:seconds. A change near an instruction alone is not the randomized evidence calculation.',
  },
  evidence: {
    title: 'Accumulating evidence as recordings are added',
    explanation: 'Each point includes the chronological recordings so far. E is evidence, not effect size or a probability that the hypothesis is true. E = 20 corresponds to a 5% false-positive bound over repeated looks under the specified sequential method and assumptions; it does not mean a 20% movement change. Preparation remains exploratory even above the boundary. Equal vertical steps represent equal multipliers.',
  },
  history: {
    title: 'Estimated targeting difference as recordings are added',
    explanation: 'Each point includes all recordings so far and summarizes the full response. Confidence limits show remaining uncertainty. More recordings can change the estimate or narrow uncertainty; greater evidence is not guaranteed.',
  },
};
const TRANSITION_TITLES = {
  'A-to-A': 'After repeating target A',
  'A-to-B': 'After switching from A to B',
  'B-to-A': 'After switching from B to A',
  'B-to-B': 'After repeating target B',
};
const transitionName = chart => chart.kind === 'transition' ? chart.title.match(/^(A-to-A|A-to-B|B-to-A|B-to-B)\b/)?.[1] : undefined;
const chartTitle = chart => TRANSITION_TITLES[transitionName(chart)] ?? CHART_DETAILS[chart.kind]?.title ?? chart.title;
const chartExplanation = (chart, audience) => {
  const explanation = chart.kind === 'transition'
    ? `Zero seconds marks the new instruction. Negative times show available preceding context, currently up to five seconds; positive times use the saved response durations. A and B curves average each region over these ${transitionName(chart)} transitions. This is a descriptive timing comparison, not another independent significance test. Repeating a target can maintain a response without another rise. Zero occurrences is not a flat zero response.`
    : CHART_DETAILS[chart.kind]?.explanation ?? chart.description;
  return audience === 'public' ? publicReportText(explanation) : explanation;
};
const movementUnitsHelp = `<details class="retained-details tree-units-help"><summary>What do the movement units mean?</summary><p><strong>Pixels per second:</strong> apparent speed of tracked image details, not wind speed or physical distance. Camera framing and perspective affect this scale.</p><p><strong>Relative-share percentage points:</strong> the primary estimate compares A's share of combined A/B movement under randomized instructions. A share changing from 44% to 45% is one percentage point, not a 1% raw-motion increase. This uses the randomized-assignment estimate. A shift toward the target does not require both regions to increase absolutely.</p><p><strong>One-second measurements:</strong> response intervals, not independent randomized trials. Targets are the randomized instructions.</p><p>Missing values remain unavailable. Before, during, and after comparisons are descriptive; alone they cannot separate practice from weather or other changes over time.</p></details>`;
const evidenceHelp = audience => `<details class="retained-details tree-evidence-help"><summary>What do effect size, E, and p mean?</summary><p><strong>Effect size</strong> describes the magnitude and direction of the estimated full-response shift in relative-share percentage points. Positive means toward the instructed region; negative means away. The 95% simultaneous confidence range shows uncertainty while accounting for multiple response times and repeated series updates. It does not assign a 95% probability to the true effect lying in this observed range. A range spanning zero does not settle the direction.</p><p><strong>E</strong> describes evidence against the no-effect claim, not the size of the effect. The no-effect claim is that the randomized target has no effect on the measured A/B movement balance. Higher E is stronger evidence against that claim. Individual E describes one recording alone. Cumulative E continues through the underlying randomized targets across recordings; it is not the average or product of individual E values. Each randomized instruction has equal weight for its applicable summary; longer responses do not create extra independent instructions. Small E does not prove absence of an effect.</p><p><strong>Sequential p-value</strong> uses the highest cumulative E reached so far, including the starting value E = 1. It can stay unchanged when current E falls below that peak. E = 20 corresponds to p = 0.05. Under a locked, valid procedure with no target effect, the chance of ever reaching sequential p ≤ 0.05 at the declared recording updates is at most 5%. A smaller p reflects a higher peak cumulative E and stronger evidence against the no-effect claim under that procedure. This p-value is not the probability that the no-effect explanation is true.${audience === 'public' ? '' : ' Preparation remains exploratory.'}</p></details>`;
const motionSeries = (rows, origin = 0, elapsed = false) => ['A', 'B'].map(key => ({key, label: key,
  values: rows.map(row => ({x: elapsed ? row.offsetSeconds + row.durationSeconds / 2 : (row.start + row.end) / 2 - origin,
    y: row.quantifiable === false ? null : row[`${key}_motion`], start: elapsed ? row.offsetSeconds : row.start-origin,
    end: elapsed ? row.offsetSeconds + row.durationSeconds : row.end-origin}))}));

function domain(values, includeZero = true) {
  const observed = values.filter(finite);
  if (includeZero) observed.push(0);
  if (!observed.length) return [0, 1];
  const minimum = Math.min(...observed), maximum = Math.max(...observed);
  const padding = (maximum-minimum || Math.abs(maximum) || 1) * .1;
  return [minimum === 0 ? 0 : minimum-padding, maximum+padding];
}

export function renderTreeChart(chart, measuredWidth = 320) {
  const width = Math.max(220, Math.round(measuredWidth));
  const timeline = chart.kind === 'timeline';
  const height = 260, left = 80, right = width-16, top = timeline ? 50 : 28, bottom = 202;
  const [xMinimum, xMaximum] = chart.xDomain;
  const [yMinimum, yMaximum] = chart.yDomain ?? domain(chart.series.flatMap(series => series.values.map(value => value.y)));
  const x = value => left+2 + (value-xMinimum) / (xMaximum-xMinimum || 1) * (right-left-4);
  const y = value => bottom-2 - (value-yMinimum) / (yMaximum-yMinimum || 1) * (bottom-top-4);
  const coordinates = value => Number(value.toFixed(3));
  const tickCount = width < 280 ? 3 : 4;
  const cumulative = chart.kind === 'evidence' || chart.kind === 'history';
  const recordingCounts = cumulative ? [...new Set(chart.series.flatMap(series => series.values.map(point => point.x))
    .filter(value => Number.isInteger(value) && value >= xMinimum && value <= xMaximum))].sort((a, b) => a-b) : [];
  const selectedCount = Math.min(tickCount, recordingCounts.length);
  const firstSecond = Math.ceil(xMinimum), lastSecond = Math.floor(xMaximum);
  const secondCount = Math.min(tickCount, Math.max(0, lastSecond - firstSecond + 1));
  const xTicks = cumulative ? Array.from({length: selectedCount}, (_, index) =>
    recordingCounts[Math.round((recordingCounts.length-1) * index / (selectedCount-1 || 1))])
    : timeline ? secondCount ? [...new Set(Array.from({length: secondCount}, (_, index) =>
      Math.round(firstSecond + (lastSecond-firstSecond) * index / (secondCount-1 || 1))))]
      : [xMinimum]
    : Array.from({length: tickCount}, (_, index) => xMinimum+(xMaximum-xMinimum)*index/(tickCount-1));
  const yTicks = [yMinimum, (yMinimum+yMaximum)/2, yMaximum];
  const evidence = chart.kind === 'evidence';
  const yTick = evidence ? evidenceTick : tick;
  const yLabel = evidence ? 'Evidence E' : chart.yLabel ?? 'Pixels/second';
  const axes = xTicks.map((value, index) => `<text class="tree-x-tick" x="${coordinates(x(value))}" y="221" text-anchor="${index === 0 ? 'start' : index === (timeline ? xTicks.length : tickCount)-1 ? 'end' : 'middle'}">${escapeHtml(timeline ? recordingTime(value) : tick(value))}</text>`).join('')
    + yTicks.map(value => `<text class="tree-y-tick" data-tick-value="${value}" x="${left-6}" y="${coordinates(y(value)+4)}" text-anchor="end">${escapeHtml(yTick(value))}</text>`).join('');
  const paths = chart.series.map(series => {
    let drawing = false, previousEnd = null, path = '';
    const marks = [];
    for (const point of series.values) {
      if (!finite(point.x) || !finite(point.y)) { drawing = false; previousEnd = null; continue; }
      if (finite(previousEnd) && finite(point.start) && point.start > previousEnd+1e-6) drawing = false;
      const connectsPrevious = drawing;
      const pointX = coordinates(x(point.x)), pointY = coordinates(y(point.y));
      path += `${drawing ? 'L' : 'M'}${pointX},${pointY} `;
      drawing = true;
      previousEnd = point.end;
      const pointLabel = evidence ? `${series.key === 'B' ? 'Threshold E' : 'E'}: ${evidenceTick(point.y)}`
        : `${series.label}: ${number(point.y)} ${yLabel}`;
      const timeLabel = timeline ? `recording time ${recordingTime(point.x)}` : `${number(point.x)} ${chart.xLabel}`;
      if (timeline && connectsPrevious) marks.at(-1).connected = true;
      marks.push({point, pointX, pointY, pointLabel, timeLabel, connected: timeline && connectsPrevious});
    }
    return `<path class="tree-series-${escapeHtml(series.key)}" data-series="${escapeHtml(series.key)}" d="${path.trim()}"/>${marks.map(mark =>
      `<circle class="tree-series-${escapeHtml(series.key)}" cx="${mark.pointX}" cy="${mark.pointY}" r="2" data-value-x="${mark.point.x}" data-value-y="${mark.point.y}"${mark.connected ? ' opacity="0" pointer-events="all"' : ''}><title>${escapeHtml(mark.pointLabel)} at ${escapeHtml(mark.timeLabel)}</title></circle>`).join('')}`;
  }).join('');
  const markers = (chart.markers ?? []).filter(marker => finite(marker.x) && marker.x >= xMinimum && marker.x <= xMaximum)
    .map(marker => `<line class="tree-cue-marker" data-cue-time="${marker.x}" x1="${coordinates(x(marker.x))}" x2="${coordinates(x(marker.x))}" y1="${top}" y2="${bottom}"><title>${escapeHtml(marker.label)}</title></line>`).join('');
  const targetIntervals = timeline ? (chart.targetIntervals ?? []).filter(interval =>
    finite(interval.start) && finite(interval.end) && interval.end > interval.start) : [];
  const targetLabels = targetIntervals.map(interval =>
    `Target ${interval.label}${interval.index}, ${interval.start} to ${interval.end} recording seconds`);
  const targetStrip = targetIntervals.map((interval, index) => {
      const startX = coordinates(x(interval.start)), endX = coordinates(x(interval.end));
      const barWidth = coordinates(endX - startX);
      const label = `${interval.label}${interval.index}`;
      const accessible = targetLabels[index];
      return `<g class="tree-target-interval tree-target-${escapeHtml(interval.label)}" data-target-start="${interval.start}" data-target-end="${interval.end}" role="group" aria-label="${escapeHtml(accessible)}"><title>${escapeHtml(accessible)}</title><rect x="${startX}" y="29" width="${barWidth}" height="16"/>${barWidth >= label.length * 6 + 4 ? `<text x="${coordinates((startX+endX)/2)}" y="41" text-anchor="middle">${escapeHtml(label)}</text>` : ''}</g>`;
    }).join('');
  const targetDescription = targetLabels.length ? `${targetLabels.join('; ')}. ` : '';
  return `<svg class="tree-chart" role="img" aria-label="${escapeHtml(chartTitle(chart))}" data-chart-kind="${escapeHtml(chart.kind)}" data-y-min="${yMinimum}" data-y-max="${yMaximum}" data-x-min="${xMinimum}" data-x-max="${xMaximum}" viewBox="0 0 ${width} ${height}" height="${height}" width="100%"><title>${escapeHtml(chartTitle(chart))}</title><desc>${escapeHtml(chart.description)} ${escapeHtml(targetDescription)}Missing measurements are gaps. Exact values and counts are in the accompanying table.</desc><rect data-chart-frame x="${left}" y="${top}" width="${right-left}" height="${bottom-top}"/>${yMinimum <= 0 && yMaximum >= 0 ? `<line class="tree-zero" x1="${left}" x2="${right}" y1="${coordinates(y(0))}" y2="${coordinates(y(0))}"/>` : ''}${markers}${paths}${targetStrip}${axes}<text class="axis-title" data-axis="x" x="${(left+right)/2}" y="249" text-anchor="middle">${escapeHtml(chart.xLabel)}</text><text class="axis-title" data-axis="y" transform="translate(14 ${(top+bottom)/2}) rotate(-90)" text-anchor="middle">${escapeHtml(yLabel)}</text></svg>`;
}

function chartFigure(chart, transitionCounts, audience) {
  const count = transitionCounts.get(transitionName(chart));
  return `<figure class="tree-figure"><figcaption>${escapeHtml(chartTitle(chart))}${count === undefined ? '' : ` <span class="tree-chart-count">(${escapeHtml(count)} ${count === 1 ? 'occurrence' : 'occurrences'})</span>`}</figcaption>${count === 0 ? '<p class="field-help">No recorded occurrences; no response curve is available.</p>' : ''}<div class="tree-chart-host" data-tree-chart="${escapeHtml(JSON.stringify(chart))}">${renderTreeChart(chart)}</div><p class="tree-legend">${chart.series.map(series => `<span><i class="tree-series-${escapeHtml(series.key)}" aria-hidden="true"></i>${escapeHtml(chart.kind === 'evidence' ? series.key === 'B' ? 'Threshold E = 20' : 'E' : series.label)}</span>`).join('')}</p><details class="retained-details tree-chart-explanation"><summary>How to read this chart</summary><p>${escapeHtml(chartExplanation(chart, audience))}</p></details></figure>`;
}

function declutterLabels(host, chart) {
  const labels = [...host.querySelectorAll('.tree-x-tick')];
  for (let index = labels.length-2; index > 0; index--) {
    const previous = labels[index-1].getBoundingClientRect(), current = labels[index].getBoundingClientRect();
    const next = labels[index+1].getBoundingClientRect();
    if (current.left < previous.right+4 || current.right+4 > next.left) {
      labels[index].remove();
      labels.splice(index, 1);
    }
  }
  const title = host.querySelectorAll('[data-axis="y"]')[0];
  if (!title) return;
  const titleBounds = title.getBoundingClientRect();
  const yTick = chart.kind === 'evidence' ? evidenceTick : tick;
  for (const label of host.querySelectorAll('.tree-y-tick')) {
    if (label.getBoundingClientRect().left < titleBounds.right+4) {
      label.textContent = yTick(Number(label.dataset.tickValue), 2);
      if (label.getBoundingClientRect().left < titleBounds.right+4) {
        label.textContent = chart.kind === 'evidence' ? evidenceTick(Number(label.dataset.tickValue), 1) : Number(label.dataset.tickValue).toExponential(0);
      }
    }
  }
}

export function mountTreeCharts(root, ResizeObserverClass = globalThis.ResizeObserver) {
  const hosts = [...root.querySelectorAll('[data-tree-chart]')];
  if (!hosts.length) return () => {};
  const redraw = host => {
    const width = host.getBoundingClientRect().width;
    if (width > 0) {
      const chart = JSON.parse(host.dataset.treeChart);
      host.innerHTML = renderTreeChart(chart, width);
      declutterLabels(host, chart);
    }
  };
  hosts.forEach(redraw);
  const observer = ResizeObserverClass ? new ResizeObserverClass(entries => entries.forEach(entry => redraw(entry.target))) : null;
  if (!observer) console.warn('Tree chart resize observation is unavailable; charts use their measured initial width.');
  hosts.forEach(host => observer?.observe(host));
  return () => observer?.disconnect();
}

export function buildReportView(result) {
  const report = result?.report ?? result;
  if (!report || !Array.isArray(report.charts) || !report.tables) throw new Error('A retained Tree report is required.');
  return structuredClone(report);
}

function resultTable(name, rows) {
  const column = (heading, value, numeric = false, identity = false) => ({heading, value, numeric, identity});
  let caption, columns, note;
  if (name === 'effects') {
    caption = 'Targeting estimates and uncertainty';
    columns = [column('Interval', row => intervalName(row.second)), column('Estimate (relative-share percentage points)', row => row.estimate, true)];
    if (rows.some(row => row['bounded missing'] > 0)) columns.push(
      column('Lower estimate bound (relative-share percentage points)', row => row['bounded missing'] > 0 ? row['estimate bounds']?.[0] : 'Not needed', true),
      column('Upper estimate bound (relative-share percentage points)', row => row['bounded missing'] > 0 ? row['estimate bounds']?.[1] : 'Not needed', true));
    columns.push(
      column('Lower confidence limit (relative-share percentage points)', row => row['simultaneous confidence range']?.[0], true),
      column('Upper confidence limit (relative-share percentage points)', row => row['simultaneous confidence range']?.[1], true),
      column('Target count', row => row.targets, true),
      column('Missing-outcome count', row => row['bounded missing'], true));
    note = 'Estimates and limits are relative-share percentage points. Full response covers the saved duration; later seconds can include fewer targets.';
  } else if (name === 'regional') {
    caption = 'Movement in each region under A and B instructions';
    columns = [
      column('Interval', row => intervalName(row.second)),
      column('A under A', row => row.means?.A?.a, true),
      column('A under B', row => row.means?.B?.a, true),
      column('A difference', row => row['A targeting difference'], true),
      column('B under B', row => row.means?.B?.b, true),
      column('B under A', row => row.means?.A?.b, true),
      column('B difference', row => row['B targeting difference'], true),
      column('A instructions with both regions measured', row => row['A assignments'], true),
      column('B instructions with both regions measured', row => row['B assignments'], true),
    ];
    note = 'Movement and differences are descriptive image pixels per second. Counts include targets with paired A and B movement measurements under each instruction.';
  } else if (name === 'absent') {
    caption = 'Movement before, during, and after targeting';
    columns = [
      column('Period', row => periodName(row.period)),
      column('A movement', row => row.A, true),
      column('B movement', row => row.B, true),
      column('Targeting minus absent A', row => row.period === 'targeting' ? 'Not applicable' : row['targeting minus absent']?.a, true),
      column('Targeting minus absent B', row => row.period === 'targeting' ? 'Not applicable' : row['targeting minus absent']?.b, true),
      column('Reasons', row => reasons(row.reasons)),
    ];
    note = 'Descriptive image pixels per second. Before, during, and after comparisons do not by themselves separate practice from changes over time.';
  } else if (name === 'transitions') {
    caption = 'Movement changes immediately after switches and repetitions';
    columns = [
      column('Transition', row => transitionTitle(row.transition)),
      column('Occurrences', row => row.count, true),
      column('First-second A change', row => row.a, true),
      column('First-second B change', row => row.b, true),
    ];
    note = 'Descriptive image pixels per second relative to available preceding context. Unavailable means no qualified change was measured.';
  } else return '';
  return `<details class="retained-details tree-table-details"><summary>${escapeHtml(caption)}</summary>${table(caption, columns, rows, note)}</details>`;
}

function comparisonEffect(full) {
  if (!full) return 'Unavailable';
  const estimate = `<span class="tree-effect-value">${escapeHtml(displayValue(full.estimate))}</span>`;
  const bounds = full.estimate == null && Array.isArray(full.estimateBounds)
    ? `<span class="tree-effect-detail">Estimate bounds: ${escapeHtml(number(full.estimateBounds[0]))} to ${escapeHtml(number(full.estimateBounds[1]))}</span>` : '';
  const range = Array.isArray(full.confidenceRange)
    ? `<span class="tree-effect-detail">95% simultaneous confidence range: ${escapeHtml(number(full.confidenceRange[0]))} to ${escapeHtml(number(full.confidenceRange[1]))}</span>` : '';
  return estimate + bounds + range;
}

function comparisonTable(rows, preparation, recordingUrl) {
  const body = rows.map(row => {
    const identity = `<span class="tree-run-tag">${escapeHtml(row.individual?.tag || 'Untagged')}</span>`
      + `<span class="tree-run-id" title="${escapeHtml(row.runId)}" aria-label="Full recording ID: ${escapeHtml(row.runId)}">${escapeHtml(String(row.runId).split('-')[0])}</span>`;
    const linkedIdentity = recordingUrl ? `<a href="${escapeHtml(recordingUrl(row.runId))}">${identity}</a>` : identity;
    return `<tr><td class="tree-comparison-identity">${linkedIdentity}</td>`
      + `<td class="tree-number tree-comparison-compact">${escapeHtml(displayValue(row.individual?.targetCount))}</td>`
      + `<td class="tree-number tree-comparison-effect">${comparisonEffect(row.individual?.full)}</td>`
      + `<td class="tree-number tree-comparison-compact">${escapeHtml(evidenceTick(row.individual?.logEvidence))}</td>`
      + `<td class="tree-number tree-comparison-compact">${escapeHtml(displayValue(row.targetCount))}</td>`
      + `<td class="tree-number tree-comparison-effect">${comparisonEffect(row.full)}</td>`
      + `<td class="tree-number tree-comparison-compact">${escapeHtml(evidenceTick(row.logEvidence))}</td></tr>`;
  }).join('');
  return `<div class="table-scroll tree-comparison"><table><caption>Recordings and accumulated results</caption><thead><tr><th rowspan="2" scope="col">Recording</th><th colspan="3" scope="colgroup">This recording</th><th colspan="3" scope="colgroup">All recordings so far</th></tr><tr><th scope="col" class="tree-number tree-comparison-compact">Targets</th><th scope="col" class="tree-number">Effect size</th><th scope="col" class="tree-number tree-comparison-compact">E</th><th scope="col" class="tree-number tree-comparison-compact">Targets</th><th scope="col" class="tree-number">Effect size</th><th scope="col" class="tree-number tree-comparison-compact">E</th></tr></thead><tbody>${body}</tbody></table><p class="tree-table-note">Effect sizes and 95% simultaneous confidence ranges are in relative-share percentage points.${preparation ? ' Preparation results remain exploratory.' : ''}</p></div>`;
}

function cumulativeEvidenceSummary(evidence) {
  if (evidence?.sequentialPValueLabel == null) return '';
  return `<dl class="tree-evidence-summary"><div><dt>Current cumulative E</dt><dd class="tree-number">${escapeHtml(evidenceTick(evidence.logValue))}</dd></div><div><dt>Highest cumulative E so far</dt><dd class="tree-number">${escapeHtml(evidenceTick(evidence.maxLogValue))}</dd></div><div><dt>Sequential p-value</dt><dd class="tree-number">${escapeHtml(evidence.sequentialPValueLabel)}</dd></div></dl>`;
}

export function renderTreeResults(result, {recordingUrl, audience = 'operator'} = {}) {
  if (!result?.report && !result?.charts) return '<p class="empty-state">The Tree report is pending.</p>';
  const report = buildReportView(result);
  const presentation = presentTreeReport(report, {audience});
  if (report.counts.targets === 0) return presentation.narrative.map(text => `<p class="empty-state">${escapeHtml(text)}</p>`).join('');
  const transitionCounts = new Map((report.tables.transitions ?? []).map(row => [row.transition, row.count]));
  const series = report.title !== 'Tree run result' && report.tables.history?.length;
  return `<div class="tree-results"><h3>${report.title === 'Tree run result' ? 'This recording' : 'All included recordings'}</h3>`
    + (audience !== 'public' || presentation.status ? `<p>${escapeHtml(presentation.status)}</p>` : '')
    + (audience !== 'public' || presentation.caveat ? `<p>${escapeHtml(presentation.caveat)}</p>` : '')
    + presentation.narrative.map(text => `<p>${escapeHtml(text)}</p>`).join('')
    + `<p>${countLabel(report.counts.runs, 'recording')} · ${countLabel(report.counts.targets, 'generated target')} · ${countLabel(report.counts.usableBins, 'qualified bin')} · ${countLabel(report.counts.missingBins, 'missing bin')}</p>`
    + (series ? cumulativeEvidenceSummary(report.evidence) + comparisonTable(report.tables.history, report.status === 'Preparation result' && audience !== 'public', recordingUrl) + evidenceHelp(audience) : '')
    + movementUnitsHelp
    + report.charts.map(chart => chartFigure(chart, transitionCounts, audience)).join('')
    + ['effects', 'regional', 'absent', 'transitions'].filter(name => report.tables[name]?.length)
      .map(name => resultTable(name, report.tables[name])).join('') + '</div>';
}
