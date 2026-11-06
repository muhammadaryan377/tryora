/**
 * Room Assistant entry points used by the storefront boot: the floating launcher and the config request.
 * The drawer itself lives in ./assistant/drawer.ts.
 */
import { VISULLY_LOGO } from "./brand.js";
import { escapeHtml } from "./assistant/format.js";
import { applyAssistantTheme, storefrontAssistantTheme } from "./assistant/theme.js";
import type { AssistantConfig } from "./assistant/drawer.js";

export { RoomAssistant, type AssistantConfig, type AssistantContext } from "./assistant/drawer.js";
export { wasOpen } from "./assistant/session.js";

import { PROXY } from "./proxy.js";


import { avoidFloatingWidgets } from "./assistant/launcher-position.js";

export function buildAssistantLauncher(config: AssistantConfig, open: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tryora-assistant-launch tryora-assistant-launch--${config.launcher.position}`;
  applyAssistantTheme(button, storefrontAssistantTheme());
  button.setAttribute("aria-label", `${config.launcher.label}, AI shopping assistant`);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<span class="tryora-assistant-launch__icon">${VISULLY_LOGO}</span>` +
    `<span class="tryora-assistant-launch__label">${escapeHtml(config.launcher.label)}</span>` +
    `<span class="tryora-assistant-launch__dot" aria-hidden="true"></span>`;
  button.addEventListener("click", open);
  avoidFloatingWidgets(button);
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
