// What a server's boost level allows, by Discord's published perks, so a
// tool can say a server is full before uploading, and the overview can say
// up front what this server can and cannot have. An AI told this first
// does not learn it one refusal at a time.

const EMOJI_SLOTS = [50, 100, 150, 250];
const STICKER_SLOTS = [5, 15, 30, 60];
const SOUND_SLOTS = [8, 24, 36, 48];

const level = (tier: number | null | undefined) => Math.max(0, Math.min(3, Number(tier ?? 0)));

// Slots of each kind (emoji: static and animated each have this many), or
// null where a feature Discord gives some servers raises the limit past
// these numbers, in which case only Discord knows it.
export function emojiSlots(tier: number | null | undefined, features: string[]): number | null {
  return features.includes("MORE_EMOJI") ? null : EMOJI_SLOTS[level(tier)];
}

export function stickerSlots(tier: number | null | undefined, features: string[]): number | null {
  return features.includes("MORE_STICKERS") ? null : STICKER_SLOTS[level(tier)];
}

export function soundSlots(tier: number | null | undefined, features: string[]): number | null {
  return features.includes("MORE_SOUNDBOARD") ? null : SOUND_SLOTS[level(tier)];
}

// What boosting unlocks, from the server's own feature list.
export function boostUnlocks(features: string[]) {
  const has = (f: string) => features.includes(f);
  return {
    banner: has("BANNER"),
    animated_banner: has("ANIMATED_BANNER"),
    animated_icon: has("ANIMATED_ICON"),
    invite_background: has("INVITE_SPLASH"),
    role_icons: has("ROLE_ICONS"),
    gradient_role_colors: has("ENHANCED_ROLE_COLORS"),
    vanity_url: has("VANITY_URL"),
  };
}

const UNLOCK_WORDS: Record<keyof ReturnType<typeof boostUnlocks>, string> = {
  banner: "a banner",
  animated_banner: "an animated banner",
  animated_icon: "an animated icon",
  invite_background: "an invite background",
  role_icons: "role icons",
  gradient_role_colors: "gradient role colors",
  vanity_url: "a custom invite link",
};

// The unlocks this server does not have, in words, most asked for first.
// Short keeps to the ones a restyle or setup most often reaches for.
export function missingUnlocks(features: string[], short = false): string[] {
  const u = boostUnlocks(features);
  const keys = short
    ? (["banner", "animated_icon", "role_icons", "gradient_role_colors"] as const)
    : (Object.keys(UNLOCK_WORDS) as Array<keyof typeof UNLOCK_WORDS>);
  return keys.filter((k) => !u[k]).map((k) => UNLOCK_WORDS[k]);
}

// An emoji counts against the animated slots when its picture moves: a
// gif, or a webp with animation in it.
export function isAnimatedImage(contentType: string, data: Buffer): boolean {
  if (contentType === "image/gif") return true;
  if (contentType === "image/webp") return data.subarray(12, 64).includes("ANIM", 0, "latin1");
  return false;
}

// Emoji uploaded through this install, per server, in the last hour.
// Discord stops emoji uploads to a server for about an hour after roughly
// fifty (seen live: the 47th in an hour was held for 55 minutes). Other
// apps and people upload too, so this can only warn, never promise.
const UPLOAD_WINDOW_MS = 60 * 60_000;
const recentUploads = new Map<string, number[]>();

export function noteEmojiUpload(guildId: string, now = Date.now()): number {
  const kept = (recentUploads.get(guildId) ?? []).filter((t) => now - t < UPLOAD_WINDOW_MS);
  kept.push(now);
  recentUploads.set(guildId, kept);
  return kept.length;
}

export const __testing = { recentUploads };
