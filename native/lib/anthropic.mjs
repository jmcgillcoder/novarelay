/** Anthropic Messages wire-format adapter for the 139 Chat Completions engine.
 * This is a compatibility adapter, not native Claude inference.
 */
import {randomUUID} from 'node:crypto';
const invalid = message => Object.assign(new Error(message), {status: 400});
const text = parts => typeof parts === 'string' ? parts : Array.isArray(parts) ? parts.filter(p => p?.type === 'text').map(p => p.text || '').join('\n') : '';
const jsonArg = value => {try{return typeof value === 'string' ? JSON.parse(value) : value || {};}catch{return {};}};
const inputImage = part => {
  const source=part.source;
  if(source?.type==='base64' && /^image\/(png|jpeg|webp|gif)$/.test(source.media_type||'') && typeof source.data==='string')return {type:'image_url',image_url:{url:`data:${source.media_type};base64,${source.data}`}};
  if(source?.type==='url' && /^https:\/\//.test(source.url||''))return {type:'image_url',image_url:{url:source.url}};
  throw invalid('图片仅支持 base64 图片或 HTTPS URL');
};
export function anthropicToChat(payload){
  if(!payload || typeof payload!=='object' || !payload.model || !Array.isArray(payload.messages) || !Number.isInteger(payload.max_tokens) || payload.max_tokens<1)throw invalid('Messages 必须提供 model、messages 和正整数 max_tokens');
  if(payload.messages.length>200)throw invalid('消息数量过多');
  if(payload.metadata?.user_id && String(payload.metadata.user_id).length>256)throw invalid('metadata.user_id 太长');
  const messages=[];
  if(payload.system){const s=text(payload.system);if(s)messages.push({role:'system',content:s});}
  for(const item of payload.messages){
    if(!['user','assistant'].includes(item?.role))throw invalid('不支持的 Messages 角色');
    const content=typeof item.content==='string'?[{type:'text',text:item.content}]:item.content;
    if(!Array.isArray(content))throw invalid('Messages content 必须是字符串或数组');
    const parts=[];const toolResults=[];const calls=[];
    for(const p of content){
      if(p?.type==='text'){parts.push({type:'text',text:String(p.text||'')});continue;}
      if(p?.type==='image' && item.role==='user'){parts.push(inputImage(p));continue;}
      if(p?.type==='tool_use' && item.role==='assistant'){
        if(typeof p.id!=='string'||typeof p.name!=='string')throw invalid('tool_use 缺少 id/name');
        calls.push({id:p.id,type:'function',function:{name:p.name,arguments:JSON.stringify(p.input||{})}});continue;
      }
      if(p?.type==='tool_result' && item.role==='user'){
        toolResults.push({role:'tool',tool_call_id:String(p.tool_use_id||''),content:text(p.content)});continue;
      }
      throw invalid(`暂不支持的 Messages 内容类型：${p?.type||'unknown'}`);
    }
    if(parts.length||calls.length)messages.push({role:item.role,content:parts.length===1&&parts[0].type==='text'?parts[0].text:parts.length?parts:null,...(calls.length?{tool_calls:calls}:{})});
    messages.push(...toolResults);
  }
  if(!messages.length)throw invalid('缺少有效消息');
  const tools=Array.isArray(payload.tools)?payload.tools.map(t=>({type:'function',function:{name:t.name,description:t.description||'',parameters:t.input_schema||{type:'object',properties:{}}}})):[];
  if(tools.some(t=>typeof t.function.name!=='string'||!t.function.name))throw invalid('tools 缺少 name');
  const choice=payload.tool_choice;
  const tool_choice=choice?.type==='tool'?{type:'function',function:{name:choice.name}}:choice?.type==='any'?'required':choice?.type==='none'?'none':'auto';
  // 流式工具调用由受约束的 Anthropic SSE 适配器负责校验与输出。
  return {model:payload.model,messages,max_tokens:payload.max_tokens,stream:payload.stream===true,
    ...(tools.length?{tools,tool_choice}:{}),...(payload.thinking?.type==='enabled'?{enable_thinking:true}:{}),
    ...(payload.temperature!=null?{temperature:payload.temperature}:{})};
}
export function chatToAnthropic(json,model,usage){
  const message=json?.choices?.[0]?.message||{};
  const blocks=[];
  const content=typeof message.content==='string'?message.content:text(message.content);
  if(content)blocks.push({type:'text',text:content});
  for(const c of message.tool_calls||[]){
    blocks.push({type:'tool_use',id:c.id||'toolu_'+randomUUID().replaceAll('-',''),name:c.function?.name||'',input:jsonArg(c.function?.arguments)});
  }
  if(!blocks.length)blocks.push({type:'text',text:''});
  return {id:'msg_'+randomUUID().replaceAll('-',''),type:'message',role:'assistant',model:json.model||model,
    content:blocks,stop_reason:blocks.some(b=>b.type==='tool_use')?'tool_use':json?.choices?.[0]?.finish_reason==='length'?'max_tokens':'end_turn',stop_sequence:null,
    usage:{input_tokens:usage?.prompt_tokens||0,output_tokens:usage?.completion_tokens||0}};
}
export function writeAnthropicStart(res,model,id){
  const mid=id||'msg_'+randomUUID().replaceAll('-','');
  const emit=(kind,data)=>res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start',{type:'message_start',message:{id:mid,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});
  return {emit,mid};
}
