export const visitSections = ['top', 'about', 'work', 'digital', 'experience', 'skills', 'learning', 'contact'] as const;
type Section = typeof visitSections[number];
type Session = { id: string; last: number; seen: Section[] };
type Pending = { id: string; sections: Section[]; downloads: string[]; tries: number };
export type VisitConfig = { endpoint: string; respectPrivacySignals?: boolean };
const SESSION_KEY = 'aa-visit-session-v2';
const IGNORE_KEY = 'aa-analytics-ignore';
const TTL = 30 * 60 * 1000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
let starting = false;
let excluded = false;
let stop: (() => void) | null = null;
let ready = false;
let earlyDownloads = 0;
let reportDownload: (() => void) | null = null;

// Called only by the three real CV download links. It never blocks the file.
export function recordCvDownload() {
  if (typeof window === 'undefined' || excluded || document.visibilityState !== 'visible') return;
  try {
    if (reportDownload) reportDownload();
    else if (starting && !ready && earlyDownloads < 10) earlyDownloads++;
  } catch { /* Downloading the CV must remain independent of measurement. */ }
}

export function excludeOwnerVisits() {
  excluded = true;
  try { localStorage.setItem(IGNORE_KEY, '1'); } catch {}
  stop?.();
}
export async function loadVisitConfig(): Promise<VisitConfig | null> {
  try {
    const response = await fetch(new URL('./assets/analytics-config.json', location.href), { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return null;
    const config = await response.json();
    if (config?.enabled !== true || typeof config.endpoint !== 'string') return null;
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/collect' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return null;
    return { endpoint: endpoint.href, respectPrivacySignals: config.respectPrivacySignals };
  } catch { return null; }
}
export async function initAnalytics() {
  if (starting || typeof window === 'undefined') return;
  starting = true;
  try {
    const ignore = new URL(location.href).searchParams.get('aa_no_track');
    try {
      if (ignore === '1') localStorage.setItem(IGNORE_KEY, '1');
      if (ignore === '0') localStorage.removeItem(IGNORE_KEY);
      excluded = ignore === '1' || localStorage.getItem(IGNORE_KEY) === '1';
      sessionStorage.removeItem('aa-visit-session-v1');
    } catch { excluded = ignore === '1'; }
    if (excluded) return;
    const config = await loadVisitConfig();
    if (!config) return;
    const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (config.respectPrivacySignals !== false && (navigator.doNotTrack === '1' || privacy.globalPrivacyControl === true)) return;
    let stored: Session | null = null;
    try { stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch {}
    const valid = stored && UUID.test(stored.id || '') && typeof stored.last === 'number' && stored.last <= Date.now() && Date.now() - stored.last < TTL
      && Array.isArray(stored.seen) && stored.seen.length <= visitSections.length && stored.seen.every(id => visitSections.includes(id));
    let session: Session = valid ? stored! : { id: crypto.randomUUID(), last: Date.now(), seen: [] };
    const save = () => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {} };
    const queue: Pending[] = [];
    const pendingSeen = new Set<Section>();
    const dwell = new Map<Section, ReturnType<typeof setTimeout>>();
    const visible = new Set<Section>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sending = false;
    let observer: IntersectionObserver | null = null;
    const payload = (item: Pending) => ({ session: item.id, path: location.pathname, sections: item.sections, ...(item.downloads.length ? { downloads: item.downloads } : {}) });
    const flush = async () => {
      timer = null;
      if (excluded || sending || !queue.length) return;
      sending = true;
      const item = queue.shift()!;
      try {
        const response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(payload(item)), credentials: 'omit', keepalive: true });
        if (!response.ok) throw new Error('unavailable');
        if (item.id === session.id) {
          session.seen = [...new Set([...session.seen, ...item.sections])];
          save();
        }
      } catch { if (++item.tries <= 2 && !excluded) queue.unshift(item); }
      finally {
        sending = false;
        if (queue.length && !excluded) timer = setTimeout(flush, item.tries ? 3000 : 250);
      }
    };
    const enqueue = (section?: Section, download?: string) => {
      if (excluded || document.visibilityState !== 'visible') return;
      if (Date.now() - session.last >= TTL) { session = { id: crypto.randomUUID(), last: Date.now(), seen: [] }; pendingSeen.clear(); }
      session.last = Date.now(); save();
      if (section && (session.seen.includes(section) || pendingSeen.has(section))) return;
      if (section) pendingSeen.add(section);
      const last = queue.at(-1);
      if (last?.id === session.id && last.tries === 0 && last.downloads.length < 10) { if (section) last.sections.push(section); if (download) last.downloads.push(download); }
      else if (queue.length < 16) queue.push({ id: session.id, sections: section ? [section] : [], downloads: download ? [download] : [], tries: 0 });
      if (!timer) timer = setTimeout(flush, 300);
    };
    const watch = (section: Section) => {
      if (excluded || dwell.has(section) || document.visibilityState !== 'visible') return;
      dwell.set(section, setTimeout(() => { dwell.delete(section); if (visible.has(section)) enqueue(section); }, 700));
    };
    const onVisibility = () => {
      for (const id of dwell.values()) clearTimeout(id);
      dwell.clear();
      if (document.visibilityState === 'visible') { enqueue(); visible.forEach(watch); }
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const id = entry.target.id as Section;
          if (!visitSections.includes(id)) continue;
          if (entry.isIntersecting) { visible.add(id); watch(id); }
          else { visible.delete(id); const pending = dwell.get(id); if (pending) clearTimeout(pending); dwell.delete(id); }
        }
      }, { rootMargin: '-20% 0px -45% 0px', threshold: 0 });
      document.querySelectorAll('main > section[id]').forEach(section => observer!.observe(section));
    }
    window.addEventListener('pagehide', () => {
      if (excluded) return;
      while (queue.length) {
        const item = queue.shift()!;
        try {
          if (!navigator.sendBeacon(config.endpoint, new Blob([JSON.stringify(payload(item))], { type: 'text/plain;charset=UTF-8' }))) { queue.unshift(item); void flush(); break; }
        } catch { queue.unshift(item); void flush(); break; }
      }
    });
    stop = () => { reportDownload = null; earlyDownloads = 0; observer?.disconnect(); document.removeEventListener('visibilitychange', onVisibility); dwell.forEach(clearTimeout); dwell.clear(); queue.length = 0; if (timer) clearTimeout(timer); };
    reportDownload = () => enqueue(undefined, crypto.randomUUID());
    enqueue();
    for (let count = earlyDownloads; count > 0; count--) reportDownload();
  } catch { /* Measurement must never interrupt the portfolio. */ }
  finally { ready = true; earlyDownloads = 0; }
}
