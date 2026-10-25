import { afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgeWithRetry, createWithRetry, decodePreview } from "../../packages/storefront/src/reliability";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("storefront delivery", () => {
  it("retries acknowledgements after transient errors", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ok: true });
    expect(await acknowledgeWithRetry(send, Date.now() + 1000, async () => {})).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("stops retrying on invalid tokens or expiration", async () => {
    const send = vi.fn().mockRejectedValue({ code: "BAD_TOKEN" });
    expect(await acknowledgeWithRetry(send, Date.now() + 1000)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    send.mockClear();
    expect(await acknowledgeWithRetry(send, Date.now())).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it("bounds transient retries by the delivery deadline", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const result = acknowledgeWithRetry(send, Date.now() + 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBe(false);
    expect(send.mock.calls.length).toBeLessThan(5);
  });
  it("does not consider corrupt images decoded", async () => {
    vi.stubGlobal("Image", class { src = ""; decode() { return Promise.reject(new Error("bad image")); } });
    await expect(decodePreview("blob:test")).rejects.toThrow("bad image");
  });
  it("retries preview creation with the same request and stops on business errors", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({ jobId: "same" });
    expect(await createWithRetry(send)).toEqual({ jobId: "same" });
    expect(send).toHaveBeenCalledTimes(2);
    const denied = vi.fn().mockRejectedValue({ code: "CREDITS_EXHAUSTED" });
    await expect(createWithRetry(denied)).rejects.toMatchObject({ code: "CREDITS_EXHAUSTED" });
    expect(denied).toHaveBeenCalledOnce();
  });
});


it("does not retry a cancelled preview request", async () => {
  const send = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
  await expect(createWithRetry(send)).rejects.toMatchObject({ name: "AbortError" });
  expect(send).toHaveBeenCalledTimes(1);
});
