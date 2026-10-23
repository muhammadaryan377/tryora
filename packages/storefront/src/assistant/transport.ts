/**
 * Streams Room Assistant turns from the Tryora server through the Shopify app proxy.
 *
 * "poll" (default): POST starts a server-side turn, then GET long-polls its event buffer. Each poll returns as soon
 * as new events exist, so model text arrives incrementally even if the proxy buffers every response.
 * "sse": one POST whose response is an event stream. If the stream breaks after the turn started, reading resumes
 * by polling the same turn from the last event received, so nothing is lost or duplicated.
 */

export const PROXY = "/apps/tryora";
const POLL_TIMEOUT_MS = 20_000;
const MAX_RECONNECTS = 4;

export interface TurnEvent { type: string; [key: string]: any }

export class TurnError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface TurnOptions {
  transport: "poll" | "sse";
  visitor: string;
  signal: AbortSignal;
  onEvent: (event: TurnEvent) => void;
  onUploadProgress?: (fraction: number) => void;
}

const TERMINAL = new Set(["done", "error", "cancelled"]);

/** AbortSignal.any is missing before Safari 17.4. */
export function anySignal(...signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as any).any === "function") return (AbortSignal as any).any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(); break; }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

const timeoutSignal = (ms: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
};
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

/** POST with real upload progress when a photo is attached (fetch cannot report upload progress). */
function postForm(url: string, form: FormData, signal: AbortSignal, onProgress?: (fraction: number) => void): Promise<any> {
  if (!onProgress || typeof XMLHttpRequest === "undefined") {
    return fetch(url, { method: "POST", body: form, credentials: "same-origin", signal }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new TurnError(body.error ?? "REQUEST_FAILED");
      return body;
    }, (error) => { throw signal.aborted ? error : new TurnError("NETWORK"); });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let body: any = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(body); }
      else reject(new TurnError(body.error ?? "REQUEST_FAILED"));
    };
    xhr.onerror = () => reject(new TurnError("NETWORK"));
    xhr.ontimeout = () => reject(new TurnError("NETWORK"));
    signal.addEventListener("abort", () => { xhr.abort(); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    xhr.send(form);
  });
}

/** Reads a turn's events from index `after` until a terminal event, reconnecting through brief network drops. */
async function pollTurn(turnId: string, after: number, options: TurnOptions): Promise<void> {
  let next = after;
  let failures = 0;
  const aborted = () => { if (options.signal.aborted) throw new DOMException("Aborted", "AbortError"); };
  for (;;) {
    aborted();
    let body: any;
    try {
      const response = await fetch(`${PROXY}/assistant/turn/${encodeURIComponent(turnId)}?visitor=${encodeURIComponent(options.visitor)}&after=${next}`, {
        credentials: "same-origin",
        signal: anySignal(options.signal, timeoutSignal(POLL_TIMEOUT_MS)),
      });
      body = await response.json().catch(() => ({}));
      if (response.status === 404) throw new TurnError("EXPIRED");
      if (!response.ok) throw new TurnError(body.error ?? "REQUEST_FAILED");
      failures = 0;
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (error instanceof TurnError && error.code === "EXPIRED") throw error;
      if (++failures > MAX_RECONNECTS) throw new TurnError("NETWORK");
      await sleep(Math.min(4_000, 500 * 2 ** failures), options.signal);
      continue;
    }
    aborted();
    const events: TurnEvent[] = Array.isArray(body.events) ? body.events : [];
    for (const event of events) {
      options.onEvent(event);
      if (TERMINAL.has(event.type)) return;
    }
    next = Number(body.next ?? next);
    if (body.done) return;
    // A long-poll normally waits for events; never spin if a proxy answers empty polls instantly.
    if (!events.length) await sleep(250, options.signal);
  }
}

async function streamTurn(form: FormData, options: TurnOptions, onTurn: (id: string) => void): Promise<void> {
  const response = await fetch(`${PROXY}/assistant/stream`, { method: "POST", body: form, credentials: "same-origin", signal: options.signal })
    .catch((error) => { throw options.signal.aborted ? error : new TurnError("NETWORK"); });
  if (!response.ok || !response.body || !/event-stream/.test(response.headers.get("Content-Type") ?? "")) {
    const body = await response.json().catch(() => ({}));
    throw new TurnError(body.error ?? "REQUEST_FAILED");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let turnId = "";
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (/^event: turn$/m.test(block)) { turnId = String(event.turnId ?? ""); onTurn(turnId); continue; }
        received += 1;
        options.onEvent(event);
        if (TERMINAL.has(event.type)) return;
      }
    }
  } catch (error) {
    if (options.signal.aborted) throw error;
  }
  // The stream ended early; finish the same turn by polling from where it stopped.
  if (!turnId) throw new TurnError("NETWORK");
  await pollTurn(turnId, received, options);
}

/** Runs one turn to its terminal event. Aborting the signal cancels the turn on the server too. */
export async function runTurn(form: FormData, options: TurnOptions): Promise<void> {
  let turnId = "";
  const cancel = () => {
    if (!turnId) return;
    const body = new FormData();
    body.set("visitor", options.visitor);
    void fetch(`${PROXY}/assistant/turn/${encodeURIComponent(turnId)}/cancel`, { method: "POST", body, credentials: "same-origin", keepalive: true }).catch(() => {});
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (options.transport === "sse") {
      await streamTurn(form, options, (id) => { turnId = id; });
      return;
    }
    const started = await postForm(`${PROXY}/assistant/turn`, form, options.signal, options.onUploadProgress);
    turnId = String(started.turnId ?? "");
    if (!turnId) throw new TurnError("REQUEST_FAILED");
    await pollTurn(turnId, 0, options);
  } finally {
    options.signal.removeEventListener("abort", cancel);
  }
}
