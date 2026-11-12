import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../lib/storage.mjs';
const store=new Store(process.env.DATA_DIR||path.resolve('data'));
if(store.hasAdmin()){ console.log('管理员已存在，密码保持不变。'); }
else {
  const pass=randomBytes(18).toString('base64url'); // 24 random URL-safe characters
  store.setAdmin(pass);
  console.log('=============================================');
  console.log(' 初始管理员：admin');
  console.log(' 初始密码：'+pass);
  console.log(' 请立即保存。此密码只显示一次。');
  console.log('=============================================');
}
