/**
 * Pull-to-refresh for a vertical scroller (home-screen apps have no reload
 * button and no native pull-to-refresh). Starts only when the scroller is at
 * the very top and the finger moves mostly downward, so horizontal vehicle
 * swipes are never taken over. Past ~70 px it refreshes and shows a spinner.
 */

import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../ui/Icon';
import './PullToRefresh.css';

const THRESHOLD = 70;   // px of (damped) pull that triggers a refresh
const MAX_PULL = 120;
const RESISTANCE = 0.5;
const HOLD = 52;        // where the content rests while refreshing

type Phase = 'idle' | 'pulling' | 'ready' | 'refreshing' | 'done';

export interface PullToRefreshProps {
  /** The element that scrolls vertically (the vehicle page). */
  scrollerRef: RefObject<HTMLElement>;
  /** Resolves true on success. */
  onRefresh: () => Promise<boolean | void>;
  disabled?: boolean;
  children: ComponentChildren;
}

export function PullToRefresh(props: PullToRefreshProps): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const phaseRef = useRef<Phase>('idle');
  const propsRef = useRef(props);
  propsRef.current = props;

  const setBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  const place = (y: number, animate: boolean) => {
    const c = contentRef.current, ind = indicatorRef.current;
    const t = animate ? 'transform 0.25s ease-out' : 'none';
    if (c) {
      c.style.transition = t;
      c.style.transform = y ? `translateY(${y}px)` : '';
    }
    if (ind) {
      ind.style.transition = animate ? `${t}, opacity 0.25s` : 'none';
      ind.style.transform = `translateY(${y - HOLD}px)`;
      ind.style.opacity = String(Math.min(1, y / THRESHOLD));
      ind.style.setProperty('--turn', `${Math.min(1, y / THRESHOLD) * 180}deg`);
    }
  };

  useEffect(() => {
    const el = props.scrollerRef.current;
    if (!el) return;
    let startX = 0, startY = 0, dist = 0;
    let tracking = false, decided = false, pulling = false;

    const onStart = (e: TouchEvent) => {
      tracking = false;
      if (propsRef.current.disabled || e.touches.length !== 1) return;
      if (phaseRef.current === 'refreshing' || el.scrollTop > 0) return;
      tracking = true;
      decided = false;
      pulling = false;
      dist = 0;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true;
        if (Math.abs(dx) >= Math.abs(dy) || dy <= 0 || el.scrollTop > 0) {
          tracking = false; // a swipe between vehicles, or a normal scroll
          return;
        }
        pulling = true;
        setBoth('pulling');
      }
      if (!pulling) return;
      if (e.cancelable) e.preventDefault(); // no rubber band while pulling
      dist = Math.max(0, Math.min(MAX_PULL, dy * RESISTANCE));
      place(dist, false);
      const next: Phase = dist >= THRESHOLD ? 'ready' : 'pulling';
      if (next !== phaseRef.current) setBoth(next);
    };

    const onEnd = () => {
      if (!tracking || !pulling) { tracking = false; return; }
      tracking = false;
      pulling = false;
      if (dist < THRESHOLD) {
        place(0, true);
        setBoth('idle');
        return;
      }
      void run();
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  async function run() {
    setBoth('refreshing');
    setStatus('Refreshing…');
    place(HOLD, true);
    let ok: boolean | void = false;
    try {
      ok = await propsRef.current.onRefresh();
    } catch {
      ok = false;
    }
    setStatus(ok === false ? 'Couldn’t refresh. Showing saved data.' : 'Up to date');
    setBoth('done');
    place(0, true);
    setTimeout(() => { if (phaseRef.current === 'done') setBoth('idle'); }, 300);
  }

  return (
    <div class="ptr">
      <div ref={indicatorRef} class={`ptr-indicator ptr-${phase}`} aria-hidden="true">
        {phase === 'refreshing' ? <span class="spinner" /> : <span class="ptr-arrow"><Icon name="down" size={20} /></span>}
      </div>
      <div ref={contentRef} class="ptr-content">{props.children}</div>
      <div class="visually-hidden" role="status" aria-live="polite">{status}</div>
    </div>
  );
}
