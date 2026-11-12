import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {createGateway} from '../server.mjs';
import {measure,costFor} from '../lib/meter.mjs';
import {applyCatalog,findCatalogMatch,fetchPriceCatalog} from '../lib/pricing.mjs';
process.env.PRICE_AUTO_SYNC='0';
import {encryptSecret,decryptSecret,permittedUpstream} from '../lib/security.mjs';
import {Store} from '../lib/storage.mjs';
import {EmbeddedAccounts} from '../lib/embedded.mjs';
import {createRenewalNotifier} from '../lib/alerts.mjs';
import {updateInfo} from '../lib/updater.mjs';

const MASTER='a'.repeat(64);
const listen=srv=>new Promise(resolve=>srv.listen(0,'127.0.0.1',()=>resolve(srv.address().port)));
const close=srv=>new Promise(resolve=>srv.close(resolve));
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
function upstream(){return http.createServer(async(req,res)=>{
  if(req.url==='/healthz')return json(res,200,{ok:true,token_cached:true,token_expiry:'2026-12-12T16:00:00Z',credentials:{sid:true,cookie:true}});
  if(req.headers.authorization!=='Bearer upstream-secret')return json(res,401,{error:'invalid upstream key'});
  if(req.method==='GET'&&req.url==='/v1/models')return json(res,200,{object:'list',data:[{id:'blian_qwen38_flash',object:'model',owned_by:'mock'}]});
  if(req.method==='POST'&&req.url==='/v1/chat/completions'){
    let body='';for await(const chunk of req)body+=chunk;
    const payload=JSON.parse(body);
    if(payload.stream){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('data: '+JSON.stringify({choices:[{delta:{content:'你'}}]})+'\n\n');
      res.write('data: '+JSON.stringify({choices:[{delta:{content:'好'}}]})+'\n\n');
      res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+'\n\n');
      return res.end('data: [DONE]\n\n');
    }
    return json(res,200,{id:'chatcmpl-x',object:'chat.completion',model:payload.model,choices:[{index:0,message:{role:'assistant',content:'你好'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
  }
  return json(res,404,{error:'not found'});
});}
async function testSetup(t,{pricingFetch}={}){
  process.env.LINGXI_ENGINE_PATH=path.resolve('test/mock-engine.mjs');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lingxi-native-test-'));
  const up=upstream();const upPort=await listen(up);
  const {server,store}=createGateway({dataDir:tmp,masterKey:MASTER,cookieSecure:false,pricingFetch});
  store.setAdmin('safe_password_for_tests');
  const port=await listen(server);
  t.after(async()=>{await close(server);await close(up);fs.rmSync(tmp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  const login=await fetch(base+'/console/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'safe_password_for_tests'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const session=await (await fetch(base+'/console/api/session',{headers:{cookie}})).json();
  const admin=async(endpoint,method='GET',body)=>{
    const r=await fetch(base+'/console/api/'+endpoint,{method,headers:{cookie,'X-CSRF-Token':session.csrf,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return [r,await r.json()];
  };
  return {base,admin,upPort,store,login,cookie,session};
}

test('cryptography, SSRF guard and usage calculation',()=>{
  const value=encryptSecret('upstream-secret',MASTER);assert.equal(decryptSecret(value,MASTER),'upstream-secret');
  assert.equal(permittedUpstream('http://127.0.0.1:8317/'),true);
  for(const url of ['https://evil.example/','http://192.168.1.1:8317/','http://127.0.0.1:8317/admin','http://127.0.0.1:8317/?x=1'])assert.equal(permittedUpstream(url),false,url);
  const m=measure([{role:'user',content:'hi'}],'你好',{prompt_tokens:100,completion_tokens:50});assert.equal(m.source,'estimated_upstream');
  assert.equal(costFor({m:{inputUsd:1,outputUsd:2}},'m',m.usage).costUsd,0.0002);
});

test('login, CSRF, accounts, keys, models, chat and responses',async t=>{
  const x=await testSetup(t);
  const invalid=await fetch(x.base+'/console/api/keys',{method:'POST',headers:{cookie:x.cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'bad'})});
  assert.equal(invalid.status,403);
  let [ar,a]=await x.admin('accounts','POST',{name:'139 主账号',sid:'SID-TEST-001',cookie:'RMKEY=TEST1; Os_SSo_Sid=MOCK'});assert.equal(ar.status,201);assert.ok(a.id);assert.equal(a.connected,true);
  const accId=a.id;
  let [editR,edit]=await x.admin('accounts/'+accId,'PATCH',{name:'工作账号',models:['blian_qwen38_flash']});
  assert.equal(editR.status,200);assert.equal(edit.ok,true);
  [editR,edit]=await x.admin('state');assert.equal(edit.accounts[0].name,'工作账号');assert.equal(edit.accounts[0].managed,true);assert.deepEqual(edit.accounts[0].models,['blian_qwen38_flash']);
  [ar,a]=await x.admin('accounts/'+accId+'/check','POST',{});assert.equal(ar.status,200);assert.equal(a.token_cached,true);
  const [renewRes,renew]=await x.admin('accounts/'+accId+'/renew','POST',{});assert.equal(renewRes.status,200);assert.equal(renew.ok,true);
  const [pr]=await x.admin('prices/blian_qwen38_flash','PUT',{inputUsd:1,outputUsd:2});assert.equal(pr.status,200);
  let [kr,k]=await x.admin('keys','POST',{name:'ShiRide',dailyLimit:0,models:[]});assert.equal(kr.status,201);assert.match(k.key,/^sk-mb-/);
  const bad=await fetch(x.base+'/v1/models');assert.equal(bad.status,401);
  const headers={Authorization:`Bearer ${k.key}`,'Content-Type':'application/json'};
  let r=await fetch(x.base+'/v1/models',{headers});let out=await r.json();assert.equal(r.status,200);assert.equal(out.data[0].id,'blian_qwen38_flash');
  r=await fetch(x.base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'hi'}],stream:false})});out=await r.json();assert.equal(r.status,200);assert.equal(out.choices[0].message.content,'你好');
  r=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',input:'hi',stream:false})});out=await r.json();assert.equal(r.status,200);assert.equal(out.object,'response');assert.equal(out.output[0].content[0].text,'你好');
  r=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',input:'hi',stream:true})});const stream=await r.text();assert.equal(r.status,200);assert.match(stream,/response\.output_text\.delta/);assert.match(stream,/response\.completed/);
  r=await fetch(x.base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'hi'}],stream:true})});const raw=await r.text();assert.match(raw,/data: \[DONE\]/);assert.match(raw,/"content":"你"/);
  const [sr,s]=await x.admin('state');assert.equal(sr.status,200);assert.equal(s.accounts[0].status,'connected');assert.equal(s.usage.requests,4);assert.equal(s.usage.input,40);assert.equal(s.usage.output,8);assert.equal(s.accounts.length,1);assert.equal(s.keys.length,1);assert.ok(s.requests.every(x=>x.usageSource==='estimated_upstream'));assert.equal(s.keys[0].hash,undefined);
  assert.equal(Number(s.usage.estimatedCost.toFixed(8)),0.000056);
  // Reject unsupported stateful Responses semantics rather than pretending full support.
  r=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',input:'hi',previous_response_id:'resp_123'})});assert.equal(r.status,400);
  [kr]=await x.admin('keys/'+k.entry.id,'PATCH',{enabled:false});assert.equal(kr.status,200);
  r=await fetch(x.base+'/v1/models',{headers});assert.equal(r.status,401);
});


test('embedded accounts store independent login state and never require legacy gateway URLs',async t=>{
  const x=await testSetup(t);
  let [r,a]=await x.admin('accounts','POST',{name:'账号 A'});
  assert.equal(r.status,201);assert.equal(a.connected,false);assert.equal(a.url,undefined);
  const accountA=a;
  [r,a]=await x.admin('accounts/'+accountA.id+'/check','POST',{});assert.equal(a.status,'unconnected');
  [r,a]=await x.admin('accounts','POST',{name:'账号 B',sid:'sid-B',cookie:'RMKEY=secretB'});
  assert.equal(r.status,201);assert.equal(a.connected,true);
  const accountB=a;
  [r,a]=await x.admin('accounts/'+accountA.id+'/connect','POST',{sid:'sid-A',cookie:'RMKEY=secretA'});
  assert.equal(r.status,200);assert.equal(a.ok,true);
  const credsA=JSON.parse(fs.readFileSync(path.join(x.store.dir,'accounts',accountA.id,'credentials.json')));
  const credsB=JSON.parse(fs.readFileSync(path.join(x.store.dir,'accounts',accountB.id,'credentials.json')));
  assert.equal(credsA.sid,'sid-A');assert.equal(credsB.sid,'sid-B');
  assert.notEqual(credsA.cookie,credsB.cookie);
  [r,a]=await x.admin('state');
  assert.equal(a.accounts.length,2);assert.ok(a.accounts.every(x=>x.status==='connected'));
  [r,a]=await x.admin('accounts/'+accountB.id,'DELETE',{});assert.equal(r.status,200);
  assert.equal(fs.existsSync(path.join(x.store.dir,'accounts',accountB.id)),false);
  assert.equal(fs.existsSync(path.join(x.store.dir,'accounts',accountA.id,'credentials.json')),true);
});

test('8-character admin password works; shorter passwords rejected',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lingxi-eight-'));
  try {const {Store}=await import('../lib/storage.mjs');const store=new Store(tmp);assert.throws(()=>store.setAdmin('1234567'));store.setAdmin('X6yd_4tQ');assert.equal(store.hasAdmin(),true);}finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('LiteLLM auto pricing: strict match, manual mapping, overrides and unknown models',()=>{
  const catalog={
    'dashscope/qwen-plus':{input_cost_per_token:0.000001,output_cost_per_token:0.000002},
    'vendor-a/qwen3.8-flash':{input_cost_per_token:0.000003,output_cost_per_token:0.000004},
    'vendor-b/qwen3.8-flash':{input_cost_per_token:0.000006,output_cost_per_token:0.000007},
  };
  const models=[{id:'blian_qwen38_flash',display_name:'qwen3.8-flash'}, {id:'dashscope/qwen-plus'}, {id:'unlisted'}];
  const state={prices:{},priceMappings:{}};
  let r=applyCatalog(state,models,catalog);
  assert.equal(r.matched,1);assert.deepEqual(r.unmatched,['blian_qwen38_flash','unlisted']);
  assert.equal(state.prices['dashscope/qwen-plus'].inputUsd,1);
  // Ambiguous provider names must not be assigned a random price.
  assert.equal(findCatalogMatch(models[0],catalog),null);
  state.priceMappings.blian_qwen38_flash='vendor-a/qwen3.8-flash';
  r=applyCatalog(state,models,catalog);assert.equal(r.matched,2);
  assert.equal(state.prices.blian_qwen38_flash.outputUsd,4);
  state.prices.blian_qwen38_flash={inputUsd:12,outputUsd:18,source:'custom_reference'};
  r=applyCatalog(state,models,catalog);assert.equal(state.prices.blian_qwen38_flash.inputUsd,12);
  assert.equal(r.skippedCustom,1);
});

test('price sync endpoint fetches catalogue but never invents an unmatched price',async t=>{
  const prices={
    'dashscope/qwen-plus':{input_cost_per_token:0.000001,output_cost_per_token:0.000002},
    'vendor-a/qwen3.8-flash':{input_cost_per_token:0.000003,output_cost_per_token:0.000004},
    'vendor-b/qwen3.8-flash':{input_cost_per_token:0.000006,output_cost_per_token:0.000007},
    ...Object.fromEntries(Array.from({length:12},(_,i)=>['other-'+i,{input_cost_per_token:0.000001,output_cost_per_token:0.000002}]))
  };
  const fetchPricing=async()=>({ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(prices)});
  const x=await testSetup(t,{pricingFetch:fetchPricing});
  const [ar,account]=await x.admin('accounts','POST',{name:'139 账号',sid:'sid-price',cookie:'RMKEY=mock'});
  assert.equal(ar.status,201);assert.equal(account.connected,true);
  let [r,j]=await x.admin('prices/sync','POST',{});assert.equal(r.status,200);assert.equal(j.matched,0);
  [r,j]=await x.admin('state');assert.equal(j.priceSync.status,'ok');assert.deepEqual(j.priceSync.unmatched,['blian_qwen38_flash']);
  [r,j]=await x.admin('prices/mapping/blian_qwen38_flash','PUT',{referenceModelId:'vendor-a/qwen3.8-flash'});assert.equal(r.status,200);
  [r,j]=await x.admin('prices/sync','POST',{});assert.equal(j.matched,1);
  [r,j]=await x.admin('state');assert.equal(j.prices.blian_qwen38_flash.inputUsd,3);
  [r,j]=await x.admin('prices/blian_qwen38_flash','PUT',{inputUsd:6,outputUsd:11});assert.equal(r.status,200);
  [r,j]=await x.admin('prices/sync','POST',{});assert.equal(j.skippedCustom,1);
  [r,j]=await x.admin('state');assert.equal(j.prices.blian_qwen38_flash.inputUsd,6);
  [r,j]=await x.admin('prices/blian_qwen38_flash','DELETE',{});assert.equal(r.status,200);
  [r,j]=await x.admin('prices/sync','POST',{});assert.equal(j.matched,1);
});

test('API key rotation never reveals old hash and revokes the old secret',async t=>{
  const x=await testSetup(t);
  let [r,k]=await x.admin('keys','POST',{name:'my-client',models:[],dailyLimit:20});
  assert.equal(r.status,201); const old=k.key, id=k.entry.id;
  [r,k]=await x.admin('keys/'+id+'/rotate','POST',{password:'wrong'});assert.equal(r.status,403);
  [r,k]=await x.admin('keys/'+id+'/rotate','POST',{password:'safe_password_for_tests'});
  assert.equal(r.status,200);assert.match(k.key,/^sk-mb-/);assert.notEqual(k.key,old);
  [r,k]=await x.admin('state');assert.equal(k.keys[0].dailyLimit,20);assert.equal(k.keys[0].hash,undefined);assert.equal(k.keys[0].name,'my-client');
  let reply=await fetch(x.base+'/v1/models',{headers:{Authorization:'Bearer '+old}});assert.equal(reply.status,401);
  assert.ok(x.store.apiKey((await x.admin('keys','POST',{name:'other',models:[],dailyLimit:0}))[1].key));
});

test('Anthropic Messages text and streamed response via x-api-key',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'account',sid:'a-id',cookie:'RMKEY=ok'});
  const [r,k]=await x.admin('keys','POST',{name:'anthropic',dailyLimit:0,models:[]});assert.equal(r.status,201);
  const headers={'x-api-key':k.key,'anthropic-version':'2023-06-01','content-type':'application/json'};
  const payload={model:'blian_qwen38_flash',max_tokens:100,messages:[{role:'user',content:'你好'}]};
  let resp=await fetch(x.base+'/v1/messages',{method:'POST',headers,body:JSON.stringify(payload)});
  let body=await resp.json();assert.equal(resp.status,200);assert.equal(body.type,'message');assert.equal(body.role,'assistant');assert.equal(body.content[0].text,'你好');assert.equal(body.stop_reason,'end_turn');assert.equal(body.usage.input_tokens,10);
  resp=await fetch(x.base+'/v1/messages',{method:'POST',headers,body:JSON.stringify({...payload,stream:true})});
  const raw=await resp.text();assert.equal(resp.status,200);assert.match(raw,/event: message_start/);assert.match(raw,/event: content_block_delta/);assert.match(raw,/event: message_stop/);
  resp=await fetch(x.base+'/v1/messages',{method:'POST',headers,body:JSON.stringify({...payload,stream:true,tools:[{name:'time',input_schema:{type:'object'}}]})});assert.equal(resp.status,200);assert.match(await resp.text(),/event: message_stop/);
});

test('Anthropic conversion maps tool_use and tool_result explicitly',async()=>{
  const {anthropicToChat,chatToAnthropic}=await import('../lib/anthropic.mjs');
  const a=anthropicToChat({model:'m',max_tokens:100,stream:false,system:'system text',tools:[{name:'add',input_schema:{type:'object'}}],messages:[
    {role:'user',content:'add numbers'},
    {role:'assistant',content:[{type:'tool_use',id:'toolu_123',name:'add',input:{a:1,b:2}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_123',content:'3'}]}
  ]});
  assert.equal(a.tools[0].function.name,'add');assert.equal(a.messages[1].role,'user');assert.equal(a.messages[2].tool_calls[0].function.name,'add');assert.equal(a.messages[3].role,'tool');
  const o=chatToAnthropic({model:'m',choices:[{message:{content:null,tool_calls:[{id:'toolu_test',function:{name:'add',arguments:'{"a":1,"b":2}'}}]}}]},'m',{prompt_tokens:10,completion_tokens:12});
  assert.equal(o.content[0].type,'tool_use');assert.equal(o.content[0].input.b,2);assert.equal(o.stop_reason,'tool_use');
});

test('catalog candidates are advisory and do not auto-assign costs',async()=>{
  const {priceCandidates}=await import('../lib/pricing.mjs');
  const c={'vendor-a/qwen3.8-flash':{input_cost_per_token:.000003,output_cost_per_token:.000005},'vendor-b/qwen3.8-flash':{input_cost_per_token:.000004,output_cost_per_token:.000006}};
  const hits=priceCandidates('blian_qwen38_flash',c);assert.equal(hits.length,2);
  assert.equal(hits[0].match,'name_equal');assert.equal(hits[0].inputUsd,3);
});

test('updater request requires host agent marker; it only writes a fixed action',async t=>{
  const x=await testSetup(t);
  let [resp,value]=await x.admin('updates/apply','POST',{});assert.equal(resp.status,503);
  const file=path.join(x.store.dir,'host-updater-enabled');fs.writeFileSync(file,'');
  [resp,value]=await x.admin('updates/apply','POST',{});assert.equal(resp.status,202);assert.equal(value.queued,true);
  const req=JSON.parse(fs.readFileSync(path.join(x.store.dir,'update-request.json'),'utf8'));
  assert.equal(req.action,'update_main');assert.deepEqual(Object.keys(req).sort(),['action','id','requestedAt']);
  [resp,value]=await x.admin('updates/apply','POST',{});assert.equal(resp.status,409);
});


test('last daily quota slot is reserved before concurrent requests (and not bypassed by pruning)',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'account',sid:'sid-regular',cookie:'RMKEY=ok'});
  const [kr,k]=await x.admin('keys','POST',{name:'last-slot',dailyLimit:1,models:[]});
  assert.equal(kr.status,201);
  const headers={Authorization:'Bearer '+k.key,'Content-Type':'application/json'};
  const request=()=>fetch(x.base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'__delay__'}],stream:false})});
  const responses=await Promise.all([request(),request()]);
  assert.deepEqual(responses.map(x=>x.status).sort(),[200,429]);
  assert.equal(x.store.keyCallsToday(k.entry.id),1);
  const third=await request();assert.equal(third.status,429);
  // Billing/quotas survive log ring buffer pruning.
  x.store.data.requests=[];x.store.write();
  assert.equal(x.store.keyCallsToday(k.entry.id),1);
});

test('concurrent cap reserves all five active slots before awaiting upstream',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'account',sid:'sid-regular',cookie:'RMKEY=ok'});
  const [kr,k]=await x.admin('keys','POST',{name:'burst',dailyLimit:0,models:[]});assert.equal(kr.status,201);
  const headers={Authorization:'Bearer '+k.key,'Content-Type':'application/json'};
  const results=await Promise.all(Array.from({length:7},()=>fetch(x.base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'__delay__'}],stream:false})})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,200,200,200,200,429,429]);
});

test('unhealthy account is quarantined and subsequent requests select a healthy account',async t=>{
  const x=await testSetup(t);
  const [r,a]=await x.admin('accounts','POST',{name:'bad',sid:'FAIL-account',cookie:'RMKEY=ok'});assert.equal(r.status,201);
  await x.admin('accounts','POST',{name:'healthy',sid:'sid-healthy',cookie:'RMKEY=ok'});
  const [kr,k]=await x.admin('keys','POST',{name:'consumer',dailyLimit:0,models:[]});assert.equal(kr.status,201);
  const headers={Authorization:'Bearer '+k.key,'Content-Type':'application/json'};
  const request=()=>fetch(x.base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'hi'}],stream:false})});
  const first=await request();assert.equal(first.status,503);
  assert.ok(x.store.accountHealth.get(a.id).until>Date.now());
  const second=await request();assert.equal(second.status,200);
  const third=await request();assert.equal(third.status,200);
  const [st,state]=await x.admin('state');assert.equal(st.status,200);
  assert.equal(state.accounts[0].circuitBreaker.lastStatus,503);
  assert.equal(state.requests[0].status,200);
});

test('premature upstream SSE close emits a protocol error and is recorded as failed',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'account',sid:'sid-regular',cookie:'RMKEY=ok'});
  const [kr,k]=await x.admin('keys','POST',{name:'stream',dailyLimit:0,models:[]});assert.equal(kr.status,201);
  const headers={Authorization:'Bearer '+k.key,'Content-Type':'application/json'};
  let response=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',input:'__truncate__',stream:true})});
  let text=await response.text();assert.equal(response.status,200);assert.match(text,/event: error/);assert.doesNotMatch(text,/response\.completed/);
  assert.equal(x.store.data.requests.at(-1).status,502);
  x.store.accountHealth.clear();
  response=await fetch(x.base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'__sse_error__'}],stream:true})});
  text=await response.text();assert.match(text, /上游流式响应中断/);assert.doesNotMatch(text,/data: \[DONE\]/);
  assert.equal(x.store.data.requests.at(-1).status,502);
  x.store.accountHealth.clear();
  response=await fetch(x.base+'/v1/messages',{method:'POST',headers:{'x-api-key':k.key,'content-type':'application/json'},body:JSON.stringify({model:'blian_qwen38_flash',max_tokens:100,messages:[{role:'user',content:'__truncate__'}],stream:true})});
  text=await response.text();assert.match(text,/event: error/);assert.doesNotMatch(text,/event: message_stop/);
  assert.equal(x.store.data.requests.at(-1).status,502);
});


test('v0.4.1 log migration keeps key quotas and records across process restart',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'novarelay-log-migrate-'));
  try{
    const time=new Date().toISOString();const day=time.slice(0,10);
    const row={id:'legacy1',time,keyId:'old-key',accountId:'a',model:'m',endpoint:'/v1/chat/completions',status:200,latencyMs:8,usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5},usageSource:'upstream',costUsd:0.0001};
    fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({version:1,admin:null,keys:[],accounts:[],prices:{},requests:[row],sessions:[],dailyKeyCounts:{[day]:{'old-key':4}}}));
    let store=new Store(dir);
    assert.equal(store.keyCallsToday('old-key'),4); // 3 already pruned old requests retain daily quota
    assert.equal(store.data.requests[0].usageSource,'estimated_upstream');
    assert.equal(store.overview().usage.requests,1);
    store.record({...row,usageSource:'estimated_local'});
    assert.equal(store.keyCallsToday('old-key'),5);
    assert.ok(fs.statSync(path.join(dir,'state.json')).size<3000,'Do not rewrite a huge state.json per request');
    assert.equal(fs.readFileSync(path.join(dir,'logs',day+'.jsonl'),'utf8').trim().split('\n').length,2);
    store=new Store(dir);
    assert.equal(store.keyCallsToday('old-key'),5);
    assert.equal(store.overview().usage.requests,2);
    assert.equal(store.overview().byDay[0].tokens,10);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('139 renewal alerts are deduplicated, show recovery and never include credentials',async()=>{
  const calls=[];
  const notifier=createRenewalNotifier({token:'123456:'+ 'A'.repeat(32),chatId:'12345678',fetchFn:async(url,opts)=>{calls.push({url,data:JSON.parse(opts.body)});return {ok:true};}});
  assert.equal(notifier.enabled,true);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'novarelay-renewal-alerts-'));
  try{
    const store=new Store(temp),account=store.addAccount({name:'139 Test',managed:true});
    const embedded=new EmbeddedAccounts({store,dataDir:temp,masterKey:MASTER,notifier});
    embedded.recordRenewal(account,false,'SID expired');
    embedded.recordRenewal(account,false,'SID expired again');
    embedded.recordRenewal(account,true);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls.length,2);assert.equal(store.data.accounts[0].renewal.requiresReauth,false);
    assert.match(calls[0].data.text,/需要重新授权/);
    assert.ok(calls.every(c=>!c.data.text.includes('RMKEY')&&!c.data.text.includes('secret')));
    assert.ok(calls.every(c=>c.url.startsWith('https://api.telegram.org/')));
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('admin model tester validates chat, Responses and Anthropic text compatibility',async t=>{
  const x=await testSetup(t);
  const [ar,a]=await x.admin('accounts','POST',{name:'compat',sid:'compat-id',cookie:'RMKEY=ok'});assert.equal(ar.status,201);
  for(const protocol of ['chat','responses','anthropic']){
    const [r,body]=await x.admin('test','POST',{accountId:a.id,model:'blian_qwen38_flash',prompt:'你好',protocol});
    assert.equal(r.status,200,protocol);assert.equal(body.compatible,true);assert.equal(body.reply,'你好');assert.equal(body.protocol,protocol);
  }
  const [bad]=await x.admin('test','POST',{accountId:a.id,model:'blian_qwen38_flash',prompt:'你好',protocol:'unknown'});
  assert.equal(bad.status,400);
});

test('updater exposes target release metadata, restart phase and backup-friendly source checks',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'novarelay-update-info-'));
  try{
    const sha='f'.repeat(40);fs.writeFileSync(path.join(temp,'deployed-version.json'),JSON.stringify({sha:'a'.repeat(40),version:'0.4.1'}));
    fs.writeFileSync(path.join(temp,'host-updater-enabled'),'');
    fs.writeFileSync(path.join(temp,'update-status.json'),JSON.stringify({state:'running',progress:70,step:'restart',message:'正在重启',updatedAt:new Date().toISOString()}));
    const mock=async u=>({ok:true,json:async()=>u.includes('commits/main')?{sha,commit:{committer:{date:'2026-11-13T00:00:00Z'}}}:{version:'0.5.0',title:'稳定更新',notes:['自动备份','可靠回滚']}});
    const r=await updateInfo(temp,{remote:true,fetchFn:mock});
    assert.equal(r.installedVersion,'1.0.0');assert.equal(r.latestVersion,'0.5.0');assert.equal(r.latestNotes.length,2);
    assert.equal(r.status.progress,70);assert.equal(r.pending,true);assert.equal(r.updateAvailable,true);
    const dockerfile=fs.readFileSync(path.resolve('Dockerfile'),'utf8');assert.match(dockerfile,/chmod -R a\+rX/);assert.match(dockerfile,/su app/);
    const updater=fs.readFileSync(path.resolve('scripts/host-update.sh'),'utf8');
    for(const term of ['backup_complete','rollback','check_health','tar -czf','git merge --ff-only'])assert.ok(updater.includes(term),term);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('Responses function tools map to Chat and support stateless tool-result replay',async t=>{
  const {toChatRequest}=await import('../lib/responses.mjs');
  const tool={type:'function',name:'get_weather',description:'Get weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}};
  const request={model:'blian_qwen38_flash',input:'__invoke_tool__',tools:[tool],tool_choice:'required'};
  const mapped=toChatRequest(request);
  assert.equal(mapped.tools[0].function.name,'get_weather');
  assert.equal(mapped.tool_choice,'required');
  assert.throws(()=>toChatRequest({...request,tools:[{type:'web_search'}]}),/暂不支持.*内置工具/);
  assert.throws(()=>toChatRequest({...request,previous_response_id:'resp_123'}),/previous_response_id/);
  assert.throws(()=>toChatRequest({...request,input:[{type:'function_call_output',call_id:'unknown',output:'12'}]}),/function_call_output/);
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'test-139',sid:'sid-001',cookie:'RMKEY=mock'});
  const [r,k]=await x.admin('keys','POST',{name:'fuyou',dailyLimit:0,models:[]});assert.equal(r.status,201);
  const headers={Authorization:'Bearer '+k.key,'Content-Type':'application/json'};
  let resp=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify(request)});
  let data=await resp.json();assert.equal(resp.status,200);
  assert.equal(data.output[0].type,'function_call');
  assert.equal(data.output[0].name,'get_weather');
  assert.equal(data.output[0].call_id,'call_mock_weather');
  assert.deepEqual(JSON.parse(data.output[0].arguments),{city:'北京'});
  assert.equal(data.output.length,1,'tool-only response must not contain a spurious empty text message');
  const replay={...request,input:[{role:'user',content:'__invoke_tool__'},data.output[0],{type:'function_call_output',call_id:data.output[0].call_id,output:'北京，晴，20度'}]};
  resp=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify(replay)});
  data=await resp.json();assert.equal(resp.status,200);
  assert.equal(data.output[0].type,'message');
  assert.match(data.output[0].content[0].text,/工具结果已收到/);
  assert.equal(data.output.length,1);
});

test('Responses function tool stream emits real call items, argument deltas and completed response',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'test-139',sid:'sid-001',cookie:'RMKEY=mock'});
  const [r,k]=await x.admin('keys','POST',{name:'fuyou-stream',dailyLimit:0,models:[]});assert.equal(r.status,201);
  const headers={Authorization:'Bearer '+k.key,'Content-Type':'application/json'};
  const req={model:'blian_qwen38_flash',input:'__invoke_tool__',stream:true,tools:[{type:'function',name:'get_weather',parameters:{type:'object',properties:{city:{type:'string'}}}}]};
  const resp=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify(req)});
  assert.equal(resp.status,200);
  const text=await resp.text();
  const frames=text.split('\n\n').filter(Boolean).map(part=>{
    const raw=part.split('\n').find(line=>line.startsWith('data: '));
    return raw?JSON.parse(raw.slice(6)):null;
  }).filter(Boolean);
  const names=frames.map(x=>x.type);
  assert.ok(names.includes('response.output_item.added'));
  assert.ok(names.includes('response.function_call_arguments.delta'));
  assert.ok(names.includes('response.function_call_arguments.done'));
  assert.ok(names.includes('response.output_item.done'));
  assert.ok(names.includes('response.completed'));
  assert.ok(!names.includes('response.output_text.delta'));
  const item=frames.find(x=>x.type==='response.output_item.added').item;
  assert.equal(item.type,'function_call');assert.equal(item.name,'get_weather');
  assert.equal(item.call_id,'call_mock_weather');
  const done=frames.find(x=>x.type==='response.function_call_arguments.done');
  assert.deepEqual(JSON.parse(done.arguments),{city:'北京'});
  const completed=frames.find(x=>x.type==='response.completed').response;
  assert.equal(completed.output[0].type,'function_call');
  assert.equal(completed.output[0].arguments,done.arguments);
  assert.equal(x.store.data.requests.at(-1).status,200);
});

test('per-API-Key reference costs are aggregated separately by model and mark missing prices',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'test-139',sid:'sid-001',cookie:'RMKEY=mock'});
  const [a,kA]=await x.admin('keys','POST',{name:'ShiRide',dailyLimit:0,models:[]});
  const [b,kB]=await x.admin('keys','POST',{name:'other-app',dailyLimit:0,models:[]});
  assert.equal(a.status,201);assert.equal(b.status,201);
  const call=async key=>fetch(x.base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'hello'}]})});
  await call(kA.key);
  await x.admin('prices/blian_qwen38_flash','PUT',{inputUsd:1,outputUsd:3});
  await call(kA.key);await call(kB.key);
  let [r,state]=await x.admin('state');assert.equal(r.status,200);
  const first=state.keyUsage[kA.entry.id],second=state.keyUsage[kB.entry.id];
  assert.equal(first.requests,2);assert.equal(first.unpricedRequests,1);
  assert.equal(first.input,20);assert.equal(first.output,4);
  assert.equal(first.byModel[0].model,'blian_qwen38_flash');
  assert.equal(first.byModel[0].requests,2);
  assert.equal(second.requests,1);assert.equal(second.unpricedRequests,0);
  assert.ok(first.referenceCostUsd>0);assert.equal(first.referenceCostUsd,second.referenceCostUsd);
  x.store.data.requests=[];x.store.write();
  const reloaded=new Store(x.store.dir);
  assert.equal(reloaded.overview().keyUsage[kA.entry.id].unpricedRequests,1);
  assert.equal(reloaded.overview().keyUsage[kB.entry.id].requests,1);
});

test('frontend shows model display names and works without a specific hosting control panel',()=>{
  const root=path.resolve('public');
  const js=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(js,/modelName\s*=/);
  assert.match(js,/keyUsage\?\.\[k\.id\]/);
  assert.match(html,/keyUsageModal/);
  assert.doesNotMatch(html,/必须.{0,12}1Panel|请在 1Panel|Docker \/ 1Panel/);
});

// NovaRelay independent-release protocol regression tests.
test('Claude Code streams tool_use blocks, input_json_delta and accepts tool_result replay',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'claude-test',sid:'sid-claude',cookie:'RMKEY=test'});
  const [r,k]=await x.admin('keys','POST',{name:'claude-client',dailyLimit:0,models:[]});assert.equal(r.status,201);
  const headers={'x-api-key':k.key,'anthropic-version':'2023-06-01','content-type':'application/json'};
  const tool={name:'get_weather',description:'Return weather',input_schema:{type:'object',properties:{city:{type:'string'}}}};
  const request={model:'blian_qwen38_flash',max_tokens:256,stream:true,tools:[tool],messages:[{role:'user',content:'__invoke_tool__'}]};
  let response=await fetch(x.base+'/v1/messages',{method:'POST',headers,body:JSON.stringify(request)});
  let s=await response.text();assert.equal(response.status,200);
  assert.match(s,/event: message_start/);
  assert.match(s,/"type":"tool_use"/);
  assert.match(s,/"type":"input_json_delta"/);
  assert.match(s,/"stop_reason":"tool_use"/);
  assert.match(s,/event: message_stop/);
  assert.doesNotMatch(s,/event: error/);
  const replay={...request,stream:false,messages:[{role:'user',content:'__invoke_tool__'},
    {role:'assistant',content:[{type:'tool_use',id:'call_mock_weather',name:'get_weather',input:{city:'北京'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'call_mock_weather',content:'晴，20 度'}]}]};
  response=await fetch(x.base+'/v1/messages',{method:'POST',headers,body:JSON.stringify(replay)});
  const data=await response.json();assert.equal(response.status,200);assert.match(data.content[0].text,/工具结果已收到/);
  assert.equal(data.stop_reason,'end_turn');
});

test('Claude Code count_tokens returns an explicitly marked estimate and never charges quota',async t=>{
  const x=await testSetup(t);
  const [r,k]=await x.admin('keys','POST',{name:'claude-count',dailyLimit:1,models:[]});assert.equal(r.status,201);
  const headers={'x-api-key':k.key,'content-type':'application/json'};
  const body={model:'blian_qwen38_flash',messages:[{role:'user',content:'A short code task'}],tools:[{name:'read_file',input_schema:{type:'object',properties:{path:{type:'string'}}}}]};
  const response=await fetch(x.base+'/v1/messages/count_tokens',{method:'POST',headers,body:JSON.stringify(body)});
  const count=await response.json();assert.equal(response.status,200);
  assert.equal(response.headers.get('x-139-token-count'),'estimated');assert.ok(count.input_tokens>0);
  assert.equal(x.store.keyCallsToday(k.entry.id),0);
  const withoutKey=await fetch(x.base+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(withoutKey.status,401);
});

test('Codex custom freeform tool maps to text-bearing tool calls and replays results',async t=>{
  const {toChatRequest}=await import('../lib/responses.mjs');
  const tool={type:'custom',name:'shell_command',description:'Run a local command',format:{type:'text'}};
  const request={model:'blian_qwen38_flash',store:false,input:'__invoke_tool__',tools:[tool],stream:false};
  const chat=toChatRequest(request);
  assert.equal(chat.tools[0].function.name,'shell_command');
  assert.ok(chat.customToolNames.has('shell_command'));
  assert.equal(Object.keys(chat).includes('customToolNames'),false);
  assert.throws(()=>toChatRequest({...request,tools:[{type:'apply_patch'}]}),/暂不支持/);
  assert.doesNotThrow(()=>toChatRequest({...request,input:[{type:'reasoning',summary:[]},{role:'user',content:'hi'}]}));
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'codex-test',sid:'sid-codex',cookie:'RMKEY=test'});
  const [r,k]=await x.admin('keys','POST',{name:'codex',dailyLimit:0,models:[]});assert.equal(r.status,201);
  const headers={Authorization:'Bearer '+k.key,'content-type':'application/json'};
  let response=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify(request)});
  let result=await response.json();assert.equal(response.status,200);assert.equal(result.output[0].type,'custom_tool_call');
  assert.equal(result.output[0].name,'shell_command');assert.equal(result.output[0].input,'printf hello');
  const call=result.output[0];
  response=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify({...request,input:[{role:'user',content:'__invoke_tool__'},call,{type:'custom_tool_call_output',call_id:call.call_id,output:'hello'}]})});
  result=await response.json();assert.equal(response.status,200);assert.match(result.output[0].content[0].text,/工具结果已收到/);
  response=await fetch(x.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify({...request,stream:true})});
  const stream=await response.text();assert.equal(response.status,200);
  assert.match(stream,/response.custom_tool_call_input.delta/);
  assert.match(stream,/response.custom_tool_call_input.done/);
  assert.match(stream,/"type":"custom_tool_call"/);
  assert.match(stream,/response.completed/);
});

test('healthz remains operational when no credentials; readyz reflects availability',async t=>{
  const x=await testSetup(t);
  let r=await fetch(x.base+'/healthz');assert.equal(r.status,200);assert.equal((await r.json()).version,'1.0.0');
  r=await fetch(x.base+'/readyz');assert.equal(r.status,503);
  await x.admin('accounts','POST',{name:'active',sid:'sid-active',cookie:'RMKEY=test'});
  r=await fetch(x.base+'/readyz');assert.equal(r.status,200);
});

test('client cancellation releases concurrency and does not quarantine a healthy account',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'cancel-test',sid:'sid-cancel',cookie:'RMKEY=test'});
  const [r,k]=await x.admin('keys','POST',{name:'long-request',dailyLimit:0,models:[]});assert.equal(r.status,201);
  const headers={Authorization:'Bearer '+k.key,'content-type':'application/json'};
  const abort=new AbortController();
  const pending=fetch(x.base+'/v1/chat/completions',{method:'POST',headers,signal:abort.signal,body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'__delay__'}]})}).catch(()=>null);
  await new Promise(resolve=>setTimeout(resolve,80));abort.abort();await pending;
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(x.store.accountHealth.size,0);
  const good=await fetch(x.base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'blian_qwen38_flash',messages:[{role:'user',content:'hi'}]})});
  assert.equal(good.status,200);
});

test('backup verify accepts only approved config/data archives and refuses unsafe paths',async()=>{
  const {execFileSync}=await import('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'139-gateway-backup-'));
  try{
    fs.mkdirSync(path.join(dir,'native','data'),{recursive:true});
    fs.writeFileSync(path.join(dir,'native','.env'),'MASTER_KEY=testing\n');
    fs.writeFileSync(path.join(dir,'native','data','state.json'),'{}\n');
    const backup=path.join(dir,'backup.tar.gz');
    execFileSync('tar',['-czf',backup,'-C',dir,'native/.env','native/data']);
    const output=execFileSync('bash',[path.resolve('scripts/backup.sh'),'verify',backup],{encoding:'utf8'});
    assert.match(output,/完整性校验通过/);
    fs.writeFileSync(path.join(dir,'unexpected'),'surprise');
    const tampered=path.join(dir,'unsafe.tar.gz');
    execFileSync('tar',['-czf',tampered,'-C',dir,'native/.env','native/data','unexpected']);
    assert.throws(()=>execFileSync('bash',[path.resolve('scripts/backup.sh'),'verify',tampered],{stdio:'ignore'}));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('never forwards undeclared upstream tool calls to Codex',async t=>{
  const x=await testSetup(t);
  await x.admin('accounts','POST',{name:'upstream-test',sid:'sid-guard',cookie:'RMKEY=test'});
  const [r,k]=await x.admin('keys','POST',{name:'guarded',dailyLimit:0,models:[]});assert.equal(r.status,201);
  const response=await fetch(x.base+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+k.key,'content-type':'application/json'},body:JSON.stringify({model:'blian_qwen38_flash',input:'__undeclared_tool__',tools:[{type:'function',name:'read_file',parameters:{type:'object'}}]})});
  assert.equal(response.status,502);
  const json=await response.json();assert.doesNotMatch(JSON.stringify(json),/unauthorized_file_delete/);
});

test('Claude Code API errors use Anthropic envelope',async t=>{
  const x=await testSetup(t);
  const response=await fetch(x.base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'a',max_tokens:10,messages:[{role:'user',content:'hi'}]})});
  assert.equal(response.status,401);
  const body=await response.json();assert.equal(body.type,'error');assert.equal(body.error.type,'authentication_error');
});
