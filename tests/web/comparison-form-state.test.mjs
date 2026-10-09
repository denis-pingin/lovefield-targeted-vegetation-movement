import test from 'node:test';
import assert from 'node:assert/strict';
import {startMacAnalysisApplication} from '../../web/app.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

function comparisonForm(html) {
  const formHtml = [...html.matchAll(/<form\b[^>]*data-analysis-form="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)]
    .find(match => match[1] === 'save-comparison')?.[2];
  if (!formHtml) return null;
  const elements = [];
  for (const match of formHtml.matchAll(/<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const attributes = match[1] ?? match[2];
    const name = attributes.match(/\bname="([^"]+)"/)?.[1];
    if (!name) continue;
    if (match[1] != null) {
      const type = attributes.match(/\btype="([^"]+)"/)?.[1] ?? 'text';
      elements.push({name, type, value: attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? '',
        checked: /\bchecked\b/.test(attributes)});
      continue;
    }
    const options = [...match[3].matchAll(/<option\b([^>]*)>/g)].map(option => ({
      value: option[1].match(/\bvalue="([^"]*)"/)?.[1] ?? '',
      selected: /\bselected\b/.test(option[1]),
    }));
    elements.push({name, type: 'select-one', options,
      value: options.find(option => option.selected)?.value ?? options[0]?.value ?? '', checked: false});
  }
  return {dataset: {analysisForm: 'save-comparison'}, elements};
}

function harness() {
  const candidates = {profiles: [
    {profileId: 'legacy', label: 'Point average'},
    {profileId: 'area', label: 'Area average'},
    {profileId: 'custom', label: 'Other point profile'},
  ], runs: [0, 1].map(index => ({runId: `run-${index}`, tag: `Oak ${index}`, createdAtMs: 1000 + index,
    analyses: [{analysisId: `area-${index}`, profileId: 'area', status: 'completed'},
      {analysisId: `custom-first-${index}`, profileId: 'custom', status: 'completed'},
      {analysisId: `custom-latest-${index}`, profileId: 'custom', status: 'completed'}]}))};
  const elements = new Map();
  const ordinaryElement = () => ({hidden: false, textContent: '', innerHTML: '', addEventListener(){},
    querySelector(){return null;}, querySelectorAll(){return [];}});
  const main = ordinaryElement();
  let html = '';
  let forms = [];
  const listeners = {};
  Object.defineProperty(main, 'innerHTML', {get: () => html, set(value) {
    html = value;
    const comparison = comparisonForm(value);
    forms = comparison ? [comparison] : [];
  }});
  main.addEventListener = (name, listener) => { listeners[name] = listener; };
  main.querySelectorAll = selector => selector === 'form' ? forms : [];
  elements.set('main', main);
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, ordinaryElement());
    return elements.get(id);
  }, querySelector(){return ordinaryElement();}};
  const timers = [];
  const window = {crypto: globalThis.crypto, setInterval(callback){timers.push(callback); return timers.length;},
    clearInterval(){}, async fetch(url) {
      const value = url.endsWith('/runs') ? {runs: []} :
        url.endsWith('/series') ? {report: null} :
        url.endsWith('/setup-clip') ? {} :
        url.endsWith('/profiles') ? {profiles: []} :
        url.endsWith('/comparison-candidates') ? candidates :
        url.endsWith('/comparisons') ? {comparisons: []} :
        url.endsWith('/publication') ? {jobs: []} :
        url.endsWith('/annotations') ? {jobs: []} : null;
      if (value === null) throw new Error(`Unexpected ${url}`);
      return new Response(JSON.stringify(value));
    }};
  return {document, window, timers, listeners, form: () => forms[0]};
}

test('switching one comparison profile resets only its revisions and polling keeps the new draft', async () => {
  const view = harness();
  startMacAnalysisApplication(view.document, view.window);
  await settle(); await settle();
  const control = name => view.form().elements.find(item => item.name === name);
  assert.equal(control('left_analysis_0').value, '');
  control('comparison_label').value = 'Oak comparison';
  control('include_1').checked = false;
  control('right_analysis_0').value = 'area-0';
  const leftProfile = control('left_profile_id');
  leftProfile.value = 'custom';
  view.listeners.change({target: leftProfile});
  assert.equal(control('left_analysis_0').value, 'custom-latest-0');
  assert.equal(control('left_analysis_1').value, 'custom-latest-1');
  assert.equal(control('comparison_label').value, 'Oak comparison');
  assert.equal(control('include_1').checked, false);
  assert.equal(control('right_analysis_0').value, 'area-0');
  control('left_analysis_0').value = 'custom-first-0';
  view.timers[0]();
  await settle(); await settle();
  assert.equal(control('left_analysis_0').value, 'custom-first-0');
  assert.equal(control('comparison_label').value, 'Oak comparison');
  assert.equal(control('include_1').checked, false);
});
