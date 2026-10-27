import { afterEach, expect, it, vi } from "vitest";
import { sendSupportMessage } from "../app/support.server";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const input = { shop: "test.myshopify.com", email: "merchant@example.com", message: "Please help with setup." };

it("does not claim delivery when email is unconfigured", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(sendSupportMessage(input)).rejects.toThrow("not configured");
  expect(fetch).not.toHaveBeenCalled();
});

it("sends to the fixed support inbox with the merchant as reply-to", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("SUPPORT_FROM_EMAIL", "Tryora <support@visully.io>");
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  await sendSupportMessage(input);
  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  expect(payload.to).toEqual(["support@visully.io"]);
  expect(payload.reply_to).toBe(input.email);
  expect(payload.text).toContain(input.message);
});

it("reports provider rejection as a failure", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("SUPPORT_FROM_EMAIL", "support@visully.io");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  await expect(sendSupportMessage(input)).rejects.toThrow("delivery failed");
});
