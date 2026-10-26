import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
const state = vi.hoisted(() => ({ count: vi.fn(), rows: vi.fn(), auth: vi.fn(), settingsUpdate: vi.fn(), shopUpdate: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: state.auth } }));
vi.mock("../app/tryora.server", () => ({ tryora: { ensureSettings: async () => ({ shopId: "demo.myshopify.com", leadCapture: "required" }), updateSettings: state.settingsUpdate } }));
vi.mock("../app/db.server", () => ({ default: {
  shop: { findUnique: async () => ({ leadSettings: { customerTag: "tryora-lead" } }), update: state.shopUpdate },
  campaign: { findFirst: async () => null, create: vi.fn() }, leadDelivery: { count: state.count, findMany: state.rows },
} }));
import { action, loader } from "../app/routes/app.leads";
const request = () => ({ request: new Request("https://app.example/app/leads") } as LoaderFunctionArgs);
beforeEach(() => { vi.clearAllMocks(); state.auth.mockResolvedValue({ session: { shop: "demo.myshopify.com" } }); state.count.mockResolvedValue(0); state.rows.mockResolvedValue([]); });

describe("merchant lead dashboard", () => {
  it("shows locally retained contacts even if Shopify customer sync failed, scoped to the authenticated shop", async () => {
    state.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    state.rows.mockResolvedValue([{ id: "lead-1", email: "shopper@example.com", firstName: "Sam", marketingOptIn: false, customerRef: null, status: "failed", createdAt: new Date() }]);
    const data = await loader(request());
    expect(data).toMatchObject({ leadsTotal: 3, leadsFailed: 2, leadsPending: 1, consentFailed: 1 });
    expect(data.leads[0]).toMatchObject({ email: "shopper@example.com", firstName: "Sam", status: "failed" });
    expect(state.count.mock.calls[0][0].where).toEqual({ shopId: "demo.myshopify.com", OR: [{ email: { not: null } }, { customerRef: { not: null } }] });
    expect(state.rows.mock.calls[0][0].where).toEqual({ shopId: "demo.myshopify.com" });
  });
  it("paginates bounded results without losing Shopify embedded context", async () => {
    state.rows.mockResolvedValue(Array.from({ length: 51 }, (_, i) => ({ id: `lead-${i}` })));
    const data = await loader({ request: new Request("https://app.example/app/leads?host=encoded&before=previous") } as LoaderFunctionArgs);
    expect(data.leads).toHaveLength(50);
    expect(data.olderUrl).toBe("/app/leads?host=encoded&before=lead-49");
    expect(state.rows.mock.calls[0][0]).toMatchObject({ take: 51, cursor: { id: "previous" }, skip: 1, where: { shopId: "demo.myshopify.com" } });
  });
  it("requires authentication before reading contacts", async () => {
    state.auth.mockRejectedValue(new Error("unauthorized"));
    await expect(loader(request())).rejects.toThrow("unauthorized");
    expect(state.rows).not.toHaveBeenCalled();
  });
  it("saves the merchant's Off choice without deleting existing leads", async () => {
    const form = new URLSearchParams({ leadCapture: "off", leadTiming: "before", customerTag: "tryora-lead", optInWording: "Send me offers" });
    const data = await action({ request: new Request("https://app.example/app/leads", { method: "POST", body: form }) } as ActionFunctionArgs);
    expect(data.ok).toBe(true);
    expect(state.settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ leadCapture: "off" }));
  });
});
