/**
 * Push notifications (spec section 9; docs/API.md "Notifications" and "Push").
 *
 * Three steps, each testable on its own:
 *   1. planNotifications_ (pure): everything that could be sent now, each
 *      with a deterministic key such as "due:<vehicle>:<serviceType>:<dueBy>".
 *   2. selectToSend_ (pure): drops keys already on Notification Log and events
 *      the person switched off, holds everything during quiet hours, and
 *      applies the daily cap (the overflow goes out as one bundle).
 *   3. deliverNotifications_: sends through the Push Worker (sendPush_),
 *      updates Push Subscriptions and writes Notification Log.
 * runNotifications_ wires the three to the Sheet for the jobs in Jobs.js.
 *
 * Planning is state-based, not transition-based: a Filed scan or a New recall
 * is a candidate on every run until its key is on Notification Log. That is
 * what makes the jobs idempotent, and why a key is only logged once a phone
 * accepted it (or the person has no phone to send to).
 *
 * The handlers the router calls for push and prefs (subscribePush_,
 * unsubscribePush_, savePrefs_, testPush_, signOutDevice_) are at the end.
 *
 * No top-level references to Config.js constants: Apps Script may load this
 * file before Config.js.
 */

/** Events the 30-minute scan job sends (the daily job sends every event). */
const SCAN_NOTIFY_EVENTS_ = ['scanFiled', 'scanNeedsAttention'];

/** Which candidates go out individually first when the daily cap bites (lower first). */
const NOTIFY_PRIORITY_ = {
  newRecall: 0, serviceOverdue: 1, scanNeedsAttention: 2, registration: 3, scanFiled: 4,
  serviceDue: 5, dealerService: 6, warrantyEnding: 7, odometerNudge: 8,
};

/**
 * A due date computed from miles (Est. Date for Miles, the dealer's miles,
 * a warranty's End Miles) moves a little whenever a new odometer reading
 * lands, which changes the date in the key. These events therefore also skip
 * a candidate when the same "family" (the key without its date) was logged
 * for that person within this many days, so "once" really means once.
 */
const NOTIFY_REPEAT_WINDOW_DAYS_ = 30;

/** Notification Log › Result values. */
const NOTIFY_RESULT_ = {
  SENT: 'Sent',
  BUNDLED: 'Bundled',
  NO_DEVICE: 'No device',
  SILENT_FIRST_IMPORT: 'Silent (first import)',
};

/** Messages per Worker request: keeps each call inside the free plan's CPU budget. */
const PUSH_BATCH_SIZE_ = 5;
const PUSH_TTL_SEC_ = 86400;

/**
 * Push-service reasons that mean OUR VAPID setup is wrong, not the
 * subscription: the row is kept (only 404/410 deactivate) and it is logged
 * with console.error so Andrew sees it in the executions list.
 */
const PUSH_CONFIG_REASONS_ = ['BadJwtToken', 'BadAuthorizationHeader', 'BadVapidPublicKey'];

/** Push services a subscription may point at (the same allowlist as the Worker). */
const PUSH_HOSTS_ = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'];
const PUSH_HOST_SUFFIXES_ = ['.push.apple.com', '.notify.windows.com'];

const TEST_PUSH_BODY_ = 'Test notification — it works!';

// ---------------------------------------------------------------- small helpers (pure)

function notifyUniq_(list) {
  const seen = {};
  return list.filter(x => {
    if (!x || seen[x]) return false;
    seen[x] = true;
    return true;
  });
}

/** Hash route for a vehicle, optionally a panel or sub-route: "#/v/2023%20BMW%20X7/odometer". */
function notifyVehicleRoute_(vehicleName, suffix) {
  return '#/v/' + encodeURIComponent(vehicleName) + (suffix ? '/' + suffix : '');
}

/** "Tire Rotation" → "Tire rotation"; acronyms stay ("CVT Fluid" → "CVT fluid"). */
function notifySentenceCase_(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
    const l = w.toLowerCase();
    return i === 0 ? l.charAt(0).toUpperCase() + l.slice(1) : l;
  }).join(' ');
}

/** Days until something → "today", "tomorrow", "in 5 days", "in 2 weeks". */
function notifyWhen_(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return 'in ' + days + ' days';
  const weeks = Math.round(days / 7);
  return 'in ' + weeks + (weeks === 1 ? ' week' : ' weeks');
}

/** "4Runner: Tire rotation due in 2 weeks": the Notification Log › Title. */
function notifyLogTitle_(n) {
  return n.title ? n.title + ': ' + n.body : n.body;
}

/** Quiet hours in Chicago (RULES.QUIET_START_HOUR to QUIET_END_HOUR): nothing is sent. */
function isQuietHours_(nowParts) {
  const h = nowParts.hour, s = RULES.QUIET_START_HOUR, e = RULES.QUIET_END_HOUR;
  return s > e ? (h >= s || h < e) : (h >= s && h < e);
}

/** Chicago day of a Notification Log › Sent At (ISO string or Date), or null. */
function notifyLogDay_(sentAt) {
  if (sentAt instanceof Date) return ymdFromDate_(sentAt);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(sentAt || ''));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- recipients (pure)

/**
 * Emails of the vehicle's primary driver: Active App Users rows whose Driver
 * Name (fallback Name) equals Vehicles › Primary Driver, ignoring case.
 */
function notifyDriverEmails_(vehicle, appUsers) {
  const driver = lower_(vehicle && vehicle.primaryDriver);
  if (!driver) return [];
  return notifyUniq_((appUsers || [])
    .filter(u => u && u.active !== false && lower_(u.driverName || u.name) === driver)
    .map(u => lower_(u.email)));
}

/** Primary driver, plus the owner when `withOwner`; each email once. */
function notifyRecipients_(vehicle, appUsers, ownerEmail, withOwner) {
  const out = notifyDriverEmails_(vehicle, appUsers);
  if (withOwner && lower_(ownerEmail)) out.push(lower_(ownerEmail));
  return notifyUniq_(out);
}

/**
 * The person who uploaded a scan. App Scans › Uploaded By holds the email; a
 * hand-entered row may hold a Name (or Driver Name) instead, which only
 * counts when exactly one Active user has it.
 */
function notifyUploaderEmail_(scan, appUsers) {
  const by = lower_(scan && scan.uploadedBy);
  if (!by) return null;
  const users = (appUsers || []).filter(u => u && u.active !== false);
  if (users.some(u => lower_(u.email) === by)) return by;
  const named = notifyUniq_(users
    .filter(u => lower_(u.name) === by || lower_(u.driverName) === by)
    .map(u => lower_(u.email)));
  return named.length === 1 ? named[0] : null;
}

/** "Robert" for "Robert's been notified", from the owner's App Users row. */
function notifyOwnerName_(state, appUsers, ownerEmail) {
  if (state.ownerName) return state.ownerName;
  const row = (appUsers || []).filter(u => lower_(u.email) === ownerEmail)[0];
  return (row && row.name) || 'the owner';
}

// ---------------------------------------------------------------- notification text (pure)

/**
 * The New-recall notification for one campaign. Shared with Recalls.js, which
 * logs these keys as "Silent (first import)" on a vehicle's first lookup.
 */
function recallNotice_(vehicleName, shortName, campaignNumber, parkIt, parkOutside) {
  let body = 'New recall may apply to the ' + shortName + '.';
  if (parkIt) body += ' Do not drive until repaired.';
  if (parkOutside) body += ' Park outside, away from buildings.';
  if (!parkIt && !parkOutside) body = body.slice(0, -1); // the spec's plain sentence
  return {
    key: 'recall:' + vehicleName + ':' + campaignNumber,
    title: shortName,
    body: body,
    urgency: parkIt ? 'high' : 'normal',
  };
}

/** "Gold Certified" → "Gold Certified warranty"; names that already say warranty/plan stay. */
function notifyPlanLabel_(plan) {
  if (/\b(warranty|plan|coverage)\b/i.test(plan.name)) return plan.name;
  return plan.name + (lower_(plan.type).indexOf('plan') !== -1 ? ' plan' : ' warranty');
}

function notifyDealerBody_(item) {
  const miles = item.dueMiles !== null && item.dueMiles !== undefined ? fmtMiles_(item.dueMiles) + ' mi' : null;
  const when = item.dueBy ? fmtMonthDay_(item.dueBy) : null;
  if (item.status === 'Overdue') {
    return 'Dealer service is overdue' + (when ? ' (was due around ' + when + ')' : miles ? ' (was due at ' + miles + ')' : '');
  }
  if (when) return 'Dealer service due around ' + when + (miles ? ' (or at ' + miles + ')' : '');
  return 'Dealer service due at ' + miles;
}

// ---------------------------------------------------------------- 1. plan (pure)

/**
 * Every notification that could go out now (spec 9.2), before the log,
 * prefs, quiet hours and cap are applied.
 *
 * @param {object} state
 *   vehicles     Logic vehicle views WITHOUT the per-user overlay (buildVehicleView_)
 *   appUsers     normalized App Users rows (inactive rows are ignored)
 *   ownerEmail   the system owner (gets recall, registration and warranty copies)
 *   ownerName?   for "Robert's been notified" (default: the owner's App Users Name)
 *   scans        normalized App Scans rows
 *   recallsRows  normalized Recalls rows
 *   today?       "YYYY-MM-DD" (default nowParts.ymd)
 *   events?      only plan these events (default: all)
 * @param {{ymd: string, hour: number}} nowParts nowParts_() output
 * @return {object[]} [{key, email, event, title, body, url, tag, vehicle, shortName,
 *   urgency, family?}] where url is a hash route and family (see
 *   NOTIFY_REPEAT_WINDOW_DAYS_) is the key without its date part
 */
function planNotifications_(state, nowParts) {
  const today = state.today || nowParts.ymd;
  const want = ev => !state.events || state.events.indexOf(ev) !== -1;
  const users = (state.appUsers || []).filter(u => u && u.email && u.active !== false);
  const owner = lower_(state.ownerEmail);
  const ownerName = notifyOwnerName_(state, users, owner);
  const vehicles = state.vehicles || [];
  const out = [];

  /** Adds one candidate per recipient. */
  const add = (c, emails) => {
    notifyUniq_(emails).forEach(email => out.push(Object.assign({ email: email, urgency: 'normal' }, c)));
  };

  vehicles.forEach(v => {
    const short = v.shortName || v.name;
    const drivers = notifyDriverEmails_(v, users);
    const driversAndOwner = notifyRecipients_(v, users, owner, true);
    const cand = (event, key, body, url, tag, extra) => Object.assign({
      key: key, event: event, title: short, body: body, url: url, tag: tag, vehicle: v.name, shortName: short,
    }, extra || {});

    (v.upcoming || []).forEach(item => {
      if (item.kind === 'schedule' && item.serviceType) {
        const what = notifySentenceCase_(item.serviceType);
        const url = notifyVehicleRoute_(v.name, 'upcoming/' + encodeURIComponent(item.id));
        const tag = 'service:' + v.name + ':' + item.serviceType;
        if (item.status === 'Overdue') {
          // Service overdue: primary driver, once.
          if (!want('serviceOverdue')) return;
          const family = 'overdue:' + v.name + ':' + item.serviceType + ':';
          add(cand('serviceOverdue', family + (item.dueBy || ''), what + ' is overdue', url, tag, { family: family }), drivers);
        } else if (item.dueBy && want('serviceDue')) {
          // Service coming due: primary driver, within NOTIFY_SERVICE_DUE_DAYS of Due By, once.
          const days = daysBetween_(today, item.dueBy);
          if (days < 0 || days > RULES.NOTIFY_SERVICE_DUE_DAYS) return;
          const miles = item.dueMiles !== null && item.dueMiles !== undefined ? ' (or at ' + fmtMiles_(item.dueMiles) + ' mi)' : '';
          const family = 'due:' + v.name + ':' + item.serviceType + ':';
          add(cand('serviceDue', family + item.dueBy, what + ' due ' + notifyWhen_(days) + miles, url, tag,
            { family: family }), drivers);
        }
      } else if (item.kind === 'dealer' && want('dealerService')) {
        // Dealer's next service: primary driver, 14 days or 500 mi before, once.
        const days = item.dueBy ? daysBetween_(today, item.dueBy) : null;
        const nearDate = days !== null && days <= RULES.NOTIFY_DEALER_DAYS;
        const nearMiles = item.dueMiles !== null && item.dueMiles !== undefined &&
          v.estMileage !== null && v.estMileage !== undefined &&
          item.dueMiles - v.estMileage <= RULES.NOTIFY_DEALER_MILES;
        if (!nearDate && !nearMiles) return;
        const family = 'dealer:' + v.name + ':';
        add(cand('dealerService', family + (item.dueBy || item.dueMiles), notifyDealerBody_(item),
          notifyVehicleRoute_(v.name, 'upcoming/' + encodeURIComponent(item.id)), 'dealer:' + v.name,
          { family: family }), drivers);
      }
    });

    // Registration: primary driver + owner at 60 and at 30 days. Only the most
    // recent threshold crossed is planned, so a late start sends one, not two.
    const reg = v.registration || {};
    if (reg.expires && reg.daysLeft !== null && reg.daysLeft !== undefined && want('registration')) {
      const threshold = RULES.NOTIFY_REGISTRATION_DAYS.slice().sort((a, b) => a - b)
        .filter(t => reg.daysLeft <= t)[0];
      if (threshold !== undefined) {
        const when = fmtMonthDay_(reg.expires);
        const body = reg.daysLeft < 0 ? 'Registration expired ' + when
          : reg.daysLeft === 0 ? 'Registration expires today' : 'Registration expires ' + when;
        add(cand('registration', 'reg:' + v.name + ':' + reg.expires + ':' + threshold, body,
          notifyVehicleRoute_(v.name, 'registration'), 'reg:' + v.name), driversAndOwner);
      }
    }

    // Warranty or plan ending: primary driver + owner, within NOTIFY_WARRANTY_DAYS, once.
    if (want('warrantyEnding')) {
      (v.coverage || []).forEach(p => {
        if (!p.active || !p.endsOn) return;
        const days = daysBetween_(today, p.endsOn);
        if (days < 0 || days > RULES.NOTIFY_WARRANTY_DAYS) return;
        const ends = days === 0 ? 'ends today' : days === 1 ? 'ends tomorrow' : 'ends in ~' + days + ' days';
        const atMiles = p.endsBy === 'miles' && p.endMiles !== null && p.endMiles !== undefined
          ? ' (at ' + fmtMiles_(p.endMiles) + ' mi)' : '';
        const family = 'warranty:' + v.name + ':' + p.name + ':';
        add(cand('warrantyEnding', family + p.endsOn, notifyPlanLabel_(p) + ' ' + ends + atMiles,
          notifyVehicleRoute_(v.name, 'coverage'), 'warranty:' + v.name + ':' + p.name, { family: family }),
        driversAndOwner);
      });
    }

    // Odometer nudge: primary driver after 60 days without mileage evidence,
    // then every 60 days (n counts the 60-day periods since the evidence).
    if (want('odometerNudge') && needsOdometerNudge_(v, today)) {
      const since = v.lastMileageEvidenceDate;
      const n = since ? Math.floor(daysBetween_(since, today) / RULES.ODOMETER_NUDGE_DAYS)
        : Math.floor(ymdToDay_(today) / RULES.ODOMETER_NUDGE_DAYS);
      add(cand('odometerNudge', 'nudge:' + v.name + ':' + (since || 'none') + ':' + n,
        "What's the odometer on the " + short + '?', notifyVehicleRoute_(v.name, 'odometer'), 'nudge:' + v.name),
      drivers);
    }
  });

  // New recalls: primary driver + owner.
  if (want('newRecall')) {
    const byName = {};
    vehicles.forEach(v => { byName[v.name] = v; });
    (state.recallsRows || []).forEach(r => {
      const v = byName[r.vehicle];
      if (!v || !r.campaignNumber || lower_(r.status) !== VALUES.RECALL_NEW) return;
      const short = v.shortName || v.name;
      const notice = recallNotice_(v.name, short, r.campaignNumber, asYesNo_(r.parkIt) === true,
        asYesNo_(r.parkOutside) === true);
      add({
        key: notice.key, event: 'newRecall', title: notice.title, body: notice.body,
        url: notifyVehicleRoute_(v.name, 'recalls'), tag: notice.key, vehicle: v.name, shortName: short,
        urgency: notice.urgency,
      }, notifyRecipients_(v, users, owner, true));
    });
  }

  // Scans: the person who scanned, for scans uploaded in the last SCAN_TRACK_DAYS.
  if (want('scanFiled') || want('scanNeedsAttention')) {
    const byName = {}, visitIndex = {};
    vehicles.forEach(v => {
      byName[v.name] = v;
      (v.visits || []).forEach(x => { visitIndex[x.visitId] = { vehicle: v, visit: x }; });
    });
    const from = addDays_(today, -RULES.SCAN_TRACK_DAYS);
    (state.scans || []).forEach(s => {
      const day = notifyLogDay_(s.uploadedAt);
      if (!s.scanId || !day || day < from) return;
      const status = scanStatus_(s.status);
      const email = notifyUploaderEmail_(s, users);
      if (!email) return;
      if (status === SCAN_STATUS.FILED && want('scanFiled')) {
        // The vehicle comes from the visit it was filed to (never the hint,
        // which is only a guess); without a known visit the text stays generic.
        const hit = s.visitId ? visitIndex[s.visitId] : null;
        const v = hit ? hit.vehicle : null;
        const short = v ? v.shortName || v.name : null;
        const where = hit && hit.visit.location ? hit.visit.location + ' ' : '';
        add({
          key: 'scanfiled:' + s.scanId, event: 'scanFiled', title: short || 'Vehicles',
          body: 'Your ' + where + 'receipt is filed' + (short ? ' on the ' + short : ''),
          url: v ? notifyVehicleRoute_(v.name, 'visit/' + encodeURIComponent(s.visitId))
            : '#/scans/' + encodeURIComponent(s.scanId),
          tag: 'scan:' + s.scanId, vehicle: v ? v.name : null, shortName: short,
        }, [email]);
      } else if (status === SCAN_STATUS.NEEDS_ATTENTION && want('scanNeedsAttention')) {
        const v = byName[s.vehicleHint] || null;
        const short = v ? v.shortName || v.name : null;
        // The owner doesn't need telling that the owner has been notified.
        const told = email === owner ? '' : ' ' + capitalize_(ownerName) + "'s been notified.";
        add({
          key: 'scanreview:' + s.scanId, event: 'scanNeedsAttention', title: short || 'Vehicles',
          body: 'A receipt you scanned needs another look.' + told,
          url: '#/scans/' + encodeURIComponent(s.scanId), tag: 'scan:' + s.scanId,
          vehicle: v ? v.name : null, shortName: short,
        }, [email]);
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------- 2. select (pure)

/**
 * What to send now.
 * - Drops a candidate whose key is already on Notification Log for that email
 *   (any Result), or whose family was logged in the last
 *   NOTIFY_REPEAT_WINDOW_DAYS_, or whose event the person switched off
 *   (missing prefs keys mean on).
 * - Quiet hours: nothing is sent (everything comes back in `held`).
 * - Daily cap: at most RULES.MAX_NOTIFICATIONS_PER_DAY per person per Chicago
 *   day, counting today's Sent and Bundled log rows. When more are waiting
 *   than the person has left, (remaining − 1) go individually and the rest as
 *   one bundle; with nothing left, everything is held until tomorrow.
 *
 * @param {object[]} candidates planNotifications_ output
 * @param {object[]} logRows normalized Notification Log rows {key, email, sentAt, result}
 * @param {Object<string, object>} prefsByEmail email → NotificationPrefs
 * @param {{ymd: string, hour: number}} nowParts
 * @return {{individual: object[], bundles: object[], held: object[]}} bundles are
 *   {email, title, body, url, tag, urgency, keys, items}
 */
function selectToSend_(candidates, logRows, prefsByEmail, nowParts) {
  const today = nowParts.ymd;
  const logged = Object.create(null);
  const recent = Object.create(null);    // email → keys logged within the repeat window
  const sentToday = Object.create(null); // email → Sent/Bundled rows today
  (logRows || []).forEach(r => {
    const key = asStr_(r.key);
    if (!key) return;
    const email = lower_(r.email);
    logged[email + '\n' + key] = true;
    const day = notifyLogDay_(r.sentAt);
    if (!day) return;
    if (daysBetween_(day, today) <= NOTIFY_REPEAT_WINDOW_DAYS_) (recent[email] = recent[email] || []).push(key);
    const result = lower_(r.result);
    if (day === today && (result === 'sent' || result === 'bundled')) sentToday[email] = (sentToday[email] || 0) + 1;
  });

  const byEmail = {}, order = [];
  (candidates || []).forEach((c, i) => {
    const email = lower_(c.email);
    if (!email || !c.key) return;
    const id = email + '\n' + c.key;
    if (logged[id]) return;
    const prefs = (prefsByEmail && prefsByEmail[email]) || {};
    if (prefs[c.event] === false) return;
    if (c.family && (recent[email] || []).some(k => k.indexOf(c.family) === 0)) return;
    logged[id] = true; // the same key twice in one plan goes once
    if (!byEmail[email]) { byEmail[email] = []; order.push(email); }
    byEmail[email].push({ c: c, i: i });
  });

  const out = { individual: [], bundles: [], held: [] };
  order.forEach(email => {
    const list = byEmail[email]
      .sort((a, b) => (priorityOf_(a.c) - priorityOf_(b.c)) || (a.i - b.i))
      .map(x => x.c);
    if (isQuietHours_(nowParts)) { out.held = out.held.concat(list); return; }
    const remaining = Math.max(0, RULES.MAX_NOTIFICATIONS_PER_DAY - (sentToday[email] || 0));
    if (list.length <= remaining) {
      out.individual = out.individual.concat(list);
    } else if (remaining === 0) {
      out.held = out.held.concat(list);
    } else {
      out.individual = out.individual.concat(list.slice(0, remaining - 1));
      out.bundles.push(notifyBundle_(email, list.slice(remaining - 1)));
    }
  });
  return out;
}

function priorityOf_(c) {
  return c.event in NOTIFY_PRIORITY_ ? NOTIFY_PRIORITY_[c.event] : 99;
}

/** "3 things coming up on the 4Runner" (one vehicle) or "3 updates about your vehicles". */
function notifyBundle_(email, items) {
  const vehicles = notifyUniq_(items.map(c => c.vehicle || '(none)'));
  const one = vehicles.length === 1 && vehicles[0] !== '(none)' ? items[0] : null;
  const n = items.length;
  return {
    email: email,
    title: one ? one.shortName || one.vehicle : 'Vehicles',
    body: one ? n + ' things coming up on the ' + (one.shortName || one.vehicle) : n + ' updates about your vehicles',
    url: one ? notifyVehicleRoute_(one.vehicle) : '',
    tag: 'bundle',
    urgency: items.some(c => c.urgency === 'high') ? 'high' : 'normal',
    keys: items.map(c => c.key),
    items: items,
  };
}

// ---------------------------------------------------------------- 3. send

/**
 * The app's public URL for notification links: Script Property APP_URL, else
 * DEFAULT_APP_URL. Always an absolute https URL ending in "/" (the Worker
 * refuses anything else, and ".../VehicleTracker#/v/X" without the slash is
 * outside the web app's scope, so iOS would open it in Safari). A malformed
 * APP_URL is logged and the default is used instead.
 */
function notifyAppUrl_() {
  const raw = String(prop_(PROP.APP_URL, false) || '').trim();
  const clean = u => {
    const m = /^(https:\/\/[A-Za-z0-9.-]+(?::\d+)?)(\/[^\s?#]*)?(?:[?#].*)?$/.exec(u);
    if (!m) return null;
    const path = m[2] || '/';
    return m[1] + (path.slice(-1) === '/' ? path : path + '/');
  };
  const url = raw ? clean(raw) : null;
  if (raw && !url) console.error('Script Property APP_URL is not an absolute https URL; using ' + DEFAULT_APP_URL + '.');
  return url || clean(DEFAULT_APP_URL);
}

/** One Worker message (push-worker/README.md). `route` is a hash route; the Worker gets an absolute URL. */
function pushMessage_(id, sub, notice, appUrl) {
  return {
    id: id,
    subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    payload: { title: notice.title, body: notice.body, url: appUrl + (notice.url || ''), tag: notice.tag || 'vehicles' },
    ttl: PUSH_TTL_SEC_,
    urgency: notice.urgency === 'high' ? 'high' : 'normal',
  };
}

/**
 * The push service's reason for a failed message: the Worker's parsed
 * `reason` field, else {"reason":"BadJwtToken"} found in its raw `error`
 * text (an older Worker), else ''.
 */
function pushReason_(r) {
  if (r.reason) return String(r.reason);
  const m = /"reason"\s*:\s*"([^"]+)"/.exec(String(r.error || ''));
  return m ? m[1] : '';
}

/**
 * POSTs messages to the Push Worker's /send in batches of PUSH_BATCH_SIZE_.
 * Never throws for a delivery problem: returns one result per message, in
 * order, {id, status, ok, gone, error, reason}. A batch the Worker refused
 * as a whole (401, 500, network) gives every message in it ok = false.
 * Throws only when PUSH_WORKER_URL or PUSH_WORKER_SECRET isn't set.
 */
function sendPush_(messages) {
  const base = String(prop_(PROP.PUSH_WORKER_URL, true)).replace(/\/+$/, '').replace(/\/send$/, '');
  const secret = prop_(PROP.PUSH_WORKER_SECRET, true);
  const results = [];
  for (let i = 0; i < messages.length; i += PUSH_BATCH_SIZE_) {
    const batch = messages.slice(i, i + PUSH_BATCH_SIZE_);
    let got = null, failure = null;
    try {
      const res = UrlFetchApp.fetch(base + '/send', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + secret },
        payload: JSON.stringify({ messages: batch }),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      let body = null;
      try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
      if (code === 200 && body && Array.isArray(body.results)) {
        got = body.results;
      } else {
        failure = { status: code, error: 'worker_' + ((body && body.error) || 'http_' + code) };
        // 401 = wrong PUSH_WORKER_SECRET; 500 not_configured = the Worker's secrets or VAPID keys.
        console.error('Push Worker refused the request: HTTP ' + code + ' ' + ((body && (body.error + ' ' + (body.detail || ''))) || ''));
      }
    } catch (e) {
      failure = { status: 0, error: 'network: ' + (e && e.message || e) };
      console.warn('Push Worker unreachable: ' + (e && e.message || e));
    }
    batch.forEach((m, j) => {
      const r = got ? (got.filter(x => x && x.id === m.id)[0] || got[j]) : null;
      if (!r) {
        results.push({ id: m.id, status: failure ? failure.status : 0, ok: false, gone: false,
          error: failure ? failure.error : 'no_result', reason: '' });
        return;
      }
      const status = +r.status || 0;
      results.push({
        id: m.id, status: status, ok: r.ok === true, gone: r.gone === true || status === 404 || status === 410,
        error: r.error || null, reason: pushReason_(r),
      });
    });
  }
  return results;
}

/**
 * ok | gone | config | failed, per docs/API.md "Worker results". Only a
 * 404/410 ("gone") ever deactivates a subscription; a VAPID configuration
 * reason is matched exactly, whatever the status code.
 */
function pushResultKind_(r) {
  if (r.ok) return 'ok';
  if (r.gone) return 'gone';
  if (PUSH_CONFIG_REASONS_.indexOf(String(r.reason || '')) !== -1) return 'config';
  return 'failed';
}

/**
 * Applies Worker results to Push Subscriptions: success → Last Success now;
 * 404/410 → Active = No; a VAPID configuration error keeps the row and is
 * logged. `subs[j]` is the subscription row results[j] was sent to.
 * @return {{ok: number, gone: number, config: number, failed: number}}
 */
function applyPushResults_(results, subs, now) {
  const counts = { ok: 0, gone: 0, config: 0, failed: 0 };
  const touched = {};
  results.forEach((r, j) => {
    const sub = subs[j];
    const kind = pushResultKind_(r);
    counts[kind]++;
    if (!sub) return;
    if (kind === 'ok') {
      if (touched[sub._row]) return;
      touched[sub._row] = true;
      updateAppRow_(TAB.PUSH_SUBSCRIPTIONS, sub._row, { 'Last Success': now });
    } else if (kind === 'gone') {
      if (sub.active === false) return;
      sub.active = false;
      updateAppRow_(TAB.PUSH_SUBSCRIPTIONS, sub._row, { 'Active': 'No' });
    } else if (kind === 'config') {
      console.error('Push configuration error (' + r.reason + '): check the Worker\'s VAPID keys and ' +
        'VAPID_SUBJECT (push-worker/README.md). The subscription is kept.');
    } else {
      console.warn('Push failed (status ' + r.status + ', ' + (r.error || 'no detail') + ') for a device of ' + sub.email);
    }
  });
  return counts;
}

/** Active Push Subscriptions rows with usable keys, grouped by email. */
function subscriptionsByEmail_(subscriptions) {
  const out = {};
  (subscriptions || []).forEach(s => {
    if (!s || !s.active || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return;
    const e = lower_(s.email);
    (out[e] = out[e] || []).push(s);
  });
  return out;
}

/**
 * Sends a selectToSend_ result and writes Notification Log.
 * - A notification counts as sent when at least one of the person's devices
 *   accepted it: its key is logged Sent (a bundle logs each key Bundled).
 * - Every device failed: nothing is logged, so the next run retries.
 * - The person has no active device: each key is logged "No device", so it
 *   isn't retried forever (and a phone added later doesn't get stale news).
 * @return {{sent, bundled, noDevice, failed, devices: {ok, gone, config, failed}}}
 */
function deliverNotifications_(selection, subscriptions, now) {
  const stats = { sent: 0, bundled: 0, noDevice: 0, failed: 0, devices: { ok: 0, gone: 0, config: 0, failed: 0 } };
  const subsByEmail = subscriptionsByEmail_(subscriptions);
  const notices = selection.individual.map(c => ({
    email: c.email, title: c.title, body: c.body, url: c.url, tag: c.tag, urgency: c.urgency,
    log: [{ key: c.key, title: notifyLogTitle_(c), result: NOTIFY_RESULT_.SENT }],
  })).concat(selection.bundles.map(b => ({
    email: b.email, title: b.title, body: b.body, url: b.url, tag: b.tag, urgency: b.urgency,
    log: b.items.map(c => ({ key: c.key, title: notifyLogTitle_(c), result: NOTIFY_RESULT_.BUNDLED })),
  })));
  if (!notices.length) return stats;

  const appUrl = notifyAppUrl_();
  const messages = [], targets = [];
  notices.forEach((n, i) => {
    n.subs = subsByEmail[lower_(n.email)] || [];
    n.subs.forEach(s => {
      messages.push(pushMessage_('n' + i + '-r' + s._row, s, n, appUrl));
      targets.push({ notice: n, sub: s });
    });
  });
  const results = messages.length ? sendPush_(messages) : [];
  stats.devices = applyPushResults_(results, targets.map(t => t.sub), now);
  results.forEach((r, j) => { if (r.ok) targets[j].notice.delivered = true; });

  notices.forEach(n => {
    let result = null;
    if (!n.subs.length) result = NOTIFY_RESULT_.NO_DEVICE;
    else if (!n.delivered) {
      console.warn('Not delivered to any device of ' + n.email + ' (will retry): ' + n.log.map(l => l.key).join(', '));
      stats.failed++;
      return;
    }
    n.log.forEach(l => {
      const r = result || l.result;
      appendAppRow_(TAB.NOTIFICATION_LOG, { 'Key': l.key, 'Email': n.email, 'Title': l.title, 'Sent At': now, 'Result': r });
      if (r === NOTIFY_RESULT_.SENT) stats.sent++;
      else if (r === NOTIFY_RESULT_.BUNDLED) stats.bundled++;
      else stats.noDevice++;
    });
  });
  return stats;
}

// ---------------------------------------------------------------- orchestration (jobs)

/** A cheap vehicle view with only what the scan notifications read. */
function scanNotifyVehicle_(v, D) {
  return {
    name: v.name,
    shortName: shortName_(v),
    primaryDriver: v.primaryDriver,
    visits: rowsFor_(D.visits, v.name).map(x => ({ visitId: x.visitId, location: x.location })),
  };
}

function readPushSubscriptions_() {
  return normPushSubscriptions_(readTab_(TAB.PUSH_SUBSCRIPTIONS, false));
}

/**
 * Plans, selects and sends. Used by jobDaily (every event) and jobScanStatus
 * (opts.events = SCAN_NOTIFY_EVENTS_). Returns a summary for the job log.
 * @param {{now?: Date, events?: string[], ownerEmail?: string}} [opts]
 */
function runNotifications_(opts) {
  opts = opts || {};
  const now = opts.now || new Date();
  const p = nowParts_(now);
  const summary = { planned: 0, individual: 0, bundles: 0, held: 0, quiet: false };
  // Quiet hours: nothing is sent and nothing is logged, so skip the reads too.
  if (isQuietHours_(p)) {
    summary.quiet = true;
    return summary;
  }
  const events = opts.events || null;
  const scanOnly = !!events && events.every(e => SCAN_NOTIFY_EVENTS_.indexOf(e) !== -1);
  const D = scanOnly
    ? dataFromTabs_(readTabs_([TAB.VEHICLES, TAB.VISITS, TAB.APP_SCANS, TAB.APP_USERS]))
    : loadData_();
  const ownerEmail = opts.ownerEmail !== undefined ? lower_(opts.ownerEmail) : ownerEmail_();
  const appUsers = D.appUsers.filter(u => u.active);
  const state = {
    vehicles: activeVehicles_(D.vehicles).map(v => (scanOnly ? scanNotifyVehicle_(v, D) : buildVehicleView_(v, D, p.ymd))),
    appUsers: appUsers,
    ownerEmail: ownerEmail,
    ownerName: ownerName_(D, ownerEmail),
    scans: D.appScans,
    recallsRows: D.recalls,
    today: p.ymd,
    events: events,
  };
  const candidates = planNotifications_(state, p);
  summary.planned = candidates.length;
  if (!candidates.length) return summary;

  const extra = readTabs_([TAB.NOTIFICATION_LOG, TAB.PUSH_SUBSCRIPTIONS]);
  const logRows = normNotificationLog_(extra[TAB.NOTIFICATION_LOG]);
  const subscriptions = normPushSubscriptions_(extra[TAB.PUSH_SUBSCRIPTIONS]);
  const prefsByEmail = {};
  appUsers.forEach(u => { prefsByEmail[u.email] = u.prefs || {}; });

  const selection = selectToSend_(candidates, logRows, prefsByEmail, p);
  summary.individual = selection.individual.length;
  summary.bundles = selection.bundles.length;
  summary.held = selection.held.length;
  if (selection.individual.length || selection.bundles.length) {
    Object.assign(summary, deliverNotifications_(selection, subscriptions, now));
  }
  return summary;
}

// ---------------------------------------------------------------- router handlers (session required)

/** True for an https endpoint on a known push service (no port, no credentials). */
function isPushEndpoint_(endpoint) {
  const s = String(endpoint || '');
  if (s.length > 2048) return false;
  const m = /^https:\/\/([A-Za-z0-9.-]+)(\/[^\s]*)?$/.exec(s);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return PUSH_HOSTS_.indexOf(host) !== -1 ||
    PUSH_HOST_SUFFIXES_.some(sfx => host.length > sfx.length && host.slice(-sfx.length) === sfx);
}

function isBase64Url_(s, minLen, maxLen) {
  return typeof s === 'string' && s.length >= minLen && s.length <= maxLen && /^[A-Za-z0-9_-]+={0,2}$/.test(s);
}

/** Device label for the Sheet: short, single line, and never read as a formula. */
function cleanDeviceLabel_(label) {
  const s = String(label || '').replace(/[\r\n\t]+/g, ' ').trim().replace(/^[=+\-@]+/, '').slice(0, 60).trim();
  return s || 'Device';
}

/**
 * subscribePush {subscription, deviceLabel} → {done: true}. Upserts the Push
 * Subscriptions row matched on Endpoint: Email = the caller, Keys as JSON,
 * Active = Yes. Holds the script lock so two launches can't add the same
 * endpoint twice.
 */
function subscribePush_(ctx, params) {
  const email = lower_(ctx && ctx.email);
  const sub = params && params.subscription;
  const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  if (!isPushEndpoint_(endpoint)) {
    throw apiError_(400, 'bad_request', "This device's notification service isn't supported.", { field: 'subscription' });
  }
  const keys = (sub && sub.keys) || {};
  if (!isBase64Url_(keys.p256dh, 40, 200) || !isBase64Url_(keys.auth, 8, 100)) {
    throw apiError_(400, 'bad_request', 'The notification subscription is missing its keys.', { field: 'subscription' });
  }
  const keysJson = JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth });
  const label = cleanDeviceLabel_(params.deviceLabel);
  return withLock_(() => {
    const rows = readPushSubscriptions_().filter(r => r.endpoint === endpoint);
    if (!rows.length) {
      appendAppRow_(TAB.PUSH_SUBSCRIPTIONS, {
        'Email': email, 'Endpoint': endpoint, 'Keys': keysJson, 'Device Label': label,
        'Created At': new Date(), 'Active': 'Yes',
      });
      return { done: true };
    }
    rows.forEach((r, i) => {
      if (i > 0) {
        // A duplicate endpoint would get every notification twice.
        if (r.active) updateAppRow_(TAB.PUSH_SUBSCRIPTIONS, r._row, { 'Active': 'No' });
        return;
      }
      const update = {};
      if (r.email !== email) {
        // The device changed hands: it is a new subscription for this person.
        update['Email'] = email;
        update['Created At'] = new Date();
      }
      if (!r.keys || r.keys.p256dh !== keys.p256dh || r.keys.auth !== keys.auth) update['Keys'] = keysJson;
      if (r.deviceLabel !== label) update['Device Label'] = label;
      if (!r.active) update['Active'] = 'Yes';
      if (Object.keys(update).length) updateAppRow_(TAB.PUSH_SUBSCRIPTIONS, r._row, update);
    });
    return { done: true };
  });
}

/** Sets Active = No on the caller's rows for `endpoint`. Someone else's endpoint is left alone. */
function deactivateEndpoint_(email, endpoint) {
  const e = lower_(email);
  const target = String(endpoint || '').trim();
  if (!e || !target) return 0;
  let n = 0;
  readPushSubscriptions_().forEach(r => {
    if (r.endpoint !== target || r.email !== e || !r.active) return;
    updateAppRow_(TAB.PUSH_SUBSCRIPTIONS, r._row, { 'Active': 'No' });
    n++;
  });
  return n;
}

/** unsubscribePush {endpoint} → {done: true}. The answer is the same whether or not a row matched. */
function unsubscribePush_(ctx, params) {
  deactivateEndpoint_(ctx && ctx.email, params && params.endpoint);
  return { done: true };
}

/** signOut {endpoint?} → {done: true}. The session token simply stops being used. */
function signOutDevice_(ctx, params) {
  if (params && params.endpoint) deactivateEndpoint_(ctx && ctx.email, params.endpoint);
  return { done: true };
}

/**
 * savePrefs {prefs} → {prefs}. Every key must be a NotificationEvent and
 * every value a boolean. Writes the JSON to the caller's App Users ›
 * Notification Prefs (the whole object replaces the old one).
 */
function savePrefs_(ctx, params) {
  const prefs = params && params.prefs;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    throw apiError_(400, 'bad_request', 'The request prefs must be an object.', { field: 'prefs' });
  }
  Object.keys(prefs).forEach(k => {
    if (NOTIFY_EVENTS.indexOf(k) === -1) {
      throw apiError_(400, 'bad_request', 'Unknown notification type: ' + k + '.', { field: 'prefs' });
    }
    if (typeof prefs[k] !== 'boolean') {
      throw apiError_(400, 'bad_request', 'Notification settings must be true or false.', { field: 'prefs' });
    }
  });
  const clean = {};
  NOTIFY_EVENTS.forEach(k => { if (k in prefs) clean[k] = prefs[k]; });
  // Look the row up fresh: ctx.appUser's row number could be stale if App Users was edited.
  const row = findAppUser_(normAppUsers_(readTab_(TAB.APP_USERS, false)), ctx && ctx.email);
  if (!row) throw apiError_(403, 'not_family', notFamilyMessage_());
  updateAppRow_(TAB.APP_USERS, row._row, { 'Notification Prefs': JSON.stringify(clean) });
  invalidateBootstrapCache_();
  return { prefs: clean };
}

/**
 * testPush → {sent, failed}: "Test notification" to every active device of
 * the caller, ignoring quiet hours and the daily cap. Nothing is logged on
 * Notification Log; Push Subscriptions is updated as for any send.
 */
function testPush_(ctx) {
  const email = lower_(ctx && ctx.email);
  const subs = subscriptionsByEmail_(readPushSubscriptions_())[email] || [];
  if (!subs.length) return { sent: 0, failed: 0 };
  const appUrl = notifyAppUrl_();
  const notice = { title: 'Vehicles', body: TEST_PUSH_BODY_, url: '', tag: 'test', urgency: 'normal' };
  const results = sendPush_(subs.map((s, i) => pushMessage_('test-' + i, s, notice, appUrl)));
  const counts = applyPushResults_(results, subs, new Date());
  return { sent: counts.ok, failed: results.length - counts.ok };
}
