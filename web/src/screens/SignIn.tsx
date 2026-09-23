/**
 * Splash, sign-in and "family only" screens.
 *
 * Sign-in is a full-page redirect to Google (lib/auth.ts; see DECISIONS.md),
 * with "Use a sign-in code" as the fallback for when Google can't finish
 * inside the home-screen app. In mock mode the fixture's people are listed
 * instead ("Continue as Robert"); the mock treats the ID token as the email.
 */

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { config, USE_MOCK } from '../config';
import { startGoogleSignIn } from '../lib/auth';
import { standalone } from '../lib/platform';
import { authState, signInMessage, signInWithCode, signInWithGoogle } from '../state/store';
import { GoogleButton } from '../components/GoogleButton';
import { openInstallGuide } from './InstallGuide';
import './SignIn.css';

const ICON = `${import.meta.env.BASE_URL}icons/icon-192.png`;

function AppIcon(props: { size?: number }): JSX.Element {
  const size = props.size ?? 80;
  return <img class="app-icon" src={ICON} alt="" width={size} height={size} />;
}

export function SplashScreen(): JSX.Element {
  return (
    <div class="center-screen splash" role="status" aria-label="Loading">
      <AppIcon />
      <span class="spinner" aria-hidden="true" />
    </div>
  );
}

interface MockPerson { email: string; name: string }

/** Keeps only letters and digits, upper-cased: "abcd-efgh" → "ABCDEFGH". */
export function normaliseCode(raw: string): string {
  return raw.replace(/[^0-9a-z]/gi, '').toUpperCase();
}

export function SignInScreen(): JSX.Element {
  const [mode, setMode] = useState<'main' | 'code'>('main');
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<MockPerson[]>([]);
  const configured = !!config.oauthClientId;

  useEffect(() => {
    if (!USE_MOCK) return;
    // Loaded lazily so the fixture never ships in the real app's main bundle.
    void import('../api/mock').then(m => setPeople(m.mockIndex().users));
  }, []);

  const google = () => {
    signInMessage.value = null;
    try {
      startGoogleSignIn();
    } catch (e) {
      signInMessage.value = e instanceof Error ? e.message : 'Sign-in couldn’t start.';
    }
  };

  const asPerson = async (email: string) => {
    setBusy(true);
    try {
      await signInWithGoogle(email);
    } finally {
      setBusy(false);
    }
  };

  const family = config.familyName ? `the ${config.familyName} family’s` : 'the family’s';

  return (
    <main class="signin">
      <div class="signin-inner">
        <AppIcon />
        <h1 class="large-title signin-title">{config.appName || 'Vehicles'}</h1>
        <p class="signin-lede">What’s due and what’s been done on {family} vehicles.</p>

        {signInMessage.value && (
          <p class="signin-message" role="alert">{signInMessage.value}</p>
        )}

        {mode === 'main' && (
          <>
            {configured && (
              <div class="signin-block">
                <GoogleButton onClick={google} disabled={busy} />
              </div>
            )}
            {!configured && !USE_MOCK && (
              <p class="signin-note" role="note">
                Sign-in isn’t set up yet. Add the Google OAuth client ID to <code>web/app.config.json</code> (see SETUP.md).
              </p>
            )}

            {USE_MOCK && (
              <section class="signin-mock" aria-labelledby="mock-heading">
                <h2 id="mock-heading" class="section-header signin-mock-heading">Sample people (mock data)</h2>
                <div class="group">
                  {people.map(p => (
                    <button key={p.email} type="button" class="row tappable" disabled={busy} onClick={() => void asPerson(p.email)}>
                      <span class="row-main">Continue as {p.name}</span>
                      <span class="row-sub">{p.email}</span>
                    </button>
                  ))}
                  {!people.length && <p class="row secondary">No mock people. Run “npm run fixture”.</p>}
                </div>
                <MockOtherEmail busy={busy} onSubmit={asPerson} />
              </section>
            )}

            <button type="button" class="link-btn" onClick={() => { signInMessage.value = null; setMode('code'); }}>
              Use a sign-in code
            </button>
            {!standalone.value && (
              <button type="button" class="link-btn signin-install" onClick={openInstallGuide}>
                How to add to your Home Screen
              </button>
            )}
          </>
        )}

        {mode === 'code' && <CodeForm onBack={() => { signInMessage.value = null; setMode('main'); }} />}
      </div>
    </main>
  );
}

function CodeForm(props: { onBack: () => void }): JSX.Element {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const clean = normaliseCode(code);
  const valid = clean.length === 8;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await signInWithCode(clean);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="signin-code" onSubmit={e => void submit(e)}>
      <h2 class="title3">Sign in with a code</h2>
      <p class="subhead secondary">
        Signed in on another device? Open Settings › Sign in on another device there, then type the 8-character code here.
      </p>
      <label class="visually-hidden" for="signin-code">Sign-in code</label>
      <input
        id="signin-code"
        class="field code-field"
        value={code}
        onInput={e => setCode((e.currentTarget as HTMLInputElement).value)}
        placeholder="ABCD EFGH"
        maxLength={11}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellcheck={false}
        inputMode="text"
        enterKeyHint="go"
      />
      <button type="submit" class="btn btn-primary btn-block" disabled={!valid || busy}>
        {busy ? <span class="spinner" aria-label="Signing in" /> : 'Sign in'}
      </button>
      <button type="button" class="link-btn" onClick={props.onBack}>Back</button>
    </form>
  );
}

/** Mock mode only: try any email, e.g. to see the "family only" screen. */
function MockOtherEmail(props: { busy: boolean; onSubmit: (email: string) => Promise<void> }): JSX.Element {
  const [email, setEmail] = useState('');
  return (
    <form
      class="signin-mock-other"
      onSubmit={e => { e.preventDefault(); if (email.trim()) void props.onSubmit(email.trim()); }}
    >
      <label class="footnote" for="mock-email">Another Google account (mock)</label>
      <div class="signin-mock-row">
        <input
          id="mock-email"
          class="field"
          type="email"
          value={email}
          onInput={e => setEmail((e.currentTarget as HTMLInputElement).value)}
          placeholder="someone@example.com"
          autoComplete="off"
        />
        <button type="submit" class="btn" disabled={props.busy || !email.trim()}>Sign in</button>
      </div>
    </form>
  );
}

export function NotFamilyScreen(): JSX.Element {
  const family = config.familyName ? `the ${config.familyName} family` : 'the family';
  return (
    <main class="signin">
      <div class="signin-inner">
        <AppIcon />
        <h1 class="title1">This app is for {family}</h1>
        <p class="signin-lede">
          The Google account you used isn’t on the list of people who can use it. If you think it should be, ask whoever set up the app to add you.
        </p>
        <button
          type="button"
          class="btn btn-primary btn-block"
          onClick={() => { signInMessage.value = null; authState.value = 'signedOut'; }}
        >
          Use a different account
        </button>
      </div>
    </main>
  );
}
