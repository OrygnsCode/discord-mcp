import { z } from "zod";
import { Routes, PermissionFlagsBits, ChannelFlags } from "discord-api-types/v10";
import type {
  APIThreadChannel,
  RESTGetAPIGuildThreadsResult,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getChannels, invalidateGuildCaches, type GuildChannelLite } from "../discord/guildData.js";
import { resolveOne } from "../discord/resolve.js";
import { gateDestructive } from "../safety.js";
import { plainText, quoted } from "../discord/names.js";
import { channelLabel } from "../discord/grants.js";
import { ok, fail } from "../envelope.js";
import { filesParam, prepareFiles, type PreparedFiles } from "../discord/uploads.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  ToolProblem,
  botPermissions,
  requirePermissions,
  embedsParam,
  embedFilesProblem,
  mapEmbeds,
  confirmTokenParam,
  archivedThreads,
} from "./common.js";

// Forum channels: posts are threads underneath, tags live on the channel.

const P = PermissionFlagsBits;

interface ForumTag {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

interface ForumChannel extends GuildChannelLite {
  available_tags?: ForumTag[];
}

async function resolveForum(
  rest: REST,
  guildId: string,
  query: string
): Promise<ForumChannel> {
  return (await resolveChannel(rest, guildId, query, [15])) as ForumChannel;
}

// The forum with its tags as they are right now. Adding, changing, or
// removing a tag sends the whole tag list back, and the channel list it
// would otherwise come from can be half a minute old: a tag someone added
// in that time was dropped by the next edit here.
async function withCurrentTags(rest: REST, forum: ForumChannel): Promise<ForumChannel> {
  const now = (await rest.get(Routes.channel(forum.id))) as ForumChannel;
  return { ...forum, available_tags: now.available_tags ?? [] };
}

function resolveTagByName(
  forum: ForumChannel,
  name: string
): ForumTag {
  const tags = forum.available_tags ?? [];
  const resolution = resolveOne(
    name,
    tags
      .filter((t) => t.id)
      .map((t) => ({ id: t.id as string, name: t.name, type: "tag" }))
  );
  if ("match" in resolution) {
    const tag = tags.find((t) => t.id === resolution.match.id);
    if (tag) return tag;
  }
  throw new ToolProblem(
    fail(`No single tag matching "${name}" on this forum.`, {
      available: tags.map((t) => t.name),
    })
  );
}

function postDigest(t: APIThreadChannel, forum?: ForumChannel) {
  const tagNames = new Map(
    (forum?.available_tags ?? []).map((tag) => [tag.id, tag.name])
  );
  return {
    id: t.id,
    title: t.name,
    archived: t.thread_metadata?.archived ?? false,
    locked: t.thread_metadata?.locked ?? false,
    pinned: ((t.flags ?? 0) & ChannelFlags.Pinned) !== 0,
    message_count: t.message_count ?? 0,
    tags: (t.applied_tags ?? []).map((id) => tagNames.get(id) ?? id),
  };
}

export function registerForumTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "create_forum_post",
    {
      title: "Create forum post",
      description:
        "Start a post in a forum channel: a title, the opening message, " +
        "optional tags from the forum's tag list, and up to 10 files fetched " +
        "from public URLs.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        title: z.string().min(1).max(100),
        content: z.string().min(1).max(2000),
        tags: z.array(z.string()).max(5).optional()
          .describe("Tag names to apply."),
        files: filesParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ forum, guild, title, content, tags, files }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveForum(rest, guildId, forum);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [
          [P.SendMessages, "Send Messages"],
          ...(files ? ([[P.AttachFiles, "Attach Files"]] as Array<[bigint, string]>) : []),
        ],
        `in ${channelLabel(target)}`
      );

      const appliedTags = (tags ?? []).map(
        (name) => resolveTagByName(target, name).id as string
      );

      let prepared: PreparedFiles | undefined;
      if (files) {
        const got = await prepareFiles(files);
        if (!got.ok) return fail(`Nothing was posted. ${got.error}`);
        prepared = got.value;
      }

      const post = (await rest.post(Routes.threads(target.id), {
        body: {
          name: title,
          // Mentions suppressed: a model echoing user text into a new
          // forum post must not be able to mass-ping by accident.
          message: {
            content,
            allowed_mentions: { parse: [] },
            ...(prepared ? { attachments: prepared.attachments } : {}),
          },
          ...(appliedTags.length > 0 ? { applied_tags: appliedTags } : {}),
        },
        ...(prepared ? { files: prepared.files } : {}),
        reason: "Created via discord-mcp",
      })) as APIThreadChannel;

      return ok(
        `Posted "${title}" in ${channelLabel(target)}` +
          (tags?.length ? ` tagged ${tags.join(", ")}` : "") +
          (prepared ? ` with ${prepared.files.length} file(s)` : "") +
          ".",
        { ...postDigest(post, target), ...(prepared ? { files: prepared.summary } : {}) }
      );
    })
  );

  server.registerTool(
    "list_forum_posts",
    {
      title: "List forum posts",
      description: "Posts in a forum, filterable by tag, optionally archived too.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        tag: z.string().optional().describe("Only posts carrying this tag."),
        include_archived: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ forum, guild, tag, include_archived }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveForum(rest, guildId, forum);

      const tagId = tag ? resolveTagByName(target, tag).id : undefined;

      const activeResult = (await rest.get(
        Routes.guildActiveThreads(guildId)
      )) as RESTGetAPIGuildThreadsResult;
      let posts = ((activeResult.threads ?? []) as APIThreadChannel[]).filter(
        (t) => t.parent_id === target.id
      );
      let moreArchived = false;
      if (include_archived) {
        const archived = await archivedThreads(rest, target.id);
        posts = posts.concat(archived.threads);
        moreArchived = archived.more;
      }
      if (tagId) {
        posts = posts.filter((t) => (t.applied_tags ?? []).includes(tagId));
      }

      return ok(
        `${posts.length} post(s) in ${channelLabel(target)}` +
          (tag ? ` tagged ${tag}` : "") +
          (moreArchived ? ", counting only the most recently archived" : "") +
          ".",
        { posts: posts.map((p) => postDigest(p, target)), ...(include_archived ? { more_archived: moreArchived } : {}) },
        moreArchived ? ["Older archived posts exist beyond the ones read; they were left out."] : []
      );
    })
  );

  server.registerTool(
    "reply_to_forum_post",
    {
      title: "Reply to forum post",
      description: "Add a reply inside a forum post: text, embeds, or both.",
      inputSchema: {
        post: z.string().describe("Post title or thread ID."),
        guild: guildParam,
        content: z.string().min(1).max(2000).optional()
          .describe("Reply text. May be left out when embeds carry the reply."),
        embeds: embedsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ post, guild, content, embeds }) => {
      if (content === undefined && !(embeds && embeds.length > 0)) {
        return fail("Pass content or embeds.");
      }
      // Both are decided from the arguments, so neither costs a request.
      const cards = embeds && embeds.length > 0 ? mapEmbeds(embeds) : undefined;
      const lost = embedFilesProblem(embeds, [], {
        some: "",
        none:
          "reply_to_forum_post sends no files. Use an http or https link, or reply with " +
          "send_message, which takes the post as its channel and sends files.",
      });
      if (lost) return fail(`Nothing was sent. ${lost}`);
      const { rest, guildId } = await enter(config, guild);
      const found = await findPost(rest, guildId, post);

      const sent = (await rest.post(Routes.channelMessages(found.id), {
        body: {
          ...(content !== undefined ? { content } : {}),
          allowed_mentions: { parse: [] },
          ...(cards ? { embeds: cards } : {}),
        },
      })) as { id: string };

      return ok(`Replied in ${quoted(found.name)}.`, {
        id: sent.id,
        post: { id: found.id, title: found.name },
      });
    })
  );

  server.registerTool(
    "update_forum_post",
    {
      title: "Update forum post",
      description:
        "Edit a post's title or tags, pin or unpin it within the forum, " +
        "lock or unlock replies, or archive it.",
      inputSchema: {
        post: z.string().describe("Post title or thread ID."),
        guild: guildParam,
        title: z.string().min(1).max(100).optional(),
        tags: z.array(z.string()).max(5).optional()
          .describe("Replace the applied tags with these."),
        pinned: z.boolean().optional(),
        locked: z.boolean().optional(),
        archived: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ post, guild, title, tags, pinned, locked, archived }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await findPost(rest, guildId, post);

      const changes: string[] = [];
      const body: Record<string, unknown> = {};
      if (title !== undefined) {
        body.name = title;
        changes.push(`title to "${title}"`);
      }
      if (tags !== undefined) {
        const forum = found.parent_id
          ? await resolveForum(rest, guildId, found.parent_id)
          : undefined;
        if (!forum) return fail("Could not load the parent forum for tags.");
        body.applied_tags = tags.map((n) => resolveTagByName(forum, n).id);
        changes.push(`tags to ${tags.join(", ") || "none"}`);
      }
      if (pinned !== undefined) {
        const current = (found.flags ?? 0) & ~ChannelFlags.Pinned;
        body.flags = pinned ? current | ChannelFlags.Pinned : current;
        changes.push(pinned ? "pinned" : "unpinned");
      }
      if (locked !== undefined) {
        body.locked = locked;
        changes.push(locked ? "locked" : "unlocked");
      }
      if (archived !== undefined) {
        body.archived = archived;
        changes.push(archived ? "archived" : "unarchived");
      }
      if (changes.length === 0) return fail("Pass at least one field to change.");

      await rest.patch(Routes.channel(found.id), {
        body,
        reason: "Updated via discord-mcp",
      });
      return ok(`Updated ${quoted(found.name)}: ${changes.join(", ")}.`, {
        id: found.id,
        changed: changes,
      });
    })
  );

  server.registerTool(
    "delete_forum_post",
    {
      title: "Delete forum post",
      description:
        "Delete a forum post and every reply in it. Safe to call " +
        "directly: the first call changes nothing and returns a preview " +
        "plus a confirm_token; repeating the call with the token deletes it.",
      inputSchema: {
        post: z.string().describe("Post title or thread ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ post, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await findPost(rest, guildId, post);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageThreads, "Manage Threads"]], "in this server");

      const gate = gateDestructive({
        tool: "delete_forum_post",
        args: { post: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the post ${quoted(found.name)} and its ` +
          `${found.message_count ?? 0} message(s) forever.`,
        previewDetails: { id: found.id, title: found.name },
      });
      if (gate) return gate;

      await rest.delete(Routes.channel(found.id), {
        reason: reason ?? "Deleted via discord-mcp",
      });
      return ok(`Deleted the post ${quoted(found.name)}.`, {
        deleted: true,
        id: found.id,
      });
    })
  );

  server.registerTool(
    "create_forum_tag",
    {
      title: "Create forum tag",
      description:
        "Add a tag to a forum's tag list. Moderated tags can only be " +
        "applied by people with Manage Threads.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(20),
        moderated: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ forum, guild, name, moderated }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await withCurrentTags(rest, await resolveForum(rest, guildId, forum));

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `for ${channelLabel(target)}`);

      const existing = target.available_tags ?? [];
      if (existing.length >= 20) {
        return fail("Forums hold at most 20 tags.");
      }
      if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        return fail(`A tag named "${name}" already exists on this forum.`);
      }

      const updated = (await rest.patch(Routes.channel(target.id), {
        body: {
          available_tags: [
            ...existing,
            { name, moderated: moderated ?? false },
          ],
        },
        reason: "Tag added via discord-mcp",
      })) as ForumChannel;
      invalidateGuildCaches(guildId);

      const created = (updated.available_tags ?? []).find(
        (t) => t.name === name
      );
      return ok(`Added the tag "${name}" to ${channelLabel(target)}.`, {
        id: created?.id ?? null,
        name,
        moderated: moderated ?? false,
      });
    })
  );

  server.registerTool(
    "update_forum_tag",
    {
      title: "Update forum tag",
      description: "Rename a forum tag or change its moderated flag.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        tag: z.string().describe("Current tag name."),
        name: z.string().min(1).max(20).optional(),
        moderated: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ forum, guild, tag, name, moderated }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await withCurrentTags(rest, await resolveForum(rest, guildId, forum));
      if (name === undefined && moderated === undefined) {
        return fail("Pass name or moderated to change.");
      }

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `for ${channelLabel(target)}`);

      const current = resolveTagByName(target, tag);
      const updatedTags = (target.available_tags ?? []).map((t) =>
        t.id === current.id
          ? {
              ...t,
              ...(name !== undefined ? { name } : {}),
              ...(moderated !== undefined ? { moderated } : {}),
            }
          : t
      );

      await rest.patch(Routes.channel(target.id), {
        body: { available_tags: updatedTags },
        reason: "Tag updated via discord-mcp",
      });
      invalidateGuildCaches(guildId);

      return ok(
        `Updated the tag ${quoted(current.name)}` +
          (name ? ` to "${name}"` : "") +
          ".",
        { id: current.id, name: name ?? current.name }
      );
    })
  );

  server.registerTool(
    "delete_forum_tag",
    {
      title: "Delete forum tag",
      description:
        "Remove a tag from a forum; posts carrying it simply lose it. " +
        "Safe to call directly: the first call changes nothing and " +
        "returns a preview plus a confirm_token; repeating the call with " +
        "the token removes it.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        tag: z.string().describe("Tag name to remove."),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ forum, guild, tag, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await withCurrentTags(rest, await resolveForum(rest, guildId, forum));

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `for ${channelLabel(target)}`);

      const current = resolveTagByName(target, tag);
      const gate = gateDestructive({
        tool: "delete_forum_tag",
        args: { forum: target.id, tag: current.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would remove the tag ${quoted(current.name)} from #${plainText(target.name)}; ` +
          "posts carrying it lose it.",
        previewDetails: { id: current.id, name: current.name },
      });
      if (gate) return gate;

      await rest.patch(Routes.channel(target.id), {
        body: {
          available_tags: (target.available_tags ?? []).filter(
            (t) => t.id !== current.id
          ),
        },
        reason: "Tag removed via discord-mcp",
      });
      invalidateGuildCaches(guildId);

      return ok(`Removed the tag ${quoted(current.name)} from ${channelLabel(target)}.`, {
        deleted: true,
        id: current.id,
      });
    })
  );

  // Post resolution shared by the tools above: active threads whose
  // parent is a forum, by title or ID, with the direct-ID fallback.
  async function findPost(
    rest: REST,
    guildId: string,
    query: string
  ): Promise<APIThreadChannel> {
    // Forum and media channels: only threads under one of these are posts.
    // Every active thread in the server used to count, so a post tool given
    // a name could land on an ordinary thread in a text channel.
    const forums = new Set(
      (await getChannels(rest, guildId)).filter((c) => c.type === 15 || c.type === 16).map((c) => c.id)
    );
    const activeResult = (await rest.get(
      Routes.guildActiveThreads(guildId)
    )) as RESTGetAPIGuildThreadsResult;
    const posts = ((activeResult.threads ?? []) as APIThreadChannel[]).filter(
      (p) => p.parent_id && forums.has(p.parent_id)
    );
    const resolution = resolveOne(
      query,
      posts.map((p) => ({ id: p.id, name: p.name ?? "", type: "post" }))
    );
    if ("match" in resolution) {
      const found = posts.find((p) => p.id === resolution.match.id);
      if (found) return found;
    }
    if (/^\d{17,20}$/.test(query.trim())) {
      const direct = (await resolveChannel(rest, guildId, query, [10, 11, 12])) as unknown as APIThreadChannel;
      if (!direct.parent_id || !forums.has(direct.parent_id)) {
        throw new ToolProblem(
          fail(`${quoted(direct.name ?? query)} is a thread in a text channel, not a forum post. The thread tools work on it.`)
        );
      }
      return direct;
    }
    const candidates = "candidates" in resolution ? resolution.candidates : [];
    throw new ToolProblem(
      candidates.length === 0
        ? fail(`No active post matching "${query}".`)
        : fail(`Multiple posts match "${query}". Pick one by ID.`, { candidates })
    );
  }
}
