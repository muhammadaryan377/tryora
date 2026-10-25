// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAssistantTheme, storefrontAssistantTheme } from "../../packages/storefront/src/assistant/theme";

type ThemeStyle = Pick<CSSStyleDeclaration, "getPropertyValue" | "backgroundColor" | "color">;
function style(values: Record<string, string> = {}): ThemeStyle {
  return {
    getPropertyValue: (key: string) => values[key] ?? "",
    backgroundColor: values.backgroundColor ?? "rgba(0, 0, 0, 0)",
    color: values.color ?? "",
  };
}
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("Room Assistant storefront colour matching", () => {
  it("uses Shopify's primary add-to-cart button without changing the launcher layout", () => {
    document.body.innerHTML = '<main><button name="add">Add to cart</button></main>';
    const add = document.querySelector('button[name="add"]')!;
    const main = document.querySelector("main")!;
    vi.stubGlobal("getComputedStyle", (element: Element) =>
      element === add ? style({ backgroundColor: "rgb(23, 23, 23)", color: "rgb(255, 255, 255)" }) :
      element === main ? style({ backgroundColor: "rgb(255, 255, 255)", color: "rgb(24, 24, 24)" }) :
      style());
    const palette = storefrontAssistantTheme();
    expect(palette.accent).toBe("#171717");
    expect(palette.accentInk).toBe("#ffffff");
    expect(palette.background).toBe("#ffffff");
    const launcher = document.createElement("button");
    launcher.className = "tryora-assistant-launch";
    applyAssistantTheme(launcher, palette);
    expect(launcher.style.getPropertyValue("--ta-accent")).toBe("#171717");
    expect(launcher.className).toBe("tryora-assistant-launch");
    expect(launcher.style.getPropertyValue("padding")).toBe("");
  });

  it("supports Dawn's RGB-triplet variables when no suitable product button exists", () => {
    vi.stubGlobal("getComputedStyle", (element: Element) => element === document.documentElement
      ? style({ "--color-button": "40, 57, 65", "--color-button-text": "255, 255, 255",
        "--color-background": "255, 255, 255", "--color-foreground": "22, 22, 22" })
      : style());
    const palette = storefrontAssistantTheme();
    expect(palette.accent).toBe("#283941");
    expect(palette.accentInk).toBe("#ffffff");
    expect(palette.ink).toBe("#161616");
  });

  it("rejects transparent buttons and keeps text readable on dark themes", () => {
    document.body.innerHTML = '<main><button name="add">Add to cart</button></main>';
    const add = document.querySelector('button[name="add"]')!;
    vi.stubGlobal("getComputedStyle", (element: Element) =>
      element === add ? style({ backgroundColor: "rgba(0, 0, 0, 0)", color: "#fff" }) :
      element === document.documentElement ? style({ "--color-background": "18, 18, 18",
        "--color-foreground": "240, 240, 240", "--color-button": "240, 240, 240" }) : style());
    const palette = storefrontAssistantTheme();
    expect(palette.accent).toBe("#f0f0f0");
    expect(palette.accentInk).toBe("#000000");
    expect(palette.background).toBe("#121212");
    expect(palette.ink).toBe("#f0f0f0");
  });
});
