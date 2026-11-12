/** Local-only test double for upstream MIT engine. Never included as the production engine. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const reply=(res,code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const read=async(req)=>{let b='';for await(const c of req)b+=c;try{return JSON.parse(b);}catch{return {};}};
export function createGateway({dataDir,adminToken}){
  const conf=JSON.parse(fs.readFileSync(path.join(dataDir,'config.json'),'utf8'));
  const file=path.join(dataDir,'credentials.json');
  const creds=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {};}};
  const server=http.createServer(async(req,res)=>{
    const c=creds();
    if(req.url==='/healthz')return reply(res,200,{ok:true,credentials:{sid:!!c.sid,cookie:!!c.cookie},token_cached:!!c.sid,token_expiry:c.sid?'2027-12-12T00:00:00Z':null});
    if(req.url==='/admin/api/credentials'){
      if(req.headers['x-admin-token']!==adminToken)return reply(res,401,{error:'bad admin token'});
      const j=await read(req);
      if(!j.sid || !j.cookie?.includes('RMKEY='))return reply(res,400,{error:'凭据验证失败'});
      fs.writeFileSync(file,JSON.stringify({sid:j.sid,cookie:j.cookie}),{mode:0o600});
      return reply(res,200,{ok:true,verified:{ok:true,phone:'139****0000'},token:{expiresAt:Date.parse('2027-12-12T00:00:00Z')}});
    }
    if(req.url==='/admin/api/renew'){
      if(req.headers['x-admin-token']!==adminToken)return reply(res,401,{error:'bad admin token'});
      return reply(res,200,c.sid?{ok:true,token:{expiresAt:Date.parse('2027-12-12T00:00:00Z')}}:{ok:false,error:'未登录'});
    }
    if(req.headers.authorization!=='Bearer '+conf.apiKey)return reply(res,401,{error:'bad api key'});
    if(req.url==='/v1/models')return reply(res,200,{object:'list',data:[{id:'blian_qwen38_flash',display_name:'qwen3.8-Flash',object:'model'}]});
    if(req.url==='/v1/chat/completions'){
      const body=await read(req);
      if(!c.sid)return reply(res,401,{error:'账号未授权'});
      if(c.sid.startsWith('FAIL'))return reply(res,503,{error:{message:'模拟账号不可用'}});
      const last=String(body.messages?.filter(m=>m.role==='user').at(-1)?.content||'');
      if(last.includes('__delay__'))await new Promise(resolve=>setTimeout(resolve,300));
      if(last.includes('__undeclared_tool__')&&body.tools?.length){
        return reply(res,200,{object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call_evil',type:'function',function:{name:'unauthorized_file_delete',arguments:'{}'}}]},finish_reason:'tool_calls'}]});
      }
      const tool=body.tools?.[0]?.function;
      const lastMessage=body.messages?.at(-1);
      const shouldCall=Boolean(tool && lastMessage?.role==='user' && last.includes('__invoke_tool__'));
      if(shouldCall){
        const name=tool.name;
        const args=JSON.stringify(tool.parameters?.properties?.input?{input:'printf hello'}:{city:'北京'});
        const cut=Math.floor(args.length/2);
        if(body.stream){
          res.writeHead(200,{'Content-Type':'text/event-stream'});
          res.write('data: '+JSON.stringify({choices:[{delta:{role:'assistant',tool_calls:[{index:0,id:'call_mock_weather',type:'function',function:{name,arguments:args.slice(0,cut)}}]}}]})+'\n\n');
          res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:args.slice(cut)}}]}}]})+'\n\n');
          res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:25,completion_tokens:9}})+'\n\n');
          return res.end('data: [DONE]\n\n');
        }
        return reply(res,200,{object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call_mock_weather',type:'function',function:{name,arguments:args}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:25,completion_tokens:9,total_tokens:34}});
      }
      if(lastMessage?.role==='tool')return reply(res,200,{object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'工具结果已收到：'+lastMessage.content},finish_reason:'stop'}],usage:{prompt_tokens:21,completion_tokens:8,total_tokens:29}});
      if(body.stream){
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.write('data: '+JSON.stringify({choices:[{delta:{content:'你'}}]})+'\n\n');
        if(last.includes('__truncate__'))return res.end();
        if(last.includes('__sse_error__'))return res.end('data: '+JSON.stringify({error:{message:'模拟上游返回错误'}})+'\n\n');
        res.write('data: '+JSON.stringify({choices:[{delta:{content:'好'}}]})+'\n\n');
        res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+'\n\n');
        return res.end('data: [DONE]\n\n');
      }
      return reply(res,200,{object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'你好'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
    }
    return reply(res,404,{error:'not found'});
  });
  return {tokens:{get:async()=>{if(!creds().sid)throw new Error('需要重新登录');return {expiryMs:Date.parse('2027-12-12T00:00:00Z')};}},start:(p=0)=>new Promise((resolve,reject)=>{server.on('error',reject);server.listen(p,'127.0.0.1',()=>resolve(server.address().port));}),stop:()=>new Promise(resolve=>server.close(resolve))};
}
