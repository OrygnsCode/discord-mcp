// Image fetching for emoji and avatar uploads, which Discord takes as
// base64 data URIs. The validation half is pure and unit tested; the
// fetch half goes through fetchPublicUrl, which refuses private addresses.

import { fetchPublicUrl } from "./fetchUrl.js";
import { readLocalFile } from "./localFiles.js";
import { MAX_SHRINK_SOURCE_BYTES, shrinkImage } from "./shrink.js";

// Discord documents 256 KB for emoji and 512 KB for stickers and
// soundboard sounds. The avatar cap is this server's own conservative
// product limit, not an API number.
export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_AVATAR_BYTES = 1024 * 1024;
export const MAX_STICKER_BYTES = 512 * 1024;
export const MAX_SOUND_BYTES = 512 * 1024;

export const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Stickers take png, apng, and gif; Discord serves apng as image/png.
export const STICKER_TYPES = new Set(["image/png", "image/apng", "image/gif"]);

export const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/ogg"]);

export function validateAsset(
  contentType: string | null,
  bytes: number,
  maxBytes: number,
  allowed: Set<string>,
  label: string
): string | null {
  const normalized = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  if (!allowed.has(normalized)) {
    return (
      `Unsupported ${label} type "${normalized || "unknown"}". ` +
      `Allowed: ${[...allowed].join(", ")}.` +
      (normalized === "text/html"
        ? " That link is a web page, not the file itself: use the file's direct link, the one that opens just the file in a browser."
        : "")
    );
  }
  if (bytes > maxBytes) {
    return (
      `The ${label} is ${Math.ceil(bytes / 1024)} KB; the limit here is ` +
      `${Math.floor(maxBytes / 1024)} KB.`
    );
  }
  if (bytes === 0) {
    return `The ${label} is empty.`;
  }
  return null;
}

export function validateImage(
  contentType: string | null,
  bytes: number,
  maxBytes: number
): string | null {
  return validateAsset(contentType, bytes, maxBytes, IMAGE_TYPES, "image");
}

// Fetches any binary asset with type and size validation; the building
// block for sticker uploads (multipart) and sound uploads (data URI).
export async function fetchBinary(
  url: string,
  maxBytes: number,
  allowed: Set<string>,
  label: string
): Promise<
  | { ok: true; contentType: string; data: Buffer }
  | { ok: false; error: string }
> {
  const res = await fetchPublicUrl(url, maxBytes);
  if (!res.ok) {
    if (res.tooLarge) {
      return {
        ok: false,
        error:
          res.tooLarge.bytes !== undefined
            ? `The ${label} is ${Math.ceil(res.tooLarge.bytes / 1024)} KB; the limit here is ${Math.floor(maxBytes / 1024)} KB.`
            : `The ${label} is larger than the limit here, ${Math.floor(maxBytes / 1024)} KB.`,
      };
    }
    return res;
  }
  const contentType = typeOf(res.contentType, res.data, allowed);
  const problem = validateAsset(contentType, res.data.length, maxBytes, allowed, label);
  if (problem) return { ok: false, error: problem };
  return { ok: true, contentType, data: res.data };
}

// An upload's bytes from a public link or from a file in the files folder
// (see localFiles.ts), typed by its own first bytes wherever the source
// does not say. With shrinkTo, a still png or jpeg over the limit is made
// smaller, its longer side at most shrinkTo (see shrink.ts), and the note
// says so.
export async function loadAsset(
  source: { url?: string; file?: string },
  maxBytes: number,
  allowed: Set<string>,
  label: string,
  shrinkTo?: number
): Promise<{ ok: true; contentType: string; data: Buffer; note?: string } | { ok: false; error: string }> {
  const cap = shrinkTo ? Math.max(maxBytes, MAX_SHRINK_SOURCE_BYTES) : maxBytes;
  const tooBig = (bytes?: number) =>
    shrinkTo
      ? `The ${label} is ${bytes !== undefined ? `${Math.ceil(bytes / 1024)} KB` : "larger than 10 MB"}, too big even to make smaller here (at most ${Math.floor(cap / (1024 * 1024))} MB).`
      : bytes !== undefined
        ? `The ${label} is ${Math.ceil(bytes / 1024)} KB; the limit here is ${Math.floor(maxBytes / 1024)} KB.`
        : `The ${label} is larger than the limit here, ${Math.floor(maxBytes / 1024)} KB.`;
  let data: Buffer;
  let contentType: string;
  if (source.file !== undefined) {
    const file = readLocalFile(source.file, cap);
    if (!file.ok) return { ok: false, error: file.tooLarge ? tooBig(file.tooLarge.bytes) : file.error };
    data = file.data;
    // A file's name proves nothing; its first bytes say what it is.
    contentType = sniffType(data) ?? "unknown";
  } else {
    const res = await fetchPublicUrl(source.url ?? "", cap);
    if (!res.ok) return { ok: false, error: res.tooLarge ? tooBig(res.tooLarge.bytes) : res.error };
    data = res.data;
    contentType = typeOf(res.contentType, data, shrinkTo ? new Set([...allowed, "image/png", "image/jpeg"]) : allowed);
  }
  let note: string | undefined;
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  if (shrinkTo && data.length > maxBytes && (allowed.has(normalized) || normalized === "image/jpeg")) {
    const shrunk = shrinkImage(data, normalized, maxBytes, shrinkTo, label);
    if (!shrunk.ok) return shrunk;
    note =
      `The ${label} was ${Math.ceil(data.length / 1024)} KB (${shrunk.from.width}x${shrunk.from.height}), over the ` +
      `${Math.floor(maxBytes / 1024)} KB limit, so it was made ${shrunk.width}x${shrunk.height} (${Math.ceil(shrunk.data.length / 1024)} KB).`;
    data = shrunk.data;
    contentType = shrunk.contentType;
  }
  const problem = validateAsset(contentType, data.length, maxBytes, allowed, label);
  if (problem) return { ok: false, error: problem };
  return { ok: true, contentType, data, ...(note ? { note } : {}) };
}

// Where Discord's CDN is. Tests point it at a local stand-in, so no test
// reaches the real one.
export const __testing = { cdnBase: "https://cdn.discordapp.com", mediaBase: "https://media.discordapp.net" };

// A sticker's image as a data URI, read while it still exists, so undo can
// put it back. Discord serves gif stickers from its media host, the others
// from the CDN. Lottie stickers (format 3) cannot be uploaded by a server,
// so they are not saved. Undefined when it cannot be read.
export async function captureSticker(id: string, formatType: number): Promise<string | undefined> {
  if (formatType === 3) return undefined;
  const gif = formatType === 4;
  const url = gif ? `${__testing.mediaBase}/stickers/${id}.gif` : `${__testing.cdnBase}/stickers/${id}.png`;
  const res = await fetchPublicUrl(url, MAX_STICKER_BYTES);
  if (!res.ok || res.data.length === 0) return undefined;
  const type = sniffType(res.data) ?? (gif ? "image/gif" : "image/png");
  if (!STICKER_TYPES.has(type)) return undefined;
  return toDataUri(type, res.data);
}

// A soundboard sound as a data URI, read while it still exists. Undefined
// when it cannot be read.
export async function captureSound(id: string): Promise<string | undefined> {
  const res = await fetchPublicUrl(`${__testing.cdnBase}/soundboard-sounds/${id}`, MAX_SOUND_BYTES);
  if (!res.ok || res.data.length === 0) return undefined;
  const type = sniffType(res.data);
  if (!type || !AUDIO_TYPES.has(type)) return undefined;
  return toDataUri(type, res.data);
}

// A custom emoji's picture as a data URI, read from Discord's CDN while it
// still exists, at the 128 pixels Discord keeps emoji at, so undo can put
// it back. Undefined when it cannot be read.
export async function captureEmoji(id: string, animated: boolean): Promise<string | undefined> {
  const url = `${__testing.cdnBase}/emojis/${id}.${animated ? "gif" : "png"}?size=128&quality=lossless`;
  const res = await fetchPublicUrl(url, MAX_EMOJI_BYTES);
  if (!res.ok || res.data.length === 0) return undefined;
  const type = sniffType(res.data) ?? (animated ? "image/gif" : "image/png");
  if (!IMAGE_TYPES.has(type)) return undefined;
  return toDataUri(type, res.data);
}

// Some hosts serve every file as a generic download type. When the type
// says nothing, the file's first bytes say what it is, and only the types
// asked for are taken from them.
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/binary"]);

export function sniffType(data: Buffer): string | undefined {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (starts(0x4f, 0x67, 0x67, 0x53)) return "audio/ogg";
  if (starts(0x49, 0x44, 0x33) || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return undefined;
}

function typeOf(declared: string, data: Buffer, allowed: Set<string>): string {
  const normalized = declared.split(";")[0].trim().toLowerCase();
  if (!GENERIC_TYPES.has(normalized)) return declared;
  const sniffed = sniffType(data);
  return sniffed && allowed.has(sniffed) ? sniffed : declared;
}

export async function fetchAudioAsDataUri(
  url: string,
  maxBytes: number
): Promise<{ ok: true; dataUri: string } | { ok: false; error: string }> {
  const result = await fetchBinary(url, maxBytes, AUDIO_TYPES, "sound");
  if (!result.ok) return result;
  // Discord wants audio/mp3 spelled audio/mpeg in the data URI.
  const type = result.contentType === "audio/mp3" ? "audio/mpeg" : result.contentType;
  return { ok: true, dataUri: toDataUri(type, result.data) };
}

export function toDataUri(contentType: string, data: Buffer): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return `data:${normalized};base64,${data.toString("base64")}`;
}

export async function fetchImageAsDataUri(
  url: string,
  maxBytes: number
): Promise<{ ok: true; dataUri: string } | { ok: false; error: string }> {
  const res = await fetchBinary(url, maxBytes, IMAGE_TYPES, "image");
  if (!res.ok) return res;
  return { ok: true, dataUri: toDataUri(res.contentType, res.data) };
}

// Server and role images, as Discord's CDN serves them. Discord keeps only
// a hash, accepts a new image only as data, and stops serving a hash the
// moment it is replaced (the old address answers 404 right away). So
// whatever may need putting back is
// downloaded while it is still the current image.
const SERVER_IMAGE_PATHS: Record<string, string> = {
  icon: "icons",
  banner: "banners",
  splash: "splashes",
  discovery_splash: "discovery-splashes",
};

export function isImageField(kind: string, field: string): boolean {
  return kind === "server" ? field in SERVER_IMAGE_PATHS : kind === "role" && field === "icon";
}

export function imageCdnUrl(kind: "server" | "role", guildId: string, id: string, field: string, hash: string): string {
  const base = kind === "role" ? `role-icons/${id}` : `${SERVER_IMAGE_PATHS[field]}/${guildId}`;
  return `${__testing.cdnBase}/${base}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=4096`;
}

const MAX_SAVED_IMAGE_BYTES = 10 * 1024 * 1024;

// The current image as a data URI, or undefined when it cannot be read.
// The CDN can keep answering 404 for a few minutes for an address that
// failed before, which happens when a picture is set again after being
// replaced (Discord gives the same picture the same hash), so a miss is
// retried past the cache before giving up.
export async function captureImage(kind: "server" | "role", guildId: string, id: string, field: string, hash: string): Promise<string | undefined> {
  const url = imageCdnUrl(kind, guildId, id, field, hash);
  for (const attempt of [url, `${url}&_=${Date.now()}`, url.replace(/\.(png|gif)\?/, ".webp?")]) {
    const res = await fetchPublicUrl(attempt, MAX_SAVED_IMAGE_BYTES);
    if (!res.ok || res.data.length === 0) continue;
    const type = res.contentType.startsWith("image/") ? res.contentType : hash.startsWith("a_") ? "image/gif" : "image/png";
    return toDataUri(type, res.data);
  }
  return undefined;
}

// For a change record: the "before" value of each image field the change
// replaces, saved as the image itself so undo can send it back. A hash that
// cannot be read stays a hash, and undo says it cannot put that one back.
export async function savedImageBefore(
  kind: "server" | "role",
  guildId: string,
  id: string,
  fields: string[],
  before: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const hash = before[field];
    if (!isImageField(kind, field) || typeof hash !== "string") continue;
    out[field] = (await captureImage(kind, guildId, id, field, hash)) ?? hash;
  }
  return out;
}
