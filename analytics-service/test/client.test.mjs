import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../../source/analytics.ts',import.meta.url),'utf8');
const code = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const ownerSource = await readFile(new URL('../../source/owner-entry.ts',import.meta.url),'utf8');
const ownerCode = ts.transpileModule(ownerSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const endpoint = 'https://visits.example/api/collect';
const landing = 'https://owner.github.io/portfolio/?utm_source=linkedin';
function client(options = {}) {
  let now = 1780560000000, timerId = 0, failures = options.failures || 0, configReads = 0;
  const timers = new Map(), posts = [], beacons = [], docEvents = new Map(), winEvents = new Map();
  const session = options.session || new Map(), local = options.local || new Map();
  const checkStorage = () => { if (options.storageUnavailable) throw new Error('Storage is unavailable'); };
  const storage = map => ({getItem:key => {checkStorage();return map.get(key) || null;},setItem:(key,value) => {checkStorage();map.set(key,String(value));},removeItem:key => {checkStorage();map.delete(key);}});
  const listeners = map => ({addEventListener(type,fn) { if (!map.has(type)) map.set(type,new Set()); map.get(type).add(fn); },removeEventListener(type,fn) { map.get(type)?.delete(fn); }});
  class Clock extends Date { constructor(...args) { super(...(args.length?args:[now])); } static now() { return now; } }
  let observer = null;
  class Observer { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() { this.stopped = true; } }
  const document = {...listeners(docEvents),visibilityState:options.visible === false ? 'hidden':'visible',querySelectorAll:() => ['top','about','work','digital','experience','skills','learning','contact'].map(id => ({id}))};
  const window = listeners(winEvents);
  const current = new URL(options.href || landing);
  const sandbox = {exports:{},URL,Blob,Date:Clock,document,window,location:{href:current.href,pathname:current.pathname,hash:current.hash},navigator:{standalone:options.standalone,doNotTrack:options.dnt,globalPrivacyControl:options.gpc,sendBeacon(url,blob) {beacons.push({url,blob}); return true;}},crypto:{randomUUID},IntersectionObserver:Observer,localStorage:storage(local),sessionStorage:storage(session),setTimeout(fn,delay=0) {timers.set(++timerId,{fn,delay});return timerId;},clearTimeout:id => timers.delete(id),fetch:async (url,init={}) => {if (init.method === 'POST') { posts.push({data:JSON.parse(init.body),init}); if (failures-- > 0) throw new Error('network interrupted'); return {ok:true}; } configReads++;if (options.configFailure) throw new Error('config missing'); return {ok:true,json:async () => options.config || {enabled:true,endpoint,respectPrivacySignals:true}};}};
  vm.runInNewContext(ownerCode,sandbox);
  const ownerExports = sandbox.exports;
  sandbox.exports = {};
  sandbox.require = name => {assert.equal(name,'./owner-entry');return ownerExports;};
  vm.runInNewContext(code,sandbox);
  return {...sandbox.exports,posts,beacons,session,local,docEvents,configReads:() => configReads,
    async timers(delay) {for(let n=0;n<30;n++) {const item=[...timers].find(([,value]) => delay===undefined || value.delay===delay);if(!item)return;timers.delete(item[0]);await item[1].fn();}throw new Error('timers did not drain');},
    seen(id,show=true) {if(!observer?.stopped)observer?.callback([{target:{id},isIntersecting:show}]);},
    visible(show=true) {document.visibilityState=show?'visible':'hidden';for(const fn of docEvents.get('visibilitychange')||[])fn();},
    hide() {for(const fn of winEvents.get('pagehide')||[])fn();},advance(ms) {now+=ms;},
  };
}
test('only a visit and fixed section identifiers are transmitted, with no click listener',async () => {
  const c = client(); await c.initAnalytics(); await c.timers();
  assert.deepEqual(Object.keys(c.posts[0].data).sort(),['path','sections','session']); assert.equal(c.docEvents.has('click'),false);
  assert.equal(c.posts[0].init.credentials,'omit'); assert.equal(c.posts[0].init.keepalive,true);
  assert.ok(!JSON.stringify(c.posts).includes('linkedin'));
});
test('a section must stay in the reading area; repeats are deduplicated within a visit',async () => {
  const c = client(); await c.initAnalytics(); await c.timers(300);
  c.seen('work'); c.seen('work',false); await c.timers(); assert.equal(c.posts.length,1);
  c.seen('work'); await c.timers(); c.seen('work',false); c.seen('work'); await c.timers();
  assert.equal(c.posts.length,2); assert.deepEqual([...c.posts[1].data.sections],['work']);
  c.seen('contact'); await c.timers(); assert.deepEqual([...c.posts.at(-1).data.sections],['contact']);
});
test('reloads preserve the session and already counted sections for thirty minutes',async () => {
  const storage = new Map(), first = client({session:storage}); await first.initAnalytics(); first.seen('skills'); await first.timers();
  const next = client({session:storage}); await next.initAnalytics(); next.seen('skills'); await next.timers();
  assert.equal(next.posts[0].data.session,first.posts[0].data.session); assert.ok(next.posts.every(row => row.data.sections.length===0));
  const later = client({session:storage}); later.advance(31*60*1000); await later.initAnalytics(); await later.timers(); assert.notEqual(later.posts[0].data.session,first.posts[0].data.session);
});
test('hidden tabs and quick scrolling do not record visits or section views',async () => {
  const c = client({visible:false}); await c.initAnalytics(); c.seen('top'); await c.timers(); assert.equal(c.posts.length,0);
  c.visible(); await c.timers(); assert.ok(c.posts.some(row => row.data.sections.includes('top')));
  c.seen('contact'); c.visible(false); await c.timers(); assert.ok(c.posts.every(row => !row.data.sections.includes('contact')));
});
test('owner exclusion stops pending and future section reports',async () => {
  const c = client(); await c.initAnalytics(); c.seen('work'); c.excludeOwnerVisits(); await c.timers(); c.seen('skills'); c.hide();
  assert.equal(c.posts.length,0); assert.equal(c.beacons.length,0); assert.equal(c.local.get('aa-analytics-ignore'),'1');
});
test('owner app launch excludes visits, sections and CV actions before configuration, even without storage or a query flag',async () => {
  for (const suffix of ['', '?aa_no_track=0']) for (const storageUnavailable of [false,true]) {
    const c = client({href:'https://owner.github.io/portfolio/owner-app.html'+suffix,storageUnavailable,standalone:true});
    await c.initAnalytics();c.seen('work');c.recordCvDownload();await c.timers();c.hide();
    assert.equal(c.configReads(),0);assert.equal(c.posts.length,0);assert.equal(c.beacons.length,0);
  }
});
test('remembered owner entry excludes a public-link visit before configuration is requested',async () => {
  const c = client({local:new Map([['aa-owner-entry','1']])});
  await c.initAnalytics();c.recordCvDownload();await c.timers();c.hide();
  assert.equal(c.configReads(),0);assert.equal(c.posts.length,0);assert.equal(c.beacons.length,0);
});
test('a publicly installed portfolio still counts visits and CV actions',async () => {
  const c = client({standalone:true});await c.initAnalytics();c.recordCvDownload();await c.timers();
  assert.equal(c.configReads(),1);assert.equal(c.posts.length,1);assert.equal(c.posts[0].data.downloads.length,1);
});
test('privacy signals and disabled or invalid endpoints send no visitor data',async () => {
  for (const options of [{dnt:'1'},{gpc:true},{href:landing+'&aa_no_track=1'},{config:{enabled:false,endpoint}},{config:{enabled:true,endpoint:'http://visits.example/api/collect'}},{config:{enabled:true,endpoint:endpoint+'?private=1'}},{configFailure:true}]) {const c=client(options);await c.initAnalytics();await c.timers();assert.equal(c.posts.length,0);}
});
test('corrupt sessions are replaced; obsolete attribution is removed from storage',async () => {
  const storage = new Map([['aa-visit-session-v1','old metadata'],['aa-visit-session-v2',JSON.stringify({id:'invalid',last:0,seen:['private_name']})]]);
  const c = client({session:storage}); await c.initAnalytics(); await c.timers(); assert.equal(storage.has('aa-visit-session-v1'),false); assert.match(c.posts[0].data.session,/^[\da-f-]{36}$/); assert.equal(c.posts[0].data.sections.length,0);
});
test('bounded retries reuse the same session and only acknowledged sections persist',async () => {
  const c = client({failures:2}); await c.initAnalytics(); c.seen('work'); await c.timers();
  assert.equal(c.posts.length,4); assert.equal(new Set(c.posts.map(row => row.data.session)).size,1);
  assert.ok(JSON.parse(c.session.get('aa-visit-session-v2')).seen.includes('work'));
});
test('queued visits keep their own session when a later visit starts',async () => {
  const c = client(); await c.initAnalytics(); c.advance(31*60*1000); c.seen('work'); await c.timers(700); await c.timers();
  assert.equal(c.posts.length,2); assert.notEqual(c.posts[0].data.session,c.posts[1].data.session); assert.deepEqual([...c.posts[1].data.sections],['work']);
});
test('page exit uses write-only beacon payloads; language changes create no action events',async () => {
  const c = client(); await c.initAnalytics(); c.hide(); assert.equal(c.beacons.length,1);
  const data = JSON.parse(await c.beacons[0].blob.text()); assert.deepEqual(Object.keys(data).sort(),['path','sections','session']);
});
test('explicit CV actions send only anonymous unique IDs without collecting other clicks',async () => {
  const c=client();await c.initAnalytics();
  c.recordCvDownload();c.recordCvDownload();c.recordCvDownload();await c.timers();
  assert.equal(c.posts.length,1);const data=c.posts[0].data;
  assert.deepEqual(Object.keys(data).sort(),['downloads','path','sections','session']);assert.equal(data.downloads.length,3);assert.equal(new Set(data.downloads).size,3);
  assert.ok(data.downloads.every(id=>/^[\da-f-]{36}$/.test(id)));assert.equal(c.docEvents.has('click'),false);assert.ok(!JSON.stringify(data).includes('linkedin'));
});
test('a CV action during configuration loading is counted after privacy checks',async () => {
  const c=client();const start=c.initAnalytics();c.recordCvDownload();await start;await c.timers();
  assert.equal(c.posts[0].data.downloads.length,1);
});
test('CV retries and page-exit beacons reuse the same activation identifier',async () => {
  const c=client({failures:1});await c.initAnalytics();c.recordCvDownload();await c.timers(300);c.hide();
  assert.equal(c.posts.length,1);assert.equal(c.beacons.length,1);
  assert.deepEqual(JSON.parse(await c.beacons[0].blob.text()).downloads,c.posts[0].data.downloads);
});
test('owner exclusion and privacy settings prevent CV collection as well as visits',async () => {
  for (const options of [{dnt:'1'},{gpc:true},{href:landing+'&aa_no_track=1'},{config:{enabled:false,endpoint}},{visible:false}]) {
    const c=client(options);const start=c.initAnalytics();c.recordCvDownload();await start;c.recordCvDownload();await c.timers();assert.equal(c.posts.length,0);assert.equal(c.beacons.length,0);
  }
  const c=client();await c.initAnalytics();c.recordCvDownload();c.excludeOwnerVisits();c.recordCvDownload();await c.timers();c.hide();assert.equal(c.posts.length,0);assert.equal(c.beacons.length,0);
});
test('rapid CV actions stay within the server batch limit and keep their individual IDs',async () => {
  const c=client();await c.initAnalytics();for(let n=0;n<27;n++)c.recordCvDownload();await c.timers();
  assert.ok(c.posts.every(row=>row.data.downloads.length<=10));assert.equal(c.posts.flatMap(row=>row.data.downloads).length,27);assert.equal(new Set(c.posts.map(row=>row.data.session)).size,1);
});
