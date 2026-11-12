import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createHmac,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const CHILD=path.resolve(ROOT,'../child.mjs');
const jsonFrom=async(resp)=>{
  const text=await resp.text();
  try{return JSON.parse(text);}catch{throw new Error('账号引擎返回无效 JSON（HTTP '+resp.status+'）');}
};
const safeError=(x)=>String(x?.message||x).slice(0,240);
export class EmbeddedAccounts {
  constructor({store,dataDir,masterKey,notifier=null}){
    this.store=store;this.dataDir=dataDir;this.masterKey=masterKey;this.notifier=notifier;
    this.children=new Map();this.closing=false;
  }
  dir(a){return path.join(this.dataDir,'accounts',a.id);}
  key(a,kind){return createHmac('sha256',Buffer.from(this.masterKey,'hex')).update('lingxi-embedded:'+kind+':'+a.id).digest('base64url');}
  credentialsExist(a){
    if(!a.managed)return true;
    try{const j=JSON.parse(fs.readFileSync(path.join(this.dir(a),'credentials.json'),'utf8'));return Boolean(j.sid&&j.cookie);}catch{return false;}
  }
  tokenExists(a){return a.managed && fs.existsSync(path.join(this.dir(a),'data','token.json'));}
  recordRenewal(a,success,detail=''){
    const entry=this.store.data.accounts.find(x=>x.id===a.id);
    if(!entry)return;
    const now=new Date().toISOString();const old=entry.renewal||{};
    const needsReauth=!success && /FA_INVALID_SESSION|session expired|重新登录|cookie|登录会话|SID/i.test(String(detail));
    entry.renewal={...old,lastAttemptAt:now,...(success?{lastSuccessAt:now,lastError:null,requiresReauth:false}:{lastError:String(detail).slice(0,240),requiresReauth:needsReauth})};
    let notification=null;
    if(!success && (!old.lastAlertAt || Date.now()-Date.parse(old.lastAlertAt)>12*3600000)){
      notification=needsReauth?'登录已失效，需要重新授权':'Token 续期失败';
      entry.renewal.lastAlertAt=now;
    }else if(success && old.lastError){notification='Token 续期已恢复';entry.renewal.lastAlertAt=now;}
    this.store.write();
    if(notification)this.notifier?.send(notification,entry.name).catch(()=>{});
  }
  async startAll(){
    await Promise.all(this.store.data.accounts.filter(a=>a.managed && a.enabled).map(a=>this.start(a).catch(e=>console.error('[account start]',a.id,safeError(e)))));
  }
  async start(a){
    if(!a.managed)throw new Error('此账号不是内置引擎账号');
    let old=this.children.get(a.id);
    if(old?.port&&old.child?.exitCode===null)return old.port;
    if(old?.readyPromise)return old.readyPromise;
    const dir=this.dir(a);
    fs.mkdirSync(path.join(dir,'data'),{recursive:true,mode:0o700});
    const configPath=path.join(dir,'config.json');
    if(!fs.existsSync(configPath))fs.writeFileSync(configPath,JSON.stringify({apiKey:this.key(a,'client'),sessionLog:false,cacheEstimate:true}),{mode:0o600});
    const entry={child:null,port:0,readyPromise:null,restartTimer:null,error:''};
    this.children.set(a.id,entry);
    entry.readyPromise=new Promise((resolve,reject)=>{
      const childEnv={...process.env,LINGXI_ACCOUNT_DIR:dir,LINGXI_CHILD_ADMIN:this.key(a,'admin')};
      delete childEnv.ALERT_TELEGRAM_BOT_TOKEN;delete childEnv.ALERT_TELEGRAM_CHAT_ID;
      const child=fork(CHILD,[],{execArgv:[],stdio:['ignore','inherit','inherit','ipc'],env:childEnv});
      entry.child=child;
      let finished=false;
      const timeout=setTimeout(()=>fail(new Error('内置 139 引擎启动超时')),20000);
      const success=(port)=>{if(finished)return;finished=true;clearTimeout(timeout);entry.port=port;entry.readyPromise=null;resolve(port);};
      const fail=(e)=>{if(finished)return;finished=true;clearTimeout(timeout);entry.error=safeError(e);entry.readyPromise=null;reject(e);};
      child.on('message',m=>{
        if(m.type==='ready')success(m.port);
        if(m.type==='fatal')fail(new Error(m.message));
        if(m.type==='token-error'){entry.error=m.message;this.recordRenewal(a,false,m.message);}
        if(m.type==='token'){entry.error='';this.recordRenewal(a,true);}
      });
      child.on('error',fail);
      child.on('exit',(code)=>{
        entry.port=0;
        if(!finished)fail(new Error('内置引擎退出，代码 '+code));
        if(this.children.get(a.id)===entry){
          this.children.delete(a.id);
          if(!this.closing && !entry.stopping && this.store.data.accounts.some(x=>x.id===a.id && x.enabled)){
            const wait=setTimeout(()=>{entry.restartTimer=null;this.start(a).catch(e=>console.error('[account retry]',a.id,safeError(e)));},5000);
            entry.restartTimer=wait;
          }
        }
      });
    });
    return entry.readyPromise;
  }
  stop(a){
    const c=this.children.get(a.id);
    if(c){c.stopping=true;if(c.restartTimer)clearTimeout(c.restartTimer);c.child?.kill('SIGTERM');this.children.delete(a.id);}
  }
  stopAll(){this.closing=true;for(const a of this.store.data.accounts.filter(x=>x.managed))this.stop(a);}
  async request(a,method,endpoint,body,{admin=false,timeout=25000,signal=null}={}){
    const port=await this.start(a);
    const headers=admin?{'x-admin-token':this.key(a,'admin')}:{'Authorization':'Bearer '+this.key(a,'client')};
    if(body!==undefined)headers['Content-Type']='application/json';
    return fetch(`http://127.0.0.1:${port}${endpoint}`,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([AbortSignal.timeout(timeout),signal]):AbortSignal.timeout(timeout),redirect:'error'});
  }
  async status(a){
    if(!a.managed)return {status:'external'};
    const c=this.children.get(a.id);
    if(!a.enabled)return {status:'disabled',credentials:this.credentialsExist(a)};
    if(!c?.port)return {status:'starting',credentials:this.credentialsExist(a),error:c?.error||null};
    try{
      const r=await this.request(a,'GET','/healthz',undefined,{timeout:4000});
      const j=await jsonFrom(r);
      const valid=j.credentials?.sid&&j.credentials?.cookie;
      const requiresReauth=Boolean(a.renewal?.requiresReauth);
      return {status:requiresReauth?'needs_reauth':valid?'connected':'unconnected',credentials:Boolean(valid),token_cached:Boolean(j.token_cached),token_expiry:j.token_expiry||null,renewal:{...(a.renewal||{}),checkEveryHours:6,refreshAheadHours:24,nextCheckAt:a.renewal?.lastAttemptAt?new Date(Date.parse(a.renewal.lastAttemptAt)+6*3600000).toISOString():null},error:c.error||null};
    }catch(e){return {status:'offline',credentials:this.credentialsExist(a),error:safeError(e)};}
  }
  async connect(a,sid,cookie){
    if(!a.managed)throw new Error('旧版外部账号不能直接导入；请创建新的内置账号');
    if(!a.enabled)throw new Error('请先启用该账号');
    const resp=await this.request(a,'POST','/admin/api/credentials',{sid,cookie},{admin:true,timeout:40000});
    const result=await jsonFrom(resp);
    if(!resp.ok)throw Object.assign(new Error(result?.error||'139 登录凭据验证失败'),{status:422});
    this.recordRenewal(a,true);
    return {ok:true,verified:result.verified,expiresAt:result.token?.expiresAt||null};
  }
  async renew(a){
    if(!a.managed)throw new Error('仅支持内置账号续期');
    await this.start(a);
    const child=this.children.get(a.id)?.child;
    if(!child?.connected)throw new Error('账号引擎未连接');
    const id=randomUUID();
    try{
      const result=await new Promise((resolve,reject)=>{
        const done=(err,data)=>{clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);err?reject(err):resolve(data);};
        const onMessage=(m)=>{if(m?.type==='renew-result'&&m.id===id)done(m.ok?null:new Error(m.error||'重铸失败'),m);};
        const onExit=()=>done(new Error('账号引擎已退出'));
        const timer=setTimeout(()=>done(new Error('Token 续期超时')),40000);
        child.on('message',onMessage);child.once('exit',onExit);
        child.send({type:'renew',id},err=>{if(err)done(err);});
      });
      this.recordRenewal(a,true);
      return {ok:true,expiresAt:result.expiresAt||null};
    }catch(e){this.recordRenewal(a,false,e.message);throw e;}
  }
  remove(a){this.stop(a);if(a.managed)fs.rmSync(this.dir(a),{recursive:true,force:true});}
}
