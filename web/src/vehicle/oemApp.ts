/**
 * Opening a manufacturer's app from the home-screen web app (spec 8.13).
 *
 * There is no reliable way to ask iOS whether an app is installed. So the
 * tap handler starts a short timer and then navigates to the app's link:
 * - if the app opens, the web app is backgrounded, which fires
 *   visibilitychange → hidden (or pagehide), and the timer is cancelled;
 * - if nothing happens (or iOS shows its "address is invalid" alert), the
 *   page stays visible and the timer fires: the caller then reveals an
 *   inline "Didn't open? Get <App> on the App Store" link. Never redirect
 *   to the App Store automatically.
 *
 * `blur` is deliberately NOT treated as success: iOS's invalid-address
 * alert blurs the page even though the app never opened.
 */

/** How long to wait for the app to take over before offering the App Store. */
export const OEM_OPEN_TIMEOUT_MS = 2000;

export interface LaunchOptions {
  /** Called when the page is still visible after the timeout (the app probably isn't installed). */
  onFail: () => void;
  timeoutMs?: number;
  /** Navigates to the link. Defaults to `location.href = link` (injected by tests). */
  navigate?: (link: string) => void;
  doc?: Document;
  win?: Window;
}

/**
 * Tries to open `link` (a URL scheme or universal link). Must be called
 * inside the tap handler. Returns a function that cancels the fallback
 * timer and removes the listeners (e.g. when the component unmounts).
 */
export function launchOemApp(link: string, opts: LaunchOptions): () => void {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const navigate = opts.navigate ?? ((url: string) => { win.location.href = url; });
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onHide);
  };
  // The app came up (or the user left): no fallback needed.
  const onHide = () => cleanup();
  const onVisibility = () => { if (doc.visibilityState === 'hidden') cleanup(); };

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onHide);
  timer = setTimeout(() => {
    timer = null;
    const stillHere = doc.visibilityState !== 'hidden';
    cleanup();
    if (stillHere) opts.onFail();
  }, opts.timeoutMs ?? OEM_OPEN_TIMEOUT_MS);

  try {
    navigate(link);
  } catch {
    // A malformed link throws synchronously in some browsers: offer the store straight away.
    cleanup();
    opts.onFail();
  }
  return cleanup;
}
