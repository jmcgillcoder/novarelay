/** One isolated 139 account per Node child process. Requires the MIT upstream engine. */
import {pathToFileURL} from 'node:url';
import path from 'node:path';

let gw;
try {
  const entry = process.env.LINGXI_ENGINE_PATH || path.join(process.cwd(),'vendor/lingxi-gateway/gateway/app.mjs');
  const engine = await import(pathToFileURL(entry).href);
  gw = engine.createGateway({dataDir:process.env.LINGXI_ACCOUNT_DIR, port:0, adminToken:process.env.LINGXI_CHILD_ADMIN});
  const port = await gw.start(0);
  process.send?.({type:'ready',port});
  // Upstream refreshes on demand. This timer also proactively refreshes before expiry.
  const timer = setInterval(async()=>{
    try {
      const creds=gw.getCredentials();
      if (!creds.sid || !creds.cookie) return;
      const expiry=gw.tokens.cache?.expiryMs || 0;
      if(expiry - Date.now() <= 24*3600*1000){
        await gw.tokens.get();
        process.send?.({type:'token',expiresAt:gw.tokens.cache?.expiryMs||null});
      }
    } catch(e) {
      process.send?.({type:'token-error',message:String(e.message||e).slice(0,220)});
    }
  },6*3600*1000);
  timer.unref();
  process.on('message', async m=>{
    if(m?.type!=='renew'||typeof m.id!=='string')return;
    try{
      // Force mint without clearing a still-valid cached token on failure.
      const t=await gw.tokens.get(true);
      process.send?.({type:'renew-result',id:m.id,ok:true,expiresAt:t.expiryMs?new Date(t.expiryMs).toISOString():null});
    }catch(e){
      process.send?.({type:'renew-result',id:m.id,ok:false,error:String(e?.message||e).slice(0,220)});
    }
  });
} catch (error) {
  process.send?.({type:'fatal',message:String(error.stack || error).slice(0,2000)});
  process.exitCode=1;
}
for(const s of ['SIGTERM','SIGINT'])process.on(s,async()=>{
  await gw?.stop().catch(()=>{});
  process.exit(0);
});
