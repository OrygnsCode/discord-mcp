// Image fetching for emoji and avatar uploads, which Discord takes as
// base64 data URIs. The validation half is pure and unit tested; the
// fetch half goes through fetchPublicUrl, which refuses private addresses.

import { fetchPublicUrl } from "./fetchUrl.js";

// Discord documents 256 KB for emoji and 512 KB for stickers and
// soundboard sounds. The avatar cap is this server's own conservative
// product limit, not an API number.
export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_AVATAR_BYTES = 1024 * 1024;
export const MAX_STICKER_BYTES = 512 * 1024;
export const MAX_SOUND_BYTES = 512 * 1024;

const ALLOWED_TYPES = new Set([
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
      `Allowed: ${[...allowed].join(", ")}.`
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
  return validateAsset(contentType, bytes, maxBytes, ALLOWED_TYPES, "image");
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
  const problem = validateAsset(res.contentType, res.data.length, maxBytes, allowed, label);
  if (problem) return { ok: false, error: problem };
  return { ok: true, contentType: res.contentType, data: res.data };
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
  const res = await fetchBinary(url, maxBytes, ALLOWED_TYPES, "image");
  if (!res.ok) return res;
  return { ok: true, dataUri: toDataUri(res.contentType, res.data) };
}

// Server and role images, as Discord's CDN serves them. Discord keeps only
// a hash, accepts a new image only as data, and stops serving a hash the
// moment it is replaced (probed live: both earlier server icons answered
// 404 right after the change). So whatever may need putting back is
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
  return `https://cdn.discordapp.com/${base}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=4096`;
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
