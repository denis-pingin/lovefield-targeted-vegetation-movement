import {Marked, Parser, Renderer, TextRenderer} from './vendor/marked.mjs';
import {publicStudyUrl, publicFileUrl, currentStudyFileUrl} from './study-paths.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const headingText = tokens => Parser.parseInline(tokens, {renderer: new TextRenderer()});

export function renderScientificDocument(markdown, {publication, study, kind}) {
  const contents = [], headingIds = new Set();
  function destination(href) {
    if (/^https?:\/\//i.test(href) && URL.canParse(href)) return {url: new URL(href).href};
    if (/^#[^\s]*$/.test(href)) return {url: href};
    if (!/^(?:\.\/)?[A-Za-z0-9_-][A-Za-z0-9_./-]*(?:#[^\s]*)?$/.test(href)) return {};
    const [filename, fragment] = href.replace(/^\.\//, '').split('#');
    if (filename.split('/').includes('..')) return {};
    const targetKind = filename === 'protocol.md' ? 'protocol' : filename === 'analysis-methods.md' ? 'analysis' : null;
    if (!publication && targetKind && currentStudyFileUrl(study, targetKind === 'analysis' ? 'methods' : 'protocol')) {
      return {url: publicStudyUrl(targetKind) + (fragment ? `#${fragment}` : '')};
    }
    const hash = targetKind === 'protocol' ? publication?.reportPresentation?.protocolSha256
      : targetKind === 'analysis' ? publication?.reportPresentation?.methodsSha256
        : Object.keys(publication?.files ?? {}).find(sha256 => publication.files[sha256].filename === filename);
    const file = publicFileUrl(publication, hash);
    if (file) return {url: (targetKind ? publicStudyUrl(targetKind, publication.publicationId) : file) + (fragment ? `#${fragment}` : '')};
    return {filename};
  }
  const parser = new Marked({gfm: true, tokenizer: {
    // Raw HTML must stay ordinary text, including text within script/style tags.
    html() {}, tag() {},
  }, renderer: {
    heading({tokens, depth}) {
      const title = headingText(tokens), level = Math.max(2, depth);
      const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
      let id = base, suffix = 2;
      while (headingIds.has(id)) id = `${base}-${suffix++}`;
      headingIds.add(id);
      contents.push({id, title, level});
      return `<h${level} id="${escapeHtml(id)}" tabindex="-1">${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    link({href, title, tokens}) {
      const label = this.parser.parseInline(tokens), resolved = destination(href);
      if (resolved.url) return `<a href="${escapeHtml(resolved.url)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`;
      if (!resolved.filename) return `${label} <span class="site-supporting-copy">(link unavailable)</span>`;
      if (!publication && !Object.hasOwn(study?.source?.files ?? {}, resolved.filename)) {
        return `${label} <span class="site-supporting-copy">(link unavailable: <code>${escapeHtml(resolved.filename)}</code>)</span>`;
      }
      const packagesAvailable = publication ? Object.values(publication.sourceReleases?.packages ?? {}).some(item => publicFileUrl(publication, item.sha256))
        : !!currentStudyFileUrl(study, 'source');
      return `${label} <span class="site-supporting-copy">(source-package reference: <code>${escapeHtml(resolved.filename)}</code>; unavailable as a separate retained file. `
        + (packagesAvailable ? `${publication ? 'Package contents are not listed in this publication.' : 'Package contents are listed in its source inventory.'} <a href="${escapeHtml(publicStudyUrl('reproducibility', publication?.publicationId))}#source-packages">${publication ? 'Inspect retained source packages' : 'Inspect current source package'}</a>` : 'The source package is unavailable in this publication.') + ')</span>';
    },
    image({text}) { return escapeHtml(text); },
    table(token) { return `<div class="table-scroll">${Renderer.prototype.table.call(this, token)}</div>\n`; },
  }});
  const tokens = parser.lexer(markdown);
  let title = kind === 'analysis' ? 'Analysis methods' : 'Study protocol';
  if (tokens[0]?.type === 'heading' && tokens[0].depth === 1) title = headingText(tokens.shift().tokens);
  while (tokens[0]?.type === 'space') tokens.shift();
  if (tokens[0]?.type === 'code' && /^yaml(?:\s|$)/i.test(tokens[0].lang ?? '')
    && /^authorship:\s*(?:machine|human)\s*$/m.test(tokens[0].text)
    && /^editing:\s*(?:collaborative|suggestions-only)\s*$/m.test(tokens[0].text)) tokens.shift();
  return {title, contents, html: parser.parser(tokens)};
}
