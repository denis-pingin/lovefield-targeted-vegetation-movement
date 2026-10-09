import test from 'node:test';
import assert from 'node:assert/strict';
import {publicStudyUrl} from '../../web/study-paths.mjs';

const lab = () => import('../../web/lab-public.mjs');
const publicationId = '12345678-1234-4234-8234-123456789012';

test('the Lab homepage explains its project role and lists the actual study with factual result availability', async () => {
  const {renderLabPage} = await lab(), publication = {publicationId, softwareTest: true,
    accumulated: {reportSha256: 'a'.repeat(64)}, inventory: [{runId: 'one'}, {runId: 'two'}]};
  const before = structuredClone(publication);
  const html = renderLabPage({page: 'index', publication});
  assert.match(html, /<h1>Lovefield Lab<\/h1>/);
  assert.match(html, /Lovefield Lab investigates observations arising from Lovefield practice through defined experimental procedures, documented measurements, and reproducible analysis\./);
  assert.match(html, /The Lab is the research area of the <a href="https:\/\/sourceof\.love\/en">Lovefield Project<\/a>\./);
  assert.match(html, /Each study presents its question and methods, reports results as recordings are added, and provides the materials needed to examine and reproduce the analysis\./);
  assert.equal((html.match(/<h2>Targeted Vegetation Movement<\/h2>/g) ?? []).length, 1);
  assert.match(html, /A randomized study testing whether vegetation movement changes according to the region the practitioner is instructed to influence\./);
  assert.ok(html.includes(`href="${publicStudyUrl('about', publicationId)}">Overview</a>`));
  assert.match(html, /Accumulated results are available/);
  assert.match(html, /2 recordings in this result version/);
  assert.doesNotMatch(html, /Wind pre-study|Coming soon|\/app\/|preparation|study-context/i);
  assert.doesNotMatch(html, /collecting|study complete|All studies|Evidence E/i);
  assert.deepEqual(publication, before);
});

test('a Lab homepage without a publication retains the actual study and clearly states missing results', async () => {
  const {renderLabPage} = await lab();
  const html = renderLabPage({page: 'index'});
  assert.match(html, /<h1>Lovefield Lab<\/h1>/);
  assert.match(html, /<h2>Targeted Vegetation Movement<\/h2>/);
  assert.match(html, /No scored results have been published yet\./);
  assert.ok(html.includes(`href="${publicStudyUrl('about')}">Overview</a>`));
  assert.doesNotMatch(html, /Coming soon|publication=|Evidence E|0 recordings/);
});

test('homepage availability distinguishes a result version without an accumulated result and a failed availability request', async () => {
  const {renderLabPage} = await lab();
  const individual = renderLabPage({page: 'index', publication: {publicationId, inventory: [{runId: 'one'}]}});
  assert.match(individual, /1 recording in this result version/);
  assert.match(individual, /No accumulated result is included/);
  assert.doesNotMatch(individual, /Accumulated results are available|collecting|study complete|1 recordings/);
  const failed = renderLabPage({page: 'index', publicationId, publicationUnavailable: true});
  assert.match(failed, /Result availability could not be loaded/);
  assert.ok(failed.includes(publicStudyUrl('about', publicationId)));
  assert.doesNotMatch(failed, /No scored results have been published|Evidence E|0 recordings/);
});

test('the shared articles use the public composition, distinct headings and actionable correction contact', async () => {
  const {renderLabPage} = await lab();
  for (const [page, title] of [['legal', 'Legal and contact'], ['privacy', 'Privacy'],
    ['reuse', 'Copyright and reuse'], ['research-notice', 'Research notice']]) {
    const html = renderLabPage({page});
    assert.match(html, /<main[^>]+class="site-surface site-page__surface public-article"/);
    assert.ok(html.includes(`<h1>${title}</h1>`));
    assert.match(html, /href="mailto:message@sourceof\.love"/);
    assert.doesNotMatch(html, /study-context|publication=|No scored results|preview|coming soon/i);
  }
});

test('Legal and contact identifies the established proprietor and contact details', async () => {
  const {renderLabPage} = await lab(), html = renderLabPage({page: 'legal'});
  for (const text of ['Pingin Reality', 'sole proprietorship', 'Denis Pingin', 'Bächlerstrasse 40',
    '8046 Zürich', 'Switzerland', 'CHE-142.040.833', 'CH-020.1.090.918-4']) assert.ok(html.includes(text), text);
  assert.match(html, /href="tel:\+41449741876"/);
  assert.match(html, /relevant study, recording or result/);
});

test('Privacy describes actual Lab delivery, access and contact handling without unrelated features or invented retention', async () => {
  const {renderLabPage} = await lab(), html = renderLabPage({page: 'privacy'});
  for (const text of ['Cloudflare', 'IP address', 'request', 'Google', 'cookies', 'image and voice',
    'outside Switzerland', 'access', 'correction', 'deletion']) assert.ok(html.includes(text), text);
  assert.match(html, /href="\/studies\/legal\/"/);
  assert.match(html, /href="https:\/\/www\.cloudflare\.com\/privacypolicy\/"/);
  assert.match(html, /href="https:\/\/policies\.google\.com\/privacy"/);
  assert.match(html, /no advertising trackers or analytics/);
  assert.doesNotMatch(html, /Stripe|Payrexx|newsletter|30 days|90 days|hosted only in Switzerland/i);
});

test('reuse information explains the study licenses and preserves permission rules for other material', async () => {
  const {renderLabPage} = await lab(), html = renderLabPage({page: 'reuse'});
  for (const text of ['share links', 'stated license', 'third-party notices', 'Attribution alone',
    'permission', 'Facts and ideas', 'intended use']) assert.ok(html.includes(text), text);
  assert.match(html, /<h2>Targeted Vegetation Movement<\/h2>/);
  for (const text of ['PolyForm Noncommercial 1.0.0', 'Creative Commons Attribution-NonCommercial 4.0 International',
    'software', 'documents', 'recordings', 'images', 'reports', 'credit Denis Pingin', 'identify changes',
    'their own licenses', 'Other Lab material']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('href="https://polyformproject.org/licenses/noncommercial/1.0.0"'));
  assert.ok(html.includes('href="https://creativecommons.org/licenses/by-nc/4.0/"'));
  assert.doesNotMatch(html, /All recordings are freely/);
});

test('the research notice keeps study scope, uncertainty and independent validation distinct', async () => {
  const {renderLabPage} = await lab(), html = renderLabPage({page: 'research-notice'});
  for (const text of ['specific question and conditions', 'estimates with uncertainty', 'mechanism',
    'Denis Pingin', 'practitioner and investigator', 'independent validation or peer review',
    'protocol', 'qualifications']) assert.ok(html.includes(text), text);
  assert.match(html, /Targeted Vegetation Movement/);
});

test('the footer exposes four ordinary shared information links without publication queries', async () => {
  const {renderLabFooter} = await lab(), html = renderLabFooter();
  for (const [slug, title] of [['legal', 'Legal and contact'], ['privacy', 'Privacy'],
    ['reuse', 'Copyright and reuse'], ['research-notice', 'Research notice']]) {
    assert.ok(html.includes(`href="/studies/${slug}/">${title}</a>`));
  }
  assert.match(html, /class="site-link-group"/);
  assert.equal((html.match(/<a /g) ?? []).length, 4);
  assert.doesNotMatch(html, /publication=|Original recordings and saved results/);
});

test('shared footer and article links preserve a selected publication through Lab round trips', async () => {
  const {renderLabFooter, renderLabPage} = await lab();
  const html = renderLabFooter({publicationId});
  for (const slug of ['legal', 'privacy', 'reuse', 'research-notice']) {
    assert.ok(html.includes(`href="/studies/${slug}/?publication=${publicationId}"`));
  }
  const privacy = renderLabPage({page: 'privacy', publicationId});
  assert.ok(privacy.includes(`href="/studies/legal/?publication=${publicationId}"`));
  assert.doesNotMatch(privacy, /study-context/);
});
