import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {PUBLIC_BASE, PUBLIC_API_BASE} from '../../web/study-paths.mjs';

const publicationId = '12345678-1234-4234-8234-123456789012';
const protocolHash = '1'.repeat(64), methodsHash = '2'.repeat(64), referenceHash = '3'.repeat(64), sourceHash = '4'.repeat(64);
const publication = {publicationId, reportPresentation: {protocolSha256: protocolHash, methodsSha256: methodsHash},
  files: {[protocolHash]: {filename: 'protocol.md'}, [methodsHash]: {filename: 'analysis-methods.md'},
    [referenceHash]: {filename: 'validation.json'}, [sourceHash]: {filename: 'source.zip'}},
  sourceReleases: {packages: {collection: {sha256: sourceHash}}}};
const documentRenderer = () => import('../../web/public-study-document.mjs');

test('developing documents resolve only their current articles, fragments, and source package', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const study = {source: {files: {'src/tree_report.py': '1'.repeat(64)}}, files: {protocol: {filename: 'protocol.md'}, methods: {filename: 'analysis-methods.md'}, source: {filename: 'source.zip'}}};
  const before = structuredClone(study);
  const result = renderScientificDocument('# Current methods\n\n[Protocol](protocol.md#field-sequence)\n\n[Software](src/tree_report.py)\n\n[Unsafe](javascript:alert(1))\n\n[Private](../private.md)', {study, kind: 'analysis'});
  assert.ok(result.html.includes(`href="${PUBLIC_BASE}protocol#field-sequence"`));
  assert.ok(result.html.includes(`href="${PUBLIC_BASE}reproducibility#source-packages"`));
  assert.match(result.html, /src\/tree_report.py/);
  assert.doesNotMatch(result.html, /publication=|href="[^\"]*private|href="javascript:/);
  assert.deepEqual(study, before);
});

test('current document references only suggest source files actually retained in its inventory', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const study = {source: {files: {'validation.md': '1'.repeat(64), 'validation/reference.py': '2'.repeat(64)}},
    files: {source: {filename: 'source.zip'}}};
  for (const filename of ['validation.md', 'validation/reference.py']) {
    const result = renderScientificDocument(`# Analysis\n\n[Validation](${filename})`, {study, kind: 'analysis'});
    assert.match(result.html, /source-package reference/);
    assert.ok(result.html.includes(`href="${PUBLIC_BASE}reproducibility#source-packages"`));
    assert.match(result.html, /Package contents are listed in its source inventory/);
  }
  const missing = renderScientificDocument('# Analysis\n\n[Internal verification](implementation-verification.md)', {study, kind: 'analysis'});
  assert.match(missing.html, /link unavailable/);
  assert.match(missing.html, /implementation-verification.md/);
  assert.doesNotMatch(missing.html, /source-package reference|Inspect current source package|<a\b/);
});

test('scientific Markdown formats its title, lists, table, code, emphasis and linked contents', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const markdown = '# Protocol\n\n## Field sequence\n\nMeasure **both regions**, preserve *uncertainty*, and use `E=1`.\n\n1. Record both regions.\n2. Follow the cue.\n\n- Preserve the original.\n  - Keep the profile.\n\n| Rule | Value |\n| --- | --- |\n| Initial E | 1 |\n\n```text\nE < 20\n```\n\n[Analysis](analysis-methods.md#scientific-foundations)';
  const before = structuredClone(publication), result = renderScientificDocument(markdown, {publication, kind: 'protocol'});
  assert.equal(result.title, 'Protocol');
  for (const output of ['<ol>', '<ul>', '<table>', '<strong>both regions</strong>', '<em>uncertainty</em>', '<code>E=1</code>', 'E &lt; 20']) assert.ok(result.html.includes(output), output);
  assert.match(result.html, /id="field-sequence"/);
  assert.doesNotMatch(result.html, /<h1/);
  assert.deepEqual(result.contents, [{id: 'field-sequence', title: 'Field sequence', level: 2}]);
  assert.match(result.html, new RegExp(`href="${PUBLIC_BASE}methods/analysis\\?publication=${publicationId}#scientific-foundations"`));
  assert.deepEqual(publication, before);
});

test('heading fragments are stable and collision-safe across repeated and similarly named headings', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const markdown = '# Protocol\n\n## Field sequence\n\nOne.\n\n## Field sequence\n\nTwo.\n\n### Field sequence-2\n\nThree.';
  const first = renderScientificDocument(markdown, {publication, kind: 'protocol'});
  assert.deepEqual(renderScientificDocument(markdown, {publication, kind: 'protocol'}), first);
  assert.deepEqual(first.contents.map(item => item.id), ['field-sequence', 'field-sequence-2', 'field-sequence-2-2']);
  for (const {id} of first.contents) assert.ok(first.html.includes(`id="${id}"`));
});

test('scientific tables retain their headings and values inside a separate scroll container', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const result = renderScientificDocument('# Protocol\n\n| Setting | Definition |\n| --- | --- |\n| Response interval | The saved interval after each cue. |', {publication, kind: 'protocol'});
  assert.match(result.html, /<div class="table-scroll">\s*<table>/);
  assert.match(result.html, /<thead>[\s\S]*<th>Setting<\/th>[\s\S]*<th>Definition<\/th>[\s\S]*<\/thead>/);
  assert.match(result.html, /<tbody>[\s\S]*Response interval[\s\S]*The saved interval after each cue\.[\s\S]*<\/tbody>/);
  assert.match(result.html, /<\/table>\s*<\/div>/);
});

test('only the leading ownership YAML is omitted while scientific YAML and formula text remain', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const markdown = '# Analysis\n\n```yaml\nauthorship: machine\nediting: collaborative\nversion: retained\n```\n\n## Rules\n\n```yaml\nresponseSeconds: 2.5\n```\n\nE_t = product(1 + lambda * contrast_t).';
  const result = renderScientificDocument(markdown, {publication, kind: 'analysis'});
  assert.doesNotMatch(result.html, /authorship:|editing:|version: retained/);
  assert.match(result.html, /responseSeconds: 2.5/);
  assert.match(result.html, /E_t = product\(1 \+ lambda \* contrast_t\)/);
  assert.ok(markdown.includes('authorship: machine'));
});

test('raw executable markup is visible text and Markdown never embeds remote images', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const result = renderScientificDocument('# Protocol\n\n<script>alert(1)</script><img src=x onerror=alert(2)>\n\n<style>body{display:none}</style>\n\n![Remote setup](https://example.invalid/image.png)\n\nInline <svg onload=alert(3)>.</svg>', {publication, kind: 'protocol'});
  assert.doesNotMatch(result.html, /<(?:script|img|style|svg|iframe|object)[\s>]/i);
  assert.match(result.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(result.html, /onerror=alert\(2\)/);
  assert.match(result.html, /Remote setup/);
  assert.doesNotMatch(result.html, /<[^>]+\bsrc=/);
});

test('unsafe schemes and equivalent obfuscated links never become active links', async () => {
  const {renderScientificDocument} = await documentRenderer();
  for (const destination of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java&#x73;cript&#58;alert(1)',
    'javascript&#58;alert(1)', 'data:text/html,unsafe', 'vbscript:msgbox(1)', 'file:///private/local', '//example.invalid/unpinned']) {
    const result = renderScientificDocument(`# Protocol\n\n[Unsafe](${destination})`, {publication, kind: 'protocol'});
    assert.doesNotMatch(result.html, /<a\b/, destination);
    assert.match(result.html, /Unsafe/);
  }
  const safe = renderScientificDocument('# Protocol\n\n[Source](https://example.org/paper?one=1&two=2 "Source title")\n\n[Local](#field-sequence)', {publication, kind: 'protocol'});
  assert.match(safe.html, /href="https:\/\/example.org\/paper\?one=1&amp;two=2"/);
  assert.match(safe.html, /title="Source title"/);
  assert.match(safe.html, /href="#field-sequence"/);
});

test('relative scientific documents and retained files resolve within the same selected publication', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const result = renderScientificDocument('# Analysis\n\n[Protocol](protocol.md#field-sequence)\n\n[Input](validation.json)', {publication, kind: 'analysis'});
  assert.match(result.html, new RegExp(`href="${PUBLIC_BASE}protocol\\?publication=${publicationId}#field-sequence"`));
  assert.match(result.html, new RegExp(`href="${PUBLIC_API_BASE}publications/${publicationId}/files/${referenceHash}/validation.json"`));
});

test('source references identify retained package material and explicitly unavailable packages without guessed URLs', async () => {
  const {renderScientificDocument} = await documentRenderer();
  const markdown = '# Analysis\n\n[Reference calculator](validation/reference.py)';
  const available = renderScientificDocument(markdown, {publication, kind: 'analysis'});
  assert.match(available.html, /source-package reference/i);
  assert.match(available.html, /unavailable as a separate retained file/i);
  assert.match(available.html, /validation\/reference.py/);
  assert.match(available.html, new RegExp(`href="${PUBLIC_BASE}reproducibility\\?publication=${publicationId}#source-packages"`));
  const missing = renderScientificDocument(markdown, {publication: {...publication, sourceReleases: {packages: {}}}, kind: 'analysis'});
  assert.match(missing.html, /source package is unavailable/i);
  assert.doesNotMatch(missing.html, /<a\b/);
  for (const result of [available, missing]) assert.doesNotMatch(result.html, /href="(?:file:|[^\"]*github|[^\"]*validation\/reference.py)/);
});

test('available source packages do not imply that an unlisted document is contained in them', async () => {
  const {renderScientificDocument} = await documentRenderer();
  for (const filename of ['validation.md', 'implementation-verification.md']) {
    const result = renderScientificDocument(`# Analysis\n\n[Reference](${filename})`, {publication, kind: 'analysis'});
    assert.match(result.html, /unavailable as a separate retained file/i);
    assert.match(result.html, /Package contents are not listed in this publication/);
    assert.doesNotMatch(result.html, new RegExp(`href="[^\"]*${filename.replaceAll('.', '\\.')}"`));
  }
});

test('the extracted standalone source renders the same document without parent modules or package installation', async context => {
  const {renderScientificDocument} = await documentRenderer();
  const directory = await mkdtemp(join(tmpdir(), 'tree-document-source-'));
  context.after(() => rm(directory, {recursive: true, force: true}));
  const packageDirectory = fileURLToPath(new URL('../../', import.meta.url)), extracted = join(directory, 'source');
  const script = 'import sys, zipfile\nfrom pathlib import Path\nsys.path.insert(0, str(Path(sys.argv[1]) / "src"))\nfrom tree_source_release import archive_source_release\narchive = Path(sys.argv[2]) / "source.zip"\narchive_source_release(archive, package=Path(sys.argv[1]))\nwith zipfile.ZipFile(archive) as source: source.extractall(Path(sys.argv[2]) / "source")\n';
  execFileSync(process.env.PYTHON ?? 'python3', ['-c', script, packageDirectory, directory]);
  const isolated = await import(pathToFileURL(join(extracted, 'web/public-study-document.mjs')));
  const markdown = '# Standalone protocol\n\n## Sequence\n\nKeep **all** observations.\n\n[Analysis](analysis-methods.md)';
  assert.deepEqual(isolated.renderScientificDocument(markdown, {publication, kind: 'protocol'}), renderScientificDocument(markdown, {publication, kind: 'protocol'}));
});
