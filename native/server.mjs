import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {Store} from './lib/storage.mjs';
import {parseBearer, readCookies, setSessionCookie, clearSessionCookie, verifyPassword, makeSecret, encryptSecret, decryptSecret, permittedUpstream} from './lib/security.mjs';
import {measure, costFor, textOf, estimateTokens} from './lib/meter.mjs';
import {toChatRequest, fromChatResponse, makeResponse, newResponseId, toolCallItem, messageItem} from './lib/responses.mjs';
import {EmbeddedAccounts} from './lib/embedded.mjs';
import {fetchPriceCatalog,applyCatalog,priceCandidates} from './lib/pricing.mjs';
import {anthropicToChat,chatToAnthropic} from './lib/anthropic.mjs';
import {createAnthropicStream} from './lib/anthropic-stream.mjs';
import {updateInfo,queueUpdate} from './lib/updater.mjs';
import {createRenewalNotifier} from './lib/alerts.mjs';

const publicDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const send=(res,status,payload,headers={})=>{
  if(res.headersSent)return;
  const value=JSON.stringify(payload);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(value);
};
const fail=(res,status,msg)=>send(res,status,{error:{message:msg,type:'invalid_request_error',code:String(status)}});
const noCacheSecurity=(res)=>{
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cache-Control','no-store');
};
const parseBody=async(req,limit=262144)=>{
  let size=0, chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('请求体过大'),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('请求体需要是有效 JSON'),{status:400});}
};
const validName=x=>typeof x==='string' && x.trim().length>0 && x.length<=80;
const isPlainModel=x=>typeof x==='string' && x.trim().length>0 && x.length<=120;
const validModels=x=>Array.isArray(x) && x.length<=100 && x.every(isPlainModel);
const ipOf=req => String(req.socket.remoteAddress||'unknown');
const ownOrigin=(req)=>{ const o=req.headers.origin; if(!o)return true;try{const u=new URL(o);return u.host===req.headers.host && ['https:','http:'].includes(u.protocol);}catch{return false;} };
const transientAccountError = code => code === 401 || code === 403 || code === 408 || code === 429 || code >= 500;
const accountOutcome = (store, account, status) => {
  if (!account) return;
  if (status >= 200 && status < 300) { store.accountHealth.delete(account.id); return; }
  if (!transientAccountError(status)) return; // do not quarantine for invalid user payloads
  const now = Date.now();
  const current = store.accountHealth.get(account.id) || {failures:0,until:0};
  const failures = current.failures + 1;
  const delay = Math.min(5*60000, 60000 * 2**Math.min(3,failures-1));
  store.accountHealth.set(account.id,{failures,until:now+delay,lastStatus:status,lastFailedAt:new Date(now).toISOString()});
};
const selectAccount=(store,model,stickiness=null)=>{
  const now=Date.now();
  const matches=store.data.accounts.filter(a=>a.enabled && !a.renewal?.requiresReauth &&
    (!a.models?.length || a.models.includes(model)) && (!a.managed || store.embedded.credentialsExist(a)) &&
    (store.accountHealth.get(a.id)?.until || 0) <= now);
  if(!matches.length)throw Object.assign(new Error('没有配置允许该模型的可用 139 上游账号'),{status:503});
  if(stickiness){
    const index=createHash('sha256').update(stickiness+'|'+model).digest().readUInt32BE(0)%matches.length;
    return matches[index];
  }
  store.roundRobin=(store.roundRobin||0)+1;
  return matches[(store.roundRobin-1)%matches.length];
};
async function upstreamFetch(account,method,urlPath,body,masterKey,timeout=150000,signal=null){
  const apiKey=decryptSecret(account.secret,masterKey);
  const u=new URL(urlPath,account.url);
  if(u.host!==new URL(account.url).host) throw new Error('非法上游路径');
  const headers={'Authorization':`Bearer ${apiKey}`};
  if(body!==undefined)headers['Content-Type']='application/json';
  return await fetch(u,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([AbortSignal.timeout(timeout),signal]):AbortSignal.timeout(timeout),redirect:'error'});
}
async function upstreamModels(account,masterKey){
  const resp=await upstreamFetch(account,'GET','/v1/models',undefined,masterKey,15000);
  if(!resp.ok)throw new Error(`models: HTTP ${resp.status}`);
  const json=await resp.json();
  if(!Array.isArray(json.data))throw new Error('上游未返回模型列表');
  return json.data;
}
const errText=async(r)=>{let t=await r.text();return t.slice(0,16000);};

/** Never forward an upstream-requested tool which the client did not declare. */
function validateUpstreamToolCalls(result,tools=[]){
  const calls=result?.choices?.[0]?.message?.tool_calls||[];
  if(!Array.isArray(calls)||calls.length>32)throw Object.assign(new Error('上游工具调用数量异常'),{status:502});
  const permitted=new Set(tools.map(x=>x?.function?.name).filter(Boolean));
  const ids=new Set();
  for(const c of calls){
    const name=c?.function?.name;
    if(!permitted.has(name)||typeof c?.id!=='string'||!c.id||ids.has(c.id))throw Object.assign(new Error('上游请求了未声明或重复的工具调用'),{status:502});
    ids.add(c.id);
    const args=c.function.arguments;
    if(typeof args!=='string'||args.length>65536)throw Object.assign(new Error('工具参数长度或格式无效'),{status:502});
    let parsed;try{parsed=JSON.parse(args);}catch{throw Object.assign(new Error('工具参数不是 JSON'),{status:502});}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Object.assign(new Error('工具参数需要 JSON 对象'),{status:502});
  }
}

export function createGateway({dataDir,masterKey,cookieSecure=true,pricingFetch=fetch,githubFetch=fetch}={}){
  if(!/^[0-9a-f]{64}$/i.test(masterKey||''))throw new Error('必须设置合法 MASTER_KEY (openssl rand -hex 32)');
  const store=new Store(dataDir);
  store.accountActive=new Map();
  store.accountHealth=new Map(); // volatile runtime circuit-breakers: never persisted as long-term credential state
  const embedded=new EmbeddedAccounts({store,dataDir,masterKey,notifier:createRenewalNotifier()});
  store.embedded=embedded;
  const fetchUpstream=(a,method,urlPath,body,key,timeout=150000,signal=null)=>a.managed?embedded.request(a,method,urlPath,body,{timeout,signal}):upstreamFetch(a,method,urlPath,body,key,timeout,signal);
  const getUpstreamModels=async(a)=>{const resp=await fetchUpstream(a,'GET','/v1/models',undefined,masterKey,15000);if(!resp.ok)throw new Error('获取模型失败，HTTP '+resp.status);const j=await resp.json();if(!Array.isArray(j.data))throw new Error('模型列表格式错误');return j.data;};
  const pricingCache={data:null,loadedAt:0,working:false};
  async function syncPricing({force=false}={}){
    if(pricingCache.working)throw Object.assign(new Error('价格同步正在进行'),{status:409});
    pricingCache.working=true;
    try{
      if(force||!pricingCache.data||Date.now()-pricingCache.loadedAt>24*3600000){
        pricingCache.data=await fetchPriceCatalog(pricingFetch);pricingCache.loadedAt=Date.now();
      }
      const accounts=store.data.accounts.filter(a=>a.enabled && (!a.managed||embedded.credentialsExist(a)));
      const settled=await Promise.all(accounts.map(a=>getUpstreamModels(a).catch(()=>[])));
      const descriptors=[...settled.flat(),...Object.keys(store.data.priceMappings||{}).map(id=>({id}))];
      const result=applyCatalog(store.data,descriptors,pricingCache.data);
      store.data.priceSync={status:'ok',...result};store.write();
      return result;
    }catch(e){store.data.priceSync={...store.data.priceSync,status:'error',lastError:String(e.message||e).slice(0,180),attemptedAt:new Date().toISOString()};store.write();throw e;}
    finally{pricingCache.working=false;}
  }
  // An unavailable public price feed never interrupts 139 AI requests.
  const autoPricing=process.env.PRICE_AUTO_SYNC!=='0';
  const pricingTimer=autoPricing?setInterval(()=>syncPricing({force:true}).catch(e=>console.warn('[pricing]',e.message)),24*3600000):null;
  pricingTimer?.unref();
  const startupPriceTimer=autoPricing?setTimeout(()=>syncPricing().catch(e=>console.warn('[pricing]',e.message)),5000):null;
  startupPriceTimer?.unref();
  const badLogins=new Map();
  const inFlight=new Map();
  const dailyPending=new Map(); // reserve quota before the first async operation
  const server=http.createServer(async(req,res)=>{
    noCacheSecurity(res);
    const u=new URL(req.url,'http://localhost');
    const pathname=u.pathname;
    try{
      if(req.method==='GET' && pathname==='/healthz')return send(res,200,{ok:true,service:'novarelay',version:'1.0.0',accounts:store.data.accounts.length});
      if(req.method==='GET' && pathname==='/readyz'){
        const ready=store.data.accounts.some(a=>a.enabled && !a.renewal?.requiresReauth && (!a.managed||embedded.credentialsExist(a)) && (store.accountHealth.get(a.id)?.until||0)<=Date.now());
        return send(res,ready?200:503,{ready,service:'novarelay',accounts:store.data.accounts.length});
      }
      if(req.method==='GET'&&pathname==='/'){res.writeHead(302,{Location:'/console'});return res.end();}
      if(pathname.startsWith('/console'))return await adminRoute(req,res,pathname);
      if(pathname.startsWith('/v1/'))return await apiRoute(req,res,pathname);
      return fail(res,404,'Not found');
    } catch(error) {
      const status=Number.isInteger(error.status)?error.status:500;
      if(status===500)console.error('[gateway]',String(error?.stack||error).slice(0,4000));
      if(!res.headersSent){
        const message=status===500?'服务器内部错误':error.message;
        if(pathname.startsWith('/v1/messages'))return send(res,status,{type:'error',error:{type:status===401?'authentication_error':status===403?'permission_error':status===429?'rate_limit_error':status>=500?'api_error':'invalid_request_error',message}});
        return fail(res,status,message);
      }
      if(!res.writableEnded)res.end();
    }
  });
  async function adminRoute(req,res,pathname){
    if(req.method==='GET' && ['/console','/console/','/console/app.js','/console/style.css'].includes(pathname)) {
      const filename=pathname==='/console/app.js'?'app.js':pathname==='/console/style.css'?'style.css':'index.html';
      const mime=filename.endsWith('.js')?'text/javascript; charset=utf-8':filename.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';
      res.writeHead(200,{'Content-Type':mime,'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
      return res.end(fs.readFileSync(path.join(publicDir,filename)));
    }
    if(!pathname.startsWith('/console/api/'))return fail(res,404,'Not found');
    const sessionToken=readCookies(req).novarelay_session;
    const session=store.session(sessionToken);
    if(pathname==='/console/api/session' && req.method==='GET')return send(res,200,{loggedIn:Boolean(session),csrf:session?.csrf||null,configured:store.hasAdmin()});
    if(pathname==='/console/api/login' && req.method==='POST'){
      if(!ownOrigin(req))return fail(res,403,'跨站请求已拒绝');
      const ip=ipOf(req), now=Date.now();
      const current=badLogins.get(ip)||{failures:0,lockUntil:0};
      if(current.lockUntil>now)return fail(res,429,'登录失败次数过多，请稍后再试');
      const body=await parseBody(req,4096);
      if(!store.hasAdmin())return fail(res,503,'管理员尚未初始化，请运行 npm run set-admin');
      if(body.username!=='admin' || !verifyPassword(body.password,store.data.admin)){
        current.failures++;if(current.failures>=5){current.lockUntil=now+5*60*1000;current.failures=0;}
        badLogins.set(ip,current);return fail(res,401,'用户名或密码错误');
      }
      badLogins.delete(ip);
      const token=store.createSession();setSessionCookie(res,token,cookieSecure);
      return send(res,200,{ok:true});
    }
    if(!session)return fail(res,401,'请先登录');
    if(req.method!=='GET'){
      if(!ownOrigin(req))return fail(res,403,'跨站请求已拒绝');
      if(req.headers['x-csrf-token']!==session.csrf)return fail(res,403,'CSRF 校验失败');
    }
    if(pathname==='/console/api/logout' && req.method==='POST'){
      store.deleteSession(sessionToken);clearSessionCookie(res,cookieSecure);return send(res,200,{ok:true});
    }
    if(pathname==='/console/api/state' && req.method==='GET'){
      const view=store.overview();
      view.accounts=await Promise.all(store.data.accounts.map(async a=>({
        ...store.safeAccount(a),...(a.managed?await embedded.status(a):{status:'external'}),
        ...(store.accountHealth.has(a.id)?{circuitBreaker:{...store.accountHealth.get(a.id),cooldownUntil:new Date(store.accountHealth.get(a.id).until).toISOString()}}:{})
      })));
      view.alerts=view.accounts.filter(a=>a.enabled && (a.renewal?.requiresReauth || a.renewal?.lastError || a.status==='offline' || a.status==='needs_reauth' || (a.token_expiry && Date.parse(a.token_expiry)-Date.now()<24*3600000))).map(a=>({id:a.id,name:a.name,kind:a.renewal?.requiresReauth?'reauth':a.renewal?.lastError?'renewal':a.status==='offline'?'offline':'expiry',message:a.renewal?.requiresReauth?'139 登录会话可能失效，请重新授权':a.renewal?.lastError?'Token 续期失败，请检查详情':a.status==='offline'?'账号引擎暂时离线':'Token 将在 24 小时内到期'}));
      return send(res,200,view);
    }
    if(pathname==='/console/api/updates' && req.method==='GET')return send(res,200,await updateInfo(dataDir,{remote:true,fetchFn:githubFetch}));
    if(pathname==='/console/api/updates/apply' && req.method==='POST')return send(res,202,queueUpdate(dataDir));
    if(pathname==='/console/api/admin/password' && req.method==='POST'){
      const b=await parseBody(req,4096);
      if(!verifyPassword(b.current,store.data.admin))return fail(res,403,'原密码不正确');
      if(typeof b.next!=='string'||b.next.length<8||b.next.length>200)return fail(res,400,'新密码要求 8–200 位');
      store.setAdmin(b.next);clearSessionCookie(res,cookieSecure);return send(res,200,{ok:true,requiresLogin:true});
    }
    if(pathname==='/console/api/keys' && req.method==='POST'){
      const body=await parseBody(req);
      if(!validName(body.name))return fail(res,400,'Key 名称必须为 1–80 字');
      const models=body.models||[], dailyLimit=Number(body.dailyLimit||0);
      if(!validModels(models)||!Number.isInteger(dailyLimit)||dailyLimit<0||dailyLimit>1000000)return fail(res,400,'模型列表或每日限额不合法');
      const {entry,value}=store.createKey({name:body.name.trim(),models,dailyLimit});
      return send(res,201,{key:value,entry:{...entry,hash:undefined}});
    }
    const rotateMatch=pathname.match(/^\/console\/api\/keys\/([0-9a-f-]{36})\/rotate$/);
    if(rotateMatch && req.method==='POST'){
      const key=store.data.keys.find(k=>k.id===rotateMatch[1]);if(!key)return fail(res,404,'Key 不存在');
      const b=await parseBody(req,2048);
      if(!verifyPassword(b.password,store.data.admin))return fail(res,403,'管理员密码不正确');
      const value=store.rotateKey(key.id);
      return send(res,200,{ok:true,key:value,entry:{id:key.id,name:key.name,prefix:key.prefix}});
    }
    const keyMatch=pathname.match(/^\/console\/api\/keys\/([0-9a-f-]{36})$/);
    if(keyMatch && ['PATCH','DELETE'].includes(req.method)){
      const key=store.data.keys.find(k=>k.id===keyMatch[1]);if(!key)return fail(res,404,'Key 不存在');
      if(req.method==='DELETE')store.data.keys=store.data.keys.filter(k=>k.id!==key.id);
      else {const body=await parseBody(req); if(typeof body.enabled!=='boolean')return fail(res,400,'enabled 必须是布尔值');key.enabled=body.enabled;}
      store.write();return send(res,200,{ok:true});
    }
    if(pathname==='/console/api/accounts' && req.method==='POST'){
      const body=await parseBody(req,65536);
      if(!validName(body.name))return fail(res,400,'账号名称应为 1–80 个字符');
      if(store.data.accounts.length>=30)return fail(res,429,'单实例最多添加 30 个 139 账号');
      const hasSid=typeof body.sid==='string' && body.sid.trim();
      const hasCookie=typeof body.cookie==='string' && body.cookie.trim();
      if(Boolean(hasSid)!==Boolean(hasCookie))return fail(res,400,'需同时提供 SID 和完整 Cookie，或先创建未连接账号');
      if(hasSid && (body.sid.length>2048||body.cookie.length>32768))return fail(res,400,'登录凭据过长');
      const entry=store.addAccount({name:body.name.trim(),managed:true,models:[]});
      let connected=false, warning=null;
      try{
        await embedded.start(entry);
        if(hasSid){await embedded.connect(entry,body.sid,body.cookie);connected=true;if(autoPricing)queueMicrotask(()=>syncPricing().catch(()=>{}));}
      }catch(e){warning=String(e.message||e).slice(0,300);}
      return send(res,201,{...store.safeAccount(entry),connected,warning});
    }
    const accountMatch=pathname.match(/^\/console\/api\/accounts\/([0-9a-f-]{36})$/);
    if(accountMatch && ['PATCH','DELETE'].includes(req.method)){
      const a=store.data.accounts.find(k=>k.id===accountMatch[1]);if(!a)return fail(res,404,'账号不存在');
      if(req.method==='DELETE'){embedded.remove(a);store.data.accounts=store.data.accounts.filter(k=>k.id!==a.id);}
      else {
        const b=await parseBody(req);
        if(b.enabled!==undefined){if(typeof b.enabled!=='boolean')return fail(res,400,'enabled 应为布尔值');a.enabled=b.enabled;if(a.managed){if(a.enabled)await embedded.start(a);else embedded.stop(a);}}
        if(b.name!==undefined){if(!validName(b.name))return fail(res,400,'名称无效');a.name=b.name.trim();}
        if(b.models!==undefined){if(!validModels(b.models))return fail(res,400,'模型列表无效');a.models=b.models;}
        if(b.apiKey!==undefined){if(a.managed)return fail(res,400,'内置账号不需要上游 API Key');if(typeof b.apiKey!=='string'||b.apiKey.length<8)return fail(res,400,'上游密钥无效');a.secret=encryptSecret(b.apiKey,masterKey);}
      }
      store.write();return send(res,200,{ok:true});
    }
    const connectMatch=pathname.match(/^\/console\/api\/accounts\/([0-9a-f-]{36})\/connect$/);
    if(connectMatch && req.method==='POST'){
      const a=store.data.accounts.find(x=>x.id===connectMatch[1]);if(!a)return fail(res,404,'账号不存在');
      const b=await parseBody(req,65536);
      if(typeof b.sid!=='string'||!b.sid.trim()||b.sid.length>2048||typeof b.cookie!=='string'||b.cookie.trim().length<10||b.cookie.length>32768)return fail(res,400,'请填写完整 SID 和 Cookie');
      return send(res,200,await embedded.connect(a,b.sid.trim(),b.cookie));
    }
    const renewMatch=pathname.match(/^\/console\/api\/accounts\/([0-9a-f-]{36})\/renew$/);
    if(renewMatch && req.method==='POST'){
      const a=store.data.accounts.find(x=>x.id===renewMatch[1]);if(!a)return fail(res,404,'账号不存在');
      return send(res,200,await embedded.renew(a));
    }
    const checkMatch=pathname.match(/^\/console\/api\/accounts\/([0-9a-f-]{36})\/check$/);
    if(checkMatch && req.method==='POST'){
      const a=store.data.accounts.find(k=>k.id===checkMatch[1]);if(!a)return fail(res,404,'账号不存在');
      if(a.managed){const t=await embedded.status(a);return send(res,200,{ok:t.status==='connected',...t});}
      const r=await fetchUpstream(a,'GET','/healthz',undefined,masterKey,15000);
      const t=await r.text();let parsed={};try{parsed=JSON.parse(t);}catch{};
      return send(res,200,{ok:r.ok && parsed.ok===true,httpStatus:r.status,token_cached:parsed.token_cached??null,token_expiry:parsed.token_expiry??null,credentials_available:Boolean(parsed.credentials?.sid||parsed.credentials?.cookie)});
    }
    if(pathname==='/console/api/models' && req.method==='GET'){
      const accounts=store.data.accounts.filter(a=>a.enabled && (!a.managed||embedded.credentialsExist(a))); 
      const results=await Promise.all(accounts.map(async a=>{try{return {account:a.name,models:await getUpstreamModels(a)};}catch(e){return {account:a.name,error:e.message,models:[]};}}));
      return send(res,200,{results});
    }
    if(pathname==='/console/api/test' && req.method==='POST'){
      const b=await parseBody(req,20000);if(!isPlainModel(b.model)||typeof b.prompt!=='string'||b.prompt.length<1||b.prompt.length>2000)return fail(res,400,'模型和测试提示词无效');
      const a=b.accountId?store.data.accounts.find(a=>a.enabled && a.id===b.accountId):selectAccount(store,b.model);
      if(!a)return fail(res,404,'账号不存在或已停用');
      const protocol=b.protocol||'chat';
      if(!['chat','responses','anthropic'].includes(protocol))return fail(res,400,'不支持的协议格式');
      const payload=protocol==='responses'?toChatRequest({model:b.model,input:b.prompt}):protocol==='anthropic'?anthropicToChat({model:b.model,max_tokens:256,messages:[{role:'user',content:b.prompt}]}):{model:b.model,messages:[{role:'user',content:b.prompt}],stream:false};
      const t=Date.now();
      const r=await fetchUpstream(a,'POST','/v1/chat/completions',payload,masterKey,90000);
      const value=await r.json().catch(()=>({error:{message:'上游未返回 JSON'}}));
      const text=textOf(value?.choices?.[0]?.message||'');
      accountOutcome(store,a,r.status);
      const m=measure(payload.messages,text,value?.usage),cost=costFor(store.data.prices,b.model,m.usage);
      store.record({keyId:null,accountId:a.id,model:b.model,endpoint:'admin_test_'+protocol,status:r.status,latencyMs:Date.now()-t,usage:m.usage,usageSource:m.source,...cost});
      if(!r.ok)return send(res,r.status,{ok:false,protocol,error:value.error||value,usage:m.usage,usageSource:m.source,latencyMs:Date.now()-t});
      const normalized=protocol==='responses'?fromChatResponse(value,b.model,m.usage):protocol==='anthropic'?chatToAnthropic(value,b.model,m.usage):value;
      const valid=protocol==='responses'?normalized?.object==='response'&&Array.isArray(normalized.output):protocol==='anthropic'?normalized?.type==='message'&&Array.isArray(normalized.content):Array.isArray(normalized.choices);
      return send(res,200,{ok:true,protocol,compatible:valid,reply:text,responseType:protocol==='responses'?'Responses':protocol==='anthropic'?'Anthropic Messages':'Chat Completions',usage:m.usage,usageSource:m.source,latencyMs:Date.now()-t});
    }
    if(pathname==='/console/api/prices/candidates' && req.method==='GET'){
      const model=u.searchParams.get('model')||'';
      if(!isPlainModel(model))return fail(res,400,'模型 ID 无效');
      const catalogue=pricingCache.data||await fetchPriceCatalog(pricingFetch);
      if(!pricingCache.data){pricingCache.data=catalogue;pricingCache.loadedAt=Date.now();}
      const results=priceCandidates(model,catalogue,6);
      return send(res,200,{model,source:'LiteLLM',candidates:results,notice:'模型候选由价格目录匹配，须手动确认型号和供应商；并非 139 实际账单'});
    }
    if(pathname==='/console/api/prices/sync' && req.method==='POST') {
      try{return send(res,200,{ok:true,...await syncPricing({force:true})});}
      catch(e){return fail(res,502,'无法同步参考价格：'+String(e.message||e).slice(0,160));}
    }
    const priceMapMatch=pathname.match(/^\/console\/api\/prices\/mapping\/([^/]+)$/);
    if(priceMapMatch && req.method==='PUT') {
      const model=decodeURIComponent(priceMapMatch[1]);
      const b=await parseBody(req,4096);
      if(!isPlainModel(model)||typeof b.referenceModelId!=='string'||b.referenceModelId.length>200)return fail(res,400,'价格映射无效');
      if(b.referenceModelId.trim())store.data.priceMappings[model]=b.referenceModelId.trim();
      else delete store.data.priceMappings[model];
      if(store.data.prices[model]?.source==='litellm_reference')delete store.data.prices[model];
      store.write();return send(res,200,{ok:true});
    }
    const priceMatch=pathname.match(/^\/console\/api\/prices\/([^/]+)$/);
    if(priceMatch && req.method==='DELETE'){
      const model=decodeURIComponent(priceMatch[1]);delete store.data.prices[model];store.write();return send(res,200,{ok:true});
    }
    if(priceMatch && req.method==='PUT'){
      const model=decodeURIComponent(priceMatch[1]);
      const b=await parseBody(req,4096);const inCost=Number(b.inputUsd),outCost=Number(b.outputUsd);
      if(!isPlainModel(model)||!Number.isFinite(inCost)||!Number.isFinite(outCost)||inCost<0||outCost<0||inCost>100000||outCost>100000)return fail(res,400,'每百万 Token 价格无效');
      store.data.prices[model]={inputUsd:inCost,outputUsd:outCost,source:'custom_reference',updatedAt:new Date().toISOString()};store.write();
      return send(res,200,{ok:true});
    }
    return fail(res,404,'Not found');
  }
  async function apiRoute(req,res,pathname){
    const auth=req.headers['x-api-key'];
    const anthropicWire=pathname.startsWith('/v1/messages');
    const apiFail=(status,message)=>anthropicWire?send(res,status,{type:'error',error:{type:status===401?'authentication_error':status===403?'permission_error':status===429?'rate_limit_error':status>=500?'api_error':'invalid_request_error',message}}):fail(res,status,message);
    const key=store.apiKey(parseBearer(req)||(pathname.startsWith('/v1/messages')&&typeof auth==='string'?auth:null));
    if(!key)return apiFail(401,'Invalid API key');
    if(pathname==='/v1/models' && req.method==='GET'){
      const accounts=store.data.accounts.filter(a=>a.enabled && (!a.managed||embedded.credentialsExist(a)) && !a.renewal?.requiresReauth && (store.accountHealth.get(a.id)?.until||0)<=Date.now());
      if(!accounts.length)return apiFail(503,'没有可用的 139 上游账号');
      const settled=await Promise.all(accounts.map(a=>getUpstreamModels(a).catch(()=>null)));
      const models=new Map();for(let i=0;i<settled.length;i++)for(const m of settled[i]||[])if(m?.id && (!key.models.length||key.models.includes(m.id)))models.set(m.id,m);
      if(!settled.some(Boolean))return apiFail(502,'全部上游模型列表获取失败');
      return send(res,200,{object:'list',data:[...models.values()]});
    }
    if(pathname==='/v1/messages/count_tokens' && req.method==='POST'){
      const body=await parseBody(req,2*1024*1024);
      const request=anthropicToChat({...body,max_tokens:Number.isInteger(body.max_tokens)?body.max_tokens:1,stream:false});
      const estimate=estimateTokens(request.messages)+estimateTokens(JSON.stringify(request.tools||[]));
      return send(res,200,{input_tokens:estimate},{'x-139-token-count':'estimated'});
    }
    if(req.method!=='POST' || !['/v1/chat/completions','/v1/responses','/v1/messages'].includes(pathname))return apiFail(404,'Not found');
    // Atomic within a Node.js event loop: reserve a daily quota slot before any await.
    const day=new Date().toISOString().slice(0,10);
    const dailyId=key.id+':'+day;
    const pending=dailyPending.get(dailyId)||0;
    const active=inFlight.get(key.id)||0;
    if(key.dailyLimit>0 && store.keyCallsToday(key.id)+pending>=key.dailyLimit)return apiFail(429,'API Key 今日请求限额已达到');
    if(active>=5)return apiFail(429,'当前 API Key 并发超限');
    dailyPending.set(dailyId,pending+1);
    inFlight.set(key.id,active+1);
    let selectedAccount=null;
    const clientAbort=new AbortController();
    res.once('close',()=>{if(!res.writableEnded)clientAbort.abort();});
    try{
      const body=await parseBody(req,12*1024*1024);
      const chat=pathname==='/v1/responses'?toChatRequest(body):pathname==='/v1/messages'?anthropicToChat(body):body;
      if(!isPlainModel(chat.model)||!Array.isArray(chat.messages))return apiFail(400,'model 或 messages 无效');
      if(key.models.length && !key.models.includes(chat.model))return apiFail(403,'此 Key 未获得该模型权限');
      const sessionHint=typeof req.headers['x-lgp-session-id']==='string' ? req.headers['x-lgp-session-id'].slice(0,128) : '';
      const upstreamSession=typeof req.headers['x-139-session-id']==='string' ? req.headers['x-139-session-id'].slice(0,128) : '';
      if(upstreamSession && !chat.session_id)chat.session_id=upstreamSession;
      const account=selectAccount(store,chat.model,(sessionHint||upstreamSession)?key.id+'|'+(sessionHint||upstreamSession):null);
      selectedAccount=account;
      store.accountActive.set(account.id,(store.accountActive.get(account.id)||0)+1);
      const start=Date.now();let recorded=false;
      const log=(status,reply,reported)=>{
        if(recorded)return;recorded=true;
        const m=measure(chat.messages,reply,reported);const c=costFor(store.data.prices,chat.model,m.usage);
        store.record({keyId:key.id,accountId:account.id,model:chat.model,endpoint:pathname,status,latencyMs:Date.now()-start,usage:m.usage,usageSource:m.source,...c});
      };
      try{
        const upstream=await fetchUpstream(account,'POST','/v1/chat/completions',chat,masterKey,900000,clientAbort.signal);
        if(!upstream.ok){
          const txt=await errText(upstream);log(upstream.status,'');accountOutcome(store,account,upstream.status);
          if(pathname==='/v1/messages'){
            let value;try{value=JSON.parse(txt);}catch{value={};}
            return apiFail(upstream.status,String(value.error?.message||value.error||'上游服务请求失败').slice(0,200));
          }
          res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json; charset=utf-8'});return res.end(txt);
        }
        if(chat.stream){
          return await relaySse(upstream,res,chat,pathname,log,status=>accountOutcome(store,account,status),clientAbort.signal);
        }
        const raw=await upstream.text();let result;
        try{result=JSON.parse(raw);}catch{log(502,'');accountOutcome(store,account,502);return apiFail(502,'上游响应不是有效 JSON');}
        validateUpstreamToolCalls(result,chat.tools||[]);
        const reply=textOf(result?.choices?.[0]?.message||'');
        const m=measure(chat.messages,reply,result?.usage);
        const converted=pathname==='/v1/responses'?fromChatResponse(result,chat.model,m.usage,chat.customToolNames):
          pathname==='/v1/messages'?chatToAnthropic(result,chat.model,m.usage):result;
        log(200,reply,result?.usage);
        accountOutcome(store,account,200);
        return send(res,200,converted);
      } catch(e){
        if(clientAbort.signal.aborted){log(499,'');return;}
        log(502,'');accountOutcome(store,account,502);
        if(!res.headersSent)return apiFail(502,'连接上游失败: '+String(e.message||e).slice(0,200));
        if(!res.writableEnded)res.end();
      }
    } finally {
      const remaining=(dailyPending.get(dailyId)||1)-1;
      if(remaining>0)dailyPending.set(dailyId,remaining);else dailyPending.delete(dailyId);
      const activeNow=(inFlight.get(key.id)||1)-1;
      if(activeNow>0)inFlight.set(key.id,activeNow);else inFlight.delete(key.id);
      if(selectedAccount){
        const remainingAccount=(store.accountActive.get(selectedAccount.id)||1)-1;
        if(remainingAccount>0)store.accountActive.set(selectedAccount.id,remainingAccount);else store.accountActive.delete(selectedAccount.id);
      }
    }
  }
  server.on('close',()=>{if(pricingTimer)clearInterval(pricingTimer);if(startupPriceTimer)clearTimeout(startupPriceTimer);embedded.stopAll();});
  return {server,store,embedded,syncPricing};
}

async function relaySse(upstream,res,chat,endpoint,log,onAccountOutcome=()=>{},clientSignal=null){
  const isResponses=endpoint==='/v1/responses';
  const isAnthropic=endpoint==='/v1/messages';
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  let content='',reported=null,buffer='',finish=false,sequence=0,lastFinishReason=null;
  const decoder=new TextDecoder('utf-8');
  const rid=newResponseId(),output=[];
  const event=(kind,extra)=>res.write(`event: ${kind}\ndata: ${JSON.stringify({type:kind,sequence_number:++sequence,...extra})}\n\n`);
  const anthro=isAnthropic?createAnthropicStream(res,chat.model,chat.tools||[]):null;
  const calls=new Map();
  let textItem=null;
  const beginText=()=>{
    if(textItem)return;
    textItem={id:'msg_'+randomUUID().replaceAll('-',''),output_index:output.length};
    output.push({id:textItem.id,type:'message',status:'in_progress',role:'assistant',content:[]});
    event('response.output_item.added',{output_index:textItem.output_index,item:output.at(-1)});
    event('response.content_part.added',{output_index:textItem.output_index,item_id:textItem.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  };
  const beginCall=call=>{
    if(call.output_index!==undefined||!call.name)return;
    call.output_index=output.length;
    call.call_id=call.call_id||'call_'+randomUUID().replaceAll('-','');
    call.isCustom=Boolean(chat.customToolNames?.has(call.name));
    call.item_id=(call.isCustom?'ctc_':'fc_')+randomUUID().replaceAll('-','');
    output.push(call.isCustom?{id:call.item_id,type:'custom_tool_call',status:'in_progress',call_id:call.call_id,name:call.name,input:''}:
      {id:call.item_id,type:'function_call',status:'in_progress',call_id:call.call_id,name:call.name,arguments:''});
    event('response.output_item.added',{output_index:call.output_index,item:{...output.at(-1)}});
    if(call.args && !call.isCustom){event('response.function_call_arguments.delta',{output_index:call.output_index,item_id:call.item_id,call_id:call.call_id,delta:call.args});call.sent=call.args.length;}
  };
  if(isResponses){
    event('response.created',{response:{id:rid,object:'response',status:'in_progress',model:chat.model,created_at:Math.floor(Date.now()/1000),output:[]}});
  }
  const consume=line=>{
    if(!line.startsWith('data:'))return;
    const payload=line.slice(5).trim();
    if(payload==='[DONE]'){finish=true;return;}
    let data;try{data=JSON.parse(payload);}catch{return;}
    if(data?.error)throw new Error('上游流式返回错误: '+String(data.error?.message||data.error).slice(0,160));
    const d=data?.choices?.[0]?.delta;
    if(isAnthropic){anthro.accept(data);content=anthro.content;}
    const segment=typeof d?.content==='string'?d.content:'';
    if(segment && !isAnthropic){
      content+=segment;
      if(isResponses){beginText();event('response.output_text.delta',{output_index:textItem.output_index,item_id:textItem.id,content_index:0,delta:segment});}
    }
    if(isResponses && Array.isArray(d?.tool_calls))for(const c of d.tool_calls){
      if(!chat.tools?.length)throw new Error('上游产生未授权的工具调用');
      const idx=Number.isInteger(c.index)?c.index:0;
      let call=calls.get(idx);
      if(!call){call={name:'',call_id:null,args:'',sent:0};calls.set(idx,call);}
      if(typeof c.id==='string' && !call.call_id)call.call_id=c.id;
      if(typeof c.function?.name==='string')call.name+=c.function.name;
      if(typeof c.function?.arguments==='string')call.args+=c.function.arguments;
      beginCall(call);
      if(call.output_index!==undefined && !call.isCustom && call.args.length>call.sent){
        event('response.function_call_arguments.delta',{output_index:call.output_index,item_id:call.item_id,call_id:call.call_id,delta:call.args.slice(call.sent)});
        call.sent=call.args.length;
      }
    }
    if(data.usage)reported=data.usage;
    if(typeof data?.choices?.[0]?.finish_reason==='string')lastFinishReason=data.choices[0].finish_reason;
  };
  try{
    for await(const bytes of upstream.body){
      const chunk=decoder.decode(bytes,{stream:true});
      if(!isResponses && !isAnthropic)res.write(chunk);
      buffer=(buffer+chunk).replaceAll('\r\n','\n');
      let ix;
      while((ix=buffer.indexOf('\n\n'))!==-1){const frame=buffer.slice(0,ix);buffer=buffer.slice(ix+2);for(const line of frame.split('\n'))consume(line);}
    }
    const rest=decoder.decode();
    if(rest){if(!isResponses && !isAnthropic)res.write(rest);buffer+=rest;}
    if(buffer)for(const line of buffer.split('\n'))consume(line);
    if(!finish)throw new Error('上游流式响应意外结束（缺少 [DONE]）');
    if(isResponses){
      if(textItem){
        event('response.output_text.done',{output_index:textItem.output_index,item_id:textItem.id,content_index:0,text:content});
        event('response.content_part.done',{output_index:textItem.output_index,item_id:textItem.id,content_index:0,part:{type:'output_text',text:content,annotations:[]}});
        const item=messageItem(content);item.id=textItem.id;output[textItem.output_index]=item;
        event('response.output_item.done',{output_index:textItem.output_index,item});
      }
      for(const call of [...calls.values()].sort((a,b)=>a.output_index-b.output_index)){
        if(!call.name||call.output_index===undefined)throw new Error('上游工具调用缺少函数名');
        if(!chat.tools?.some(t=>t.function?.name===call.name))throw new Error('上游返回的函数未在请求中声明');
        try{JSON.parse(call.args);}catch{throw new Error('上游工具调用参数不是有效 JSON');}
        const item=toolCallItem({id:call.call_id,function:{name:call.name,arguments:call.args}},chat.customToolNames);item.id=call.item_id;
        if(call.isCustom){
          event('response.custom_tool_call_input.delta',{output_index:call.output_index,item_id:call.item_id,call_id:call.call_id,delta:item.input});
          event('response.custom_tool_call_input.done',{output_index:call.output_index,item_id:call.item_id,call_id:call.call_id,input:item.input});
        }else{
          event('response.function_call_arguments.done',{output_index:call.output_index,item_id:call.item_id,call_id:call.call_id,name:call.name,arguments:call.args});
        }
        output[call.output_index]=item;
        event('response.output_item.done',{output_index:call.output_index,item});
      }
      if(!output.length)output.push(messageItem(''));
      const m=measure(chat.messages,content,reported);
      const response=makeResponse(chat.model,content,m.usage,rid);response.output=output;
      log(200,content,reported);onAccountOutcome(200);
      event('response.completed',{response});
    }else{
      if(isAnthropic){
        const m=measure(chat.messages,content,reported);
        const finishReason=lastFinishReason||'stop';
        anthro.finish(m.usage,finishReason);
      }
      log(200,content,reported);onAccountOutcome(200);
    }
    return res.end();
  }catch(e){
    if(clientSignal?.aborted){log(499,content,reported);return;}
    log(502,content,reported);onAccountOutcome(502);
    if(res.destroyed)return;
    if(isResponses){event('response.failed',{response:{id:rid,object:'response',status:'failed',model:chat.model,output:[],error:{code:'upstream_stream_error',message:'上游工具或流式响应异常'}}});event('error',{error:{type:'upstream_error',message:'上游工具或流式响应异常'}});}
    else if(isAnthropic)anthro.fail();
    else res.write(`data: ${JSON.stringify({error:{message:'上游流式响应中断，未完成请求',type:'upstream_error'}})}\n\n`);
    return res.end();
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const HOST=process.env.HOST||'127.0.0.1',PORT=Number(process.env.PORT||8323);
  const gw=createGateway({dataDir:process.env.DATA_DIR||path.join(process.cwd(),'data'),masterKey:process.env.MASTER_KEY,cookieSecure:process.env.COOKIE_SECURE!=='0'});
  gw.server.listen(PORT,HOST,async()=>{console.log(`[novarelay] http://${HOST}:${PORT} admin=/console`); await gw.embedded.startAll();});
  for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>gw.server.close(()=>process.exit(0)));
}
