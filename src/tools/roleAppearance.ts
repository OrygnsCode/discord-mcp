import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type { APIGuild, APIRole } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import { resolveEmojiInput } from "../discord/emoji.js";
import { fetchImageAsDataUri, MAX_EMOJI_BYTES } from "../discord/images.js";
import { parseHexColor } from "./common.js";

// How a role looks beyond its single color: a gradient or Discord's
// holographic style (servers with the Enhanced Role Colors feature), and an
// icon next to its members' names (servers with Role Icons, boost level 2).
// Shared by create_role and update_role.

// Discord sets these three itself for the holographic style and refuses
// any others alongside a tertiary color.
export const HOLOGRAPHIC = { primary_color: 11127295, secondary_color: 16759788, tertiary_color: 16761760 };

export const roleAppearanceFields = {
  secondary_color: z.string().optional()
    .describe("A second hex color, so the role name shows a gradient from color to this one; none for a solid color. Needs the Enhanced Role Colors server feature."),
  holographic: z.boolean().optional()
    .describe("Discord's holographic style, which uses its own three colors; false for a solid color. Needs the Enhanced Role Colors server feature."),
  icon_url: z.string().optional()
    .describe("Public URL of a small image (png, jpeg, webp; 256 KB) shown beside members' names, or none to remove. Needs boost level 2."),
  icon_emoji: z.string().optional()
    .describe("A standard emoji shown beside members' names instead of an image, or none to remove. Needs boost level 2."),
};

export type RoleAppearanceInput = {
  color?: string;
  secondary_color?: string;
  holographic?: boolean;
  icon_url?: string;
  icon_emoji?: string;
};

export function hasRoleAppearance(input: RoleAppearanceInput): boolean {
  return [input.secondary_color, input.holographic, input.icon_url, input.icon_emoji].some((v) => v !== undefined);
}

const isNone = (v: string) => /^none$/i.test(v.trim());

// The request fields for the appearance asked for. When it sets colors, the
// caller sends no plain color: `colors` carries the primary too. Checks the
// server features it needs, read here.
export async function roleAppearanceBody(
  rest: REST,
  guildId: string,
  input: RoleAppearanceInput,
  current?: Pick<APIRole, "color" | "colors">
): Promise<{ ok: true; body: Record<string, unknown>; changes: string[]; setsColors: boolean } | { ok: false; reason: string }> {
  const body: Record<string, unknown> = {};
  const changes: string[] = [];
  if (!hasRoleAppearance(input)) return { ok: true, body, changes, setsColors: false };
  if (input.holographic === true && (input.color !== undefined || input.secondary_color !== undefined)) {
    return { ok: false, reason: "holographic uses Discord's own three colors, so it cannot be combined with color or secondary_color." };
  }
  if (input.icon_url !== undefined && input.icon_emoji !== undefined && !isNone(input.icon_url) && !isNone(input.icon_emoji)) {
    return { ok: false, reason: "A role shows either an image or an emoji as its icon, not both. Pass one of icon_url or icon_emoji." };
  }
  const guild = (await rest.get(Routes.guild(guildId))) as APIGuild;
  const has = (f: string) => (guild.features as string[]).includes(f);

  const gradient = input.secondary_color !== undefined && !isNone(input.secondary_color);
  if ((gradient || input.holographic === true) && !has("ENHANCED_ROLE_COLORS")) {
    return { ok: false, reason: "Gradient and holographic role colors need the Enhanced Role Colors feature, which this server does not have." };
  }
  const primary = input.color !== undefined ? parseHexColor(input.color) : (current?.colors?.primary_color ?? current?.color ?? 0);
  let setsColors = false;
  if (input.holographic === true) {
    body.colors = { ...HOLOGRAPHIC };
    changes.push("holographic colors");
    setsColors = true;
  } else if (gradient) {
    body.colors = { primary_color: primary, secondary_color: parseHexColor(input.secondary_color as string), tertiary_color: null };
    changes.push(`gradient to ${input.secondary_color}`);
    setsColors = true;
  } else if (input.holographic === false || (input.secondary_color !== undefined && isNone(input.secondary_color))) {
    body.colors = { primary_color: primary, secondary_color: null, tertiary_color: null };
    changes.push("solid color");
    setsColors = true;
  }

  const wantsIcon = (input.icon_url !== undefined && !isNone(input.icon_url)) || (input.icon_emoji !== undefined && !isNone(input.icon_emoji));
  if (wantsIcon && !has("ROLE_ICONS")) {
    return { ok: false, reason: "Role icons need boost level 2 (the Role Icons feature), which this server does not have." };
  }
  if (input.icon_url !== undefined) {
    if (isNone(input.icon_url)) {
      body.icon = null;
      changes.push("icon image removed");
    } else {
      const image = await fetchImageAsDataUri(input.icon_url, MAX_EMOJI_BYTES);
      if (!image.ok) return { ok: false, reason: `The role icon: ${image.error}` };
      body.icon = image.dataUri;
      body.unicode_emoji = null;
      changes.push("icon image");
    }
  }
  if (input.icon_emoji !== undefined) {
    if (isNone(input.icon_emoji)) {
      body.unicode_emoji = null;
      changes.push("icon emoji removed");
    } else {
      const found = resolveEmojiInput(input.icon_emoji, []);
      if (!found.ok || found.custom) {
        return { ok: false, reason: "icon_emoji takes a standard emoji character. For a custom emoji's picture, pass its image as icon_url." };
      }
      body.unicode_emoji = found.api;
      body.icon = null;
      changes.push(`icon ${found.api}`);
    }
  }
  return { ok: true, body, changes, setsColors };
}
