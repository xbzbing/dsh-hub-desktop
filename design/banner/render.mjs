// Render design/banner/banner*.html to PNG at 1280x640 (and a 2x variant).
// Usage: node design/banner/render.mjs
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pages = [
  { html: 'banner.html', name: 'dsh-hub-desktop-banner-en' },
  { html: 'banner.zh.html', name: 'dsh-hub-desktop-banner-zh' },
];

const browser = await chromium.launch();
try {
  for (const { html, name } of pages) {
    for (const scale of [1, 2]) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 640 },
        deviceScaleFactor: scale,
      });
      const tab = await context.newPage();
      await tab.goto('file://' + path.join(here, html));
      await tab.waitForLoadState('networkidle');
      const out = scale === 1
        ? path.join(here, `${name}.png`)
        : path.join(here, `${name}@2x.png`);
      await tab.screenshot({ path: out });
      console.log('wrote', out);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
