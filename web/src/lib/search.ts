/**
 * Search across every vehicle's journal (spec 8.10), on the data already on
 * the phone, so it works offline.
 *
 * - Searched per visit: Summary, Location, each service's Service Type and
 *   Description, and each recommendation's Item (plus the visit's year).
 * - Several words are ANDed. Each word may match the visit's text OR the
 *   vehicle (name, make, model, short name), so "brakes jeep" finds the Jeep's
 *   brake service.
 * - Case, accents and punctuation are ignored; simple plurals are folded
 *   ("brakes" → "brake", "batteries" → "battery"); words of 3+ letters also
 *   match as prefixes ("rot" finds "rotors").
 * - Results are grouped by vehicle (vehicle order), newest visit first.
 */

import type { Vehicle, Visit } from '../api/types';
import { ymdToDay } from './format';

export type SnippetField = 'summary' | 'service' | 'recommendation' | 'location';

export interface Snippet {
  field: SnippetField;
  /** The field's text as shown ("Brake Service: Rear brake pads and rotors"). */
  text: string;
  /** [start, end) character ranges in `text` to highlight. */
  ranges: [number, number][];
}

export interface SearchHit {
  visit: Visit;
  /** Where a query word matched in the visit's own text; null when only the vehicle matched. */
  snippet: Snippet | null;
}

export interface SearchGroup {
  vehicle: Vehicle;
  hits: SearchHit[];
}

export interface SearchResult {
  terms: string[];
  groups: SearchGroup[];
  total: number;
}

// ---------------------------------------------------------------- normalising

const WORD = /[\p{L}\p{N}]+/gu;

/** Lower-case, strip accents. */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Very small English plural folding. Enough for receipts: brakes, tires,
 * filters, wipers, rotors, batteries, boxes, glasses, services.
 */
export function stem(word: string): string {
  const w = word;
  if (w.length <= 3) return w;
  if (/\d/.test(w)) return w; // part numbers, "4runner", "x7"
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (/(?:x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Text → normalised, stemmed words. */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of fold(text).matchAll(WORD)) out.push(stem(m[0]));
  return out;
}

/** Query → unique stemmed terms, in the order typed. */
export function queryTerms(query: string): string[] {
  return Array.from(new Set(tokenize(query)));
}

function termMatches(term: string, word: string): boolean {
  return word === term || (term.length >= 3 && word.startsWith(term));
}

function anyWordMatches(term: string, words: string[]): boolean {
  for (const w of words) if (termMatches(term, w)) return true;
  return false;
}

/** Character ranges in `text` whose words match any of `terms`. */
export function matchRanges(text: string, terms: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(WORD)) {
    const word = stem(fold(m[0]));
    if (terms.some(t => termMatches(t, word))) ranges.push([m.index!, m.index! + m[0].length]);
  }
  return ranges;
}

// ---------------------------------------------------------------- index

interface Field {
  field: SnippetField;
  text: string;
  words: string[];
}

interface VisitDoc {
  visit: Visit;
  fields: Field[];
  words: string[];
}

function visitFields(v: Visit): Field[] {
  const fields: Field[] = [];
  const add = (field: SnippetField, text: string | null | undefined) => {
    if (text && text.trim()) fields.push({ field, text, words: tokenize(text) });
  };
  add('summary', v.summary);
  for (const s of v.services) {
    const text = [s.serviceType, s.description].filter(Boolean).join(': ');
    add('service', text);
  }
  for (const r of v.recommendations) add('recommendation', r.item);
  add('location', v.location);
  return fields;
}

function vehicleWords(v: Vehicle): string[] {
  return tokenize([v.name, v.make, v.model, v.shortName].filter(Boolean).join(' '));
}

/** Newest first by date, then mileage (undated last). */
function compareVisits(a: Visit, b: Visit): number {
  const da = ymdToDay(a.date), db = ymdToDay(b.date);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return db - da;
  }
  return (b.mileage ?? -1) - (a.mileage ?? -1);
}

// ---------------------------------------------------------------- search

/**
 * Searches every visit of every vehicle. An empty query returns no groups.
 * `limitPerVehicle` caps each group (default: no cap).
 */
export function searchVisits(vehicles: Vehicle[], query: string, limitPerVehicle = Infinity): SearchResult {
  const terms = queryTerms(query);
  const result: SearchResult = { terms, groups: [], total: 0 };
  if (!terms.length) return result;

  for (const vehicle of vehicles) {
    const vWords = vehicleWords(vehicle);
    const hits: SearchHit[] = [];
    for (const visit of vehicle.visits) {
      const fields = visitFields(visit);
      const year = visit.date ? visit.date.slice(0, 4) : null;
      const doc: VisitDoc = { visit, fields, words: fields.flatMap(f => f.words).concat(year ? [year] : []) };
      let ok = true;
      const textTerms: string[] = [];
      for (const t of terms) {
        const inText = anyWordMatches(t, doc.words);
        if (inText) textTerms.push(t);
        else if (!anyWordMatches(t, vWords)) { ok = false; break; }
      }
      if (!ok) continue;
      hits.push({ visit, snippet: bestSnippet(fields, textTerms) });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => compareVisits(a.visit, b.visit));
    result.total += hits.length;
    result.groups.push({ vehicle, hits: hits.slice(0, limitPerVehicle) });
  }
  return result;
}

/**
 * The field that best explains the match: the one matching the most query
 * words, preferring services and recommendations (they add information that
 * the summary line on the result row doesn't already show).
 */
function bestSnippet(fields: Field[], terms: string[]): Snippet | null {
  if (!terms.length) return null;
  const order: Record<SnippetField, number> = { service: 0, recommendation: 1, summary: 2, location: 3 };
  let best: { f: Field; score: number } | null = null;
  for (const f of fields) {
    const score = terms.filter(t => anyWordMatches(t, f.words)).length;
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && order[f.field] < order[best.f.field])) best = { f, score };
  }
  if (!best) return null;
  return { field: best.f.field, text: best.f.text, ranges: matchRanges(best.f.text, terms) };
}

/** Splits text into plain and highlighted parts for rendering with <mark>. */
export function highlightParts(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s > pos) parts.push({ text: text.slice(pos, s), hit: false });
    parts.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), hit: false });
  return parts;
}
