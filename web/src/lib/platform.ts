/**
 * Platform detection for the iPhone home-screen app.
 *
 * "Standalone" means the app was opened from the home screen icon. Web Push,
 * the app badge and persistent storage only work there; in a Safari tab the
 * app still works but shows the Add to Home Screen guide once.
 */

import { signal } from '@preact/signals';

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia?.('(display-mode: standalone)').matches === true
    );
  } catch {
    return false;
  }
}

/** Live: true when running as a home-screen app. Follows display-mode changes. */
export const standalone = signal<boolean>(detectStandalone());

if (typeof window !== 'undefined') {
  try {
    const mq = window.matchMedia?.('(display-mode: standalone)');
    mq?.addEventListener?.('change', () => { standalone.value = detectStandalone(); });
  } catch {
    /* old Safari without addEventListener on MediaQueryList */
  }
}

export function isStandalone(): boolean {
  return standalone.value;
}

/** True on iPhone/iPad (including iPadOS, which reports itself as a Mac with touch). */
export function isIOS(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent, maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}

/** Automated browsers (Playwright) skip first-run guides unless a test asks for them. */
export function isAutomated(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.webdriver === true;
  } catch {
    return false;
  }
}

/**
 * A short device label for Push Subscriptions › Device Label ("iPhone",
 * "iPad", "Mac", "Android phone", "Computer"). Never includes the full UA.
 */
export function deviceLabel(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent, maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPod/.test(ua)) return 'iPod';
  if (/Macintosh/.test(ua)) return maxTouchPoints > 1 ? 'iPad' : 'Mac';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Browser';
}
