/** Opt-in real upstream smoke test. Never logs prompts, credentials or model responses. */
const origin=String(process.env.GATEWAY_BASE||'http://127.0.0.1:8323').replace(/\/$/,'').replace(/\/v1$/,'');
const key=process.env.GATEWAY_API_KEY;
let model=process.env.MODEL_ID||'';
if(!key){console.error('请通过 GATEWAY_API_KEY 环境变量传入已创建的客户端密钥');process.exit(2);}
const results=[];
async function request(route,payload=null,auth='openai'){
  const response=await fetch(origin+route,{method:payload?'POST':'GET',headers:{...(auth==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+key}),...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(90000)});
  const raw=await response.text();
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${raw.slice(0,160).replaceAll(key,'[REDACTED]')}`);
  return {raw,json:raw.startsWith('{')?JSON.parse(raw):null};
}
async function check(name,fn){
  try{const out=await fn();results.push({name,result:out||'pass'});}catch(err){results.push({name,result:'failed',error:String(err.message||err).slice(0,180)});}
}
await check('models',async()=>{
  const {json}=await request('/v1/models');
  if(!Array.isArray(json?.data)||!json.data.length)throw new Error('没有可用模型');
  model||=json.data[0].id;
  return 'pass';
});
if(model){
  await check('OpenAI Chat non-stream',async()=>{
    const {json}=await request('/v1/chat/completions',{model,messages:[{role:'user',content:'回复 OK'}],stream:false});
    if(!Array.isArray(json?.choices))throw Error('缺少 choices');
  });
  await check('OpenAI Responses non-stream',async()=>{
    const {json}=await request('/v1/responses',{model,input:'回复 OK',store:false,stream:false});
    if(json?.object!=='response'||!Array.isArray(json.output))throw Error('输出不是 Responses 结构');
  });
  await check('OpenAI Responses SSE',async()=>{
    const {raw}=await request('/v1/responses',{model,input:'回复 OK',store:false,stream:true});
    if(!raw.includes('response.completed'))throw Error('缺少 response.completed');
  });
  await check('Anthropic Messages SSE',async()=>{
    const {raw}=await request('/v1/messages',{model,max_tokens:80,stream:true,messages:[{role:'user',content:'回复 OK'}]},'anthropic');
    if(!raw.includes('event: message_start')||!raw.includes('event: message_stop'))throw Error('缺少 message_start/message_stop');
  });
  await check('Anthropic estimated count_tokens',async()=>{
    const {json}=await request('/v1/messages/count_tokens',{model,messages:[{role:'user',content:'hello'}]},'anthropic');
    if(!Number.isFinite(json?.input_tokens))throw Error('缺少 input_tokens');
    return 'pass (estimate)';
  });
  if(process.env.SMOKE_TOOL_TEST==='1'){
    const func={type:'function',name:'echo_answer',description:'Echo the input text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}};
    await check('Codex Responses function (best effort model capability)',async()=>{
      const {json}=await request('/v1/responses',{model,input:'必须使用 echo_answer 工具，text=ping',tools:[func],tool_choice:'required',store:false});
      if(!json?.output)throw Error('无有效回应');
      return json.output.some(x=>x.type==='function_call')?'pass':'warning: model returned text instead of a function call';
    });
    await check('Claude Messages tool stream (best effort model capability)',async()=>{
      const {raw}=await request('/v1/messages',{model,max_tokens:160,stream:true,messages:[{role:'user',content:'必须调用 echo_answer，text=ping'}],tools:[{name:'echo_answer',description:'Echo the input text',input_schema:func.parameters}]},'anthropic');
      if(raw.includes('event: error'))throw Error('流式工具调用错误');
      return raw.includes('"type":"tool_use"')?'pass':'warning: model returned text instead of tool_use';
    });
  }
}
console.log(JSON.stringify({model:model||null,results},null,2));
if(results.some(x=>x.result==='failed'))process.exitCode=1;
