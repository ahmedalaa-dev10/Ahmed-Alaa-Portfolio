import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LockKeyhole, RefreshCw, LogOut, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { excludeOwnerVisits, loadVisitConfig, visitSections } from './analytics';
import { ui, type Lang } from './content';

const words = {
  entry: { ar: 'مركز الزيارات', en: 'Visits center' },
  title: { ar: 'مركز الزيارات', en: 'Visits center' },
  private: { ar: 'الإحصاءات متاحة للمالك بعد تسجيل الدخول.', en: 'Statistics are available to the owner after signing in.' },
  email: { ar: 'بريد حساب المالك', en: 'Owner account email' },
  password: { ar: 'كلمة المرور', en: 'Password' },
  login: { ar: 'تسجيل الدخول', en: 'Sign in' },
  loading: { ar: 'جارٍ التحميل…', en: 'Loading…' },
  total: { ar: 'إجمالي الزيارات', en: 'Total visits' },
  downloads: { ar: 'تحميلات الـCV', en: 'CV downloads' },
  downloadsNote: { ar: 'عداد الـCV يسجّل الضغطات على أزرار التحميل، ولا يؤكد اكتمال حفظ الملف. يبدأ العدّ بعد تفعيل التحديث.', en: 'The CV counter records download-button activations, not completed file saves. Counting starts when the update is activated.' },
  counterPending: { ar: 'يحتاج عدّاد التحميل إلى تحديث الخدمة.', en: 'Update the service to enable the download counter.' },
  sections: { ar: 'الأقسام التي تمت مشاهدتها', en: 'Sections viewed' },
  section: { ar: 'القسم', en: 'Section' },
  sectionVisits: { ar: 'عدد الزيارات', en: 'Visits' },
  refresh: { ar: 'تحديث الإحصاءات', en: 'Refresh statistics' },
  logout: { ar: 'تسجيل الخروج', en: 'Sign out' },
  updated: { ar: 'آخر تحديث', en: 'Last updated' },
  note: { ar: 'تُحسب مشاهدة كل قسم مرة واحدة في الزيارة. تُجمع إعادة التحميل خلال 30 دقيقة من آخر نشاط مرصود في نفس الزيارة. قد تمنع إعدادات الخصوصية تسجيل بعض الزيارات.', en: 'Each section is counted once per visit. Reloads within 30 minutes of the last recorded activity belong to the same visit. Privacy settings may prevent some visits from being recorded.' },
  ownerNote: { ar: 'زيارات هذا المتصفح مستبعدة بعد تسجيل دخول المالك.', en: 'Visits from this browser are excluded after the owner signs in.' },
  unavailable: { ar: 'مركز الزيارات غير متاح حاليًا. حاول لاحقًا.', en: 'The visits center is currently unavailable. Please try again later.' },
  invalid_credentials: { ar: 'البريد أو كلمة المرور غير صحيحة.', en: 'The email or password is incorrect.' },
  unauthorized: { ar: 'انتهت جلسة الدخول. سجّل دخولك مرة أخرى.', en: 'Your session has expired. Please sign in again.' },
  rate_limited: { ar: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.', en: 'Too many attempts. Please wait before trying again.' },
  loggedOut: { ar: 'تم تسجيل الخروج.', en: 'You have signed out.' },
};
type Summary = { visits: number; cvDownloads?: number; sections: { id: string; visits: number }[] };
function isSummary(value: unknown): value is Summary {
  const s = value as Summary;
  return !!s && Number.isSafeInteger(s.visits) && s.visits >= 0 && Array.isArray(s.sections) && s.sections.length === visitSections.length
    && (s.cvDownloads === undefined || (Number.isSafeInteger(s.cvDownloads) && s.cvDownloads >= 0))
    && visitSections.every(id => s.sections.filter(row => row?.id === id && Number.isSafeInteger(row.visits) && row.visits >= 0).length === 1);
}

export default function VisitsCenter({ lang, changeLanguage }: { lang: Lang; changeLanguage: (lang: Lang) => void }) {
  const [open, setOpen] = useState(false);
  const [entryVisible, setEntryVisible] = useState(false);
  const [service, setService] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const token = useRef('');
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const entry = useRef<HTMLButtonElement | null>(null);
  const rememberEntry = () => { setEntryVisible(true); try { localStorage.setItem('aa-owner-entry', '1'); } catch {} window.dispatchEvent(new Event('aa-owner-mode')); };
  const number = (value: number) => new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-GB').format(value);
  const sectionName = (id: string) => id === 'top' ? (lang === 'ar' ? 'المقدمة' : 'Introduction') : id === 'contact' ? ui.contact[lang] : ui.nav.find(item => item.id === id)?.label[lang] || '';
  const cancel = () => { generation.current++; active.current?.abort(); active.current = null; };
  const clearPrivate = () => { token.current = ''; setAuthenticated(false); setSummary(null); setUpdated(null); setPassword(''); };
  const showError = (reason: unknown) => {
    const code = reason instanceof Error ? reason.message : 'unavailable';
    if (code === 'unauthorized') clearPrivate();
    setError(['invalid_credentials', 'unauthorized', 'rate_limited'].includes(code) ? code : 'unavailable');
  };
  const request = async (origin: string, path: string, controller: AbortController, init: RequestInit = {}) => {
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(origin + '/api/owner/' + path, { ...init, signal: controller.signal, credentials: 'omit', headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(token.current ? { Authorization: 'Bearer ' + token.current } : {}) } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'unavailable');
      return data;
    } finally { clearTimeout(timeout); }
  };
  const readSummary = async (origin: string, controller: AbortController, version: number) => {
    const data = await request(origin, 'summary', controller);
    if (!isSummary(data)) throw new Error('unavailable');
    if (version !== generation.current) return;
    setSummary(data); setAuthenticated(true); setUpdated(new Date()); setError('');
  };
  const changeOpen = (next: boolean) => { cancel(); setPassword(''); setError(''); setMessage(false); setBusy(false); setOpen(next); };
  useEffect(() => {
    if (location.hash === '#owner') setOpen(true);
    if (new URL(location.href).searchParams.get('aa_no_track') === '1') rememberEntry();
    else { try { setEntryVisible(localStorage.getItem('aa-owner-entry') === '1'); } catch {} }
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) { cancel(); clearPrivate(); setOpen(false); } };
    window.addEventListener('pageshow', pageshow);
    return () => { cancel(); window.removeEventListener('pageshow', pageshow); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const version = ++generation.current;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setSummary(null);
    void (async () => {
      const config = await loadVisitConfig();
      if (version !== generation.current) return;
      if (!config) throw new Error('unavailable');
      const origin = new URL(config.endpoint).origin;
      if (service && service !== origin) clearPrivate();
      setService(origin);
      if (token.current) await readSummary(origin, controller, version);
    })().catch(reason => { if (version === generation.current) showError(reason); }).finally(() => { if (version === generation.current) setBusy(false); });
    return () => { if (version === generation.current) cancel(); };
  }, [open]);
  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!service || busy) return;
    cancel(); const version = generation.current;
    const controller = new AbortController(); active.current = controller;
    const submitted = password; setPassword(''); setBusy(true); setError(''); setMessage(false);
    try {
      const data = await request(service, 'login', controller, { method: 'POST', body: JSON.stringify({ email, password: submitted }) });
      if (version !== generation.current) return;
      if (!/^[\da-f]{64}$/.test(data.token || '')) throw new Error('unavailable');
      token.current = data.token; setAuthenticated(true); rememberEntry(); excludeOwnerVisits();
      await readSummary(service, controller, version);
    } catch (reason) { if (version === generation.current) showError(reason); }
    finally { if (version === generation.current) setBusy(false); }
  };
  const refresh = async () => {
    if (!service || !token.current || busy) return;
    cancel(); const version = generation.current;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError('');
    try { await readSummary(service, controller, version); }
    catch (reason) { if (version === generation.current) showError(reason); }
    finally { if (version === generation.current) setBusy(false); }
  };
  const signOut = async () => {
    cancel(); const version = generation.current;
    const controller = new AbortController(); active.current = controller;
    const previous = token.current; clearPrivate(); setEmail(''); setBusy(true); setError('');
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(service + '/api/owner/logout', { method: 'POST', credentials: 'omit', signal: controller.signal, headers: { Authorization: 'Bearer ' + previous } });
      if (!response.ok && response.status !== 401) throw new Error('unavailable');
      if (version === generation.current) setMessage(true);
    } catch (reason) { if (version === generation.current) showError(reason); }
    finally { clearTimeout(timeout); if (version === generation.current) setBusy(false); }
  };
  return <>
    {entryVisible && <button ref={entry} className="owner-entry" type="button" onClick={() => changeOpen(true)}><LockKeyhole size={14} aria-hidden="true" />{words.entry[lang]}</button>}
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="visits-center" showCloseButton={false} dir={lang === 'ar' ? 'rtl' : 'ltr'} onCloseAutoFocus={event => { event.preventDefault(); entry.current?.focus({ preventScroll: true }); }}>
      <div className="visits-heading"><div><span className="visits-private"><LockKeyhole size={15} aria-hidden="true" />Ahmed Alaa</span><DialogTitle>{words.title[lang]}</DialogTitle><DialogDescription>{words.private[lang]}</DialogDescription></div><button className="visits-close" type="button" aria-label={ui.close[lang]} onClick={() => changeOpen(false)}><X size={22} /></button></div>
      <div className="visits-languages language-switch" dir="ltr" role="group" aria-label={lang === 'ar' ? 'لغة الموقع' : 'Site language'}><button type="button" aria-pressed={lang === 'ar'} lang="ar" onClick={() => changeLanguage('ar')}>العربية</button><span aria-hidden="true">|</span><button type="button" aria-pressed={lang === 'en'} lang="en" onClick={() => changeLanguage('en')}>English</button></div>
      {error && <p className="visits-error" role="alert">{words[error as 'unavailable'][lang]}</p>}
      {message && <p className="visits-note" role="status">{words.loggedOut[lang]}</p>}
      {busy && <p className="visits-note" role="status">{words.loading[lang]}</p>}
      {!authenticated ? <form className="visits-form" onSubmit={signIn}><label htmlFor="owner-email">{words.email[lang]}</label><input id="owner-email" type="email" autoComplete="username" dir="ltr" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} disabled={busy} /><label htmlFor="owner-password">{words.password[lang]}</label><input id="owner-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} disabled={busy} /><button className="visits-action" type="submit" disabled={busy || !service}>{words.login[lang]}</button></form>
        : <div className="visits-dashboard">
          {summary && <><div className="visits-stats"><div className="visits-total"><span>{words.total[lang]}</span><strong>{number(summary.visits)}</strong></div><div className="visits-total"><span>{words.downloads[lang]}</span>{summary.cvDownloads === undefined ? <span>{words.counterPending[lang]}</span> : <strong>{number(summary.cvDownloads)}</strong>}</div></div><h3>{words.sections[lang]}</h3><div className="visits-section-head"><span>{words.section[lang]}</span><span>{words.sectionVisits[lang]}</span></div><ul className="visits-sections">{summary.sections.map(row => <li key={row.id}><span>{sectionName(row.id)}</span><strong>{number(row.visits)}</strong></li>)}</ul><p className="visits-note">{words.note[lang]}</p><p className="visits-note">{words.downloadsNote[lang]}</p></>}
          <div className="visits-actions"><button className="visits-action" type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={16} />{words.refresh[lang]}</button><button className="visits-action outline" type="button" onClick={() => void signOut()} disabled={busy}><LogOut size={16} />{words.logout[lang]}</button></div><p className="visits-note">{words.ownerNote[lang]}</p>{updated && <p className="visits-note" role="status">{words.updated[lang]}: <bdi>{updated.toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</bdi></p>}
        </div>}
    </DialogContent></Dialog>
  </>;
}
