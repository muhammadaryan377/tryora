import { inflateSync } from "node:zlib";

/**
 * Reads the main colour of a product photo. We ask Shopify's CDN for a tiny, centre-cropped PNG of the variant
 * photo (so no image library is needed) and average its middle, where the product usually is.
 * Used only to fill missing swatches when the merchant has approved automatic filling.
 */

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Minimal decoder for 8-bit RGB/RGBA, non-interlaced PNGs (what Shopify's CDN returns). */
export function decodePng(buf: Buffer): { width: number; height: number; channels: number; pixels: Uint8Array } | null {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8], colourType = data[9], interlace = data[12];
      if (bitDepth !== 8 || interlace !== 0) return null;
      channels = colourType === 2 ? 3 : colourType === 6 ? 4 : 0;
      if (!channels) return null;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const v = line[x]!;
      out[y * stride + x] =
        (filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 255;
    }
  }
  return { width, height, channels, pixels: out };
}

/** Average colour of the central third of the image, as #rrggbb. */
export function centreColour(img: { width: number; height: number; channels: number; pixels: Uint8Array }): string {
  const x0 = Math.floor(img.width / 3), x1 = Math.ceil((img.width * 2) / 3);
  const y0 = Math.floor(img.height / 3), y1 = Math.ceil((img.height * 2) / 3);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * img.channels;
      r += img.pixels[i]!; g += img.pixels[i + 1]!; b += img.pixels[i + 2]!; n++;
    }
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export async function photoColour(tinyPngUrl: string): Promise<string | null> {
  try {
    const res = await fetch(tinyPngUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const img = decodePng(Buffer.from(await res.arrayBuffer()));
    return img ? centreColour(img) : null;
  } catch {
    return null;
  }
}
