import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMacAnalysisPage} from '../../web/views.mjs';
import {startMacAnalysisApplication} from '../../web/app.mjs';

const pending=message=>({status:'Pending Tree result',counts:{targets:0},narrative:[message],charts:[],tables:{}});
test('named Mac series selection displays only the chosen series with existing form controls',()=>{
  const html=renderMacAnalysisPage({series:{series:[{seriesId:'oak',label:'Oak sequence',manifestImported:true}],
    report:pending('Independent recordings only')},selectedSeriesId:'oak',
    seriesDetail:{seriesLabel:'Oak sequence',report:pending('Oak pending member')}});
  assert.match(html,/<option value="oak" selected>Oak sequence/);
  assert.match(html,/Oak pending member/);
  assert.doesNotMatch(html,/Independent recordings only/);
  assert.match(html,/Choose run or series bundle/);
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('selected Mac series is retained in the report export request',async()=>{
  const elements=new Map(),requests=[];
  const element=()=>({hidden:false,innerHTML:'',textContent:'',listeners:new Map(),
    addEventListener(kind,callback){this.listeners.set(kind,callback);},querySelector(){return null;},querySelectorAll(){return [];}});
  const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},querySelector:element};
  class Form {dataset={analysisForm:'select-series'};reportValidity(){return true;}}
  const window={HTMLFormElement:Form,FormData:class extends Map {constructor(){super([['series_id','oak']]);}},
    crypto:globalThis.crypto,setInterval(){return 1;},clearInterval(){},
    async fetch(url,options){requests.push({url,body:options?.body?JSON.parse(options.body):null});let value;
      if(url.endsWith('/runs'))value={runs:[]};
      else if(url.endsWith('/series'))value={series:[{seriesId:'oak',label:'Oak sequence'}],report:pending('Independent')};
      else if(url.endsWith('/series/oak'))value={seriesLabel:'Oak sequence',report:pending('Oak')};
      else if(url.endsWith('/profiles'))value={profiles:[]};
      else if(url.endsWith('/annotations'))value={jobs:[]};
      else if(url.endsWith('/publication'))value={jobs:[]};
      else if(url.endsWith('/setup-clip'))value={};
      else if(url.endsWith('/export-report'))value={filename:'oak.json',textFilename:'oak.txt'};
      else throw new Error('Unexpected route '+url);
      return new Response(JSON.stringify(value));}};
  startMacAnalysisApplication(document,window);await settle();await settle();
  elements.get('main').listeners.get('submit')({target:new Form(),preventDefault(){}});
  await settle();await settle();
  const button={dataset:{analysisOperation:'export-report'},disabled:false,type:'button'};
  elements.get('main').listeners.get('click')({target:{closest:()=>button}});
  await settle();await settle();
  assert.equal(requests.find(value=>value.url.endsWith('/export-report')).body.seriesId,'oak');
});
