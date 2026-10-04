const encoder = new TextEncoder();
export function hex(bytes) { return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''); }
export async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
export function randomToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export async function keyedHash(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
export async function passwordHash(password, saltHex, iterations = 100000) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(pair => parseInt(pair, 16)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256));
}
export async function verifyPassword(password, saved) {
  const [algorithm, count, salt, expected] = String(saved).split('$');
  if (algorithm !== 'pbkdf2-sha256' || count !== '100000' || !/^[\da-f]{32}$/.test(salt || '') || !/^[\da-f]{64}$/.test(expected || '')) return false;
  const actual = await passwordHash(password, salt, Number(count));
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}
export async function readJSON(request, limit = 8192) {
  if (Number(request.headers.get('Content-Length') || 0) > limit) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  if (!request.body) throw Object.assign(new Error('invalid_json'), { status: 400 });
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw Object.assign(new Error('payload_too_large'), { status: 413 }); }
    chunks.push(value);
  }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}
export function cookieToken(request) {
  const value = String(request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith('__Host-aa_owner='))?.slice('__Host-aa_owner='.length);
  return /^[\da-f]{64}$/.test(value || '') ? value : '';
}
export function cookie(value, seconds) { return `__Host-aa_owner=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`; }
