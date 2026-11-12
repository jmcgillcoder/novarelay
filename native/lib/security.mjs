import {createHash, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv} from 'node:crypto';

export function hashSecret(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
export function timingEqualHex(a, b) {
  if (!a || !b || a.length !== b.length || !/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export function makeSecret(prefix = '') { return prefix + randomBytes(32).toString('base64url'); }
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new Error('密码长度必须为 8–200 个字符');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return {salt, hash};
}
export function verifyPassword(password, stored) {
  if (!stored?.salt || !stored?.hash || typeof password !== 'string') return false;
  const value = scryptSync(password, stored.salt, 64).toString('hex');
  return timingEqualHex(value, stored.hash);
}
function masterKey(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) throw new Error('MASTER_KEY 必须为 64 位十六进制随机字符串');
  return Buffer.from(hex, 'hex');
}
export function encryptSecret(value, master) {
  if (!value) throw new Error('不能为空');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(master), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}
export function decryptSecret(value, master) {
  const [version, iv, tag, data] = (value || '').split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('无法解析上游凭据');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(master), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
export function parseBearer(req) {
  const h = req.headers.authorization || '';
  return h.match(/^Bearer ([^\s]+)$/i)?.[1] || null;
}
export function readCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.includes('=')).map(x => [x.slice(0,x.indexOf('=')), x.slice(x.indexOf('=')+1)]));
}
export function setSessionCookie(res, token, secure = true) {
  res.setHeader('Set-Cookie', `novarelay_session=${token}; HttpOnly; Path=/console; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`);
}
export function clearSessionCookie(res, secure = true) {
  res.setHeader('Set-Cookie', `novarelay_session=; HttpOnly; Path=/console; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
}
export function permittedUpstream(url) {
  try {
    const v = new URL(url);
    if (v.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(v.hostname) || v.username || v.password || v.hash || v.search || !v.port || !/^\d+$/.test(v.port)) return false;
    return v.pathname === '/' || v.pathname === '';
  } catch { return false; }
}
