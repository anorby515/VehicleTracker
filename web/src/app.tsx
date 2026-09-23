/**
 * Top-level screen switch. Ownership of the pieces below (see docs/FRONTEND.md):
 * - screens/  sign-in, main layout, search, settings, install guide  (shell)
 * - vehicle/  the vehicle card and every vehicle sub-view            (vehicle)
 * - receipts/ Add Receipt flows, upload queue, My scans              (receipts)
 */

import type { JSX } from 'preact';
import { authState } from './state/store';
import { MainScreen } from './screens/Main';
import { InstallGuideHost } from './screens/InstallGuide';
import { NotFamilyScreen, SignInScreen, SplashScreen } from './screens/SignIn';
import { ToastHost } from './ui/toast';

export function App(): JSX.Element {
  let screen: JSX.Element;
  switch (authState.value) {
    case 'loading': screen = <SplashScreen />; break;
    case 'signedOut': screen = <SignInScreen />; break;
    case 'notFamily': screen = <NotFamilyScreen />; break;
    default: screen = <MainScreen />;
  }
  return (
    <>
      {screen}
      <InstallGuideHost />
      <ToastHost />
    </>
  );
}
