import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {renderPublicStudy, mountPublicStudy} from '../../web/public-study.mjs';
import {PUBLIC_BASE, PUBLIC_API_BASE, publicStudyUrl} from '../../web/study-paths.mjs';

const publicationId = '12345678-1234-4234-8234-123456789012';
const previousPublicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const digest = character => character.repeat(64);
function fixture() {
  const hashes = {report: digest('a'), video: digest('b'), viewing: digest('c'), setup: digest('d'),
    bundle: digest('e'), profile: digest('f'), protocol: digest('1'), methods: digest('2'), source: digest('3')};
  const files = Object.fromEntries(Object.entries(hashes).map(([key, sha256]) => [sha256, {sha256,
    filename: key === 'protocol' ? 'protocol.md' : key === 'methods' ? 'analysis-methods.md' : `${key}.${['video', 'viewing'].includes(key) ? 'mp4' : key === 'setup' ? 'png' : key === 'source' ? 'zip' : 'json'}`,
    role: key === 'video' ? 'camera-original' : key === 'setup' ? 'setup-image' : key, size: 1234}]));
  const analysis = {runId: 'run-one', analysisId: 'selected-analysis', reportSha256: hashes.report,
    runBundleSha256: hashes.bundle, profileSha256: hashes.profile, inputSha256s: [hashes.video, hashes.setup],
    videos: [{originalSha256: hashes.video, viewingSha256: hashes.viewing}], qualificationReasons: ['saved qualification reason'], missingReasons: []};
  const publication = {publicationId, createdAtMs: 1728000000000, softwareTest: false, previousPublicationId,
    correctionReason: 'Corrected saved camera alignment', seriesBundle: {label: 'Scored series', status: 'collecting', codeCheckpoint: 'frozen-checkpoint'},
    inventory: [{runId: 'run-one', tag: 'First tree', analysisState: 'completed', contributes: true, analysis},
      {runId: 'pending-run', tag: 'Second tree', analysisState: 'pending', contributes: false, analysisReason: 'Original video is unavailable.'},
      {runId: 'failed-run', analysisState: 'failed', contributes: false, analysisReason: 'Saved analysis failed.'}],
    accumulated: {reportSha256: hashes.report}, files,
    reportPresentation: {protocolSha256: hashes.protocol, methodsSha256: hashes.methods},
    sourceReleases: {collection: ['frozen-checkpoint'], analyses: {'selected-analysis': {codeSha256: digest('4')}},
      packages: {release: {sha256: hashes.source, origin: {kind: 'git-checkpoint', checkpoint: 'frozen-checkpoint'}}}}};
  const report = {title: 'Accumulating Tree result', status: 'Scored result', caveat: '',
    narrative: ['Saved scientific explanation.'], counts: {runs: 1, targets: 2, missingBins: 1},
    full: {estimate: null}, charts: [{kind: 'effect', title: 'Targeting effect', xLabel: 'Seconds', yLabel: 'Effect', xDomain: [0, 1], markers: [],
      series: [{key: 'A', values: [{x: 0, y: null}]}]}],
    tables: {history: [{runId: 'run-one', runCount: 1, individual: {tag: 'First tree', full: {estimate: null}}, full: {estimate: null}}]}};
  const runBundle = {state: {setupSnapshot: {imageSha256: hashes.setup, imageSize: {width: 180, height: 120},
    regions: {A: [[1, 2], [20, 2], [20, 30]], B: [[40, 2], [60, 2], [60, 30]], background: [[90, 2], [100, 2], [100, 30]]}}}};
  return {publication, report, runBundle, hashes};
}

test('About retains its scientific copy and classification without article-level study navigation', () => {
  const {publication} = fixture();
  publication.softwareTest = true;
  const before = structuredClone(publication);
  const html = renderPublicStudy({page: 'about', publication});
  assert.doesNotMatch(html, /aria-label="Study pages"|aria-current="page"/);
  assert.match(html, /<h1>Overview<\/h1>/);
  assert.match(html, /A randomized study testing whether vegetation movement changes according to the region the practitioner is instructed to influence\./);
  assert.match(html, /single-practitioner study/);
  assert.doesNotMatch(html, /Software test data|not observations from the research study/);
  assert.doesNotMatch(html, /Saved series state|Publication time unavailable|Publication identity/);
  assert.match(html, new RegExp(`publication=${publicationId}`));
  assert.doesNotMatch(html, /Reproduce the results/);
  assert.equal(publication.softwareTest, true);
  assert.deepEqual(publication, before);
});

test('every study section identifies Targeted Vegetation Movement above its matching menu heading', () => {
  const {publication, report} = fixture();
  const about = renderPublicStudy({page: 'about', publication});
  assert.match(about, /<p class="site-supporting-copy study-context">Targeted Vegetation Movement<\/p><h1>Overview<\/h1>/);
  for (const [page, title] of [['about', 'Overview'], ['methods', 'Methods'], ['results', 'Results'],
    ['recordings', 'Study data'], ['reproducibility', 'Reproducibility']]) {
    const html = renderPublicStudy({page, publication, report});
    assert.ok(html.includes(`<p class="site-supporting-copy study-context">Targeted Vegetation Movement</p><h1>${title}</h1>`), page);
    assert.equal((html.match(/class="site-supporting-copy study-context"/g) ?? []).length, 1);
  }
});

test('public pages share one article composition without duplicating the header menu', () => {
  const {publication, report} = fixture(), before = structuredClone(report);
  for (const page of ['about', 'results', 'recordings', 'methods', 'reproducibility']) {
    const html = renderPublicStudy({page, publication, report});
    assert.doesNotMatch(html, /aria-label="Study pages"|study-navigation|Back to Lovefield research/);
    assert.match(html, /<main[^>]+class="site-surface site-page__surface public-article"/);
    assert.match(html, /class="site-leading-paragraph"/);
  }
  assert.deepEqual(report, before);
});

test('the five sections open with their matching title and substantive introduction before content', () => {
  const {publication} = fixture();
  const titles = {about: 'Overview', results: 'Results', recordings: 'Study data', methods: 'Methods', reproducibility: 'Reproducibility'};
  const introductions = {
    about: 'A randomized study testing whether vegetation movement changes according to the region the practitioner is instructed to influence.',
    results: 'The analysis estimates whether relative movement shifts toward the randomly assigned tree region. Effect size describes the magnitude and direction of the estimated response; the confidence limits describe its uncertainty, and the evidence measure assesses its compatibility with the no-target-effect hypothesis.',
    recordings: 'Study data connects each recording to its original materials, saved settings, target assignments and individual analysis. Open a recording to inspect its measurements, figures and complete source files.',
    methods: 'The retained protocol and analysis methods define the hypothesis, randomized procedure, measurements and interpretation rules used for this study.',
    reproducibility: 'The retained settings, software versions and original inputs identify how each result was produced. These materials support independent inspection and computational reproduction.',
  };
  for (const [page, title] of Object.entries(titles)) {
    const html = renderPublicStudy({page, publication});
    const introduction = html.indexOf(introductions[page]);
    assert.ok(html.indexOf('<main') < html.indexOf(`<h1>${title}</h1>`), page);
    assert.ok(html.indexOf(`<h1>${title}</h1>`) < introduction, page);
    assert.ok(introduction < html.indexOf('<section'), page);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.doesNotMatch(html, /aria-label="Study pages"/, page);
  }
});

test('document contents preserve the scientific heading numbering without a second numbered list', () => {
  const {publication} = fixture();
  const scientificDocument = {title: 'Analysis methods', contents: [
    {id: 'input-contract', title: '1. Input contract', level: 2},
    {id: 'preserved-material', title: '2.1 Preserved material', level: 3},
  ], html: '<h2 id="input-contract">1. Input contract</h2><h3 id="preserved-material">2.1 Preserved material</h3>'};
  const html = renderPublicStudy({page: 'analysis', publication, scientificDocument});
  assert.match(html, /<nav class="document-contents"[^>]*><h2>Contents<\/h2><ul>/);
  assert.doesNotMatch(html, /<nav class="document-contents"[^>]*>[\s\S]*?<ol>/);
  assert.match(html, /data-heading-level="2"><a href="#input-contract">1\. Input contract<\/a>/);
  assert.match(html, /data-heading-level="3"><a href="#preserved-material">2\.1 Preserved material<\/a>/);
});

test('About separates the study objective, procedure, interpretation and verification without repeating a report or metadata dump', () => {
  const {publication, report} = fixture();
  const html = renderPublicStudy({page: 'about', publication, report});
  for (const heading of ['Study objective', 'The randomized procedure', 'Analysis and interpretation', 'Accumulating evidence', 'Independent verification']) {
    assert.ok(html.includes(`<h2>${heading}</h2>`));
  }
  assert.match(html, /The targeted region need not become the more mobile of the two\./i);
  assert.match(html, /View accumulating results/);
  assert.match(html, /View study data/);
  assert.match(html, /Read study methods/);
  assert.doesNotMatch(html, /Current published result|Saved scientific explanation|Saved series state|Publication time unavailable|Publication identity/);
});

const currentBase = `${PUBLIC_BASE}current-study/`;
function currentFixture() {
  const documents = new Map([['protocol.md', '# Current study protocol\n\n## Field sequence\n\nDeveloping procedure.\n\n[Analysis](analysis-methods.md#scientific-foundations)'],
    ['analysis-methods.md', '# Current analysis methods\n\n## Scientific foundations\n\nDeveloping methods.\n\n[Protocol](protocol.md#field-sequence)']]);
  const descriptor = filename => ({filename, sha256: createHash('sha256').update(documents.get(filename) ?? 'source fixture').digest('hex'),
    size: Buffer.byteLength(documents.get(filename) ?? 'source fixture')});
  const study = {schemaVersion: 1, experimentSlug: 'tree-targeting', stage: 'before-scored-collection',
    source: {contentSha256: '9'.repeat(64), origin: {kind: 'working-source', checkpoint: 'a'.repeat(40)},
      files: Object.fromEntries([...documents.keys()].map(filename => [filename, descriptor(filename).sha256]))},
    files: {protocol: descriptor('protocol.md'), methods: descriptor('analysis-methods.md'), source: descriptor('source.zip')}};
  return {study, documents};
}

test('current study opens every section with substantive material and only Results and Study data have empty states', () => {
  const {study} = currentFixture(), before = structuredClone(study);
  for (const page of ['about', 'results', 'recordings', 'methods', 'reproducibility']) {
    const html = renderPublicStudy({page, study});
    assert.doesNotMatch(html, /<table|<svg[^>]*class="tree-chart|Evidence E is 0|data-value-y="0"|Publication time unavailable|preview banner|frozen series/i);
    if (page === 'results') assert.match(html, /No scored results have been published yet/);
    else if (page === 'recordings') assert.match(html, /No scored recordings have been published yet/);
    else assert.doesNotMatch(html, /No scored results|Results will appear here/);
    if (page === 'methods') {
      assert.ok(html.includes(publicStudyUrl('protocol')));
      assert.ok(html.includes(publicStudyUrl('analysis')));
      assert.ok(html.includes(`${currentBase}protocol.md`));
      assert.match(html, /developing|development/i);
    }
    if (page === 'reproducibility') {
      assert.match(html, /Current study software/);
      assert.ok(html.includes(`${currentBase}source.zip`));
      assert.match(html, /Current study version/);
      assert.ok(html.includes(study.source.contentSha256));
      assert.doesNotMatch(html, /About this result version|reproduce-publication.py|Download publication manifest|github.com/);
    }
  }
  assert.deepEqual(study, before);
});

test('results reuse saved report values, keep pending and failed inventory, and link exact recording revision', () => {
  const {publication, report} = fixture(), original = structuredClone(report);
  const html = renderPublicStudy({page: 'results', publication, report});
  assert.match(html, /Saved scientific explanation/);
  assert.match(html, new RegExp(`recordings/run-one\\?publication=${publicationId}`));
  assert.match(html, /pending-run/);
  assert.match(html, /Original video is unavailable/);
  assert.match(html, /failed-run/);
  assert.match(html, /Saved analysis failed/);
  assert.doesNotMatch(html, /data-value-y="0"/);
  assert.deepEqual(report, original);
});

test('recording detail shows actual viewing/original files and saved setup regions alongside shared full report', () => {
  const {publication, report, runBundle, hashes} = fixture();
  const html = renderPublicStudy({page: 'recording', publication, report,
    recording: {inventory: publication.inventory[0], runBundle}});
  assert.match(html, /<h1>Recording: First tree<\/h1>/);
  assert.match(html, /This recording brings together its original materials, saved settings, target assignments and individual analysis\./);
  assert.doesNotMatch(html, /Open a recording to inspect/);
  assert.match(html, new RegExp(`<video[^>]+controls[^>]+src="${PUBLIC_API_BASE}publications/${publicationId}/files/${hashes.viewing}/viewing.mp4"`));
  assert.match(html, /converted for browser playback/);
  assert.match(html, new RegExp(`files/${hashes.video}/video.mp4`));
  assert.match(html, /Download unchanged camera original/);
  assert.match(html, new RegExp(`files/${hashes.setup}/setup.png`));
  assert.match(html, /points="1,2 20,2 20,30"/);
  assert.match(html, /points="40,2 60,2 60,30"/);
  assert.match(html, /Saved qualification reason|saved qualification reason/);
  assert.match(html, /Saved scientific explanation/);
});

test('Reproducibility provides complete source/input identities, settings and correction history without altering the publication', () => {
  const {publication, hashes} = fixture();
  const before = structuredClone(publication);
  const html = renderPublicStudy({page: 'reproducibility', publication});
  assert.match(html, /<h1>Reproducibility<\/h1>/);
  for (const name of ['protocol', 'methods', 'source']) assert.ok(html.includes(`/files/${hashes[name]}/`));
  assert.ok(html.includes(publicStudyUrl('methods', publicationId)));
  assert.match(html, /frozen-checkpoint/);
  assert.match(html, /The study record includes the collection software, motion-analysis settings and statistical analysis used for each result\./);
  assert.doesNotMatch(html, /Public source release has not started|Protected Test|credentials|the Mac/);
  assert.match(html, /reproduce-publication.py/);
  assert.match(html, new RegExp(`publications/${publicationId}/manifest`));
  assert.match(html, /Files and checksums/);
  assert.match(html, /Corrected saved camera alignment/);
  assert.match(html, new RegExp(`publication=${previousPublicationId}`));
  assert.doesNotMatch(html, /github.com/);
  assert.deepEqual(publication, before);
});

test('Methods describes two readable retained scientific documents with secondary downloads and a Reproducibility link', () => {
  const {publication, hashes} = fixture(), before = structuredClone(publication);
  const html = renderPublicStudy({page: 'methods', publication});
  assert.match(html, /<h1>Methods<\/h1>/);
  assert.ok(html.includes(`href="${publicStudyUrl('protocol', publicationId)}">Study protocol</a>`));
  assert.ok(html.includes(`href="${publicStudyUrl('analysis', publicationId)}">Analysis methods</a>`));
  assert.match(html, /hypothesis, randomized procedure and recording rules/);
  assert.match(html, /measurement, qualification, scoring and interpretation/);
  for (const name of ['protocol', 'methods']) assert.ok(html.includes(`/files/${hashes[name]}/`));
  assert.match(html, /Download study protocol|Download analysis methods/);
  assert.ok(html.includes(`href="${publicStudyUrl('reproducibility', publicationId)}">Reproducibility</a>`));
  assert.doesNotMatch(html, /reproduce-publication\.py|manifest\.json|Files and checksums|frozen-checkpoint|About this result version|Saved scientific explanation/);
  assert.deepEqual(publication, before);
});

function harness({page = 'results', publication = fixture().publication, fetchFailure = false, missing = false, pinned = true, documents = new Map(), fragment = '', pathname = null, current = currentFixture()} = {}) {
  const nodes = new Map(), requests = [], statusRequests = [], timers = [], warnings = [], fileFailures = new Set(), listeners = new Map();
  function element() {
    const node = {textContent: '', hidden: true, listeners: new Map(), focusCalls: [], scrollCalls: [], dataset: {openLabel: 'Open menu', closeLabel: 'Close menu'}, attributes: new Map(),
    addEventListener(kind, listener) { this.listeners.set(kind, listener); }, removeEventListener() {},
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
    },
    getAttribute(name) { return this.attributes.get(name) ?? null; }, removeAttribute(name) { this.attributes.delete(name); },
    matches(selector) {
      return selector.split(',').some(part => part.trim() === 'a[href]' ? this.tagName === 'a' && this.attributes.has('href')
        : part.trim() === 'button' ? this.tagName === 'button' : part.trim() === '[hidden]' ? this.hidden
          : this.attributes.has(part.trim().slice(1, -1)));
    },
    closest(selector) { return this.matches(selector) ? this : null; },
    focus(options) { document.activeElement = this; this.focusCalls.push(options); },
    scrollIntoView(options) { this.scrollCalls.push(options); },
    contains(target) { return [...nodes.entries()].some(([id, node]) => node === target && this.innerHTML.includes(`id="${id}"`)); },
    querySelectorAll(selector) { return controls.filter(control => control.matches(selector)); }};
    let markup = '', controls = [];
    Object.defineProperty(node, 'innerHTML', {
      set(value) {
        markup = value;
        controls = [...value.matchAll(/<(a|button)\b([^>]*)>/g)].map(([, tagName, attributes]) => {
          const control = element(); control.tagName = tagName; control.hidden = false;
          for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) control.setAttribute(name, value.replaceAll('&amp;', '&'));
          if (/\bdownload(?:\s|>|$)/.test(attributes)) control.setAttribute('download', '');
          return control;
        });
      },
      get() {
        let index = 0;
        return markup.replace(/<(a|button)\b[^>]*>/g, (_match, tagName) => {
          const control = controls[index++];
          return `<${tagName} ${[...control.attributes].map(([name, value]) => `${name}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join(' ')}>`;
        });
      },
    });
    return node;
  }
  const document = {title: '', body: {dataset: {}}, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    addEventListener(event, callback) {listeners.set(event, callback);}, removeEventListener(event) {listeners.delete(event);}, querySelectorAll() { return []; }, documentElement: {classList: {add() {}, remove() {}}}};
  const location = new URL(`${pathname ?? PUBLIC_BASE + page}${pinned ? `?publication=${publication.publicationId}` : ''}${fragment}`, 'https://test.lab.sourceof.love');
  let latest = publication, fail = fetchFailure, statusValue = null;
  const window = {location, console: {warn(...args) { warnings.push(args); }},
    history: {replaceState(_state, _title, url) { location.href = new URL(url, location).href; }},
    setInterval(callback) { timers.push(callback); return timers.length; }, clearInterval() {}};
  async function fetch(url) {
    if (url.endsWith('/status')) {
      statusRequests.push(url);
      if (fail) throw new TypeError('Network unavailable');
      return Response.json(statusValue ?? {registry: {state: 'unconfigured'}, synchronization: {state: 'unconfigured'}, registrations: [], latestPublicationId: missing || latest.softwareTest ? null : latest.publicationId});
    }
    requests.push(url);
    if (fail) throw new TypeError('Network unavailable');
    if (url.startsWith(currentBase)) {
      const filename = url.slice(currentBase.length);
      if (fileFailures.has(filename)) return new Response('Unavailable', {status: 404});
      if (filename === 'study.json') return Response.json(current.study);
      return new Response(current.documents.get(filename) ?? 'source fixture');
    }
    if (missing) return new Response(JSON.stringify({code: 'publication_not_found'}), {status: 404});
    if (url.endsWith('/latest')) return Response.json(latest);
    if (url.includes('/reports/')) return Response.json(fixture().report);
    if (url.includes('/files/')) {
      const hash = url.split('/files/')[1].split('/')[0];
      if (fileFailures.has(hash)) return Response.json({code: 'published_file_unavailable'}, {status: 404});
      if (documents.has(hash)) return new Response(documents.get(hash), {headers: {'Content-Type': 'text/markdown; charset=utf-8'}});
      return Response.json(fixture().runBundle);
    }
    return Response.json(publication);
  }
  return {document, window, fetch, nodes, requests, statusRequests, timers, warnings, listeners, setStatus(value) {statusValue = value;},
    setLatest(value) { latest = value; }, recover() { fail = false; }, fail() { fail = true; },
    failFile(hash) { fileFailures.add(hash); }, recoverFile(hash) { fileFailures.delete(hash); }};
}

test('shared information articles mount with usable footer and no scientific requests or publication polling', async () => {
  for (const [path, title] of [['legal', 'Legal and contact'], ['privacy', 'Privacy'],
    ['reuse', 'Copyright and reuse'], ['research-notice', 'Research notice']]) {
    for (const pinned of [false, true]) {
    const h = harness({pathname: `/studies/${path}/`, pinned, fetchFailure: true});
    const app = await mountPublicStudy(h);
    assert.deepEqual(h.requests, [], path);
    assert.deepEqual(h.timers, [], path);
    assert.match(h.nodes.get('public-study-content').innerHTML, new RegExp(`<h1>${title}</h1>`));
    assert.equal(h.document.title, `${title} · Lovefield Lab`);
    assert.equal(h.nodes.get('public-study-error').hidden, true);
    assert.ok(h.nodes.get('lab-footer').innerHTML.includes(`href="/studies/privacy/${pinned ? `?publication=${publicationId}` : ''}"`));
    assert.equal(h.window.location.search, pinned ? `?publication=${publicationId}` : '');
    assert.doesNotMatch(h.nodes.get('public-study-content').innerHTML, /study-context/);
    assert.ok(h.nodes.get('study-menu').innerHTML.includes(publicStudyUrl('reproducibility', pinned ? publicationId : null)));
    assert.equal(h.nodes.get('study-home').attributes.get('href'), `/studies/${pinned ? `?publication=${publicationId}` : ''}`);
    app.dispose();
    }
  }
});

test('the Lab index reads latest once, links the saved study, and leaves its own URL unpinned', async () => {
  const h = harness({pathname: '/studies/', pinned: false});
  const app = await mountPublicStudy(h);
  assert.deepEqual(h.requests, [`${PUBLIC_API_BASE}latest`]);
  assert.deepEqual(h.timers, []);
  assert.match(h.nodes.get('public-study-content').innerHTML, /<h1>Lovefield Lab<\/h1>/);
  assert.ok(h.nodes.get('public-study-content').innerHTML.includes(`href="${PUBLIC_BASE}?publication=${publicationId}">Overview</a>`));
  assert.equal(h.window.location.href, 'https://test.lab.sourceof.love/studies/');
  assert.equal(h.document.title, 'Lovefield Lab');
  assert.ok(h.nodes.get('lab-footer').innerHTML.includes(`?publication=${publicationId}`));
  assert.ok(h.nodes.get('study-menu').innerHTML.includes(publicStudyUrl('reproducibility', publicationId)));
  h.setLatest({...fixture().publication, publicationId: previousPublicationId});
  await app.refresh();
  assert.equal(h.requests.at(-1), `${PUBLIC_API_BASE}publications/${publicationId}`);
  app.dispose();
});

test('the Lab index distinguishes an empty publication list from failed loading and Retry repeats the same read', async () => {
  const empty = harness({pathname: '/studies', pinned: false, missing: true});
  const emptyApp = await mountPublicStudy(empty);
  assert.match(empty.nodes.get('public-study-content').innerHTML, /No scored results have been published yet/);
  assert.match(empty.nodes.get('study-menu').innerHTML, /Targeted Vegetation Movement/);
  assert.equal(empty.nodes.get('public-study-error').hidden, true);
  emptyApp.dispose();
  const failed = harness({pathname: '/studies/', pinned: false, fetchFailure: true});
  const app = await mountPublicStudy(failed);
  assert.equal(failed.nodes.get('public-study-error').hidden, false);
  assert.match(failed.nodes.get('public-study-error').innerHTML, /Retry/);
  assert.doesNotMatch(failed.nodes.get('public-study-content').innerHTML, /Loading|No scored results have been published/);
  assert.match(failed.nodes.get('public-study-content').innerHTML, /<h1>Lovefield Lab<\/h1>/);
  assert.match(failed.nodes.get('public-study-content').innerHTML, /Targeted Vegetation Movement|Result availability could not be loaded/);
  assert.equal(failed.document.activeElement, failed.nodes.get('public-study-error'));
  assert.equal(failed.warnings.length, 1);
  assert.match(failed.nodes.get('lab-footer').innerHTML, /href="\/studies\/legal\/"/);
  failed.recover();
  failed.nodes.get('public-study-error').listeners.get('click')({target: {closest: () => true}});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failed.requests, [`${PUBLIC_API_BASE}latest`, `${PUBLIC_API_BASE}latest`]);
  assert.match(failed.nodes.get('public-study-content').innerHTML, />Overview<\/a>/);
  assert.equal(failed.nodes.get('public-study-error').hidden, true);
  assert.deepEqual(failed.timers, []);
  app.dispose();
});

test('the shared footer remains mounted during loading and failed scientific requests', async () => {
  const h = harness({fetchFailure: true});
  const pending = mountPublicStudy(h);
  assert.ok(h.document.getElementById('lab-footer').innerHTML.includes(`href="/studies/research-notice/?publication=${publicationId}"`));
  const app = await pending;
  assert.match(h.nodes.get('lab-footer').innerHTML, /Copyright and reuse/);
  assert.equal(h.nodes.get('public-study-error').hidden, false);
  app.dispose();
});

test('study and document browser titles identify the Lovefield Lab without changing saved reports', async () => {
  const {publication, hashes} = fixture(), before = structuredClone(publication);
  const h = harness({publication});
  const app = await mountPublicStudy(h);
  assert.equal(h.document.title, 'Results · Targeted Vegetation Movement · Lovefield Lab');
  assert.deepEqual(publication, before);
  app.dispose();
  const documentPage = harness({publication, page: 'protocol', documents: new Map([[hashes.protocol, '# Exact study protocol\n\n## Procedure\n\nSaved procedure.']])});
  const documentApp = await mountPublicStudy(documentPage);
  assert.equal(documentPage.document.title, 'Exact study protocol · Targeted Vegetation Movement · Lovefield Lab');
  assert.deepEqual(publication, before);
  documentApp.dispose();
});

test('all five section browser titles and recording details use the public study identity', async () => {
  for (const [page, title] of [['about', 'Overview'], ['methods', 'Methods'], ['results', 'Results'],
    ['recordings', 'Study data'], ['reproducibility', 'Reproducibility'], ['recordings/run-one', 'Recording: First tree']]) {
    const h = harness({page}), app = await mountPublicStudy(h);
    assert.equal(h.document.title, `${title} · Targeted Vegetation Movement · Lovefield Lab`, page);
    assert.match(h.nodes.get('public-study-content').innerHTML, new RegExp(`<h1>${title}</h1>`), page);
    assert.equal(h.nodes.get('public-study-error').hidden, true, page);
    app.dispose();
  }
});

test('Methods reads the selected manifest only while Reproducibility reads its frozen series and profiles', async () => {
  const {publication, hashes} = fixture(), seriesHash = digest('9');
  publication.seriesBundle.sha256 = seriesHash;
  publication.files[seriesHash] = {sha256: seriesHash, filename: 'series.json', role: 'series-bundle', size: 321};
  const series = {config: {tree: {responseSeconds: 2.5, count: 7}}};
  const profile = {label: 'Exact saved profile', video: {featureDetection: {maxCorners: 1234}}};
  const documents = new Map([[seriesHash, JSON.stringify(series)], [hashes.profile, JSON.stringify(profile)]]);
  const before = structuredClone(publication);
  const methods = harness({page: 'methods', publication, documents}), methodsApp = await mountPublicStudy(methods);
  assert.deepEqual(methods.requests, [`${PUBLIC_API_BASE}publications/${publicationId}`]);
  assert.doesNotMatch(methods.nodes.get('public-study-content').innerHTML, /maxCorners|Exact saved profile|reproduce-publication\.py/);
  methodsApp.dispose();
  const reproduction = harness({page: 'reproducibility', publication, documents}), reproductionApp = await mountPublicStudy(reproduction);
  assert.deepEqual(reproduction.requests, [`${PUBLIC_API_BASE}publications/${publicationId}`,
    `${PUBLIC_API_BASE}publications/${publicationId}/files/${seriesHash}/series.json`,
    `${PUBLIC_API_BASE}publications/${publicationId}/files/${hashes.profile}/profile.json`]);
  const html = reproduction.nodes.get('public-study-content').innerHTML;
  assert.match(html, /View frozen series settings/);
  assert.match(html, /2\.5/);
  assert.match(html, /Exact saved profile/);
  assert.match(html, /1234/);
  assert.match(html, /python scripts\/reproduce-publication\.py/);
  assert.deepEqual(publication, before);
  reproductionApp.dispose();
});

test('selected results survive Lab homepage and footer round trips even when a newer publication exists', async () => {
  const original = harness(), originalApp = await mountPublicStudy(original);
  const destinations = ['/studies/', '/studies/legal/', '/studies/privacy/', '/studies/reuse/', '/studies/research-notice/'];
  for (const destination of destinations) {
    const shared = harness({pathname: `${destination}?publication=${publicationId}`, pinned: false});
    shared.setLatest({...fixture().publication, publicationId: previousPublicationId});
    const sharedApp = await mountPublicStudy(shared);
    assert.deepEqual(shared.requests, destination === '/studies/' ? [`${PUBLIC_API_BASE}publications/${publicationId}`] : [], destination);
    assert.equal(shared.window.location.searchParams.get('publication'), publicationId);
    assert.equal(shared.nodes.get('study-home').attributes.get('href'), `/studies/?publication=${publicationId}`);
    assert.ok(shared.nodes.get('lab-footer').innerHTML.includes(`href="/studies/privacy/?publication=${publicationId}"`));
    const menu = shared.nodes.get('study-menu').innerHTML;
    for (const section of ['about', 'methods', 'results', 'recordings', 'reproducibility']) assert.ok(menu.includes(publicStudyUrl(section, publicationId)), section);
    const back = harness({pathname: publicStudyUrl('about', publicationId), pinned: false});
    back.setLatest({...fixture().publication, publicationId: previousPublicationId});
    const backApp = await mountPublicStudy(back);
    assert.deepEqual(back.requests, [`${PUBLIC_API_BASE}publications/${publicationId}`]);
    assert.equal(back.window.location.searchParams.get('publication'), publicationId);
    sharedApp.dispose(); backApp.dispose();
  }
  originalApp.dispose();
});

test('a failed saved-data read keeps the resolved publication in menu and footer links for retry and navigation', async () => {
  const h = harness({pinned: false}); h.failFile(fixture().hashes.bundle);
  const app = await mountPublicStudy(h);
  assert.equal(h.nodes.get('public-study-error').hidden, false);
  assert.ok(h.nodes.get('study-menu').innerHTML.includes(publicStudyUrl('methods', publicationId)));
  assert.ok(h.nodes.get('lab-footer').innerHTML.includes(`href="/studies/privacy/?publication=${publicationId}"`));
  assert.equal(h.window.location.searchParams.get('publication'), publicationId);
  app.dispose();
});

test('protocol and analysis pages fetch only the selected publication document and keep its raw download secondary', async () => {
  const first = fixture(), second = fixture();
  second.publication.publicationId = previousPublicationId;
  second.publication.reportPresentation.protocolSha256 = digest('5');
  second.publication.files[digest('5')] = {...second.publication.files[second.hashes.protocol], sha256: digest('5')};
  for (const {publication, hashes} of [first, second]) {
    const documents = new Map([[publication.reportPresentation.protocolSha256, `# Protocol ${publication.publicationId}\n\n## Field sequence\n\nRecord both regions.`],
      [hashes.methods, '# Exact analysis methods\n\n## Scientific foundations\n\nUse the saved formula.']]);
    const before = structuredClone(publication);
    for (const [page, hash, filename, title] of [['protocol', publication.reportPresentation.protocolSha256, 'protocol.md', `Protocol ${publication.publicationId}`],
      ['methods/analysis', hashes.methods, 'analysis-methods.md', 'Exact analysis methods']]) {
      const h = harness({page, publication, documents}); await mountPublicStudy(h);
      const html = h.nodes.get('public-study-content').innerHTML;
      assert.deepEqual(h.requests, [`${PUBLIC_API_BASE}publications/${publication.publicationId}`,
        `${PUBLIC_API_BASE}publications/${publication.publicationId}/files/${hash}/${filename}`]);
      assert.match(html, new RegExp(`<h1>${title}</h1>`));
      assert.equal((html.match(/<h1>/g) ?? []).length, 1);
      assert.match(html, /aria-label="Document contents"/);
      assert.ok(html.indexOf('Document contents') < html.indexOf('<h2 id='));
      assert.match(html, new RegExp(`href="${PUBLIC_API_BASE}publications/${publication.publicationId}/files/${hash}/${filename}" download(?:="")?>Download Markdown`));
      assert.deepEqual(publication, before);
    }
  }
});

test('About and Methods link to the readable protocol and analysis document for the same version', () => {
  const {publication} = fixture();
  for (const page of ['about', 'methods']) {
    const html = renderPublicStudy({page, publication});
    assert.ok(html.includes(publicStudyUrl('protocol', publicationId)));
  }
  const methods = renderPublicStudy({page: 'methods', publication});
  assert.ok(methods.includes(`href="${publicStudyUrl('analysis', publicationId)}">Analysis methods</a>`));
});

test('missing or failed retained document shows visible Retry and never substitutes another document', async () => {
  for (const page of ['protocol', 'methods/analysis']) {
    for (const missing of ['hash', 'file']) {
      const {publication, hashes} = fixture(), hash = page === 'protocol' ? hashes.protocol : hashes.methods;
      if (missing === 'hash') delete publication.reportPresentation[page === 'protocol' ? 'protocolSha256' : 'methodsSha256'];
      else delete publication.files[hash];
      const h = harness({page, publication}); await mountPublicStudy(h);
      assert.deepEqual(h.requests, [`${PUBLIC_API_BASE}publications/${publicationId}`]);
      assert.equal(h.nodes.get('public-study-error').hidden, false);
      assert.match(h.nodes.get('public-study-error').innerHTML, /protocol|analysis methods/);
      assert.match(h.nodes.get('public-study-error').innerHTML, /Retry/);
      assert.doesNotMatch(h.nodes.get('public-study-content').innerHTML, /Study objective|Loading/);
      assert.equal(h.warnings.length, 1);
    }
    const {publication, hashes} = fixture(), hash = page === 'protocol' ? hashes.protocol : hashes.methods;
    const h = harness({page, publication, documents: new Map([[hash, '# Saved scientific document\n\n## Procedure\n\nRetained words.']])});
    h.failFile(hash); const app = await mountPublicStudy(h);
    assert.equal(h.nodes.get('public-study-error').hidden, false);
    assert.match(h.nodes.get('public-study-error').innerHTML, /Retry/);
    h.recoverFile(hash); await app.refresh();
    assert.equal(h.nodes.get('public-study-error').hidden, true);
    assert.match(h.nodes.get('public-study-content').innerHTML, /Retained words/);
    const saved = h.nodes.get('public-study-content').innerHTML;
    h.failFile(hash); await app.refresh();
    assert.equal(h.nodes.get('public-study-content').innerHTML, saved);
    assert.equal(h.nodes.get('public-study-error').hidden, false);
    assert.ok(h.requests.every(url => !url.includes('/latest') && !url.includes('/reports/')));
  }
});

test('current scientific articles load and verify the exact developing documents with working cross-links and downloads', async () => {
  for (const page of ['protocol', 'methods/analysis']) {
    const h = harness({page, missing: true, pinned: false}); await mountPublicStudy(h);
    const html = h.nodes.get('public-study-content').innerHTML;
    const filename = page === 'protocol' ? 'protocol.md' : 'analysis-methods.md';
    assert.deepEqual(h.requests, [`${PUBLIC_API_BASE}latest`, `${currentBase}study.json`, `${currentBase}${filename}`]);
    assert.match(html, /Developing procedure|Developing methods/);
    assert.match(html, /Download Markdown/);
    assert.ok(html.includes(page === 'protocol' ? `${publicStudyUrl('analysis')}#scientific-foundations` : `${publicStudyUrl('protocol')}#field-sequence`));
    assert.doesNotMatch(html, /No scored results|publication=/);
    assert.equal(h.nodes.get('public-study-error').hidden, true);
  }
});

test('an explicitly missing publication remains an error with Retry and never opens developing material', async () => {
  for (const pathname of [null, '/studies/']) {
    const h = harness({page: 'protocol', pathname, missing: true}); await mountPublicStudy(h);
    assert.deepEqual(h.requests, [`${PUBLIC_API_BASE}publications/${publicationId}`]);
    assert.equal(h.nodes.get('public-study-error').hidden, false);
    assert.match(h.nodes.get('public-study-error').innerHTML, /Retry/);
    assert.doesNotMatch(h.nodes.get('public-study-content').innerHTML, /Developing|No scored results/);
    if (!pathname) {
      assert.match(h.nodes.get('public-study-error').innerHTML, /access to this publication/);
      assert.match(h.nodes.get('public-study-content').innerHTML, /The published study could not be loaded/);
      assert.match(h.nodes.get('public-study-content').innerHTML, /Use Retry above to open this saved publication\./);
    }
    assert.equal(h.warnings[0][1].fallback, 'Retry is available; the selected publication is preserved.');
    assert.ok(h.nodes.get('study-menu').innerHTML.includes(`publication=${publicationId}`));
  }
});

test('ordinary study and Lab links ignore latest software fixtures while their explicit publication remains readable', async () => {
  const publication = {...fixture().publication, softwareTest: true}, before = structuredClone(publication);
  for (const page of ['about', 'methods', 'results', 'recordings', 'reproducibility']) {
    const h = harness({page, publication, pinned: false}), app = await mountPublicStudy(h);
    assert.equal(h.nodes.get('public-study-error').hidden, true, page);
    assert.doesNotMatch(h.window.location.href, /publication=/);
    assert.ok(h.requests.every(url => !url.includes('/reports/') && !url.includes('/files/')));
    assert.doesNotMatch(h.nodes.get('public-study-content').innerHTML, /Saved scientific explanation|run-one/);
    assert.doesNotMatch(h.nodes.get('study-menu').innerHTML, /publication=/);
    h.setLatest({...publication, publicationId: previousPublicationId}); await h.timers[0]();
    assert.equal(h.nodes.get('publication-update').hidden, true);
    app.dispose();
  }
  const lab = harness({pathname: '/studies/', publication, pinned: false}), labApp = await mountPublicStudy(lab);
  assert.match(lab.nodes.get('public-study-content').innerHTML, /No scored results/);
  assert.doesNotMatch(lab.nodes.get('public-study-content').innerHTML, /publication=|Accumulated results are available/);
  labApp.dispose();
  const selected = harness({publication}), selectedApp = await mountPublicStudy(selected);
  assert.match(selected.nodes.get('public-study-content').innerHTML, /Saved scientific explanation/);
  assert.ok(selected.requests.includes(`${PUBLIC_API_BASE}publications/${publicationId}`));
  assert.deepEqual(publication, before);
  selectedApp.dispose();
});

test('failed or mismatched current documents and unsafe descriptors show Retry without presenting substituted text', async () => {
  for (const defect of ['descriptor', 'document', 'digest', 'size']) {
    const current = currentFixture();
    if (defect === 'digest') current.documents.set('protocol.md', '# Changed after descriptor');
    if (defect === 'size') current.study.files.protocol.size++;
    const h = harness({page: 'protocol', missing: true, pinned: false, current});
    if (defect === 'descriptor') h.failFile('study.json');
    if (defect === 'document') h.failFile('protocol.md');
    const app = await mountPublicStudy(h);
    assert.equal(h.nodes.get('public-study-error').hidden, false, defect);
    assert.match(h.nodes.get('public-study-error').innerHTML, /Retry/);
    assert.match(h.nodes.get('public-study-error').innerHTML, /access to this study/);
    assert.match(h.nodes.get('public-study-content').innerHTML, /The current study materials could not be loaded/);
    assert.match(h.nodes.get('public-study-content').innerHTML, /Use Retry above to load the current study materials\./);
    assert.doesNotMatch(h.nodes.get('public-study-error').innerHTML + h.nodes.get('public-study-content').innerHTML, /this publication|published study|saved publication/);
    assert.doesNotMatch(h.nodes.get('public-study-content').innerHTML, /Developing procedure|Changed after descriptor/);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0][1].fallback, 'Retry is available to load the current study materials.');
    h.recoverFile('study.json'); h.recoverFile('protocol.md');
    current.documents.set('protocol.md', currentFixture().documents.get('protocol.md'));
    current.study.files.protocol = currentFixture().study.files.protocol;
    const retryRequests = h.requests.length;
    await app.refresh();
    assert.deepEqual(h.requests.slice(retryRequests), [`${PUBLIC_API_BASE}latest`, `${currentBase}study.json`, `${currentBase}protocol.md`]);
    assert.equal(h.nodes.get('public-study-error').hidden, true);
    assert.match(h.nodes.get('public-study-content').innerHTML, /Developing procedure/);
    assert.equal(h.window.location.search, '');
    app.dispose();
  }
  for (const corrupt of [study => {study.files.protocol.filename = '../../private.md';},
    study => {study.stage = 'scored';}, study => {study.repositoryUrl = 'javascript:alert(1)';},
    study => {delete study.source.files;}, study => {study.source.files['../private.md'] = '1'.repeat(64);},
    study => {study.source.files['protocol.md'] = '1'.repeat(64);},
    study => {study.files.source.sha256 = 'not-a-hash';}]) {
    const current = currentFixture(); corrupt(current.study);
    const h = harness({page: 'methods', missing: true, pinned: false, current}); await mountPublicStudy(h);
    assert.equal(h.nodes.get('public-study-error').hidden, false);
    assert.ok(h.requests.every(url => !url.includes('private')));
  }
});

test('a current-document fragment receives initial focus without manufacturing a publication identity', async () => {
  const h = harness({page: 'methods/analysis', missing: true, pinned: false, fragment: '#scientific-foundations'});
  const target = h.document.getElementById('scientific-foundations');
  const app = await mountPublicStudy(h);
  assert.equal(h.document.activeElement, target);
  assert.equal(h.window.location.search, '');
  assert.equal(h.window.location.hash, '#scientific-foundations');
  assert.deepEqual(target.scrollCalls, [{block: 'start'}]);
  app.dispose();
});

test('a linked scientific heading retains its fragment during publication pinning and receives initial focus and scroll', async () => {
  const {publication, hashes} = fixture();
  for (const pinned of [false, true]) {
    const h = harness({page: 'methods/analysis', publication, pinned, fragment: '#scientific-foundations',
      documents: new Map([[hashes.methods, '# Analysis\n\n## Scientific foundations\n\nPreserve the rules.']])});
    const target = h.document.getElementById('scientific-foundations');
    const app = await mountPublicStudy(h);
    assert.equal(h.window.location.hash, '#scientific-foundations');
    assert.equal(h.window.location.searchParams.get('publication'), publicationId);
    assert.equal(h.document.activeElement, target);
    assert.deepEqual(target.scrollCalls, [{block: 'start'}]);
    const readingFocus = {}; h.document.activeElement = readingFocus;
    await app.refresh();
    assert.equal(h.document.activeElement, readingFocus);
    assert.equal(target.scrollCalls.length, 1);
  }
});

test('mount requests one pinned manifest and its saved report, not latest or a calculator', async () => {
  const h = harness(); await mountPublicStudy(h);
  assert.deepEqual(h.requests, [`${PUBLIC_API_BASE}publications/${publicationId}`,
    `${PUBLIC_API_BASE}publications/${publicationId}/reports/${fixture().hashes.report}`,
    `${PUBLIC_API_BASE}publications/${publicationId}/files/${fixture().hashes.bundle}/bundle.json`]);
  assert.match(h.nodes.get('public-study-content').innerHTML, /Saved scientific explanation/);
});

test('About opens the selected publication and fixed method illustration without unused report or setup-bundle requests', async () => {
  const h = harness({page: ''}); await mountPublicStudy(h);
  assert.deepEqual(h.requests, [`${PUBLIC_API_BASE}publications/${publicationId}`]);
  assert.match(h.nodes.get('public-study-content').innerHTML, /DSC_0053/);
});

test('latest full-manifest response is pinned for subsequent navigation and a newer complete revision is offered without replacing it', async () => {
  const h = harness({pinned: false}); await mountPublicStudy(h);
  assert.match(h.window.location.href, new RegExp(`publication=${publicationId}`));
  const before = h.nodes.get('public-study-content').innerHTML;
  h.setLatest({...fixture().publication, publicationId: previousPublicationId});
  await h.timers[0]();
  assert.equal(h.nodes.get('public-study-content').innerHTML, before);
  assert.equal(h.requests.filter(url => url.includes('/reports/')).length, 1);
  assert.match(h.nodes.get('publication-update').innerHTML, /New published results are available/);
  assert.match(h.nodes.get('publication-update').innerHTML, new RegExp(`publication=${previousPublicationId}`));
});

test('public empty-study 404 has a readable empty state, while a failed fetch has warning context and a working retry', async () => {
  const empty = harness({missing: true, pinned: false}); await mountPublicStudy(empty);
  assert.match(empty.nodes.get('public-study-content').innerHTML, /No scored results/);
  assert.equal(empty.nodes.get('public-study-error').hidden, true);
  const failed = harness({fetchFailure: true}); const app = await mountPublicStudy(failed);
  assert.equal(failed.nodes.get('public-study-error').hidden, false);
  assert.match(failed.nodes.get('public-study-error').innerHTML, /Retry/);
  assert.match(failed.nodes.get('public-study-error').innerHTML, /publication/);
  assert.ok(failed.warnings.length);
  failed.recover(); await app.refresh();
  assert.equal(failed.nodes.get('public-study-error').hidden, true);
  assert.match(failed.nodes.get('public-study-content').innerHTML, /Saved scientific explanation/);
});

test('initial recording failure ends the loading view and brings its visible error and Retry into view', async () => {
  const h = harness({page: 'recordings/run-one', fetchFailure: true});
  const root = h.document.getElementById('public-study-content');
  root.innerHTML = '<main id="main"><h1>Loading the published study</h1><p>Opening the saved publication and its results.</p></main>';
  await mountPublicStudy(h);
  const error = h.nodes.get('public-study-error');
  assert.doesNotMatch(root.innerHTML, /Loading the published study|Opening the saved publication/);
  assert.match(root.innerHTML, /could not be loaded/);
  assert.equal(error.hidden, false);
  assert.match(error.innerHTML, /Retry/);
  assert.equal(h.document.activeElement, error);
  assert.equal(error.scrollCalls.length, 1);
});

test('an explicit refresh failure preserves the valid report and brings Retry into view', async () => {
  const h = harness(), app = await mountPublicStudy(h);
  const before = h.nodes.get('public-study-content').innerHTML;
  h.fail(); await app.refresh();
  const error = h.nodes.get('public-study-error');
  assert.equal(h.nodes.get('public-study-content').innerHTML, before);
  assert.match(before, /Saved scientific explanation/);
  assert.equal(error.hidden, false);
  assert.equal(h.document.activeElement, error);
  assert.equal(error.scrollCalls.length, 1);
});

test('latest-publication polling keeps the readers focus and scroll through both an update and a failed check', async () => {
  const h = harness(); await mountPublicStudy(h);
  const readingFocus = {}, before = h.nodes.get('public-study-content').innerHTML;
  h.document.activeElement = readingFocus;
  h.setLatest({...fixture().publication, publicationId: previousPublicationId});
  await h.timers[0]();
  assert.equal(h.document.activeElement, readingFocus);
  h.fail(); await h.timers[0]();
  const error = h.nodes.get('public-study-error');
  assert.equal(error.hidden, false);
  assert.equal(h.document.activeElement, readingFocus);
  assert.equal(error.focusCalls.length, 0);
  assert.equal(error.scrollCalls.length, 0);
  assert.equal(h.nodes.get('public-study-content').innerHTML, before);
});

test('Results dates use the completed receipt and contributing recordings without exposing internal series metadata', () => {
  const {publication} = fixture();
  publication.seriesBundle.status = 'frozen';
  publication.inventory[0].recordingStartedAtMs = publication.createdAtMs - 3600000;
  publication.inventory[1].recordingStartedAtMs = publication.createdAtMs + 7200000;
  const completedAtMs = publication.createdAtMs + 3600000;
  const before = structuredClone(publication);
  const html = renderPublicStudy({page: 'results', publication, publicationMetadata: {completedAtMs}});
  const format = timestamp => new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short'}).format(timestamp);
  assert.ok(html.includes(`Results updated ${format(completedAtMs)}`));
  assert.ok(html.includes(`Includes recordings through ${format(publication.inventory[0].recordingStartedAtMs)}`));
  assert.ok(!html.includes(`Results updated ${format(publication.createdAtMs)}`));
  assert.ok(!html.includes(`Includes recordings through ${format(publication.inventory[1].recordingStartedAtMs)}`));
  assert.match(html, /Correction: Corrected saved camera alignment/);
  assert.match(html, new RegExp(`results\\?publication=${previousPublicationId}`));
  assert.doesNotMatch(html, /Study settings: locked|Saved series state|Scored series|Publication identity/);
  assert.match(html, /<div class="recording-id">run-one<\/div>/);
  assert.deepEqual(publication, before);
});

test('absent or invalid Results dates are omitted and update metadata stays off other page introductions', () => {
  const {publication} = fixture();
  for (const completedAtMs of [null, undefined, NaN, Infinity, '1728000000000']) {
    const html = renderPublicStudy({page: 'results', publication, publicationMetadata: {completedAtMs}});
    assert.doesNotMatch(html, /Results updated|Includes recordings through|Publication time unavailable|Most recent included recording/);
  }
  for (const page of ['about', 'recordings', 'methods', 'recording']) {
    const html = renderPublicStudy({page, publication, publicationMetadata: {completedAtMs: publication.createdAtMs}});
    assert.doesNotMatch(html, /Results updated|Includes recordings through|Saved series state|Publication time unavailable/);
  }
});

test('Reproducibility explains the pinned result version and keeps correction history, source identity and checksums in disclosures', () => {
  const {publication, hashes} = fixture(), before = structuredClone(publication);
  const html = renderPublicStudy({page: 'reproducibility', publication});
  const version = html.match(/<details class="retained-details"><summary>About this result version<\/summary>([\s\S]*?)<\/details>/)?.[1];
  assert.ok(version);
  assert.match(version, /saved set of recordings, analyses, settings and files/);
  assert.match(version, /cite and reopen the same set after later updates/);
  assert.match(version, new RegExp(publicationId));
  assert.match(version, /Correction: Corrected saved camera alignment/);
  assert.match(version, new RegExp(`results\\?publication=${previousPublicationId}`));
  assert.match(html, /<summary>Collection software version<\/summary>[\s\S]*?frozen-checkpoint/);
  const files = html.match(/<details class="retained-details"><summary>Files and checksums<\/summary>([\s\S]*?)<\/details>/)?.[1];
  assert.ok(files);
  assert.match(files, /A checksum is a file fingerprint/);
  for (const hash of Object.values(hashes)) assert.ok(files.includes(`/files/${hash}/`));
  assert.doesNotMatch(html, /Frozen collection release|Saved series state|Publication identity|Every file in this publication/);
  assert.deepEqual(publication, before);
});

test('Reproducibility omits unavailable collection-version boilerplate and states actual source package availability without an invented link', () => {
  const {publication} = fixture();
  delete publication.seriesBundle.codeCheckpoint;
  publication.sourceReleases.packages = {};
  const html = renderPublicStudy({page: 'reproducibility', publication});
  assert.doesNotMatch(html, /Frozen collection release|Collection software version|>Download source package<|href="[^\"]*github/);
  assert.match(html, /No source package is available for this result version/);
});

test('public setup labels use displayed-size overlay text and retain exact source polygon coordinates', () => {
  const {publication, report, runBundle} = fixture();
  const html = renderPublicStudy({page: 'recording', publication, report, recording: {inventory: publication.inventory[0], runBundle}});
  for (const label of ['Region A', 'Region B', 'Reference']) assert.ok(html.includes(`>${label}</span>`));
  assert.match(html, /Enlarge image/);
  assert.match(html, /Download original setup PNG/);
  assert.match(html, /points="90,2 100,2 100,30"/);
  assert.doesNotMatch(html, /<text class="mask-label"/);
});

test('reproduction instructions accept browser-supplied original filenames', () => {
  const html = renderPublicStudy({page: 'reproducibility', publication: fixture().publication});
  assert.match(html, /Keep the downloaded filenames/);
  assert.doesNotMatch(html, /use their full SHA-256 hash as the filename/);
});

test('catalog shows retained dates, response settings, generated counts, collection status and individual report interpretation', () => {
  const {publication, report} = fixture();
  publication.inventory[0].recordingStartedAtMs = 1728000000000;
  publication.inventory[0].lifecycle = 'stopped';
  const catalog = {seriesBundle: {config: {tree: {responseSeconds: 2.5, count: 7}}}, reports: {'run-one': {...report,
    counts: {targets: 6}, narrative: ['The retained individual effect is unavailable.'], evidence: {label: '1.25'}}}};
  const html = renderPublicStudy({page: 'recordings', publication, catalog});
  const date = new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short'}).format(publication.inventory[0].recordingStartedAtMs);
  assert.ok(html.includes(date));
  assert.match(html, /2.5 seconds per target/);
  assert.match(html, /6 generated targets/);
  assert.match(html, /7 planned targets/);
  assert.match(html, /Collection: stopped/);
  assert.match(html, /The retained individual effect is unavailable/);
  assert.match(html, /Individual E: 1.25/);
  assert.match(html, /Individual result unavailable/);
  assert.doesNotMatch(html, /Most recent included recording|Results updated/);
});

test('About includes the real method illustration and links to the saved results', () => {
  const {publication, report, runBundle} = fixture();
  const html = renderPublicStudy({page: 'about', publication, report,
    recording: {inventory: publication.inventory[0], runBundle}});
  assert.match(html, /View accumulating results/);
  assert.doesNotMatch(html, /Current published result|Saved scientific explanation|2 generated targets/);
  assert.match(html, /DSC_0053/);
  assert.match(html, /Movement tracking in DSC_0053, recorded September 25, 2026\. Frame 25, one second into the recording\./);
  assert.doesNotMatch(html, /does not contribute to the scored results|preparation/i);
  assert.match(html, /10 times/);
  assert.match(html, /points="1110,17 1580,177 1749,573/);
  assert.doesNotMatch(html, /tracking-readable/);
  assert.match(html, /Download study protocol/);
  assert.doesNotMatch(html, /Reproduce the results/);
});

test('recording details explain actual profile, camera alignment and footage decisions and label downloads by their retained role', () => {
  const {publication, report, runBundle, hashes} = fixture();
  publication.files[hashes.bundle].role = 'run-bundle';
  publication.files[hashes.profile].role = 'profile';
  runBundle.config = {tree: {responseSeconds: 2.5, count: 7}};
  const recording = {inventory: publication.inventory[0], runBundle,
    profile: {profileId: 'frozen', video: {measurement: {method: 'feature-mean-v1'}, featureDetection: {maxCorners: 3000}, tracking: {windowSizePixels: [21, 21]}}},
    reproductionInputs: {recordings: {camera: {kind: 'video', recordingId: 'camera', timeMappingQualified: true,
      clockMap: {offset_seconds: 1000, rate: 1, references: [{frameIndex: 0, ptsSeconds: 0, serverDisplayedAtMs: 1728000000000}]}}}},
    footageReviews: [{decision: 'obstructed', spans: [{startFrameIndex: 10, endFrameIndex: 15}]}]};
  const html = renderPublicStudy({page: 'recording', publication, report, recording});
  assert.match(html, /Recording and analysis settings/);
  assert.match(html, /3000 maximum feature points/);
  assert.match(html, /21 × 21/);
  assert.match(html, /Camera clock alignment/);
  assert.match(html, /Clock mapping qualified/);
  assert.match(html, /Frame 0/);
  assert.match(html, /Footage review: obstructed/);
  assert.match(html, /Frames 10 through 15/);
  assert.match(html, /Recorded instructions and run records/);
  assert.match(html, /Analysis settings/);
  assert.match(html, /Collection and analysis source identity/);
});

test('area-grid settings use retained point allowances and square cell dimensions instead of the regional feature limit', () => {
  const {publication} = fixture();
  for (const [pointsPerCell, cellSizePixels] of [[32, 128], [24, 96]]) {
    const recording = {inventory: publication.inventory[0], profile: {video: {
      measurement: {method: 'area-grid-mean-v1', pointsPerCell, cellSizePixels},
      featureDetection: {maxCorners: 3000}, tracking: {windowSizePixels: [41, 41]},
    }}};
    const before = structuredClone(recording);
    const html = renderPublicStudy({page: 'recording', publication, recording});
    const summary = html.match(/<p>Measurement: [^<]*<\/p>/)?.[0];
    assert.equal(summary, `<p>Measurement: area-grid-mean-v1. ${pointsPerCell} maximum feature points per full grid cell. Grid cell size: ${cellSizePixels} × ${cellSizePixels} pixels. Tracking window: 41 × 41 pixels.</p>`);
    assert.deepEqual(recording, before);
  }
});

test('legacy feature settings describe the retained maximum points per region and tracking window', () => {
  const {publication} = fixture();
  for (const measurement of [undefined, {method: 'feature-mean-v1'}]) {
    const recording = {inventory: publication.inventory[0], profile: {video: {
      ...(measurement ? {measurement} : {}), featureDetection: {maxCorners: 1200}, tracking: {windowSizePixels: [21, 21]},
    }}};
    const before = structuredClone(recording);
    const html = renderPublicStudy({page: 'recording', publication, recording});
    assert.equal(html.match(/<p>Measurement: [^<]*<\/p>/)?.[0],
      '<p>Measurement: feature-mean-v1. 1200 maximum feature points per region. Tracking window: 21 × 21 pixels.</p>');
    assert.deepEqual(recording, before);
  }
});

test('camera references retain seconds and milliseconds in UTC while recording and update dates stay compact', () => {
  const {publication} = fixture();
  const timestamp = Date.UTC(2026, 9, 2, 15, 16, 20, 123);
  publication.inventory[0].recordingStartedAtMs = timestamp;
  const recording = {inventory: publication.inventory[0], reproductionInputs: {recordings: {camera: {
    kind: 'video', recordingId: 'camera', timeMappingQualified: true,
    clockMap: {references: [{frameIndex: 310, ptsSeconds: 12.4, serverDisplayedAtMs: timestamp, clockUncertaintyMs: 2.75}]},
  }}}};
  const before = structuredClone({publication, recording});
  const detail = renderPublicStudy({page: 'recording', publication, recording});
  assert.equal(detail.match(/<li>Frame 310[^<]*<\/li>/)?.[0],
    '<li>Frame 310 at 12.4 video seconds: 2026-10-02 15:16:20.123 UTC; clock uncertainty 2.75 milliseconds.</li>');
  const compact = new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short'}).format(timestamp);
  const recordings = renderPublicStudy({page: 'recordings', publication});
  assert.ok(recordings.includes(`Recording<br>${compact}`));
  const results = renderPublicStudy({page: 'results', publication, publicationMetadata: {completedAtMs: timestamp}});
  assert.ok(results.includes(`Results updated ${compact}.`));
  assert.ok(results.includes(`Includes recordings through ${compact}.`));
  assert.deepEqual({publication, recording}, before);
});

test('missing recording time and download hashes are described without claiming a renamed file', () => {
  const publication = fixture().publication;
  const recordings = renderPublicStudy({page: 'recordings', publication});
  assert.match(recordings, /Recording<br>Time unavailable/);
  const methods = renderPublicStudy({page: 'reproducibility', publication});
  assert.match(methods, /A checksum is a file fingerprint that verifies the exact downloaded bytes/);
  assert.doesNotMatch(methods, /identifies its filename in the reproduction input directory/);
});

test('compact result interpretations preserve saved unqualified status and caveat with singular retained counts', () => {
  const {publication, report} = fixture();
  report.status = 'Unqualified result';
  report.caveat = 'Saved timing qualification did not pass.';
  report.counts = {runs: 1, targets: 1};
  const results = renderPublicStudy({page: 'results', publication, report});
  assert.match(results, /Unqualified result/);
  assert.match(results, /Saved timing qualification did not pass/);
  assert.match(results, /1 recording · 1 generated target/);
  assert.doesNotMatch(results, /1 recordings|1 generated targets/);
  const catalog = renderPublicStudy({page: 'recordings', publication, catalog: {reports: {'run-one': report}}});
  assert.match(catalog, /Unqualified result/);
  assert.match(catalog, /Saved timing qualification did not pass/);
  assert.match(catalog, /1 generated target</);
});

test('public full reports and compact recording narratives omit only development context and preserve saved scientific warnings', () => {
  const {publication, report, runBundle} = fixture();
  report.status = 'Preparation result';
  report.caveat = 'Preparation results are exploratory. Settings and retrospective region choices can affect the result.';
  report.narrative = ['The estimated full-response effect size is 2.73 relative-share percentage points.',
    '1 missing elapsed bin remains bounded unknown.',
    'The saved randomization is unverified; this output cannot establish a qualified scored conclusion.'];
  const before = structuredClone({publication, report, runBundle});
  for (const page of ['results', 'recordings', 'recording']) {
    const html = renderPublicStudy({page, publication, report,
      catalog: {reports: {'run-one': report}}, recording: {inventory: publication.inventory[0], runBundle}});
    assert.doesNotMatch(html, /Preparation result|Preparation results|Preparation remains|Software test data|Scored Tree recording/);
    assert.match(html, /effect size is 2\.73 relative-share percentage points/);
    assert.match(html, /1 missing elapsed bin remains bounded unknown/);
    assert.doesNotMatch(html, /Settings and retrospective region choices can affect the result/);
    assert.match(html, /saved qualification reason/);
    if (page !== 'recordings') assert.match(html, /saved randomization is unverified/);
  }
  assert.deepEqual({publication, report, runBundle}, before);
});

test('live inventory refreshes independently while the older selected publication and report files stay pinned', async () => {
  const h = harness({page: 'recordings'});
  const value = {registry: {state: 'configured'}, synchronization: {state: 'current', caughtUp: true}, latestPublicationId: previousPublicationId,
    registrations: [{runId: 'new-live-run', confirmation: 'sealed', execution: {state: 'registered'}, data: {state: 'awaiting_publication', publications: []}}]};
  h.setStatus(value); const app = await mountPublicStudy(h);
  assert.equal(h.statusRequests.length, 1); assert.match(h.nodes.get('registered-runs').innerHTML, /new-live-run/);
  assert.match(h.nodes.get('public-study-content').innerHTML, /id="registered-runs"/);
  assert.match(h.nodes.get('registered-runs').innerHTML, /Registered runs/);
  assert.match(h.nodes.get('public-study-content').innerHTML, new RegExp(publicationId));
  const reads = [...h.requests]; const html = h.nodes.get('public-study-content').innerHTML;
  h.setStatus({...value, registrations: [...value.registrations, {...value.registrations[0], runId: 'another-start'}]}); await h.timers[0]();
  assert.deepEqual(h.requests, reads); assert.equal(h.nodes.get('public-study-content').innerHTML, html);
  assert.match(h.nodes.get('registered-runs').innerHTML, /another-start/); assert.equal(h.nodes.get('publication-update').hidden, false);
  h.document.hidden = true; await h.timers[0](); assert.equal(h.statusRequests.length, 2);
  h.document.hidden = false; await h.listeners.get('visibilitychange')(); assert.equal(h.statusRequests.length, 3);
  app.dispose(); assert.equal(h.listeners.has('visibilitychange'), false);
});

test('registered runs remain visible on the complete pre-publication Study data page', async () => {
  const h = harness({page: 'recordings', pinned: false, missing: true});
  h.setStatus({registry: {state: 'configured'}, synchronization: {state: 'catching_up'}, latestPublicationId: null,
    registrations: [{runId: 'orphan-start', execution: {state: 'completion_not_reported'}, data: {state: 'awaiting_publication'}}]});
  await mountPublicStudy(h);
  assert.match(h.nodes.get('public-study-content').innerHTML, /Study data/);
  assert.match(h.nodes.get('registered-runs').innerHTML, /orphan-start/); assert.match(h.nodes.get('registered-runs').innerHTML, /Completion not reported/);
});
