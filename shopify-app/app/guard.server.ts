import prisma from "./db.server";
import { TryoraError } from "./core/index";

/**
 * Protects merchants' credits from bots (owner decision, 19 Oct 2026). Shopper limits themselves are the merchant's
 * setting (Shopper limits page, 10 a day by default). On top of that, only a safety net against automated abuse:
 *  - a store accepts at most 40 new previews in any 10 minutes; a burst beyond that is refused for a few minutes and
 *    shown to the merchant as a warning on the Tryora Home page;
 *  - photo checks are capped at 300 per store per 10 minutes (they cost us, not the merchant).
 * Counters are in memory: fine for one server; move to the database or Redis if we run several.
 */

const windows = new Map<string, number[]>();

function hit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const list = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    windows.set(key, list);
    return false;
  }
  list.push(now);
  windows.set(key, list);
  return true;
}

// Keep memory bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of windows) if (!v.some((t) => now - t < 3_600_000)) windows.delete(k);
}, 600_000).unref();

const VISITOR = /^[0-9a-f-]{36}$/i;

export function guardPhotoCheck(shopId: string, visitorId: string) {
  if (!VISITOR.test(visitorId)) throw new TryoraError("RATE_LIMITED", "Missing visitor");
  if (!hit(`check-shop:${shopId}`, 300, 10 * 60_000)) throw new TryoraError("RATE_LIMITED");
}

export async function guardPreview(shopId: string, visitorId: string) {
  if (!VISITOR.test(visitorId)) throw new TryoraError("RATE_LIMITED", "Missing visitor");
  if (!hit(`preview-shop:${shopId}`, 40, 10 * 60_000)) {
    await prisma.shop.update({ where: { id: shopId }, data: { abuseAlertAt: new Date() } }).catch(() => {});
    throw new TryoraError("RATE_LIMITED", "Unusual burst");
  }
}

/** Assistant messages can call a paid model but never reserve or consume preview credits. */
export function guardAssistant(shopId: string, visitorId: string) {
  if (!VISITOR.test(visitorId)) throw new TryoraError("RATE_LIMITED", "Missing visitor");
  if (!hit(`assistant-visitor:${shopId}:${visitorId}`, 20, 10 * 60_000) ||
      !hit(`assistant-shop:${shopId}`, 200, 10 * 60_000)) {
    throw new TryoraError("RATE_LIMITED");
  }
}
