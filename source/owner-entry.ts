// Owner context exposes only the sign-in entry and excludes measurement. It is not authentication.
export const OWNER_ENTRY_KEY = 'aa-owner-entry';

export function isOwnerLaunchPage() {
  if (typeof window === 'undefined') return false;
  const current = new URL(location.href);
  return current.pathname === new URL('./owner-app.html', current).pathname;
}

export function hasOwnerEntry() {
  if (typeof window === 'undefined') return false;
  if (isOwnerLaunchPage() || new URL(location.href).searchParams.get('aa_no_track') === '1') return true;
  try { return localStorage.getItem(OWNER_ENTRY_KEY) === '1'; } catch { return false; }
}

export function ownerLaunchUrl() {
  const url = new URL('./owner-app.html', location.href);
  url.hash = location.hash || '#top';
  return url.href;
}
