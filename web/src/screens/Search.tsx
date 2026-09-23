/**
 * Search across all vehicles (spec 8.10), on #/search?q=…. Runs on the data
 * already on the phone, so it works offline. Tapping a result opens the visit;
 * closing the visit comes back here with the same words.
 */

import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Visit } from '../api/types';
import { formatDate } from '../lib/format';
import { highlightParts, searchVisits, type Snippet } from '../lib/search';
import { back, go, href } from '../state/router';
import { vehicles } from '../state/store';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
import './Search.css';

const FIELD_LABEL: Record<Snippet['field'], string> = {
  summary: 'Summary',
  service: 'Service',
  recommendation: 'Recommendation',
  location: 'Shop',
};

export function SearchScreen(props: { q: string }): JSX.Element {
  const [text, setText] = useState(props.q);
  const inputRef = useRef<HTMLInputElement>(null);
  const result = useMemo(() => searchVisits(vehicles.value, text), [vehicles.value, text]);

  // The sheet focuses itself when it opens; take focus for the field right after.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // Keep the words in the route (replace, no history), so "back" from a visit restores them.
  const syncRoute = () => {
    // Only while the search is still the current screen (not after a result was opened).
    if (!location.hash.startsWith('#/search')) return;
    const want = href.search(text.trim());
    if (location.hash !== want) go(want, true);
  };
  useEffect(() => {
    const t = setTimeout(syncRoute, 250);
    return () => clearTimeout(t);
  }, [text]);

  const open = (vehicle: string, visitId: string) => {
    syncRoute();
    go(href.visit(vehicle, visitId));
  };

  const clear = () => {
    setText('');
    inputRef.current?.focus();
  };

  const trimmed = text.trim();
  return (
    <Sheet title="Search" onClose={() => back(href.home())} class="search-sheet">
      <form class="search-bar" role="search" onSubmit={e => { e.preventDefault(); inputRef.current?.blur(); }}>
        <div class="search-field">
          <Icon name="search" size={18} class="search-field-icon" />
          <input
            ref={inputRef}
            type="search"
            class="search-input"
            value={text}
            onInput={e => setText((e.currentTarget as HTMLInputElement).value)}
            placeholder="Visits, shops, services"
            aria-label="Search all vehicles"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            spellcheck={false}
            enterKeyHint="search"
          />
          {text && (
            <button type="button" class="search-clear" aria-label="Clear search" onClick={clear}>
              <span class="search-clear-circle"><Icon name="close" size={12} strokeWidth={3} /></span>
            </button>
          )}
        </div>
      </form>

      <div class="visually-hidden" role="status" aria-live="polite">
        {trimmed ? (result.total ? `${result.total} ${result.total === 1 ? 'visit' : 'visits'} found` : 'No matches') : ''}
      </div>

      {!trimmed && (
        <p class="empty search-hint">
          Search every vehicle’s service history: summaries, shops, services and recommendations.
          Try “brakes jeep” or “oil 2025”.
        </p>
      )}

      {trimmed && !result.total && (
        <div class="empty search-empty">
          <p class="headline">No matches</p>
          <p class="subhead">Nothing in the journal matches “{trimmed}”. Try fewer or shorter words.</p>
        </div>
      )}

      {result.groups.map(g => (
        <section key={g.vehicle.name} class="section search-group" aria-label={g.vehicle.name}>
          <div class="section-header">
            <h3>{g.vehicle.name}</h3>
            <span>{g.hits.length} {g.hits.length === 1 ? 'visit' : 'visits'}</span>
          </div>
          <div class="group">
            {g.hits.map(h => (
              <ResultRow key={h.visit.visitId} visit={h.visit} snippet={h.snippet} onOpen={() => open(g.vehicle.name, h.visit.visitId)} />
            ))}
          </div>
        </section>
      ))}
    </Sheet>
  );
}

function ResultRow(props: { visit: Visit; snippet: Snippet | null; onOpen: () => void }): JSX.Element {
  const v = props.visit;
  const title = v.summary || v.services.find(s => s.serviceType)?.serviceType || 'Visit';
  const meta = [formatDate(v.date, 'No date'), v.location].filter(Boolean).join(' · ');
  const snippet = props.snippet && !(props.snippet.field === 'summary' && props.snippet.text === v.summary) ? props.snippet : null;
  return (
    <button type="button" class="row tappable search-result" onClick={props.onOpen}>
      <span class="row-main">
        <span class="search-meta">{meta}</span>
        <span class="row-title search-title">{props.snippet?.field === 'summary' ? <Highlight snippet={props.snippet} /> : title}</span>
        {snippet && (
          <span class="search-snippet">
            <span class="search-snippet-label">{FIELD_LABEL[snippet.field]}: </span>
            <Highlight snippet={snippet} />
          </span>
        )}
      </span>
      <Icon name="chevronRight" size={18} class="row-chevron" />
    </button>
  );
}

function Highlight(props: { snippet: Snippet }): JSX.Element {
  return (
    <>
      {highlightParts(props.snippet.text, props.snippet.ranges).map((p, i) =>
        p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}
