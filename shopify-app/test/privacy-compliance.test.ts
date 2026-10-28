import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const tx = {
    leadDelivery: { findMany: vi.fn(), deleteMany: vi.fn() },
    previewJob: { updateMany: vi.fn() },
    quotaUsage: { updateMany: vi.fn() },
    consentRecord: { deleteMany: vi.fn(), findMany: vi.fn() },
    privacyRequest: { deleteMany: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    shop: { deleteMany: vi.fn() },
    session: { deleteMany: vi.fn() },
  };
  const fixture = {
    shop: "store-one.myshopify.com",
    topic: "CUSTOMERS_REDACT",
    payload: { customer: { id: null as number | null, email: "Buyer@Example.com" } } as any,
    tx,
  };
  return fixture;
});

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(async () => ({ shop: state.shop, topic: state.topic, payload: state.payload })),
    admin: vi.fn(async () => ({ session: { shop: state.shop } })),
  },
}));
vi.mock("../app/db.server", () => ({ default: {
  ...state.tx,
  $transaction: vi.fn(async (arg: unknown) => typeof arg === "function" ? (arg as any)(state.tx) : Promise.all(arg as Promise<unknown>[])),
} }));

import { action as webhook } from "../app/routes/webhooks.compliance";
import { exportShopifyDataRequest, privacySubject } from "../app/privacy.server";
import prisma from "../app/db.server";

const request = () => ({ request: new Request("https://visully.test/webhooks/compliance", { method: "POST" }) } as any);

beforeEach(() => {
  vi.clearAllMocks();
  state.shop = "store-one.myshopify.com";
  state.topic = "CUSTOMERS_REDACT";
  state.payload = { customer: { id: null, email: "Buyer@Example.com" } };
  state.tx.leadDelivery.findMany.mockResolvedValue([{ customerRef: "gid://shopify/Customer/98" }]);
  state.tx.leadDelivery.deleteMany.mockResolvedValue({ count: 1 });
  state.tx.previewJob.updateMany.mockResolvedValue({ count: 1 });
  state.tx.quotaUsage.updateMany.mockResolvedValue({ count: 1 });
  state.tx.consentRecord.deleteMany.mockResolvedValue({ count: 1 });
  state.tx.privacyRequest.deleteMany.mockResolvedValue({ count: 1 });
  state.tx.privacyRequest.upsert.mockResolvedValue({});
  state.tx.privacyRequest.update.mockResolvedValue({});
  state.tx.privacyRequest.findUnique.mockResolvedValue({
    requestId: "123", shopId: state.shop, customerId: "98", email: "buyer@example.com",
  });
  state.tx.consentRecord.findMany.mockResolvedValue([]);
  state.tx.shop.deleteMany.mockResolvedValue({ count: 1 });
  state.tx.session.deleteMany.mockResolvedValue({ count: 1 });
});

describe("Shopify privacy subject resolution", () => {
  it("matches only valid Shopify IDs and normalized email subjects", () => {
    const subject = privacySubject({ id: 98, email: " Buyer@Example.com " });
    expect(subject.ids).toEqual(["98", "gid://shopify/Customer/98"]);
    expect(subject.email).toBe("buyer@example.com");
    expect(subject.or).toHaveLength(2);
    expect(subject.consentSubjects).toContain("gid://shopify/Customer/98");
    expect(subject.consentSubjects).toContain("buyer@example.com");
  });
  it("does not generate a broad-match selector without valid customer identifiers", () => {
    expect(privacySubject({ id: "../../", email: "not-an-email" }).or).toEqual([]);
  });
});

describe("mandatory compliance webhook", () => {
  it("records and deduplicates Shopify data requests scoped to the webhook's authenticated shop", async () => {
    state.topic = "CUSTOMERS_DATA_REQUEST";
    state.payload = { customer: { id: 98, email: "Buyer@Example.com" }, data_request: { id: 777 } };
    const response = await webhook(request());
    expect(response.status).toBe(200);
    expect(state.tx.privacyRequest.upsert).toHaveBeenCalledWith({
      where: { shopId_requestId: { shopId: state.shop, requestId: "777" } },
      create: { shopId: state.shop, requestId: "777", customerId: "98", email: "buyer@example.com" },
      update: {},
    });
    expect(state.tx.leadDelivery.deleteMany).not.toHaveBeenCalled();
  });

  it("resolves a linked Shopify customer ID during email-only redaction", async () => {
    state.payload = { customer: { email: "Buyer@Example.com" } };
    await webhook(request());
    expect(state.tx.leadDelivery.findMany).toHaveBeenCalledWith({
      where: { shopId: state.shop, OR: [{ email: { equals: "buyer@example.com", mode: "insensitive" } }] },
      select: { customerRef: true },
    });
    expect(state.tx.previewJob.updateMany).toHaveBeenCalledWith({
      where: { shopId: state.shop, verifiedCustomerId: { in: ["gid://shopify/Customer/98"] } },
      data: { verifiedCustomerId: null },
    });
    expect(state.tx.quotaUsage.updateMany).toHaveBeenCalledTimes(1);
    expect(state.tx.consentRecord.deleteMany).toHaveBeenCalledWith({
      where: { shopId: state.shop, subjectRef: { in: expect.arrayContaining(["gid://shopify/Customer/98"]) } },
    });
    expect(state.tx.privacyRequest.deleteMany).toHaveBeenCalledWith({
      where: { shopId: state.shop, OR: [
        { email: { equals: "buyer@example.com", mode: "insensitive" } },
      ] },
    });
  });

  it("never deletes all leads when Shopify supplies no valid subject", async () => {
    state.payload = { customer: {} };
    const response = await webhook(request());
    expect(response.status).toBe(200);
    expect(state.tx.leadDelivery.deleteMany).not.toHaveBeenCalled();
    expect(state.tx.consentRecord.deleteMany).not.toHaveBeenCalled();
  });

  it("clears a removed shop's owned records and sessions through database cascades", async () => {
    state.topic = "SHOP_REDACT";
    const response = await webhook(request());
    expect(response.status).toBe(200);
    expect(state.tx.shop.deleteMany).toHaveBeenCalledWith({ where: { id: state.shop } });
    expect(state.tx.session.deleteMany).toHaveBeenCalledWith({ where: { shop: state.shop } });
  });
});

describe("authenticated merchant data export", () => {
  it("requires shop-scoped matching request ID and does not query another shop", async () => {
    const result = await exportShopifyDataRequest(state.shop, "123");
    expect(result.customer).toEqual({ id: "98", email: "buyer@example.com" });
    expect(state.tx.privacyRequest.findUnique).toHaveBeenCalledWith({
      where: { shopId_requestId: { shopId: state.shop, requestId: "123" } },
    });
    expect(state.tx.leadDelivery.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ shopId: state.shop }),
    }));
    expect(state.tx.privacyRequest.update).toHaveBeenCalledWith({
      where: { shopId_requestId: { shopId: state.shop, requestId: "123" } },
      data: { status: "exported", exportedAt: expect.any(Date) },
    });
  });

  it("rejects unknown requests and refuses incomplete oversized exports", async () => {
    state.tx.privacyRequest.findUnique.mockResolvedValueOnce(null);
    await expect(exportShopifyDataRequest(state.shop, "123")).rejects.toThrow("not found");
    state.tx.leadDelivery.findMany.mockResolvedValueOnce(Array.from({ length: 1001 }, () => ({})));
    await expect(exportShopifyDataRequest(state.shop, "123")).rejects.toThrow("Large data request");
    expect(state.tx.privacyRequest.update).not.toHaveBeenCalled();
  });

  it("rejects invalid request IDs before any database lookup", async () => {
    await expect(exportShopifyDataRequest(state.shop, "../1")).rejects.toThrow("Invalid");
    expect(prisma.privacyRequest.findUnique).not.toHaveBeenCalled();
  });
});
