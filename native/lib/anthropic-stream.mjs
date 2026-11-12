/** Anthropic Messages SSE translation. This is an adapter for ChatCompletions tool deltas,
 * not a claim that the 139 provider supports native Claude thinking or tool execution.
 */
import {randomUUID} from 'node:crypto';

const uid = prefix => prefix + randomUUID().replaceAll('-', '');
const asString = v => typeof v === 'string' ? v : '';

export function createAnthropicStream(res, model, allowedTools = []) {
  const emit = (type, extra) => res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...extra})}\n\n`);
  emit('message_start', {message: {id: uid('msg_'), type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 0, output_tokens: 0}}});

  let index = 0;
  let textOpened = false;
  let textClosed = false;
  let content = '';
  const tools = new Map();
  const allowed = new Set(allowedTools.map(x => x?.function?.name).filter(Boolean));

  const closeText = () => {
    if (textOpened && !textClosed) {
      emit('content_block_stop', {index: 0});
      textClosed = true;
    }
  };
  const text = value => {
    if (!value) return;
    if (textClosed) throw new Error('上游在工具调用后继续发送无序文本');
    if (!textOpened) {
      if (index !== 0) throw new Error('工具调用后收到无序文本');
      emit('content_block_start', {index: 0, content_block: {type:'text', text:''}});
      textOpened = true;
      index = 1;
    }
    content += value;
    emit('content_block_delta', {index: 0, delta: {type:'text_delta', text:value}});
  };
  const openTool = call => {
    if (call.opened) return;
    if (!call.name) return;
    if (!allowed.has(call.name)) throw new Error('上游请求了未声明的工具：' + call.name);
    closeText();
    call.blockIndex = index++;
    call.id ||= uid('toolu_');
    call.opened = true;
    emit('content_block_start', {index:call.blockIndex, content_block:{type:'tool_use',id:call.id,name:call.name,input:{}}});
    if (call.args) {emit('content_block_delta',{index:call.blockIndex,delta:{type:'input_json_delta',partial_json:call.args}});call.sent=call.args.length;}
  };
  const accept = data => {
    if (data?.error) throw new Error('上游流式错误');
    const delta = data?.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string') text(delta.content);
    if (Array.isArray(delta.tool_calls)) for (const chunk of delta.tool_calls) {
      const idx = Number.isInteger(chunk.index) ? chunk.index : 0;
      let call = tools.get(idx);
      if (!call) {call={name:'',id:null,args:'',sent:0,opened:false};tools.set(idx,call);}
      if (typeof chunk.id === 'string' && chunk.id && !call.id) call.id=chunk.id;
      call.name += asString(chunk.function?.name);
      call.args += asString(chunk.function?.arguments);
      // Name is generally complete when JSON arguments start; delay the start
      // until that point so fragmented names don't get frozen too early.
      if (call.args && !call.opened) openTool(call);
      else if (call.opened && call.args.length>call.sent) {
        emit('content_block_delta',{index:call.blockIndex,delta:{type:'input_json_delta',partial_json:call.args.slice(call.sent)}});
        call.sent=call.args.length;
      }
    }
  };
  const finish = (usage = {}, finishReason = 'stop') => {
    closeText();
    const list=[...tools.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
    for (const call of list) {
      openTool(call);
      if (!call.opened) throw new Error('工具调用缺少名称');
      if (!allowed.has(call.name)) throw new Error('上游返回了未知的工具名称');
      if (call.args.length>call.sent) {
        emit('content_block_delta',{index:call.blockIndex,delta:{type:'input_json_delta',partial_json:call.args.slice(call.sent)}});
        call.sent=call.args.length;
      }
      let parsed;
      try { parsed=JSON.parse(call.args || '{}'); } catch { throw new Error('上游工具参数不是有效 JSON'); }
      if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('上游工具参数需要 JSON 对象');
      emit('content_block_stop',{index:call.blockIndex});
    }
    if (!textOpened && !list.length) {
      emit('content_block_start',{index:0,content_block:{type:'text',text:''}});
      emit('content_block_stop',{index:0});
    }
    emit('message_delta',{delta:{stop_reason:list.length?'tool_use':finishReason==='length'?'max_tokens':'end_turn',stop_sequence:null},usage:{output_tokens:usage.completion_tokens||0}});
    emit('message_stop',{});
    return {content,toolCount:list.length};
  };
  const fail = () => emit('error',{error:{type:'api_error',message:'上游流式或工具参数不完整'}});
  return {accept,finish,fail, get content(){return content;},get toolCount(){return tools.size;}};
}
