/**
 * Rendered once at the app root. When the flow is opened it loads the flow
 * chunk (scanner UI, pdf-lib) and shows it full screen.
 */

import type { ComponentType, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Overlay, StepBar } from './common';
import { closeFlow, flowRequest, type FlowRequest } from './state';
import './Flow.css';

type FlowComponent = ComponentType<{ request: FlowRequest; onClose: () => void }>;

let loaded: FlowComponent | null = null;

export function AddReceiptHost(): JSX.Element | null {
  const req = flowRequest.value;
  const [Flow, setFlow] = useState<FlowComponent | null>(() => loaded);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!req || Flow) return;
    let cancelled = false;
    setError(null);
    import('./Flow')
      .then(m => {
        loaded = m.Flow;
        if (!cancelled) setFlow(() => m.Flow);
      })
      .catch(() => {
        if (!cancelled) setError('Add Receipt couldn’t open. Check your connection and try again.');
      });
    return () => { cancelled = true; };
  }, [req?.id, Flow]);

  if (!req) return null;
  if (Flow) return <Flow key={req.id} request={req} onClose={closeFlow} />;
  return (
    <Overlay label="Add Receipt" onEscape={closeFlow}>
      <StepBar title="Add Receipt" left={<button type="button" class="btn btn-plain" onClick={closeFlow}>Cancel</button>} />
      <div class="ar-body ar-center">
        {error ? <p role="alert">{error}</p> : <span class="spinner" aria-label="Opening" />}
      </div>
    </Overlay>
  );
}
