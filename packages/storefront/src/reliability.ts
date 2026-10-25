export async function acknowledgeWithRetry(
  send: () => Promise<unknown>,
  expiresAt: number,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  let delay = 500;
  while (Date.now() < expiresAt) {
    try { await send(); return true; }
    catch (e: any) {
      if (["BAD_TOKEN", "INVALID_TRANSITION", "NOT_FOUND"].includes(e?.code)) return false;
      await wait(Math.min(delay, Math.max(0, expiresAt - Date.now())));
      delay = Math.min(delay * 2, 10_000);
    }
  }
  return false;
}

/** Decode before publishing a result to the flow or acknowledging its delivery. */
export async function decodePreview(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  await image.decode();
}

export async function createWithRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await send(); }
    catch (e: any) {
      if (e?.name === "AbortError" || attempt >= 2 || (e?.code && e.code !== "REQUEST_FAILED")) throw e;
    }
  }
}
