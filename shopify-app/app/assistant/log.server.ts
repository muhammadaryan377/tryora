/**
 * Privacy-safe structured logs for the Room Assistant.
 * Only allowlisted, non-content fields are written: never message text, photos, visitor IDs, emails or API keys.
 * Upstream error messages are reduced to a class name and HTTP status because they can echo request content.
 */

export type AssistantLogEvent =
  | "assistant_request"
  | "openai_failure"
  | "shopify_failure"
  | "tool_validation_failure"
  | "model_parse_failure"
  | "timeout"
  | "rate_limited"
  | "catalogue_loaded"
  | "recommendation_completion_unavailable"
  | "recommendation_dropped"
  | "auto_config_failure"
  | "preview_unavailable";

type Field = string | number | boolean | null | undefined;

const ALLOWED = new Set([
  "shop", "requestId", "code", "stage", "status", "durationMs", "round", "tool", "rounds", "toolCalls",
  "products", "pages", "complete", "cache", "inputTokens", "outputTokens", "recommendations", "reason",
  "errorClass", "model", "photo", "shopifyCalls", "product", "variant",
]);

export type AssistantLogFields = Partial<Record<string, Field>>;

let sink: (line: string, level: "info" | "warn") => void = (line, level) =>
  level === "warn" ? console.warn(line) : console.info(line);

/** Tests replace the sink to assert on what would be written. */
export function setAssistantLogSink(next: typeof sink) { sink = next; }

export function logAssistant(event: AssistantLogEvent, fields: AssistantLogFields = {}, level: "info" | "warn" = "warn") {
  const safe: Record<string, Field> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key) || value === undefined) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 120) : value;
  }
  try { sink(JSON.stringify({ component: "room-assistant", event, ...safe }), level); }
  catch { /* Logging must never break a shopper request. */ }
}

/** A loggable description of an upstream error without its message, which may contain shopper content. */
export function errorShape(error: unknown): { errorClass: string; status?: number; code?: string } {
  const value = error as { name?: unknown; status?: unknown; code?: unknown } | null;
  return {
    errorClass: typeof value?.name === "string" ? value.name.slice(0, 60) : typeof error,
    status: typeof value?.status === "number" ? value.status : undefined,
    code: typeof value?.code === "string" && /^[A-Z_]{2,40}$/.test(value.code) ? value.code : undefined,
  };
}
