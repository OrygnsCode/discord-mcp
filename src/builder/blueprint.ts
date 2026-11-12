import { z } from "zod";

// The blueprint is the contract between the AI client and the builder.
// The client AI translates a conversation ("I want a dark fantasy guild
// with mod channels and an LFG role") into this structure; this server
// validates it, plans it, and executes it. The blueprint deliberately
// references roles by name rather than ID so it stays portable across
// servers and across time.

const hexColor = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, "Use a hex color like #5865f2");

// Exports carry each item's Discord id. With an id, a blueprint item means
// that exact role or channel, so a different name renames it. Without one,
// items match by name.
const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, "A Discord id: 17 to 20 digits")
  .optional()
  .describe("Discord id from export_server_blueprint. Matches this exact item, so a new name renames it.");

const privateTo = z.array(z.string()).nullable().optional();

// Everything about a role's access in one channel that private_to,
// read_only, and posting_roles do not cover.
const rolePermissions = z
  .array(
    z.object({
      role: z.string().min(1).max(100).describe("Role name, or @everyone."),
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
  )
  .max(50)
  .optional()
  .describe(
    "Extra permissions per role here, beyond who can see and post " +
      '(private_to, read_only, posting_roles). Example: [{"role": "Event ' +
      'Staff", "allow": ["mention_everyone", "embed_links"]}]. A listed ' +
      "role's extras become exactly these; roles not listed keep theirs."
  );

export type BlueprintRolePermission = { role: string; allow?: string[]; deny?: string[] };

export const blueprintRoleSchema = z.object({
  id: snowflake,
  name: z.string().min(1).max(100),
  preset: z
    .enum(["none", "member", "moderator", "admin"])
    .optional()
    .describe("Vetted permission bundle. Administrator is never included."),
  permissions: z
    .array(z.string())
    .optional()
    .describe("Extra permission names beyond the preset."),
  color: hexColor.nullable().optional().describe("null clears it."),
  hoist: z.boolean().optional()
    .describe("Show members with this role separately in the sidebar."),
  mentionable: z.boolean().optional(),
});

export const blueprintChannelSchema = z.object({
  id: snowflake,
  name: z.string().min(1).max(100),
  type: z
    .enum(["text", "voice", "forum", "stage", "announcement"])
    .optional()
    .describe("Default text."),
  topic: z.string().max(1024).optional(),
  slowmode_seconds: z.number().int().min(0).max(21600).optional(),
  nsfw: z.boolean().optional(),
  private_to: privateTo.describe(
    "Role names that can see this channel; everyone else is denied view. " +
      "[] leaves only admins. null makes it visible to everyone. Omit to " +
      "follow the category."
  ),
  read_only: z.boolean().optional()
    .describe("Deny sending for everyone; for rules and announcements."),
  posting_roles: z
    .array(z.string())
    .optional()
    .describe("With read_only: role names that may still post and start threads."),
  permissions: rolePermissions,
});

export const blueprintCategorySchema = z.object({
  id: snowflake,
  name: z.string().min(1).max(100),
  private_to: privateTo.describe(
    "Role names that can see the whole category. [] leaves only admins. " +
      "null makes it visible to everyone."
  ),
  permissions: rolePermissions,
  channels: z.array(blueprintChannelSchema).max(50),
});

// Discord's structural limits, from the developer docs. The schema caps
// below match them so a blueprint can hold any server Discord itself
// allows; tighter caps here would make a large server unexportable while
// adding nothing, since the planner checks these same numbers against the
// live server (existing entities plus what the blueprint adds), which is
// the check that actually matters. Kept in one place so the two cannot
// disagree.
export const DISCORD_LIMITS = {
  rolesPerGuild: 250,
  channelsPerGuild: 500,
  channelsPerCategory: 50,
  categoriesPerGuild: 50,
} as const;

export const blueprintSchema = z.object({
  name: z.string().max(100).optional()
    .describe("Optional label for saving or referencing this blueprint."),
  theme: z.string().max(500).optional()
    .describe("Freeform note recording the intent and naming style."),
  roles: z
    .array(blueprintRoleSchema)
    .max(DISCORD_LIMITS.rolesPerGuild)
    .optional()
    .describe(
      "Highest role first, the way the server settings list them. A build " +
        "creates them in this order and that order is the hierarchy."
    ),
  categories: z
    .array(blueprintCategorySchema)
    .max(DISCORD_LIMITS.categoriesPerGuild)
    .optional(),
  channels: z
    .array(blueprintChannelSchema)
    .max(DISCORD_LIMITS.channelsPerGuild)
    .optional()
    .describe("Top-level channels outside any category."),
});

export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintRole = z.infer<typeof blueprintRoleSchema>;
export type BlueprintChannel = z.infer<typeof blueprintChannelSchema>;
export type BlueprintCategory = z.infer<typeof blueprintCategorySchema>;

// Discord rewrites text-like channel names on creation: lowercased, spaces
// become hyphens. Collision detection has to compare what Discord will
// store, not what the blueprint says. Voice, stage, and category names
// keep their spacing and case.
export function normalizedChannelName(name: string, type?: string): string {
  const kind = type ?? "text";
  if (kind === "voice" || kind === "stage") return name.trim();
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}
