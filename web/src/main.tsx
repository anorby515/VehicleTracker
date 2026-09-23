import { render } from 'preact';
import './styles/base.css';
import { App } from './app';
import { startLifecycle } from './state/lifecycle';
import { boot } from './state/store';
import { initServiceWorker } from './state/sw-register';

startLifecycle();
render(<App />, document.getElementById('app')!);
void boot();
initServiceWorker();
