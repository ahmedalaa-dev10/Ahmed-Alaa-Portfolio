import { digest, keyedHash, randomToken, verifyPassword, readJSON, cookieToken, cookie } from './security.mjs';

const SOURCES = ['linkedin', 'google', 'github', 'facebook', 'email', 'direct', 'other'];
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const MAX_EVENTS = 200;
const SESSION_SECONDS = 12 * 60 * 60;
const fail = (code, status = 400) => Object.assign(new Error(code), { status });
const result = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

function siteConfig(env) {
  let site;
  try { site = new URL(env.SITE_URL); } catch { throw fail('not_configured', 503); }
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || !env.DB || !env.AUTH_SECRET || env.AUTH_SECRET.length < 32 || !env.OWNER_PASSWORD_HASH || !env.OWNER_EMAIL) throw fail('not_configured', 503);
  const prefix = site.pathname.endsWith('/') ? site.pathname : site.pathname + '/';
  return { url: site.href, origin: site.origin, prefix };
}
async function limit(env, request, name, maximum, seconds) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(now / (seconds * 1000));
  const key = await keyedHash(`${name}:${ip}:${bucket}`, env.AUTH_SECRET);
  const row = await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key, (bucket + 1) * seconds * 1000).first();
  if (row.count > maximum) throw Object.assign(fail('rate_limited', 429), { retryAfter: Math.ceil(((bucket + 1) * seconds * 1000 - now) / 1000) });
}
function validateCollect(data, prefix) {
  if (!data || !UUID.test(data.session || '') || typeof data.path !== 'string' || data.path.length > 300 || !data.path.startsWith(prefix) || data.path.includes('?') || data.path.includes('#') || data.path.includes('..') || data.path.includes('\\')) throw fail('invalid_visit');
  if (!data.attribution || !SOURCES.includes(data.attribution.source) || !['utm','referrer','direct'].includes(data.attribution.method)) throw fail('invalid_source');
  for (const value of [data.attribution.medium, data.attribution.campaign]) if (typeof value !== 'string' || !/^[a-z0-9_-]{0,60}$/.test(value)) throw fail('invalid_source');
  if (!['ar','en'].includes(data.lang) || !Array.isArray(data.events) || !data.events.length || data.events.length > 20) throw fail('invalid_events');
  for (const event of data.events) {
    if (!event || !UUID.test(event.id || '') || !['visit','project_open','cv_click','contact_click'].includes(event.type) || typeof event.at !== 'number' || !Number.isFinite(event.at)) throw fail('invalid_event');
    if (event.type === 'visit' && (event.target || event.action)) throw fail('invalid_event');
    if (event.type === 'project_open' && (!['audit','custody'].includes(event.target) || !['gallery','details'].includes(event.action))) throw fail('invalid_event');
    if (event.type === 'cv_click' && (event.target !== 'cv' || event.action !== 'download')) throw fail('invalid_event');
    if (event.type === 'contact_click' && (!['section','email','phone','linkedin'].includes(event.target) || event.action !== (event.target === 'section' ? 'navigate' : 'click'))) throw fail('invalid_event');
  }
}
function device(request) {
  const ua = request.headers.get('User-Agent') || '';
  return /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? 'tablet' : /Mobile|iPhone|Android/i.test(ua) ? 'mobile' : 'desktop';
}
function isBot(request) { return /bot|crawler|spider|preview|headless|facebookexternalhit|curl|wget/i.test(request.headers.get('User-Agent') || ''); }

async function collect(request, env, ctx, config) {
  const origin = request.headers.get('Origin');
  if (origin !== config.origin) throw fail('origin_denied', 403);
  const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } });
  if (request.method !== 'POST') throw fail('method_not_allowed', 405);
  if (isBot(request)) return result({ accepted: true }, 202, cors);
  await limit(env, request, 'collect', 90, 60);
  const data = await readJSON(request);
  validateCollect(data, config.prefix);
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT id FROM visits WHERE id=?').bind(data.session).first();
  const medium = ['social','organic_social','referral','email'].includes(data.attribution.medium) ? data.attribution.medium : '';
  const campaign = ['portfolio','linkedin_profile','linkedin_portfolio'].includes(data.attribution.campaign) ? data.attribution.campaign : '';
  const queries = [env.DB.prepare('INSERT INTO visits(id,created_at,last_seen,source,source_method,medium,campaign,device,lang) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,lang=excluded.lang').bind(data.session, now, now, data.attribution.source, data.attribution.method, medium, campaign, device(request), data.lang)];
  for (const event of data.events) queries.push(env.DB.prepare('INSERT OR IGNORE INTO events(id,visit_id,created_at,type,target,action) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM events WHERE visit_id=?)<?').bind(event.id, data.session, now, event.type, event.target || '', event.action || '', data.session, MAX_EVENTS));
  if (!existing) queries.push(env.DB.prepare('INSERT OR IGNORE INTO notifications(visit_id,status,due_at) VALUES (?,?,?)').bind(data.session, env.NOTIFICATION_CHANNEL === 'off' ? 'disabled' : 'pending', now));
  await env.DB.batch(queries);
  if (!existing && env.NOTIFICATION_CHANNEL !== 'off') ctx.waitUntil(deliverNotifications({ ...env, SERVICE_URL: new URL(request.url).origin }));
  return result({ accepted: true }, 202, cors);
}

async function ownerSession(request, env) {
  const token = cookieToken(request);
  if (!token) throw fail('unauthorized', 401);
  const hash = await keyedHash(token, env.AUTH_SECRET);
  const version = await digest(env.OWNER_PASSWORD_HASH + env.OWNER_EMAIL.toLowerCase());
  const row = await env.DB.prepare('SELECT token_hash FROM owner_sessions WHERE token_hash=? AND expires_at>? AND credential_version=?').bind(hash, Date.now(), version).first();
  if (!row) throw fail('unauthorized', 401);
  return hash;
}
function sameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw fail('origin_denied', 403);
}
async function login(request, env) {
  sameOrigin(request);
  await limit(env, request, 'login', 8, 900);
  const data = await readJSON(request, 2048);
  if (typeof data?.email !== 'string' || data.email.length > 254 || typeof data.password !== 'string' || data.password.length > 256) throw fail('invalid_credentials', 401);
  const validPassword = await verifyPassword(data.password, env.OWNER_PASSWORD_HASH);
  if (!validPassword || data.email.trim().toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) throw fail('invalid_credentials', 401);
  const token = randomToken();
  const version = await digest(env.OWNER_PASSWORD_HASH + env.OWNER_EMAIL.toLowerCase());
  await env.DB.prepare('INSERT INTO owner_sessions(token_hash,credential_version,expires_at) VALUES (?,?,?)').bind(await keyedHash(token, env.AUTH_SECRET), version, Date.now() + SESSION_SECONDS * 1000).run();
  return result({ email: env.OWNER_EMAIL }, 200, { 'Set-Cookie': cookie(token, SESSION_SECONDS) });
}
function range(url) {
  const days = [1,7,30,90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
  const source = SOURCES.includes(url.searchParams.get('source')) ? url.searchParams.get('source') : '';
  const clause = 'v.created_at>=?' + (source ? ' AND v.source=?' : '');
  const args = [Date.now() - days * 86400000, ...(source ? [source] : [])];
  return { days, source, clause, args };
}
async function summary(url, env) {
  const f = range(url);
  const [totals, sources, projects, daily, errors] = await env.DB.batch([
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM visits v WHERE ${f.clause}) AS visits, COUNT(CASE WHEN e.type='project_open' THEN 1 END) AS project_opens, COUNT(CASE WHEN e.type='cv_click' THEN 1 END) AS cv_clicks, COUNT(CASE WHEN e.type='contact_click' AND e.target!='section' THEN 1 END) AS contact_clicks FROM events e JOIN visits v ON v.id=e.visit_id WHERE ${f.clause}`).bind(...f.args, ...f.args),
    env.DB.prepare(`SELECT v.source,COUNT(*) AS total FROM visits v WHERE ${f.clause} GROUP BY v.source ORDER BY total DESC`).bind(...f.args),
    env.DB.prepare(`SELECT e.target,COUNT(*) AS total,COUNT(DISTINCT e.visit_id) AS visits FROM events e JOIN visits v ON v.id=e.visit_id WHERE ${f.clause} AND e.type='project_open' GROUP BY e.target ORDER BY total DESC`).bind(...f.args),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d',v.created_at/1000,'unixepoch') AS day,COUNT(*) AS total FROM visits v WHERE ${f.clause} GROUP BY day ORDER BY day`).bind(...f.args),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM notifications n JOIN visits v ON v.id=n.visit_id WHERE ${f.clause} AND n.status='failed'`).bind(...f.args),
  ]);
  return result({ days: f.days, source: f.source, totals: totals.results[0], sources: sources.results, projects: projects.results, daily: daily.results, failed_notifications: errors.results[0].total });
}
async function visits(url, env) {
  const f = range(url);
  const page = Math.min(10000, Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`SELECT v.*,COALESCE(n.status,'disabled') AS notification,(SELECT COUNT(*) FROM events e WHERE e.visit_id=v.id AND e.type='project_open') AS project_opens,(SELECT COUNT(*) FROM events e WHERE e.visit_id=v.id AND e.type='cv_click') AS cv_clicks,(SELECT COUNT(*) FROM events e WHERE e.visit_id=v.id AND e.type='contact_click' AND e.target!='section') AS contact_clicks FROM visits v LEFT JOIN notifications n ON n.visit_id=v.id WHERE ${f.clause} ORDER BY v.created_at DESC,v.id LIMIT 25 OFFSET ?`).bind(...f.args, (page - 1) * 25),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM visits v WHERE ${f.clause}`).bind(...f.args),
  ]);
  return result({ rows: rows.results, total: count.results[0].total, page, page_size: 25 });
}

async function notificationRequest(env, visit, test = false) {
  const time = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(visit.created_at));
  const method = visit.source_method === 'utm' ? 'وسم الرابط' : visit.source_method === 'referrer' ? 'المُحيل' : 'زيارة مباشرة';
  const text = test ? `اختبار تنبيهات البورتفوليو — Ahmed Alaa\nتم توصيل التنبيه إلى حسابك. لا يمثل هذا التنبيه زيارة حقيقية.\nالوقت: ${time}\nلوحة المتابعة: ${env.SERVICE_URL || ''}/owner` : `زيارة جديدة للبورتفوليو\nالوقت: ${time}\nالمصدر: ${visit.source}\nتحديد المصدر: ${method}\nالجهاز: ${visit.device}\nاللغة: ${visit.lang}\nرقم الزيارة: ${visit.id.slice(0, 8)}\nلوحة المتابعة: ${env.SERVICE_URL || ''}/owner`;
  if (env.NOTIFICATION_CHANNEL === 'telegram') {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN || '') || !/^\d+$/.test(env.TELEGRAM_CHAT_ID || '')) throw fail('notification_not_configured');
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(8000) });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw fail('telegram_delivery_failed');
  } else if (env.NOTIFICATION_CHANNEL === 'email') {
    if (!env.RESEND_API_KEY || !env.NOTIFY_FROM || !env.NOTIFY_TO) throw fail('notification_not_configured');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Idempotency-Key': `${test ? 'test' : 'visit'}-${visit.id}` }, body: JSON.stringify({ from: env.NOTIFY_FROM, to: [env.NOTIFY_TO], subject: `${test ? 'اختبار التنبيه' : 'زيارة جديدة'} — Ahmed Alaa Portfolio`, text }), signal: AbortSignal.timeout(8000) });
    const body = await response.json();
    if (!response.ok || !body.id) throw fail('email_delivery_failed');
  } else throw fail('notification_not_configured');
}
export async function deliverNotifications(env) {
  const now = Date.now();
  const due = await env.DB.prepare("SELECT visit_id FROM notifications WHERE (status='pending' AND due_at<=?) OR (status='sending' AND lease_until<=?) ORDER BY due_at LIMIT 5").bind(now, now).all();
  await Promise.all(due.results.map(async ({ visit_id }) => {
    const claimTime = Date.now();
    const claimed = await env.DB.prepare("UPDATE notifications SET status='sending',lease_until=?,attempts=attempts+1 WHERE visit_id=? AND ((status='pending' AND due_at<=?) OR (status='sending' AND lease_until<=?)) RETURNING attempts").bind(claimTime + 60000, visit_id, claimTime, claimTime).first();
    if (!claimed) return;
    try {
      const visit = await env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visit_id).first();
      if (!visit) return;
      await notificationRequest(env, visit);
      await env.DB.prepare("UPDATE notifications SET status='sent',sent_at=?,lease_until=0,error_code='' WHERE visit_id=?").bind(Date.now(), visit_id).run();
    } catch (error) {
      const code = ['notification_not_configured','telegram_delivery_failed','email_delivery_failed'].includes(error.message) ? error.message : 'delivery_unavailable';
      const failed = claimed.attempts >= 5 || code === 'notification_not_configured';
      await env.DB.prepare('UPDATE notifications SET status=?,due_at=?,lease_until=0,error_code=? WHERE visit_id=?').bind(failed ? 'failed' : 'pending', Date.now() + Math.min(3600000, 60000 * 2 ** claimed.attempts), code, visit_id).run();
    }
  }));
}
export async function cleanup(env) {
  const retention = Math.min(365, Math.max(7, Number(env.RETENTION_DAYS) || 90));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM visits WHERE created_at<?').bind(now - retention * 86400000),
    env.DB.prepare('DELETE FROM owner_sessions WHERE expires_at<=?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(now),
  ]);
}
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && ['/owner','/owner/','/owner.js','/owner.css'].includes(url.pathname)) {
    const filename = url.pathname.startsWith('/owner.') ? url.pathname : '/index.html';
    return env.UI_ASSETS.fetch(new Request(url.origin + filename, request));
  }
  if (request.method === 'GET' && url.pathname === '/') return Response.redirect(url.origin + '/owner', 302);
  const config = siteConfig(env);
  if (url.pathname === '/api/collect') return collect(request, env, ctx, config);
  if (!url.pathname.startsWith('/api/owner/')) throw fail('not_found', 404);
  if (url.pathname === '/api/owner/login' && request.method === 'POST') return login(request, env);
  const sessionHash = await ownerSession(request, env);
  if (request.method !== 'GET') sameOrigin(request);
  if (request.method === 'GET' && url.pathname === '/api/owner/me') return result({ email: env.OWNER_EMAIL, site_url: config.url, notification_channel: env.NOTIFICATION_CHANNEL || 'off', retention_days: Math.min(365, Math.max(7, Number(env.RETENTION_DAYS) || 90)) });
  if (request.method === 'POST' && url.pathname === '/api/owner/logout') {
    await env.DB.prepare('DELETE FROM owner_sessions WHERE token_hash=?').bind(sessionHash).run();
    return result({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (request.method === 'GET' && url.pathname === '/api/owner/summary') return summary(url, env);
  if (request.method === 'GET' && url.pathname === '/api/owner/visits') return visits(url, env);
  if (request.method === 'POST' && url.pathname === '/api/owner/notification-test') {
    await limit(env, request, 'notification_test', 3, 60);
    await notificationRequest({ ...env, SERVICE_URL: url.origin }, { created_at: Date.now(), id: crypto.randomUUID() }, true);
    return result({ delivered: true });
  }
  const detail = /^\/api\/owner\/visits\/([\da-f-]{36})$/.exec(url.pathname);
  if (detail && UUID.test(detail[1]) && request.method === 'GET') {
    const visit = await env.DB.prepare('SELECT v.*,n.status AS notification,n.error_code AS notification_error FROM visits v LEFT JOIN notifications n ON n.visit_id=v.id WHERE v.id=?').bind(detail[1]).first();
    if (!visit) throw fail('not_found', 404);
    const events = await env.DB.prepare('SELECT created_at,type,target,action FROM events WHERE visit_id=? ORDER BY created_at,rowid LIMIT 200').bind(detail[1]).all();
    return result({ visit, events: events.results });
  }
  const retry = /^\/api\/owner\/notifications\/([\da-f-]{36})\/retry$/.exec(url.pathname);
  if (retry && UUID.test(retry[1]) && request.method === 'POST') {
    await limit(env, request, 'retry', 10, 60);
    const row = await env.DB.prepare("UPDATE notifications SET status='pending',attempts=0,due_at=?,error_code='' WHERE visit_id=? AND status='failed' RETURNING visit_id").bind(Date.now(), retry[1]).first();
    if (!row) throw fail('not_retryable', 409);
    ctx.waitUntil(deliverNotifications(env));
    return result({ queued: true }, 202);
  }
  throw fail('not_found', 404);
}
function secure(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, headers });
}
export default {
  async fetch(request, env, ctx) {
    try { return secure(await handle(request, env, ctx)); }
    catch (error) {
      const code = error.status ? error.message : 'service_unavailable';
      const headers = {};
      try { if (new URL(request.url).pathname === '/api/collect' && request.headers.get('Origin') === siteConfig(env).origin) { headers['Access-Control-Allow-Origin'] = request.headers.get('Origin'); headers['Vary'] = 'Origin'; } } catch {}
      if (error.status === 429) headers['Retry-After'] = String(error.retryAfter || 60);
      return secure(result({ error: code }, error.status || 503, headers));
    }
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(Promise.all([deliverNotifications(env), cleanup(env)])); },
};
