#!/usr/bin/env node
/**
 * Renders the app icon (an inline SVG) to the PNGs the app and manifest use:
 *
 *   public/icons/apple-touch-icon-180.png  iPhone home screen (opaque, no transparency)
 *   public/icons/icon-192.png              manifest
 *   public/icons/icon-512.png              manifest
 *   public/icons/icon-512-maskable.png     manifest, purpose "maskable" (mark inside the 80% safe zone)
 *   public/icons/favicon-32.png            browser tab
 *
 * Uses Playwright's Chromium. Set PW_CHROMIUM_PATH to use an installed
 * Chromium instead of the one `npx playwright install chromium` downloads.
 *
 *   node scripts/make-icons.mjs
 *
 * The PNGs are committed; re-run only when the design changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');

const BLUE = '#007aff';
const BLUE_DARK = '#0062d6';

/**
 * The mark: a calm, simple car in white on the app blue, drawn in a 100×100 box
 * and centred (its body spans x 17–83, y 27–71).
 */
function mark() {
  return `
    <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 1)">
      <!-- body -->
      <path d="M17 60 V51 c0-2.2 1.2-4.2 3.1-5.3 L27 42 l6.3-11.2 c1.2-2.1 3.4-3.3 5.8-3.3 h21.8 c2.4 0 4.6 1.3 5.8 3.3 L73 42 l6.9 3.7 c1.9 1.1 3.1 3.1 3.1 5.3 V60 c0 1.7-1.3 3-3 3 H20 c-1.7 0-3-1.3-3-3 z" stroke-width="5" fill="#fff" fill-opacity="0.14"/>
      <!-- window line -->
      <path d="M29 42 h42" stroke-width="4"/>
      <!-- wheels -->
      <circle cx="31" cy="63" r="7.5" stroke-width="5" fill="${BLUE_DARK}"/>
      <circle cx="69" cy="63" r="7.5" stroke-width="5" fill="${BLUE_DARK}"/>
      <!-- lights -->
      <path d="M22.5 52 h6" stroke-width="4"/>
      <path d="M71.5 52 h6" stroke-width="4"/>
    </g>`;
}

/** Full-bleed square (iOS applies its own rounded mask). `scale` shrinks the mark for the maskable safe zone. */
function svg(size, { scale = 1 } = {}) {
  const s = scale;
  const offset = (100 - 100 * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${BLUE}"/>
        <stop offset="1" stop-color="${BLUE_DARK}"/>
      </linearGradient>
    </defs>
    <rect width="100" height="100" fill="url(#bg)"/>
    <g transform="translate(${offset} ${offset}) scale(${s})">${mark()}</g>
  </svg>`;
}

const targets = [
  { file: 'apple-touch-icon-180.png', size: 180, opts: { scale: 0.92 } },
  { file: 'icon-192.png', size: 192, opts: { scale: 0.92 } },
  { file: 'icon-512.png', size: 512, opts: { scale: 0.92 } },
  { file: 'icon-512-maskable.png', size: 512, opts: { scale: 0.72 } },
  { file: 'favicon-32.png', size: 32, opts: { scale: 1.1 } },
];

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  mkdirSync(outDir, { recursive: true });
  for (const t of targets) {
    await page.setViewportSize({ width: t.size, height: t.size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:${BLUE}">${svg(t.size, t.opts)}</body></html>`,
    );
    const png = await page.locator('svg').screenshot({ omitBackground: false, type: 'png' });
    writeFileSync(join(outDir, t.file), png);
    console.log(`wrote public/icons/${t.file} (${t.size}×${t.size}, ${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
