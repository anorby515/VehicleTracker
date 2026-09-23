/**
 * Vehicle Basics (spec 8.2): what you need at a service counter or parts
 * store. VIN has a copy button; every value copies on a long press (or
 * right-click). Blank values read "Not set".
 */

import type { JSX } from 'preact';
import type { Vehicle } from '../../api/types';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { ValueRow, copyWithToast, ownerName } from '../common';
import { valueText } from '../display';

export function BasicsSheet(props: { vehicle: Vehicle; onClose: () => void }): JSX.Element {
  const v = props.vehicle;
  const b = v.basics;
  const vin = valueText(v.vin);
  return (
    <Sheet title="Vehicle Basics" onClose={props.onClose} class="basics-sheet">
      <div class="vsheet-hero">
        <h3 class="title2">{v.name}</h3>
      </div>

      <section class="section" aria-labelledby="basics-id">
        <div class="section-header"><h3 id="basics-id">Vehicle</h3></div>
        <div class="group">
          <ValueRow
            label="VIN"
            value={vin}
            copy
            action={vin && (
              <button type="button" class="icon-btn" aria-label="Copy VIN" onClick={() => copyWithToast(vin)}>
                <Icon name="copy" size={20} />
              </button>
            )}
          />
          <ValueRow label="Plate" value={valueText(v.plate)} copy />
          <ValueRow label="Battery group" value={valueText(b.batteryGroup)} copy />
        </div>
      </section>

      <section class="section" aria-labelledby="basics-oil">
        <div class="section-header"><h3 id="basics-oil">Oil and filters</h3></div>
        <div class="group">
          <ValueRow label="Oil" value={valueText(b.oilSpec)} copy />
          <ValueRow label="Oil capacity" value={valueText(b.oilCapacity)} copy />
          <ValueRow label="Oil filter" value={valueText(b.oilFilter)} copy />
          <ValueRow label="Engine air filter" value={valueText(b.engineAirFilter)} copy />
          <ValueRow label="Cabin air filter" value={valueText(b.cabinAirFilter)} copy />
        </div>
      </section>

      <section class="section" aria-labelledby="basics-tires">
        <div class="section-header"><h3 id="basics-tires">Tires and wipers</h3></div>
        <div class="group">
          <ValueRow label="Tire size" value={valueText(b.tireSize)} copy />
          <ValueRow label="Tire pressure" value={pressureText(b.tirePressure)} copy />
          <ValueRow label="Wiper, front driver" value={valueText(b.wiperFrontDriver)} copy />
          <ValueRow label="Wiper, front passenger" value={valueText(b.wiperFrontPassenger)} copy />
          <ValueRow label="Wiper, rear" value={valueText(b.wiperRear)} copy />
        </div>
        <p class="section-footer">
          Touch and hold any value to copy it. {ownerName()} keeps these in the Sheet; check the owner’s manual before buying parts.
        </p>
      </section>
    </Sheet>
  );
}

/** A bare number from the Sheet ("32") reads better with its unit. */
function pressureText(v: unknown): string | null {
  const s = valueText(v);
  return s && /^\d+(\.\d+)?$/.test(s) ? `${s} psi` : s;
}
