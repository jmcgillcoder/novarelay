import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const SOURCE='https://api.github.com/repos/jmcgillcoder/novarelay/commits/main';
const NOTES='https://raw.githubusercontent.com/jmcgillcoder/novarelay/main/native/release.json';
const dirname=path.dirname(fileURLToPath(import.meta.url));
const getJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
export const updaterFiles=dir=>({request:path.join(dir,'update-request.json'),inflight:path.join(dir,'update-inflight.json'),status:path.join(dir,'update-status.json'),deployed:path.join(dir,'deployed-version.json'),ready:path.join(dir,'host-updater-enabled')});
let cache={at:0,sha:null,version:null,title:'',notes:[],updatedAt:null,error:null};
export async function updateInfo(dataDir,{remote=false,fetchFn=fetch}={}){
  const files=updaterFiles(dataDir), deployed=getJson(files.deployed)||{}, status=getJson(files.status)||{state:'idle',step:'idle',progress:0,message:'尚未执行在线更新'};
  const pkg=getJson(path.resolve(dirname,'../package.json'))||{};
  if(remote && Date.now()-cache.at>120000){
    const next={...cache,at:Date.now(),error:null};
    try{
      const resp=await fetchFn(SOURCE,{signal:AbortSignal.timeout(9000),headers:{Accept:'application/vnd.github+json','User-Agent':'NovaRelay-Updater/1.0'}});
      if(!resp.ok)throw new Error('GitHub HTTP '+resp.status);
      const json=await resp.json();if(!/^[0-9a-f]{40}$/.test(json?.sha||''))throw new Error('GitHub 返回的提交号无效');
      next.sha=json.sha;next.updatedAt=json.commit?.committer?.date||null;
      // Release metadata is advisory; failure must not prevent update checks.
      try{
        const nr=await fetchFn(NOTES,{signal:AbortSignal.timeout(9000)});
        if(nr.ok){const info=await nr.json();if(/^\d+\.\d+\.\d+$/.test(info.version||'')){
          next.version=info.version;next.title=String(info.title||'').slice(0,100);
          next.notes=Array.isArray(info.notes)?info.notes.filter(n=>typeof n==='string').slice(0,8).map(n=>n.slice(0,200)):[];
        }}
      }catch{}
    }catch(e){next.error=String(e.message||e).slice(0,120);}
    cache=next;
  }
  const queued=fs.existsSync(files.request),inflight=fs.existsSync(files.inflight);
  const last=Date.parse(status.updatedAt||'')||0;
  const stale=Boolean(inflight&&last&&Date.now()-last>20*60000);
  const isUpdating=Boolean(!stale&&(queued||inflight||(['queued','running','rollback'].includes(status.state)&&last>0&&Date.now()-last<20*60000)));
  if(stale){status.state='error';status.progress=100;status.message='更新任务长时间未响应，请在服务器查看 novarelay-updater 服务日志';}
  return {enabled:fs.existsSync(files.ready),pending:isUpdating,installedSha:deployed.sha||null,installedVersion:pkg.version||deployed.version||null,installedAt:deployed.at||null,
    latestSha:cache.sha,latestVersion:cache.version,latestTitle:cache.title,latestNotes:cache.notes,latestAt:cache.updatedAt,remoteError:cache.error,
    updateAvailable:Boolean(cache.sha&&deployed.sha&&cache.sha!==deployed.sha),status};
}
export function queueUpdate(dataDir){
  const f=updaterFiles(dataDir);
  if(!fs.existsSync(f.ready))throw Object.assign(new Error('服务器尚未安装主机更新服务，请执行最新版 install.sh'),{status:503});
  if(fs.existsSync(f.request)||fs.existsSync(f.inflight))throw Object.assign(new Error('已有更新正在进行'),{status:409});
  const request={id:randomUUID(),requestedAt:new Date().toISOString(),action:'update_main'};
  fs.writeFileSync(f.request,JSON.stringify(request)+'\n',{flag:'wx',mode:0o600});
  return {queued:true,id:request.id,message:'更新已排队，服务器将先构建镜像、制作备份，再短暂重启进行健康检查'};
}
