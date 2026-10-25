/**
 * Room Assistant entry points used by the storefront boot: the floating launcher and the config request.
 * The drawer itself lives in ./assistant/drawer.ts.
 */
import { escapeHtml } from "./assistant/format.js";
import { applyAssistantTheme, storefrontAssistantTheme } from "./assistant/theme.js";
import type { AssistantConfig } from "./assistant/drawer.js";

export { RoomAssistant, type AssistantConfig, type AssistantContext } from "./assistant/drawer.js";
export { wasOpen } from "./assistant/session.js";

import { PROXY } from "./proxy.js";

const LAUNCHER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 016.5 3h11A2.5 2.5 0 0120 5.5v8a2.5 2.5 0 01-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 014 13.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 6.2l.95 2.45 2.45.95-2.45.95L12 13l-.95-2.45-2.45-.95 2.45-.95z" fill="currentColor"/></svg>`;

/** Third-party chat bubbles that sit in the same corner (Shopify Inbox and common equivalents). */
const CHAT_WIDGETS = "#shopify-chat, inbox-online-store-chat, #ShopifyChat, .shopify-chat-button, #tidio-chat, #gorgias-chat-container";

/** Moves the launcher above a chat widget in the same corner. Widgets load late, so this re-checks a few times. */
export function avoidChatWidgets(button: HTMLElement, position: "bottom-left" | "bottom-right") {
  const check = () => {
    const widget = document.querySelector<HTMLElement>(CHAT_WIDGETS);
    if (!widget) return;
    const rect = typeof widget.getBoundingClientRect === "function" ? widget.getBoundingClientRect() : null;
    const width = typeof window !== "undefined" ? window.innerWidth || 0 : 0;
    // Without layout information (or an off-screen widget) assume it uses the default right-hand corner.
    const right = !rect || !rect.width || !width || rect.left + rect.width / 2 > width / 2;
    if ((position === "bottom-right") === right) button.classList.add("tryora-assistant-launch--above-chat");
  };
  check();
  for (const delay of [2500, 6000]) setTimeout(check, delay);
}

export function buildAssistantLauncher(config: AssistantConfig, open: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tryora-assistant-launch tryora-assistant-launch--${config.launcher.position}`;
  applyAssistantTheme(button, storefrontAssistantTheme());
  button.setAttribute("aria-label", `${config.launcher.label}, AI shopping assistant`);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<span class="tryora-assistant-launch__icon">${LAUNCHER_ICON}</span>` +
    `<span class="tryora-assistant-launch__label">${escapeHtml(config.launcher.label)}</span>` +
    `<span class="tryora-assistant-launch__dot" aria-hidden="true"></span>`;
  button.addEventListener("click", open);
  avoidChatWidgets(button, config.launcher.position);
  return button;
}

export async function fetchAssistantConfig(root: HTMLElement): Promise<AssistantConfig | null> {
  const query = new URLSearchParams({ pageType: root.dataset.pageType ?? "" });
  if (root.dataset.productId) query.set("product", root.dataset.productId);
  if (root.dataset.productHandle) query.set("productHandle", root.dataset.productHandle);
  if (root.dataset.collectionId) query.set("collection", root.dataset.collectionId);
  if (root.dataset.collectionHandle) query.set("collectionHandle", root.dataset.collectionHandle);
  try {
    const response = await fetch(`${PROXY}/assistant/config?${query}`, { credentials: "same-origin" });
    if (!response.ok) return null;
    return await response.json() as AssistantConfig;
  } catch { return null; }
}
