// Mac preparation comparison controls and retained two-side summaries.
import {EXPERIMENT} from './run-config.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const disabled = busy => busy ? ' disabled' : '';
const date = value => Number.isFinite(value) ? new Date(value).toLocaleString('en-US') : 'Date unavailable';
const number = value => typeof value === 'number' && Number.isFinite(value) ? Number(value.toPrecision(4)) : 'Unavailable';
const profileName = (profiles, id) => profiles.find(item => item.profileId === id)?.label ?? id;

function revisions(run, profiles, profileId, side, index, busy) {
  const values = (run.analyses ?? []).filter(item => item.profileId === profileId);
  const selected = [...values].reverse().find(item => item.status === 'completed')?.analysisId ?? '';
  return `<label class="field">${side === 'left' ? 'First' : 'Second'} revision
    <select name="${side}_analysis_${index}"${disabled(busy)}><option value="">Missing</option>${values.map(item =>
      `<option value="${escapeHtml(item.analysisId)}"${item.analysisId === selected ? ' selected' : ''}>${escapeHtml(profileName(profiles, item.profileId))} · ${escapeHtml(item.analysisId)} · ${escapeHtml(item.status)}</option>`).join('')}</select></label>`;
}

const resultLink = (runId, analysisId) => analysisId
  ? `<a href="${escapeHtml(`${EXPERIMENT.basePath}analysis/#run=${encodeURIComponent(runId)}&analysis=${encodeURIComponent(analysisId)}`)}" target="_blank" rel="noopener">Exact result</a>`
  : 'Unavailable';
const sideLink = (comparisonId, side) => `${EXPERIMENT.basePath}analysis/#comparison=${encodeURIComponent(comparisonId)}&side=${side}`;

function individualRows(row, names) {
  return `<div class="table-scroll"><table><caption>Individual results for ${escapeHtml(row.tag || row.runId)}</caption><thead><tr><th>Profile</th><th>Effect</th><th>95% range</th><th>E</th><th>Usable / missing bins</th><th>Saved revision</th></tr></thead><tbody>${['left', 'right'].map(side => {
    const item = row[`${side}Individual`];
    const label = names[side];
    return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(number(item?.effect))}</td><td>${escapeHtml(item?.confidenceRange?.map(number).join(' to ') ?? 'Unavailable')}</td><td>${escapeHtml(item?.evidence ?? 'Unavailable')}</td><td>${escapeHtml(item ? `${item.usableBinCount} / ${item.missingBinCount}` : 'Unavailable')}</td><td>${resultLink(row.runId, row[`${side}AnalysisId`])}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function comparisonStatus(status, names) {
  switch (status) {
    case 'paired': return 'Both analyses available';
    case 'missing_left': return `No analysis for ${names.left}`;
    case 'missing_right': return `No analysis for ${names.right}`;
    case 'unavailable_left': return `${names.left} analysis unavailable`;
    case 'unavailable_right': return `${names.right} analysis unavailable`;
    case 'source_mismatch': return `${names.left} and ${names.right} analyses used different saved inputs`;
    case 'target_mismatch': return `${names.left} and ${names.right} analyses have different target assignments or response intervals`;
    case 'profile_mismatch': return `One analysis does not match its selected saved profile (${names.left} or ${names.right})`;
    case 'statistical_version_mismatch': return `${names.left} and ${names.right} analyses use different calculation versions`;
    default: return 'Analysis pair unavailable';
  }
}

export function renderComparisonSection({candidates = {profiles: [], runs: []}, saved = {comparisons: []},
  selected = null, busy = false, leftProfileId = null, rightProfileId = null} = {}) {
  const profiles = candidates?.profiles ?? [];
  const runs = candidates?.runs ?? [];
  const first = leftProfileId ?? profiles[0]?.profileId ?? '';
  const second = rightProfileId ?? profiles.find(item => item.profileId !== first)?.profileId ?? '';
  const names = selected ? {
    left: selected.leftProfile?.label ?? selected.leftProfile?.profile?.label ?? profileName(profiles, selected.leftProfile?.profile?.profileId),
    right: selected.rightProfile?.label ?? selected.rightProfile?.profile?.label ?? profileName(profiles, selected.rightProfile?.profile?.profileId),
  } : null;
  const profileOptions = current => profiles.map(item => `<option value="${escapeHtml(item.profileId)}"${item.profileId === current ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
  const includedRuns = selected?.commonPrefixRunIds ?? [];
  const includedNames = includedRuns.map(id => selected.rows.find(row => row.runId === id)?.tag || id.slice(0, 12));
  const included = includedRuns.length
    ? `Both accumulated results include ${includedRuns.length} recording${includedRuns.length === 1 ? '' : 's'}: ${includedNames.map(escapeHtml).join(', ')}.`
    : 'Both accumulated results include no recordings yet.';
  const inventory = runs.length ? `<div class="table-scroll"><table><caption>Chronological recording inventory</caption><thead><tr><th>Use</th><th>Recording</th><th>First analysis</th><th>Second analysis</th></tr></thead><tbody>${runs.map((run, index) =>
    `<tr><td><label><input type="checkbox" name="include_${index}" checked${disabled(busy)}> Include</label></td><td>${escapeHtml(run.tag || run.runId)}<br><small>${escapeHtml(run.runId)} · ${escapeHtml(date(run.recordingStartedAtMs ?? run.createdAtMs))}</small></td><td>${revisions(run, profiles, first, 'left', index, busy)}</td><td>${revisions(run, profiles, second, 'right', index, busy)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty-state">Import a preparation Tree recording to compare analyses.</p>';
  const savedList = saved?.comparisons?.length ? `<div class="table-scroll"><table><caption>Saved comparisons</caption><thead><tr><th>Name</th><th>Saved</th><th>Common completed recordings</th><th>Open</th></tr></thead><tbody>${saved.comparisons.map(item => `<tr><td>${escapeHtml(item.label)}</td><td>${escapeHtml(date(item.createdAtMs))}</td><td>${escapeHtml(item.commonPrefixRunIds?.length ?? 0)}</td><td><button type="button" data-analysis-operation="open-comparison" data-comparison-id="${escapeHtml(item.comparisonId)}"${disabled(busy)}>Open comparison</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-state">No saved comparisons yet.</p>';
  const detail = selected ? `<div class="jobs"><article class="job"><h3>${escapeHtml(selected.label)}</h3><p>${included} Both stop before the first recording with a missing or incompatible analysis pair. Matching footage is analyzed twice for method development and is not counted twice as observations. A larger effect or E does not establish tracking accuracy.</p><div class="button-row"><a href="${escapeHtml(sideLink(selected.comparisonId, 'left'))}" target="_blank" rel="noopener">Open ${escapeHtml(names.left)} accumulated result</a><a href="${escapeHtml(sideLink(selected.comparisonId, 'right'))}" target="_blank" rel="noopener">Open ${escapeHtml(names.right)} accumulated result</a></div><p class="field-help">Effect and 95% simultaneous confidence ranges are in relative-share percentage points. Usable and missing bins count response measurement intervals.</p>${selected.rows.map(row => `<article class="job"><h4>${escapeHtml(row.tag || 'Untitled recording')} · ${escapeHtml(date(row.recordingStartedAtMs ?? row.createdAtMs))} · <span class="tree-run-id" title="${escapeHtml(row.runId)}">${escapeHtml(row.runId.slice(0, 12))}</span> · ${escapeHtml(comparisonStatus(row.status, names))}</h4>${individualRows(row, names)}</article>`).join('')}<details class="retained-details"><summary>Full retained comparison</summary><div class="table-scroll"><pre>${escapeHtml(JSON.stringify(selected, null, 2))}</pre></div></details></article></div>` : '';
  return `<section class="panel"><h2>Compare analysis methods</h2><p>Choose two saved preparation profiles and exact revisions for each recording. Missing or incompatible analysis pairs stay visible; both accumulated results include only the same earlier recordings.</p><form data-analysis-form="save-comparison"><div class="field"><label>Comparison name<input name="comparison_label" required${disabled(busy)}></label></div><div class="form-grid"><div class="field"><label>First profile<select name="left_profile_id"${disabled(busy)}>${profileOptions(first)}</select></label></div><div class="field"><label>Second profile<select name="right_profile_id"${disabled(busy)}>${profileOptions(second)}</select></label></div></div>${inventory}<button type="submit"${disabled(busy || !runs.length || profiles.length < 2)}>Save comparison</button></form>${savedList}${detail}</section>`;
}
