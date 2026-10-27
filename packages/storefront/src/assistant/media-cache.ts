/** Tab-scoped, short-lived browser-only room media. Never put image bytes in sessionStorage or server DB. */
const NAME = "tryora-assistant-private-media-v1", STORE = "assets";
const TAB = "tryora-assistant-tab-id", TTL = 4 * 60 * 60_000;
let tab: string | null | undefined;
function key(shop: string, name: string): string | null {
  try {
    if (tab === undefined) {
      tab = sessionStorage.getItem(TAB);
      if (!tab) { tab = crypto.randomUUID(); sessionStorage.setItem(TAB, tab); }
    }
    return `${shop}:${tab}:${name}`;
  } catch { return null; }
}
async function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
type Saved = { key: string; blob: Blob; expires: number };
async function transact<T>(shop: string, name: string, mode: IDBTransactionMode, action: (store: IDBObjectStore, key: string, complete: (v: T) => void) => void, fallback: T): Promise<T> {
  const id = key(shop, name);
  if (!id) return fallback;
  const db = await database();
  if (!db) return fallback;
  try {
    return await new Promise(resolve => {
      let done = false;
      const complete = (value: T) => { if (!done) { done = true; resolve(value); } };
      try {
        const tx = db.transaction(STORE, mode);
        tx.onerror = () => complete(fallback);
        tx.onabort = () => complete(fallback);
        action(tx.objectStore(STORE), id, complete);
      } catch { complete(fallback); }
    });
  } finally { db.close(); }
}
export function saveMedia(shop: string, name: string, blob: Blob): Promise<boolean> {
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > 8 * 1024 * 1024) return Promise.resolve(false);
  return transact(shop, name, "readwrite", (store, id, done) => {
    const req = store.put({ key: id, blob, expires: Date.now() + TTL } satisfies Saved);
    req.onsuccess = () => done(true);
  }, false);
}
export function readMedia(shop: string, name: string): Promise<Blob | null> {
  return transact<Blob | null>(shop, name, "readonly", (store, id, done) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const v = req.result as Saved | undefined;
      done(v && v.expires > Date.now() && v.blob instanceof Blob ? v.blob : null);
    };
  }, null);
}
export function removeMedia(shop: string, name: string): Promise<void> {
  return transact<void>(shop, name, "readwrite", (store, id, done) => {
    const req = store.delete(id);
    req.onsuccess = () => done();
  }, undefined);
}
export function clearMedia(shop: string): Promise<void> {
  return transact<void>(shop, "", "readwrite", (store, id, done) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return done();
      if (typeof cursor.key === "string" && cursor.key.startsWith(id)) cursor.delete();
      cursor.continue();
    };
  }, undefined);
}

/** Opportunistically delete expired bytes whenever this shop's assistant starts again. */
export function pruneExpiredMedia(shop: string): Promise<void> {
  return transact<void>(shop, "", "readwrite", (store, id, done) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return done();
      const record = cursor.value as Saved | undefined;
      // Expired images from old closed tabs are also purged without exposing their content.
      if (!record || record.expires <= Date.now()) cursor.delete();
      cursor.continue();
    };
  }, undefined);
}
