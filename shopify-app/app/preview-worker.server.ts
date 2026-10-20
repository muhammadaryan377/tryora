import { randomUUID, timingSafeEqual } from "node:crypto";

// Only operator-configured internal origins are used; no shopper-controlled URLs.
const nodeId = process.env.TRYORA_WORKER_ID ?? "local";
if (!/^[a-zA-Z0-9]+$/.test(nodeId)) throw new Error("TRYORA_WORKER_ID must be alphanumeric");
export const workerId = `${nodeId}_${randomUUID().replaceAll("-", "")}`;
const origins: Record<string, string> = JSON.parse(process.env.TRYORA_WORKER_ORIGINS ?? "{}");
const secret = process.env.TRYORA_WORKER_SECRET;
if (Object.keys(origins).length && (!secret || secret.length < 32 || !origins[nodeId])) {
  throw new Error("Worker routing requires this worker's origin and a shared secret of at least 32 characters");
}
for (const origin of Object.values(origins)) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Worker origins must be plain internal HTTP(S) origins");
  }
}

export function workerAuthorised(header: string | null) {
  if (!secret || !header) return false;
  const supplied = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function remoteJob(operation: "poll" | "drop", shopId: string, jobId: string): Promise<any | undefined> {
  const owner = jobId.includes("__") ? jobId.split("__")[0]!.split("_")[0]! : nodeId;
  if (owner === nodeId) return undefined;
  const origin = origins[owner];
  if (!origin) throw new Error("Preview owner is unavailable");
  const res = await fetch(new URL("/internal/tryora-worker", origin), {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation, shopId, jobId }),
  });
  if (!res.ok) throw new Error("Preview owner is unavailable");
  return res.json();
}
