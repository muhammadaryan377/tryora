export interface SwatchAppearance { shape: "circle" | "rectangle"; size: 25 | 50 | 75 | 100 }
/** Empty style preserves legacy/native sizing when no merchant setting exists. */
export function swatchAppearanceStyle(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const { shape, size } = value as SwatchAppearance;
  if (!["circle", "rectangle"].includes(shape) || ![25, 50, 75, 100].includes(size)) return "";
  return `width:${size}px;height:${shape === "rectangle" ? Math.round(size * .7) : size}px;border-radius:${shape === "circle" ? "50%" : "5px"};flex-shrink:0;`;
}
