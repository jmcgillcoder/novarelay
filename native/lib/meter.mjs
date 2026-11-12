export function textOf(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map(textOf).join(' ');
  if (!input || typeof input !== 'object') return '';
  if (input.type==='text' || input.type==='input_text' || input.type==='output_text') return typeof input.text === 'string' ? input.text : '';
  if (input.role && input.content != null) return textOf(input.content);
  return '';
}
export function estimateTokens(input) {
  const s=textOf(input);
  // Deliberately rough: never label this as an upstream measured token count.
  const han=(s.match(/[\u3400-\u9fff]/g)||[]).length;
  return Math.max(0,Math.ceil(han*1.3+(s.length-han)/4));
}
export function measure(messages,response,reported=null) {
  if (reported && Number.isFinite(reported.prompt_tokens) && Number.isFinite(reported.completion_tokens)) {
    return {usage:{prompt_tokens:Math.max(0,Math.floor(reported.prompt_tokens)),completion_tokens:Math.max(0,Math.floor(reported.completion_tokens)),total_tokens:Math.max(0,Math.floor(reported.prompt_tokens+reported.completion_tokens))},source:'estimated_upstream'};
  }
  const prompt_tokens=estimateTokens(messages), completion_tokens=estimateTokens(response);
  return {usage:{prompt_tokens,completion_tokens,total_tokens:prompt_tokens+completion_tokens},source:'estimated_local'};
}
export function costFor(prices,model,usage) {
  const p=prices[model];
  if (!p || !Number.isFinite(p.inputUsd) || !Number.isFinite(p.outputUsd)) return {costUsd:null,costSource:'unpriced'};
  return {costUsd:Number(((usage.prompt_tokens*p.inputUsd + usage.completion_tokens*p.outputUsd)/1e6).toFixed(10)),costSource:p.source||'custom_reference'};
}
