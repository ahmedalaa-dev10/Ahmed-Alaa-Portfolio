type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type InstallState = 'idle' | 'ready' | 'prompting' | 'installed';
const listeners = new Set<() => void>();
let state: InstallState = 'idle';
let deferred: InstallPrompt | null = null;
let started = false;

function publish(next: InstallState) {
  if (state === next) return;
  state = next;
  listeners.forEach(listener => listener());
}
function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: minimal-ui)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
export function initPwa() {
  if (started) return;
  started = true;
  // Each entry document declares its fixed manifest before JavaScript executes.
  if (isInstalled()) publish('installed');
  window.addEventListener('beforeinstallprompt', event => {
    if (isInstalled() || state === 'installed') return;
    event.preventDefault();
    deferred = event as InstallPrompt;
    publish('ready');
  });
  window.addEventListener('appinstalled', () => { deferred = null; publish('installed'); });
  const display = matchMedia('(display-mode: standalone)');
  display.addEventListener('change', () => { if (isInstalled()) { deferred = null; publish('installed'); } });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    const register = () => {
      // Cache only the public offline screen and its fonts; never the portfolio or owner APIs.
      void navigator.serviceWorker.register(new URL('./sw.js', document.baseURI), {
        scope: new URL('./', document.baseURI).href,
        updateViaCache: 'none',
      }).catch(() => {});
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

export function subscribeInstall(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const getInstallState = () => state;
export const getServerInstallState = (): InstallState => 'idle';

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable' | 'error'> {
  const prompt = deferred;
  if (!prompt || state !== 'ready') return 'unavailable';
  deferred = null;
  publish('prompting');
  try {
    await prompt.prompt();
    return (await prompt.userChoice).outcome;
  } catch {
    return 'error';
  } finally {
    if (getInstallState() !== 'installed') publish('idle');
  }
}
