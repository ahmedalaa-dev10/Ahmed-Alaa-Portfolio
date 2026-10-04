import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { passwordHash } from '../src/security.mjs';
import { cleanup } from '../src/worker.mjs';

const service = 'https://private-visits.example';
const portfolio = 'https://owner.github.io';
const password = 'Test fixture password 2026!';
let mf, db, session, saved;
let delivery = [];
let deliveryMode = 'ok';
let settings;
const uuid = () => randomUUID();
const payload = (id=uuid(), events=[{id:uuid(),type:'visit',at:Date.now()}],source='linkedin') => ({session:id,path:'/portfolio/',lang:'ar',attribution:{source,method:source==='direct'?'direct':'utm',medium:source==='direct'?'':'social',campaign:source==='direct'?'':'portfolio'},events});
function send(path,{method='GET',body,cookie,origin,ip='198.51.100.1',ua='Mozilla/5.0 Desktop'}={}) {
  return mf.dispatchFetch(service+path,{method,headers:{...(origin?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),'CF-Connecting-IP':ip,'User-Agent':ua,...(body!==undefined?{'Content-Type':'text/plain;charset=UTF-8'}:{})},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
}
async function owner(path,options={}) {return send('/api/owner/'+path,{cookie:session,...options});}
async function configure() { await mf.setOptions(settings); db = await mf.getD1Database('DB'); }
async function until(predicate) {for(let i=0;i<80;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Notification did not reach expected state');}
before(async()=>{
  const salt='f'.repeat(32);saved='pbkdf2-sha256$100000$'+salt+'$'+await passwordHash(password,salt);
  settings={modules:true,scriptPath:new URL('../src/worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-05-15',d1Databases:['DB'],bindings:{SITE_URL:portfolio+'/portfolio/',OWNER_EMAIL:'owner@example.invalid',OWNER_PASSWORD_HASH:saved,AUTH_SECRET:'a'.repeat(64),SERVICE_URL:service,NOTIFICATION_CHANNEL:'telegram',TELEGRAM_BOT_TOKEN:'12345:test_fixture_token',TELEGRAM_CHAT_ID:'99999',RETENTION_DAYS:'90'},serviceBindings:{UI_ASSETS:async request=>new Response(request.url.endsWith('/index.html')?await readFile(new URL('../ui/index.html',import.meta.url),'utf8'):'/* owner asset */',{headers:{'Content-Type':request.url.endsWith('.html')?'text/html':'text/plain'}})},outboundService:async request=>{
    const url=new URL(request.url);
    assert.ok(url.hostname==='api.telegram.org'||url.hostname==='api.resend.com','Unexpected external request');
    delivery.push({url:url.pathname,body:await request.json(),headers:Object.fromEntries(request.headers)});
    if(deliveryMode==='fail')return Response.json({ok:false},{status:503});
    await new Promise(resolve=>setTimeout(resolve,15));
    return Response.json(url.hostname==='api.telegram.org'?{ok:true,result:{message_id:delivery.length}}:{id:'test-email-id'});
  }};
  mf=new Miniflare(settings);db=await mf.getD1Database('DB');
  const sql=await readFile(new URL('../migrations/0001_visits.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').filter(text=>text.trim()))await db.prepare(statement).run();
});
after(async()=>{await mf?.dispose();});

test('anonymous users cannot read logs, summaries, details or account metadata',async()=>{
  for(const path of ['summary','visits','me','visits/'+uuid()]){
    const response=await send('/api/owner/'+path);assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'unauthorized'});
  }
});
test('login page contains no analytics data and security headers prohibit embedding',async()=>{
  const response=await send('/owner');assert.equal(response.status,200);assert.equal(response.headers.get('X-Frame-Options'),'DENY');assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(await response.text(),/login-form/);
});
test('login rejects cross-site requests and invalid credentials',async()=>{
  const wrongOrigin=await send('/api/owner/login',{method:'POST',origin:portfolio,body:{email:'owner@example.invalid',password}});assert.equal(wrongOrigin.status,403);
  for(const credentials of [{email:'owner@example.invalid',password:'wrong'},{email:'someone@example.invalid',password}]){
    const response=await send('/api/owner/login',{method:'POST',origin:service,body:credentials});assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'invalid_credentials'});
  }
});
test('owner authenticates with a protected cookie; raw session tokens are not stored',async()=>{
  const response=await send('/api/owner/login',{method:'POST',origin:service,body:{email:'OWNER@example.invalid',password}});
  assert.equal(response.status,200);const cookie=response.headers.get('Set-Cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);session=cookie.split(';')[0];
  const row=await db.prepare('SELECT * FROM owner_sessions').first();assert.notEqual(row.token_hash,session.split('=')[1]);
  const me=await owner('me');assert.equal(me.status,200);assert.equal((await me.json()).email,'owner@example.invalid');
});
test('LinkedIn visits and project/CV/contact events are recorded, replays stay deduplicated',async()=>{
  const id=uuid(),events=[{id:uuid(),type:'visit',at:Date.now()},{id:uuid(),type:'project_open',target:'audit',action:'gallery',at:Date.now()},{id:uuid(),type:'cv_click',target:'cv',action:'download',at:Date.now()},{id:uuid(),type:'contact_click',target:'email',action:'click',at:Date.now()}];
  const data=payload(id,events);
  for(let i=0;i<2;i++){const response=await send('/api/collect',{method:'POST',origin:portfolio,body:data});assert.equal(response.status,202);assert.equal(response.headers.get('Access-Control-Allow-Origin'),portfolio);}
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM visits WHERE id=?').bind(id).first()).total,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM events WHERE visit_id=?').bind(id).first()).total,4);
  const visit=await db.prepare('SELECT * FROM visits WHERE id=?').bind(id).first();assert.equal(visit.source,'linkedin');assert.equal(visit.source_method,'utm');
  assert.ok(!Object.hasOwn(visit,'ip'));assert.ok(!Object.hasOwn(visit,'user_agent'));
  await until(async()=>((await db.prepare('SELECT status FROM notifications WHERE visit_id=?').bind(id).first())?.status==='sent'));
  assert.equal(delivery.filter(item=>item.body.text?.includes(id.slice(0,8))).length,1);
});
test('concurrent initial visits for one session generate one log and one notification',async()=>{
  const id=uuid(),data=payload(id);
  const responses=await Promise.all([1,2,3].map(()=>send('/api/collect',{method:'POST',origin:portfolio,body:data})));
  assert.ok(responses.every(response=>response.status===202));
  await until(async()=>((await db.prepare('SELECT status FROM notifications WHERE visit_id=?').bind(id).first())?.status==='sent'));
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM visits WHERE id=?').bind(id).first()).total,1);
  assert.equal(delivery.filter(item=>item.body.text?.includes(id.slice(0,8))).length,1);
});
test('collector enforces Origin, portfolio subpath, event allowlist and payload limit',async()=>{
  assert.equal((await send('/api/collect',{method:'POST',origin:'https://attacker.invalid',body:payload()})).status,403);
  assert.equal((await send('/api/collect',{method:'POST',body:payload()})).status,403);
  const wrongPath=payload();wrongPath.path='/other-repo/';assert.equal((await send('/api/collect',{method:'POST',origin:portfolio,body:wrongPath})).status,400);
  const malicious=payload();malicious.events=[{id:uuid(),at:Date.now(),type:'project_open',target:'<script>alert(1)</script>',action:'gallery'}];assert.equal((await send('/api/collect',{method:'POST',origin:portfolio,body:malicious})).status,400);
  assert.equal((await send('/api/collect',{method:'POST',origin:portfolio,body:'x'.repeat(9000)})).status,413);
  assert.equal((await send('/api/collect',{origin:portfolio})).status,405);
});
test('preflight is restricted; preview bots produce no recorded visit',async()=>{
  const preflight=await send('/api/collect',{method:'OPTIONS',origin:portfolio});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Methods'),'POST');assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'),null);
  const id=uuid();const response=await send('/api/collect',{method:'POST',origin:portfolio,ua:'LinkedInBot',body:payload(id)});assert.equal(response.status,202);assert.equal(await db.prepare('SELECT * FROM visits WHERE id=?').bind(id).first(),null);
});
test('unknown campaign/medium fields are not retained and metadata is preserved across reloads',async()=>{
  const id=uuid(),data=payload(id);data.attribution.campaign='person_name';data.attribution.medium='01000000000';
  await send('/api/collect',{method:'POST',origin:portfolio,body:data});
  const follow=payload(id,[{id:uuid(),type:'cv_click',target:'cv',action:'download',at:Date.now()}],'direct');
  await send('/api/collect',{method:'POST',origin:portfolio,body:follow});
  const row=await db.prepare('SELECT * FROM visits WHERE id=?').bind(id).first();assert.equal(row.source,'linkedin');assert.equal(row.campaign,'');assert.equal(row.medium,'');
});
test('source filter applies to counts, rows and project statistics consistently',async()=>{
  await send('/api/collect',{method:'POST',origin:portfolio,body:payload(uuid(),[{id:uuid(),type:'visit',at:Date.now()}],'direct')});
  const summary=await (await owner('summary?days=7&source=linkedin')).json();const rows=await (await owner('visits?days=7&source=linkedin')).json();
  assert.equal(summary.totals.visits,rows.total);assert.ok(rows.rows.every(row=>row.source==='linkedin'));assert.ok(summary.sources.every(row=>row.source==='linkedin'));assert.equal(summary.totals.cv_clicks,2);
  const everyone=await(await owner('summary?days=7')).json();assert.ok(everyone.totals.visits>summary.totals.visits);
  assert.equal((await owner("summary?source='OR%201=1--")).status,200);
});
test('visit activity order is preserved within a batch and details are owner-only',async()=>{
  const id=uuid(),data=payload(id,[{id:uuid(),type:'visit',at:Date.now()},{id:uuid(),type:'project_open',target:'custody',action:'details',at:Date.now()},{id:uuid(),type:'cv_click',target:'cv',action:'download',at:Date.now()}]);
  await send('/api/collect',{method:'POST',origin:portfolio,body:data});
  const detail=await(await owner('visits/'+id)).json();assert.deepEqual(detail.events.map(event=>event.type),['visit','project_open','cv_click']);
  assert.equal((await send('/api/owner/visits/'+id)).status,401);
});
test('failed notifications are retained for retry; retries require owner plus same Origin',async()=>{
  deliveryMode='fail';const id=uuid();await send('/api/collect',{method:'POST',origin:portfolio,body:payload(id)});
  await until(async()=>((await db.prepare('SELECT status FROM notifications WHERE visit_id=?').bind(id).first())?.status==='pending'));
  await db.prepare("UPDATE notifications SET status='failed' WHERE visit_id=?").bind(id).run();
  assert.equal((await send('/api/owner/notifications/'+id+'/retry',{method:'POST',origin:service,body:'{}'})).status,401);
  assert.equal((await owner('notifications/'+id+'/retry',{method:'POST',origin:portfolio,body:'{}'})).status,403);
  deliveryMode='ok';const retry=await owner('notifications/'+id+'/retry',{method:'POST',origin:service,body:'{}'});assert.equal(retry.status,202);
  await until(async()=>((await db.prepare('SELECT status FROM notifications WHERE visit_id=?').bind(id).first())?.status==='sent'));
});
test('notification test sends no fake visit into the dashboard',async()=>{
  const before=(await db.prepare('SELECT COUNT(*) AS total FROM visits').first()).total;
  const response=await owner('notification-test',{method:'POST',origin:service,body:'{}'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{delivered:true});
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM visits').first()).total,before);assert.match(delivery.at(-1).body.text,/لا يمثل هذا التنبيه زيارة حقيقية/);
});
test('email notifications use server credentials and an idempotency key',async()=>{
  settings.bindings.NOTIFICATION_CHANNEL='email';settings.bindings.RESEND_API_KEY='test-fixture-resend';settings.bindings.NOTIFY_FROM='Portfolio <owner@example.invalid>';settings.bindings.NOTIFY_TO='owner@example.invalid';
  await configure();
  const id=uuid();const response=await send('/api/collect',{method:'POST',origin:portfolio,body:payload(id)});assert.equal(response.status,202);
  await until(async()=>((await db.prepare('SELECT status FROM notifications WHERE visit_id=?').bind(id).first())?.status==='sent'));
  const email=delivery.find(item=>item.headers['idempotency-key']==='visit-'+id);assert.ok(email);assert.deepEqual(email.body.to,['owner@example.invalid']);assert.equal(email.headers.authorization,'Bearer test-fixture-resend');
  settings.bindings.NOTIFICATION_CHANNEL='telegram';await configure();
});
test('missing or non-private Telegram destination fails closed without sending to a group',async()=>{
  const before=delivery.length;
  settings.bindings.TELEGRAM_CHAT_ID='-123456';await configure();
  const id=uuid();await send('/api/collect',{method:'POST',origin:portfolio,body:payload(id)});
  await until(async()=>((await db.prepare('SELECT status FROM notifications WHERE visit_id=?').bind(id).first())?.status==='failed'));
  const notification=await db.prepare('SELECT error_code FROM notifications WHERE visit_id=?').bind(id).first();assert.equal(notification.error_code,'notification_not_configured');assert.equal(delivery.length,before);
  settings.bindings.TELEGRAM_CHAT_ID='99999';await configure();
});
test('login throttling survives different cookies and collector abuse is limited',async()=>{
  let latest;
  for(let i=0;i<9;i++)latest=await send('/api/owner/login',{method:'POST',origin:service,ip:'198.51.100.50',body:{email:'owner@example.invalid',password:'wrong'}});
  assert.equal(latest.status,429);assert.ok(Number(latest.headers.get('Retry-After'))>0);
  for(let i=0;i<91;i++)latest=await send('/api/collect',{method:'POST',origin:portfolio,ip:'198.51.100.51',body:payload()});
  assert.equal(latest.status,429);
});
test('event volume is capped without dropping valid visit metadata',async()=>{
  const id=uuid();for(let j=0;j<11;j++)await send('/api/collect',{method:'POST',origin:portfolio,ip:'198.51.100.52',body:payload(id,Array.from({length:20},()=>({id:uuid(),type:'project_open',target:'audit',action:'gallery',at:Date.now()})))});
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM events WHERE visit_id=?').bind(id).first()).total,200);
});
test('retention deletes expired visits, events, notifications and auth/rate-limit records',async()=>{
  const id=uuid(),old=Date.now()-100*86400000;
  await db.prepare("INSERT INTO visits(id,created_at,last_seen,source,source_method,device,lang) VALUES (?,?,?,'direct','direct','desktop','ar')").bind(id,old,old).run();
  await db.prepare("INSERT INTO events(id,visit_id,created_at,type) VALUES (?,?,?,'visit')").bind(uuid(),id,old).run();
  await db.prepare("INSERT INTO notifications(visit_id,status,due_at) VALUES (?,'sent',?)").bind(id,old).run();
  await cleanup({...settings.bindings,DB:db});
  assert.equal(await db.prepare('SELECT id FROM visits WHERE id=?').bind(id).first(),null);assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM events WHERE visit_id=?').bind(id).first()).total,0);assert.equal(await db.prepare('SELECT * FROM notifications WHERE visit_id=?').bind(id).first(),null);
});
test('changing the owner password invalidates an existing session',async()=>{
  const previous=settings.bindings.OWNER_PASSWORD_HASH;settings.bindings.OWNER_PASSWORD_HASH='pbkdf2-sha256$100000$'+'e'.repeat(32)+'$'+await passwordHash('Different test password!','e'.repeat(32));
  await configure();assert.equal((await owner('me')).status,401);
  settings.bindings.OWNER_PASSWORD_HASH=previous;await configure();
});
test('logging out revokes server-side access; cookie tampering cannot authenticate',async()=>{
  assert.equal((await owner('me')).status,200);
  const tampered=session.slice(0,-1)+(session.endsWith('a')?'b':'a');assert.equal((await send('/api/owner/me',{cookie:tampered})).status,401);
  assert.equal((await owner('logout',{method:'POST',origin:portfolio,body:'{}'})).status,403);
  const response=await owner('logout',{method:'POST',origin:service,body:'{}'});assert.equal(response.status,200);assert.match(response.headers.get('Set-Cookie'),/Max-Age=0/);assert.equal((await owner('me')).status,401);
});
