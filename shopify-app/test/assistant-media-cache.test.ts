// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearMedia, readMedia, removeMedia, saveMedia } from "../../packages/storefront/src/assistant/media-cache";

function memoryDatabase() {
  const rows = new Map<string, unknown>();
  const store = {
    put(value: any) {
      const request: any = {};
      queueMicrotask(() => { rows.set(value.key, value); request.onsuccess?.(); });
      return request;
    },
    get(key: string) {
      const request: any = {};
      queueMicrotask(() => { request.result = rows.get(key); request.onsuccess?.(); });
      return request;
    },
    delete(key: string) {
      const request: any = {};
      queueMicrotask(() => { rows.delete(key); request.onsuccess?.(); });
      return request;
    },
    openCursor() {
      const request: any = {};
      const keys = [...rows.keys()];
      let i = 0;
      const tick = () => queueMicrotask(() => {
        const key = keys[i++];
        request.result = key === undefined ? null : {
          key, delete: () => { rows.delete(key); },
          continue: tick,
        };
        request.onsuccess?.();
      });
      tick();
      return request;
    },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    transaction: () => ({ objectStore: () => store }),
    close: vi.fn(),
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request: any = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  return rows;
}
beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("browser-only Room Assistant image restoration", () => {
  it("keeps binary photos tab- and shop-scoped without serialising bytes into sessionStorage", async () => {
    memoryDatabase();
    const original = new Blob(["secret image bytes"], { type: "image/jpeg" });
    expect(await saveMedia("sofa.myshopify.com", "room", original)).toBe(true);
    expect(await (await readMedia("sofa.myshopify.com", "room"))?.text()).toBe("secret image bytes");
    expect(await readMedia("another.myshopify.com", "room")).toBeNull();
    expect(JSON.stringify([...Array(sessionStorage.length)].map((_, n) => sessionStorage.key(n)))).not.toContain("secret image");
    await removeMedia("sofa.myshopify.com", "room");
    expect(await readMedia("sofa.myshopify.com", "room")).toBeNull();
  });

  it("deletes the whole tab's images on Clear Conversation without touching other stores", async () => {
    memoryDatabase();
    const binary = new Blob(["opaque"], { type: "image/jpeg" });
    await saveMedia("sofa.myshopify.com", "room", binary);
    await saveMedia("sofa.myshopify.com", "preview:p1", binary);
    await saveMedia("other.myshopify.com", "room", binary);
    await clearMedia("sofa.myshopify.com");
    expect(await readMedia("sofa.myshopify.com", "room")).toBeNull();
    expect(await readMedia("sofa.myshopify.com", "preview:p1")).toBeNull();
    expect(await readMedia("other.myshopify.com", "room")).not.toBeNull();
  });

  it("treats browser storage denial as unavailable rather than breaking preview generation", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("storage denied"); } });
    const image = new Blob(["photo"], { type: "image/jpeg" });
    await expect(saveMedia("sofa.myshopify.com", "room", image)).resolves.toBe(false);
    await expect(readMedia("sofa.myshopify.com", "room")).resolves.toBeNull();
  });
});
