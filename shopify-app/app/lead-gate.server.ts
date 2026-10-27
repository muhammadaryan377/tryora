import { createHash } from "node:crypto";
import prisma from "./db.server";
import { TryoraError } from "./core/index";

/**
 * Opt-in merchant lead gate. We retain only an opaque, per-shop visitor hash,
 * never the shopper's email or raw visitor identifier in this table.
 */
export type LeadChannel = "popup" | "assistant";
export type LeadMode = "off" | "required" | "skippable";
const VISIT_MS = 24 * 60 * 60 * 1000;

export function leadChannel(value: string): LeadChannel {
  if (value === "popup" || value === "assistant") return value;
  throw new TryoraError("BAD_REQUEST");
}

function visitorHash(shopId: string, visitorId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(visitorId)) throw new TryoraError("BAD_REQUEST");
  return createHash("sha256").update(shopId).update(":").update(visitorId).digest("hex");
}

export async function leadPolicy(shopId: string, channel: LeadChannel) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { leadCapture: true, leadTiming: true, leadSettings: true } });
  const settings = (shop?.leadSettings ?? {}) as { chatLeadCapture?: unknown };
  const chosen = channel === "assistant" ? settings.chatLeadCapture : shop?.leadCapture;
  const mode: LeadMode = chosen === "required" || chosen === "skippable" ? chosen : "off";
  const timing: "before" | "after" = shop?.leadTiming === "after" ? "after" : "before";
  return { mode, timing };
}

export async function markLeadCaptured(shopId: string, visitorId: string) {
  const hash = visitorHash(shopId, visitorId);
  // Email was saved for this visitor: do not require the same email in the other enabled experience.
  await prisma.$transaction(["popup", "assistant"].map(channel =>
    prisma.leadVisit.upsert({
      where: { shopId_visitorHash_channel: { shopId, visitorHash: hash, channel } },
      create: { shopId, visitorHash: hash, channel, satisfied: true },
      update: { satisfied: true },
    })));
}

export async function skipLead(shopId: string, visitorId: string, channel: LeadChannel) {
  const policy = await leadPolicy(shopId, channel);
  if (policy.mode !== "skippable") throw new TryoraError("LEAD_REQUIRED");
  const hash = visitorHash(shopId, visitorId);
  await prisma.leadVisit.upsert({
    where: { shopId_visitorHash_channel: { shopId, visitorHash: hash, channel } },
    create: { shopId, visitorHash: hash, channel, satisfied: true },
    update: { satisfied: true },
  });
  return { ok: true };
}

export async function leadVisitStatus(shopId: string, visitorId: string, channel: LeadChannel) {
  const policy = await leadPolicy(shopId, channel);
  if (policy.mode === "off") return { satisfied: true };
  const hash = visitorHash(shopId, visitorId);
  const state = await prisma.leadVisit.findUnique({
    where: { shopId_visitorHash_channel: { shopId, visitorHash: hash, channel } },
  });
  return { satisfied: !!state?.satisfied && state.updatedAt.getTime() >= Date.now() - VISIT_MS };
}

/**
 * Reserve an after-first-preview exception atomically. The untrusted leadDone
 * form field is deliberately ignored: email and Skip must be recorded server-side.
 * The returned rollback restores the exception if no preview job was created.
 */
export async function reserveLeadPermission(shopId: string, visitorId: string, channel: LeadChannel): Promise<() => Promise<void>> {
  const policy = await leadPolicy(shopId, channel);
  if (policy.mode === "off") return async () => {};
  const hash = visitorHash(shopId, visitorId);
  const where = { shopId_visitorHash_channel: { shopId, visitorHash: hash, channel } };
  const existing = await prisma.leadVisit.findUnique({ where });
  if (existing?.satisfied && existing.updatedAt.getTime() >= Date.now() - VISIT_MS) return async () => {};
  if (policy.timing !== "after") throw new TryoraError("LEAD_REQUIRED");
  await prisma.leadVisit.upsert({
    where,
    create: { shopId, visitorHash: hash, channel },
    update: {},
  });
  const claimed = await prisma.leadVisit.updateMany({
    where: { shopId, visitorHash: hash, channel, firstPreviewUsed: false, satisfied: false },
    data: { firstPreviewUsed: true },
  });
  if (claimed.count !== 1) throw new TryoraError("LEAD_REQUIRED");
  return async () => {
    await prisma.leadVisit.updateMany({
      where: { shopId, visitorHash: hash, channel, satisfied: false },
      data: { firstPreviewUsed: false },
    });
  };
}
