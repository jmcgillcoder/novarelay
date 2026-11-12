import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hashPassword, hashSecret, makeSecret, timingEqualHex} from './security.mjs';

const INITIAL=()=>({version:1,admin:null,keys:[],accounts:[],prices:{},requests:[],sessions:[]});
const MAX_RECENT=250;
const DAY_MS=86400000;
const safeDay=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'');
const dayUTC=(t=Date.now())=>new Date(t).toISOString().slice(0,10);
const recentCutoff=()=>Date.now()-30*DAY_MS;
const newStats=()=>({requests:0,input:0,output:0,estimatedCost:0,byDay:{},byModel:{},byKey:{}});
export class Store {
  constructor(dir){
    this.dir=dir;this.file=path.join(dir,'state.json');this.logDir=path.join(dir,'logs');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    fs.mkdirSync(this.logDir,{recursive:true,mode:0o700});
    this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):INITIAL();
    if(this.data.version!==1)throw new Error('Unsupported state version');
    this.data.priceMappings ||= {};
    this.data.priceSync ||= {status:'never',updatedAt:null,matched:0,unmatched:[]};
    this.migrateLegacyLogs();
    this.dailyKeyCounts={};this.stats=newStats();this.data.requests=[];this.indexDay=dayUTC();
    this.loadRecentLogs();
    this.write();
  }
  migrateLegacyLogs(){
    if(this.data.logStorageVersion===2)return;
    const rows=this.data.requests||[];
    const byDay=new Map();const legacyCounts={};
    for(const row of rows){
      const day=String(row.time||'').slice(0,10);
      if(!safeDay(day))continue;
      const copy={...row,usageSource:row.usageSource==='upstream'?'estimated_upstream':row.usageSource==='estimated'?'estimated_local':row.usageSource};
      if(!byDay.has(day))byDay.set(day,[]);
      byDay.get(day).push(copy);
      if(row.keyId){const m=legacyCounts[day] ||= {};m[row.keyId]=(m[row.keyId]||0)+1;}
    }
    for(const [day,list] of byDay){
      const file=path.join(this.logDir,day+'.jsonl'),temp=file+'.legacy.tmp';
      fs.writeFileSync(temp,list.map(r=>JSON.stringify(r)+'\n').join(''),{mode:0o600});
      fs.renameSync(temp,file);fs.chmodSync(file,0o600);
    }
    // Preserve quota counts from records that had already been pruned by the v0.4.1 ring buffer.
    const base={};for(const [day,ids] of Object.entries(this.data.dailyKeyCounts||{})){
      for(const [key,n] of Object.entries(ids||{})){
        const missing=Math.max(0,Number(n||0)-Number(legacyCounts[day]?.[key]||0));
        if(missing)(base[day] ||= {})[key]=missing;
      }
    }
    this.data.quotaBase=base;delete this.data.dailyKeyCounts;this.data.logStorageVersion=2;
    this.data.requests=[]; // legacy content is now in day-partitioned JSONL logs
  }
  loadRecentLogs(){
    const lower=dayUTC(Date.now()-89*DAY_MS);
    for(const [day,keys] of Object.entries(this.data.quotaBase||{})){
      if(day<lower)continue;
      for(const [id,value] of Object.entries(keys||{})){
        (this.dailyKeyCounts[day] ||= {})[id]=Number(value||0);
      }
    }
    const filenames=fs.readdirSync(this.logDir).filter(n=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
    for(const filename of filenames){
      const day=filename.slice(0,10);
      if(day<lower){fs.rmSync(path.join(this.logDir,filename),{force:true});continue;}
      const logFile=path.join(this.logDir,filename);
      let content=fs.readFileSync(logFile,'utf8');
      if(content && !content.endsWith('\n')){
        const lastNewline=content.lastIndexOf('\n');
        // A power loss can leave a torn JSONL row; discard only that incomplete tail.
        fs.truncateSync(logFile,lastNewline+1);content=content.slice(0,lastNewline+1);
      }
      for(const line of content.split('\n')){
        if(!line.trim())continue;
        let row;try{row=JSON.parse(line);}catch{continue;} // ignore a torn trailing append after power loss
        this.accumulate(row);
      }
    }
    this.data.quotaBase=Object.fromEntries(Object.entries(this.data.quotaBase||{}).filter(([day])=>day>=lower));
  }
  accumulate(row){
    const day=String(row.time||'').slice(0,10);
    if(row.keyId && safeDay(day)){
      const counts=this.dailyKeyCounts[day] ||= {};
      counts[row.keyId]=(counts[row.keyId]||0)+1;
    }
    this.data.requests.push(row);if(this.data.requests.length>MAX_RECENT)this.data.requests.splice(0,this.data.requests.length-MAX_RECENT);
    if(Date.parse(row.time)<=recentCutoff())return;
    const s=this.stats;s.requests++;
    s.input+=row.usage?.prompt_tokens||0;s.output+=row.usage?.completion_tokens||0;s.estimatedCost+=row.costUsd||0;
    const daily=s.byDay[day] ||= {count:0,tokens:0,costUsd:0};
    daily.count++;daily.tokens+=(row.usage?.total_tokens||0);daily.costUsd+=(row.costUsd||0);
    const model=row.model||'-';s.byModel[model]=(s.byModel[model]||0)+1;
    if(row.keyId){
      const k=s.byKey[row.keyId] ||= {requests:0,input:0,output:0,referenceCostUsd:0,unpricedRequests:0,byModel:{}};
      k.requests++;
      k.input+=row.usage?.prompt_tokens||0;k.output+=row.usage?.completion_tokens||0;
      if(typeof row.costUsd==='number' && Number.isFinite(row.costUsd))k.referenceCostUsd+=row.costUsd;
      else k.unpricedRequests++;
      const m=k.byModel[model] ||= {requests:0,input:0,output:0,referenceCostUsd:0,unpricedRequests:0};
      m.requests++;m.input+=row.usage?.prompt_tokens||0;m.output+=row.usage?.completion_tokens||0;
      if(typeof row.costUsd==='number' && Number.isFinite(row.costUsd))m.referenceCostUsd+=row.costUsd;
      else m.unpricedRequests++;
    }
  }
  write(){
    const tmp=`${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify({...this.data,requests:[]},null,2),{mode:0o600});
    fs.renameSync(tmp,this.file);fs.chmodSync(this.file,0o600);
  }
  setAdmin(password){this.data.admin=hashPassword(password);this.data.sessions=[];this.write();}
  hasAdmin(){return Boolean(this.data.admin);}
  session(token){if(!token)return null;const h=hashSecret(token);return this.data.sessions.find(x=>timingEqualHex(x.hash,h)&&x.expires>Date.now())||null;}
  createSession(){
    const token=makeSecret(),csrf=makeSecret();this.data.sessions=this.data.sessions.filter(x=>x.expires>Date.now()).slice(-30);
    this.data.sessions.push({hash:hashSecret(token),csrf,expires:Date.now()+8*60*60*1000});this.write();return token;
  }
  deleteSession(token){this.data.sessions=this.data.sessions.filter(s=>!timingEqualHex(s.hash,hashSecret(token||'')));this.write();}
  createKey({name,models=[],dailyLimit=0}){
    const value=makeSecret('sk-mb-');const entry={id:randomUUID(),name,hash:hashSecret(value),prefix:value.slice(0,15)+'…',enabled:true,models,dailyLimit,createdAt:new Date().toISOString()};
    this.data.keys.push(entry);this.write();return {entry,value};
  }
  rotateKey(id){const item=this.data.keys.find(k=>k.id===id);if(!item)throw new Error('Key 不存在');const value=makeSecret('sk-mb-');item.hash=hashSecret(value);item.prefix=value.slice(0,15)+'…';item.rotatedAt=new Date().toISOString();this.write();return value;}
  apiKey(value){if(!value)return null;const h=hashSecret(value);return this.data.keys.find(k=>k.enabled&&timingEqualHex(k.hash,h))||null;}
  addAccount(account){const entry={id:randomUUID(),createdAt:new Date().toISOString(),enabled:true,...account};this.data.accounts.push(entry);this.write();return entry;}
  record({keyId=null,accountId,model,endpoint,status,latencyMs,usage,usageSource,costUsd,costSource}){
    if(dayUTC()!==this.indexDay){this.dailyKeyCounts={};this.stats=newStats();this.data.requests=[];this.loadRecentLogs();this.indexDay=dayUTC();}
    const time=new Date().toISOString();const row={id:randomUUID(),time,keyId,accountId,model,endpoint,status,latencyMs,usage,usageSource,costUsd,costSource};
    const file=path.join(this.logDir,time.slice(0,10)+'.jsonl');
    fs.appendFileSync(file,JSON.stringify(row)+'\n',{mode:0o600});
    this.accumulate(row);
  }
  keyCallsToday(id){return this.dailyKeyCounts[dayUTC()]?.[id]||0;}
  safeAccount(a){return {id:a.id,name:a.name,managed:Boolean(a.managed),url:a.url,enabled:a.enabled,models:a.models||[],renewal:a.renewal||null,createdAt:a.createdAt};}
  overview(){
    if(dayUTC()!==this.indexDay){this.dailyKeyCounts={};this.stats=newStats();this.data.requests=[];this.loadRecentLogs();this.indexDay=dayUTC();}
    const s=this.stats;
    const byDay=Object.entries(s.byDay).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,metrics])=>({date,...metrics}));
    const byModel=Object.entries(s.byModel).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([name,count])=>({name,count}));
    const keyUsage=Object.fromEntries(Object.entries(s.byKey).map(([id,k])=>[id,{...k,byModel:Object.entries(k.byModel).map(([model,metrics])=>({model,...metrics}))}]));
    return {keyUsage,keys:this.data.keys.map(({hash,...x})=>x),accounts:this.data.accounts.map(a=>this.safeAccount(a)),prices:this.data.prices,priceMappings:this.data.priceMappings,priceSync:this.data.priceSync,usage:{requests:s.requests,input:s.input,output:s.output,estimatedCost:s.estimatedCost},byDay,byModel,requests:this.data.requests.slice(-60).reverse(),hasAdmin:this.hasAdmin()};
  }
}
