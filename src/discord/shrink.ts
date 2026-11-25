import { PNG } from "pngjs";
import jpeg from "jpeg-js";

// Making an image that is over Discord's size limit smaller, so an emoji or
// sticker from a big picture goes up instead of being refused. Pure
// JavaScript, so it works the same in every package (npm, Docker, and the
// one Claude Desktop bundle for every system), with no native code.
//
// Only still png and jpeg are made smaller. An animated gif, webp, or png
// would lose its animation, so those are refused with the reason. The
// picture's size is read from its header first, and anything past
// MAX_SIDE on a side is refused before it is decoded, so a small file that
// claims to be huge cannot make this allocate gigabytes.

export const MAX_SHRINK_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 4096;

export function imageDimensions(data: Buffer, type: string): { width: number; height: number } | undefined {
  if (type === "image/png") {
    if (data.length < 24 || data.toString("latin1", 12, 16) !== "IHDR") return undefined;
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return undefined;
      const marker = data[i + 1];
      // Start-of-frame markers carry the size; C4, C8, and CC are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
      }
      i += 2 + data.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

// An animated png carries an acTL chunk before its image data.
function isAnimatedPng(data: Buffer): boolean {
  const idat = data.indexOf("IDAT", 8, "latin1");
  const actl = data.indexOf("acTL", 8, "latin1");
  return actl !== -1 && (idat === -1 || actl < idat);
}

export type Shrunk =
  | { ok: true; data: Buffer; contentType: "image/png"; width: number; height: number; from: { width: number; height: number } }
  | { ok: false; error: string };

// Scales the picture down so its longer side is at most `side`, averaging
// the pixels each new one covers, and writes it as png (which keeps
// transparency). Fails when it still does not fit maxBytes.
export function shrinkImage(data: Buffer, type: string, maxBytes: number, side: number, label: string): Shrunk {
  const limit = `${Math.floor(maxBytes / 1024)} KB`;
  if (type !== "image/png" && type !== "image/jpeg") {
    const kind = type === "image/gif" ? "a gif" : type === "image/webp" ? "a webp" : `"${type || "unknown"}"`;
    return { ok: false, error: `The ${label} is over the ${limit} limit, and only a still png or jpeg can be made smaller here; this one is ${kind}. Use a smaller file.` };
  }
  if (type === "image/png" && isAnimatedPng(data)) {
    return { ok: false, error: `The ${label} is an animated png over the ${limit} limit; making it smaller would lose the animation. Use a smaller file.` };
  }
  const dims = imageDimensions(data, type);
  if (!dims || dims.width < 1 || dims.height < 1) return { ok: false, error: `The ${label} could not be read as a ${type === "image/png" ? "png" : "jpeg"}.` };
  if (dims.width > MAX_SIDE || dims.height > MAX_SIDE) {
    return { ok: false, error: `The ${label} is ${dims.width}x${dims.height}, larger than the ${MAX_SIDE}x${MAX_SIDE} this can make smaller. Use a smaller file.` };
  }

  let rgba: Buffer | Uint8Array;
  try {
    if (type === "image/png") {
      rgba = PNG.sync.read(data).data;
    } else {
      rgba = jpeg.decode(data, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 17, maxMemoryUsageInMB: 128 }).data;
    }
  } catch {
    return { ok: false, error: `The ${label} could not be read as a ${type === "image/png" ? "png" : "jpeg"}.` };
  }

  const { width: w, height: h } = dims;
  const scale = Math.min(1, side / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new PNG({ width: nw, height: nh });
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * h) / nh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * w) / nw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
      // Color weighted by opacity, so transparent pixels do not darken edges.
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) * 4;
          const alpha = rgba[i + 3];
          r += rgba[i] * alpha;
          g += rgba[i + 1] * alpha;
          b += rgba[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out.data[o] = a ? Math.round(r / a) : 0;
      out.data[o + 1] = a ? Math.round(g / a) : 0;
      out.data[o + 2] = a ? Math.round(b / a) : 0;
      out.data[o + 3] = Math.round(a / n);
    }
  }
  const png = PNG.sync.write(out, { deflateLevel: 9 });
  if (png.length > maxBytes) {
    return { ok: false, error: `The ${label} is still ${Math.ceil(png.length / 1024)} KB after making it ${nw}x${nh}, over the ${limit} limit. Use a smaller file.` };
  }
  return { ok: true, data: png, contentType: "image/png", width: nw, height: nh, from: dims };
}
