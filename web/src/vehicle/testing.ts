/**
 * Synthetic Vehicle objects for unit tests (made-up VIN, plate and shops).
 * Only imported by *.test.ts files.
 */

import type { Vehicle, Visit } from '../api/types';

export function makeVisit(over: Partial<Visit> = {}): Visit {
  return {
    visitId: 'v-1',
    date: '2026-08-24',
    mileage: 36410,
    location: 'Sample Motors',
    roNumber: 'S100',
    summary: 'Oil change, tire rotation',
    invoiceTotal: 158.4,
    amountPaid: 163.15,
    cardSurcharge: 4.75,
    dealerNextDueDate: null,
    dealerNextDueMiles: null,
    source: 'Receipt',
    sourceTag: null,
    beforeOwnership: false,
    notes: 'Technical note for the owner only.',
    services: [
      { serviceType: 'Oil Change', description: 'ENGINE OIL CHANGE (0W-20)', lineCost: 138.4, notes: null },
      { serviceType: 'Tire Rotation', description: 'TIRE ROTATE', lineCost: null, notes: 'Included' },
    ],
    documents: [],
    recommendations: [],
    readings: [],
    ...over,
  };
}

export function makeVehicle(over: Partial<Vehicle> = {}): Vehicle {
  return {
    name: '2023 Sample Roadster',
    shortName: 'Roadster',
    year: 2023,
    make: 'Sample',
    model: 'Roadster',
    vin: 'TESTVIN0000000099',
    plate: 'SAMPLE9',
    primaryDriver: 'Pat',
    isMine: true,
    photoFileId: null,
    originalInServiceDate: '2023-01-25',
    purchaseDate: '2026-04-10',
    purchaseMileage: 28640,
    estMileage: 37704,
    avgMilesPerDay: 54.9,
    latestOdometer: 37320,
    latestOdometerDate: '2026-09-15',
    lastMileageEvidenceDate: '2026-09-15',
    basics: {
      oilSpec: '0W-20', oilCapacity: null, oilFilter: null, engineAirFilter: null, cabinAirFilter: null,
      tireSize: null, tirePressure: null, wiperFrontDriver: null, wiperFrontPassenger: null, wiperRear: null,
      batteryGroup: null,
    },
    registration: { expires: null, fileId: null, daysLeft: null },
    oemApp: null,
    upcoming: [],
    noHistory: [],
    coverage: [],
    visits: [makeVisit()],
    costs: { thisYear: 0, last12Months: 0, sincePurchase: 0, costPerMile: null, visitsWithoutTotal: 0, byYear: [], byServiceType: [] },
    wear: { tread: null, brakeFront: null, brakeRear: null },
    recalls: [],
    attention: [],
    ...over,
  };
}
