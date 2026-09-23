/**
 * The first screens of Add Receipt: choose what to add (spec 7.1 step 1),
 * the Google Drive scanner card (7.5), and the "One visit, one scan"
 * coaching card (7.1 step 2).
 */

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { config } from '../config';
import { Icon, type IconName } from '../ui/Icon';
import { FULL_COACH_TIMES, bumpCoachCount, coachCount } from './state';

export function ChooseStep(props: {
  vehicleShort: string;
  onScan: () => void;
  onDigital: () => void;
  onOwner: () => void;
  onDrive: () => void;
}): JSX.Element {
  return (
    <div class="ar-body">
      <p class="ar-lead">What would you like to add for the {props.vehicleShort}?</p>
      <div class="ar-choices">
        <ChoiceButton primary icon="camera" title="Scan a paper receipt" sub="Use the camera. Every page from one shop visit." onClick={props.onScan} />
        <ChoiceButton icon="file" title="Upload a digital receipt" sub="A PDF or photo saved on your phone, like an emailed invoice." onClick={props.onDigital} />
        <ChoiceButton icon="wrench" title="Work I did myself" sub="No shop receipt? Record what you did." onClick={props.onOwner} />
      </div>
      <div class="ar-center-row">
        <button type="button" class="link-btn" onClick={props.onDrive}>Use the Google Drive scanner instead</button>
      </div>
    </div>
  );
}

function ChoiceButton(props: { icon: IconName; title: string; sub: string; primary?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" class={`ar-choice${props.primary ? ' ar-choice-primary' : ''}`} onClick={props.onClick}>
      <span class="ar-choice-icon"><Icon name={props.icon} size={26} /></span>
      <span class="ar-choice-text">
        <span class="ar-choice-title">{props.title}</span>
        <span class="ar-choice-sub">{props.sub}</span>
      </span>
      <Icon name="chevronRight" size={18} class="ar-choice-chevron" />
    </button>
  );
}

/** Spec 7.5: instructions, then the Drive app (never an automatic redirect). */
export function DriveCard(): JSX.Element {
  const openDrive = () => {
    // A custom URL scheme: iOS hands off to the app if it's installed.
    location.href = config.googleDriveAppUrl;
  };
  return (
    <div class="ar-body">
      <section class="ar-card" aria-labelledby="drive-title">
        <h3 id="drive-title" class="title3">Scan with the Google Drive app</h3>
        <ol class="ar-steps">
          <li>Tap + then Scan.</li>
          <li>Scan every page from this one visit.</li>
          <li>Tap Save and choose Family Share › Vehicles › Inbox.</li>
          <li>Come back here by tapping the {config.appName || 'Vehicles'} icon on your home screen.</li>
        </ol>
        <p class="ar-note">These won’t show a status here, but they’ll still be filed.</p>
      </section>
      <div class="ar-actions">
        <button type="button" class="btn btn-primary btn-block" onClick={openDrive}>
          <Icon name="drive" size={20} /> Open Google Drive
        </button>
        <a class="btn btn-plain btn-block" href={config.googleDriveAppStoreUrl} target="_blank" rel="noopener noreferrer">
          Don’t have the Drive app?
        </a>
      </div>
    </div>
  );
}

/**
 * Spec 7.1 step 2. The full card the first three times on this phone, then
 * a one-line reminder (with the full tips a tap away).
 */
export function CoachStep(props: { onStart: () => void }): JSX.Element {
  const [full, setFull] = useState(() => coachCount() < FULL_COACH_TIMES);
  const [counted, setCounted] = useState(false);
  useEffect(() => {
    if (full && !counted) { bumpCoachCount(); setCounted(true); }
  }, [full]);

  return (
    <div class="ar-body">
      {full ? (
        <section class="ar-card ar-coach" aria-labelledby="coach-title">
          <div class="ar-coach-art" aria-hidden="true"><CoachArt /></div>
          <h3 id="coach-title" class="title2">One visit, one scan</h3>
          <p>
            Gather every page from this one shop visit (the invoice, the inspection sheet, the payment slip) and scan
            them together. Got receipts from two visits? Do them one at a time so each gets filed in the right place.
          </p>
          <ul class="ar-tips">
            <li>Lay it flat on something dark.</li>
            <li>Good light, no shadows.</li>
            <li>Every page, even the boring ones.</li>
          </ul>
        </section>
      ) : (
        <div class="ar-reminder">
          <Icon name="info" size={20} />
          <p>
            <strong>One visit, one scan.</strong> Every page from this one shop visit, together.{' '}
            <button type="button" class="link-btn ar-inline-link" onClick={() => setFull(true)}>Show tips</button>
          </p>
        </div>
      )}
      <div class="ar-actions">
        <button type="button" class="btn btn-primary btn-block" onClick={props.onStart}>
          <Icon name="camera" size={20} /> Start scanning
        </button>
      </div>
    </div>
  );
}

/** A receipt on a dark surface with its outline found. */
function CoachArt(): JSX.Element {
  return (
    <svg viewBox="0 0 160 100" width="160" height="100" role="presentation">
      <rect x="0" y="0" width="160" height="100" rx="12" fill="#2c2c2e" />
      <g transform="rotate(-6 80 50)">
        <rect x="52" y="12" width="56" height="78" rx="2" fill="#fafafa" />
        {[22, 30, 38, 46, 54].map(y => <rect key={y} x="58" y={y} width={y % 16 ? 36 : 44} height="3" rx="1.5" fill="#b8b8bd" />)}
        <rect x="58" y="70" width="20" height="4" rx="2" fill="#6e6e73" />
        <rect x="82" y="70" width="20" height="4" rx="2" fill="#6e6e73" />
        <rect x="50" y="10" width="60" height="82" rx="3" fill="none" stroke="#34c759" stroke-width="2.5" />
      </g>
    </svg>
  );
}
