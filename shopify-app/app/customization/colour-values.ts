/** RGB is an editable representation of the canonical persisted HEX value. */
export function hexToRgb(hex: string | null): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? "")) return "";
  return [1, 3, 5].map((offset) => parseInt(hex!.slice(offset, offset + 2), 16)).join(", ");
}
export function rgbToHex(rgb: string): string | null {
  if (!/^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*$/.test(rgb)) return null;
  const values = rgb.split(",").map(Number);
  if (values.some((v) => v > 255)) return null;
  return "#" + values.map((v) => v.toString(16).padStart(2, "0")).join("");
}
