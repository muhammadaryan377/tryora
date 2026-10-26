import { beforeEach, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
const state = vi.hoisted(() => ({ auth: vi.fn(), remove: vi.fn(), transaction: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { webhook: state.auth } }));
vi.mock("../app/db.server", () => ({ default: {
  leadDelivery: { deleteMany: state.remove }, $transaction: state.transaction,
  previewJob: { updateMany: vi.fn() }, quotaUsage: { updateMany: vi.fn() }, consentRecord: { deleteMany: vi.fn() },
} }));
import { action } from "../app/routes/webhooks.compliance";
beforeEach(() => vi.clearAllMocks());
it("redacts retained email leads even when no Shopify customer was created", async () => {
  state.auth.mockResolvedValue({ shop: "demo.myshopify.com", topic: "CUSTOMERS_REDACT", payload: { customer: { email: "Sam@example.com" } } });
  await action({ request: new Request("https://app.example/webhooks/compliance") } as ActionFunctionArgs);
  expect(state.remove).toHaveBeenCalledWith({ where: { shopId: "demo.myshopify.com", OR: [{ email: { equals: "Sam@example.com", mode: "insensitive" } }] } });
  expect(state.transaction).toHaveBeenCalledTimes(1);
});
it("does not delete any leads for an unidentifiable customer", async () => {
  state.auth.mockResolvedValue({ shop: "demo.myshopify.com", topic: "CUSTOMERS_REDACT", payload: { customer: {} } });
  await action({ request: new Request("https://app.example/webhooks/compliance") } as ActionFunctionArgs);
  expect(state.remove).not.toHaveBeenCalled();
});
