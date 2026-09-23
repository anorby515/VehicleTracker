/**
 * The signed-in app: top bar with the current vehicle and page dots, one
 * swipeable page per vehicle, the floating Add Receipt button, status
 * banners, and the route overlays (search, settings, scans, vehicle sheets).
 *
 * Which vehicle is shown:
 * - at start: the route's vehicle (#/v/<name>), else the person's Default
 *   Vehicle, else the first one;
 * - swiping replaces the route with #/v/<name> (no new history entry);
 * - a route change from outside (deep link, back from a sheet) scrolls there.
 */

import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { User, Vehicle } from '../api/types';
import { AddReceiptButton } from '../components/AddReceiptButton';
import { PageNotices, TopBanners } from '../components/Banners';
import { TopBar } from '../components/TopBar';
import { type PagerApi, VehiclePager } from '../components/VehiclePager';
import { config } from '../config';
import { AddReceiptHost, ScansSheet, openAddReceipt } from '../receipts';
import { type Route, go, href, route } from '../state/router';
import { currentVehicleName, refresh, refreshing, user, vehicles } from '../state/store';
import { VehicleRouteSheets } from '../vehicle/VehicleRouteSheets';
import { SearchScreen } from './Search';
import { SettingsScreen } from './Settings';
import './Main.css';

/** Index to open on: the route's vehicle, else the Default Vehicle, else the first. */
export function initialIndex(vs: Vehicle[], r: Route, u: User | null): number {
  if (!vs.length) return 0;
  if (r.name === 'vehicle') {
    const i = vs.findIndex(v => v.name === r.vehicle);
    if (i >= 0) return i;
  }
  if (u?.defaultVehicle) {
    const i = vs.findIndex(v => v.name === u.defaultVehicle);
    if (i >= 0) return i;
  }
  return 0;
}

export function MainScreen(): JSX.Element {
  const vs = vehicles.value;
  const r = route.value;
  const pager = useRef<PagerApi | null>(null);

  let index = vs.findIndex(v => v.name === currentVehicleName.value);
  if (index < 0) index = initialIndex(vs, r, user.value);
  const current = vs[index] ?? null;

  // Remember the vehicle on screen by name, and show it in the address (#/ → #/v/<name>).
  useEffect(() => {
    if (!current) return;
    if (currentVehicleName.value !== current.name) currentVehicleName.value = current.name;
    if (route.value.name === 'home') go(href.vehicle(current.name), true);
  }, [current?.name, r.name]);

  // A route change from outside (deep link, back from a sheet, notification) moves the pager.
  useEffect(() => {
    if (r.name !== 'vehicle') return;
    const i = vs.findIndex(v => v.name === r.vehicle);
    if (i < 0 || vs[i].name === currentVehicleName.value) return;
    currentVehicleName.value = vs[i].name;
    pager.current?.scrollTo(i, false);
  }, [r, vs]);

  const onCurrentChange = (i: number) => {
    const v = vs[i];
    if (!v) return;
    currentVehicleName.value = v.name;
    const now = route.value;
    // Swiping updates the route in place, but never replaces an open sheet or screen.
    if (now.name === 'home' || (now.name === 'vehicle' && !now.sub && now.vehicle !== v.name)) {
      go(href.vehicle(v.name), true);
    }
  };

  return (
    <div class="main">
      <TopBar
        vehicles={vs}
        current={index}
        title={current?.name ?? (config.appName || 'Vehicles')}
        onDot={i => pager.current?.scrollTo(i, true)}
      />
      <TopBanners />

      {vs.length ? (
        <VehiclePager
          vehicles={vs}
          current={index}
          onCurrentChange={onCurrentChange}
          onRefresh={refresh}
          apiRef={pager}
          pageTop={() => <PageNotices />}
        />
      ) : (
        <NoVehicles />
      )}

      {current && <AddReceiptButton vehicleName={current.name} onClick={() => openAddReceipt(current.name)} />}

      {r.name === 'search' && <SearchScreen q={r.q} />}
      {r.name === 'settings' && <SettingsScreen />}
      {r.name === 'scans' && <ScansSheet scanId={r.scanId} />}
      <VehicleRouteSheets />
      <AddReceiptHost />
    </div>
  );
}

function NoVehicles(): JSX.Element {
  return (
    <div class="main-empty">
      <PageNotices />
      <div class="empty">
        <p class="title3">No vehicles yet</p>
        <p>Vehicles show up here once they’re marked Active on the Vehicles tab of the Sheet.</p>
        <button type="button" class="btn" disabled={refreshing.value} onClick={() => void refresh()}>
          {refreshing.value ? <span class="spinner" aria-label="Refreshing" /> : 'Refresh'}
        </button>
      </div>
    </div>
  );
}
