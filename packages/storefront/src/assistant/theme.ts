/**
 * Read the active Shopify storefront's button and surface palette. No layout,
 * typography, markup or theme settings are changed: only Tryora colour tokens.
 * Dawn uses RGB-triplet variables; other Shopify themes use CSS colours or
 * ordinary computed button/background colours.
 */
export interface AssistantTheme {
  accent: string;
  accentInk: string;
  background: string;
  surface: string;
  line: string;
  ink: string;
  muted: string;
}

type RGB = [number, number, number];

function rgb(input: string | null | undefined): RGB | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  const hex = raw.match(/^#([\da-f]{3}|[\da-f]{6})$/);
  if (hex) {
    const code = hex[1]!.length === 3 ? [...hex[1]!].map((n) => n + n).join("") : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(code.slice(i, i + 2), 16)) as RGB;
  }
  // Support Shopify's "18, 18, 18" and modern rgb(18 18 18 / 1) formats.
  const functional = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  const triplet = raw.match(/^([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)$/);
  const values = functional ?? triplet;
  if (!values) return null;
  if (functional?.[4] && (functional[4] === "0" || functional[4] === "0%")) return null;
  const numbers = [Number(values[1]), Number(values[2]), Number(values[3])];
  return numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? numbers as RGB : null;
}
function css(color: RGB): string {
  return "#" + color.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
}
function blend(first: RGB, second: RGB, weight: number): RGB {
  return first.map((value, i) => Math.round(value * (1 - weight) + second[i]! * weight)) as RGB;
}
function luminance([r, g, b]: RGB) {
  const v = [r, g, b].map((channel) => {
    const n = channel / 255;
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  });
  return v[0]! * .2126 + v[1]! * .7152 + v[2]! * .0722;
}
function contrast(a: RGB, b: RGB) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
const DARK: RGB = [24, 24, 24];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/** Safely pick a contrasting text colour for the theme's chosen button. */
function readable(candidate: RGB, background: RGB, ratio = 4.5): RGB {
  if (contrast(candidate, background) >= ratio) return candidate;
  return contrast(WHITE, background) > contrast(BLACK, background) ? WHITE : BLACK;
}

export function storefrontAssistantTheme(doc: Document = document): AssistantTheme {
  const root = getComputedStyle(doc.documentElement);
  const body = doc.body ? getComputedStyle(doc.body) : root;
  const mainElement = doc.querySelector<HTMLElement>("#MainContent, main");
  const main = mainElement ? getComputedStyle(mainElement) : body;
  const sources = [main, body, root];

  const themeVar = (...names: string[]): RGB | null => {
    for (const name of names) for (const style of sources) {
      const found = rgb(style.getPropertyValue(name));
      if (found) return found;
    }
    return null;
  };
  // Do not sample Tryora itself (or checkout / payment buttons) as the site's
  // brand colour. Add-to-cart buttons are a reliable primary action on PDPs.
  const addToCart = doc.querySelector<HTMLElement>(
    'main .product-form__submit, main button[name="add"], main [type="submit"][name="add"], ' +
    '.product-form__submit, button[name="add"], main .button--primary'
  );
  const buttonStyle = addToCart ? getComputedStyle(addToCart) : null;
  const background = themeVar("--color-background", "--color-base-background-1", "--color-page-background", "--background-color")
    ?? rgb(main.backgroundColor) ?? rgb(body.backgroundColor) ?? WHITE;
  const preferredInk = themeVar("--color-foreground", "--color-base-text", "--color-text", "--text-color")
    ?? rgb(main.color) ?? rgb(body.color) ?? DARK;
  const ink = readable(preferredInk, background);
  const buttonBackground = buttonStyle && rgb(buttonStyle.backgroundColor);
  const preferredAccent = (buttonBackground && contrast(buttonBackground, background) >= 2.5 ? buttonBackground : null)
    ?? themeVar("--color-button", "--color-base-accent-1", "--color-primary-button-background", "--button-background", "--color-primary")
    ?? ink;
  const accent = contrast(preferredAccent, background) >= 2.5 ? preferredAccent : ink;
  const preferredButtonText = buttonStyle && rgb(buttonStyle.color);
  const accentInk = readable(preferredButtonText
    ?? themeVar("--color-button-text", "--color-base-solid-button-labels") ?? WHITE, accent);

  const opposite = luminance(background) > .5 ? BLACK : WHITE;
  return {
    accent: css(accent), accentInk: css(accentInk), background: css(background),
    surface: css(blend(background, opposite, .035)),
    line: css(blend(background, opposite, .13)),
    ink: css(ink),
    muted: css(readable(blend(ink, background, .38), background)),
  };
}

/** Keep the existing widget's layout, changing only its CSS colour variables. */
export function applyAssistantTheme(element: HTMLElement, palette: AssistantTheme): void {
  element.style.setProperty("--ta-accent", palette.accent);
  element.style.setProperty("--ta-accent-ink", palette.accentInk);
  element.style.setProperty("--ta-bg", palette.background);
  element.style.setProperty("--ta-surface", palette.surface);
  element.style.setProperty("--ta-line", palette.line);
  element.style.setProperty("--ta-ink", palette.ink);
  element.style.setProperty("--ta-muted", palette.muted);
}
