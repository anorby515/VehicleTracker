/**
 * Inline SVG icons (SF Symbols-like strokes). Decorative by default: pass
 * `label` only when the icon is the sole content of a control without text.
 */

import type { JSX } from 'preact';

const PATHS: Record<string, string> = {
  camera: 'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.2-2h5l1.2 2h1.8A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z M12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.3 15.3 20 20',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5a7.7 7.7 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.7 7.7 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 2.6-1.5l2.4 1 2-3.5z',
  chevronRight: 'M9 5l7 7-7 7',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronDown: 'M5 9l7 7 7-7',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h10v11H9z M5 15V4h10',
  gauge: 'M4 16a8 8 0 1 1 16 0 M12 16l4-5 M4 16h2 M18 16h2 M12 8V6',
  wrench: 'M14.5 6.5a4 4 0 0 1 5 5l-9 9a2.1 2.1 0 0 1-3-3l9-9a4 4 0 0 1-2-2z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 7.5v.5',
  doc: 'M7 3h7l5 5v13H7z M14 3v5h5 M10 13h6 M10 17h6',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4z M10 20a2 2 0 0 0 4 0',
  share: 'M12 3v12 M8 7l4-4 4 4 M5 12v8h14v-8',
  upload: 'M12 16V4 M7 9l5-5 5 5 M5 20h14',
  check: 'M5 12.5l4.5 4.5L19 7',
  alert: 'M12 3 2 20h20z M12 10v4 M12 17v.5',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  up: 'M12 19V5 M6 11l6-6 6 6',
  down: 'M12 5v14 M6 13l6 6 6-6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  car: 'M4 16v-4l2-5h12l2 5v4 M4 16h16 M4 16v3h3v-3 M17 16v3h3v-3 M7 13h.5 M16.5 13h.5',
  calendar: 'M4 6h16v15H4z M4 10h16 M8 3v4 M16 3v4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  tire: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  dollar: 'M12 3v18 M16 7.5C16 5.5 14 5 12 5s-4 .8-4 3 2.5 2.7 4 3 4 .8 4 3-2 3-4 3-4-.5-4-2.5',
  flag: 'M5 21V4 M5 4h11l-2 4 2 4H5',
  photo: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15.5 9.5h.01',
  file: 'M7 3h7l5 5v13H7z M14 3v5h5',
  pencil: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  signOut: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10',
  more: 'M6 12h.01 M12 12h.01 M18 12h.01',
  drive: 'M8 4h8l6 10-4 6H6l-4-6z M8 4l8 16 M16 4 8 20 M2 14h20',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4 12H2 M22 12h-2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5',
};

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; label?: string; class?: string; strokeWidth?: number }): JSX.Element {
  const { name, size = 22, label, strokeWidth = 1.9 } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
