type EventKind = 'visit' | 'project_open' | 'cv_click' | 'contact_click';
type EventInput = { type: EventKind; target?: string; action?: string };
type VisitEvent = EventInput & { id: string; at: number };
type Attribution = { source: string; method: 'utm' | 'referrer' | 'direct'; campaign: string; medium: string };
type VisitSession = { id: string; last: number; attribution: Attribution; tagged: string };
type QueuedEvent = { event: VisitEvent; visit: Pick<VisitSession, 'id' | 'attribution'> };
type AnalyticsConfig = { enabled: boolean; endpoint: string; respectPrivacySignals?: boolean };
const SESSION_KEY = 'aa-visit-session-v1';
const IGNORE_KEY = 'aa-analytics-ignore';
const SESSION_TTL = 30 * 60 * 1000;
let accept: ((event: EventInput) => void) | null = null;
let starting = false;
const early: EventInput[] = [];

export function deriveAttribution(url: URL, referrer: string): Attribution {
  const slug = (value: string | null) => value && /^[a-z0-9_-]{1,60}$/i.test(value) ? value.toLowerCase() : '';
  const tagged = slug(url.searchParams.get('utm_source'));
  const known = ['linkedin', 'google', 'github', 'facebook', 'email'];
  if (tagged) return { source: known.includes(tagged) ? tagged : 'other', method: 'utm', campaign: slug(url.searchParams.get('utm_campaign')), medium: slug(url.searchParams.get('utm_medium')) };
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (host === url.hostname) return { source: 'direct', method: 'direct', campaign: '', medium: '' };
    const domains: [string, string[]][] = [['linkedin', ['linkedin.com', 'lnkd.in']], ['google', ['google.com']], ['github', ['github.com']], ['facebook', ['facebook.com', 'fb.com']]];
    for (const [source, aliases] of domains) if (aliases.some(domain => host === domain || host.endsWith('.' + domain))) return { source, method: 'referrer', campaign: '', medium: 'referral' };
    return { source: 'other', method: 'referrer', campaign: '', medium: 'referral' };
  } catch { return { source: 'direct', method: 'direct', campaign: '', medium: '' }; }
}

export function trackProjectOpen(project: string, action: 'gallery' | 'details') {
  const event: EventInput = { type: 'project_open', target: project, action };
  if (accept) accept(event);
  else if (starting && early.length < 20) early.push(event);
}

export async function initAnalytics() {
  if (starting || typeof window === 'undefined') return;
  starting = true;
  try {
    const page = new URL(location.href);
    const ignore = page.searchParams.get('aa_no_track');
    try {
      if (ignore === '1') localStorage.setItem(IGNORE_KEY, '1');
      if (ignore === '0') localStorage.removeItem(IGNORE_KEY);
      if (localStorage.getItem(IGNORE_KEY) === '1') return;
    } catch { if (ignore === '1') return; }
    const response = await fetch(new URL('./assets/analytics-config.json', page), { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return;
    const config = await response.json() as AnalyticsConfig;
    if (!config.enabled || !config.endpoint) return;
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/collect' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return;
    const privacyNavigator = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (config.respectPrivacySignals !== false && (navigator.doNotTrack === '1' || privacyNavigator.globalPrivacyControl === true)) return;
    const attribution = deriveAttribution(page, document.referrer);
    const tagged = page.searchParams.get('utm_source') ? JSON.stringify(attribution) : '';
    let stored: VisitSession | null = null;
    try { stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch {}
    const validStored = stored && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(stored.id)
      && typeof stored.last === 'number' && stored.last <= Date.now() && Date.now() - stored.last < SESSION_TTL
      && stored.attribution && ['linkedin','google','github','facebook','email','direct','other'].includes(stored.attribution.source)
      && ['utm','referrer','direct'].includes(stored.attribution.method)
      && [stored.attribution.medium, stored.attribution.campaign].every(value => typeof value === 'string' && /^[a-z0-9_-]{0,60}$/.test(value));
    let session: VisitSession = validStored && (!tagged || stored!.tagged === tagged)
      ? stored! : { id: crypto.randomUUID(), last: Date.now(), attribution, tagged };
    const queue: QueuedEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sending = false;
    let retries = 0;
    const save = () => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {} };
    const payload = (items: QueuedEvent[]) => ({ session: items[0].visit.id, attribution: items[0].visit.attribution, path: location.pathname, lang: document.documentElement.lang === 'en' ? 'en' : 'ar', events: items.map(item => item.event) });
    const takeBatch = () => {
      const other = queue.findIndex(item => item.visit.id !== queue[0].visit.id);
      return queue.splice(0, Math.min(20, other < 0 ? queue.length : other));
    };
    const flush = async () => {
      timer = null;
      if (sending || !queue.length) return;
      sending = true;
      const chunk = takeBatch();
      try {
        const result = await fetch(endpoint, { method: 'POST', body: JSON.stringify(payload(chunk)), headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, credentials: 'omit', keepalive: true });
        if (!result.ok && result.status >= 500) throw new Error('Unavailable');
        retries = 0;
      } catch {
        if (++retries <= 2) queue.unshift(...chunk);
      } finally {
        sending = false;
        if (queue.length && !timer) timer = setTimeout(flush, retries ? 3000 : 300);
      }
    };
    accept = event => {
      if (Date.now() - session.last >= SESSION_TTL) {
        session = { id: crypto.randomUUID(), last: Date.now(), attribution: deriveAttribution(new URL(location.href), document.referrer), tagged };
      }
      session.last = Date.now(); save();
      if (queue.length >= 40) return;
      queue.push({ event: { ...event, id: crypto.randomUUID(), at: Date.now() }, visit: { id: session.id, attribution: session.attribution } });
      if (!timer) timer = setTimeout(flush, event.type === 'visit' ? 400 : 150);
    };
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (anchor.hasAttribute('download') && /Ahmed-Alaa-CV\.pdf(?:$|[?#])/i.test(href)) accept?.({ type: 'cv_click', target: 'cv', action: 'download' });
      else if (href === '#contact') accept?.({ type: 'contact_click', target: 'section', action: 'navigate' });
      else if (href.startsWith('mailto:')) accept?.({ type: 'contact_click', target: 'email', action: 'click' });
      else if (href.startsWith('tel:')) accept?.({ type: 'contact_click', target: 'phone', action: 'click' });
      else { try { if (new URL(anchor.href).hostname === 'www.linkedin.com') accept?.({ type: 'contact_click', target: 'linkedin', action: 'click' }); } catch {} }
    };
    document.addEventListener('click', onClick, { capture: true });
    window.addEventListener('pagehide', () => {
      while (queue.length) {
        const chunk = takeBatch();
        try {
          const accepted = navigator.sendBeacon(endpoint.href, new Blob([JSON.stringify(payload(chunk))], { type: 'text/plain;charset=UTF-8' }));
          if (!accepted) { queue.unshift(...chunk); void flush(); break; }
        } catch { queue.unshift(...chunk); void flush(); break; }
      }
    });
    const startVisit = () => { accept?.({ type: 'visit' }); early.splice(0).forEach(event => accept?.(event)); };
    // Link previews and background tabs do not trigger a visit until the page becomes visible.
    if (document.visibilityState === 'visible') startVisit();
    else {
      const visible = () => { if (document.visibilityState !== 'visible') return; document.removeEventListener('visibilitychange', visible); startVisit(); };
      document.addEventListener('visibilitychange', visible);
    }
  } catch { /* Analytics failure must never affect portfolio navigation. */ }
}
