export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/**
 * Renders assistant text safely: everything is escaped first, then only **bold**, "- " bullets and paragraphs are
 * turned into markup. Links and raw HTML from the model are never rendered.
 */
export function formatText(text: string): string {
  const blocks: string[] = [];
  let list: string[] = [];
  const inline = (line: string) => escapeHtml(line).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const flush = () => { if (list.length) blocks.push(`<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`); list = []; };
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) { list.push(inline(bullet[1]!)); continue; }
    flush();
    if (line) blocks.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return blocks.join("");
}

export function money(value: string | null, currency: string): string {
  if (value === null || !Number.isFinite(Number(value))) return "";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "GBP" }).format(Number(value)); }
  catch { return `${value} ${currency}`; }
}

export const STAGE_LABELS: Record<string, string> = {
  understanding: "Understanding your question…",
  analysing_room: "Analysing your room…",
  searching_products: "Searching store products…",
  checking_variants: "Checking variants and availability…",
  reading_store_info: "Reading store information…",
  preparing_recommendations: "Preparing recommendations…",
  checking_preview: "Checking AI preview eligibility…",
  writing: "Writing…",
};

export const ERROR_MESSAGES: Record<string, string> = {
  RATE_LIMITED: "The assistant is busy right now. Please wait a moment and try again.",
  BAD_PHOTO: "That room photo couldn't be read. Please choose another one.",
  PROVIDER_TIMEOUT: "That took too long to answer. Please try again.",
  NETWORK: "Connection lost. Check your internet connection and try again.",
  EXPIRED: "This answer expired before it finished. Please try again.",
  BAD_REQUEST: "Something about that message couldn't be processed. Please rephrase it and try again.",
};
export const errorMessage = (code: string) => ERROR_MESSAGES[code] ?? "The assistant is temporarily unavailable. Please try again.";
