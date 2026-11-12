/** Public reference prices only. 139 does not provide an actual billing rate. */
export const PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const NORMALIZE = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const isRate = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1;

/** Strict matching: never guess across multiple providers or similar model versions. */
export function findCatalogMatch(model,catalog,explicit='') {
  const entries=Object.entries(catalog||{});
  if(explicit) {
    const found=catalog[explicit];
    return found ? {key:explicit,info:found,match:'manual_mapping'} : null;
  }
  const exact=String(model.id||'');
  if(catalog[exact])return {key:exact,info:catalog[exact],match:'exact_id'};
  const candidates=new Set([NORMALIZE(exact),NORMALIZE(model.display_name||model.name)]);
  candidates.delete('');
  const hits=entries.filter(([key,info])=>info && candidates.has(NORMALIZE(key.split('/').at(-1))));
  // Multiple providers -> ambiguous. Do not invent a price or choose the cheapest.
  if(hits.length!==1)return null;
  return {key:hits[0][0],info:hits[0][1],match:'unique_model_name'};
}

export function applyCatalog(storeData,models,catalog,now=new Date()) {
  storeData.prices ||= {};
  storeData.priceMappings ||= {};
  const unique=new Map(models.filter(x=>x && typeof x.id==='string').map(x=>[x.id,x]));
  const result={matched:0,unmatched:[],skippedCustom:0,source:'LiteLLM',updatedAt:now.toISOString()};
  for(const [id,model] of unique){
    if(storeData.prices[id]?.source==='custom_reference') { result.skippedCustom++; continue; }
    const found=findCatalogMatch(model,catalog,storeData.priceMappings[id]||'');
    if(!found || !isRate(found.info.input_cost_per_token) || !isRate(found.info.output_cost_per_token)) {
      if(storeData.prices[id]?.source==='litellm_reference')delete storeData.prices[id];
      result.unmatched.push(id); continue;
    }
    const inputUsd=Number((found.info.input_cost_per_token*1e6).toFixed(6));
    const outputUsd=Number((found.info.output_cost_per_token*1e6).toFixed(6));
    storeData.prices[id]={inputUsd,outputUsd,source:'litellm_reference',referenceModelId:found.key,match:found.match,updatedAt:result.updatedAt};
    result.matched++;
  }
  return result;
}

/** A bounded, timeout-aware fetch. An unavailable price service must never stop inference. */
export async function fetchPriceCatalog(fetchFn=fetch){
  const r=await fetchFn(PRICING_URL,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/json'}});
  if(!r.ok)throw new Error('LiteLLM 价格目录 HTTP '+r.status);
  const size=Number(r.headers?.get?.('content-length')||0);
  if(size>25*1024*1024)throw new Error('价格目录文件过大');
  const raw=await r.text();
  if(raw.length>25*1024*1024)throw new Error('价格目录超过限制');
  const data=JSON.parse(raw);
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length<10)throw new Error('价格目录格式不正确');
  return data;
}

/** Catalog-backed candidates; never automatically approve approximate matches. */
export function priceCandidates(model,catalog,limit=6){
  const norm=NORMALIZE(model);
  // Strip 139 routing prefix for search only; selection is always explicit.
  const slug=norm.replace(/^(blian|huoshan|vlm)/,'');
  if(slug.length<4)return [];
  const hits=[];
  for(const [id,info] of Object.entries(catalog||{})){
    if(!info || !isRate(info.input_cost_per_token) || !isRate(info.output_cost_per_token))continue;
    const tail=NORMALIZE(id.split('/').at(-1));
    if(tail===slug || tail.includes(slug) || slug.includes(tail)){
      hits.push({id,provider:info.litellm_provider||id.split('/')[0]||'unknown',inputUsd:info.input_cost_per_token*1e6,outputUsd:info.output_cost_per_token*1e6,match:tail===slug?'name_equal':'candidate_only'});
    }
  }
  hits.sort((a,b)=>(a.match===b.match?0:a.match==='name_equal'?-1:1)||a.id.localeCompare(b.id));
  return hits.slice(0,Math.min(20,Math.max(1,limit)));
}
