import {createService} from '../../server/worker.mjs';
import {SessionStore} from '../../server/session-store.mjs';
import {EXPERIMENT} from '../../web/run-config.mjs';

export class MemoryStorage {
  values = new Map(); queue = Promise.resolve();
  async get(key) {return structuredClone(this.values.get(key));}
  async put(key,value) {this.values.set(key,structuredClone(value));}
  async list({prefix = '', startAfter = '', limit = 1000} = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && key > startAfter).sort(([left], [right]) => left.localeCompare(right)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
  }
  transaction(operation) {
    const result=this.queue.then(async()=>{const before=structuredClone(this.values);try{return await operation(this);}catch(error){this.values=before;throw error;}});
    this.queue=result.then(()=>{},()=>{}); return result;
  }
}
export function api(path,method='GET',body=null,headers={}) {
  return new Request(`https://test.lab.sourceof.love/tree-targeting/api/${path}`, {method,headers:{'Content-Type':'application/json',...headers},...(body===null?{}:{body:JSON.stringify(body)})});
}
export function harness(labels=['A','A','B'], options={}) {
  const storage=new MemoryStorage(),store=new SessionStore({storage,experimentSlug:EXPERIMENT.slug});
  let now=1000,ticket=0; const drawn=[];
  const randomService={drawn,
    async createTickets(count){return Array.from({length:count},()=>({ticketId:`ticket-${++ticket}`,creationTime:'2026-09-28 10:00:00Z',previousTicketId:null,nextTicketId:null}));},
    async draw(ticketId,binding){const bit=labels[drawn.length%labels.length]==='B'?1:0;drawn.push(ticketId);return {value:bit,result:{random:{method:'generateSignedIntegers',n:1,min:0,max:1,replacement:true,base:10,pregeneratedRandomization:null,data:[bit],userData:binding,ticketData:{ticketId},serialNumber:drawn.length,completionTime:'2026-09-28 10:00:00Z'},signature:'synthetic-test-only'},verification:{status:'pending'}};},
    async verifySignature(){return {status:'verified',response:{result:{authenticity:true}}};}
  };
  const deadlines=[];
  const service=createService({store,storage,randomService,authenticate:async()=>({id:'operator'}),clock:()=>now,
    codeCheckpoint:'a'.repeat(40),scheduleAlarm:async(runId,deadline)=>deadlines.push({runId,deadline}),...options});
  return {service,store,storage,randomService,deadlines,setTime:value=>{now=value;}};
}
export const action=(service,runId,kind,actionId,data={})=>service.fetch(api(`runs/${runId}/actions`,'POST',{actionId,kind,deviceId:'phone',clientAtMs:1000,data}));
export async function ready(h,runId,config,{seriesId, existing=false}={}){
  let response;
  if(!existing){response=await h.service.fetch(api('runs','POST',{runId,config,...(seriesId?{seriesId}:{})}));if(response.status!==201)throw new Error(JSON.stringify(await response.json()));}
  for(const [kind,data] of [['prepare',{}],['designatePlayback',{deviceId:'phone'}]]){
    response=await action(h.service,runId,kind,kind,data);if(response.status!==200)throw new Error(JSON.stringify(await response.json()));
    if(kind==='designatePlayback')h.playbackToken=(await response.json()).playbackToken;
  }
  for(const kind of ['testAudioPlayed','recordingReady','start']){
    response=await action(h.service,runId,kind,kind,{deviceId:'phone',playbackToken:h.playbackToken});if(response.status!==200)throw new Error(JSON.stringify(await response.json()));
  }
}
export async function play(h,runId,at){
  h.setTime(at);
  const record=await h.store.readRun(runId);const cue=record.state.pendingDelivery;
  const response=await action(h.service,runId,'cuePlayed','play-'+cue.cueId,{cueId:cue.cueId,deviceId:'phone',playbackToken:h.playbackToken});
  if(response.status!==200)throw new Error(JSON.stringify(await response.json()));
  await action(h.service,runId,'cueEnded','end-'+cue.cueId,{cueId:cue.cueId,deviceId:'phone',playbackToken:h.playbackToken});
  return cue;
}
