import {PUBLIC_BASE, PUBLIC_API_BASE, CURRENT_STUDY_BASE, currentStudyFileUrl, publicStudyUrl, publicFileUrl as fileUrl, labPageForPath} from './study-paths.mjs';
import {renderTreeResults, mountTreeCharts, presentTreeReport} from './tree-results.mjs';
import {publicStudyContent, publicStudyIdentity} from './public-study-content.mjs';
import {renderPublicFigure, mountPublicFigures} from './public-study-figure.mjs';
import {publicStudyIllustration} from './public-study-illustration.mjs';
import {studyPages as pages, mountStudyNavigation} from './public-study-navigation.mjs';
import {renderScientificDocument} from './public-study-document.mjs';
import {renderLabPage, renderLabFooter, labPageTitles} from './lab-public.mjs';
import {renderStartStatus, updateStartStatus, createStatusPoll} from './start-status.mjs';
export {publicStudyUrl} from './study-paths.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
function download(publication, sha256, label) {
  const url = fileUrl(publication, sha256);
  return url ? `<a href="${escapeHtml(url)}" download>${escapeHtml(label)}</a>` : `<span class="empty-state">${escapeHtml(label)} is unavailable.</span>`;
}
function dateTime(timestamp) {
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short'}).format(timestamp) : 'Time unavailable';
}
function cameraReferenceTime(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().replace('T', ' ').replace('Z', ' UTC') : 'Time unavailable';
}
const counted = (value, noun) => `${escapeHtml(value ?? 'Unavailable')} ${noun}${value === 1 ? '' : 's'}`;
function reportInterpretation(report, paragraphLimit = Infinity) {
  const presentation = presentTreeReport(report, {audience: 'public'});
  return (presentation.status === null ? '' : `<p>${escapeHtml(presentation.status ?? 'Result status unavailable')}</p>`)
    + (presentation.caveat ? `<p>${escapeHtml(presentation.caveat)}</p>` : '')
    + presentation.narrative.slice(0, paragraphLimit).map(text => `<p>${escapeHtml(text)}</p>`).join('');
}
function correctionHistory(publication) {
  return (publication.correctionReason ? `<p>Correction: ${escapeHtml(publication.correctionReason)}</p>` : '')
    + (publication.previousPublicationId ? `<p><a href="${escapeHtml(publicStudyUrl('results', publication.previousPublicationId))}">Earlier result version</a></p>` : '');
}
function resultDates(publication, metadata) {
  const mostRecent = publication.inventory?.filter(item => item.contributes).at(-1);
  const context = (Number.isFinite(metadata?.completedAtMs) ? `<p>Results updated ${escapeHtml(dateTime(metadata.completedAtMs))}.</p>` : '')
    + (Number.isFinite(mostRecent?.recordingStartedAtMs) ? `<p>Includes recordings through ${escapeHtml(dateTime(mostRecent.recordingStartedAtMs))}.</p>` : '')
    + correctionHistory(publication);
  return context ? `<div class="publication-context">${context}</div>` : '';
}
function resultVersion(publication) {
  return '<details class="retained-details"><summary>About this result version</summary><p>A result version is a saved set of recordings, analyses, settings and files. Its identifier lets you cite and reopen the same set after later updates.</p>'
    + `<p class="publication-identity">${escapeHtml(publication.publicationId)}</p>${correctionHistory(publication)}</details>`;
}
function inventoryTable(publication, catalog) {
  const rows = (publication.inventory ?? []).map(item => {
    const report = catalog?.reports?.[item.runId], configuration = catalog?.runBundles?.[item.runId]?.config ?? catalog?.seriesBundle?.config;
    const response = configuration?.tree?.responseSeconds, plannedCount = configuration?.tree?.count;
    return `<tr><th scope="row"><a href="${escapeHtml(publicStudyUrl('recording', publication.publicationId, item.runId))}">${escapeHtml(item.tag || item.runId)}</a><div class="recording-id">${escapeHtml(item.runId)}</div><p class="field-help">Recording<br>${escapeHtml(dateTime(item.recordingStartedAtMs))}</p></th>`
      + `<td><p>${Number.isFinite(response) ? `${escapeHtml(response)} seconds per target` : 'Response duration unavailable'}</p><p>${report?.counts?.targets != null ? counted(report.counts.targets, 'generated target') : Number.isSafeInteger(plannedCount) ? `${counted(plannedCount, 'planned target')}; generated count unavailable` : 'Target count unavailable'}</p></td>`
      + `<td>Collection: ${escapeHtml(item.lifecycle ?? 'unavailable')}<p>Analysis: ${escapeHtml(item.analysisState ?? 'pending')}</p>${item.analysisReason ? `<p>${escapeHtml(item.analysisReason)}</p>` : ''}${(item.analysis?.qualificationReasons ?? []).map(reason => `<p>${escapeHtml(reason)}</p>`).join('')}<p>${item.contributes ? 'Included in accumulated result' : item.analysisState === 'completed' ? 'Awaiting earlier recordings' : 'Pending for accumulated result'}</p></td>`
      + `<td>${report ? reportInterpretation(report, 2) + `<p>Individual E: ${escapeHtml(report.evidence?.label ?? 'unavailable')}</p>` : '<p class="empty-state">Individual result unavailable.</p>'}</td></tr>`;
  }).join('');
  return `<div class="table-scroll publication-inventory"><table><caption>Every collected recording in this publication</caption><thead><tr><th scope="col">Recording</th><th scope="col">Saved settings</th><th scope="col">Collection and analysis status</th><th scope="col">Individual result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function setupFigure(publication, setup) {
  const image = fileUrl(publication, setup?.imageSha256);
  if (!image || !setup.imageSize) return '<p class="empty-state">No saved setup image is available for this recording.</p>';
  return renderPublicFigure({imageUrl: image, originalUrl: image, imageSize: setup.imageSize, regions: setup.regions,
    caption: 'Saved Region A, Region B and stationary reference for this recording.',
    alt: 'Original saved Tree setup image with outlined Region A, Region B and stationary reference.'});
}

function methodIllustration() {
  return renderPublicFigure(publicStudyIllustration) + '<div class="public-prose"><h3>What the marks show</h3>'
    + '<p>Magenta marks belong to Region A; cyan marks belong to Region B. Each dot marks an image detail matched between two consecutive frames. A short line shows its measured direction and distance of movement, enlarged 10 times to make it visible.</p>'
    + '<p>The small yellow region is a stationary reference used to check camera movement.</p>'
    + '<details class="retained-details"><summary>How are these tracking marks drawn?</summary><p>The actual matched image details are replayed on the original video frame, with the saved regions and positions. Only the drawn lines are enlarged 10 times. The recorded movements and analysis values are unchanged. Dots remain at their actual matched positions.</p></details></div>';
}
const roleLabels = {'camera-original': 'Unchanged camera original', 'viewing-video': 'Browser viewing copy', 'setup-image': 'Saved setup image',
  'run-bundle': 'Recorded instructions and run records', 'series-bundle': 'Frozen series and recording inventory',
  analysis: 'Complete saved analysis', measurement: 'Complete measurements', report: 'Saved readable report', profile: 'Analysis settings',
  'clock-map': 'Saved camera clock mapping', 'footage-review': 'Saved footage review', 'reproduction-inputs': 'Exact input associations', source: 'Source software', protocol: 'Protocol or methods'};
function scientificSettings(configuration, profile) {
  const tree = configuration?.tree, video = profile?.video;
  const areaGrid = video?.measurement?.method === 'area-grid-mean-v1';
  const measurementSettings = areaGrid ? [
    Number.isFinite(video.measurement.pointsPerCell) ? `${escapeHtml(video.measurement.pointsPerCell)} maximum feature points per full grid cell.` : '',
    Number.isFinite(video.measurement.cellSizePixels) ? `Grid cell size: ${escapeHtml(video.measurement.cellSizePixels)} × ${escapeHtml(video.measurement.cellSizePixels)} pixels.` : '',
  ].filter(Boolean).join(' ') : Number.isFinite(video?.featureDetection?.maxCorners) ? `${escapeHtml(video.featureDetection.maxCorners)} maximum feature points per region.` : '';
  return `<h3>Recording and analysis settings</h3><p>${tree ? `${escapeHtml(tree.responseSeconds)} seconds per target · ${escapeHtml(tree.count)} planned targets · ${escapeHtml(tree.preRollSeconds ?? 'unavailable')} seconds absent before · ${escapeHtml(tree.postRollSeconds ?? 'unavailable')} seconds absent after` : 'Recording settings unavailable.'}</p>`
    + (video ? `<p>Measurement: ${escapeHtml(video.measurement?.method ?? 'feature-mean-v1')}. ${measurementSettings} ${video.tracking?.windowSizePixels ? `Tracking window: ${escapeHtml(video.tracking.windowSizePixels.join(' × '))} pixels.` : ''}</p>` : '<p>Analysis settings unavailable.</p>')
    + (configuration ? `<details class="retained-details"><summary>View exact recording settings</summary><pre>${escapeHtml(JSON.stringify(configuration, null, 2))}</pre></details>` : '')
    + (profile ? `<details class="retained-details"><summary>View exact analysis settings</summary><pre>${escapeHtml(JSON.stringify(profile, null, 2))}</pre></details>` : '');
}
function timingAndReview(recording) {
  const videos = Object.values(recording.reproductionInputs?.recordings ?? {}).filter(item => item.kind === 'video');
  return '<h3>Camera clock alignment and footage review</h3>' + (!videos.length ? '<p>Saved camera alignment is unavailable.</p>' : '')
    + videos.map(video => `<p class="publication-identity">Camera recording: ${escapeHtml(video.recordingId)}</p><p>${video.timeMappingQualified === true ? 'Clock mapping qualified.' : video.timeMappingQualified === false ? 'Clock mapping unqualified.' : 'Clock mapping qualification unavailable.'}</p>`
      + (video.timeMappingQualityReasons ?? []).map(reason => `<p>${escapeHtml(reason)}</p>`).join('')
      + (video.clockMap?.references?.length ? `<ul>${video.clockMap.references.map(reference => `<li>Frame ${escapeHtml(reference.frameIndex)} at ${escapeHtml(reference.ptsSeconds)} video seconds: ${escapeHtml(cameraReferenceTime(reference.serverDisplayedAtMs))}${reference.clockUncertaintyMs != null ? `; clock uncertainty ${escapeHtml(reference.clockUncertaintyMs)} milliseconds` : ''}.</li>`).join('')}</ul><details class="retained-details"><summary>View exact camera alignment</summary><pre>${escapeHtml(JSON.stringify(video.clockMap, null, 2))}</pre></details>` : '<p>No retained clock references are available.</p>')).join('')
    + (recording.footageReviews?.length ? recording.footageReviews.map(review => `<p>Footage review: ${escapeHtml(review.decision ?? 'unavailable')}.</p>${review.spans?.length ? `<ul>${review.spans.map(span => `<li>Frames ${escapeHtml(span.startFrameIndex)} through ${escapeHtml(span.endFrameIndex)}.</li>`).join('')}</ul>` : '<p>No obstructed frame spans are recorded in this review.</p>'}`).join('') : '<p>Saved footage-review decision is unavailable.</p>');
}
function recordingPage(publication, report, recording) {
  const item = recording?.inventory, analysis = item?.analysis;
  if (!item) return `<p class="empty-state">This recording is not in the selected publication. Open <a href="${escapeHtml(publicStudyUrl('recordings', publication.publicationId))}">Study data</a> to choose a retained recording.</p>`;
  const videos = (analysis?.videos ?? []).map(video => {
    const viewing = video.viewingSha256 ?? video.originalSha256, url = fileUrl(publication, viewing);
    return `<figure class="public-recording-video"><figcaption>Camera recording</figcaption>${url ? `<video controls src="${escapeHtml(url)}" preload="metadata">Your browser cannot play this video. Download the retained file to view it.</video>` : '<p class="empty-state">No video file is available.</p>'}`
      + `<p>${video.viewingSha256 && video.viewingSha256 !== video.originalSha256 ? 'This viewing copy was converted for browser playback. It does not replace the unchanged camera original used for analysis.' : 'This is the unchanged camera original used for analysis.'}</p><p>${download(publication, video.originalSha256, 'Download unchanged camera original')}</p></figure>`;
  }).join('');
  const inputHashes = [...new Set([analysis?.runBundleSha256, analysis?.analysisSha256, analysis?.reportSha256,
    analysis?.profileSha256, analysis?.reproductionInputsSha256, ...(analysis?.inputSha256s ?? [])].filter(Boolean))];
  return `<section class="panel"><p class="publication-identity">Recording: ${escapeHtml(item.runId)}</p><p>Saved analysis: ${escapeHtml(item.analysisState ?? 'pending')}. ${item.contributes ? 'Included in the accumulated result.' : 'Not yet included in the accumulated result.'}</p>`
    + (item.analysisReason ? `<p class="empty-state">${escapeHtml(item.analysisReason)}</p>` : '')
    + [...(analysis?.qualificationReasons ?? []), ...(analysis?.missingReasons ?? [])].map(reason => `<p>${escapeHtml(reason)}</p>`).join('')
    + (analysis ? `<p class="publication-identity">Selected analysis: ${escapeHtml(analysis.analysisId)}</p>` : '')
    + videos + (!videos ? '<p class="empty-state">No camera video is available in this publication for this recording.</p>' : '')
    + (recording.runBundle ? setupFigure(publication, recording.runBundle.state?.setupSnapshot) : '')
    + scientificSettings(recording.runBundle?.config, recording.profile) + timingAndReview(recording)
    + (report ? renderTreeResults({report}, {audience: 'public'}) : '<p class="empty-state">The analysis report is pending.</p>')
    + `<details class="retained-details"><summary>Collection and analysis source identity</summary><p class="publication-identity">Collection release: ${escapeHtml(item.codeCheckpoint ?? 'unavailable')}</p><pre>${escapeHtml(JSON.stringify(publication.sourceReleases?.analyses?.[analysis?.analysisId] ?? {status: 'Analysis source unavailable'}, null, 2))}</pre></details>`
    + (inputHashes.length ? `<h3>Retained inputs and complete outputs</h3><ul>${inputHashes.map(sha256 => {const file = publication.files[sha256]; return `<li>${download(publication, sha256, roleLabels[file?.role] ?? file?.role ?? 'Retained file')}<details class="retained-details"><summary>File identity</summary><p>${escapeHtml(file?.filename ?? 'Filename unavailable')}</p><p class="publication-identity">${escapeHtml(sha256)}</p></details></li>`;}).join('')}</ul>` : '') + '</section>';
}
function currentDownload(study, kind, label) {
  const url = currentStudyFileUrl(study, kind);
  return url ? `<a href="${escapeHtml(url)}" download>${escapeHtml(label)}</a>` : `<span class="empty-state">${escapeHtml(label)} is unavailable.</span>`;
}
function currentVersion(study) {
  return study ? '<details class="retained-details"><summary>Current study version</summary><p>The source fingerprint identifies the exact developing documents and software in this release.</p>'
    + `<p class="publication-identity">${escapeHtml(study.source.contentSha256)}</p></details>` : '';
}
function methodsPage(publication, content, study) {
  const presentation = publication?.reportPresentation ?? {};
  return `<section class="panel public-prose">${publication ? '' : `<p>${escapeHtml(content.currentMaterials)}</p>${currentVersion(study)}`}<h2><a href="${escapeHtml(publicStudyUrl('protocol', publication?.publicationId))}">Study protocol</a></h2><p>${escapeHtml(content.methods.protocol)}</p><p class="site-supporting-copy">${publication ? download(publication, presentation.protocolSha256, 'Download study protocol') : currentDownload(study, 'protocol', 'Download study protocol')}</p>`
    + `<h2><a href="${escapeHtml(publicStudyUrl('analysis', publication?.publicationId))}">Analysis methods</a></h2><p>${escapeHtml(content.methods.analysis)}</p><p class="site-supporting-copy">${publication ? download(publication, presentation.methodsSha256, 'Download analysis methods') : currentDownload(study, 'methods', 'Download analysis methods')}</p></section>`
    + `<section class="panel public-prose"><p>${escapeHtml(content.methods.reproduction)}</p><div class="site-link-group"><a href="${escapeHtml(publicStudyUrl('reproducibility', publication?.publicationId))}">Reproducibility</a></div></section>`;
}
function currentReproducibility(study, content) {
  return `<section class="panel public-prose"><h2 id="source-packages">Current study software</h2><p>${escapeHtml(content.currentMaterials)}</p>${currentVersion(study)}`
    + `<p>${currentDownload(study, 'source', 'Download source package')}</p>`
    + (study?.repositoryUrl ? `<p><a href="${escapeHtml(study.repositoryUrl)}">Inspect source repository</a></p>` : '')
    + `<p>Extract the source package to inspect the collection software, analysis code, tests and declared dependencies. Follow its README and publication-release-guide.md for installation and calculation instructions.</p><p><a href="${escapeHtml(publicStudyUrl('methods'))}">Read study methods</a></p></section>`
    + (study ? `<section class="panel"><details class="retained-details"><summary>Files and checksums</summary><p>A checksum is a file fingerprint that verifies the exact downloaded bytes.</p><ul class="publication-files">${Object.entries(study.files).map(([kind, file]) => `<li>${currentDownload(study, kind, file.filename)}<span>${escapeHtml(file.size)} bytes</span><span class="publication-identity">${escapeHtml(file.sha256)}</span></li>`).join('')}</ul></details></section>` : '');
}
function reproducibilityPage(publication, content, settings) {
  const presentation = publication.reportPresentation ?? {}, releases = publication.sourceReleases ?? {};
  const packages = [...new Map(Object.values(releases.packages ?? {}).map(item => [item.sha256, item])).values()];
  return `<section class="panel"><h2>Saved settings and result version</h2><p>${escapeHtml(content.reproducibility.description)}</p><p><a href="${escapeHtml(publicStudyUrl('methods', publication.publicationId))}">Read study methods</a></p>${resultVersion(publication)}`
    + (settings?.seriesBundle?.config ? `<details class="retained-details"><summary>View frozen series settings</summary><pre>${escapeHtml(JSON.stringify(settings.seriesBundle.config, null, 2))}</pre></details>` : '')
    + (settings?.profiles ?? []).map(profile => `<details class="retained-details"><summary>View saved analysis profile: ${escapeHtml(profile.label ?? profile.profileId ?? 'Frozen profile')}</summary><pre>${escapeHtml(JSON.stringify(profile, null, 2))}</pre></details>`).join('')
    + `<ul>${[...new Set((publication.inventory ?? []).map(item => item.analysis?.profileSha256).filter(Boolean))].map(sha256 => `<li>${download(publication, sha256, 'Download saved analysis profile')}</li>`).join('')}</ul></section>`
    + `<section class="panel"><h2 id="source-packages">Software actually used</h2>${packages.length ? `<p>The retained source packages identify the software used for this result.</p><ul>${packages.map(item => `<li>${download(publication, item.sha256, 'Download source package')}<details class="retained-details"><summary>Source package version</summary><p class="publication-identity">${escapeHtml(item.origin?.checkpoint ?? item.contentSha256 ?? item.sha256)}</p></details></li>`).join('')}</ul>` : '<p class="empty-state">No source package is available for this result version.</p>'}`
    + (publication.seriesBundle?.codeCheckpoint ? `<details class="retained-details"><summary>Collection software version</summary><p class="publication-identity">${escapeHtml(publication.seriesBundle.codeCheckpoint)}</p></details>` : '')
    + `<details class="retained-details"><summary>Collection, analysis and report identities</summary><pre>${escapeHtml(JSON.stringify({collection: releases.collection, events: releases.events, analyses: releases.analyses, accumulation: releases.accumulation, reportPresentation: presentation}, null, 2))}</pre></details></section>`
    + `<section class="panel"><h2>Reproduce the results</h2><p>${escapeHtml(content.reproducibility.reproduction)}</p><p><a href="${PUBLIC_API_BASE}publications/${encodeURIComponent(publication.publicationId)}/manifest" download="manifest.json">Download publication manifest</a></p><p>Extract the source package and follow its publication-release-guide.md. Install the declared dependencies, retain the manifest and every listed file, and run:</p><pre>python scripts/reproduce-publication.py --publication /absolute/download/manifest.json --files /absolute/download/files --output /absolute/reproduction</pre><p>Keep the downloaded filenames. The reproduction command accepts the unique original filenames supplied by the browser, or full SHA-256 filenames. It can download all listed files using <code>--url</code> and <code>--download</code>.</p></section>`
    + `<section class="panel"><details class="retained-details"><summary>Files and checksums</summary><p>A checksum is a file fingerprint that verifies the exact downloaded bytes. These files and checksums are retained in the manifest for this result version.</p><ul class="publication-files">${Object.entries(publication.files ?? {}).map(([sha256, file]) => `<li>${download(publication, sha256, file.filename)}<span>${escapeHtml(file.role)} · ${escapeHtml(file.size)} bytes</span><span class="publication-identity">${escapeHtml(sha256)}</span></li>`).join('')}</ul></details></section>`;
}

function pageTitle(page, scientificDocument, recording, content = publicStudyContent) {
  if (scientificDocument) return scientificDocument.title;
  if (page === 'recording') {
    const name = recording?.inventory?.tag || recording?.inventory?.runId || recording?.runId;
    return name ? `Recording: ${name}` : 'Recording details';
  }
  return (content[page] ?? content.about).title;
}

export function renderPublicStudy({page = 'about', publication = null, study = null, report = null, recording = null, content = publicStudyContent, settings = null, publicationMetadata = null, catalog = null, scientificDocument = null, status = null} = {}) {
  const selected = content[page] ?? content.about;
  let body = '';
  if (page === 'about') body = `<section class="panel public-prose"><h2>Study objective</h2><p>${escapeHtml(content.about.objective)}</p></section>`
    + `<section class="panel"><h2>The randomized procedure</h2><p>${escapeHtml(content.about.procedure)}</p>${methodIllustration()}</section>`
    + `<section class="panel public-prose"><h2>Analysis and interpretation</h2><p>${escapeHtml(content.about.interpretation)}</p></section>`
    + `<section class="panel public-prose"><h2>Accumulating evidence</h2><p>${escapeHtml(content.about.accumulation)}</p><a href="${escapeHtml(publicStudyUrl('results', publication?.publicationId))}">View accumulating results</a></section>`
    + `<section class="panel public-prose"><h2>Independent verification</h2><p>${escapeHtml(content.about.inspection)}</p>${publication ? `<p><a href="${escapeHtml(publicStudyUrl('protocol', publication.publicationId))}">Read study protocol</a></p><p>${download(publication, publication.reportPresentation?.protocolSha256, 'Download study protocol')}</p>` : ''}<div class="site-link-group"><a href="${escapeHtml(publicStudyUrl('recordings', publication?.publicationId))}">View study data</a><a href="${escapeHtml(publicStudyUrl('methods', publication?.publicationId))}">Read study methods</a></div></section>`;
  if (publication) {
    if (page === 'results') body = `<section class="panel"><p>${escapeHtml(content.results.description)}</p>${resultDates(publication, publicationMetadata)}${report ? renderTreeResults({report}, {audience: 'public', recordingUrl: runId => publicStudyUrl('recording', publication.publicationId, runId)}) : '<p class="empty-state">The saved report is unavailable.</p>'}</section><section class="panel"><h2>Collected recordings</h2>${inventoryTable(publication, catalog)}</section>`;
    if (page === 'recordings') body = `<section class="panel"><p>${escapeHtml(content.recordings.description)}</p>${inventoryTable(publication, catalog)}</section>`;
    if (page === 'recording') body = recordingPage(publication, report, recording);
    if (page === 'methods') body = methodsPage(publication, content);
    if (page === 'reproducibility') body = reproducibilityPage(publication, content, settings);
  } else {
    if (page === 'methods') body = methodsPage(null, content, study);
    if (page === 'reproducibility') body = currentReproducibility(study, content);
    if (['results', 'recordings'].includes(page)) body = `<section class="panel public-prose"><p class="empty-state">${escapeHtml(page === 'results' ? content.empty : content.emptyRecordings)}</p><p>${escapeHtml(content.emptyDescription)}</p><p><a href="${escapeHtml(publicStudyUrl('methods'))}">Read study methods</a></p></section>`;
    if (page === 'recording') body = `<section class="panel public-prose"><p class="empty-state">This recording is unavailable. Open <a href="${escapeHtml(publicStudyUrl('recordings'))}">Study data</a> to inspect published recordings.</p></section>`;
  }
  if (scientificDocument && ['protocol', 'analysis'].includes(page)) {
    const hash = page === 'protocol' ? publication?.reportPresentation.protocolSha256 : publication?.reportPresentation.methodsSha256;
    body = (scientificDocument.contents.length ? `<nav class="document-contents" aria-label="Document contents"><h2>Contents</h2><ul>${scientificDocument.contents.map(item => `<li data-heading-level="${item.level}"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.title)}</a></li>`).join('')}</ul></nav>` : '')
      + (publication ? '' : `<section class="panel public-prose"><p>${escapeHtml(content.currentMaterials)}</p>${currentVersion(study)}</section>`)
      + `<section class="panel reading-prose">${scientificDocument.html}</section><p class="site-supporting-copy">${publication ? download(publication, hash, 'Download Markdown') : currentDownload(study, page === 'protocol' ? 'protocol' : 'methods', 'Download Markdown')}</p>`;
  }
  const introduction = !publication && page === 'methods' ? content.currentMethodsIntroduction
    : !publication && page === 'reproducibility' ? content.currentSoftwareIntroduction : selected.introduction;
  if (page === 'recordings') body = `<section class="panel" id="registered-runs">${renderStartStatus(status)}</section>` + body;
  return `<main id="main" class="site-surface site-page__surface public-article" tabindex="-1"><div class="page-heading"><p class="site-supporting-copy study-context">${escapeHtml(publicStudyIdentity.name)}</p><h1>${escapeHtml(pageTitle(page, scientificDocument, recording, content))}</h1>${introduction ? `<p class="site-leading-paragraph">${escapeHtml(introduction)}</p>` : ''}</div>`
    + body + '</main>';
}

export async function mountPublicStudy({document, window, fetch = window.fetch.bind(window)}) {
  const root = document.getElementById('public-study-content'), errorPanel = document.getElementById('public-study-error');
  const updatePanel = document.getElementById('publication-update');
  const location = new URL(window.location.href), labPage = labPageForPath(location.pathname);
  const path = location.pathname.slice(PUBLIC_BASE.length).replace(/\/$/, '');
  const recordingId = path.startsWith('recordings/') ? decodeURIComponent(path.slice('recordings/'.length)) : null;
  const page = labPage ?? (recordingId ? 'recording' : path === 'methods/analysis' ? 'analysis' : path === 'protocol' || pages.some(([key]) => key === path) ? path : 'about');
  let publicationId = location.searchParams.get('publication'), unmountCharts = () => {}, figures = {dispose() {}}, hasRenderedStudy = false;
  let currentStatus = null, statusError = null;
  let footerPublicationId = publicationId;
  document.getElementById('lab-footer').innerHTML = renderLabFooter({publicationId});
  const navigation = mountStudyNavigation({document, window});
  navigation.update({page, publicationId});
  const updateContext = () => {
    navigation.update({page, publicationId});
    if (footerPublicationId !== publicationId) {
      document.getElementById('lab-footer').innerHTML = renderLabFooter({publicationId});
      footerPublicationId = publicationId;
    }
  };
  document.title = labPage ? labPage === 'index' ? 'Lovefield Lab' : `${labPageTitles[labPage]} · Lovefield Lab`
    : `${pageTitle(page)} · ${publicStudyIdentity.name} · Lovefield Lab`;
  if (labPage && labPage !== 'index') {
    root.innerHTML = renderLabPage({page: labPage, publicationId});
    return {dispose() { navigation.dispose(); }};
  }
  function failed(operation, error, {showInView = false} = {}) {
    const selectedPublication = Boolean(publicationId) || location.searchParams.has('publication');
    (window.console ?? console).warn(`Lovefield Lab ${operation} failed.`, {page, publicationId, type: error.name, status: error.status,
      fallback: labPage || selectedPublication ? 'Retry is available; the selected publication is preserved.'
        : 'Retry is available to load the current study materials.'});
    errorPanel.innerHTML = `<p>${escapeHtml(operation)} could not be loaded. Check your connection and access to ${labPage ? 'the Lab' : selectedPublication ? 'this publication' : 'this study'}, then retry.</p><button type="button" class="site-control" data-public-retry>Retry</button>`;
    errorPanel.hidden = false;
    if (showInView) {
      if (!hasRenderedStudy) root.innerHTML = labPage ? renderLabPage({page: labPage, publicationId, publicationUnavailable: true})
        : `<main id="main" class="site-surface site-page__surface public-article" tabindex="-1"><h1>${selectedPublication ? 'The published study could not be loaded' : 'The current study materials could not be loaded'}</h1><p class="site-supporting-copy">${selectedPublication ? 'Use Retry above to open this saved publication.' : 'Use Retry above to load the current study materials.'}</p></main>`;
      errorPanel.tabIndex = -1;
      errorPanel.focus({preventScroll: true});
      errorPanel.scrollIntoView({block: 'center'});
    }
  }
  async function readJson(url, {allowEmpty = false, onResponse} = {}) {
    const response = await fetch(url, {cache: 'no-store'});
    const value = await response.json();
    if (!response.ok) {
      if (allowEmpty && response.status === 404 && value.code === 'publication_not_found') return null;
      const error = new Error('Published data request failed.'); error.status = response.status; throw error;
    }
    onResponse?.(response);
    return value;
  }
  async function readPublication(onResponse) {
    if (location.searchParams.has('publication') && !publicationId) throw new Error('The selected publication identity is empty.');
    const publication = await readJson(`${PUBLIC_API_BASE}${publicationId ? `publications/${encodeURIComponent(publicationId)}` : 'latest'}`,
      {allowEmpty: !publicationId, onResponse});
    if (publicationId && publication?.publicationId !== publicationId) throw new Error('The returned publication does not match the selected identity.');
    return !publicationId && publication?.softwareTest === true ? null : publication;
  }
  async function readCurrentStudy() {
    const study = await readJson(`${CURRENT_STUDY_BASE}study.json`);
    if (study?.schemaVersion !== 1 || study.experimentSlug !== 'tree-targeting' || study.stage !== 'before-scored-collection'
      || !/^[a-f0-9]{64}$/.test(study.source?.contentSha256 ?? '')
      || !study.source?.files || typeof study.source.files !== 'object' || Array.isArray(study.source.files)
      || Object.entries(study.source.files).some(([filename, hash]) =>
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(filename) || filename.split('/').some(part => ['.', '..'].includes(part)) || !/^[a-f0-9]{64}$/.test(hash))
      || ['protocol', 'methods', 'source'].some(kind => !currentStudyFileUrl(study, kind)
        || !/^[a-f0-9]{64}$/.test(study.files[kind].sha256 ?? '') || !Number.isSafeInteger(study.files[kind].size) || study.files[kind].size < 0)
      || ['protocol', 'methods'].some(kind => study.source.files[study.files[kind].filename] !== study.files[kind].sha256)
      || study.repositoryUrl !== undefined && !/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(study.repositoryUrl)) {
      throw new Error('The current study descriptor is invalid.');
    }
    return study;
  }
  async function readCurrentDocument(study, kind) {
    const response = await fetch(currentStudyFileUrl(study, kind), {cache: 'no-store'});
    if (!response.ok) { const error = new Error('Current document request failed.'); error.status = response.status; throw error; }
    const bytes = await response.arrayBuffer(), descriptor = study.files[kind];
    const hash = Array.from(new Uint8Array(await (window.crypto ?? globalThis.crypto).subtle.digest('SHA-256', bytes)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== descriptor.size || hash !== descriptor.sha256) throw new Error('The current document does not match its saved file identity.');
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  }
  async function refresh() {
    let operation = labPage ? 'The study index' : 'The publication';
    try {
      if (labPage) {
        const publication = await readPublication();
        if (publication) { publicationId = publication.publicationId; updateContext(); }
        root.innerHTML = renderLabPage({page: labPage, publication, publicationId});
        hasRenderedStudy = true;
        errorPanel.hidden = true;
        return;
      }
      let publicationMetadata = null;
      const publication = await readPublication(response => {
        const completedAtMs = response.headers.get('X-Publication-Completed-At-Ms');
        publicationMetadata = {completedAtMs: /^\d+$/.test(completedAtMs ?? '') ? Number(completedAtMs) : null};
      });
      if (publication) {
        publicationId = publication.publicationId;
        if (!location.searchParams.has('publication')) window.history?.replaceState(null, '', publicStudyUrl(page, publicationId, recordingId) + location.hash);
        updateContext();
      }
      let report = null, recording = null, settings = null, catalog = null, scientificDocument = null, study = null;
      if (!publication) {
        operation = 'The current study materials';
        study = await readCurrentStudy();
        if (['protocol', 'analysis'].includes(page)) {
          operation = page === 'protocol' ? 'The current study protocol' : 'The current analysis methods';
          scientificDocument = renderScientificDocument(await readCurrentDocument(study, page === 'protocol' ? 'protocol' : 'methods'), {study, kind: page});
        }
      }
      const reads = new Map();
      const savedJson = url => {if (!reads.has(url)) reads.set(url, readJson(url)); return reads.get(url);};
      if (publication && page === 'results') {
        operation = 'The saved accumulated report';
        report = await savedJson(`${PUBLIC_API_BASE}publications/${publicationId}/reports/${publication.accumulated.reportSha256}`);
      }
      if (publication && ['results', 'recordings'].includes(page)) {
        operation = 'The recording catalog and saved settings';
        const seriesBundle = publication.seriesBundle.sha256 ? await savedJson(fileUrl(publication, publication.seriesBundle.sha256)) : null;
        const reports = {}, runBundles = {};
        await Promise.all(publication.inventory.filter(item => item.analysis).map(async item => {
          [reports[item.runId], runBundles[item.runId]] = await Promise.all([
            savedJson(`${PUBLIC_API_BASE}publications/${publicationId}/reports/${item.analysis.reportSha256}`),
            savedJson(fileUrl(publication, item.analysis.runBundleSha256)),
          ]);
        }));
        catalog = {seriesBundle, reports, runBundles};
      }
      if (publication && page === 'recording') {
        const inventory = publication.inventory.find(item => item.runId === recordingId);
        recording = {inventory, runId: recordingId};
        if (inventory?.analysis) {
          operation = 'The recording report and saved setup';
          [report, recording.runBundle, recording.profile, recording.reproductionInputs, recording.footageReviews] = await Promise.all([
            savedJson(`${PUBLIC_API_BASE}publications/${publicationId}/reports/${inventory.analysis.reportSha256}`),
            savedJson(fileUrl(publication, inventory.analysis.runBundleSha256)),
            inventory.analysis.profileSha256 ? savedJson(fileUrl(publication, inventory.analysis.profileSha256)) : null,
            inventory.analysis.reproductionInputsSha256 ? savedJson(fileUrl(publication, inventory.analysis.reproductionInputsSha256)) : null,
            Promise.all((inventory.analysis.inputSha256s ?? []).filter(sha256 => publication.files[sha256]?.role === 'footage-review').map(sha256 => savedJson(fileUrl(publication, sha256)))),
          ]);
        }
      }
      if (publication && page === 'reproducibility') {
        operation = 'The frozen settings';
        const profileHashes = [...new Set(publication.inventory.map(item => item.analysis?.profileSha256).filter(Boolean))];
        const [seriesBundle, ...profiles] = await Promise.all([
          publication.seriesBundle.sha256 ? readJson(fileUrl(publication, publication.seriesBundle.sha256)) : null,
          ...profileHashes.map(sha256 => readJson(fileUrl(publication, sha256))),
        ]);
        settings = {seriesBundle, profiles};
      }
      if (publication && ['protocol', 'analysis'].includes(page)) {
        operation = page === 'protocol' ? 'The saved study protocol' : 'The saved analysis methods';
        const hash = page === 'protocol' ? publication.reportPresentation?.protocolSha256 : publication.reportPresentation?.methodsSha256;
        const url = fileUrl(publication, hash);
        if (!url) throw new Error('The selected publication does not retain this scientific document.');
        const response = await fetch(url, {cache: 'no-store'});
        if (!response.ok) { const error = new Error('Published document request failed.'); error.status = response.status; throw error; }
        scientificDocument = renderScientificDocument(await response.text(), {publication, kind: page});
      }
      unmountCharts(); figures.dispose(); root.innerHTML = renderPublicStudy({page, publication, study, report, recording, settings, publicationMetadata, catalog, scientificDocument, status: currentStatus});
      applyStatus(currentStatus);
      unmountCharts = mountTreeCharts(root, window.ResizeObserver);
      figures = mountPublicFigures(root, {document, ResizeObserver: window.ResizeObserver});
      document.title = `${pageTitle(page, scientificDocument, recording)} · ${publicStudyIdentity.name} · Lovefield Lab`;
      if (!hasRenderedStudy && location.hash) {
        const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (target && root.contains?.(target)) { target.tabIndex = -1; target.scrollIntoView({block: 'start'}); target.focus({preventScroll: true}); }
      }
      hasRenderedStudy = true;
      errorPanel.hidden = true;
    } catch (error) { failed(operation, error, {showInView: true}); }
  }
  function applyStatus(status) {
    if (page === 'recordings' && hasRenderedStudy) {
      const inventory = document.getElementById('registered-runs');
      if (inventory) updateStartStatus(inventory, status, {document, error: statusError});
    }
    if (status?.latestPublicationId && status.latestPublicationId !== publicationId) {
      updatePanel.innerHTML = `<a href="${escapeHtml(publicStudyUrl(page, status.latestPublicationId, recordingId))}">New published results are available. Open the latest publication.</a>`;
      updatePanel.hidden = false;
    }
  }
  const retry = event => { if (event.target.closest('[data-public-retry]')) void refresh(); };
  errorPanel.addEventListener('click', retry);
  const poll = labPage ? null : createStatusPoll({document, window, read: () => readJson(`${PUBLIC_API_BASE}status`),
    onStatus: status => {currentStatus = status; statusError = null; applyStatus(status);},
    onError: error => {statusError = 'The live registered run status could not be refreshed.'; applyStatus(currentStatus); failed('The live registered run status check', error);}});
  await Promise.all([refresh(), poll?.refresh()]);
  applyStatus(currentStatus);
  return {refresh, dispose() { poll?.dispose(); unmountCharts(); figures.dispose(); navigation.dispose(); errorPanel.removeEventListener('click', retry); }};
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') void mountPublicStudy({document, window});
