/** Optional Telegram renewal alerts; fixed official endpoint prevents arbitrary webhook SSRF.
 * This module never sends SID, Cookie, bearer keys or chat prompts.
 */
export function createRenewalNotifier({token=process.env.ALERT_TELEGRAM_BOT_TOKEN,chatId=process.env.ALERT_TELEGRAM_CHAT_ID,fetchFn=fetch}={}){
  const enabled=Boolean(token && chatId && /^\d+:[A-Za-z0-9_-]{20,}$/.test(token) && /^-?\d{4,20}$/.test(String(chatId)));
  return {enabled,async send(label,accountName){
    if(!enabled)return false;
    const name=String(accountName||'账号').slice(0,70).replace(/[\r\n]/g,' ');
    const message=`NovaRelay · ${label}\n账号：${name}\n请登录控制台检查续期状态。`;
    try{
      const r=await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:String(chatId),text:message}),signal:AbortSignal.timeout(10000),redirect:'error'
      });
      return Boolean(r.ok);
    }catch{return false;}
  }};
}
