/** Hosted study routes and the separate local analysis service. */
export const LAB_BASE = '/studies/';
export const LAB_PAGE_SLUGS = Object.freeze(['', 'legal', 'privacy', 'reuse', 'research-notice']);
export function labPageUrl(page = 'index', publicationId) {
  return `${LAB_BASE}${page === 'index' ? '' : `${page}/`}${publicationId ? `?publication=${encodeURIComponent(publicationId)}` : ''}`;
}
export function labPageForPath(pathname) {
  const match = /^\/studies(?:\/([^/]+))?\/?$/.exec(pathname);
  return match && LAB_PAGE_SLUGS.includes(match[1] ?? '') ? match[1] || 'index' : null;
}
export const STUDY_NAME = 'Targeted Vegetation Movement';
export const STUDY_BASE = '/studies/targeted-vegetation-movement/';
export const LEGACY_HOSTED_BASE = '/studies/tree-targeting/';
export function canonicalHostedStudyPath(pathname) {
  if (pathname === LEGACY_HOSTED_BASE.slice(0, -1)) return STUDY_BASE.slice(0, -1);
  return pathname.startsWith(LEGACY_HOSTED_BASE) ? STUDY_BASE + pathname.slice(LEGACY_HOSTED_BASE.length) : pathname;
}
export const PUBLIC_BASE = `${STUDY_BASE}public/`;
export const PUBLIC_API_BASE = `${PUBLIC_BASE}api/`;
export const CURRENT_STUDY_BASE = `${PUBLIC_BASE}current-study/`;
export function currentStudyFileUrl(study, kind) {
  const filename = {protocol: 'protocol.md', methods: 'analysis-methods.md', source: 'source.zip'}[kind];
  return filename && study?.files?.[kind]?.filename === filename ? CURRENT_STUDY_BASE + filename : null;
}
export const HOSTED_APP_BASE = `${STUDY_BASE}app/`;
export const HOSTED_API_BASE = `${HOSTED_APP_BASE}api/`;
export const PUBLICATION_API_BASE = `${HOSTED_API_BASE}publication/`;
export const LOCAL_ANALYSIS_BASE = '/tree-targeting/analysis/';
export const LOCAL_ANALYSIS_API = '/tree-targeting/api/analysis/';
export const LEGACY_BASE = '/tree-targeting/';
export const LEGACY_API_BASE = `${LEGACY_BASE}api/`;
export function publicStudyUrl(page, publicationId, runId) {
  const path = page === 'recording' ? `recordings/${encodeURIComponent(runId)}` : page === 'about' ? '' : page === 'analysis' ? 'methods/analysis' : page;
  return `${PUBLIC_BASE}${path}${publicationId ? `?publication=${encodeURIComponent(publicationId)}` : ''}`;
}
export function publicFileUrl(publication, sha256) {
  const file = publication?.files?.[sha256];
  return file ? `${PUBLIC_API_BASE}publications/${encodeURIComponent(publication.publicationId)}/files/${sha256}/${encodeURIComponent(file.filename)}` : null;
}
export const PUBLIC_ASSETS = Object.freeze([
  'app.css', 'public-study.mjs', 'start-status.mjs', 'lab-public.mjs', 'public-study-content.mjs', 'tree-results.mjs', 'study-paths.mjs',
  'public-study.css', 'public-study-figure.mjs', 'public-study-illustration.mjs', 'public-study-navigation.mjs', 'public-study-document.mjs', 'vendor/marked.mjs',
  'visual-identity/visual-identity.css', 'visual-identity/global.css', 'visual-identity/site-page.css', 'visual-identity/reading.css',
  'visual-identity/archivo.woff2', 'visual-identity/OFL.txt', 'visual-identity/identity-mark.svg',
  'visual-identity/energy-branches-magenta.webp', 'visual-identity/energy-branches-cyan.webp',
  'study-media/tree-tracking.webp', 'study-media/tree-tracking-1600.webp',
  'current-study/study.json', 'current-study/protocol.md', 'current-study/analysis-methods.md', 'current-study/source.zip',
]);
