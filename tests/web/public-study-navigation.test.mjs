import test from 'node:test';
import assert from 'node:assert/strict';
import {LAB_BASE, PUBLIC_BASE, publicStudyUrl} from '../../web/study-paths.mjs';

const publicationId = '12345678-1234-4234-8234-123456789012';
const previousPublicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const navigation = () => import('../../web/public-study-navigation.mjs');

function fixture() {
  const document = new EventTarget();
  class Element extends EventTarget {
    attributes = new Map();
    dataset = {};
    hidden = false;
    inert = false;
    children = [];
    parentElement = null;
    tagName = '';
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    get href() { return this.getAttribute('href'); }
    focus() { document.activeElement = this; }
    matches(selector) {
      return selector.split(',').some(part => part.trim() === 'a[href]' ? this.tagName === 'a' && this.href
        : part.trim() === 'button' ? this.tagName === 'button'
          : part.trim() === '[hidden]' ? this.hidden : this.attributes.has(part.trim().slice(1, -1)));
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
  }
  const trigger = new Element(), overlay = new Element(), home = new Element(), identityArea = new Element(), background = new Element();
  identityArea.textContent = 'Project';
  home.setAttribute('href', PUBLIC_BASE);
  home.setAttribute('aria-label', 'Lovefield Lab');
  trigger.dataset = {openLabel: 'Open menu', closeLabel: 'Close menu'};
  trigger.setAttribute('aria-expanded', 'false');
  overlay.hidden = true;
  Object.defineProperty(overlay, 'innerHTML', {set(value) {
    overlay.children = [];
    const stack = [overlay];
    for (const [, closing, tagName, attributes] of value.matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
      if (closing) { stack.pop(); continue; }
      const node = new Element();
      node.tagName = tagName;
      node.parentElement = stack.at(-1);
      node.parentElement.children.push(node);
      node.hidden = /\bhidden\b/.test(attributes);
      for (const [, name, text] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
        node.setAttribute(name, text.replaceAll('&amp;', '&'));
        if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = text;
      }
      if (!attributes.endsWith('/')) stack.push(node);
    }
  }});
  document.getElementById = id => ({'study-menu-trigger': trigger, 'study-menu': overlay, 'study-home': home, 'study-identity-label': identityArea})[id]
    ?? overlay.querySelectorAll('[id]').find(node => node.getAttribute('id') === id) ?? null;
  document.body = {dataset: {}};
  document.querySelectorAll = () => [background];
  document.documentElement = {classList: new Set()};
  document.documentElement.classList.remove = name => document.documentElement.classList.delete(name);
  const scrollCalls = [], history = [];
  const window = Object.assign(new EventTarget(), {scrollX: 10, scrollY: 150,
    scrollTo(options) { scrollCalls.push(options); this.scrollX = options.left; this.scrollY = options.top; },
    history: {pushState(...args) { history.push(args); }},
  });
  function key(key, shiftKey = false) {
    const event = new Event('keydown', {cancelable: true});
    Object.assign(event, {key, shiftKey}); document.dispatchEvent(event); return event;
  }
  function click(target, modifiers = {}) {
    const event = new Event('click', {cancelable: true});
    Object.defineProperty(event, 'target', {value: target});
    Object.assign(event, {button: 0, ...modifiers}); overlay.dispatchEvent(event); return event;
  }
  return {document, window, trigger, overlay, home, identityArea, background, scrollCalls, history, key, click,
    links: () => overlay.querySelectorAll('a[href]'), buttons: () => overlay.querySelectorAll('button')};
}

test('every Lab menu exposes the five ordered study sections, a separate overview link and the Project exit', async () => {
  const {renderStudyNavigation} = await navigation();
  for (const [page, current] of [['about', 'about'], ['results', 'results'], ['recordings', 'recordings'],
    ['recording', 'recordings'], ['protocol', 'methods'], ['methods', 'methods'], ['analysis', 'methods'],
    ['reproducibility', 'reproducibility'], ['index', null], ['legal', null], ['privacy', null], ['reuse', null], ['research-notice', null]]) {
    const html = renderStudyNavigation({page, publicationId});
    const labels = ['Overview', 'Methods', 'Results', 'Study data', 'Reproducibility'];
    for (const destination of ['about', 'methods', 'results', 'recordings', 'reproducibility']) {
      assert.ok(html.includes(`href="${publicStudyUrl(destination, publicationId)}"`), page);
    }
    for (const label of ['Lovefield Lab', 'Targeted Vegetation Movement', ...labels, 'Lovefield Project']) assert.ok(html.includes(label), `${page}: ${label}`);
    assert.ok(html.indexOf('Lovefield Lab') < html.indexOf('Targeted Vegetation Movement'));
    for (let index = 1; index < labels.length; index++) assert.ok(html.indexOf(`<strong>${labels[index - 1]}</strong>`) < html.indexOf(`<strong>${labels[index]}</strong>`), page);
    assert.ok(html.indexOf('<strong>Reproducibility</strong>') < html.indexOf('Lovefield Project'));
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, current || page === 'index' ? 1 : 0);
    if (current) assert.match(html, new RegExp(`data-study-page="${current}"[^>]*aria-current="page"`));
    assert.match(html, new RegExp(`href="${PUBLIC_BASE}\\?publication=${publicationId}"[^>]*><strong>Targeted Vegetation Movement</strong></a>`));
    assert.match(html, /<button[^>]+aria-controls="[^"]+"[^>]+aria-expanded="(?:true|false)"[^>]+aria-label="(?:Expand|Collapse) Targeted Vegetation Movement"/);
    assert.match(html, /href="https:\/\/sourceof\.love\/en"/);
    assert.doesNotMatch(html, /All studies|<[^>]+>STUDIES<|Back to Lovefield|Lovefield website|\/app\//);
  }
});

test('every public page uses the Lab identity as an ordinary index link', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture();
  const menu = mountStudyNavigation(f);
  for (const page of ['about', 'results', 'recordings', 'recording', 'protocol', 'methods', 'analysis',
    'index', 'legal', 'privacy', 'reuse', 'research-notice']) {
    menu.update({page, publicationId});
    assert.equal(f.identityArea.textContent, 'Lab', page);
    assert.equal(f.home.href, `${LAB_BASE}?publication=${publicationId}`, page);
    assert.equal(f.home.getAttribute('aria-label'), 'Lovefield Lab', page);
    assert.equal(f.document.body.dataset.studyPage, page);
  }
  menu.dispose();
});

test('the sole study expands initially on the homepage and study pages; footer pages have no selected study section', async () => {
  const {renderStudyNavigation} = await navigation();
  for (const page of ['index', 'about', 'results', 'legal', 'privacy', 'reuse', 'research-notice']) {
    const f = fixture(), {mountStudyNavigation} = await navigation(), menu = mountStudyNavigation(f);
    menu.update({page, publicationId});
    const button = f.buttons()[0], expanded = ['index', 'about', 'results'].includes(page);
    assert.ok(button, page);
    assert.equal(button.getAttribute('aria-expanded'), String(expanded));
    assert.equal(f.document.getElementById(button.getAttribute('aria-controls')).hidden, !expanded);
    if (!expanded) assert.ok(f.links().filter(link => link.dataset.studyPage).every(link => link.getAttribute('aria-current') === null));
    menu.dispose();
  }
  assert.doesNotMatch(renderStudyNavigation({page: 'privacy'}), /publication=/);
});

test('same-page About publication updates preserve the focused menu link and index identity', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture();
  const menu = mountStudyNavigation(f); menu.update({page: 'about', publicationId});
  f.trigger.dispatchEvent(new Event('click'));
  const focused = f.links().find(link => link.dataset.studyPage === 'recordings'); focused.focus();
  const next = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  menu.update({page: 'about', publicationId: next});
  assert.equal(f.links().find(link => link.dataset.studyPage === 'recordings'), focused);
  assert.equal(f.document.activeElement, focused);
  assert.equal(focused.href, `${PUBLIC_BASE}recordings?publication=${next}`);
  assert.equal(f.home.href, `${LAB_BASE}?publication=${next}`);
  assert.equal(f.identityArea.textContent, 'Lab');
  assert.equal(f.background.inert, true);
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.key('Escape').defaultPrevented, true);
  assert.equal(f.document.activeElement, f.trigger);
  menu.dispose();
});

test('Open, Escape and Close preserve focus and scroll using the persistent shell', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture();
  const menu = mountStudyNavigation(f); menu.update({page: 'protocol', publicationId});
  assert.equal(f.home.href, `${LAB_BASE}?publication=${publicationId}`);
  f.trigger.dispatchEvent(new Event('click'));
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(f.trigger.getAttribute('aria-label'), 'Close menu');
  assert.equal(f.document.activeElement, f.links()[0]);
  assert.equal(f.background.inert, true);
  assert.equal(f.document.documentElement.classList.has('site-menu-open'), true);
  assert.equal(f.key('Escape').defaultPrevented, true);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(f.background.inert, false);
  assert.deepEqual(f.scrollCalls, [{left: 10, top: 150, behavior: 'auto'}]);
  f.trigger.dispatchEvent(new Event('click')); f.trigger.dispatchEvent(new Event('click'));
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.document.activeElement, f.trigger);
  menu.dispose();
});

test('the menu contains Tab focus and leaves ordinary navigation to the browser', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture();
  const menu = mountStudyNavigation(f); menu.update({page: 'recording', publicationId});
  f.trigger.dispatchEvent(new Event('click'));
  f.links().at(-1).focus();
  assert.equal(f.key('Tab').defaultPrevented, true);
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.key('Tab', true).defaultPrevented, true);
  assert.equal(f.document.activeElement, f.links().at(-1));
  const event = new Event('click', {cancelable: true});
  Object.defineProperty(event, 'target', {value: f.links()[1]});
  Object.assign(event, {button: 0}); f.overlay.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(f.history, []);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.background.inert, false);
  menu.dispose();
});

test('publication updates retain the focused menu link and disposal removes behavior and restores reading', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture();
  const menu = mountStudyNavigation(f); menu.update({page: 'methods', publicationId});
  f.trigger.dispatchEvent(new Event('click'));
  const focused = f.links().find(link => link.dataset.studyPage === 'recordings'); focused.focus();
  const next = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  menu.update({page: 'analysis', publicationId: next});
  assert.equal(f.document.activeElement, focused);
  assert.equal(focused.href, `${PUBLIC_BASE}recordings?publication=${next}`);
  assert.equal(f.links().find(link => link.dataset.studyPage === 'methods').getAttribute('aria-current'), 'page');
  assert.equal(f.home.href, `${LAB_BASE}?publication=${next}`);
  menu.dispose();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.background.inert, false);
  assert.equal(f.document.activeElement, f.trigger);
  f.trigger.dispatchEvent(new Event('click'));
  assert.equal(f.overlay.hidden, true);
});

test('shared-page menu updates retain the focused Lab link and support Escape and contained Tab focus', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture();
  const menu = mountStudyNavigation(f); menu.update({page: 'index'});
  f.trigger.dispatchEvent(new Event('click'));
  const focused = f.links()[0];
  assert.equal(focused.href, LAB_BASE);
  assert.equal(focused.getAttribute('aria-current'), 'page');
  assert.equal(f.document.activeElement, focused);
  menu.update({page: 'privacy'});
  assert.equal(f.links()[0], focused);
  assert.equal(f.document.activeElement, focused);
  assert.equal(focused.getAttribute('aria-current'), null);
  assert.equal(f.background.inert, true);
  f.links().at(-1).focus();
  assert.equal(f.key('Tab').defaultPrevented, true);
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.key('Escape').defaultPrevented, true);
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.background.inert, false);
  menu.dispose();
});

test('study expansion changes only the child list and survives refreshes without replacing focused controls', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture(), menu = mountStudyNavigation(f);
  menu.update({page: 'about', publicationId}); f.trigger.dispatchEvent(new Event('click'));
  const button = f.buttons()[0], children = f.document.getElementById(button.getAttribute('aria-controls'));
  button.focus();
  assert.equal(f.click(button).defaultPrevented, false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.getAttribute('aria-label'), 'Expand Targeted Vegetation Movement');
  assert.equal(children.hidden, true);
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.background.inert, true);
  assert.deepEqual(f.history, []);
  menu.update({page: 'about', publicationId: previousPublicationId});
  assert.equal(f.buttons()[0], button);
  assert.equal(f.document.activeElement, button);
  assert.equal(children.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  f.click(button);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Collapse Targeted Vegetation Movement');
  assert.equal(children.hidden, false);
  menu.dispose();
});

test('collapsed child links are excluded from Tab containment while the expansion button stays focusable', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture(), menu = mountStudyNavigation(f);
  menu.update({page: 'privacy', publicationId}); f.trigger.dispatchEvent(new Event('click'));
  const button = f.buttons()[0];
  assert.ok(button);
  button.focus();
  assert.equal(f.key('Tab').defaultPrevented, false);
  assert.equal(f.document.activeElement, button);
  f.links().find(link => link.dataset.studyPage === 'methods').focus();
  assert.equal(f.key('Tab').defaultPrevented, true);
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.key('Tab', true).defaultPrevented, true);
  assert.equal(f.document.activeElement, f.links().at(-1));
  f.click(button);
  const child = f.links().find(link => link.dataset.studyPage === 'methods'); child.focus();
  assert.equal(f.key('Tab').defaultPrevented, false);
  assert.equal(f.document.activeElement, child);
  menu.dispose();
});

test('the study parent opens Overview normally and modified clicks retain the open menu and browser behavior', async () => {
  const {mountStudyNavigation} = await navigation(), f = fixture(), menu = mountStudyNavigation(f);
  menu.update({page: 'privacy', publicationId}); f.trigger.dispatchEvent(new Event('click'));
  const parent = f.links().find(link => link.dataset.studyOverview);
  assert.ok(parent);
  assert.equal(parent.href, publicStudyUrl('about', publicationId));
  for (const modifiers of [{metaKey: true}, {ctrlKey: true}, {shiftKey: true}, {altKey: true}, {button: 1}]) {
    assert.equal(f.click(parent, modifiers).defaultPrevented, false);
    assert.equal(f.overlay.hidden, false);
  }
  assert.equal(f.click(parent).defaultPrevented, false);
  assert.equal(f.overlay.hidden, true);
  assert.deepEqual(f.history, []);
  menu.dispose();
});
