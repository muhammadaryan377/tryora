import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFixture, shopId, productId } from "./fixtures/provider-mapping";

const state = vi.hoisted(() => ({ admin: null as any, saved: [] as any[], create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), authenticate: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: state.authenticate } }));
vi.mock("../app/db.server", () => {
  const db = { shop: { upsert: vi.fn(async () => ({})) }, customizationConfig: {
    findMany: vi.fn(async () => state.saved), create: state.create, updateMany: state.updateMany, deleteMany: state.deleteMany,
  } };
  return { default: { ...db, $transaction: async (fn: any) => fn(db) } };
});
import { action, loader } from "../app/routes/app.customization";

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true");
  state.admin = providerFixture().context.admin; state.saved = [];
  state.authenticate.mockResolvedValue({ admin: state.admin, session: { shop: shopId } });
  state.create.mockResolvedValue({}); state.updateMany.mockResolvedValue({ count: 1 }); state.deleteMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllEnvs());
function request(fields: Record<string, string>, product = productId) {
  return new Request(`https://tryora.example/app/customization${product ? `?product=${encodeURIComponent(product)}` : ""}`,
    { method: "POST", body: new URLSearchParams({ revision: "", intent: "save", ...fields }) });
}
const act = (r: Request) => action({ request: r } as any);
describe("authenticated merchant provider configuration", () => {
  it("saves Cloudlift as Needs setup without marking it active", async () => {
    const result = await act(request({ provider: "cloudlift" }, ""));
    expect(result).toBeInstanceOf(Response);
    expect(state.create.mock.calls[0]?.[0].data).toMatchObject({ shopId, productId: "__store__", providerId: "cloudlift", active: false });
    const view = await loader({ request: new Request("https://tryora.example/app/customization") } as any);
    expect(view.enabled).toBe(true);
  });
  it("activates a Cloudlift native-linked profile only with a reviewed Shopify mapping", async () => {
    const { mapping } = providerFixture();
    const response = await act(request({ provider: "cloudlift", intent: "activate", reviewed: "yes", mapping: JSON.stringify(mapping) }));
    expect(response).toBeInstanceOf(Response);
    expect(state.create.mock.calls[0]?.[0].data).toMatchObject({ shopId, productId, providerId: "cloudlift", active: true });
  });

  it("validates complete product evidence before manual activation", async () => {
    const { mapping } = providerFixture();
    const response = await act(request({ provider: "manual_mapping", intent: "activate", reviewed: "yes", mapping: JSON.stringify(mapping) }));
    expect(response).toBeInstanceOf(Response);
    expect(state.create.mock.calls[0]?.[0].data).toMatchObject({ shopId, productId, providerId: "manual_mapping", active: true });
  });
  it("saves a reviewed native profile as inactive until explicitly activated", async () => {
    await act(request({ provider: "manual_mapping", mapping: JSON.stringify(providerFixture().mapping) }));
    expect(state.create.mock.calls[0]?.[0].data.active).toBe(false);
  });
  it.each(["cross-tenant", "missing-reference", "missing-review", "malformed", "unsupported-activate"])("does not save %s", async (kind) => {
    const { mapping, media } = providerFixture();
    const fields: Record<string, string> = { provider: "manual_mapping", intent: "activate", reviewed: "yes", mapping: "" };
    if (kind === "cross-tenant") mapping.shopId = "other.myshopify.com";
    if (kind === "missing-reference") mapping.entries[0]!.referenceMediaIds = ["gid://shopify/MediaImage/999"];
    if (kind === "missing-review") delete fields.reviewed;
    if (kind === "unsupported-activate") fields.provider = "unsupported";
    fields.mapping = kind === "malformed" ? "not-json" : JSON.stringify(mapping);
    const response = await act(request(fields));
    expect(response).toHaveProperty("error");
    expect(state.create).not.toHaveBeenCalled(); expect(state.updateMany).not.toHaveBeenCalled();
  });
  it("uses optimistic revisions scoped to the authenticated tenant and product", async () => {
    state.updateMany.mockResolvedValue({ count: 0 });
    const result = await act(request({ provider: "shopify_native", revision: "old" }));
    expect(result).toHaveProperty("error");
    expect(state.updateMany.mock.calls[0]?.[0].where).toEqual({ shopId, productId, revision: "old" });
  });
  it("does not access provider persistence when opt-in is disabled", async () => {
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "false");
    await expect(act(request({ provider: "cloudlift" }))).rejects.toMatchObject({ status: 503 });
    expect(state.create).not.toHaveBeenCalled();
  });
  it("requires authentication and checks product ownership before saving", async () => {
    state.authenticate.mockRejectedValue(new Response("Unauthorized", { status: 401 }));
    await expect(act(request({ provider: "shopify_native" }))).rejects.toMatchObject({ status: 401 });
    state.authenticate.mockResolvedValue({ admin: { graphql: async () => Response.json({ data: { product: null } }) }, session: { shop: shopId } });
    await expect(act(request({ provider: "shopify_native" }))).rejects.toMatchObject({ status: 404 });
    expect(state.create).not.toHaveBeenCalled();
  });
  it("rejects arbitrary provider IDs and oversized request bodies", async () => {
    expect(await act(request({ provider: "unregistered-provider" }))).toHaveProperty("error");
    await expect(act(request({ provider: "manual_mapping", mapping: "x".repeat(1_600_001) }))).rejects.toMatchObject({ status: 413 });
    expect(state.create).not.toHaveBeenCalled();
  });
});
