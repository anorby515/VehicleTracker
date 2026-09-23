import { describe, expect, it } from 'vitest';
import type { CoveragePlan, DocumentRef, Recall, WearItem } from '../api/types';
import {
  attentionEntries, costPerMileText, coverageEndText, coversText, dueText, formatMonthYear, formatWearValue, intervalText, makeInitial,
  recommendationStatusText, registrationDaysText, replacementPointText, sortDocuments, visitsWithoutTotalText, wearProjectionText,
} from './display';
import { makeVehicle } from './testing';

const tread: WearItem = {
  label: 'Tire tread',
  unit: '/32 in',
  replacementPoint: 4,
  latest: { value: 6, date: '2026-08-24', mileage: 36410, rating: 'Good', visitId: 'v2' },
  readings: [
    { value: 8, date: '2025-08-01', mileage: 26000, visitId: 'v1' },
    { value: 6, date: '2026-08-24', mileage: 36410, visitId: 'v2' },
  ],
  projection: { mileage: 51880, date: '2028-03-14' },
  note: null,
};

describe('wear display', () => {
  it('formats readings with their units', () => {
    expect(formatWearValue(5, '/32 in')).toBe('5/32 in');
    expect(formatWearValue(4, 'mm')).toBe('4 mm');
    expect(formatWearValue(6.25, 'mm')).toBe('6.3 mm');
    expect(formatWearValue(null, 'mm')).toBe('—');
    expect(replacementPointText(tread)).toBe('Replace at 4/32 in');
  });

  it('describes the projection in rounded miles and a month', () => {
    expect(wearProjectionText(tread, 37704)).toBe('Replace around 52,000 mi (about Mar 2028)');
    expect(wearProjectionText({ ...tread, projection: { mileage: 51880, date: null } }, 37704)).toBe('Replace around 52,000 mi');
  });

  it('says so when the projection has already been reached', () => {
    expect(wearProjectionText({ ...tread, projection: { mileage: 37000, date: '2026-01-01' } }, 37704))
      .toBe('Probably at the replacement point now (projected 37,000 mi)');
    expect(wearProjectionText({ ...tread, latest: { ...tread.latest, value: 3 } }, 37704)).toBe('At or past the replacement point');
  });

  it('falls back to the API note', () => {
    expect(wearProjectionText({ ...tread, projection: null, note: 'One reading so far' }, 37704)).toBe('One reading so far');
  });

  it('formats month and year', () => {
    expect(formatMonthYear('2028-03-14')).toBe('Mar 2028');
    expect(formatMonthYear(null)).toBe('—');
  });
});

describe('cost display', () => {
  it('counts visits without a total', () => {
    expect(visitsWithoutTotalText(0)).toBeNull();
    expect(visitsWithoutTotalText(1)).toBe('1 visit has no total recorded');
    expect(visitsWithoutTotalText(4)).toBe('4 visits have no total recorded');
  });

  it('shows cost per mile in cents', () => {
    expect(costPerMileText(0.1234)).toBe('$0.12 a mile');
    expect(costPerMileText(null)).toBe('Not enough mileage yet');
  });
});

describe('upcoming and schedule display', () => {
  it('describes an interval in months and miles', () => {
    expect(intervalText(6, 5000)).toBe('Every 6 months or 5,000 mi');
    expect(intervalText(12, null)).toBe('Every 12 months');
    expect(intervalText(null, 30000)).toBe('Every 30,000 mi');
    expect(intervalText(null, null)).toBeNull();
  });

  it('writes the due line from the Sheet values', () => {
    expect(dueText({ dueBy: '2026-12-25', dueMiles: 40000 })).toBe('Due by Dec 25, 2026 · at 40,000 mi');
    expect(dueText({ dueBy: null, dueMiles: 40000 })).toBe('at 40,000 mi');
    expect(dueText({ dueBy: null, dueMiles: null })).toBeNull();
  });

  it('labels recommendation statuses plainly', () => {
    expect(recommendationStatusText('Open')).toBe('Declined');
    expect(recommendationStatusText('Watch')).toBe('Keep an eye on');
  });

  it('counts registration days', () => {
    expect(registrationDaysText({ daysLeft: 190 })).toBe('190 days left');
    expect(registrationDaysText({ daysLeft: 0 })).toBe('Expires today');
    expect(registrationDaysText({ daysLeft: -22 })).toBe('Expired 22 days ago');
    expect(registrationDaysText({ daysLeft: null })).toBeNull();
  });

  it('uses the make for the photo placeholder', () => {
    expect(makeInitial({ make: 'Toyota', name: '2023 Toyota 4Runner' })).toBe('T');
    expect(makeInitial({ make: null, name: '2016 Jeep Wrangler' })).toBe('J');
  });
});

describe('coverage display', () => {
  const plan: CoveragePlan = {
    name: 'Gold Certified', type: 'Warranty', startDate: '2026-04-10', endDate: '2027-04-10', startMiles: null,
    endMiles: 45000, endMilesDate: '2027-01-30', endsOn: '2027-01-30', endsBy: 'miles', covers: ['All'], active: true, notes: null,
  };

  it('says which limit ends a plan first', () => {
    expect(coverageEndText(plan)).toBe('Ends at 45,000 mi (about Jan 30, 2027)');
    expect(coverageEndText({ ...plan, endsBy: 'date', endsOn: '2027-04-10' })).toBe('Ends Apr 10, 2027');
    expect(coverageEndText({ ...plan, endsBy: 'date', active: false })).toBe('Ended Apr 10, 2027');
  });

  it('lists what a plan covers', () => {
    expect(coversText(plan)).toBe('Covers everything');
    expect(coversText({ covers: ['Oil Change', 'Tire Rotation'] })).toBe('Covers Oil Change, Tire Rotation');
    expect(coversText({ covers: [] })).toBeNull();
  });
});

describe('documents', () => {
  const doc = (fileId: string, kind: DocumentRef['kind']): DocumentRef =>
    ({ documentType: 'Invoice', fileName: `${fileId}.${kind}`, fileId, pages: 1, complete: true, notes: null, kind });

  it('puts PDFs first, then images, keeping the tab order within each', () => {
    const out = sortDocuments([doc('p1', 'image'), doc('x', 'other'), doc('merged', 'pdf'), doc('p2', 'image'), doc('pay', 'pdf')]);
    expect(out.map(d => d.fileId)).toEqual(['merged', 'pay', 'p1', 'p2', 'x']);
  });

  it('does not change the input', () => {
    const input = [doc('a', 'image'), doc('b', 'pdf')];
    sortDocuments(input);
    expect(input.map(d => d.fileId)).toEqual(['a', 'b']);
  });
});

describe('attention banner', () => {
  const recall = (over: Partial<Recall>): Recall => ({
    campaignNumber: '00V000000', reportDate: '2026-09-01', component: 'AIR BAGS', summary: null, consequence: null,
    remedy: null, status: 'New', firstSeen: null, notes: null, parkIt: false, parkOutside: false, ...over,
  });
  const recallsHref = '#/v/x/recalls';

  it('passes the API rows through when there is nothing urgent', () => {
    const v = makeVehicle({ attention: [{ kind: 'odometer', text: 'What’s the odometer?', href: '#/o' }] });
    expect(attentionEntries(v, recallsHref)).toEqual([{ kind: 'odometer', text: 'What’s the odometer?', href: '#/o', tone: 'normal', strong: null }]);
  });

  it('marks a new "park it" recall with "Do not drive until repaired" and puts it first', () => {
    const v = makeVehicle({
      recalls: [recall({ parkIt: true })],
      attention: [
        { kind: 'registration', text: 'Registration expires Oct 15', href: '#/r' },
        { kind: 'recall', text: 'New recall may apply', href: recallsHref },
      ],
    });
    const out = attentionEntries(v, recallsHref);
    expect(out[0]).toMatchObject({ kind: 'recall', tone: 'danger', strong: 'Do not drive until repaired' });
    expect(out[1]).toMatchObject({ kind: 'registration', tone: 'normal', strong: null });
  });

  it('adds the warning for everyone, even without a recall row for this person', () => {
    const v = makeVehicle({ recalls: [recall({ parkIt: true })], attention: [] });
    const out = attentionEntries(v, recallsHref);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'recall', href: recallsHref, tone: 'danger', strong: 'Do not drive until repaired' });
    expect(out[0].text).toContain(v.shortName);
  });

  it('ignores "park it" on recalls that are no longer New', () => {
    const v = makeVehicle({ recalls: [recall({ parkIt: true, status: 'Done' })], attention: [] });
    expect(attentionEntries(v, recallsHref)).toEqual([]);
  });

  it('says "Park outside" for a fire-risk recall', () => {
    const v = makeVehicle({ recalls: [recall({ parkOutside: true })], attention: [{ kind: 'recall', text: 'New recall', href: recallsHref }] });
    expect(attentionEntries(v, recallsHref)[0]).toMatchObject({ tone: 'warn', strong: 'Park outside, away from buildings' });
  });
});
