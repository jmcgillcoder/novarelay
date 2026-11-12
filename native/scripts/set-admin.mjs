import path from 'node:path';
import readline from 'node:readline';
import {Store} from '../lib/storage.mjs';
import {stdin as input, stdout as output} from 'node:process';

if(!process.env.MASTER_KEY || !/^[0-9a-f]{64}$/i.test(process.env.MASTER_KEY)){
  console.error('请先在 .env 中设置 MASTER_KEY');process.exit(1);
}
if(!input.isTTY){console.error('请使用交互式终端执行此命令，以安全输入管理员密码');process.exit(1);}
const store=new Store(process.env.DATA_DIR||path.resolve('data'));
console.log('设置 NovaRelay 管理员（用户名固定为：admin）');
const rl=readline.createInterface({input,output,terminal:true});
const prompt='输入新密码（至少 8 位）：';
rl._writeToOutput=function(str){if(str.includes(prompt))output.write(str);};
const password=await new Promise(resolve=>rl.question(prompt,answer=>resolve(answer)));
output.write('\n');rl.close();
try{store.setAdmin(password);console.log('管理员密码已安全保存。');}
catch(e){console.error(e.message);process.exitCode=1;}
