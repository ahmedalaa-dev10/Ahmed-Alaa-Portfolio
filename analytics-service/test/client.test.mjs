import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../../source/analytics.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const endpoint = 'https://visits.example/api/collect';
const landing = 'https://owner.github.io/portfolio/?utm_source=linkedin&utm_medium=social&utm_campaign=portfolio';
const normalize = value => JSON.parse(JSON.stringify(value));

// Execute the production tracking module with controlled browser ports; no live accounts or deliveries.
function client(options = {}) {
  let now = 1780560000000, timerId = 0;
  const timers = new Map(), posts = [], requests = [], beacons = [], configs = [];
  const docEvents = new Map(), winEvents = new Map();
  const session = options.session || new Map(), local = options.local || new Map();
  const storage = map => ({ getItem: key => map.get(key) || null, setItem: (key,value) => map.set(key,String(value)), removeItem: key => map.delete(key) });
  const listeners = map => ({
    addEventListener(type,fn) { if (!map.has(type)) map.set(type,new Set()); map.get(type).add(fn); },
    removeEventListener(type,fn) { map.get(type)?.delete(fn); },
  });
  class Element {
    constructor(href,download = false) { this.value = href; this.download = download; this.href = new URL(href,options.href || landing).href; }
    closest() { return this; }
    getAttribute(key) { return key === 'href' ? this.value : null; }
    hasAttribute(key) { return key === 'download' && this.download; }
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const document = { ...listeners(docEvents), referrer: options.referrer || '', visibilityState: options.visible === false ? 'hidden' : 'visible', documentElement: { lang: options.lang || 'ar' } };
  const window = listeners(winEvents);
  let failures = options.failures || 0;
  const fetch = async (url,init = {}) => {
    if (init.method === 'POST') {
      posts.push(JSON.parse(init.body)); requests.push(init);
      if (failures-- > 0) throw new Error('simulated network interruption');
      return { ok: true, status: 202 };
    }
    configs.push(String(url));
    if (options.configGate) await options.configGate;
    if (options.configFailure) throw new Error('config unavailable');
    return { ok: true, json: async () => options.config || { enabled: true, endpoint, respectPrivacySignals: true } };
  };
  const sandbox = { exports: {}, URL, Blob, Element, Date: Clock, document, window, location: { href: options.href || landing, pathname: '/portfolio/' }, navigator: {
    doNotTrack: options.dnt, globalPrivacyControl: options.gpc,
    sendBeacon(url,blob) { beacons.push({url,blob}); return true; },
  }, crypto: { randomUUID }, fetch, localStorage: storage(local), sessionStorage: storage(session),
    setTimeout(fn) { timers.set(++timerId,fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(code,sandbox,{filename:'production-analytics.js'});
  return {
    ...sandbox.exports, posts, requests, configs, beacons, session, local,
    advance(ms) { now += ms; },
    async flush() { for (let i=0;timers.size && i<20;i++) { const [id,fn] = timers.entries().next().value; timers.delete(id); await fn(); } assert.equal(timers.size,0,'tracking queue did not drain'); },
    visible() { document.visibilityState = 'visible'; for (const fn of docEvents.get('visibilitychange') || []) fn(); },
    pagehide() { for (const fn of winEvents.get('pagehide') || []) fn(); },
    click(href,download = false) {
      let prevented = false;
      const event = { target: new Element(href,download), preventDefault() { prevented = true; } };
      for (const fn of docEvents.get('click') || []) fn(event);
      return prevented;
    },
  };
}

test('LinkedIn attribution accepts real domains and tagged links without retaining URLs',()=>{
  const api = client();
  const cases = [
    [landing,'https://google.com/', 'linkedin','utm'],
    ['https://owner.github.io/portfolio/','https://www.linkedin.com/in/person/?private=1','linkedin','referrer'],
    ['https://owner.github.io/portfolio/','https://lnkd.in/example','linkedin','referrer'],
    ['https://owner.github.io/portfolio/','https://linkedin.com.attacker.invalid/','other','referrer'],
    ['https://owner.github.io/portfolio/','','direct','direct'],
  ];
  for (const [url,referrer,source,method] of cases) {
    const result = normalize(api.deriveAttribution(new URL(url),referrer));
    assert.equal(result.source,source); assert.equal(result.method,method);
    assert.deepEqual(Object.keys(result).sort(),['campaign','medium','method','source']);
    assert.ok(!JSON.stringify(result).includes('/in/person'));
  }
});
test('project, CV and contact actions are captured without preventing navigation',async()=>{
  const c = client(); await c.initAnalytics();
  c.trackProjectOpen('audit','gallery'); c.trackProjectOpen('custody','details');
  for (const [href,download] of [['./assets/Ahmed-Alaa-CV.pdf',true],['#contact',false],['mailto:owner@example.invalid',false],['tel:+201000000000',false],['https://www.linkedin.com/in/person/',false],['#skills',false]]) assert.equal(c.click(href,download),false);
  await c.flush();
  assert.equal(c.posts.length,1);
  assert.deepEqual(c.posts[0].events.map(event=>[event.type,event.target || '']),[['visit',''],['project_open','audit'],['project_open','custody'],['cv_click','cv'],['contact_click','section'],['contact_click','email'],['contact_click','phone'],['contact_click','linkedin']]);
  assert.ok(!JSON.stringify(c.posts).includes('owner@example.invalid')); assert.ok(!JSON.stringify(c.posts).includes('+201000000000'));
  assert.equal(c.requests[0].credentials,'omit'); assert.equal(c.requests[0].keepalive,true);
});
test('reloads preserve session and LinkedIn source; a different explicit source begins a new session',async()=>{
  const storage = new Map();
  const first = client({session:storage}); await first.initAnalytics(); await first.flush();
  const reload = client({session:storage,href:'https://owner.github.io/portfolio/'}); await reload.initAnalytics(); await reload.flush();
  assert.equal(reload.posts[0].session,first.posts[0].session); assert.equal(reload.posts[0].attribution.source,'linkedin');
  const other = client({session:storage,href:'https://owner.github.io/portfolio/?utm_source=email'}); await other.initAnalytics(); await other.flush();
  assert.notEqual(other.posts[0].session,first.posts[0].session); assert.equal(other.posts[0].attribution.source,'email');
});
test('session expiry never moves queued actions into a different visit',async()=>{
  const c = client(); await c.initAnalytics();
  c.advance(30*60*1000+1); c.trackProjectOpen('audit','details'); await c.flush();
  assert.equal(c.posts.length,2); assert.notEqual(c.posts[0].session,c.posts[1].session);
  assert.equal(c.posts[0].events[0].type,'visit'); assert.equal(c.posts[1].events[0].type,'project_open');
});
test('disabled config, owner exclusion and privacy signals prevent collecting visits',async()=>{
  for (const options of [{config:{enabled:false,endpoint}}, {config:{enabled:true,endpoint:'http://visits.example/api/collect'}}, {config:{enabled:true,endpoint:endpoint+'?token=no'}}, {dnt:'1'}, {gpc:true}, {configFailure:true}, {href:'https://owner.github.io/portfolio/?aa_no_track=1'}]) {
    const c = client(options); await c.initAnalytics(); c.trackProjectOpen('audit','gallery'); c.click('./assets/Ahmed-Alaa-CV.pdf',true); await c.flush();
    assert.equal(c.posts.length,0);
  }
  const local = new Map();
  const own = client({local,href:'https://owner.github.io/portfolio/?aa_no_track=1'}); await own.initAnalytics(); assert.equal(own.configs.length,0);
  const repeat = client({local}); await repeat.initAnalytics(); await repeat.flush(); assert.equal(repeat.posts.length,0);
  const restore = client({local,href:'https://owner.github.io/portfolio/?aa_no_track=0'}); await restore.initAnalytics(); await restore.flush(); assert.equal(restore.posts.length,1);
});
test('background previews wait for visibility; early project actions survive config loading',async()=>{
  const background = client({visible:false}); await background.initAnalytics(); await background.flush(); assert.equal(background.posts.length,0);
  background.visible(); await background.flush(); assert.equal(background.posts.length,1);
  let release; const configGate = new Promise(resolve=>{release=resolve;});
  const early = client({configGate}); const init = early.initAnalytics(); early.trackProjectOpen('audit','gallery'); release(); await init; await early.flush();
  assert.deepEqual(early.posts[0].events.map(event=>event.type),['visit','project_open']);
});
test('network retries retain event identifiers and remain bounded',async()=>{
  const c = client({failures:2}); await c.initAnalytics(); c.click('mailto:owner@example.invalid'); await c.flush();
  assert.equal(c.posts.length,3); assert.deepEqual(c.posts[0],c.posts[1]); assert.deepEqual(c.posts[1],c.posts[2]);
  const unavailable = client({failures:20}); await unavailable.initAnalytics(); await unavailable.flush(); assert.equal(unavailable.posts.length,3);
});
test('page exit sends all bounded batches and corrupted session storage recovers',async()=>{
  const c = client(); await c.initAnalytics();
  for(let i=0;i<35;i++) c.trackProjectOpen('audit','gallery');
  c.pagehide(); const packets = await Promise.all(c.beacons.map(async item=>JSON.parse(await item.blob.text())));
  assert.equal(packets.flatMap(packet=>packet.events).length,36); assert.ok(packets.every(packet=>packet.events.length<=20)); await c.flush(); assert.equal(c.posts.length,0);
  const broken = client({session:new Map([['aa-visit-session-v1',JSON.stringify({id:randomUUID(),last:1780560000000,attribution:{source:'linkedin'}})]])});
  await broken.initAnalytics(); await broken.flush(); assert.equal(broken.posts.length,1); assert.equal(broken.posts[0].attribution.source,'linkedin');
});

test('owner UI has complete paired translations and valid source filter choices',async()=>{
  const script = await readFile(new URL('../ui/owner.js',import.meta.url),'utf8');
  const html = await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
  const parsed = ts.createSourceFile('owner.js',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const statement = parsed.statements.find(item=>ts.isVariableStatement(item) && item.declarationList.declarations[0].name.getText(parsed)==='copy');
  const languages = Object.fromEntries(statement.declarationList.declarations[0].initializer.properties.map(item=>[item.name.getText(parsed),item.initializer.properties.map(property=>property.name.getText(parsed))]));
  for (const keys of Object.values(languages)) assert.equal(new Set(keys).size,keys.length,'duplicate translation keys');
  assert.deepEqual(languages.ar.sort(),languages.en.sort());
  const used = [...html.matchAll(/data-t="([^"]+)"/g)].map(match=>match[1]);
  for (const key of used) assert.ok(languages.ar.includes(key),'missing UI translation: '+key);
  for (const match of script.matchAll(/\bt\('([^']+)'\)/g)) assert.ok(languages.ar.includes(match[1]),'missing dynamic translation: '+match[1]);
  const select = /<select id="source">([\s\S]*?)<\/select>/.exec(html)?.[1];
  assert.deepEqual([...select.matchAll(/<option value="([^"]*)"/g)].map(match=>match[1]),['','linkedin','google','github','facebook','email','direct','other']);
  assert.ok(!/innerHTML\s*=/.test(script),'untrusted data must be rendered as text');
});
