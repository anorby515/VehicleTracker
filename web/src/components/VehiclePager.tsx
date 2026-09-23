/**
 * One full-screen page per vehicle, swiped left and right (spec 2, 10.3).
 *
 * Recipe from the iOS research (ios-pwa §9):
 * - The pager scrolls horizontally with mandatory scroll snapping; each page
 *   snaps at its start and stops there (scroll-snap-stop: always), so a fast
 *   flick can't fly past several vehicles.
 * - Each page is its own vertical scroller with a height fixed to the pager
 *   (the viewport minus the top bar), so every vehicle keeps its own scroll
 *   position. overscroll-behavior keeps rubber-banding from chaining.
 * - The current page is tracked with an IntersectionObserver (60% visible),
 *   not scroll events (scrollend is too new on iOS).
 * - WebKit caches snap positions, so the position is re-asserted after a
 *   resize, a rotation or a data reload.
 * - Nothing position:fixed lives inside the pages (the Add Receipt button and
 *   sheets sit outside).
 */

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { Vehicle } from '../api/types';
import { VehicleCard } from '../vehicle/VehicleCard';
import { PullToRefresh } from './PullToRefresh';
import './VehiclePager.css';

export interface PagerApi {
  /** Scrolls to a page. Smooth for taps on the dots; instant for deep links. */
  scrollTo(index: number, smooth: boolean): void;
}

export interface VehiclePagerProps {
  vehicles: Vehicle[];
  /** The page to show (Main keeps it in sync with the route). */
  current: number;
  /** The user swiped (or a dot scroll arrived) to another page. */
  onCurrentChange: (index: number) => void;
  onRefresh: () => Promise<boolean>;
  /** Receives the imperative API once mounted. */
  apiRef: { current: PagerApi | null };
  /** Renders what goes at the top of every page, above the vehicle card (status chips, cards). */
  pageTop?: () => ComponentChildren;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function VehiclePager(props: VehiclePagerProps): JSX.Element {
  const pagerRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef(props.current);
  const reportedRef = useRef(props.current);
  /** A dot tap's destination: pages passed on the way are ignored until `until`, or while still scrolling (up to `hardStop`). */
  const targetRef = useRef<{ index: number; until: number; hardStop: number } | null>(null);
  const lastScrollAt = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  // A slow phone (or a busy one) can take longer than usual to finish a smooth scroll.
  const stillScrolling = () => Date.now() - lastScrollAt.current < 200;

  const jump = (index: number) => {
    const el = pagerRef.current;
    if (!el) return;
    const left = index * el.clientWidth;
    if (Math.abs(el.scrollLeft - left) > 1) el.scrollTo({ left, behavior: 'instant' as ScrollBehavior });
  };

  props.apiRef.current = {
    scrollTo(index, smooth) {
      const el = pagerRef.current;
      if (!el || index < 0 || index >= propsRef.current.vehicles.length) return;
      currentRef.current = index;
      if (smooth && !prefersReducedMotion()) {
        // Ignore the pages we pass on the way; report the target straight away.
        const target = { index, until: Date.now() + 1200, hardStop: Date.now() + 4000 };
        targetRef.current = target;
        reportedRef.current = index;
        propsRef.current.onCurrentChange(index);
        el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
        // If the scroll was interrupted, settle on wherever it actually stopped.
        const settle = () => {
          if (targetRef.current !== target || !pagerRef.current) return;
          if (stillScrolling() && Date.now() < target.hardStop) { setTimeout(settle, 150); return; }
          targetRef.current = null;
          const at = Math.round(pagerRef.current.scrollLeft / Math.max(1, pagerRef.current.clientWidth));
          currentRef.current = at;
          if (at !== reportedRef.current) {
            reportedRef.current = at;
            propsRef.current.onCurrentChange(at);
          }
        };
        setTimeout(settle, 1300);
      } else {
        targetRef.current = null;
        jump(index);
      }
    },
  };

  // Keep the position when the current page changes from outside (route) or the data reloads.
  useLayoutEffect(() => {
    currentRef.current = props.current;
    reportedRef.current = props.current;
    if (!targetRef.current) jump(props.current);
  }, [props.current, props.vehicles]);

  // Track the page that is at least 60% on screen.
  useEffect(() => {
    const root = pagerRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting || e.intersectionRatio < 0.6) continue;
        const index = Number((e.target as HTMLElement).dataset.index);
        if (!Number.isFinite(index)) continue;
        const target = targetRef.current;
        if (target) {
          const now = Date.now();
          if (index !== target.index && (now < target.until || (stillScrolling() && now < target.hardStop))) continue;
          targetRef.current = null;
        }
        currentRef.current = index;
        if (index !== reportedRef.current) {
          reportedRef.current = index;
          propsRef.current.onCurrentChange(index);
        }
      }
    }, { root, threshold: [0.6] });
    root.querySelectorAll<HTMLElement>(':scope > .pager-page').forEach(p => io.observe(p));
    const onScroll = () => { lastScrollAt.current = Date.now(); };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => { io.disconnect(); root.removeEventListener('scroll', onScroll); };
  }, [props.vehicles]);

  // WebKit forgets where it was after rotation or a size change.
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => jump(currentRef.current));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={pagerRef} class="pager" aria-roledescription="carousel" aria-label="Vehicles">
      {props.vehicles.map((v, i) => (
        <Page key={v.name} vehicle={v} index={i} count={props.vehicles.length} active={i === props.current} onRefresh={props.onRefresh}>
          {props.pageTop?.()}
        </Page>
      ))}
    </div>
  );
}

function Page(props: {
  vehicle: Vehicle;
  index: number;
  count: number;
  active: boolean;
  onRefresh: () => Promise<boolean>;
  children?: ComponentChildren;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      class="pager-page"
      data-index={props.index}
      data-vehicle={props.vehicle.name}
      role="group"
      aria-roledescription="slide"
      aria-label={`${props.vehicle.name}, ${props.index + 1} of ${props.count}`}
      aria-hidden={props.active ? undefined : 'true'}
    >
      <PullToRefresh scrollerRef={ref} onRefresh={props.onRefresh}>
        <div class="pager-page-inner">
          {props.children}
          <VehicleCard vehicle={props.vehicle} active={props.active} />
        </div>
      </PullToRefresh>
    </div>
  );
}
