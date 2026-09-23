/**
 * Time-driven jobs (docs/API.md "Jobs"). installTriggers() (Setup.js) points
 * the project's triggers at these two entry points:
 *
 *   jobScanStatus  every 30 minutes   check scans that aren't final, then send
 *                                     scan notifications (quiet hours and cap apply)
 *   jobDaily       ~7:30 AM Central   recall lookup, then every notification
 *                                     type, including any held overnight
 *
 * Both hold the script lock so two runs never plan and send at the same time
 * (which could send a notification twice). Each step has its own try/catch:
 * a failed recall lookup never stops the notifications. Every step is
 * idempotent, so a run that dies half-way is simply finished by the next one.
 */

/** How long a job waits for the lock before giving up (the daily run waits longer: skipping it costs a day). */
const JOB_LOCK_WAIT_MS_ = { scanStatus: 5 * 1000, daily: 2 * 60 * 1000 };

/** Every 30 minutes: scan status, then scan notifications. */
function jobScanStatus() {
  return runJob_('jobScanStatus', JOB_LOCK_WAIT_MS_.scanStatus, now => [
    jobStep_('scan status check', () => {
      const r = runScanStatus_({ now: now });
      return { checked: r.checked, changed: r.changed.map(c => c.scanId + ': ' + c.previousStatus + ' → ' + c.status) };
    }),
    jobStep_('scan notifications', () => runNotifications_({ now: new Date(), events: SCAN_NOTIFY_EVENTS_ })),
  ]);
}

/** Daily at ~7:30 AM Central: recalls, then every notification type. */
function jobDaily() {
  return runJob_('jobDaily', JOB_LOCK_WAIT_MS_.daily, now => [
    jobStep_('recall lookup', () => runRecalls_(now)),
    jobStep_('notifications', () => runNotifications_({ now: new Date() })),
  ]);
}

/**
 * Runs a job's steps while holding the script lock. When another run holds
 * it for longer than waitMs, this run is skipped (the next one catches up).
 * @param {function(Date): object[]} body returns the jobStep_ results
 */
function runJob_(name, waitMs, body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) {
    console.warn(name + ': skipped, another run is still busy.');
    return { job: name, skipped: true };
  }
  const t0 = Date.now();
  try {
    const steps = body(new Date());
    return { job: name, skipped: false, steps: steps };
  } finally {
    lock.releaseLock();
    console.log(name + ': finished in ' + (Date.now() - t0) + ' ms.');
  }
}

/** Runs one step, logging its result and duration. Never throws. */
function jobStep_(label, fn) {
  const t0 = Date.now();
  try {
    const result = fn();
    console.log(label + ' (' + (Date.now() - t0) + ' ms): ' + JSON.stringify(result));
    return { step: label, ok: true, result: result };
  } catch (e) {
    console.error(label + ' failed after ' + (Date.now() - t0) + ' ms: ' + (e && e.stack || e));
    return { step: label, ok: false, error: String(e && e.message || e) };
  }
}
