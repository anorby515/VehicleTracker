/**
 * The Add Receipt flow (spec 7.1, 7.5, 7.6, 8.5), full screen over the app.
 *
 *   Choose ─┬─ Scan a paper receipt: coaching → camera → adjust → pages ⟲ → Which car? → upload → Got it!
 *           ├─ Upload a digital receipt: coaching + picker + review → Which car? → upload → Got it!
 *           ├─ Work I did myself: form (+ photos via the scanner) → upload → Got it!
 *           └─ Use the Google Drive scanner instead: instruction card
 *
 * Steps are component state, never routes (iOS re-asks for the camera when
 * the hash changes). One camera stream serves every page: it's paused while
 * a page is adjusted or the tray is open, and stopped when the flow moves on
 * or closes (or after a minute without the camera, to save battery).
 */

import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ScanKind } from '../api/types';
import { todayYmd } from '../lib/format';
import { assemblePdf } from '../pdf/assemble';
import { type CombineInput, combineFiles, countPdfPages } from '../pdf/combine';
import { buildOwnerEntryPdf } from '../pdf/ownerEntry';
import { CameraSession } from '../scanner/camera';
import type { CV } from '../scanner/cv';
import { normalizeImage, thumbnailUrl } from '../scanner/image';
import { loadOpenCv, openCvReady } from '../scanner/opencv';
import { MAX_SCAN_PAGES, type ScannedPage, freePage, newPageId } from '../scanner/pipeline';
import { go, href } from '../state/router';
import { bootstrap, user, vehicles } from '../state/store';
import { AdjustStep } from './AdjustStep';
import { CameraStep } from './CameraStep';
import { ChooseStep, CoachStep, DriveCard } from './ChooseStep';
import { ConfirmDialog, type ConfirmRequest, Overlay, StepBar, plural } from './common';
import { DigitalUpload, type DigitalFile, freeFile, prepareFile, totals } from './DigitalUpload';
import { OwnerEntryForm, type OwnerForm, emptyOwnerForm, ownerFormDirty, validateOwnerForm } from './OwnerEntryForm';
import { PagesTray } from './PagesTray';
import type { FlowRequest } from './state';
import { type BuiltPdf, UploadStep } from './UploadStep';
import { WhichCarStep } from './WhichCar';
import './PagesTray.css';

type Mode = 'scan' | 'digital' | 'owner';

type AdjustTarget = { kind: 'pages'; replace: number | null } | { kind: 'digital'; index: number };

type Step =
  | { name: 'choose' }
  | { name: 'drive' }
  | { name: 'coach' }
  | { name: 'camera'; replace: number | null }
  | { name: 'adjust'; still: Blob; origin: 'camera' | 'file'; target: AdjustTarget; key: number }
  | { name: 'tray' }
  | { name: 'digital' }
  | { name: 'owner' }
  | { name: 'car' }
  | { name: 'upload' };

/** Stop the paused camera after this long without it (battery). */
const IDLE_CAMERA_MS = 60_000;

const KIND: Record<Mode, ScanKind> = { scan: 'Receipt', digital: 'Upload', owner: 'Owner entry' };

let stillSeq = 0;

export function Flow(props: { request: FlowRequest; onClose: () => void }): JSX.Element {
  const vs = vehicles.value;
  const [vehicle, setVehicle] = useState(() => vs.find(v => v.name === props.request.vehicle)?.name ?? vs[0]?.name ?? props.request.vehicle);
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState<Step>({ name: 'choose' });
  const [pages, setPages] = useState<ScannedPage[]>([]);
  const [files, setFiles] = useState<DigitalFile[]>([]);
  const [owner, setOwner] = useState<OwnerForm>(emptyOwnerForm);
  const [ownerErrors, setOwnerErrors] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [opening, setOpening] = useState<Promise<MediaStream> | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [cv, setCv] = useState<CV | null>(null);
  const [cvStatus, setCvStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const camera = useMemo(() => new CameraSession(), []);
  const cvPromise = useRef<Promise<CV | null> | null>(null);
  const saved = useRef(false);
  const live = useRef({ pages, files });
  live.current = { pages, files };

  const current = vs.find(v => v.name === vehicle);
  const vehicleShort = current?.shortName ?? vehicle;

  // ------------------------------------------------------------ OpenCV and the camera

  const getCv = (): Promise<CV | null> => {
    if (!cvPromise.current) {
      if (!openCvReady()) setCvStatus('loading');
      cvPromise.current = loadOpenCv().then(
        m => { setCv(m); setCvStatus('ready'); return m; },
        () => { setCvStatus('failed'); return null; },
      );
    }
    return cvPromise.current;
  };

  /** Tap handler: go to the camera (reusing the stream), or to the photo fallback. */
  const startCamera = (replace: number | null) => {
    void getCv();
    let p: Promise<MediaStream> | null = null;
    if (camera.live()) {
      camera.resume();
    } else if (!cameraFailed) {
      p = camera.open();
      p.catch(() => setCameraFailed(true));
    }
    setOpening(p);
    setStep({ name: 'camera', replace });
  };

  const retryCamera = () => {
    setCameraFailed(false);
    const p = camera.open();
    p.catch(() => setCameraFailed(true));
    setOpening(p);
  };

  useEffect(() => {
    const n = step.name;
    if (n === 'camera') { camera.resume(); return; }
    if (n === 'adjust' || n === 'tray') {
      camera.pause();
      const t = setTimeout(() => camera.stop(), IDLE_CAMERA_MS);
      return () => clearTimeout(t);
    }
    camera.stop();
  }, [step.name]);

  // Leaving: turn the camera off and free the previews.
  useEffect(() => () => {
    camera.stop();
    live.current.pages.forEach(freePage);
    live.current.files.forEach(freeFile);
  }, []);

  // ------------------------------------------------------------ closing and going back

  const dirtyMessage = (): string | null => {
    if (saved.current) return null;
    if (mode === 'scan' && (pages.length || step.name === 'adjust')) {
      return pages.length ? `The ${plural(pages.length, 'page', 'pages')} you’ve scanned will be deleted.` : 'The photo you just took will be deleted.';
    }
    if (mode === 'digital' && files.length) return 'The files you picked won’t be uploaded.';
    if (mode === 'owner' && (ownerFormDirty(owner) || pages.length)) return 'What you’ve entered won’t be saved.';
    return null;
  };

  const requestClose = () => {
    const msg = dirtyMessage();
    if (!msg) { props.onClose(); return; }
    setConfirm({ title: 'Discard this?', message: msg, confirmLabel: 'Discard', cancelLabel: 'Keep going', danger: true, onConfirm: props.onClose });
  };

  const resetMode = () => {
    pages.forEach(freePage);
    files.forEach(freeFile);
    setPages([]);
    setFiles([]);
    setOwner(emptyOwnerForm());
    setOwnerErrors([]);
    setMode(null);
    setStep({ name: 'choose' });
  };

  const backToChoose = () => {
    const msg = dirtyMessage();
    if (!msg) { resetMode(); return; }
    setConfirm({ title: 'Discard this?', message: msg, confirmLabel: 'Discard', cancelLabel: 'Keep going', danger: true, onConfirm: resetMode });
  };

  // ------------------------------------------------------------ pages (scan pages or owner photos)

  const onStill = (blob: Blob, origin: 'camera' | 'file') => {
    const replace = step.name === 'camera' ? step.replace : null;
    stillSeq++;
    setStep({ name: 'adjust', still: blob, origin, target: { kind: 'pages', replace }, key: stillSeq });
  };

  const usePage = (target: AdjustTarget, page: ScannedPage) => {
    if (target.kind === 'digital') {
      setFiles(fs => fs.map((f, i) => {
        if (i !== target.index) return f;
        freeFile(f);
        return { ...f, data: page.jpeg, width: page.width, height: page.height, thumb: page.thumb, cleaned: true };
      }));
      setStep({ name: 'digital' });
      return;
    }
    setPages(ps => {
      if (target.replace !== null && ps[target.replace]) {
        freePage(ps[target.replace]);
        return ps.map((p, i) => (i === target.replace ? page : p));
      }
      return [...ps, page].slice(0, MAX_SCAN_PAGES);
    });
    setStep({ name: 'tray' });
  };

  const movePage = (i: number, d: -1 | 1) => setPages(ps => swap(ps, i, i + d));

  const deletePage = (i: number) => {
    setConfirm({
      title: `Delete page ${i + 1}?`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => setPages(ps => { freePage(ps[i]); return ps.filter((_, j) => j !== i); }),
    });
  };

  const pagesDone = () => setStep(mode === 'owner' ? { name: 'owner' } : { name: 'car' });

  // ------------------------------------------------------------ digital files

  const addFiles = (picked: File[]) => {
    const placeholders = picked.map(f => ({
      id: `loading-${Math.random().toString(36).slice(2)}`, name: f.name || 'File', kind: 'image' as const, data: null, original: null,
      width: 0, height: 0, pages: null, thumb: null, status: 'loading' as const, error: null, cleaned: false,
    }));
    setFiles(fs => [...fs, ...placeholders]);
    picked.forEach((file, k) => {
      void prepareFile(file).then(ready => {
        setFiles(fs => fs.map(f => (f.id === placeholders[k].id ? ready : f)));
      });
    });
  };

  const straighten = (i: number) => {
    const f = files[i];
    const still = f?.original ?? f?.data;
    if (!still) return;
    void getCv();
    stillSeq++;
    setStep({ name: 'adjust', still, origin: 'file', target: { kind: 'digital', index: i }, key: stillSeq });
  };

  // ------------------------------------------------------------ owner entry

  const pickOwnerPhotos = async (picked: File[]) => {
    setPicking(true);
    try {
      for (const file of picked) {
        if (live.current.pages.length >= MAX_SCAN_PAGES) break;
        try {
          const img = await normalizeImage(file, 2000, 0.8);
          const thumb = await thumbnailUrl(img.jpeg, 360);
          const page: ScannedPage = { id: newPageId(), jpeg: img.jpeg, width: img.width, height: img.height, thumb, filter: 'photo' };
          setPages(ps => [...ps, page].slice(0, MAX_SCAN_PAGES));
        } catch {
          setOwnerErrors([`“${file.name}” couldn’t be opened. Try a different photo.`]);
        }
      }
    } finally {
      setPicking(false);
    }
  };

  const submitOwner = () => {
    const { errors } = validateOwnerForm(owner);
    setOwnerErrors(errors);
    if (!errors.length) setStep({ name: 'upload' });
  };

  // ------------------------------------------------------------ building the PDF

  const build = async (): Promise<BuiltPdf> => {
    const who = user.value?.name ?? '';
    const createdAt = new Date();
    if (mode === 'digital') {
      const inputs: CombineInput[] = files
        .filter(f => f.status === 'ready' && f.data)
        .map(f => (f.kind === 'pdf'
          ? { kind: 'pdf' as const, name: f.name, data: f.data! }
          : { kind: 'image' as const, name: f.name, jpeg: f.data!, width: f.width, height: f.height }));
      const r = await combineFiles(inputs, { title: `Receipt upload - ${vehicle} - ${todayYmd(createdAt)}`, author: who, createdAt });
      return { pdf: r.pdf, pages: r.pages };
    }
    if (mode === 'owner') {
      const v = vs.find(x => x.name === vehicle);
      const { mileage, partsCost } = validateOwnerForm(owner);
      const bytes = await buildOwnerEntryPdf({
        vehicleName: vehicle, vin: v?.vin ?? null, plate: v?.plate ?? null,
        date: owner.date, dateApprox: owner.dateApprox, mileage, mileageApprox: owner.mileageApprox,
        services: owner.services, otherWork: owner.otherWork, partsCost, notes: owner.notes,
        who, enteredAt: createdAt, photoCount: pages.length,
      }, pages.map(p => ({ jpeg: p.jpeg, width: p.width, height: p.height })));
      const n = await countPdfPages(bytes, 'record');
      return { pdf: new Blob([bytes as BlobPart], { type: 'application/pdf' }), pages: n };
    }
    const bytes = await assemblePdf(
      pages.map(p => ({ jpeg: p.jpeg, width: p.width, height: p.height })),
      { title: `Receipt scan - ${vehicle} - ${todayYmd(createdAt)}`, author: who, createdAt },
    );
    return { pdf: new Blob([bytes as BlobPart], { type: 'application/pdf' }), pages: pages.length };
  };

  // ------------------------------------------------------------ render

  const back = (label = 'Back', onClick: () => void = backToChoose) => <button type="button" class="btn btn-plain" onClick={onClick}>{label}</button>;
  let body: JSX.Element;
  let dark = false;

  switch (step.name) {
    case 'choose':
      body = (
        <>
          <StepBar title="Add Receipt" left={back('Cancel', props.onClose)} />
          <ChooseStep
            vehicleShort={vehicleShort}
            onScan={() => { setMode('scan'); setStep({ name: 'coach' }); void getCv(); }}
            onDigital={() => { setMode('digital'); setStep({ name: 'digital' }); }}
            onOwner={() => { setMode('owner'); setStep({ name: 'owner' }); }}
            onDrive={() => setStep({ name: 'drive' })}
          />
        </>
      );
      break;
    case 'drive':
      body = <><StepBar title="Google Drive scanner" left={back()} /><DriveCard /></>;
      break;
    case 'coach':
      body = <><StepBar title="Scan a paper receipt" left={back()} /><CoachStep onStart={() => startCamera(null)} /></>;
      break;
    case 'camera':
      dark = true;
      body = (
        <CameraStep
          camera={camera}
          opening={opening}
          cv={cv}
          cvStatus={cvStatus}
          pageCount={pages.length}
          retakePage={step.replace !== null ? step.replace + 1 : null}
          subject={mode === 'owner' ? 'photo' : 'receipt'}
          onStill={onStill}
          onClose={() => {
            if (pages.length) setStep({ name: 'tray' });
            else if (mode === 'owner') setStep({ name: 'owner' });
            else setStep({ name: 'coach' });
          }}
          onShowPages={() => setStep({ name: 'tray' })}
          onRetryCamera={retryCamera}
        />
      );
      break;
    case 'adjust': {
      const target = step.target;
      const toDigital = target.kind === 'digital';
      body = (
        <AdjustStep
          key={step.key}
          still={step.still}
          origin={step.origin}
          getCv={getCv}
          cvLoading={cvStatus === 'loading'}
          title={toDigital ? 'Straighten & clean up' : undefined}
          retakeLabel={toDigital ? 'Cancel' : 'Retake'}
          onRetake={() => (toDigital ? setStep({ name: 'digital' }) : startCamera(target.kind === 'pages' ? target.replace : null))}
          onUse={page => usePage(target, page)}
        />
      );
      break;
    }
    case 'tray':
      body = (
        <PagesTray
          title={mode === 'owner' ? 'Photos' : 'Pages'}
          pages={pages}
          doneLabel="Done"
          onMove={movePage}
          onDelete={deletePage}
          onRetake={i => startCamera(i)}
          onAddPage={() => startCamera(null)}
          onDone={pagesDone}
          onCancel={mode === 'owner' ? () => setStep({ name: 'owner' }) : requestClose}
          cancelLabel={mode === 'owner' ? 'Back' : 'Cancel'}
        />
      );
      break;
    case 'digital':
      body = (
        <>
          <StepBar title="Upload a digital receipt" left={back()} />
          <DigitalUpload
            files={files}
            onAdd={addFiles}
            onRemove={i => setFiles(fs => { freeFile(fs[i]); return fs.filter((_, j) => j !== i); })}
            onMove={(i, d) => setFiles(fs => swap(fs, i, i + d))}
            onStraighten={straighten}
            onNext={() => setStep({ name: 'car' })}
          />
        </>
      );
      break;
    case 'owner':
      body = (
        <>
          <StepBar title="Work I did myself" left={back()} />
          <OwnerEntryForm
            vehicles={vs}
            vehicle={vehicle}
            onVehicle={setVehicle}
            serviceTypes={bootstrap.value?.serviceTypes ?? []}
            form={owner}
            onChange={f => { setOwner(f); if (ownerErrors.length) setOwnerErrors([]); }}
            photos={pages}
            onRemovePhoto={i => setPages(ps => { freePage(ps[i]); return ps.filter((_, j) => j !== i); })}
            onScanPhotos={() => startCamera(null)}
            onPickPhotos={files => void pickOwnerPhotos(files)}
            pickingPhotos={picking}
            errors={ownerErrors}
            onSubmit={submitOwner}
          />
        </>
      );
      break;
    case 'car': {
      const summary = mode === 'digital'
        ? (() => { const t = totals(files); const n = files.filter(f => f.status === 'ready').length; return `${plural(n, 'file', 'files')}, ${plural(t.pages, 'page', 'pages')} in all.`; })()
        : `${plural(pages.length, 'page', 'pages')} scanned.`;
      body = (
        <>
          <StepBar title="Which car?" left={back('Back', () => setStep(mode === 'digital' ? { name: 'digital' } : { name: 'tray' }))} />
          <WhichCarStep vehicles={vs} value={vehicle} onChange={setVehicle} onUpload={() => setStep({ name: 'upload' })} summary={summary} />
        </>
      );
      break;
    }
    case 'upload':
      body = (
        <>
          <StepBar title={mode === 'owner' ? 'Work I did myself' : 'Add Receipt'} />
          <UploadStep
            kind={KIND[mode ?? 'scan']}
            vehicle={vehicle}
            build={build}
            onSaved={() => { saved.current = true; }}
            onBack={() => setStep(mode === 'digital' ? { name: 'digital' } : mode === 'owner' ? { name: 'owner' } : { name: 'tray' })}
            onSeeScans={() => { props.onClose(); go(href.scans()); }}
            onDone={props.onClose}
          />
        </>
      );
      break;
  }

  return (
    <Overlay label="Add Receipt" dark={dark} onEscape={confirm ? undefined : requestClose}>
      {body}
      {confirm && <ConfirmDialog req={confirm} onCancel={() => setConfirm(null)} />}
    </Overlay>
  );
}

function swap<T>(list: T[], i: number, j: number): T[] {
  if (i < 0 || j < 0 || i >= list.length || j >= list.length) return list;
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
