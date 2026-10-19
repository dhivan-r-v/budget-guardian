import { api } from './api.js';

// Device alerts through the browser's Push API and the service worker in public/sw.js.

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// 'ok', 'ios-home-screen' (iPhone/iPad only allow push after Add to Home Screen),
// 'insecure' (needs https or localhost) or 'unsupported'.
export function pushSupport() {
  if (!window.isSecureContext) return 'insecure';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok';
  if (isIOS() && !standalone()) return 'ios-home-screen';
  return 'unsupported';
}

const registration = () => navigator.serviceWorker.register('/sw.js');

export async function currentSubscription() {
  if (pushSupport() !== 'ok') return null;
  return (await registration()).pushManager.getSubscription();
}

// The base64url VAPID key as the bytes PushManager.subscribe() wants.
function keyBytes(base64url) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Must run from a click: browsers only show the permission prompt for a user gesture.
export async function turnOn(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.' : 'Notifications were not allowed.');
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key can't receive this server's alerts.
  if (sub && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey ?? []))) !== btoa(String.fromCharCode(...keyBytes(publicKey)))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return post('/api/alerts/subscribe', { subscription: sub.toJSON() });
}

export async function turnOff() {
  const sub = await currentSubscription();
  if (!sub) return;
  await post('/api/alerts/unsubscribe', { endpoint: sub.endpoint }).catch(() => null);
  await sub.unsubscribe();
}

export const sendTest = (endpoint) => post('/api/alerts/test', { endpoint });

// Re-registers an existing subscription, e.g. after the server's database was reset.
export const resync = (sub) => post('/api/alerts/subscribe', { subscription: sub.toJSON() });
