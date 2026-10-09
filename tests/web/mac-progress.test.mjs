import test from 'node:test';
import assert from 'node:assert/strict';
import {startMacAnalysisApplication} from '../../web/app.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const elements = new Map();
  const element = () => ({hidden:false,textContent:'',innerHTML:'',addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}});
  const document = {getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},querySelector(){return element();}};
  const requests = [],timers = [];
  let running = true;
  const window = {crypto:globalThis.crypto, setInterval(callback){timers.push(callback);return timers.length;},clearInterval(){},
    async fetch(url){
      requests.push(url);
      let value;
      if(url.endsWith('/runs'))value={runs:[{runId:'retained-run',mode:'tree',purpose:'preparation',analysisRunning:running}]};
      else if(url.endsWith('/series'))value={report:null};
      else if(url.endsWith('/profiles'))value={profiles:[]};
      else if(url.endsWith('/comparison-candidates'))value={runs:[],profiles:[]};
      else if(url.endsWith('/comparisons'))value={comparisons:[]};
      else if(url.endsWith('/annotations'))value={jobs:[]};
      else if(url.endsWith('/publication'))value={jobs:[]};
      else if(url.endsWith('/progress'))value={stage:'Tracking Tree',completed:12,total:100};
      else if(url.endsWith('/setup-clip'))value={};
      else throw new Error(`Unexpected ${url}`);
      return new Response(JSON.stringify(value));
    }};
  return {document,window,requests,timers,elements,finish(){running=false;}};
}

test('a reopened Mac page refreshes completion without a selected run and clears its busy controls',async()=>{
  const h=harness();startMacAnalysisApplication(h.document,h.window);
  await settle();await settle();
  const main=h.elements.get('main');
  assert.match(main.innerHTML,/Other controls are unavailable/);
  h.finish();h.timers[0]();await settle();await settle();
  assert.equal(h.requests.filter(path=>path.endsWith('/runs')).length,2);
  assert.doesNotMatch(main.innerHTML,/Other controls are unavailable/);
});

test('attached background progress never displays an invented zero elapsed duration',async()=>{
  const h=harness();startMacAnalysisApplication(h.document,h.window);
  await settle();await settle();
  assert.doesNotMatch(h.elements.get('main').innerHTML,/0 seconds elapsed/);
});
