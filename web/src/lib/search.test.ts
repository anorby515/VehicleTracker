import { describe, expect, it } from 'vitest';
import type { Vehicle, Visit } from '../api/types';
import { highlightParts, matchRanges, queryTerms, searchVisits, stem, tokenize } from './search';

function visit(p: Partial<Visit> & { visitId: string }): Visit {
  return {
    date: null, mileage: null, location: null, roNumber: null, summary: null, invoiceTotal: null, amountPaid: null,
    cardSurcharge: null, dealerNextDueDate: null, dealerNextDueMiles: null, source: 'Receipt', sourceTag: null,
    beforeOwnership: false, notes: null, services: [], documents: [], recommendations: [], readings: [],
    ...p,
  };
}

function vehicle(name: string, make: string, model: string, shortName: string, visits: Visit[]): Vehicle {
  return { name, make, model, shortName, visits } as unknown as Vehicle;
}

const jeep = vehicle('2016 Jeep Wrangler', 'Jeep', 'Wrangler', 'Wrangler', [
  visit({
    visitId: 'jp-1', date: '2023-08-01', mileage: 54800, location: 'Stop Right Brakes',
    summary: 'Rear brake pads and rotors, brake inspection',
    services: [
      { serviceType: 'Brake Service', description: 'Rear brake pads and rotors', lineCost: 452.8, notes: null },
      { serviceType: 'Other', description: 'Brake inspection (no charge)', lineCost: 0, notes: null },
    ],
  }),
  visit({ visitId: 'jp-2', date: '2024-11-27', mileage: 68300, location: 'Prairie Jeep RAM', summary: 'Oil change, tire rotation' ,
    services: [{ serviceType: 'Oil Change', description: 'LOF 5W-20', lineCost: 89, notes: null }] }),
  visit({ visitId: 'jp-0', date: '2017-02-10', mileage: 11020, location: 'Northside Chrysler Jeep', summary: 'Oil change' }),
]);

const highlander = vehicle('2014 Toyota Highlander', 'Toyota', 'Highlander', 'Highlander', [
  visit({
    visitId: 'hl-1', date: '2025-12-02', mileage: 134120, location: 'Toyota of Somewhere', summary: 'Oil change; rear brakes',
    services: [{ serviceType: 'Brake Service', description: 'REAR BRAKE PADS, SHIM KIT', lineCost: 402.67, notes: null }],
    recommendations: [{ recId: 'r1', item: 'Wiper blades streaking', estimate: 59.98, status: 'Open', resolvedByVisit: null, notes: null }],
  }),
  visit({ visitId: 'hl-2', date: '2018-09-27', mileage: 61300, location: 'Toyota of Somewhere', summary: 'Front brake pads',
    services: [{ serviceType: 'Brake Service', description: 'FRONT BRAKE PADS', lineCost: 219.95, notes: null }] }),
  visit({ visitId: 'hl-3', date: '2020-05-19', mileage: 81400, location: 'Main St Tire & Auto', summary: 'Four new tires, alignment',
    services: [{ serviceType: 'Tires', description: 'Four tires mounted & balanced', lineCost: 800, notes: null }] }),
]);

const all = [highlander, jeep];

describe('stemming and tokens', () => {
  it('folds simple plurals', () => {
    expect(stem('brakes')).toBe('brake');
    expect(stem('filters')).toBe('filter');
    expect(stem('tires')).toBe('tire');
    expect(stem('batteries')).toBe('battery');
    expect(stem('boxes')).toBe('box');
    expect(stem('glasses')).toBe('glass');
    expect(stem('services')).toBe('service');
    expect(stem('glass')).toBe('glass');
    expect(stem('gas')).toBe('gas');
    expect(stem('4runners')).toBe('4runners');
  });

  it('ignores case, accents and punctuation', () => {
    expect(tokenize('REAR BRAKE-PADS, Café!')).toEqual(['rear', 'brake', 'pad', 'cafe']);
    expect(queryTerms('  Brakes, brakes  JEEP ')).toEqual(['brake', 'jeep']);
  });
});

describe('searchVisits', () => {
  it('empty query → nothing', () => {
    expect(searchVisits(all, '   ').groups).toEqual([]);
  });

  it('"brakes jeep" finds the Jeep rear brake service (vehicle words count)', () => {
    const r = searchVisits(all, 'brakes jeep');
    expect(r.groups.map(g => g.vehicle.name)).toEqual(['2016 Jeep Wrangler']);
    expect(r.groups[0].hits.map(h => h.visit.visitId)).toEqual(['jp-1']);
    const snip = r.groups[0].hits[0].snippet!;
    expect(snip.field).toBe('service');
    expect(snip.text).toBe('Brake Service: Rear brake pads and rotors');
    expect(snip.ranges.length).toBeGreaterThan(0);
  });

  it('ANDs words: every word must match text or vehicle', () => {
    expect(searchVisits(all, 'brake alignment').total).toBe(0);
    expect(searchVisits(all, 'front brakes highlander').groups[0].hits.map(h => h.visit.visitId)).toEqual(['hl-2']);
  });

  it('groups by vehicle in vehicle order and sorts newest first', () => {
    const r = searchVisits(all, 'brake');
    expect(r.groups.map(g => g.vehicle.shortName)).toEqual(['Highlander', 'Wrangler']);
    expect(r.groups[0].hits.map(h => h.visit.visitId)).toEqual(['hl-1', 'hl-2']);
    expect(r.total).toBe(3);
  });

  it('prefix-matches words of 3+ letters, but not shorter ones', () => {
    expect(searchVisits(all, 'rot').total).toBe(2); // rotors, rotation
    expect(searchVisits(all, 'ro').total).toBe(0);
  });

  it('searches locations, recommendation items and service types', () => {
    expect(searchVisits(all, 'prairie').groups[0].hits[0].visit.visitId).toBe('jp-2');
    const wiper = searchVisits(all, 'wipers').groups[0].hits[0];
    expect(wiper.visit.visitId).toBe('hl-1');
    expect(wiper.snippet?.field).toBe('recommendation');
    expect(searchVisits(all, 'tires highlander').groups[0].hits.map(h => h.visit.visitId)).toEqual(['hl-3']);
  });

  it('matches the visit year', () => {
    expect(searchVisits(all, 'brakes 2023').groups[0].hits.map(h => h.visit.visitId)).toEqual(['jp-1']);
  });

  it('a vehicle-only query lists every visit of that vehicle without a snippet', () => {
    const r = searchVisits(all, 'wrangler');
    expect(r.groups[0].hits.map(h => h.visit.visitId)).toEqual(['jp-2', 'jp-1', 'jp-0']);
    expect(r.groups[0].hits[0].snippet).toBeNull();
  });

  it('is punctuation-insensitive in the data too (5W-20)', () => {
    expect(searchVisits(all, '5w 20').groups[0].hits[0].visit.visitId).toBe('jp-2');
  });
});

describe('highlighting', () => {
  it('marks matched words in the original text', () => {
    const text = 'Rear brake pads and rotors';
    const ranges = matchRanges(text, queryTerms('brakes rotor'));
    expect(highlightParts(text, ranges)).toEqual([
      { text: 'Rear ', hit: false },
      { text: 'brake', hit: true },
      { text: ' pads and ', hit: false },
      { text: 'rotors', hit: true },
    ]);
  });
});
