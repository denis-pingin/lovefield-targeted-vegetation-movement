import {publicStudyUrl} from './study-paths.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const dateTime = timestamp => Number.isFinite(timestamp) ? new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short'}).format(timestamp) : 'Time unavailable';
const executionLabels = {registered: 'Registered; sequence not started', in_progress: 'In progress', completed: 'Completed', interrupted: 'Interrupted or failed', completion_not_reported: 'Completion not reported'};
const dataLabels = {awaiting_publication: 'Data awaiting publication', published: 'Published', inventory_published: 'Inventory published; analysis awaiting publication', recording_partial: 'Partial recording reported', recording_unavailable: 'Recording unavailable, as reported', analysis_failed: 'Analysis issue reported', publication_failed: 'Publication issue reported'};
const issueLabels = {...dataLabels, correction: 'Correction', resolved: 'Resolution'};
function safeHttps(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
}
const focusAttribute = key => ` data-start-focus="${escapeHtml(key)}"`;
const link = (url, label, key) => safeHttps(url) ? `<a href="${escapeHtml(safeHttps(url))}"${focusAttribute(key)} target="_blank" rel="noopener">${escapeHtml(label)}</a>` : escapeHtml(label);
export function renderStartStatus(status, {error = null} = {}) {
  const registry = status?.registry ?? {}, synchronization = status?.synchronization ?? {};
  let html = '<h2>Registered runs</h2><p>Every scored run whose start is registered through the application is listed here, including runs whose sequence or recording is incomplete. This live inventory of registered runs updates independently of the selected publication.</p>';
  if (error) html += `<p class="error-text" role="status">${escapeHtml(error)} Retained start registration status remains below. The next status check will retry.</p>`;
  if (!status) return html + '<p class="empty-state">Start registration status is loading.</p>';
  if (registry.state === 'unconfigured') {
    html += '<p class="empty-state">Scored start registration has not been configured.</p>';
    if (!(status.registrations ?? []).length && synchronization.state !== 'failed') return html;
  }
  if (synchronization.state === 'failed') html += `<p class="error-text" role="status">${escapeHtml(synchronization.error?.message ?? 'Blockchain synchronization is unavailable.')} Cached start registrations remain visible; the next allowed check will retry.</p>`;
  else if (!synchronization.caughtUp) html += '<p class="field-help" role="status">Catching up with finalized blockchain records. Recent sealed start registrations are displayed immediately.</p>';
  if (synchronization.indexedBlock != null) html += `<p class="field-help">Indexed through block ${escapeHtml(synchronization.indexedBlock)}${Number.isFinite(synchronization.indexedAtMs) ? `; checked ${escapeHtml(dateTime(synchronization.indexedAtMs))}` : ''}.</p>`;
  if (!(status.registrations ?? []).length) html += '<p class="empty-state">No registered scored runs are retained yet.</p>';
  else html += '<div class="table-scroll publication-inventory"><table><caption>Live inventory of registered runs</caption><thead><tr><th scope="col">Run and start registration</th><th scope="col">Execution</th><th scope="col">Data and analysis</th></tr></thead><tbody>' + status.registrations.map(registration => {
    const explorer = safeHttps(registry.explorerUrl);
    const transactionUrl = explorer && /^0x[a-f0-9]{64}$/i.test(registration.transactionHash ?? '') ? `${explorer.replace(/\/$/, '')}/tx/${registration.transactionHash}` : null;
    const execution = registration.execution ?? {}, data = registration.data ?? {};
    const key = registration.attestationUid;
    return `<tr><th scope="row"><div class="recording-id">${escapeHtml(registration.runId)}</div><p class="field-help">${escapeHtml(dateTime(registration.chainTimestamp * 1000))}</p><p>${link(transactionUrl, 'Start registration', `${key}:transaction`)} · block ${escapeHtml(registration.blockNumber)}</p><p class="field-help">${registration.confirmation === 'finalized' ? 'Finalized start registration' : registration.confirmation === 'receipt_issue' ? 'Start registration receipt issue' : 'Sealed start registration; finalization pending'}</p>${registration.registryIssue ? `<p class="error-text">${escapeHtml(registration.registryIssue.message)}</p>` : ''}${registration.conflict || registration.duplicateRun ? '<p class="error-text">Multiple start registrations use this run identity. Fixed data conflicts remain flagged.</p>' : ''}<details class="retained-details" data-start-details="${escapeHtml(key)}:identity"><summary${focusAttribute(`${key}:identity`)}>Start registration identity</summary><p>Series: <span class="recording-id">${escapeHtml(registration.seriesId)}</span></p><p>Attestation: <span class="publication-identity">${escapeHtml(registration.attestationUid)}</span></p><p>Configuration: <span class="publication-identity">${escapeHtml(registration.configHash)}</span></p><p>Source: <span class="publication-identity">${escapeHtml(registration.sourceCheckpoint)}</span></p></details></th>`
      + `<td><p>${escapeHtml(executionLabels[execution.state] ?? 'Completion not reported')}</p>${Number.isFinite(execution.startedAtMs) ? `<p class="field-help">Sequence started ${escapeHtml(dateTime(execution.startedAtMs))}.</p>` : ''}${Number.isFinite(execution.finishedAtMs) ? `<p class="field-help">Sequence ended ${escapeHtml(dateTime(execution.finishedAtMs))}.</p>` : ''}${execution.reason ? `<p>${escapeHtml(execution.reason)}</p>` : ''}</td>`
      + `<td><p>${escapeHtml(dataLabels[data.state] ?? 'Data status unavailable')}</p>${safeHttps(registration.streamUrl) ? `<p>${link(registration.streamUrl, 'Optional stream', `${key}:stream`)}</p>` : ''}${(data.publications ?? []).map(publication => `<p><a href="${escapeHtml(publicStudyUrl('recording', publication.publicationId, registration.runId))}"${focusAttribute(`${key}:publication:${publication.publicationId}`)}>${publication.analysisPublished ? 'Published material' : 'Published inventory'}</a></p><p class="recording-id">${escapeHtml(publication.publicationId)}</p>`).join('')}${registration.issues?.length ? `<details class="retained-details" data-start-details="${escapeHtml(key)}:issues"><summary${focusAttribute(`${key}:issues`)}>Dated issue reports (${registration.issues.length})</summary><ul>${registration.issues.map(issue => `<li><p>${escapeHtml(dateTime(issue.reportedAtMs))}: ${escapeHtml(issueLabels[issue.category] ?? issue.category)}</p><p>${escapeHtml(issue.reason)}</p></li>`).join('')}</ul></details>` : ''}</td></tr>`;
  }).join('') + '</tbody></table></div>';
  return html + `<details class="retained-details" data-start-details="registry"><summary${focusAttribute('registry')}>Independent registry verification</summary><p>Network: ${escapeHtml(registry.network)}. First block: ${escapeHtml(registry.fromBlock)}.</p><p>Dedicated signer: ${link(registry.signerUrl, registry.signerAddress, 'registry:signer')}</p><p>${link(registry.contractUrl, 'Ethereum Attestation Service contract', 'registry:contract')}</p><p>Non-revocable start schema: <span class="publication-identity">${escapeHtml(registry.schemaUid)}</span></p><p>A start registration records fixed run identity. Execution reports and committed files show what happened afterward.</p></details>`;
}

export function updateStartStatus(container, status, {document = container.ownerDocument, ...options} = {}) {
  const open = new Set([...container.querySelectorAll('[data-start-details]')].filter(item => item.open).map(item => item.dataset.startDetails));
  const focused = container.contains(document?.activeElement) ? document.activeElement?.dataset.startFocus : null;
  container.innerHTML = renderStartStatus(status, options);
  for (const item of container.querySelectorAll('[data-start-details]')) item.open = open.has(item.dataset.startDetails);
  if (focused) [...container.querySelectorAll('[data-start-focus]')].find(item => item.dataset.startFocus === focused)?.focus({preventScroll: true});
}

export function createStatusPoll({document, window, read, onStatus, onError}) {
  let disposed = false, inFlight = null;
  function refresh() {
    if (disposed || document.hidden) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {const value = await read(); if (!disposed) onStatus(value);}
      catch (error) {if (!disposed) onError(error);}
      finally {inFlight = null;}
    })();
    return inFlight;
  }
  const visible = () => refresh();
  document.addEventListener('visibilitychange', visible);
  const timer = window.setInterval(refresh, 60000);
  return {refresh, dispose() {disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible);}};
}
