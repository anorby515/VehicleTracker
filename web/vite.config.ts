import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appConfig = JSON.parse(readFileSync(new URL('./app.config.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** GitHub Pages project site: https://<user>.github.io/VehicleTracker/ */
const BASE = process.env.VITE_BASE || '/VehicleTracker/';

/**
 * OpenCV.js (~10 MB, WASM embedded) is served as a separate, versioned static
 * file and loaded only when the scanner opens (see src/scanner/opencv.ts).
 * It is NOT precached; the service worker caches it on first use.
 */
export const OPENCV_PATH = 'vendor/opencv/opencv-4.10.0.js';

function opencvAsset(): Plugin {
  const src = () => require.resolve('@techstark/opencv-js/dist/opencv.js');
  return {
    name: 'opencv-asset',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.endsWith(OPENCV_PATH)) {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(readFileSync(src()));
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: OPENCV_PATH, source: readFileSync(src()) });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: BASE,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version || '1.0.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __USE_MOCK__: JSON.stringify(mode === 'mock' || process.env.VITE_USE_MOCK === '1'),
    __OPENCV_PATH__: JSON.stringify(OPENCV_PATH),
  },
  plugins: [
    preact(),
    opencvAsset(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        globIgnores: ['**/vendor/opencv/**', '**/pdf.worker*'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        // A stable id so iOS keeps Focus/notification settings across updates.
        id: BASE,
        name: appConfig.appName,
        short_name: appConfig.appName,
        description: 'What’s due on each family vehicle, its service history, and receipt scanning.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f2f2f7',
        theme_color: '#f2f2f7',
        icons: [
          { src: 'icons/apple-touch-icon-180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false, type: 'module' },
    }),
  ],
  build: {
    target: ['es2022', 'safari16'],
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
}));
