import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
describe("memory-only worker routing", () => {
  it("routes to operator-configured owners with authentication and bounded requests", async () => {
    vi.stubEnv("TRYORA_WORKER_ID", "a");
    vi.stubEnv("TRYORA_WORKER_ORIGINS", JSON.stringify({ a: "http://worker-a:3000", b: "http://worker-b:3000" }));
    vi.stubEnv("TRYORA_WORKER_SECRET", "s".repeat(32));
    const fetcher = vi.fn().mockResolvedValue(Response.json({ stage: "ready" }));
    vi.stubGlobal("fetch", fetcher);
    const { remoteJob, workerAuthorised } = await import("../app/preview-worker.server");
    expect(await remoteJob("poll", "shop", "a_incarnation__job")).toBeUndefined();
    expect(await remoteJob("poll", "shop", "b_incarnation__job")).toEqual({ stage: "ready" });
    expect(fetcher).toHaveBeenCalledWith(new URL("http://worker-b:3000/internal/tryora-worker"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${"s".repeat(32)}` }), signal: expect.any(AbortSignal) }));
    expect(workerAuthorised(null)).toBe(false);
    expect(workerAuthorised("Bearer bad")).toBe(false);
    expect(workerAuthorised(`Bearer ${"s".repeat(32)}`)).toBe(true);
    await expect(remoteJob("poll", "shop", "evil_incarnation__job")).rejects.toThrow("unavailable");
  });
  it("rejects insecure routing configuration", async () => {
    vi.stubEnv("TRYORA_WORKER_ID", "a");
    vi.stubEnv("TRYORA_WORKER_ORIGINS", '{"a":"http://worker-a"}');
    vi.stubEnv("TRYORA_WORKER_SECRET", "short");
    await expect(import("../app/preview-worker.server")).rejects.toThrow("shared secret");
  });
});
