import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OEM_OPEN_TIMEOUT_MS, launchOemApp } from './oemApp';

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
});

function hide(): void {
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('launchOemApp', () => {
  it('navigates to the link inside the tap', () => {
    const navigate = vi.fn();
    launchOemApp('sample-oem://', { onFail: vi.fn(), navigate });
    expect(navigate).toHaveBeenCalledWith('sample-oem://');
  });

  it('offers the App Store when the page is still visible after the timeout', () => {
    const onFail = vi.fn();
    launchOemApp('sample-oem://', { onFail, navigate: () => {} });
    vi.advanceTimersByTime(OEM_OPEN_TIMEOUT_MS - 1);
    expect(onFail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('does nothing more when the app takes over (page hidden)', () => {
    const onFail = vi.fn();
    launchOemApp('sample-oem://', { onFail, navigate: () => {} });
    hide();
    vi.advanceTimersByTime(OEM_OPEN_TIMEOUT_MS * 2);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('treats pagehide as success too', () => {
    const onFail = vi.fn();
    launchOemApp('sample-oem://', { onFail, navigate: () => {} });
    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(OEM_OPEN_TIMEOUT_MS * 2);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('ignores blur (iOS fires it for the "address is invalid" alert)', () => {
    const onFail = vi.fn();
    launchOemApp('sample-oem://', { onFail, navigate: () => {} });
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(OEM_OPEN_TIMEOUT_MS);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled (component unmounted)', () => {
    const onFail = vi.fn();
    const cancel = launchOemApp('sample-oem://', { onFail, navigate: () => {} });
    cancel();
    vi.advanceTimersByTime(OEM_OPEN_TIMEOUT_MS * 2);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('offers the store at once when navigating throws', () => {
    const onFail = vi.fn();
    launchOemApp('not a link', { onFail, navigate: () => { throw new TypeError('bad url'); } });
    expect(onFail).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(OEM_OPEN_TIMEOUT_MS * 2);
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});
