import {randomUUID} from 'node:crypto';
import {textOf} from './meter.mjs';

const invalid=message=>Object.assign(new Error(message),{status:400});
const id=prefix=>prefix+randomUUID().replaceAll('-','');
const nonempty=x=>typeof x==='string' && x.length>0 && x.length<=256;
const usageOf=u=>({input_tokens:u?.prompt_tokens??0,output_tokens:u?.completion_tokens??0,total_tokens:u?.total_tokens??0});

function inputText(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))throw invalid('消息 content 必须是字符串或文本数组');
  return content.map(p=>{
    if(p?.type==='input_text'||p?.type==='output_text'||p?.type==='text')return String(p.text??'');
    throw invalid(`暂不支持 Responses 内容块 ${p?.type||'unknown'}；目前仅支持文本与函数工具`);
  }).join('\n');
}
function toolArgs(args){
  if(typeof args==='string'){
    try { JSON.parse(args); } catch { throw invalid('function_call.arguments 必须是 JSON 字符串'); }
    return args;
  }
  if(args && typeof args==='object' && !Array.isArray(args))return JSON.stringify(args);
  throw invalid('function_call.arguments 必须是 JSON 对象或字符串');
}
function toolChoice(value){
  if(value==null)return undefined;
  if(['auto','none','required'].includes(value))return value;
  if(['function','custom'].includes(value?.type)&&nonempty(value.name))return {type:'function',function:{name:value.name}};
  throw invalid('不支持的 tool_choice，请使用 auto、none、required 或指定函数');
}
export function toChatRequest(r){
  if(!r || typeof r!=='object'||Array.isArray(r))throw invalid('请求体必须是对象');
  if(r.previous_response_id)throw invalid('暂不支持 previous_response_id；请将先前 function_call 和 function_call_output 一并放进 input');
  if(!nonempty(r.model))throw invalid('缺少 model');
  if(r.tools!=null && (!Array.isArray(r.tools)||r.tools.length>64))throw invalid('tools 必须是最多 64 项的数组');
  const customTools=new Set();
  const names=new Set();
  const tools=(r.tools||[]).map(t=>{
    if(!['function','custom'].includes(t?.type))throw invalid(`暂不支持 ${t?.type||'unknown'} 内置工具；支持客户端 function/custom 工具`);
    if(!nonempty(t.name)||names.has(t.name))throw invalid('工具名称无效或重复');
    names.add(t.name);
    if(t.type==='custom'){
      // Codex custom tools accept freeform string input. The 139 engine only
      // understands JSON-schema function tools; explicitly wrap input as text.
      if(t.format && !['text','grammar'].includes(t.format.type))throw invalid('custom 工具 format 不受支持');
      customTools.add(t.name);
      return {type:'function',function:{name:t.name,description:typeof t.description==='string'?t.description:'',parameters:{type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false}}};
    }
    const params=t.parameters??{type:'object',properties:{}};
    if(typeof params!=='object'||!params||Array.isArray(params))throw invalid('function 工具缺少有效的 parameters');
    return {type:'function',function:{name:t.name,description:typeof t.description==='string'?t.description:'',parameters:params,...(typeof t.strict==='boolean'?{strict:t.strict}:{})}};
  });
  const messages=[];
  if(r.instructions)messages.push({role:'system',content:String(r.instructions)});
  const items=typeof r.input==='string'?[{role:'user',content:r.input}]:r.input;
  if(!Array.isArray(items)||items.length>256)throw invalid('input 必须是字符串或最多 256 项的数组');
  const knownCalls=new Set();
  for(const item of items){
    if(typeof item==='string'){messages.push({role:'user',content:item});continue;}
    if(!item||typeof item!=='object')throw invalid('input 包含无效的消息项');
    if(item.type==='reasoning'){
      // No native encrypted reasoning support. Do not echo or fabricate reasoning.
      // Stateless clients can replay opaque reasoning alongside the visible messages.
      continue;
    }
    if(item.type==='custom_tool_call'){
      if(!nonempty(item.call_id)||!nonempty(item.name)||typeof item.input!=='string')throw invalid('custom_tool_call 缺少 call_id/name/input');
      if(knownCalls.has(item.call_id))throw invalid('重复的 custom_tool_call.call_id');
      knownCalls.add(item.call_id);
      messages.push({role:'assistant',content:null,tool_calls:[{id:item.call_id,type:'function',function:{name:item.name,arguments:JSON.stringify({input:item.input})}}]});
      continue;
    }
    if(item.type==='function_call'){
      if(!nonempty(item.call_id)||!nonempty(item.name))throw invalid('function_call 缺少 call_id / name');
      if(knownCalls.has(item.call_id))throw invalid('存在重复的 function_call.call_id');
      knownCalls.add(item.call_id);
      messages.push({role:'assistant',content:null,tool_calls:[{id:item.call_id,type:'function',function:{name:item.name,arguments:toolArgs(item.arguments)}}]});
      continue;
    }
    if(item.type==='custom_tool_call_output'){
      if(!nonempty(item.call_id)||!knownCalls.has(item.call_id))throw invalid('custom_tool_call_output 未找到完整调用历史');
      if(typeof item.output!=='string')throw invalid('custom_tool_call_output 必须是文本');
      messages.push({role:'tool',tool_call_id:item.call_id,content:item.output});
      continue;
    }
    if(item.type==='function_call_output'){
      if(!nonempty(item.call_id)||!knownCalls.has(item.call_id))throw invalid('function_call_output 未找到同一 input 中的 function_call，请提供完整工具调用历史');
      if(typeof item.output!=='string'&&!Array.isArray(item.output))throw invalid('function_call_output 目前仅支持文本输出');
      messages.push({role:'tool',tool_call_id:item.call_id,content:inputText(item.output)});
      continue;
    }
    if(item.type && item.type!=='message')throw invalid(`暂不支持 Responses input 项：${item.type}`);
    if(!['user','assistant','system','developer'].includes(item.role))throw invalid('input 消息角色不受支持');
    messages.push({role:item.role==='developer'?'system':item.role,content:inputText(item.content)});
  }
  if(!messages.length)throw invalid('input 不能为空');
  const choice=toolChoice(r.tool_choice);
  if(tools.length===0&&choice&&choice!=='auto'&&choice!=='none')throw invalid('必须先提供 tools 才能要求工具调用');
  const result={model:r.model,messages,stream:r.stream===true,
    ...(tools.length?{tools}:{}),...(choice?{tool_choice:choice}:{}),
    ...(typeof r.parallel_tool_calls==='boolean'?{parallel_tool_calls:r.parallel_tool_calls}:{}),
    ...(Number.isInteger(r.max_output_tokens)&&r.max_output_tokens>0?{max_tokens:r.max_output_tokens}:{}),
    ...(r.temperature!=null?{temperature:r.temperature}:{})};
  Object.defineProperty(result,'customToolNames',{value:customTools,enumerable:false});
  return result;
}
export function newResponseId(){return id('resp_');}
export function toolCallItem(call,customTools=new Set()){
  const name=call?.function?.name;
  if(!nonempty(name))throw Object.assign(new Error('上游返回了缺少函数名的工具调用'),{status:502});
  const args=call.function.arguments;
  if(customTools?.has(name)){
    let parsed;try{parsed=typeof args==='string'?JSON.parse(args):args;}catch{throw Object.assign(new Error('custom 工具输入不是合法 JSON'),{status:502});}
    if(typeof parsed?.input!=='string')throw Object.assign(new Error('custom 工具输入缺少文本 input'),{status:502});
    return {id:id('ctc_'),type:'custom_tool_call',status:'completed',call_id:call.id||id('call_'),name,input:parsed.input};
  }
  return {id:id('fc_'),type:'function_call',status:'completed',call_id:call.id||id('call_'),name,arguments:typeof args==='string'?args:JSON.stringify(args??{})};
}
export function messageItem(text){return {id:id('msg_'),type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]};}
export function makeResponse(model,text,usage,responseId=newResponseId(),status='completed',extraOutput=[]){
  const output=[...(text? [messageItem(text)] : []),...extraOutput];
  if(!output.length)output.push(messageItem(''));
  return {id:responseId,object:'response',created_at:Math.floor(Date.now()/1000),status,model,output,usage:usageOf(usage),error:null,incomplete_details:null};
}
export function fromChatResponse(data,model,usage,customTools=new Set()){
  const msg=data?.choices?.[0]?.message||{};
  const content=typeof msg?.content==='string'?msg.content:textOf(msg?.content);
  const calls=(msg.tool_calls||[]).map(call=>toolCallItem(call,customTools));
  return makeResponse(data?.model||model,content,usage,newResponseId(),'completed',calls);
}
