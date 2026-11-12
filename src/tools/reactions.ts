import { z } from "zod";
import { channelLabel } from "../discord/grants.js";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIEmoji,
  APIMessage,
  APIUser,
  RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getBotUser } from "../discord/guildData.js";
import { resolveEmojiInput } from "../discord/emoji.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import { describeDuration } from "./community.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  resolveMember,
  ToolProblem,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
  confirmTokenParam,
  messageIdParam,
} from "./common.js";

// Reactions and polls.

const P = PermissionFlagsBits;

async function resolveEmoji(
  rest: REST,
  guildId: string,
  input: string,
  known?: APIEmoji[]
): Promise<{ api: string; display: string }> {
  const guildEmojis = known ?? ((await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[]);
  const result = resolveEmojiInput(input, guildEmojis);
  if (!result.ok) {
    throw new ToolProblem(
      fail(result.reason, result.candidates ? { candidates: result.candidates } : {})
    );
  }
  return { api: result.api, display: result.display };
}

export function registerReactionTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "add_reactions",
    {
      title: "Add reactions",
      description:
        "Add one or more reactions to a message in a single call. Takes " +
        "unicode emoji directly or custom emoji by name.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        emojis: z.array(z.string()).min(1).max(10)
          .describe("Emoji to add, like a pasted emoji or a custom emoji name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, emojis }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [
          [P.AddReactions, "Add Reactions"],
          [P.ReadMessageHistory, "Read Message History"],
        ],
        `in ${channelLabel(target)}`
      );

      // Every emoji is worked out before the first reaction goes on, from one
      // read of the server's emoji. A name that matches nothing used to fail
      // the call after the reactions before it were already added, with no
      // word that they had been.
      const guildEmojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
      const wanted: Array<{ api: string; display: string }> = [];
      for (const input of emojis) wanted.push(await resolveEmoji(rest, guildId, input, guildEmojis));

      const added: string[] = [];
      for (const emoji of wanted) {
        try {
          await rest.put(
            Routes.channelMessageOwnReaction(
              target.id,
              message_id,
              encodeURIComponent(emoji.api)
            )
          );
        } catch (err) {
          // Nothing added yet: the failure stands as it is. Otherwise the
          // result has to say what did go on.
          if (added.length === 0) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          const untried = wanted.length - added.length - 1;
          return fail(
            `Added ${added.join(" ")} to the message, then ${emoji.display} failed: ${reason}.` +
              (untried > 0 ? ` The ${untried} after it ${untried === 1 ? "was" : "were"} not tried.` : ""),
            { added, failed: emoji.display }
          );
        }
        added.push(emoji.display);
      }
      return ok(
        `Added ${added.length} reaction(s) to the message: ${added.join(" ")}.`,
        { added }
      );
    })
  );

  server.registerTool(
    "remove_reaction",
    {
      title: "Remove reaction",
      description:
        "Remove a reaction: the bot's own by default, or another user's " +
        "(which needs Manage Messages).",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        emoji: z.string(),
        user: z.string().optional()
          .describe("Whose reaction to remove; omit for the bot's own."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, emoji, user }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);
      const resolved = await resolveEmoji(rest, guildId, emoji);
      const encoded = encodeURIComponent(resolved.api);

      if (user) {
        const member = await resolveMember(rest, guildId, user);
        if (!member.user) return fail(`Could not load member "${user}".`);
        const botUser = await getBotUser(rest);
        if (member.user.id !== botUser.id) {
          const perms = await botPermissions(rest, guildId, target);
          requirePermissions(
            perms,
            [[P.ManageMessages, "Manage Messages"]],
            `in ${channelLabel(target)}`
          );
        }
        await rest.delete(
          Routes.channelMessageUserReaction(target.id, message_id, encoded, member.user.id)
        );
        return ok(`Removed ${resolved.display} reaction by ${quoted(member.user.username)}.`, {
          removed: resolved.display,
          user: member.user.id,
        });
      }

      await rest.delete(
        Routes.channelMessageOwnReaction(target.id, message_id, encoded)
      );
      return ok(`Removed the bot's ${resolved.display} reaction.`, {
        removed: resolved.display,
      });
    })
  );

  server.registerTool(
    "clear_reactions",
    {
      title: "Clear reactions",
      description:
        "Clear all reactions from a message, or all of one emoji. Safe to " +
        "call directly: the first call changes nothing and returns a " +
        "preview plus a confirm_token; repeating the call with the token " +
        "executes. Relay the preview for the user's go-ahead.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        emoji: z.string().optional()
          .describe("Only clear this emoji; omit to clear everything."),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ channel, guild, message_id, emoji, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.ManageMessages, "Manage Messages"]],
        `in ${channelLabel(target)}`
      );

      const resolved = emoji ? await resolveEmoji(rest, guildId, emoji) : undefined;
      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;
      const reactionCount = (message.reactions ?? []).reduce(
        (sum, r) => sum + r.count,
        0
      );

      const gate = gateDestructive({
        tool: "clear_reactions",
        args: { channel: target.id, message_id, emoji: resolved?.api ?? "all" },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary: resolved
          ? `Would clear every ${resolved.display} reaction from the message.`
          : `Would clear all ${reactionCount} reaction(s) from the message.`,
        previewDetails: { total_reactions: reactionCount },
      });
      if (gate) return gate;

      if (resolved) {
        await rest.delete(
          Routes.channelMessageReaction(
            target.id,
            message_id,
            encodeURIComponent(resolved.api)
          )
        );
      } else {
        await rest.delete(Routes.channelMessageAllReactions(target.id, message_id));
      }
      return ok(
        resolved
          ? `Cleared ${resolved.display} reactions.`
          : "Cleared all reactions.",
        { cleared: resolved?.display ?? "all" }
      );
    })
  );

  server.registerTool(
    "get_reactions",
    {
      title: "Get reactions",
      description: "Who reacted to a message with a given emoji.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        emoji: z.string(),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max users. Default 25."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild, message_id, emoji, limit }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);
      const resolved = await resolveEmoji(rest, guildId, emoji);

      const users = (await rest.get(
        Routes.channelMessageReaction(
          target.id,
          message_id,
          encodeURIComponent(resolved.api)
        ),
        { query: new URLSearchParams({ limit: String(limit ?? 25) }) }
      )) as APIUser[];

      // A full page is a floor, not a count: Discord returns at most the
      // limit, and more people may have reacted.
      const cap = limit ?? 25;
      const full = users.length >= cap;
      return ok(
        full
          ? `At least ${users.length} user(s) reacted with ${resolved.display}; these are the first ${users.length}` +
              (cap < 100 ? ", and a higher limit (up to 100) lists more." : ".")
          : `${users.length} user(s) reacted with ${resolved.display}.`,
        {
          emoji: resolved.display,
          more: full,
          users: users.map((u) => ({
            id: u.id,
            name: u.global_name ?? u.username,
            bot: u.bot ?? false,
          })),
        }
      );
    })
  );

  server.registerTool(
    "create_poll",
    {
      title: "Create poll",
      description:
        "Post a native Discord poll: a question, two to ten answers, and " +
        "a duration of up to 32 days.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        question: z.string().min(1).max(300),
        answers: z.array(z.string().min(1).max(55)).min(2).max(10),
        duration_hours: z.number().int().min(1).max(768).optional()
          .describe("How long the poll runs. Default 24."),
        multi_select: z.boolean().optional()
          .describe("Allow choosing several answers."),
        content: z.string().max(2000).optional()
          .describe("Optional message text above the poll."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      channel,
      guild,
      question,
      answers,
      duration_hours,
      multi_select,
      content,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.SendMessages, "Send Messages"]],
        `in ${channelLabel(target)}`
      );

      const body: RESTPostAPIChannelMessageJSONBody = {
        ...(content ? { content } : {}),
        // Mentions suppressed in the optional text above the poll.
        allowed_mentions: { parse: [] },
        poll: {
          question: { text: question },
          answers: answers.map((text) => ({ poll_media: { text } })),
          duration: duration_hours ?? 24,
          allow_multiselect: multi_select ?? false,
          layout_type: 1 as never,
        },
      };
      const sent = (await rest.post(Routes.channelMessages(target.id), {
        body,
      })) as APIMessage;

      return ok(
        `Poll posted in ${channelLabel(target)}: "${question}" with ` +
          `${answers.length} answers, running ${duration_hours ?? 24} hour(s).`,
        {
          id: sent.id,
          channel: { id: target.id, name: target.name },
          jump_link: `https://discord.com/channels/${guildId}/${target.id}/${sent.id}`,
        }
      );
    })
  );

  server.registerTool(
    "get_poll_results",
    {
      title: "Get poll results",
      description:
        "Current tallies for a poll message. With include_voters, also who " +
        "voted for each answer.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        include_voters: z.boolean().optional()
          .describe("Also list the people who chose each answer."),
        voters_per_answer: z.number().int().min(1).max(1000).optional()
          .describe("How many voters to list per answer when include_voters is on. Default 100."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild, message_id, include_voters, voters_per_answer }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;
      if (!message.poll) {
        return fail("That message has no poll.");
      }
      const counts = new Map(
        (message.poll.results?.answer_counts ?? []).map((c) => [c.id, c.count])
      );
      const cap = voters_per_answer ?? 100;
      const results = [];
      let shortLists = 0;
      for (const a of message.poll.answers) {
        const votes = counts.get(a.answer_id) ?? 0;
        if (!include_voters) {
          results.push({ text: a.poll_media.text ?? "", votes });
          continue;
        }
        // Discord pages voters 100 at a time, oldest user id first.
        const voters: Array<{ id: string; name: string }> = [];
        let after: string | undefined;
        while (votes > 0 && voters.length < cap) {
          const limit = Math.min(100, cap - voters.length);
          const page = (await rest.get(
            Routes.pollAnswerVoters(target.id, message_id, a.answer_id),
            { query: new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) }) }
          )) as { users?: APIUser[] };
          const users = page.users ?? [];
          for (const u of users) voters.push({ id: u.id, name: u.global_name ?? u.username });
          if (users.length < limit) break;
          after = users[users.length - 1].id;
        }
        const unlisted = Math.max(0, votes - voters.length);
        if (unlisted > 0) shortLists++;
        results.push({
          text: a.poll_media.text ?? "",
          votes,
          voters,
          ...(unlisted > 0 ? { voters_not_listed: unlisted } : {}),
        });
      }
      const total = results.reduce((sum, r) => sum + r.votes, 0);
      const finalized = message.poll.results?.is_finalized ?? false;

      return ok(
        `Poll ${quoted(message.poll.question.text, 300)}: ${total} vote(s)` +
          (finalized ? ", finished." : ", still open."),
        {
          question: message.poll.question.text,
          finalized,
          multi_select: message.poll.allow_multiselect,
          expires_at: message.poll.expiry,
          answers: results,
        },
        shortLists > 0
          ? [
              `Voters are listed up to ${cap} per answer; raise voters_per_answer ` +
                "(up to 1000) to see more.",
            ]
          : []
      );
    })
  );

  server.registerTool(
    "end_poll",
    {
      title: "End poll",
      description:
        "Close one of the bot's own polls early and finalize the results. " +
        "Voting stops for good, since a poll cannot be reopened. Safe to " +
        "call directly: the first call changes nothing and returns a " +
        "preview plus a confirm_token; repeating the call with the token " +
        "ends the poll. A poll that has already closed is left alone.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ channel, guild, message_id, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;
      if (!message.poll) return fail("That message has no poll.");
      const botUser = await getBotUser(rest);
      if (message.author.id !== botUser.id) {
        return fail(
          "Only the poll's creator can end it early, and that poll was " +
            `posted by ${quoted(message.author.username)}, not the bot.`
        );
      }

      const question = message.poll.question.text;
      const closes = message.poll.expiry ? new Date(message.poll.expiry).getTime() : undefined;
      if (message.poll.results?.is_finalized === true || (closes !== undefined && closes <= Date.now())) {
        return ok(`The poll ${quoted(question, 300)} has already closed. Nothing to do.`, { ended: false, id: message_id });
      }
      const votes = (message.poll.results?.answer_counts ?? []).reduce((n, a) => n + a.count, 0);
      const gate = gateDestructive({
        tool: "end_poll",
        args: { channel: target.id, message_id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would end the poll ${quoted(question, 300)} in ${channelLabel(target)} now` +
          (closes !== undefined ? `, ${describeDuration(Math.round((closes - Date.now()) / 1000))} before it closes on its own` : "") +
          `, with ${votes} vote(s) in. Voting stops and the results become final; a poll cannot be reopened.`,
        previewDetails: {
          channel: { id: target.id, name: target.name },
          poll: { id: message_id, question, votes, closes_at: message.poll.expiry ?? null },
        },
      });
      if (gate) return gate;

      await rest.post(Routes.expirePoll(target.id, message_id));
      return ok(`Ended the poll ${quoted(question, 300)}.`, {
        ended: true,
        id: message_id,
      });
    })
  );
}
