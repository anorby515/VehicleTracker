/**
 * Renders the sheet for the current #/v/<vehicle>/<sub> route: a visit, an
 * Upcoming item, or one of the panels (basics, odometer, costs, wear,
 * registration, recalls, coverage, export). Closing goes back (or, after a
 * deep link from a notification, replaces the route with the vehicle card).
 */

import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import type { Vehicle } from '../api/types';
import { prunePhotos } from '../lib/photos';
import { back, href, route, type Panel } from '../state/router';
import { vehicles } from '../state/store';
import { Sheet } from '../ui/Sheet';
import { NotFound } from './common';
import { UpcomingSheet } from './UpcomingSheet';
import { VisitSheet } from './VisitSheet';
import { BasicsSheet } from './panels/BasicsSheet';
import { CostsSheet } from './panels/CostsSheet';
import { CoverageSheet } from './panels/CoverageSheet';
import { ExportSheet } from './panels/ExportSheet';
import { OdometerSheet } from './panels/OdometerSheet';
import { RecallsSheet } from './panels/RecallsSheet';
import { RegistrationSheet } from './panels/RegistrationSheet';
import { WearSheet } from './panels/WearSheet';

type PanelSheet = (p: { vehicle: Vehicle; onClose: () => void }) => JSX.Element;

const PANELS: Record<Panel, PanelSheet> = {
  basics: BasicsSheet,
  odometer: OdometerSheet,
  costs: CostsSheet,
  wear: WearSheet,
  registration: RegistrationSheet,
  recalls: RecallsSheet,
  coverage: CoverageSheet,
  export: ExportSheet,
};

export function VehicleRouteSheets(): JSX.Element | null {
  usePrunePhotos();
  const r = route.value;
  if (r.name !== 'vehicle' || !r.sub) return null;
  const name = r.vehicle;
  const close = () => back(href.vehicle(name));
  const v = vehicles.value.find(x => x.name === name);

  if (!v) {
    const list = vehicles.value;
    return (
      <Sheet title="Not found" onClose={() => back(list.length ? href.vehicle(list[0].name) : href.home())} auto>
        <NotFound text={`“${name}” isn’t one of the family’s vehicles any more.`} />
      </Sheet>
    );
  }

  const sub = r.sub;
  if (sub.kind === 'visit') {
    const visit = v.visits.find(x => x.visitId === sub.visitId);
    if (!visit) {
      return (
        <Sheet title="Visit not found" onClose={close} auto>
          <NotFound text={`That visit isn’t in the ${v.shortName || v.name}’s journal. It may have been changed in the Sheet.`} />
        </Sheet>
      );
    }
    // key: a new visit (e.g. "See that visit" from an Upcoming item) starts fresh.
    return <VisitSheet key={visit.visitId} vehicle={v} visit={visit} onClose={close} />;
  }

  if (sub.kind === 'upcoming') {
    const item = v.upcoming.find(x => x.id === sub.itemId) ?? v.noHistory.find(x => x.id === sub.itemId);
    if (!item) {
      return (
        <Sheet title="Not on the list" onClose={close} auto>
          <NotFound text="This isn’t on the Upcoming list any more. It may have been done, or changed in the Sheet." />
        </Sheet>
      );
    }
    return <UpcomingSheet key={item.id} vehicle={v} item={item} onClose={close} />;
  }

  const Panel = PANELS[sub.panel];
  return <Panel key={`${v.name}:${sub.panel}`} vehicle={v} onClose={close} />;
}

/**
 * Drops cached vehicle photos no vehicle uses any more (a new photo gets a
 * new Drive file ID). Rendered once in the main screen, so it runs whenever
 * the set of photo IDs changes. Skipped while there's no vehicle data.
 */
function usePrunePhotos(): void {
  const ids = vehicles.value.map(v => v.photoFileId).filter((x): x is string => !!x);
  const key = [...ids].sort().join('|');
  useEffect(() => {
    if (!vehicles.value.length) return;
    const t = setTimeout(() => { void prunePhotos(ids); }, 3000);
    return () => clearTimeout(t);
  }, [key]);
}
