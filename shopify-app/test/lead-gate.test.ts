import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  shop: { leadCapture: "off", leadTiming: "before", leadSettings: {} as Record<string, unknown> },
  visits: new Map<string, any>(),
}));
const keyOf = (input: { shopId: string; visitorHash: string; channel: string }) =>
  [input.shopId, input.visitorHash, input.channel].join(":");

vi.mock("../app/db.server", () => ({ default: {
  shop: { findUnique: vi.fn(async () => fixture.shop) },
  leadVisit: {
    findUnique: vi.fn(async ({ where }) => fixture.visits.get(keyOf(where.shopId_visitorHash_channel)) ?? null),
    upsert: vi.fn(async ({ where, create, update }) => {
      const key = keyOf(where.shopId_visitorHash_channel);
      const current = fixture.visits.get(key);
      const value = { satisfied: false, firstPreviewUsed: false, ...(current ?? create), ...(current ? update : {}), updatedAt: new Date() };
      fixture.visits.set(key, value);
      return value;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      let count = 0;
      for (const [key, record] of fixture.visits) {
        if (record.shopId !== where.shopId || record.visitorHash !== where.visitorHash || record.channel !== where.channel) continue;
        if (where.firstPreviewUsed !== undefined && record.firstPreviewUsed !== where.firstPreviewUsed) continue;
        if (where.satisfied !== undefined && record.satisfied !== where.satisfied) continue;
        fixture.visits.set(key, { ...record, ...data, updatedAt: new Date() });
        count++;
      }
      return { count };
    }),
  },
  $transaction: async (queries: Promise<any>[]) => Promise.all(queries),
} }));

import { leadPolicy, leadVisitStatus, markLeadCaptured, reserveLeadPermission, skipLead } from "../app/lead-gate.server";

const shop = "demo.myshopify.com";
const visitor = "123e4567-e89b-42d3-a456-426614174000";
beforeEach(() => {
  fixture.visits.clear();
  fixture.shop = { leadCapture: "off", leadTiming: "before", leadSettings: {} };
});

describe("independent lead capture", () => {
  it("defaults both experiences to off and preserves an enabled popup when chat is off", async () => {
    expect((await leadPolicy(shop, "popup")).mode).toBe("off");
    expect((await leadPolicy(shop, "assistant")).mode).toBe("off");
    fixture.shop.leadCapture = "required";
    expect((await leadPolicy(shop, "popup")).mode).toBe("required");
    expect((await leadPolicy(shop, "assistant")).mode).toBe("off");
    fixture.shop.leadSettings = { chatLeadCapture: "skippable" };
    expect((await leadPolicy(shop, "assistant")).mode).toBe("skippable");
  });

  it("requires real server lead proof for a required first preview", async () => {
    fixture.shop.leadSettings = { chatLeadCapture: "required" };
    await expect(reserveLeadPermission(shop, visitor, "assistant")).rejects.toThrow();
    await markLeadCaptured(shop, visitor);
    const release = await reserveLeadPermission(shop, visitor, "assistant");
    expect(await leadVisitStatus(shop, visitor, "assistant")).toEqual({ satisfied: true });
    await release();
    expect((await leadPolicy(shop, "popup")).mode).toBe("off");
    expect(fixture.visits).toHaveProperty("size", 2);
  });

  it("allows one initial after-preview exception and no second until proof is saved", async () => {
    fixture.shop.leadTiming = "after";
    fixture.shop.leadSettings = { chatLeadCapture: "required" };
    const release = await reserveLeadPermission(shop, visitor, "assistant");
    await expect(reserveLeadPermission(shop, visitor, "assistant")).rejects.toThrow();
    await release();
    await reserveLeadPermission(shop, visitor, "assistant");
    await markLeadCaptured(shop, visitor);
    expect(await leadVisitStatus(shop, visitor, "assistant")).toEqual({ satisfied: true });
    await reserveLeadPermission(shop, visitor, "assistant");
  });

  it("accepts Skip only for an enabled skippable experience, not a required channel", async () => {
    fixture.shop.leadCapture = "required";
    fixture.shop.leadSettings = { chatLeadCapture: "skippable" };
    await expect(skipLead(shop, visitor, "popup")).rejects.toThrow();
    expect(await skipLead(shop, visitor, "assistant")).toEqual({ ok: true });
    expect(await leadVisitStatus(shop, visitor, "assistant")).toEqual({ satisfied: true });
    expect(await leadVisitStatus(shop, visitor, "popup")).toEqual({ satisfied: false });
  });

  it("does not trust empty or malformed visitor identifiers", async () => {
    fixture.shop.leadCapture = "required";
    await expect(markLeadCaptured(shop, "x")).rejects.toThrow();
    await expect(skipLead(shop, "", "popup")).rejects.toThrow();
  });
});
