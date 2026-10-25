import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';

// Local layout checks only: no store, credentials, network APIs or paid models.
describe.skipIf(process.env.TRYORA_E2E !== '1')('adaptive assistant launcher', () => {
  let browser: Browser;
  let script: string;
  const css = readFileSync(resolve('extensions/tryora-theme/assets/tryora.css'), 'utf8');
  beforeAll(async () => {
    const result = await build({ stdin: { contents: 'import { avoidFloatingWidgets } from "./packages/storefront/src/assistant/launcher-position.ts"; window.startAvoidance = avoidFloatingWidgets;', resolveDir: resolve('..') }, bundle: true, write: false, format: 'iife' });
    script = result.outputFiles[0]!.text;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  it.each(['bottom-right', 'bottom-left'] as const)('moves and restores around late overlays on %s', async (side) => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    try {
      await page.setContent('<style>' + css + '</style><button class="tryora-assistant-launch tryora-assistant-launch--' + side + '" style="animation:none">Room Assistant</button>');
      await page.addScriptTag({ content: script });
      await page.evaluate(() => { (window as any).stopAvoidance = (window as any).startAvoidance(document.querySelector('button')); });
      const launcher = page.locator('button');
      const base = (await launcher.boundingBox())!;
      await page.evaluate((side) => {
        const widget = document.createElement('div'); widget.id = 'notification';
        widget.style.cssText = 'position:fixed;bottom:12px;width:260px;height:90px;background:red;' + (side === 'bottom-right' ? 'right' : 'left') + ':12px';
        document.body.append(widget);
      }, side);
      await expect.poll(async () => { const a = (await launcher.boundingBox())!; const b = (await page.locator('#notification').boundingBox())!; return b.y - a.y - a.height; }).toBeGreaterThanOrEqual(11);
      await page.locator('#notification').evaluate((el) => { (el as HTMLElement).style.height = '150px'; });
      await expect.poll(async () => { const a = (await launcher.boundingBox())!; return 638 - a.y - a.height; }).toBeGreaterThanOrEqual(11);
      // A full-width cookie bar and another chat bubble must both be avoided.
      await page.evaluate(() => { const bar = document.createElement('div'); bar.id = 'cookie'; bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:200px;background:blue'; document.body.append(bar); });
      await expect.poll(async () => { const a = (await launcher.boundingBox())!; return 600 - a.y - a.height; }).toBeGreaterThanOrEqual(11);
      await page.locator('#cookie').evaluate((el) => el.remove());
      await page.locator('#notification').evaluate((el) => { (el as HTMLElement).style.display = 'none'; });
      await expect.poll(async () => (await launcher.boundingBox())!.y).toBeCloseTo(base.y, 0);
      // Opposite corner and ordinary page content must not move this launcher.
      await page.locator('#notification').evaluate((el, side) => { const style = (el as HTMLElement).style; style.display = 'block'; style.left = side === 'bottom-right' ? '12px' : 'auto'; style.right = side === 'bottom-left' ? '12px' : 'auto'; }, side);
      await page.waitForTimeout(650);
      expect((await launcher.boundingBox())!.y).toBeCloseTo(base.y, 0);
      await page.locator('#notification').evaluate((el) => el.remove());
      // Preserve the existing Tryora preview stack and return to it after a mobile bar closes.
      await launcher.evaluate((el) => { el.classList.add('tryora-assistant-launch--stacked'); (el as HTMLElement).style.setProperty('--ta-stack', '56px'); });
      await page.setViewportSize({ width: 390, height: 700 });
      await page.waitForTimeout(650);
      const stacked = (await launcher.boundingBox())!;
      await page.evaluate(() => { const bar = document.createElement('iframe'); bar.id = 'mobile-bar'; bar.style.cssText = 'position:fixed;bottom:0;left:0;width:100%;height:120px;border:0'; document.body.append(bar); });
      await expect.poll(async () => { const a = (await launcher.boundingBox())!; return 580 - a.y - a.height; }).toBeGreaterThanOrEqual(11);
      await page.locator('#mobile-bar').evaluate((el) => el.remove());
      await expect.poll(async () => (await launcher.boundingBox())!.y).toBeCloseTo(stacked.y, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.evaluate(() => (window as any).stopAvoidance());
    } finally { await page.close(); }
  });
});
