const $=id=>document.getElementById(id);
const labels={overview:'概览',accounts:'139 账号',keys:'API 密钥',models:'模型测试',pricing:'Token 与费用',requests:'请求日志',updates:'在线更新',settings:'设置',about:'关于'};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n||0).toLocaleString('zh-CN');
const time=s=>{if(!s)return '—';const d=new Date(s);return Number.isNaN(d.getTime())?'—':d.toLocaleString('zh-CN');};
const money=n=>n==null?'未设置':'$'+Number(n).toFixed(5);
const usageLabel=s=>s==='estimated_upstream'||s==='upstream'?'上游估算':s==='estimated_local'||s==='estimated'?'本地估算':s==='measured'?'上游实测':'估算';
const list=s=>String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
const empty=t=>`<div class="empty">${esc(t)}</div>`;
const table=(heads,rows)=>!rows.length?empty('暂无记录'):`<table><thead><tr>${heads.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
const status=(label,type='off')=>`<span class="status ${type}">${esc(label)}</span>`;
let csrf='',state=null,page='overview',models=[],justCreatedKey='',booted=false,trend='requests';
// Display names are never used as API identifiers. The live /models result takes precedence.
const modelFallback={blian_qwen38_max:'qwen3.8-Max',huoshan_glm_5_3:'GLM-5.3',blian_qwen38_flash:'qwen3.8-Flash',blian_qwen37_plus:'qwen3.7-Plus',blian_qwen36_plus:'qwen3.6-Plus',blian_qwen35_plus:'qwen3.5-Plus',blian_deepseek_v4_pro:'DeepSeek-V4-Pro',blian_deepseek_v4_flash:'DeepSeek-V4-Flash',jiutian:'九天大模型',vlm_huoshan_2_0_lite_thinking_vision:'Seed-2.0-Lite'};
const modelName=id=>models.find(m=>m.id===id)?.display_name||models.find(m=>m.id===id)?.name||modelFallback[id]||id||'—';
const modelCell=id=>id&&modelName(id)!==id?`<div class="model-cell"><strong>${esc(modelName(id))}</strong><small class="muted">${esc(id)}</small></div>`:`<code>${esc(id||'—')}</code>`;
const modelList=ids=>ids?.length?ids.map(id=>modelName(id)===id?esc(id):`${esc(modelName(id))} <small class="muted">(${esc(id)})</small>`).join('<div class="model-permission-sep"></div>'):'全部模型';
const refCost=(value,unpriced=0,requests=0)=>`<span class="ref-cost">${value==null||(requests>0&&unpriced===requests)?'未定价':'$'+Number(value).toFixed(5)}</span>${unpriced?`<small class="unpriced-note">${fmt(unpriced)} 次未定价</small>`:''}`;
function toast(msg,error=false){const el=$('toast');el.textContent=String(msg);el.className='show'+(error?' error':'');clearTimeout(toast.timer);toast.timer=setTimeout(()=>{el.className='';el.textContent='';},4300);}
async function api(route,{method='GET',data}={}){
  const r=await fetch('/console/api/'+route,{method,credentials:'same-origin',headers:{Accept:'application/json',...(method==='GET'?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const j=await r.json().catch(()=>({error:{message:'服务器返回无效 JSON'}}));
  if(!r.ok)throw new Error(typeof j.error==='string'?j.error:j.error?.message||`请求失败 (${r.status})`);
  return j;
}
async function startup(){
  try{
    const r=await api('session');
    if(r.loggedIn){csrf=r.csrf;showShell();await refresh();await loadModels().catch(()=>{});}
    else{showLogin();if(!r.configured)toast('还未创建管理员，请先执行安装脚本',true);}
  }catch(e){showLogin();toast('无法连接服务：'+e.message,true);}
}
function showLogin(){$('shell').classList.add('hidden');$('login').classList.remove('hidden');}
function showShell(){$('login').classList.add('hidden');$('shell').classList.remove('hidden');changePage(page);if(!booted){booted=true;setInterval(()=>{if(!$('shell').classList.contains('hidden'))refresh().catch(()=>{});},30000);}}
function changePage(name){if(!labels[name])return;page=name;$('currentPage').textContent=labels[name];document.querySelectorAll('.page').forEach(x=>x.classList.toggle('hidden',x.id!=='page-'+name));document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.page===name));if(name==='models'||name==='pricing')loadModels().catch(e=>toast(e.message,true));if(name==='updates')loadUpdateStatus().catch(e=>toast(e.message,true));}
async function refresh(){state=await api('state');render();}
const idBadge=a=>{
  if(!a.enabled)return status('已停用','off');
  if(a.circuitBreaker?.cooldownUntil && Date.parse(a.circuitBreaker.cooldownUntil)>Date.now())return status('临时隔离','warn');
  if(a.status==='connected' && a.token_expiry && Date.parse(a.token_expiry)<Date.now())return status('Token 已过期','warn');
  if(a.status==='needs_reauth')return status('需要重新登录','warn');
  if(a.status==='connected')return status('已连接','ok');
  if(a.status==='starting')return status('启动中','warn');
  if(a.status==='offline')return status('连接异常','warn');
  if(a.status==='unconnected')return status('待授权','warn');
  if(a.status==='external')return status('旧版外部实例','off');
  return status('未连接','off');
};
function render(){
  if(!state)return;
  const u=state.usage||{};
  const metrics=[['请求次数',fmt(u.requests),'近 30 天'],['输入 Token',fmt(u.input),'按接口返回或估算'],['输出 Token',fmt(u.output),'按接口返回或估算'],['参考成本',money(u.estimatedCost),'非实际账单']];
  $('stats').innerHTML=metrics.map(x=>`<div class="metric"><div class="metric-label">${x[0]}</div><div class="metric-value">${x[1]}</div><div class="metric-foot">${x[2]}</div></div>`).join('');
  renderTrend();
  $('modelDistribution').innerHTML=(state.byModel||[]).length ? state.byModel.slice(0,8).map(m=>{
    const mx=Math.max(1,...(state.byModel||[]).map(v=>v.count));
    return `<div class="distribution-row"><label title="${esc(modelName(m.name))} · ${esc(m.name)}">${esc(modelName(m.name))}</label><div class="distribution-track"><span style="width:${Math.max(3,m.count/mx*100)}%"></span></div><b>${fmt(m.count)} 次</b></div>`;
  }).join(''):empty('尚无模型调用记录');
  const warnings=state.alerts||[];
  $('serviceAlerts').classList.toggle('hidden',!warnings.length);
  $('serviceAlerts').innerHTML=warnings.length?`<div class="alert-banner"><span>⚠ ${warnings.length} 个账号需要处理：${warnings.slice(0,2).map(x=>esc(x.name)).join('、')}${warnings.length>2?' 等':''}</span><button class="action" data-jump="accounts">查看账号</button></div>`:'';
  $('overviewAccounts').innerHTML=(state.accounts||[]).length?state.accounts.slice(0,5).map(a=>`<div class="compact-row"><div><b>${esc(a.name)}</b><small>${a.token_expiry?'令牌到期 '+esc(time(a.token_expiry)):'尚未获取令牌'}</small></div>${idBadge(a)}</div>`).join(''):empty('尚未添加 139 账号');
  const req=(state.requests||[]);
  $('overviewRequests').innerHTML=renderRequests(req.slice(0,6));$('requestTable').innerHTML=renderRequests(req);
  $('accountCount').textContent=(state.accounts||[]).length+' 个账号';
  $('accountTable').innerHTML=table(['账号','状态','Token 到期','自动续期','模型范围','操作'],(state.accounts||[]).map(a=>{
    const renew=a.renewal||{};
    const renewalInfo=renew.requiresReauth?'<span class="status warn">需要重新授权</span>':'<span class="status ok">自动管理</span>';
    const renewalSummary=renew.lastError?'最近一次续期失败':renew.lastSuccessAt?'最近续期成功':'暂无续期记录';
    return `<tr><td><strong>${esc(a.name)}</strong><br><span class="muted small">${a.managed?'独立内置账号':'外部实例'}</span></td><td>${idBadge(a)}</td><td>${esc(time(a.token_expiry))}</td><td><div class="account-renewal">${renewalInfo}<span class="renewal-caption">${esc(renewalSummary)}</span><button class="action" data-action="renew-info" data-id="${esc(a.id)}">查看详情</button></div></td><td>${modelList(a.models)}</td><td><div class="account-actions"><button class="action" data-action="edit-account" data-id="${esc(a.id)}">编辑</button>${a.managed?`<button class="action" data-action="connect" data-id="${esc(a.id)}">授权</button><button class="action" data-action="renew" data-id="${esc(a.id)}">立即续期</button>`:''}<button class="action" data-action="check" data-id="${esc(a.id)}">检查</button><button class="action" data-action="toggle-account" data-id="${esc(a.id)}" data-enabled="${!a.enabled}">${a.enabled?'停用':'启用'}</button><button class="action danger" data-action="delete-account" data-id="${esc(a.id)}">删除</button></div></td></tr>`;
  }));
  $('keyCount').textContent=(state.keys||[]).length+' 个密钥';
  $('keyTable').innerHTML=table(['名称','密钥标识','状态','每日上限','近 30 天请求','近 30 天参考费用','可用模型','操作'],(state.keys||[]).map(k=>{
    const u=state.keyUsage?.[k.id]||{};
    return `<tr><td><strong>${esc(k.name)}</strong><br><span class="muted small">${esc(time(k.createdAt))}</span></td><td><code>${esc(k.prefix)}</code></td><td>${status(k.enabled?'启用':'已停用',k.enabled?'ok':'off')}</td><td>${k.dailyLimit?fmt(k.dailyLimit):'不限制'}</td><td>${fmt(u.requests)}</td><td>${refCost(u.referenceCostUsd??0,u.unpricedRequests||0,u.requests||0)}<small class="muted">按请求时价格估算</small></td><td>${modelList(k.models)}</td><td><div class="actions"><button class="action" data-action="key-usage" data-id="${k.id}">费用详情</button><button class="action" data-action="rotate-key" data-id="${k.id}">重新生成</button><button class="action" data-action="toggle-key" data-id="${k.id}" data-enabled="${!k.enabled}">${k.enabled?'停用':'启用'}</button><button class="action danger" data-action="delete-key" data-id="${k.id}">删除</button></div></td></tr>`;
  }));
  $('apiBaseUrl').textContent=location.origin+'/v1';
  const selectedAccount=$('testAccountId').value;
  $('testAccountId').innerHTML='<option value="">请选择账号</option>'+(state.accounts||[]).filter(x=>x.enabled && x.status==='connected').map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');
  if([...$('testAccountId').options].some(x=>x.value===selectedAccount))$('testAccountId').value=selectedAccount;
  renderPrices();
}
function renderTrend(){
  if(!state)return;
  const data=new Map((state.byDay||[]).map(x=>[x.date,x]));
  const days=Array.from({length:14},(_,i)=>{const d=new Date(Date.now()-(13-i)*86400000);return {key:d.toISOString().slice(0,10),d};});
  const val=d=>{const x=data.get(d.key)||{};return trend==='tokens'?x.tokens||0:trend==='cost'?x.costUsd||0:x.count||0;};
  const max=Math.max(0.0000001,...days.map(val));
  $('activity').innerHTML=days.map(d=>{
    const n=val(d);const suffix=trend==='cost'?' USD':trend==='tokens'?' Token':' 次';
    return `<div class="chart-bar" title="${esc(d.key)} · ${trend==='cost'?Number(n).toFixed(4):fmt(n)}${suffix}" style="height:${Math.max(2,n/max*90)}%"><small>${d.d.getDate()}</small></div>`;
  }).join('');
  document.querySelectorAll('#trendTabs button').forEach(b=>b.classList.toggle('active',b.dataset.trend===trend));
}
$('trendTabs').addEventListener('click',e=>{const b=e.target.closest('[data-trend]');if(!b)return;trend=b.dataset.trend;renderTrend();});
function renderRequests(rows){
  return table(['时间','API Key','账号','模型','Token · 输入/输出','参考费用','响应','耗时'],rows.map(r=>{
    const key=(state.keys||[]).find(k=>k.id===r.keyId)?.name||'后台测试';
    const account=(state.accounts||[]).find(k=>k.id===r.accountId)?.name||'—';
    return `<tr><td>${esc(time(r.time))}</td><td>${esc(key)}</td><td>${esc(account)}</td><td>${modelCell(r.model)}</td><td>${fmt(r.usage?.prompt_tokens)} / ${fmt(r.usage?.completion_tokens)}<br><span class="muted small">${usageLabel(r.usageSource)}</span></td><td>${refCost(r.costUsd, r.costUsd==null?1:0)}</td><td>${status(String(r.status),r.status<400?'ok':'warn')}</td><td>${fmt(r.latencyMs)} ms</td></tr>`;
  }));
}
async function loadModels(){
  if(!state)return;
  try{
    const data=await api('models');
    const selected=$('testModelId').value;
    const m=new Map();for(const r of data.results||[])for(const x of r.models||[])if(x?.id)m.set(x.id,x);
    models=[...m.values()];
    $('testModelId').innerHTML='<option value="">请选择模型</option>'+models.map(m=>`<option value="${esc(m.id)}">${esc(modelName(m.id))} · ${esc(m.id)}</option>`).join('');
    if(models.some(m=>m.id===selected))$('testModelId').value=selected;
    render();
  }catch(e){toast('加载模型失败：'+e.message,true);}
}
function renderPrices(){if(!state)return;
  const ids=new Set([...Object.keys(state.prices||{}),...Object.keys(state.priceMappings||{}),...models.map(x=>x.id)]);
  const sync=state.priceSync||{};
  $('priceSyncStatus').textContent=sync.status==='ok'?`上次同步：${time(sync.updatedAt)} · 匹配 ${sync.matched||0} 个`:sync.status==='error'?'最近同步失败：'+(sync.lastError||'未知错误'):'尚未同步';
  $('pricingTable').innerHTML=table(['模型 ID','输入 / 百万 Token','输出 / 百万 Token','参考来源','操作'],[...ids].map(k=>{
    const x=state.prices?.[k],mapping=state.priceMappings?.[k]||'';
    const label=!x?'未匹配':x.source==='custom_reference'?'手动覆盖':`LiteLLM · ${x.match==='manual_mapping'?'手动映射':'自动匹配'}`;
    return `<tr><td>${modelCell(k)}</td><td>${x?'$'+x.inputUsd:'—'}</td><td>${x?'$'+x.outputUsd:'—'}</td><td><span class="small">${esc(label)}</span><small class="muted">${esc(x?.referenceModelId||mapping)}</small></td><td><div class="actions"><button class="action" data-price-model="${esc(k)}">改价格</button><button class="action" data-map-model="${esc(k)}">改映射</button>${x?.source==='custom_reference'?`<button class="action" data-clear-price="${esc(k)}">恢复自动</button>`:''}</div></td></tr>`;
  }));
}
const openModal=(id)=>$(id).showModal();const closeModal=(id)=>$(id).close();
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('login',{method:'POST',data:{username:f.get('username'),password:f.get('password')}});e.target.reset();await startup();toast('登录成功');}catch(x){toast(x.message,true);}});
$('logout').addEventListener('click',async()=>{try{await api('logout',{method:'POST',data:{}});}catch{}csrf='';showLogin();});
document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>changePage(b.dataset.page)));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
$('overviewRefresh').addEventListener('click',async()=>{try{await refresh();toast('已更新');}catch(e){toast(e.message,true);}});
$('logRefresh').addEventListener('click',()=>refresh().then(()=>toast('已更新')).catch(e=>toast(e.message,true)));
$('openAccount').addEventListener('click',()=>{
  prepareAccountForm('create');openModal('accountModal');
});
function prepareAccountForm(mode,a=null){
  const form=$('accountForm');form.reset();form.elements.id.value=a?.id||'';form.elements.mode.value=mode;
  form.elements.name.value=a?.name||'';form.elements.models.value=(a?.models||[]).join(', ');
  const canEdit=mode!=='connect';
  $('accountNameField').classList.toggle('hidden',!canEdit);$('accountModelsField').classList.toggle('hidden',!canEdit);
  $('accountCredentials').classList.toggle('hidden',mode==='edit');$('accountCredentialHelp').classList.toggle('hidden',mode==='edit');
  $('accountModalTitle').textContent=mode==='edit'?'编辑 139 账号':mode==='connect'?'重新导入账号凭据':'添加 139 账号';
  $('accountSave').textContent=mode==='edit'?'保存修改':mode==='connect'?'验证并更新':'保存并验证';
  form.elements.name.required=canEdit;
}
$('accountForm').addEventListener('submit',async e=>{
  e.preventDefault();const f=new FormData(e.target),id=String(f.get('id')||''),mode=String(f.get('mode'));
  const body={name:String(f.get('name')||'').trim(),models:list(f.get('models')),sid:String(f.get('sid')||'').trim(),cookie:String(f.get('cookie')||'').trim()};
  if(mode!=='edit' && Boolean(body.sid)!==Boolean(body.cookie)){toast('SID 和 Cookie 必须同时填写',true);return;}
  const btn=$('accountSave');btn.disabled=true;btn.textContent='正在保存…';
  try{
    let r;
    if(mode==='edit'){r=await api('accounts/'+id,{method:'PATCH',data:{name:body.name,models:body.models}});}
    else if(mode==='connect'){
      if(!body.sid||!body.cookie)throw new Error('请输入完整 SID 和 Cookie');
      r=await api('accounts/'+id+'/connect',{method:'POST',data:{sid:body.sid,cookie:body.cookie}});
    }else r=await api('accounts',{method:'POST',data:body});
    closeModal('accountModal');e.target.reset();await refresh();
    toast(r.warning?'账号已创建，但验证失败：'+r.warning:mode==='edit'?'账号资料已更新':r.connected||r.ok?'账号已验证并保存':'账号已创建，等待授权',Boolean(r.warning));
    if(r.connected||mode==='connect')await loadModels();
  }catch(x){toast(x.message,true);}finally{btn.disabled=false;btn.textContent='保存';}
});
$('openKey').addEventListener('click',()=>{$('keyForm').reset();openModal('keyModal');});
$('keyForm').addEventListener('submit',async e=>{
  e.preventDefault();const f=new FormData(e.target);
  try{const r=await api('keys',{method:'POST',data:{name:String(f.get('name')),dailyLimit:Number(f.get('dailyLimit')||0),models:list(f.get('models'))}});justCreatedKey=r.key;$('newKeyValue').textContent=r.key;$('keyResultTitle').textContent='API 密钥已创建';closeModal('keyModal');openModal('keyResult');e.target.reset();await refresh();}catch(x){toast(x.message,true);}
});
$('copyNewKey').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(justCreatedKey);toast('密钥已复制');}catch{toast('复制失败，请手动选中密钥',true);}});
$('rotateKeyForm').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target, f=new FormData(form);const id=String(f.get('id')||'');
  try{
    const r=await api('keys/'+id+'/rotate',{method:'POST',data:{password:String(f.get('password')||'')}});
    justCreatedKey=r.key;$('newKeyValue').textContent=r.key;
    $('keyResultTitle').textContent='新 API 密钥（旧密钥已失效）';
    closeModal('rotateKeyModal');form.reset();openModal('keyResult');await refresh();
    toast('已重新生成密钥，请立即保存并更新客户端');
  }catch(e){toast(e.message,true);}
});
$('copyBase').addEventListener('click' ,async()=>{try{await navigator.clipboard.writeText(location.origin+'/v1');toast('API 地址已复制');}catch{toast('复制失败',true);}});
$('reloadModels').addEventListener('click',async()=>{await loadModels();toast('已更新模型列表');});
$('testForm').addEventListener('submit',async e=>{
  e.preventDefault();const f=new FormData(e.target),b=$('testSubmit');
  b.disabled=true;b.textContent='请求中…';$('testResult').textContent='正在等待模型返回…';
  try{const r=await api('test',{method:'POST',data:{accountId:String(f.get('accountId')),model:String(f.get('model')),protocol:String(f.get('protocol')||'chat'),prompt:String(f.get('prompt'))}});$('testResult').textContent=r.reply||'(模型没有返回文本内容)';$('testMeta').textContent=`${r.protocol||'Chat'} · ${fmt(r.latencyMs)} ms · ${fmt(r.usage?.total_tokens)} Token（${usageLabel(r.usageSource)}）`;await refresh();toast('模型测试完成');}
  catch(x){$('testResult').textContent='测试失败：'+x.message;$('testMeta').textContent='请求失败';toast(x.message,true);}finally{b.disabled=false;b.textContent='发送测试';}
});
$('syncPricing').addEventListener('click',async()=>{const b=$('syncPricing');b.disabled=true;b.textContent='同步中…';try{const r=await api('prices/sync',{method:'POST',data:{}});await refresh();toast(`价格同步完成，匹配 ${r.matched} 个；未匹配 ${r.unmatched.length} 个`);}catch(e){await refresh();toast(e.message,true);}finally{b.disabled=false;b.textContent='立即同步参考价';}});
$('mapPrice').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('prices/mapping/'+encodeURIComponent(String(f.get('model'))),{method:'PUT',data:{referenceModelId:String(f.get('referenceModelId')||'')}});await refresh();toast('映射已保存，点击“立即同步参考价”生效');}catch(x){toast(x.message,true);}});
$('setPrice').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('prices/'+encodeURIComponent(String(f.get('model'))),{method:'PUT',data:{inputUsd:Number(f.get('inputUsd')),outputUsd:Number(f.get('outputUsd'))}});await refresh();toast('参考价格已保存');}catch(x){toast(x.message,true);}});
$('changePassword').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('admin/password',{method:'POST',data:{current:String(f.get('current')),next:String(f.get('next'))}});csrf='';e.target.reset();showLogin();toast('管理密码已修改，请重新登录');}catch(x){toast(x.message,true);}});
document.addEventListener('click',async e=>{
  const jump=e.target.closest('[data-jump]');if(jump){changePage(jump.dataset.jump);return;}
  const price=e.target.closest('[data-price-model]');if(price){$('priceModelId').value=price.dataset.priceModel;changePage('pricing');$('priceModelId').focus();return;}
  const mapPrice=e.target.closest('[data-map-model]');if(mapPrice){$('mapModelId').value=mapPrice.dataset.mapModel;$('referenceModelId').value=state?.priceMappings?.[mapPrice.dataset.mapModel]||'';changePage('pricing');$('referenceModelId').focus();return;}
  const clearPrice=e.target.closest('[data-clear-price]');if(clearPrice){try{await api('prices/'+encodeURIComponent(clearPrice.dataset.clearPrice),{method:'DELETE',data:{}});await refresh();toast('已恢复自动定价模式（需重新同步）');}catch(x){toast(x.message,true);}return;}
  const b=e.target.closest('[data-action]');if(!b)return;const {action,id}=b.dataset;
  try{
    const a=state?.accounts?.find(x=>x.id===id);
    if(action==='key-usage'){
      const key=state?.keys?.find(k=>k.id===id);if(!key)return;
      const usage=state?.keyUsage?.[id]||{};
      $('keyUsageTitle').textContent=key.name+' · API Key 用量';
      $('keyUsageSummary').innerHTML=`<div class="key-usage-metrics"><div>30 天请求<b>${fmt(usage.requests)}</b></div><div>输入 / 输出 Token<b>${fmt(usage.input)} / ${fmt(usage.output)}</b></div><div>参考费用<b>${refCost(usage.referenceCostUsd??0,usage.unpricedRequests||0,usage.requests||0)}</b></div></div>`;
      $('keyUsageTable').innerHTML=table(['模型','请求','输入 / 输出 Token','参考费用'],(usage.byModel||[]).sort((a,b)=>b.requests-a.requests).map(v=>`<tr><td>${modelCell(v.model)}</td><td>${fmt(v.requests)}</td><td>${fmt(v.input)} / ${fmt(v.output)}</td><td>${refCost(v.referenceCostUsd??0,v.unpricedRequests,v.requests)}</td></tr>`));
      openModal('keyUsageModal');return;
    }
    if(action==='renew-info'){
      if(!a)return;
      const r=a.renewal||{}, fields=[['当前状态',r.requiresReauth?'登录凭据可能过期，需要重新授权':a.status==='connected'?'已连接':'需要检查'],['Token 到期',time(a.token_expiry)],['检查频率','每 6 小时'],['自动重铸阈值','到期前 24 小时'],['下一次计划检查',time(r.nextCheckAt)],['最近尝试',time(r.lastAttemptAt)],['最近成功',time(r.lastSuccessAt)],['最近失败',r.lastError||'无']];
      $('renewInfoTitle').textContent=a.name+' · 自动续期';
      $('renewInfoBody').innerHTML=fields.map(([label,val])=>`<div><span>${esc(label)}</span><strong>${esc(val)}</strong></div>`).join('');
      openModal('renewInfoModal');return;
    }
    if(action==='rotate-key'){
      if(!confirm('此操作会立即使旧 API Key 失效，确定继续吗？'))return;
      $('rotateKeyForm').reset();$('rotateKeyForm').elements.id.value=id;
      openModal('rotateKeyModal');return;
    }
    if(action==='connect'||action==='edit-account'){prepareAccountForm(action==='connect'?'connect':'edit',a);openModal('accountModal');return;}
    if(action==='check'){const r=await api('accounts/'+id+'/check',{method:'POST',data:{}});toast(r.ok?`账号正常 · Token ${r.token_cached?'已缓存':'未缓存'} · 到期 ${time(r.token_expiry)}`:`账号状态：${r.status||r.httpStatus||'未知'}`,!r.ok);await refresh();return;}
    if(action==='renew'){b.disabled=true;const r=await api('accounts/'+id+'/renew',{method:'POST',data:{}});toast('Token 已重铸，预计到期：'+time(r.expiresAt));await refresh();return;}
    if(action==='delete-account'||action==='delete-key'){
      if(!confirm(action==='delete-account'?'删除账号将同时删除本程序保存的该账号凭据与 Token，确定继续？':'确定删除这个 API Key？'))return;
    }
    let route='',method='';let data={};
    if(action==='toggle-account'){route='accounts/'+id;method='PATCH';data={enabled:b.dataset.enabled==='true'};}
    if(action==='delete-account'){route='accounts/'+id;method='DELETE';}
    if(action==='toggle-key'){route='keys/'+id;method='PATCH';data={enabled:b.dataset.enabled==='true'};}
    if(action==='delete-key'){route='keys/'+id;method='DELETE';}
    if(!route)return;
    await api(route,{method,data});await refresh();toast('操作成功');
  }catch(x){toast(x.message,true);}finally{b.disabled=false;}
});
let updatePoll=null;
function showUpdateDialog(r){
  const d=$('updateModal');if(!d.open)d.showModal();
  updateDialogState(r);
}
function updateDialogState(r){
  if(!r)return;
  const state=r.status||{};const working=r.pending||['queued','running','rollback'].includes(state.state);
  const percent=Number.isFinite(Number(state.progress))?Math.max(0,Math.min(100,Number(state.progress))):0;
  $('updateDialogTitle').textContent=working?'正在更新服务':state.state==='success'?'更新成功':state.state==='error'?'更新失败':'等待更新';
  $('updateDialogVersion').textContent=`${r.installedVersion||'当前版本未知'} → ${r.latestVersion||'GitHub main'}`;
  $('updateProgressFill').style.width=percent+'%';$('updateProgressText').textContent=percent+'%';
  $('updateDialogMessage').textContent=state.message||'正在等待主机更新服务响应…';
  $('updateReload').classList.toggle('hidden',state.state!=='success');
  $('updateDialogHide').textContent=working?'后台继续':'关闭';
  if(!working && (state.state==='error'||state.state==='success'))stopUpdatePolling();
}
function stopUpdatePolling(){if(updatePoll){clearInterval(updatePoll);updatePoll=null;}}
function startUpdatePolling(){
  stopUpdatePolling();updatePoll=setInterval(async()=>{
    try{const r=await loadUpdateStatus();updateDialogState(r);}catch(e){
      $('updateDialogTitle').textContent='服务正在重启';
      $('updateDialogMessage').textContent='暂时无法连接网关，正在重新连接。请勿反复点击更新。';
    }
  },2500);
}
async function loadUpdateStatus(){
  const r=await api('updates'),stat=r.status||{};
  $('updateCurrentVersion').textContent='v'+(r.installedVersion||'未知');
  $('updateInstalled').textContent=r.installedSha?.slice(0,12)||'未知';
  $('updateLatest').textContent=r.latestSha?.slice(0,12)||'无法获取';
  $('updateTargetVersion').textContent=r.latestVersion?'v'+r.latestVersion:'未找到版本信息';
  const label={running:'正在更新',rollback:'正在恢复',success:'已完成',error:'更新失败',queued:'排队中',idle:'尚未更新'};
  $('updateState').textContent=r.pending?'更新进行中':label[stat.state]||'尚未更新';
  $('updateMessage').textContent=stat.message||'—';
  $('updateHint').textContent=!r.enabled?'未启用主机更新服务，请执行新版 install.sh':r.remoteError?'GitHub 检查失败：'+r.remoteError:r.pending?'正在备份、构建或切换服务':r.updateAvailable?'发现新的 GitHub 提交':'当前没有确认的新版本';
  $('updateReleaseTitle').textContent=r.latestTitle||'当前 GitHub 未提供发布说明';
  $('updateReleaseNotes').innerHTML=(r.latestNotes||[]).map(x=>`<li>${esc(x)}</li>`).join('')||'<li>暂无变更说明</li>';
  $('applyUpdate').disabled=!r.enabled||r.pending||!r.updateAvailable;
  return r;
}
$('checkUpdates').addEventListener('click',async()=>{try{await loadUpdateStatus();toast('版本信息已同步');}catch(e){toast(e.message,true);}});
$('applyUpdate').addEventListener('click',async()=>{
  const info=await loadUpdateStatus().catch(()=>null);
  const version=info?.latestVersion?'v'+info.latestVersion:'GitHub 最新提交';
  if(!confirm(`准备更新到 ${version}。服务器会自动备份账号数据、构建镜像、短暂重启并验证服务，失败时尝试回滚。是否继续？`))return;
  try{
    const queued=await api('updates/apply',{method:'POST',data:{}});
    showUpdateDialog({...info,pending:true,status:{state:'queued',progress:3,message:queued.message}});
    startUpdatePolling();
  }catch(e){toast(e.message,true);}
});
$('updateDialogClose').addEventListener('click',()=>$('updateModal').close());
$('updateDialogHide').addEventListener('click',()=>$('updateModal').close());
$('updateReload').addEventListener('click',()=>location.reload());
$('priceSuggest').addEventListener('submit',async e=>{
  e.preventDefault();const id=String(new FormData(e.target).get('model')||'').trim();
  const result=$('priceCandidates');result.textContent='正在查询目录…';
  try{
    const data=await api('prices/candidates?model='+encodeURIComponent(id));
    result.innerHTML=data.candidates.length?data.candidates.map(x=>`<div class="candidate-row"><div><strong>${esc(x.id)}</strong><p class="hint">提供商 ${esc(x.provider)} · 输入 $${Number(x.inputUsd).toFixed(3)} / 1M · 输出 $${Number(x.outputUsd).toFixed(3)} / 1M · ${x.match==='name_equal'?'名称相同':'可能相关'}</p></div><button class="action" data-suggestion="${esc(x.id)}" data-target-model="${esc(id)}">填入映射</button></div>`).join(''):empty('目录中暂无可信候选，可手动查阅供应商价格或不设置。');
  }catch(err){result.textContent=err.message;toast(err.message,true);}
});
document.addEventListener('click',e=>{const b=e.target.closest('[data-suggestion]');if(!b)return;$('mapModelId').value=b.dataset.targetModel;$('referenceModelId').value=b.dataset.suggestion;$('referenceModelId').focus();toast('已填入候选型号。请确认提供商与版本后保存映射');});

startup();
