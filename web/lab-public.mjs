import {labPageUrl} from './study-paths.mjs';
import {availableStudies, publicStudyIdentity, publicStudyContent} from './public-study-content.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

// Established proprietor details: website/src/foundation/company.ts and
// website/src/support/configuration.ts (CURRENT_SUPPORT_OPERATOR).
// Retained here so the extracted Lab reader has no parent-website dependency.
const contact = '<a href="mailto:message@sourceof.love">message@sourceof.love</a>';
const legalLink = publicationId => `<a href="${escapeHtml(labPageUrl('legal', publicationId))}">Legal and contact</a>`;
const informationPages = [
  ['legal', 'Legal and contact'], ['privacy', 'Privacy'],
  ['reuse', 'Copyright and reuse'], ['research-notice', 'Research notice'],
];
export const labPageTitles = Object.freeze(Object.fromEntries([['index', 'Lovefield Lab'], ...informationPages]));

const articles = {
  legal: '<p>Lovefield Lab is published by Pingin Reality, a sole proprietorship operated by Denis Pingin.</p>'
    + '<p>Bächlerstrasse 40<br>8046 Zürich<br>Switzerland</p>'
    + `<div class="site-link-group">${contact}<a href="tel:+41449741876">+41 44 974 18 76</a></div>`
    + '<p>UID: CHE-142.040.833<br>Commercial register: CH-020.1.090.918-4</p>'
    + `<h2>Questions and corrections</h2><p>Use ${contact} for scientific queries, corrections, privacy requests and reuse inquiries. Include the relevant study, recording or result link so the material can be identified.</p>`,
  privacy: publicationId => `<p>Pingin Reality, operated by Denis Pingin, is responsible for the Lab's handling of personal data. Contact details are in ${legalLink(publicationId)}.</p>`
    + '<h2>Delivery and security</h2><p>Cloudflare delivers and protects the Lab. It receives technical request information, including your IP address, requested URL, request time and browser information, for delivery and security.</p>'
    + '<p>The reader adds no advertising trackers or analytics. Videos, fonts and charts are served from the Lab rather than embedded advertising or video platforms.</p>'
    + '<p>Protected access uses Cloudflare Access and the configured Google sign-in. Identity information and session cookies support sign-in verification and security. These cookies are distinct from advertising cookies.</p>'
    + '<p>Data may be processed outside Switzerland by these providers. The <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare privacy policy</a> explains its technical and security processing, retention and international transfers. The <a href="https://policies.google.com/privacy">Google privacy policy</a> applies to Google sign-in.</p>'
    + '<h2>Research records and contact</h2><p>Research records can contain the practitioner\'s image and voice and study-related information. Contact the Lab about identifiable material in a recording.</p>'
    + '<p>Contact messages are used to handle the request and retained as needed to resolve it and meet legal obligations. The reader creates no visitor account or local browsing-history database.</p>'
    + `<h2>Your rights</h2><p>For access, correction, deletion or other applicable rights under Swiss data-protection law, contact ${contact} and identify the relevant material or request.</p>`,
  reuse: '<p>You are welcome to share links to the studies and inspect their methods and results.</p>'
    + `<h2>${escapeHtml(publicStudyIdentity.name)}</h2><p>The original study software is licensed under <a href="https://polyformproject.org/licenses/noncommercial/1.0.0">PolyForm Noncommercial 1.0.0</a>. Noncommercial reuse follows its terms. When distributing the software, include the license text or URL and its Required Notice.</p>`
    + '<p>The original study documents and published material, including recordings, images and reports, are licensed under <a href="https://creativecommons.org/licenses/by-nc/4.0/">Creative Commons Attribution-NonCommercial 4.0 International</a>. Reuse must be noncommercial and follow the license terms. When sharing the material, credit Denis Pingin, link to the original material and license, retain supplied notices, and identify changes.</p>'
    + '<p>These licenses cover only rights held by Denis Pingin. Separately identified third-party components and material retain their own licenses and notices.</p>'
    + '<h2>Other Lab material</h2><p>A package\'s stated license governs that package. Preserve its third-party notices.</p>'
    + '<p>Without an express license, republishing, translating or adapting protected text, images, recordings or code requires the rights holder\'s permission, except where the law permits it. Attribution alone does not provide permission.</p>'
    + '<p>Facts and ideas are distinct from their protected expression.</p>'
    + `<h2>Reuse inquiries</h2><p>Contact ${contact} with the material and intended use.</p>`,
  'research-notice': '<p>Each study addresses the specific question and conditions defined in its protocol. Results are estimates with uncertainty; their scope and limitations are reported with the analysis.</p>'
    + '<h2>Scope of the evidence</h2><p>Evidence from randomized targeting does not by itself identify a mechanism or establish an effect under untested conditions.</p>'
    + `<p>Denis Pingin is both the practitioner and investigator in the ${escapeHtml(publicStudyIdentity.name)} study.</p>`
    + '<p>Methods, recordings and code support independent inspection and computational reproduction. Their availability does not imply independent validation or peer review.</p>'
    + '<p>Read each study\'s protocol, methods and result qualifications to understand its question, analysis and limitations.</p>'
    + `<h2>Report an error</h2><p>Send corrections to ${contact} with the relevant study, recording or result link.</p>`,
};

function resultAvailability(publication, unavailable) {
  if (unavailable) return 'Result availability could not be loaded.';
  if (!publication) return publicStudyContent.empty;
  const count = publication.inventory?.length;
  return (publication.accumulated?.reportSha256 ? 'Accumulated results are available.' : 'No accumulated result is included in this result version.')
    + (count ? ` ${count} recording${count === 1 ? '' : 's'} in this result version.` : '');
}

export function renderLabPage({page, publication = null, publicationId = publication?.publicationId, publicationUnavailable = false}) {
  const title = labPageTitles[page];
  if (!title) throw new Error('This shared Lab page is unavailable.');
  const index = page === 'index';
  const introduction = index ? '<p class="site-leading-paragraph">Lovefield Lab investigates observations arising from Lovefield practice through defined experimental procedures, documented measurements, and reproducible analysis.</p>'
    + '<p>The Lab is the research area of the <a href="https://sourceof.love/en">Lovefield Project</a>. Each study presents its question and methods, reports results as recordings are added, and provides the materials needed to examine and reproduce the analysis.</p>' : '';
  const body = index ? availableStudies.map(study => `<h2>${escapeHtml(study.name)}</h2><p>${escapeHtml(study.subtitle)}</p>`
    + `<p class="site-supporting-copy">${escapeHtml(resultAvailability(publication, publicationUnavailable))}</p><div class="site-link-group"><a href="${escapeHtml(study.url('about', publicationId))}">Overview</a></div>`).join('')
    : typeof articles[page] === 'function' ? articles[page](publicationId) : articles[page];
  return `<main id="main" class="site-surface site-page__surface public-article" tabindex="-1"><div class="page-heading"><h1>${title}</h1>${introduction}</div><section class="panel public-prose">${body}</section></main>`;
}

export function renderLabFooter({publicationId} = {}) {
  return '<nav class="site-link-group" aria-label="Lab information">'
    + informationPages.map(([page, title]) => `<a href="${escapeHtml(labPageUrl(page, publicationId))}">${title}</a>`).join('') + '</nav>';
}
