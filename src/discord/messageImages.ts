import type { APIMessage } from "discord-api-types/v10";
import { fetchPublicUrl } from "./fetchUrl.js";

// Images in a message, for the AI to look at: attachments, embed images and
// thumbnails, Components V2 media, and what a forwarded message carries.
//
// Everything is fetched through Discord's media proxy, never from the
// address an embed points at, so a link in a message cannot make this
// server fetch from wherever it likes. The proxy also resizes: asking for a
// width and height (both are needed; one alone returns the original) and
// format=webp turned a 3000x1500 PNG of 1.2 MB into a 1568x784 webp of
// about 95 KB when probed live. Models see little more than about 1.15
// megapixels, so nothing larger is fetched.

export const MAX_EDGE = 1568;
export const MAX_PIXELS = 1_150_000;
// Per image, after resizing, and per call. A tool result much past a few
// megabytes is refused or truncated by some apps.
export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_TOTAL_BYTES = 4_000_000;

export interface ImageRef {
  source: "attachment" | "embed" | "component" | "forwarded";
  name: string;
  proxyUrl: string;
  width?: number;
  height?: number;
  spoiler: boolean;
  flagged: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

// Discord's content scanning bits, as on digestMessage.
const SCAN: Array<[number, string]> = [
  [1 << 4, "explicit"],
  [1 << 6, "gore"],
  [1 << 7, "self_harm"],
];
function scanLabels(flags: number | undefined): string[] {
  return SCAN.filter(([bit]) => ((flags ?? 0) & bit) !== 0).map(([, l]) => l);
}

// Only Discord's own media hosts are fetched.
export function isDiscordMediaUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return (
      host === "cdn.discordapp.com" ||
      host === "media.discordapp.net" ||
      /^images-ext-\d+\.discordapp\.net$/.test(host)
    );
  } catch {
    return false;
  }
}

interface MediaLike {
  url?: string;
  proxy_url?: string;
  width?: number | null;
  height?: number | null;
  content_type?: string;
  flags?: number;
}

type AttachmentLike = {
  filename: string;
  content_type?: string;
  proxy_url: string;
  width?: number | null;
  height?: number | null;
  flags?: number;
};

function fromAttachments(list: AttachmentLike[] | undefined, source: ImageRef["source"], out: ImageRef[]): void {
  for (const a of list ?? []) {
    const isImage = a.content_type ? a.content_type.startsWith("image/") : IMAGE_EXT.test(a.filename);
    if (!isImage || !isDiscordMediaUrl(a.proxy_url)) continue;
    out.push({
      source,
      name: a.filename,
      proxyUrl: a.proxy_url,
      ...(a.width ? { width: a.width } : {}),
      ...(a.height ? { height: a.height } : {}),
      // Discord marks a spoiler by the file name, and since 2025 by a flag.
      spoiler: a.filename.startsWith("SPOILER_") || ((a.flags ?? 0) & (1 << 3)) !== 0,
      flagged: scanLabels(a.flags),
    });
  }
}

function fromMedia(media: MediaLike | undefined, name: string, source: ImageRef["source"], spoiler: boolean, out: ImageRef[]): void {
  if (!media || !isDiscordMediaUrl(media.proxy_url)) return;
  if (media.content_type && !media.content_type.startsWith("image/")) return;
  out.push({
    source,
    name,
    proxyUrl: media.proxy_url as string,
    ...(media.width ? { width: media.width } : {}),
    ...(media.height ? { height: media.height } : {}),
    spoiler,
    flagged: scanLabels(media.flags),
  });
}

type ComponentLike = {
  type: number;
  components?: ComponentLike[];
  accessory?: ComponentLike;
  items?: Array<{ media?: MediaLike; spoiler?: boolean; description?: string | null }>;
  media?: MediaLike;
  spoiler?: boolean;
  description?: string | null;
};

function fromComponents(list: ComponentLike[] | undefined, out: ImageRef[]): void {
  for (const c of list ?? []) {
    // 12 is a media gallery, 11 a thumbnail; sections and containers nest.
    if (c.type === 12) {
      (c.items ?? []).forEach((item, i) =>
        fromMedia(item.media, item.description || `gallery image ${i + 1}`, "component", item.spoiler ?? false, out)
      );
    } else if (c.type === 11) {
      fromMedia(c.media, c.description || "thumbnail", "component", c.spoiler ?? false, out);
    }
    if (c.components) fromComponents(c.components, out);
    if (c.accessory) fromComponents([c.accessory], out);
  }
}

// Every image in a message, in reading order. Pure.
export function collectImages(message: APIMessage): ImageRef[] {
  const out: ImageRef[] = [];
  fromAttachments(message.attachments as AttachmentLike[], "attachment", out);
  (message.embeds ?? []).forEach((e, i) => {
    const label = e.title ?? `embed ${i + 1}`;
    fromMedia(e.image as MediaLike | undefined, `${label} (image)`, "embed", false, out);
    fromMedia(e.thumbnail as MediaLike | undefined, `${label} (thumbnail)`, "embed", false, out);
  });
  fromComponents(message.components as unknown as ComponentLike[], out);
  for (const snap of (message as { message_snapshots?: Array<{ message?: Partial<APIMessage> }> }).message_snapshots ?? []) {
    fromAttachments(snap.message?.attachments as AttachmentLike[] | undefined, "forwarded", out);
    (snap.message?.embeds ?? []).forEach((e, i) => {
      fromMedia(e.image as MediaLike | undefined, `${e.title ?? `forwarded embed ${i + 1}`} (image)`, "forwarded", false, out);
    });
  }
  // The same picture can show up twice, for example a link whose preview
  // repeats an attachment.
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = r.proxyUrl.split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The size to ask the proxy for: within MAX_EDGE on the long side and
// MAX_PIXELS in all, never larger than the original. Pure.
export function targetSize(width: number, height: number, maxEdge = MAX_EDGE, maxPixels = MAX_PIXELS): { width: number; height: number } {
  let scale = Math.min(1, maxEdge / Math.max(width, height));
  if (width * height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

// The proxy address for one image at a given size, as webp. Pure.
export function proxyRequestUrl(ref: ImageRef, shrink = 1): string {
  const u = new URL(ref.proxyUrl);
  if (ref.width && ref.height) {
    const size = targetSize(ref.width, ref.height, Math.floor(MAX_EDGE * shrink), Math.floor(MAX_PIXELS * shrink * shrink));
    u.searchParams.set("width", String(size.width));
    u.searchParams.set("height", String(size.height));
  }
  u.searchParams.set("format", "webp");
  return u.href;
}

const MIME_BY_MAGIC: Array<[(b: Buffer) => boolean, string]> = [
  [(b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP", "image/webp"],
  [(b) => b.length > 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG", "image/png"],
  [(b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, "image/jpeg"],
  [(b) => b.length > 6 && b.toString("ascii", 0, 3) === "GIF", "image/gif"],
];

// The type the bytes actually are, which is what the AI app needs; a
// header can say otherwise.
export function sniffImageType(data: Buffer): string | undefined {
  return MIME_BY_MAGIC.find(([test]) => test(data))?.[1];
}

export type FetchedImage =
  | { ok: true; data: Buffer; mimeType: string; width?: number; height?: number }
  | { ok: false; error: string };

// One image through the proxy, shrunk further if it comes back too large.
// The fetch stays on Discord's media hosts through every redirect: the
// proxy exists so that whoever posted an image never sees who looked at
// it, and following a redirect off it would hand this machine's address to
// the image's host. The fetcher is a parameter for tests.
export async function fetchMessageImage(
  ref: ImageRef,
  fetcher: typeof fetchPublicUrl = fetchPublicUrl
): Promise<FetchedImage> {
  if (!isDiscordMediaUrl(ref.proxyUrl)) return { ok: false, error: "not on Discord's media host" };
  for (const shrink of [1, 0.6, 0.35]) {
    const res = await fetcher(proxyRequestUrl(ref, shrink), MAX_IMAGE_BYTES * 4, {
      stayOn: (url) => isDiscordMediaUrl(url.href),
    });
    if (!res.ok) return res;
    const mimeType = sniffImageType(res.data);
    if (!mimeType) return { ok: false, error: "Discord did not return an image" };
    if (res.data.length <= MAX_IMAGE_BYTES) {
      const size = ref.width && ref.height
        ? targetSize(ref.width, ref.height, Math.floor(MAX_EDGE * shrink), Math.floor(MAX_PIXELS * shrink * shrink))
        : undefined;
      return { ok: true, data: res.data, mimeType, ...(size ?? {}) };
    }
    // Without known dimensions the proxy cannot shrink it.
    if (!ref.width || !ref.height) break;
  }
  return { ok: false, error: "too large even after shrinking" };
}
