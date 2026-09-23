/**
 * addOdometer: one reading onto the app-owned Odometer Readings tab
 * (docs/API.md "addOdometer", spec 8.4). The Vehicles › Latest Odometer
 * formula picks it up, which moves Avg Miles/Day and Est. Current Mileage.
 *
 * Steps, in the documented order:
 *   1. vehicle is active; mileage is a whole number 1..999,999
 *   2. date defaults to today (Chicago) and can't be in the future
 *   3. clientId already a Reading ID → return that row (offline retry)
 *   4. mileage below the latest reading → 409 below_latest {mileage, date}
 *   5. more than 5,000 above Est. Current Mileage without confirmHigh
 *      → 409 confirm_high {estimate}
 *   6. append (Date at noon, Entered At now), refresh the bootstrap cache
 */

const ODOMETER_MAX_MILES_ = 999999;

/**
 * addOdometer {vehicle, mileage, date?, note?, clientId, confirmHigh?}
 *   → {reading, latestOdometer, latestOdometerDate}
 */
function addOdometer_(ctx, params, now) {
  const today = nowParts_(now).ymd;

  // 1. Vehicle and mileage.
  const vehicles = normVehicles_(readTab_(TAB.VEHICLES, true));
  const v = activeVehicles_(vehicles).filter(x => x.name === params.vehicle)[0];
  if (!v) throw apiError_(400, 'bad_request', "Pick one of the family's vehicles.");
  const mileage = params.mileage;
  if (typeof mileage !== 'number' || Math.floor(mileage) !== mileage || mileage < 1 || mileage > ODOMETER_MAX_MILES_) {
    throw apiError_(400, 'bad_request', 'Enter the odometer as a whole number of miles.');
  }

  // 2. Date.
  const date = params.date === undefined || params.date === null || params.date === '' ? today : String(params.date);
  if (ymdToDay_(date) === null || dayToYmd_(ymdToDay_(date)) !== date) {
    throw apiError_(400, 'bad_request', "That date isn't valid.");
  }
  if (date > today) throw apiError_(400, 'bad_request', "The date can't be in the future.");

  const clientId = String(params.clientId || '').trim();
  if (!clientId) throw apiError_(400, 'bad_request', 'The reading has no ID.');
  const note = params.note ? String(params.note).trim().slice(0, 500) : '';

  // 3. Offline retry: this reading is already on the tab.
  const readings = normOdometer_(readTab_(TAB.ODOMETER_READINGS, false));
  const again = readings.filter(r => r.readingId === clientId)[0];
  if (again) return odometerResult_(again, v, readings);

  // 4. Never lower than the latest recorded reading.
  const latest = latestReading_(v, readings);
  if (latest.mileage !== null && mileage < latest.mileage) {
    throw apiError_(409, 'below_latest',
      "That's lower than the last reading: " + fmtMiles_(latest.mileage) + ' mi' +
      (latest.date ? ' on ' + fmtDate_(latest.date) : '') + '.',
      { mileage: latest.mileage, date: latest.date });
  }

  // 5. Much higher than expected: ask first.
  if (v.estMileage !== null && mileage > v.estMileage + RULES.ODOMETER_CONFIRM_ABOVE_EST && params.confirmHigh !== true) {
    throw apiError_(409, 'confirm_high',
      "That's more than " + fmtMiles_(RULES.ODOMETER_CONFIRM_ABOVE_EST) + ' miles above the estimate (about ' +
      fmtMiles_(v.estMileage) + ' mi). Are you sure?',
      { estimate: v.estMileage });
  }

  // 6. Append, once (a concurrent retry may have landed while we checked).
  const row = withLock_(() => {
    const fresh = normOdometer_(readTab_(TAB.ODOMETER_READINGS, false));
    const dup = fresh.filter(r => r.readingId === clientId)[0];
    if (dup) return { row: dup, readings: fresh };
    const obj = {
      'Reading ID': clientId,
      'Vehicle': v.name,
      'Date': noonDate_(date),
      'Mileage': mileage,
      'Entered By': (ctx.appUser && ctx.appUser.name) || ctx.email,
      'Entered At': now || new Date(),
      'Note': note,
    };
    const r = appendAppRow_(TAB.ODOMETER_READINGS, obj);
    const added = normOdometerRow_(Object.assign({ _row: r }, obj));
    return { row: added, readings: fresh.concat([added]) };
  });
  invalidateBootstrapCache_();
  return odometerResult_(row.row, v, row.readings);
}

/**
 * The vehicle's latest reading: the higher of Vehicles › Latest Odometer
 * (Last Known Mileage before setupSchemaApply) and the highest Odometer
 * Readings mileage for it. On a tie, the later date.
 * @return {{mileage: number|null, date: string|null}}
 */
function latestReading_(v, readings) {
  let best = latestOdometerOf_(v);
  best = { mileage: best.mileage === undefined ? null : best.mileage, date: best.date || null };
  rowsFor_(readings, v.name).forEach(r => {
    if (r.mileage === null) return;
    if (best.mileage === null || r.mileage > best.mileage ||
      (r.mileage === best.mileage && r.date && (!best.date || r.date > best.date))) {
      best = { mileage: r.mileage, date: r.date };
    }
  });
  return best;
}

/** OdometerResult for a stored reading, with the server's latest after it. */
function odometerResult_(row, v, readings) {
  const latest = latestReading_(v, readings);
  return {
    reading: {
      readingId: row.readingId,
      vehicle: row.vehicle,
      date: row.date,
      mileage: row.mileage,
      enteredBy: row.enteredBy,
      enteredAt: row.enteredAt,
      note: row.note,
    },
    latestOdometer: latest.mileage,
    latestOdometerDate: latest.date,
  };
}
