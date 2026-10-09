import test from 'node:test';
import assert from 'node:assert/strict';
import {placeRegionLabel, renderPublicFigure, mountPublicFigures} from '../../web/public-study-figure.mjs';

const figureData = {
  imageUrl: '/retained/setup.png', originalUrl: '/retained/setup.png',
  imageSize: {width: 200, height: 150}, caption: 'Saved regions.', alt: 'Saved tree setup.',
  regions: {A: [[40, 60], [100, 60], [100, 120]],
    B: [[120, 60], [180, 60], [180, 120]], background: [[10, 130], [30, 130], [30, 145]]},
};

test('label placement uses display dimensions, stays above the region, and preserves saved geometry', () => {
  const saved = {points: figureData.regions.A, imageSize: figureData.imageSize,
    displaySize: {width: 400, height: 300}, labelSize: {width: 90, height: 28}};
  const before = structuredClone(saved), placed = placeRegionLabel(saved);
  assert.equal(placed.external, false);
  assert.ok(placed.top + 28 <= 120);
  assert.ok(placed.left >= 0 && placed.left + 90 <= 400);
  assert.deepEqual(saved, before);
});

test('edge labels clamp their full box, avoid existing labels, and use an outside key when space is exhausted', () => {
  const saved = {points: [[1, 1], [90, 1], [90, 70]], imageSize: {width: 100, height: 80},
    displaySize: {width: 200, height: 160}, labelSize: {width: 90, height: 28}};
  const first = placeRegionLabel(saved);
  assert.equal(first.external, false);
  assert.ok(first.left >= 0 && first.top >= 0 && first.left + 90 <= 200 && first.top + 28 <= 160);
  const second = placeRegionLabel({...saved, occupied: [{...first, width: 90, height: 28}]});
  assert.equal(second.external, false);
  assert.ok(second.left >= first.left + 90 || first.left >= second.left + 90
    || second.top >= first.top + 28 || first.top >= second.top + 28);
  assert.equal(placeRegionLabel({...saved, occupied: [{left: 0, top: 0, width: 200, height: 160}]}).external, true);
  assert.equal(placeRegionLabel({...saved, displaySize: {width: 70, height: 40}}).external, true);
});

test('inline and enlarged figures retain the same source, exact polygons, names, caption and original download', () => {
  const before = structuredClone(figureData);
  const inline = renderPublicFigure(figureData), enlarged = renderPublicFigure({...figureData, enlarged: true});
  for (const html of [inline, enlarged]) {
    assert.match(html, /src="\/retained\/setup.png"/);
    assert.match(html, /points="40,60 100,60 100,120"/);
    assert.match(html, /points="120,60 180,60 180,120"/);
    assert.match(html, /points="10,130 30,130 30,145"/);
    for (const name of ['Region A', 'Region B', 'Reference']) assert.ok(html.includes(`>${name}</span>`));
    assert.match(html, /Saved regions\./);
    assert.match(html, /Download original setup PNG/);
    assert.doesNotMatch(html, />Background<|<text/);
  }
  assert.match(inline, /Enlarge image/);
  assert.doesNotMatch(enlarged, /data-figure-open/);
  assert.deepEqual(figureData, before);
});

test('missing regions are stated explicitly and text in the component is escaped', () => {
  const html = renderPublicFigure({...figureData, regions: {A: figureData.regions.A}, caption: '<unsafe>'});
  assert.match(html, /Region B and Reference are unavailable/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
});

function eventNode() {
  return {listeners: new Map(), hidden: false, style: {}, dataset: {}, isConnected: true,
    addEventListener(kind, handler) { this.listeners.set(kind, handler); },
    removeEventListener(kind, handler) { if (this.listeners.get(kind) === handler) this.listeners.delete(kind); },
    dispatch(kind, target = this) { return this.listeners.get(kind)?.({type: kind, target, preventDefault() {}}); },
    focus() { this.focusCount = (this.focusCount ?? 0) + 1; }};
}
function fakeFigure(data = figureData) {
  const figure = eventNode(); figure.dataset.publicFigure = JSON.stringify(data);
  const frame = eventNode(); frame.bounds = {width: 400, height: 300};
  frame.getBoundingClientRect = () => frame.bounds;
  frame.closest = selector => selector === '[data-public-figure]' ? figure : null;
  const image = eventNode(); image.src = data.imageUrl; image.complete = true; image.naturalWidth = data.imageSize.width;
  image.dataset.figureImage = ''; image.closest = frame.closest;
  const loading = eventNode(), error = eventNode(), key = eventNode(); error.hidden = true; key.hidden = true;
  const labels = Object.keys(data.regions).map(region => {
    const label = eventNode(); label.dataset.regionLabel = region;
    label.getBoundingClientRect = () => ({width: 90, height: 28}); return label;
  });
  const keys = labels.map(label => {const item = eventNode(); item.dataset.regionKey = label.dataset.regionLabel; return item;});
  const nodes = {'[data-figure-frame]': frame, '[data-figure-image]': image, '[data-figure-loading]': loading,
    '[data-figure-error]': error, '[data-figure-key]': key};
  figure.querySelector = selector => nodes[selector] ?? null;
  figure.querySelectorAll = selector => selector === '[data-region-label]' ? labels : selector === '[data-region-key]' ? keys : [];
  const opener = eventNode(); opener.closest = selector => selector === '[data-figure-open]' ? opener : selector === '[data-public-figure]' ? figure : null;
  const retry = eventNode(); retry.closest = selector => selector === '[data-figure-retry]' ? retry : selector === '[data-public-figure]' ? figure : null;
  return {figure, frame, image, loading, error, key, labels, keys, opener, retry};
}
function harness() {
  const original = fakeFigure(), root = eventNode(), warnings = [], observers = [], dialogs = [];
  root.querySelectorAll = selector => selector === '[data-public-figure]' ? [original.figure] : [];
  root.append = dialog => {dialogs.push(dialog); dialog.parentNode = root;};
  const document = {defaultView: {console: {warn(...args) {warnings.push(args);}}}, createElement(name) {
    assert.equal(name, 'dialog');
    const dialog = eventNode(); dialog.contents = fakeFigure(); dialog.closeButton = eventNode();
    dialog.closeButton.closest = selector => selector === '[data-figure-close]' ? dialog.closeButton : null;
    dialog.setAttribute = (name, value) => {dialog[name] = value;};
    dialog.showModal = () => {dialog.open = true;};
    dialog.close = () => {dialog.open = false; dialog.dispatch('close');};
    dialog.remove = () => {dialog.isConnected = false;};
    dialog.querySelector = selector => selector === '[data-figure-close]' ? dialog.closeButton : selector === '[data-public-figure]' ? dialog.contents.figure : null;
    dialog.querySelectorAll = selector => selector === '[data-public-figure]' ? [dialog.contents.figure] : [];
    return dialog;
  }};
  class ResizeObserver {
    constructor(callback) {this.callback = callback; this.observed = new Set(); observers.push(this);}
    observe(target) {this.observed.add(target);}
    unobserve(target) {this.observed.delete(target);}
    disconnect() {this.observed.clear(); this.disconnected = true;}
  }
  return {original, root, document, ResizeObserver, warnings, observers, dialogs};
}

test('image and Enlarge actions open a native viewer; Close and Escape return focus to their opener', () => {
  const h = harness(), mounted = mountPublicFigures(h.root, h);
  h.root.dispatch('click', h.original.opener);
  const viewer = h.dialogs[0];
  assert.equal(viewer.open, true);
  assert.match(viewer.innerHTML, /src="\/retained\/setup.png"/);
  assert.match(viewer.innerHTML, /Region A/);
  assert.match(viewer.innerHTML, /Close image/);
  assert.ok(viewer.closeButton.focusCount);
  h.root.dispatch('click', viewer.closeButton);
  assert.equal(viewer.open, false); assert.equal(viewer.isConnected, false);
  assert.equal(h.original.opener.focusCount, 1);
  h.root.dispatch('click', h.original.opener);
  h.dialogs[1].dispatch('cancel');
  assert.equal(h.dialogs[1].open, false);
  assert.equal(h.original.opener.focusCount, 2);
  mounted.dispose();
});

test('actual measured label sizes are laid out on load and resize; crowded labels move into the adjacent key', () => {
  const h = harness(), mounted = mountPublicFigures(h.root, h);
  assert.ok(Number.parseFloat(h.original.labels[0].style.top) + 28 <= 120);
  h.original.frame.bounds = {width: 70, height: 40};
  h.observers[0].callback([{target: h.original.frame}]);
  assert.equal(h.original.key.hidden, false);
  assert.ok(h.original.labels.every(label => label.hidden));
  assert.ok(h.original.keys.every(item => !item.hidden));
  h.original.frame.bounds = {width: 400, height: 300};
  h.root.dispatch('load', h.original.image);
  assert.equal(h.original.key.hidden, true);
  assert.ok(h.original.labels.every(label => !label.hidden));
  mounted.dispose();
});

test('failed images log image context and show Retry; retry and successful load restore the local image state', () => {
  const h = harness(), mounted = mountPublicFigures(h.root, h);
  h.root.dispatch('error', h.original.image);
  assert.equal(h.original.error.hidden, false); assert.equal(h.original.loading.hidden, true);
  assert.ok(JSON.stringify(h.warnings).includes('/retained/setup.png'));
  h.root.dispatch('click', h.original.retry);
  assert.equal(h.original.error.hidden, true); assert.equal(h.original.loading.hidden, false);
  assert.equal(h.original.image.src, figureData.imageUrl);
  h.root.dispatch('load', h.original.image);
  assert.equal(h.original.loading.hidden, true);
  mounted.dispose();
});

test('dispose removes all delegated listeners, observation and an open viewer', () => {
  const h = harness(), mounted = mountPublicFigures(h.root, h);
  h.root.dispatch('click', h.original.opener);
  mounted.dispose();
  assert.equal(h.root.listeners.size, 0);
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.dialogs[0].listeners.size, 0);
  assert.equal(h.dialogs[0].isConnected, false);
});
