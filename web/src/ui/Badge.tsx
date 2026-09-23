import type { JSX } from 'preact';
import type { UpcomingStatus } from '../api/types';

const CLASS: Record<UpcomingStatus, string> = {
  'Overdue': 'badge-overdue',
  'Due soon': 'badge-soon',
  'OK': 'badge-ok',
  'Watch': 'badge-watch',
  'Declined': 'badge-declined',
  'Recall': 'badge-recall',
  'No history': 'badge-nohistory',
};

/** Status badge: colour always carries a word (never colour alone). */
export function StatusBadge(props: { status: UpcomingStatus }): JSX.Element {
  return <span class={`badge ${CLASS[props.status] ?? 'badge-ok'}`}>{props.status}</span>;
}

export function CoveredBadge(props: { plan: string }): JSX.Element {
  return <span class="badge badge-covered">Covered: {props.plan}</span>;
}

export function Tag(props: { children: string }): JSX.Element {
  return <span class="tag">{props.children}</span>;
}
