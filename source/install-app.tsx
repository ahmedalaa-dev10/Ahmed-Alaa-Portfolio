import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Monitor, Smartphone, Download, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { type Lang, ui } from './content';
import { getInstallState, getServerInstallState, promptInstall, subscribeInstall } from './pwa';
import { hasOwnerEntry, isOwnerLaunchPage, ownerLaunchUrl } from './owner-entry';

const words = {
  button: { ar: 'تثبيت البورتفوليو', en: 'Install portfolio' },
  title: { ar: 'البورتفوليو على جهازك', en: 'Your portfolio app' },
  intro: { ar: 'افتح البورتفوليو من أيقونته، في نافذة مستقلة على الموبايل أو الكمبيوتر.', en: 'Open the portfolio from its icon in a dedicated window on your phone or computer.' },
  install: { ar: 'تثبيت الآن', en: 'Install now' },
  installing: { ar: 'أكمل التثبيت في نافذة المتصفح…', en: 'Complete installation in the browser prompt…' },
  failed: { ar: 'لم يكتمل التثبيت. يمكنك استخدام الخطوات أدناه.', en: 'Installation did not complete. You can use the steps below.' },
  connection: { ar: 'يحتاج محتوى البورتفوليو إلى اتصال بالإنترنت.', en: 'Portfolio content requires an internet connection.' },
  ios: { ar: 'على iPhone / iPad', en: 'On iPhone and iPad' },
  iosSteps: [
    { ar: 'افتح هذا الرابط في Safari.', en: 'Open this link in Safari.' },
    { ar: 'اضغط «مشاركة»، ثم «إضافة إلى الشاشة الرئيسية». قد تحتاج إلى فتح قائمة «المزيد» أولًا.', en: 'Tap Share, then Add to Home Screen. You may need to open the More menu first.' },
    { ar: 'فعّل «فتح كتطبيق ويب» إذا ظهر، ثم اضغط «إضافة».', en: 'Turn on Open as Web App if shown, then tap Add.' },
  ],
  android: { ar: 'على Android', en: 'On Android' },
  androidSteps: [
    { ar: 'افتح الرابط في Chrome.', en: 'Open the link in Chrome.' },
    { ar: 'من قائمة المتصفح ⋮، اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».', en: 'In the browser menu ⋮, choose Install app or Add to Home screen.' },
    { ar: 'أكّد التثبيت أو الإضافة.', en: 'Confirm installation or addition.' },
  ],
  desktop: { ar: 'على الكمبيوتر', en: 'On desktop' },
  desktopSteps: [
    { ar: 'افتح الرابط في Chrome أو Microsoft Edge.', en: 'Open the link in Chrome or Microsoft Edge.' },
    { ar: 'اضغط أيقونة التثبيت بجوار شريط العنوان، أو اختر تثبيت هذا الموقع من قائمة المتصفح.', en: 'Click the install icon beside the address bar, or choose to install this site from the browser menu.' },
    { ar: 'على Mac في Safari، يمكنك اختيار «ملف» ثم «إضافة إلى Dock» إذا كان الخيار متاحًا.', en: 'In Safari on Mac, choose File, then Add to Dock if available.' },
  ],
};
type Platform = 'ios' | 'android' | 'desktop';

export default function InstallApp({ lang, languageSwitch }: { lang: Lang; languageSwitch: ReactNode }) {
  const state = useSyncExternalStore(subscribeInstall, getInstallState, getServerInstallState);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [platform, setPlatform] = useState<Platform>('desktop');
  const entry = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setPlatform(ios ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop');
  }, []);
  useEffect(() => { if (state === 'installed') setOpen(false); }, [state]);
  const platforms: Platform[] = [platform, ...(['ios', 'android', 'desktop'] as const).filter(item => item !== platform)];
  const install = async () => {
    setFailed(false);
    const result = await promptInstall();
    if (result === 'accepted') setOpen(false);
    else if (result === 'error' || result === 'unavailable') setFailed(true);
  };
  const openInstall = () => {
    // Load the owner's dedicated install document before the browser saves app metadata.
    if (hasOwnerEntry() && !isOwnerLaunchPage()) {
      location.assign(ownerLaunchUrl());
      return;
    }
    setFailed(false); setOpen(true);
  };
  if (state === 'installed') return null;
  return <>
    <button ref={entry} className="install-entry" type="button" onClick={openInstall}><Download size={15} aria-hidden="true" />{words.button[lang]}</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="install-dialog" showCloseButton={false} dir={lang === 'ar' ? 'rtl' : 'ltr'} onCloseAutoFocus={event => { event.preventDefault(); entry.current?.focus({ preventScroll: true }); }}>
      <div className="install-heading"><div><DialogTitle>{words.title[lang]}</DialogTitle><DialogDescription>{words.intro[lang]}</DialogDescription></div><button className="install-close" type="button" aria-label={ui.close[lang]} onClick={() => setOpen(false)}><X size={22} /></button></div>
      <div className="install-languages">{languageSwitch}</div>
      {state === 'ready' && <button className="button primary install-native" type="button" onClick={() => void install()}><Download size={18} />{words.install[lang]}</button>}
      {state === 'prompting' && <p className="install-message" role="status">{words.installing[lang]}</p>}
      {failed && <p className="install-message" role="alert">{words.failed[lang]}</p>}
      <div className="install-guides">{platforms.map((item, index) => {
        const steps = words[`${item}Steps`];
        const heading = <span className="install-platform">{item === 'desktop' ? <Monitor size={19} /> : <Smartphone size={19} />}{words[item][lang]}</span>;
        const list = <ol>{steps.map((step, number) => <li key={number}>{step[lang]}</li>)}</ol>;
        return index === 0 ? <section className="install-guide" key={item}><h3>{heading}</h3>{list}</section> : <details className="install-guide" key={item}><summary>{heading}</summary>{list}</details>;
      })}</div>
      <p className="install-note">{words.connection[lang]}</p>
    </DialogContent></Dialog>
  </>;
}
