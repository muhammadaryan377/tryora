import { beforeEach, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const state = vi.hoisted(() => ({
  auth: vi.fn(),
  remove: vi.fn(),
  linked: vi.fn(),
  previewUpdate: vi.fn(),
  quotaUpdate: vi.fn(),
  consentDelete: vi.fn(),
  requestDelete: vi.fn(),
  transaction: vi.fn(),
}));
const tx = {
  leadDelivery: { findMany: state.linked, deleteMany: state.remove },
  previewJob: { updateMany: state.previewUpdate },
  quotaUsage: { updateMany: state.quotaUpdate },
  consentRecord: { deleteMany: state.consentDelete },
  privacyRequest: { deleteMany: state.requestDelete },
};
vi.mock("../app/shopify.server", () => ({ authenticate: { webhook: state.auth } }));
vi.mock("../app/db.server", () => ({ default: {
  ...tx,
  $transaction: state.transaction,
} }));

import { action } from "../app/routes/webhooks.compliance";

beforeEach(() => {
  vi.clearAllMocks();
  state.linked.mockResolvedValue([]);
  state.remove.mockResolvedValue({ count: 1 });
  state.consentDelete.mockResolvedValue({ count: 0 });
  state.requestDelete.mockResolvedValue({ count: 0 });
  state.transaction.mockImplementation(async (work: (tx: typeof tx) => Promise<void>) => work(tx));
});

it("redacts retained email leads even when no Shopify customer was created", async () => {
  state.auth.mockResolvedValue({
    shop: "demo.myshopify.com",
    topic: "CUSTOMERS_REDACT",
    payload: { customer: { email: "Sam@example.com" } },
  });
  await action({ request: new Request("https://app.example/webhooks/compliance") } as ActionFunctionArgs);
  expect(state.linked).toHaveBeenCalledWith({
    where: {
      shopId: "demo.myshopify.com",
      OR: [{ email: { equals: "sam@example.com", mode: "insensitive" } }],
    },
    select: { customerRef: true, email: true },
  });
  expect(state.remove).toHaveBeenCalledWith({
    where: {
      shopId: "demo.myshopify.com",
      OR: [
        { email: { equals: "sam@example.com", mode: "insensitive" } },
        { email: { equals: "sam@example.com", mode: "insensitive" } },
      ],
    },
  });
  expect(state.consentDelete).toHaveBeenCalledTimes(1);
  expect(state.transaction).toHaveBeenCalledTimes(1);
});

it("does not delete any leads for an unidentifiable customer", async () => {
  state.auth.mockResolvedValue({
    shop: "demo.myshopify.com",
    topic: "CUSTOMERS_REDACT",
    payload: { customer: {} },
  });
  await action({ request: new Request("https://app.example/webhooks/compliance") } as ActionFunctionArgs);
  expect(state.remove).not.toHaveBeenCalled();
  expect(state.transaction).not.toHaveBeenCalled();
});
