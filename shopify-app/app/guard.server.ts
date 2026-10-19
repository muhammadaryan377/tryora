import prisma from "./db.server";
import { TryoraError } from "./core/index";

/**
 * Protects merchants' credits from bots and abuse (owner decision, 19 Oct 2026).
 *  - Each shopper (browser) can start at most 10 previews and 30 photo checks an hour.
 *  - Each store accepts at most 40 new previews in any 10 minutes; a burst beyond that is refused and flagged in the admin.
 *  - Each store has a daily cap on new previews (30 by default, merchant can change or turn it off).
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
const HOUR = 3_600_000;

export function guardPhotoCheck(shopId: string, visitorId: string) {
  if (!VISITOR.test(visitorId)) throw new TryoraError("RATE_LIMITED", "Missing visitor");
  if (!hit(`check:${shopId}:${visitorId}`, 30, HOUR)) throw new TryoraError("RATE_LIMITED");
  if (!hit(`check-shop:${shopId}`, 300, 10 * 60_000)) throw new TryoraError("RATE_LIMITED");
}

export async function guardPreview(shopId: string, visitorId: string) {
  if (!VISITOR.test(visitorId)) throw new TryoraError("RATE_LIMITED", "Missing visitor");
  if (!hit(`preview:${shopId}:${visitorId}`, 10, HOUR)) throw new TryoraError("RATE_LIMITED");
  if (!hit(`preview-shop:${shopId}`, 40, 10 * 60_000)) {
    await prisma.shop.update({ where: { id: shopId }, data: { abuseAlertAt: new Date() } }).catch(() => {});
    throw new TryoraError("RATE_LIMITED", "Unusual burst");
  }
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { dailyPreviewCap: true } });
  if (shop?.dailyPreviewCap != null) {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const today = await prisma.previewJob.count({
      where: { shopId, createdAt: { gte: dayStart }, state: { notIn: ["FAILED", "REJECTED", "CANCELLED", "EXPIRED"] } },
    });
    if (today >= shop.dailyPreviewCap) throw new TryoraError("DAILY_CAP");
  }
}
