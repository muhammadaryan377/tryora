/**
 * Launcher settings (owner decision, 19 Oct 2026). The merchant chooses how shoppers open Tryora:
 *   - "tryora": a Tryora button (overlay, floating or inline). One automatic launcher per page.
 *   - "own":    only the merchant's own elements (#tryora link, data-tryora attribute, Tryora.open()).
 *   - "both":   a Tryora button plus the merchant's own elements.
 */

export type LaunchMode = "tryora" | "own" | "both";
export type LauncherType = "overlay" | "floating" | "inline";
export type TemplateName = "gallery" | "atelier" | "noir" | "hearth" | "studio";

export interface LauncherSettings {
  mode: LaunchMode;
  type: LauncherType;
  wording: string;
  showIcon: boolean;
  /** null = use the theme's own button colour (the default for Studio). */
  background: string | null;
  text: string | null;
  radiusPx: number;
  position: "bottom-right" | "bottom-left";
  offsetPx: { x: number; y: number };
  showOnMobile: boolean;
  showOnDesktop: boolean;
}

export const DEFAULT_WORDING = "See it in your room";

const PRESETS: Record<TemplateName, Pick<LauncherSettings, "background" | "text" | "radiusPx">> = {
  gallery: { background: "#111111", text: "#FFFFFF", radiusPx: 999 },
  atelier: { background: null, text: null, radiusPx: 0 }, // editorial text link with underline
  noir: { background: "#111111", text: "#FFFFFF", radiusPx: 999 },
  hearth: { background: "#2F4B3C", text: "#FFFFFF", radiusPx: 999 },
  studio: { background: null, text: null, radiusPx: 6 }, // theme's button colour
};

export function defaultLauncher(template: TemplateName): LauncherSettings {
  return {
    mode: "tryora",
    type: "overlay",
    wording: DEFAULT_WORDING,
    showIcon: true,
    ...PRESETS[template],
    position: "bottom-right",
    offsetPx: { x: 16, y: 16 },
    showOnMobile: true,
    showOnDesktop: true,
  };
}

/** Which launchers the storefront should render on a product page. */
export function launchersToRender(s: LauncherSettings, device: "mobile" | "desktop"): { tryora: LauncherType | null; listenForOwn: boolean } {
  const deviceOk = device === "mobile" ? s.showOnMobile : s.showOnDesktop;
  return {
    tryora: s.mode !== "own" && deviceOk ? s.type : null,
    // Custom triggers always work: even in "tryora" mode a #tryora link should not be dead.
    listenForOwn: true,
  };
}

export function validateLauncher(s: LauncherSettings): string[] {
  const errors: string[] = [];
  if (!s.wording.trim()) errors.push("Button wording can't be empty.");
  if (s.wording.length > 40) errors.push("Button wording must be 40 characters or fewer.");
  if (s.mode !== "own" && !s.showOnMobile && !s.showOnDesktop) errors.push("Show the Tryora button on mobile, desktop or both.");
  if (s.radiusPx < 0 || s.radiusPx > 999) errors.push("Corner radius must be between 0 and 999.");
  for (const c of [s.background, s.text]) if (c !== null && !/^#[0-9a-fA-F]{6}$/.test(c)) errors.push(`"${c}" isn't a valid colour.`);
  return errors;
}
