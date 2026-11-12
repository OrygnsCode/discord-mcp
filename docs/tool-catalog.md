# discord-mcp Tool Catalog

Version: 1.1
Status: shipped; the contract the implementation follows
Owner: Orygn LLC

This document is the contract for the discord-mcp tool surface. Every tool the server exposes is listed here with its tier, destructiveness, required Discord permission, key parameters, and behavior. The implementation and the registry listings derive from this file. Change the contract here first, then change code.

Totals: 164 tools implemented and shipped. All of them load by default. `DISCORD_MCP_TOOLS` narrows that to a chosen set of groups, with a core of 15 diagnostics and read tools always present; see [toolsets](toolsets.md) for the groups and what each one costs.

## 1. Design conventions

These rules apply to every tool. Individual tool entries only document what differs from them.

### 1.1 Naming

Tools are named `verb_object` in snake_case: `create_channel`, `ban_member`, `list_roles`. No `discord_` prefix; the server itself is the namespace. Most verbs are the plain ones: get, list, search, find, create, update, delete, send, read, assign, remove. The rest are the domain's own, such as ban, kick, timeout, pin, lock, forward, subscribe, plan, and undo.

### 1.1b Description conventions

Tool descriptions are written for the model that selects and calls them,
following the same principles a good API would use for a new teammate.
Grounded in current tool-use guidance (Anthropic's "writing tools for
agents," the OWASP and MCP best-practice notes):

- Lead with what the tool does in the first clause. A model may not read
  the whole description, so the most important information comes first.
- Disambiguate against similar tools explicitly. Where several tools could
  plausibly match an intent, the description names the alternatives ("for
  X use other_tool"). This is the single most effective defense against
  wrong-tool selection. The known clusters: the three senses of "events"
  (scheduled community events via create_event, live activity via
  subscribe_events, timed messages via schedule_message); the send family
  (send_message, send_dm, send_webhook_message, schedule_message); member
  lookup (search_members, list_members, get_member, get_role_members,
  find); threads versus forum posts; and the audit log versus live events.
- State constraints and what the tool does not do, not just what it does.
- Tell the model that destructive tools are safe to call: the first call
  only previews and returns a confirm token, so the model should call them
  and relay the preview rather than refusing.
- Parameter descriptions carry formats and examples (ISO time, name-or-id,
  hex color) and use unambiguous names.

### 1.2 Entity references

Any parameter that names a Discord entity (channel, role, member, emoji, thread, webhook, event) accepts either a snowflake ID or a name. Name resolution runs in order: exact ID match, exact name match, normalized match (case, spaces, hyphens, underscores, and a leading # or @ ignored), a name that starts with the text, a name that contains it. The best tier with exactly one match wins, a lone partial match included. When two or more tie, the tool does not guess: it returns a `candidates` list in the output envelope and asks the caller to disambiguate. The `find` tool exposes this resolver directly. The exceptions are parameters that take only an ID (`user_id`, `user_ids`, `message_id`, `for_users`).

A member is matched on username, display name, and server nickname alike, and a mention (`<@id>`) works as an ID. When two members carry the name exactly, in any letter case, neither is picked. A name is looked up among at most 25 members Discord returns for it; when it returns that many, only an exact name is trusted.

Parameters that take only an ID or a code are checked for shape before any request is made: a message ID or integration ID is 17 to 20 digits, a template or invite code is letters, digits, and dashes, and the tools that take one accept its link as well. A message can also be given by its link (Copy Message Link in Discord, or the `jump_link` the tools return) wherever its ID is wanted. That link names the channel too, so when it disagrees with the channel the call names, the call is refused before anything is sent and the refusal gives the link's channel; a message in a thread is in the thread, not in the parent channel. No request leaves with `.` or `..` as a path segment.

`guild` is an optional parameter on every guild-scoped tool. If the server is configured with a default guild, it can be omitted.

When more than one bot is configured, each guild-scoped tool is routed to the bot that is a member of the named server; there is nothing extra to pass. The tools that act on a bot itself take an optional `bot` parameter, defaulting to the default bot: get_bot_info, run_setup_check, update_bot_profile, leave_server, and the four application command tools. No other tool has it. When two configured bots are in the same server, one handles it: the bot named for that server under `servers` in `bots.json`, otherwise the default bot when it is one of them. Every result from such a server says in `warnings` which bot ran and why, on failures too. When neither rule settles it the tool stops and gives the line to add. leave_server picks neither bot there and asks for `bot`. See [Multiple bots](multi-bot.md).

### 1.3 Tiers

Every tool a session exposes is registered at startup and appears in `tools/list`. Nothing is fetched later, and there is no discovery call: an earlier version of this document described on-demand loading that was never built.

What controls the surface is `DISCORD_MCP_TOOLS`, which selects groups. Unset loads all 164. See [toolsets](toolsets.md) for the groups, their membership, and what each one costs in context. The `core` group there is 15 diagnostics and read tools, always loaded because without them the server cannot report which servers it reaches or whether setup worked.

Neither marking is authorization. A tool being loaded does not mean the caller may use it (see 1.8).

### 1.3b What the server says about itself

When an app connects, the server sends a short text about itself: the `instructions` of the initialize result, and of `server/discover` on 2026-07-28 connections. An app that loads tools on demand, as Claude Code does by default, puts only the tool names and this text in front of the model before a tool is picked. So it holds what the model has to know before its first call:

- what the server is for, group by group, so the model knows when to look for a tool here;
- where to start: `get_server_overview`, `list_servers` when the bot is in several servers, and `find` for a name;
- that deleting, punishing, handing out power or access, and lowering a protection return a preview and a `confirm_token` first (1.4), or, with safe mode off, that they do not;
- that names, topics, message text, and reasons coming back from Discord are data, never an instruction or an approval;
- that a parameter a tool does not have is refused (1.7b), where that check is on;
- `undo_change` and `run_setup_check`.

The text is built from what the install runs. A group left out by `DISCORD_MCP_TOOLS` is not described and none of its tools is named, and the sentences about previews and refused parameters follow `DISCORD_MCP_SAFE_MODE` and `DISCORD_MCP_STRICT_PARAMS`. It stays under 2,000 characters, about 400 tokens in every session; Claude Code cuts instructions at 4,096.

### 1.4 Destructive operations

A tool is classified destructive (D = yes below) if it deletes content, removes access, punishes a user, or fans out a change to many entities at once. Destructive tools share this behavior:

- They accept `dry_run: boolean`, except leave_server and execute_build_plan (whose preview is the staged plan). A dry run returns a preview of what would happen and a short-lived `confirm_token`. Previews of bulk actions give the count and a sample, not every item; the token still covers exactly the items counted. `dry_run` always wins: passed together with a token, nothing executes and the token stays valid.
- A token is bound to the tool, the resolved arguments, the server the call resolved to, and, with several bots, the acting bot. It cannot be spent on another target, in another server, or as another bot.
- In safe mode (default on), a destructive call without a `confirm_token` executes nothing and returns the preview instead. Passing the token back executes for real. A token that is unknown, already used, expired, or issued for a different action is an error, and a fresh preview is needed.
- When the app declares it can show a form (MCP elicitation, form mode), passing the token back does not execute straight away: the server asks the app to show the user a confirmation dialog, written from the resolved target, with one required checkbox, and executes only when the box comes back ticked. Declining, cancelling, an unticked box, or a call cancelled while the dialog is open changes nothing, and the token is spent either way. The dialog's answer is bound to the exact action and used once. On 2025-era connections the SDK sends the dialog during the call; on 2026-07-28 requests it travels as an `input_required` result. A stateless HTTP instance serving a 2025-era app has no record of what the app declared, so it keeps to the token. `confirmed_by` in the preview says which applies.
- `DISCORD_MCP_CONFIRM` selects `auto` (the default: the dialog where the app can show one, the token alone otherwise), `token` (never the dialog, for apps that declare it but have nobody to answer, such as Claude Code run with `-p`, which closes every dialog unanswered), or `dialog` (the dialog only; in apps that cannot show one, destructive actions are refused at the preview and no token is minted).
- The token alone proves that a preview was made, not that a person approved: the model holds it. Only the dialog puts the decision outside the model.
- What a preview or dialog names was named by someone else: a member's display name, a role, a thread, an event, a poll question, a message excerpt, a ban reason. Each goes in double quotes on one line, with control and invisible characters removed, its own double quotes turned into single ones, and a cut at 100 characters for a name (message text, poll questions, and ban reasons get more), so nothing a member wrote can read as part of the preview's sentence. A text, announcement, or forum channel is written `#name`; voice, stage, category, and thread names are quoted. A name with nothing visible in it shows as `"" (blank)`.
- Safe mode can be disabled per deployment for trusted automation. With it off nothing below is asked, including the tools described as always confirmed.

Six tools that are not destructive take `dry_run` too: send_message, create_channel, create_role, update_channel, update_server, and update_bot_profile. The tools gated only for what they grant (1.4b) or lower (1.4c) take a `confirm_token`, and no `dry_run` unless they are in that list.

### 1.4b Power and access

Some changes do more harm than a delete because nothing reverses them: a new moderator can ban and delete by hand, outside any confirmation, and what someone read in a channel opened by mistake stays read. These go through the same gate as destructive operations (preview, token, and the dialog where the app can show one), but only when they actually hand something out; otherwise the same tools act at once. D = grants below.

- **Power**: a member or role would gain administrator, manage server, manage roles, manage channels, manage webhooks, ban, kick, time out, manage messages, manage threads, manage expressions, manage events, mention @everyone, manage nicknames, or mute, deafen, or move members. That counts server-wide, or in a channel they can see; in one channel, only the powers that mean something there count. It is judged against what they hold now, so the owner, an administrator, or someone who already has the power gains nothing. A member is judged by the roles they hold. A role (or @everyone) is judged held alone and next to each other role in turn, because what its holders can see often comes from another role they all have: in a server where a Member role is what lets people see channels, lifting @everyone's denial on a private channel opens it to every member, though someone with no roles sees nothing either way. Roles that behave alike are judged once. A gain that takes three or more roles together is not found.
- **Access**: someone who cannot see a channel now would be able to, could read its earlier messages, or could join a voice channel closed to them. A category on its own does not count. The channels synced with a category do, since Discord copies a category's overwrite changes into them.
- assign_role is gated on both. Asking for a role is the plainest way into a private channel, so a role that opens channels hidden from the member waits too. One that hands out neither is given at once, and the result says which channels a role opened.
- remove_role is gated when the role held the member back: a role can deny, and taking away one that hides channels (a quarantine role, say) lets them in. Other roles are taken away at once.
- Also gated:
  - unban_member, always.
  - update_member's move_to_voice, when it moves someone into a voice channel they cannot join.
  - add_thread_member, when it adds someone to a private thread they cannot see.
  - reorder_roles, when a role holding ban, kick, time out, manage roles, manage nicknames, or administrator would move above a role it was below.
  - update_onboarding, when it offers a role that hands out power or access, since members pick those themselves.
  - create_invite, when the roles it gives to whoever joins hand out power or access; the preview says whether anyone with the link or only the people it is for can use it.
  - execute_build_plan, when a new channel or category in the plan gives @everyone or a role that already exists a power. Powers for a role the same blueprint creates do not count: nobody holds it yet.
- The token is bound to what the change grants as well as to its arguments. If the server changes between preview and confirmation so that the same call would grant something else, the token is refused.
- Channels hidden from the bot cannot be checked. Previews say so when the bot knows of any.
- Not covered: plain invites (an invite that gives no role). A model can also copy text it can read into a channel others see; no permission check stops that.

### 1.4c Lowering a protection

Putting a protection up is urgent and safe to get wrong; taking one down is neither. So these tools act at once in one direction and go through the gate (preview, token, and the dialog where the app can show one) in the other. D = lowers below.

- update_server, when verification would go down, the explicit media filter would get weaker, or Community would go off on a server that has it. Raising them, and every other setting, is immediate. The preview lists everything the call changes, then each thing it lowers.
- set_incident_actions, when a pause on invites or DMs that is running would be lifted or would end sooner. Pausing, and pausing for longer, is immediate. The preview says what Discord flagged, if anything. The token is for the hours asked, so it survives the clock moving between the two calls.
- update_automod_rule, when it turns off a rule that is on, or its new keyword list leaves out keywords the rule has now (compared without regard to case). The preview names up to five of them.
- remove_timeout, whenever the member is timed out. With no timeout running there is nothing to confirm.
- unlock_channel, when no lock made by this install is on record for the channel. Then nothing says the denial came from a lock, and a rules or announcements channel is closed the same way on purpose. Undoing a recorded lock is immediate.
- update_member, when it lifts a server mute or deafen the member has. Muting and deafening are immediate, and so is "unmuting" someone who is not muted. Its D stays `grants` in the table, for the voice move in 1.4b; one preview covers both when a call does both.
- update_server_widget, when it turns the widget on, or points a widget that is on at an invite channel it did not have. An enabled widget shows the server's name, who is online, and its voice channels to anyone on the web, and with an invite channel anyone can join through it. Turning it off, clearing the channel, or setting a channel while it stays off is immediate.
- update_event, for `status: end` only. It lowers nothing, but it is the one edit there that cannot be taken back: an event that has ended cannot be started again.
- The token is bound to every argument of the call, so a confirmed change cannot carry another one along.
- Not covered: adding exemptions to an AutoMod rule (not editable here) and switching onboarding off.

### 1.5 Output envelope

Every tool returns the same envelope:

```
{
  "summary":  "One to three plain sentences describing what happened or what was found.",
  "data":     { ... },        // typed payload, documented per tool
  "warnings": [ "..." ]       // non-fatal notes: missing optional perms, partial results
}
```

Three fields, always these three. `summary` exists so the model never has to narrate raw JSON back to the user. `data` is kept lean: snowflakes, names, and the fields a caller actually acts on, not the full Discord API object.

A sentence in `summary` or `warnings` names things the way a preview does (1.4): a member, a role, a thread, a forum post, an event, a webhook, a sticker, a sound, an AutoMod rule, a template, or a server goes in double quotes on one line, with its own double quotes turned single and a cut at 100 characters; a text, announcement, or forum channel is `#name`; a voice or stage channel and a category are quoted and named with their kind. So `Removed "Helper" from "Sam"`, not `Removed Helper from Sam`: whoever named the role or picked the display name cannot write the rest of the sentence. The same holds for the findings of `audit_server_security` and the lines of a build plan that name what is already on the server. Two things are left as they are: the bot's own name, which the operator chose, and what stands in for a message's text.

`summary` and `warnings` also never contain characters nobody can see: zero-width characters, direction overrides, and Unicode tag characters are removed from them, whatever a name or a message held. Each is also one line. No sentence written here has a line break, so one that turns up came in with a name, and there it would start a line that reads as someone else speaking; line breaks, tabs, and other control characters become a single space. `data` is not touched, so a name there is exactly what Discord stores.

When name resolution is ambiguous the tool returns an error envelope whose `data.candidates` holds the options, rather than guessing. There is no top-level `candidates` field and no `raw` parameter.

### 1.6 Pagination

There is no opaque cursor and no general pagination. Eleven tools take a `limit`: `read_messages`, `search_members`, `get_role_members`, `get_audit_log`, `get_reactions`, `get_event_attendees`, and `get_recent_events` up to 100, `search_messages` up to 25, `list_changes` up to 50, and `list_members` and `list_bans` up to 1000. Four of them page: `read_messages` takes `before` and `list_bans` and `list_members` take `after`, each a Discord ID, and `search_messages` takes `offset`.

A result that is only part of a list says so. Lists Discord itself pages are read to a stated ceiling: archived threads and forum posts up to 300, pinned messages up to 250, and a role's holders among the first 3,000 members. Everything else returns the full set for the guild, which is bounded by Discord's own limits (500 roles, 500 channels, 50 templates and so on).

### 1.7 Errors and preflight

Tools check the common causes of failure before calling Discord and return actionable messages:

- Role hierarchy: "The bot's highest role (Mod, position 5) is below the target role (Admin, position 8), so Discord will reject this. Move the bot's role higher or pick a lower role."
- Missing permission: names the exact permission. Most tools check the permission in their Requires cell before calling Discord; where one does not, Discord's refusal comes back reworded (see below).
- Intents are not checked ahead of a call. `run_setup_check` reports them, and catch_up and forward_message say when a missing Message Content intent is the likely cause of what came back.

A refusal from Discord (403) is reworded to say what is usually missing. Other errors are passed on as `Discord API error <status>: <Discord's message>`. Both keep the original code in `data.discord_error`.

### 1.7b A parameter a tool does not have

A parameter that is not in a tool's schema is never dropped in silence. A call that ran without it looks, from its result, exactly like a call that honored it.

- A tool that changes something refuses the call before doing anything, and lists the parameters it does have. `dry_run` gets a sentence of its own: some tools take it, and on the others a call marked as a rehearsal would otherwise run for real.
- A tool that only reads (`readOnlyHint`) answers as usual and adds a warning naming what it ignored. `plan_server_build` is the exception: it changes nothing itself, but the plan it stages is what `execute_build_plan` runs, so it refuses.
- The same holds inside a parameter. A key that a blueprint's channel, a file entry, an onboarding prompt, or any other nested object does not have is answered by its path, such as `blueprint.channels[2].private`. Before, a channel written that way was built for everyone to see.
- An undeclared key counts whatever its value, `null` included: `null` is how this API clears a setting, so `private_to` misspelled and set to `null` is an instruction that would otherwise go missing. The one exception is `dry_run` set to `false` or `null` on a tool with no dry run, which asks for what that tool does anyway.
- `sessionId`, `action`, `chatInput`, and `toolCallId` are accepted and ignored by every tool that does not declare them, because n8n's AI Agent adds them to each call.

`DISCORD_MCP_STRICT_PARAMS=false` turns the check off, for a host that adds other keys of its own to every call. Unknown parameters are then dropped as they were before 2.0. The check sees only what the app sends: an app that strips unknown parameters before calling leaves nothing to answer.

### 1.8 Authorization layers

Two layers, evaluated in order:

1. Discord permission: what the bot can physically do, per guild and channel. Listed in the Requires column below. "none" means any bot in the guild can do it.
2. Gateway intents: privileged intents gate whole capability groups. Members intent gates member listing and search. Message Content intent gates reading and searching message bodies. Voice state is not a privileged intent and is always requested.

### 1.9 Rate limiting

The server owns rate limit coordination so the model never sees a 429 it could have avoided:

- Token bucket per route honoring `X-RateLimit-*` headers, plus the global 50 requests per second bot limit.
- Ordinary waits are waited out, up to five minutes. A wait on one of Discord's hidden per-channel limits longer than 30 seconds, or any wait past five minutes, fails at once with the reason and when to try again, since AI apps give up on a call long before that.
- 401, 403, and 429 responses are counted, because Discord blocks an address after 10,000 of them in ten minutes. The count is reported; nothing throttles on it.
- `get_rate_limit_status` reports the waits and that count, across every configured bot.

### 1.10 Known API gaps the catalog must be honest about

- Pinning: since February 23, 2026 pinning requires the PIN_MESSAGES permission; MANAGE_MESSAGES alone is no longer sufficient. Preflight checks the new permission.
- Voice audio: joining voice to play or capture audio is out of scope. It needs a separate UDP voice connection, Opus, and DAVE end-to-end encryption, required since March 1, 2026. The voice tools are administrative only.
- Guild creation: Discord stopped letting apps create servers in July 2025. Building works on a server the user creates and invites the bot into.

## 2. What is always loaded

Fifteen tools load no matter what: the `core` toolset. They are all reads,
so narrowing the surface with `DISCORD_MCP_TOOLS` can never leave a write
enabled that was not asked for, and an agent can always orient itself before
it acts. The list, the sizes, and every optional group are in
[toolsets.md](toolsets.md), which is the only place they are written down.
A second copy here would be a second thing to keep true.

The surface is shaped around two flows, and those drove which tools exist and
how they are named rather than which ones load:

- Chat and operate a server. Orientation (`get_server_overview`,
  `list_channels`), name-to-entity resolution (`find`, so a model never hunts
  for a snowflake), then the frequent reads and writes: `read_messages`,
  `send_message`, `search_messages`, `search_members`, `get_member`,
  `assign_role`.
- Build a server from a brief. `plan_server_build` to turn a brief into a
  plan, `execute_build_plan` to apply it, with `create_channel` and
  `create_role` as the primitives underneath.

`run_setup_check` sits outside both. Missing intents and permissions fail
silently and are the usual reason a first run goes nowhere, so diagnosing
that is a tool rather than a paragraph in a README.

## 3. Server and guild settings (17 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_servers | no | none | (none) | Every server across all configured bots, each labeled with the bot that reaches it, with IDs and approximate member counts. With multiple bots this is the routing map; any unreachable bot (bad token) is flagged. A server more than one of the bots is in has a row per bot, with `handles_server` true on the one tools run as there, and a warning explaining why (or that nothing settles it yet). Use get_server_overview for one server's detail. |
| get_server_overview | no | none | guild | Structured snapshot: name, owner, boost level, features, counts of channels, roles, members, emojis, plus a category-grouped channel outline. The outline holds the channels the bot can see; `hidden_from_bot` reports how many others exist, per category, when any do. When a pause on invites or DMs is running, the summary says so and names set_incident_actions, and `incidents` carries the end times and anything Discord flagged. |
| update_server | lowers | Manage Guild | guild, name, description, verification_level, explicit_media_filter (off, members_without_roles, all_members), default_notifications (all_messages, only_mentions), icon_url, banner_url, invite_background_url, discovery_background_url, afk_channel, afk_timeout_seconds (60, 300, 900, 1800, 3600), system_channel, rules_channel, public_updates_channel, community | Edits guild settings. Only passed fields change, with one exception: enabling Community also sets what Discord requires of one (media scanning for everyone, mentions-only notifications, at least low verification). The result names each of those it changed, and a different value passed for one of them in the same call is refused. Images come from public URLs (or none to remove one), up to 10 MiB, and the feature each needs is checked first: banner at boost level 2, invite background at level 1, discovery background in Server Discovery, an animated icon or banner at levels 1 and 3. The images it replaces are saved in the change record, since Discord stops serving an image once it is replaced, so `undo_change` can put them back. Gated when it lowers verification or the media filter, or turns Community off (1.4c); turning Community off also clears the rules and moderator updates channels, and a welcome screen left enabled can no longer be edited until Community is back on. Locale is not editable here. |
| get_server_preview | no | none | guild | A server's preview data: name, description, and approximate member and online counts. Only for servers a configured bot is in. |
| get_audit_log | no | View Audit Log | guild, action, user, limit | Recent audit entries, summarized per entry (who did what to what, when). `user` given as an ID or a mention is not looked up as a member, so it also finds entries by someone who has left. Not paginated. Names channel and role reordering (events 16 and 33). Discord merges some quickly repeated actions into one entry that keeps the first reason. |
| get_server_widget | no | Manage Guild | guild | Widget settings and invite channel. |
| update_server_widget | lowers | Manage Guild | guild, enabled, channel | Enables or disables the widget, or points its invite channel (none to clear). Gated when it turns the widget on or gives an enabled widget a new invite channel (1.4c), since the widget is a public page. |
| get_welcome_screen | no | Manage Guild | guild | Welcome screen description and channel cards. |
| update_welcome_screen | no | Manage Guild | guild, enabled, description, channels[] | Sets welcome screen content. |
| get_onboarding | no | Manage Guild | guild | Whether onboarding is on, each prompt's title with how many options it has, and the default channels. |
| update_onboarding | grants | Manage Guild + Manage Roles + Manage Channels | guild, prompts[], default_channels[], enabled, mode | Edits the new-member onboarding flow. Gated when it offers a role that hands out power or access (1.4b). |
| list_integrations | no | Manage Guild | guild | Installed integrations (bots, Twitch, YouTube). |
| delete_integration | yes | Manage Guild | guild, integration_id, reason | Removes an integration. |
| list_server_templates | no | Manage Guild | guild | Templates created from this guild. |
| create_server_template | no | Manage Guild | guild, name, description | Snapshots the guild as a Discord template. |
| sync_server_template | no | Manage Guild | guild, code | Re-syncs a template to current guild state. Takes the code or its discord.new link. |
| delete_server_template | yes | Manage Guild | guild, code | Deletes a template. Takes the code or its discord.new link. |

## 4. Channels and categories (15 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_channels | no | none | guild, type | The channels the bot can see, in position order, each with its type, category, and topic. Filterable by type. Since 2026-11-16 Discord leaves out channels the bot lacks View Channel on; `hidden_from_bot` reports how many when any are. |
| get_channel | no | none | channel | One channel's settings: type, category, topic, slowmode, NSFW, position, and how many permission overwrites it has (`get_channel_permissions` lists them). |
| create_channel | no | Manage Channels, plus Manage Roles when restricted | guild, name, type (text, voice, forum, stage, announcement, category), category, topic, slowmode_seconds, nsfw, private_to[], read_only, posting_roles[]; voice: bitrate_kbps, user_limit, region, video_quality; threads: thread_archive_minutes; forum: default_reaction, default_sort, default_layout, post_slowmode_seconds, require_tag | Creates any channel type. `private_to`, `read_only` and `posting_roles` are the same visibility sugar a blueprint uses, applied to the category's overwrites in the create call, so a private channel is one request rather than three and a read-only channel in a private category stays private. Here an empty `private_to` means no restriction. `posting_roles` only means something alongside `read_only`. Listing @everyone in `private_to` is refused, since allowing it back cancels the restriction and leaves the channel public. Anything finer, including member-specific overwrites, is `set_channel_permissions`. The voice, thread, and forum settings are checked as in `update_channel`. Position is `reorder_channels`; forum tags are `create_forum_tag` and its siblings. |
| update_channel | no | Manage Channels | channel, guild, name, topic, category, slowmode_seconds, nsfw; voice: bitrate_kbps, user_limit, region, video_quality; threads: thread_archive_minutes; forum: default_reaction, default_sort, default_layout, post_slowmode_seconds, require_tag | Edits channel settings. Only passed fields change, and settings for another kind of channel are refused. Bitrate is checked against the boost level (96, 128, 256, 384 kbps; 64 for stage). `require_tag` needs a tag anyone can use, so it is refused on a forum without one, and at creation; Discord answers 40066 otherwise. Position is `reorder_channels`; forum tags are `create_forum_tag` and its siblings. |
| delete_channel | yes | Manage Channels | channel | Deletes a channel and every message in it. Deleting a category leaves its channels in place, uncategorized, and the preview says how many. |
| clone_channel | no | Manage Channels | channel, guild, new_name | Copies a channel's settings and permission overwrites into a new channel. Overwrites always come along; there is no opt out. |
| reorder_channels | no | Manage Channels | guild, moves[] (channel, position, category) | Batch position and category moves in one call. |
| get_channel_permissions | no | none | channel | Overwrites on the channel, resolved into plain language per role and member, and whether the channel is synced with its category (the same permissions exactly), which decides whether a change to the category reaches it. |
| set_channel_permissions | grants | Manage Roles | channel, target (role or member), allow[], deny[] | Sets one overwrite, replacing that role's or member's whole overwrite; the result lists, under `removed`, anything the old overwrite allowed or denied that the new one leaves out. On a category, Discord applies the same change to the channels synced with it (the same permissions exactly), as the Discord app does; the result names them under `followed_by_synced_channels` and the change record includes them, so undo puts each back. On a channel synced with its category, the result says it stops following the category. Gated when it would let the target see the channel, read back its messages, or use moderator powers there (1.4b). |
| clear_channel_permissions | grants | Manage Roles | channel, target | Removes an overwrite, restoring inheritance. On a category, the channels synced with it follow, and are named and recorded, as with set_channel_permissions. Gated when removing it lets the target see the channel or gives them powers there, as when clearing the denial that keeps @everyone out (1.4b). Recorded, so undo_change reverses it. |
| lock_channel | no | Manage Roles; the bot must hold Send Messages itself | channel, reason | Denies @everyone sending messages and starting threads on a text, announcement, or forum channel. An allowance @everyone had there is taken off while it is locked, since within one overwrite an allow beats a deny. Roles and members allowed to post by an overwrite of their own keep posting; the result names those roles and counts those members. A bot can deny only permissions it holds; the result names any it could not. What the lock changed is kept in the data folder for unlock_channel. |
| unlock_channel | lowers | Manage Roles | channel, reason | Puts back exactly what lock_channel changed: its denials come off, an allowance it removed returns, and anything denied before the lock stays. A channel that was read-only before it was locked stays read-only. With no lock on record (one made before 2.0, or from another install), removing @everyone's denial on sending is gated (1.4c), since the channel may be closed on purpose. |
| follow_announcement_channel | no | Manage Webhooks | guild, source, target | Subscribes a channel to an announcement channel. |
| list_voice_members | no | none | channel | Who is in a voice or stage channel, with mute and deafen state. |
| set_voice_channel_status | no | Set Voice Channel Status + Manage Channels + Connect | channel, status (up to 500 characters, empty clears) | Sets the live status line shown on a voice channel. This is the status, not the topic. A bot is never connected to the channel, so Discord also wants Manage Channels, which a denied Connect cancels. |

## 5. Threads (8 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| create_thread | no | Create Public Threads | channel, guild, name, message_id (optional, to branch from a message), private, auto_archive_minutes (60, 1440, 4320, 10080), slowmode_seconds | Creates a thread, standalone or from a message. Private threads require Create Private Threads. In an announcement channel a thread started without a message is an announcement thread, the only kind Discord takes there, and a private one is refused. |
| list_threads | no | none | channel or guild, include_archived | Active threads, and archived when asked, with parent and last-activity info. Archived threads are read a page at a time up to 300, newest first; `more_archived` and a warning say when older ones were left out. Archived private threads are not listed. |
| get_thread | no | none | thread | One thread's settings, member count, and state. |
| update_thread | no | Manage Threads | thread, guild, name, archived, locked, slowmode_seconds, auto_archive_minutes (60, 1440, 4320, 10080) | Edits thread state. Archive and lock live here. |
| delete_thread | yes | Manage Threads | thread | Deletes a thread and its messages. |
| list_thread_members | no | none | thread | Members of a thread. |
| add_thread_member | grants | none | thread, member | Adds a member to a thread. Gated when it adds someone to a private thread they cannot see (1.4b). |
| remove_thread_member | no | Manage Threads | thread, member | Removes a member from a thread. |

## 6. Forums (8 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| create_forum_post | no | Send Messages; Attach Files for files | forum, guild, title, content, tags[], files[] | Starts a forum post with applied tags and files as in send_message. |
| list_forum_posts | no | none | forum, guild, tag, include_archived | Posts in a forum, filterable by tag. Archived posts are read up to 300, newest first, and the result says when older ones were left out. |
| reply_to_forum_post | no | Send Messages in Threads | post, guild, content, embeds[] | Replies inside a forum post, with text, embeds (7.4), or both. It sends no files; `send_message` takes a forum post as its channel when a reply needs one. |
| update_forum_post | no | Manage Threads (others' posts) | post, title, tags[], pinned, locked, archived | Edits post metadata and state. |
| delete_forum_post | yes | Manage Threads | post | Deletes a forum post. Like the other post tools, it finds forum posts only; a thread in a text channel is refused, by name or by ID. |
| create_forum_tag | no | Manage Channels | forum, guild, name, moderated | Adds an available tag to a forum. Tag emoji are not settable. The tag list is read fresh from the forum first, since Discord takes the whole list back and a cached one could drop a tag added moments earlier; the same holds for update_forum_tag and delete_forum_tag. |
| update_forum_tag | no | Manage Channels | forum, guild, tag, name, moderated | Edits a tag. |
| delete_forum_tag | yes | Manage Channels | forum, guild, tag | Removes a tag from the forum and all posts. |

## 7. Messages (17 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| send_message | no | Send Messages; Embed Links for embeds or component media; Attach Files for files; Mention Everyone for `mentions: everything` | channel, guild, content, reply_to, embeds[], components[], files[], mentions (none, users, roles_and_users, everything), silent | Sends a message. `mentions` defaults to none so the model cannot mass-ping by accident. `files` attaches up to 10 files, each fetched from a public http or https URL, 20 MiB each, with optional filename, alt text, and spoiler; see 7.2. A message needs at least one of `content`, `embeds`, `files`, or `components`; an embed alone is a whole message, and 7.4 lists what one takes. `components` builds a Components V2 layout from text, sections, image galleries, separators and link buttons inside colored containers. It replaces `content` and `embeds` rather than joining them: sending it sets a flag Discord will not let you clear, after which that message can never render either, so passing both is refused. Display blocks and link buttons only, covered in 7.1. |
| read_messages | no | Message Content intent | channel, guild, limit, before | Returns a digest: messages with author, time, whether edited, the message each replies to (its author and an excerpt), attachment names, image and embed counts, and reactions. A message that is an embed carries the embed's words in `embeds_text` (author, title, body, fields, footer; up to 1,500 characters each, five embeds), and a forwarded message carries what it forwards in `forwarded` (its text, embed words, file names, and where it came from), since neither has content of its own. Not a raw dump. Paging is backwards only, via `before`. |
| catch_up | no | Message Content intent | guild, hours (default 24, at most 14 days) or since, channels[] (a category means its channels), mentions_of, per_channel (default 30), max_channels (default 12) | What happened since a time across the whole server: every channel and active thread with new messages, busiest first (when there are more than `max_channels`, the most recently active are the ones read), each with who talked and its messages oldest first (trimmed to 300 characters, Discord's notices in words), plus @everyone pings and the messages mentioning a member. Each channel's newest message id carries its time, so quiet channels are skipped without a request; channels the bot cannot read are named and do not use up `max_channels`. Core. |
| get_message | no | Message Content intent | channel, guild, message_id, include_images, max_images, include_flagged | One message in full detail: author, content, timestamps, attachments, embed count and embed text, what a forwarded message forwards, reactions, and the reply reference. `flagged_media` lists attachments and embeds Discord's content scanning flagged (explicit, gore, self-harm), when any are. `include_images` also returns up to `max_images` (default 4, at most 10) of its pictures as image content the model can see: attachments, embed images and thumbnails, layout media, and a forwarded message's attachments. See 7.3. |
| edit_message | no | own messages: none; webhook messages: Manage Webhooks | channel, guild, message_id, content, embeds[], components[] | Edits a bot-authored message, or one posted through one of the server's incoming webhooks (through the webhook's own token, inside threads too). Messages crossposted from a followed channel, or posted by another app's webhook, are refused with that reason. A message keeps the mode it was sent in: edit a Components V2 message with `components`, an ordinary one with `content` or `embeds` (7.4; an empty list takes the embeds off). Discord allows no conversion either way, so both mismatches are reported before the call rather than as a bare 400. An edit mentions nobody: Discord works out an edited message's mentions afresh, and would otherwise use its defaults. |
| delete_message | yes | Manage Messages (others') | channel, message_id, reason | Deletes one message. |
| bulk_delete_messages | yes | Manage Messages | channel, guild, count, from_author, contains | Bulk delete up to 100 messages under 14 days old, newest first, optionally narrowed by author or substring. Explicit message IDs are not accepted. The preview gives the count and a sample of five; the token covers exactly the messages counted. |
| search_messages | no | Read Message History; Message Content intent | query, channel, author, has (image, video, sound, file, sticker, embed, link, poll, snapshot), pinned, sort (recent, relevant), limit, offset | Full-text search over Discord's server message index. Matches whole words across every channel the bot can read, or one named channel, and looks inside embeds and polls, not just message text. Reports the total match count. |
| pin_message | no | Pin Messages | channel, message_id | Pins. Preflights the post-Feb-2026 PIN_MESSAGES permission. |
| unpin_message | no | Pin Messages | channel, message_id | Unpins. |
| list_pinned_messages | no | none | channel | Pinned messages with author and date, every page of them, up to the 250 a channel can hold. |
| crosspost_message | no | Send Messages; Manage Messages for someone else's message | channel, message_id | Publishes an announcement-channel message to followers. |
| forward_message | no | Send Messages; View Channel and Read Message History in the source channel | channel, from_channel, message_id, content | Forwards a message from one channel into another as a quoted snapshot, the way the client's forward does. An optional note posts as its own message just before the forward, since Discord does not allow text on a forward. If the forward then fails, the note is removed again. |
| send_dm | no | none | user, guild, content | Direct message to a user who shares a guild with the bot. Text only. Fails gracefully when DMs are closed. |
| schedule_message | no | Send Messages | channel, content, send_at, repeat (none, daily, weekly) | Runs in this server's own scheduler, and is sent by the bot that scheduled it. Survives restarts. A repeat whose start is in the past begins at its next occurrence. A message Discord refuses because the channel is gone or the bot may no longer post there stays listed with the reason; a one-off is not tried again, a repeat waits for its next time. |
| list_scheduled_messages | no | none | guild | Pending scheduled messages, with the reason on any that could not be delivered. |
| cancel_scheduled_message | yes | none | schedule_id | Cancels a scheduled message of this server; an id from another server is answered as not found. The preview shows its channel, time, repeat, and text, which is not kept. Cancelling one that is being sent at that moment stops its repeat. |

### 7.1 Message components

`send_message` and `edit_message` take a `components` array that compiles to
Discord's Components V2 layout. Each entry is a block with a `type` and the
fields that type reads; anything else is reported rather than ignored.

| type | Reads | Renders as |
|---|---|---|
| `text` | `text` | A paragraph of markdown. |
| `section` | `text`, and exactly one of `media` or `buttons` | Text with a thumbnail or link button beside it. |
| `gallery` | `media` (1-10) | A grid of images. |
| `separator` | `divider`, `spacing` (small, large) | Vertical space, with an optional rule. |
| `buttons` | `buttons` (1-5) | A row of link buttons. |
| `container` | `accent_color`, `spoiler`, `components` (1-10) | A bordered group with a colored left edge. Containers do not nest. |

Two limits are enforced before the call. Discord allows 40 components per
message counted over the whole tree, where a section counts as three and a
button row as one plus each button, so a layout can exceed the cap with far
fewer than 40 blocks. A container holds at most 10.

Buttons are link buttons: they carry a URL and open it. Buttons and select
menus that fire an interaction are deliberately absent, because answering one
means holding a gateway connection and replying within three seconds, and
this server answers MCP calls rather than Discord interactions. Such a button
would render correctly and then fail for everyone who clicked it. File
components are not offered. Galleries and thumbnails take ordinary URLs, or
`attachment://<filename>` for a file sent in the same call (7.2).

Reading one of these messages back works normally. Discord leaves `content`
empty on a Components V2 message, so the digest every read tool shares pulls
the text out of the components instead, joins it in order, renders link
buttons as markdown links, and marks the message `components_v2`. Without
that a panel this feature posts would read back blank.

### 7.2 Files

`send_message`, `send_webhook_message`, and `create_forum_post` take `files`: up to 10 entries of `url`, optional `filename`, `description` (alt text), and `spoiler`.

- Only URLs. There is no parameter for a path on the machine the server runs on, because a message in a channel could talk the AI into posting a local file for everyone there to read.
- Only public addresses. Loopback, private, link-local, carrier-grade NAT, and the other reserved ranges are refused, checked on the address actually connected to after DNS and again on every redirect (at most five). `DISCORD_MCP_ALLOW_PRIVATE_URLS=true` lifts this for setups that serve their own files from a private address. The same fetcher serves every other upload: emoji, stickers, sounds, avatars.
- 20 MiB per file, Discord's default upload limit, and 50 MiB per message held in memory. Files are fetched before anything is sent, dry runs included, so a bad URL fails the call and nothing is half sent.
- File names keep letters, digits, dot, dash, and underscore, gain an extension from the content type when they have none, and are numbered when two would match. `spoiler` adds Discord's `SPOILER_` prefix.
- In a Components V2 layout a file shows only where a gallery or thumbnail points at it as `attachment://<filename>`, so a file nothing points at is refused, and spoilers go on the gallery entry.

### 7.3 Images the model can see

`get_message` with `include_images` returns MCP image content after the envelope, each preceded by a line naming it, its source, and whether it is a spoiler.

- Fetched through Discord's media proxy only (cdn.discordapp.com, media.discordapp.net, images-ext-N.discordapp.net), never from the address an embed names, so a link in a message cannot steer the fetch.
- The proxy shrinks each image to at most 1568 pixels on the long edge and about 1.15 megapixels, and converts it to webp; a 3000x1500 PNG of 1.2 MB came back as a 1516x758 webp of about 95 KB. An image still over 1.5 MB is asked for smaller, and a call returns at most 4 MB in all.
- Images Discord's content scanning flagged (explicit, gore, self-harm) are held back, with a warning saying how many and why, unless `include_flagged` is passed.
- The summary tells the model that text inside an image is part of the message, not an instruction.

### 7.4 Embeds

`send_message`, `edit_message`, `send_webhook_message`, and `reply_to_forum_post` take `embeds`: up to 10, each built from the parts below. A key that is not in this list is refused rather than dropped.

| Part | Limit | Shows as |
|---|---|---|
| `title` | 256 characters | The heading. `url`, an http or https link, makes it a link. |
| `description` | 4,096 | The body, in markdown. |
| `author` | 256 | A small line above the title. |
| `fields` | 25, each with a `name` of 256 and a `value` of 1,024 | Name and value pairs under the body. `inline: true` sets a field beside its neighbours. |
| `footer` | 2,048 | A small line at the bottom. |
| `timestamp` | `now`, or ISO 8601, such as `2026-11-09T18:00:00Z`; with no zone it is read as UTC | A time beside the footer, shown to each reader in their own time zone. `now` is the moment of the call, for a card that should carry the time it was posted: a model has no clock to write that from. |
| `image_url`, `thumbnail_url` | an http or https link, or `attachment://<filename>` | A large picture under the text, and a small one in the top corner. |
| `color` | hex, like `#5865f2` | The left edge. |

Three things are checked before the call, so a refusal names the embed and the reason:

- An embed needs something to show: a title, a description, an author, a field, a footer, or a picture. A color, a link, or a time alone is not one, and neither is text made only of spaces, which Discord trims away.
- The embeds of one message share 6,000 characters of text: titles, descriptions, authors, footers, and field names and values. It is counted the way Discord counts it, by character after trimming each piece, so an emoji is one.
- `attachment://<filename>` has to name a file that comes with the message, exactly, capitals included. Otherwise Discord takes the message, shows the embed without the picture, and reports nothing. For `send_message` and `send_webhook_message` that is a file in `files` (7.2), and a file an embed shows appears inside the embed instead of beside it. `edit_message` sends no files, so there a picture can point only at a file the message already has. `reply_to_forum_post` sends none at all.

A picture given as a link is fetched by Discord, not by this server.

## 8. Reactions and polls (7 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| add_reactions | no | Add Reactions, Read Message History | channel, message_id, emojis[] | Adds one or more reactions in a single call. Every emoji is resolved before the first is added, so a name that matches nothing adds none; if Discord refuses one partway, the result says which went on. |
| remove_reaction | no | own: none, others': Manage Messages | channel, message_id, emoji, user | Removes a reaction. |
| clear_reactions | yes | Manage Messages | channel, message_id, emoji (optional) | Clears all reactions, or all of one emoji. |
| get_reactions | no | none | channel, message_id, emoji, limit | Who reacted with what. A full page is reported as "at least" that many, with `more: true`. |
| create_poll | no | Send Messages | channel, question, answers[], duration_hours, multi_select, content | Creates a native Discord poll. |
| get_poll_results | no | none | channel, message_id, include_voters, voters_per_answer | Current tallies. `include_voters` lists who chose each answer, up to `voters_per_answer` (default 100, at most 1000) each, and how many more there are. |
| end_poll | yes | own polls: none | channel, message_id | Closes one of the bot's polls early; a poll cannot be reopened. The preview says how early and how many votes are in. A poll that has already closed is left alone, with nothing to confirm. |

## 9. Roles (10 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_roles | no | none | guild | Roles with how many members hold each (Discord's own count), color, gradient or holographic style, icon, position, and a permission digest in plain language. |
| create_role | no | Manage Roles | guild, name, color, secondary_color, holographic, icon_url, icon_emoji, permissions[] or preset (none, member, moderator, admin), hoist, mentionable | Creates a role. Presets map to vetted permission bundles so the model does not hand out Administrator by reflex. A gradient (`secondary_color`) or Discord's holographic style needs the Enhanced Role Colors feature; an icon (an image up to 256 KB, or a standard emoji) needs Role Icons (boost level 2). Both are checked first. |
| update_role | grants | Manage Roles | role, guild, name, color, secondary_color, holographic, icon_url, icon_emoji, permissions[] or preset, hoist, mentionable | Edits a role. Hierarchy preflighted. Colors and icons as in create_role; `none` returns a gradient to a solid color or removes an icon, and a replaced icon image is saved for undo. Gated when the new permissions hand out power or access (1.4b). |
| delete_role | yes | Manage Roles | role | Deletes a role. The preview names it and its position; the change record keeps its settings, holders, and channel permissions for `undo_change`. |
| clone_role | no | Manage Roles | role, new_name | Copies a role's permissions and settings. |
| reorder_roles | grants | Manage Roles | guild, moves[] (role, position) | Batch hierarchy changes. Gated when a role with ban, kick, time out, manage roles, manage nicknames, or administrator would rise above a role it was below (1.4b). |
| assign_role | grants | Manage Roles | member, role, reason | Gives a member a role. Gated when the role gives them moderator or admin powers or opens channels hidden from them (1.4b); the result says which channels it opened. |
| remove_role | grants | Manage Roles | member, role, reason, dry_run, confirm_token | Takes a role from a member, at once. Gated when the role held them back, so that without it they see channels hidden from them now or regain a power (1.4b). |
| bulk_update_roles | yes | Manage Roles | guild, action (assign, remove), role, filter (has_role, joined_before, joined_after, is_bot) | Fans a role change across the members matching the filter, looking through the first 3,000 members of the server and warning when that cut the search short. The preview gives the count, the first ten names, and what the role would hand out to those members (1.4b). |
| get_role_members | no | Members intent | role, limit | Members holding a role. The total comes from Discord's own count of the role, apart from how many are listed. Holders are looked for among the first 3,000 members; a warning says when the search stopped short. @everyone lists members instead of none. |

## 10. Members (7 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| search_members | no | Members intent | guild, query, role, limit | Finds members by name fragment, optionally narrowed to one role; with `role` alone, lists its holders among the first 3,000 members. For join-date and bot filters see `bulk_update_roles`, whose `filter` object carries them. |
| list_members | no | Members intent | guild, limit, after | Paged member roster. Pages forward by user ID via `after`, not a cursor. |
| get_member | no | none | user, guild | Profile: username, display name, nickname, roles, join date, and timeout state. Permissions are `get_member_permissions`; who is in voice is `list_voice_members`. |
| update_member | grants | varies by field | member, guild, nickname (Manage Nicknames), move_to_voice (Move Members), server_mute, server_deafen (Mute/Deafen Members), reason | Multi-field member edit, including moving them between voice channels. Role changes go through `assign_role` and `remove_role`. Gated when it moves someone into a voice channel they cannot join (1.4b), and when it lifts a server mute or deafen they have (1.4c). |
| get_member_permissions | no | none | member, channel | Effective permissions for a member, server-wide or in a channel, in plain language. Discord's own permission check when it gives one (including its implicit rules), otherwise a local calculation; `source` says which. The server owner is shown with every permission, whatever their roles. |
| disconnect_member | no | Move Members | member, reason | Removes a member from the voice channel they are in. They stay in the server and can rejoin, so it is not confirmed. |
| prune_members | yes | Kick Members + Manage Guild, or Administrator where the owner made pruning admin-only | guild, days, reason | Removes members inactive for `days`. Dry run uses Discord's native prune-count endpoint for an exact preview. A server with the `PRUNE_REQUIRES_ADMIN` feature is explained up front instead of failing with a bare 403. When Discord does not answer within 15 seconds the result says the outcome is not known and how to check, since a prune on a large server can still be running. |

## 11. Moderation (12 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| timeout_member | yes | Moderate Members | member, guild, duration_minutes (up to 28 days), reason | Times a member out. Reason lands in the audit log. A member with Administrator is refused up front, since Discord does not allow it. |
| remove_timeout | lowers | Moderate Members | member | Lifts a timeout. Gated whenever the member is timed out (1.4c); the preview says until when. |
| kick_member | yes | Kick Members | member, reason | Removes a member. They can rejoin with an invite. |
| ban_member | yes | Ban Members | user, guild, reason, delete_message_seconds | Bans, optionally deleting recent messages. `user` takes a name or an ID, so it works on users no longer in the guild. |
| unban_member | grants | Ban Members | user_id, reason | Lifts a ban. Gated whenever safe mode is on: the preview names the user and the ban reason (1.4b). |
| bulk_ban | yes | Ban Members + Manage Guild | user_ids[] (up to 200), reason, delete_message_seconds | Mass ban, for raid cleanup. The preview gives the count and the first ten IDs, and the preview says whether their recent messages are deleted too; the token covers both. |
| list_bans | no | Ban Members | guild, limit, after | Current bans with reasons. Pages forward by user ID via `after`, not a cursor. |
| list_automod_rules | no | Manage Guild | guild | AutoMod rules, triggers, and actions, summarized. |
| create_automod_rule | no | Manage Guild | guild, name, trigger (keyword, keyword_preset, spam, mention_spam, member_profile), keywords[], regex_patterns[], presets[] (profanity, sexual_content, slurs), allow_list[], mention_limit, actions (block, alert, timeout), alert_channel, timeout_minutes, exempt_roles[], exempt_channels[], enabled | Creates an AutoMod rule. For slur filtering prefer keyword_preset with the slurs preset: Discord maintains the word list. member_profile scans usernames, nicknames, and bios instead of messages and needs a Community server; its block quarantines the member. Timeout is not allowed on spam, keyword_preset, or member_profile rules. `exempt_roles` and `exempt_channels` take names or IDs. |
| update_automod_rule | lowers | Manage Guild | rule, name, enabled, keywords[] | Renames a rule, turns it on or off, or replaces the keyword list of a keyword rule. Gated when it turns off a rule that is on or drops keywords the rule has (1.4c). Its trigger, actions, and exemptions are not editable here; delete the rule and create it again. |
| delete_automod_rule | yes | Manage Guild | rule | Deletes a rule. |
| set_incident_actions | lowers | Manage Server | guild, invites (hours to pause, 0 to resume), dms (hours to pause, 0 to resume) | Pauses new invites and DMs between non-friend members for up to 24 hours each, Discord's raid-defense security actions. No arguments reports the current state and any raid Discord detected on its own. Pausing is immediate; lifting a running pause or ending it sooner is gated (1.4c). |

## 12. Invites (4 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| create_invite | grants | Create Invite; Manage Roles for roles | channel, guild, max_age_seconds, max_uses, temporary, roles[], for_users[], dry_run, confirm_token | Makes an invite link with explicit lifetime defaults (24h, 0 = infinite must be asked for). `roles` gives roles to whoever joins with it (Discord's 2026 invite roles): each must sit below the bot and hold no permission the bot lacks, and integration roles are refused. `for_users` limits it to up to 1000 user IDs, who need not be in the server; the list is read back from Discord after the invite is made, and an invite Discord did not limit to exactly those people is revoked instead of returned. Gated when the roles hand out power or access (1.4b). |
| list_invites | no | Manage Guild | guild or channel | Active invites with uses, creators, and the roles each gives. |
| get_invite | no | none | code | Inspects an invite: guild, channel, expiry, approximate member and online counts, and, for the bot's own servers, the roles it gives and the people it is limited to (read from Discord's target users list). Takes a code or a link, and needs no server chosen: the code names its own. |
| delete_invite | yes | Manage Channels or Manage Server | code | Revokes an invite of this server. One that belongs to another server the bot is in is refused, since the confirmation names this one. The preview names the invite's channel and who made it. |

## 13. Webhooks (5 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_webhooks | no | Manage Webhooks | guild or channel | Webhooks with their target channels. Tokens are never returned in summaries. |
| create_webhook | no | Manage Webhooks | channel, guild, name, avatar_url | Creates a webhook. |
| update_webhook | no | Manage Webhooks | webhook, guild, name, avatar_url, channel | Edits a webhook. |
| delete_webhook | yes | Manage Webhooks | webhook | Deletes a webhook. |
| send_webhook_message | no | Manage Webhooks, to find the webhook | webhook, guild, content, username_override, avatar_url_override, embeds[], files[] | Posts via webhook with optional identity override, embeds as in 7.4, and files as in send_message. Posting into a specific thread is not supported. |

## 14. Expressions: emojis, stickers, soundboard (12 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_emojis | no | none | guild | Custom emojis with usage hints. |
| create_emoji | no | Create Expressions | guild, name, image_url | Uploads a custom emoji from a URL. |
| update_emoji | no | Manage Expressions | emoji, guild, name | Renames an emoji. Restricting one to roles is not supported. |
| delete_emoji | yes | Manage Expressions | emoji | Deletes an emoji. |
| list_stickers | no | none | guild | Custom stickers. |
| create_sticker | no | Create Expressions | guild, name, description, tags, image_url | Uploads a sticker from a URL. |
| update_sticker | no | Manage Expressions | sticker, name, description, tags | Edits sticker metadata. |
| delete_sticker | yes | Manage Expressions | sticker | Deletes a sticker. |
| list_soundboard_sounds | no | none | guild | Soundboard sounds with volume and emoji. |
| create_soundboard_sound | no | Create Expressions | guild, name, sound_url, volume, emoji | Uploads a soundboard sound from a URL. |
| update_soundboard_sound | no | Manage Expressions | sound, guild, name, volume | Edits a sound. Its emoji is set at upload and not editable. |
| delete_soundboard_sound | yes | Manage Expressions | sound | Deletes a sound. |

## 15. Scheduled events (6 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_events | no | none | guild | Upcoming events with type, time, and interest counts. |
| get_event | no | none | event | One event in detail. |
| create_event | no | Create Events | guild, name, description, type (voice, stage, external), channel or location, start_time, end_time, repeat (daily, weekly, biweekly, monthly) | Creates a scheduled event, optionally recurring. |
| update_event | lowers | Manage Events | event, name, description, start_time, end_time, location, status (start, end) | Edits an event's details, or starts or ends it. Ending is gated (1.4c): an ended event cannot be started again. Its type, channel, and repeat are set at creation. |
| cancel_event | yes | Manage Events | event | Cancels an event by deleting it; Discord keeps no cancelled event behind. |
| get_event_attendees | no | none | event, limit | Users marked interested, with the event's own count when the list is only part of it. |

## 16. Stage instances (4 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_stages | no | none | guild | Live stage instances. |
| start_stage | no | Manage Channels (stage) | channel, guild, topic, notify | Goes live in a stage channel. |
| update_stage | no | Manage Channels (stage) | channel, topic | Changes the live topic. |
| end_stage | yes | Manage Channels (stage) | channel | Ends the live stage for everyone listening. The preview names the stage's topic; with no live stage there is nothing to confirm. |

## 17. Application commands and bot (8 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_app_commands | no | app owner | guild (optional, else global), bot | Registered slash commands. Guild and global sets are separate lists. |
| register_app_command | no | app owner | name, description, options[], guild, bot | Registers a slash command, or updates it in place when the name already exists. Guild commands appear immediately; global ones can take an hour and are rate limited per day. Required options are sent before optional ones, as Discord requires. Subcommands and subcommand groups are not supported. |
| update_app_command | no | app owner | command, description, options[], guild, bot | Edits a command by name or ID. Sending options replaces the whole list. |
| delete_app_command | yes | app owner | command, guild, bot | Unregisters a command. Registering it again restores it. |
| set_bot_presence | no | none | status (online, idle, dnd, invisible), activity_text | Sets the bot's presence. The activity type is not selectable. |
| update_bot_profile | no | none; Change Nickname for a server nickname | scope (server, everywhere), guild, bot, nickname, username, avatar_url, banner_url, bio, dry_run | How the bot looks. Per server (the default, Discord's Modify Current Member since September 2025): nickname, avatar, banner, and bio in that server only. Everywhere: username, avatar, and banner. `none` removes a server-only one, so the global one shows again. An avatar or banner being replaced is saved to the data folder's `replaced-images` first, since Discord stops serving it once replaced. Discord's limits on avatar changes and on username changes (about two an hour) are reported in words. |
| leave_server | yes | none | guild (required), bot, confirm_token | The bot leaves a server; when two configured bots are in it, `bot` says which. Confirmed whenever safe mode is on; never falls back to the default server. The preview gives the member count, says the bot can only return through a new invite, and says how many scheduled messages for that server will be cancelled, since they could never be delivered. A server the bot owns is refused. |
| get_bot_info | no | none | bot (optional) | Application info, guild count, enabled intents, the gateway state, and this server's version. The first diagnostics stop. Pass bot to inspect a specific bot when several are configured. |

## 18. Builder (13 tools)

The product headline. The flow is: brief in, plan out, plan reviewed, plan executed, with blueprints as the persistence format.

A blueprint is a JSON document with five optional fields: `name`, `theme`, `roles`, `categories`, and `channels` (top-level ones, outside any category). Roles carry a name, a permission preset plus any extra permission names, and color, hoist, and mentionable, and are listed highest first: that order is the hierarchy. There is no position field because one is not needed. Discord parks every role created through the API at position 1 and ranks roles that share a position by id, older higher, so a build that creates the top role first reproduces the hierarchy exactly, and an export lists roles the same way. Channels carry a name, type (text, voice, forum, stage, announcement), topic, slowmode, nsfw, and the visibility sugar below. Blueprints are portable across guilds because they reference roles by name rather than by ID. Any item may also carry its Discord `id`, which exports include: an item with an id means that exact role, category, or channel, so a new name renames it. An id the target server does not have falls back to matching by name, so an export still works as a design for another server.

Limits match Discord's own: 250 roles, 500 channels, 50 categories, and 50 channels per category. The schema enforces them on authoring and export, so any server Discord allows fits in a blueprint, and the planner checks the same numbers against the live server, existing entities plus what the blueprint adds, since a blueprint that fits on its own can still overflow a server that is already half full.

What a blueprint does not carry: numeric role positions (order stands in for them, as above), AutoMod rules, onboarding, the welcome screen, scheduled events, and seed content such as a rules post or pinned message. Those are managed by their own tools, not by the builder.

Division of labor, fixed at implementation time: the AI client owns the creative translation from conversation to blueprint (themes, naming, which channels a "dark fantasy guild" needs), guided by the reference layouts. discord-mcp owns correctness: schema validation, intra-blueprint and live-server collision detection, Discord structural limits, role reference resolution, Community feature gating (verified against the live API: forums work everywhere, announcement and stage channels need Community), bot permission preflight, and dependency ordering. This keeps every deployment free of any LLM dependency inside the server itself. Channels and categories can also carry `permissions`: per-role extras beyond who can see and post, such as letting a staff role mention everyone or manage messages in one channel, with `@everyone` allowed as a role. A listed role's extras become exactly the list; roles not listed keep theirs. Extras never touch the bits the visibility sugar controls, and one that contradicts it (denying a `private_to` role the view, say) is refused while planning. Exports write each role's extras out, so an export rebuilt on another server reproduces role permission overwrites exactly; only member-specific overwrites and those for roles an integration manages are still captured approximately.

Visibility sugar on channels and categories: private_to (role names that can see it; `[]` leaves only admins, `null` makes it visible to everyone, and leaving it out follows the category), read_only, and posting_roles (who may still post and start threads in a read-only channel). They become permission overwrites by changing only the bits they are about: a new channel starts from its category's overwrites, the way Discord does itself, and an edit starts from the channel's own, so member overwrites and other bits pass through untouched.

Editing an existing server: `plan_server_build` with `update_existing` changes existing items to match the blueprint as well as creating what is missing. An item changes only the settings it lists, so naming a role without its permissions leaves them alone; listing a setting empty (`topic ""`, `private_to null`, `color null`) clears it. A channel listed inside a category follows the privacy and permissions the category sets unless it sets its own, including a channel with permissions of its own such as a read-only one. When a category's privacy or permissions change, the channels synced to it (the same permissions exactly) follow too, listed or not, as they do in Discord; each channel that changes is a step of its own. An unlisted channel with permissions of its own keeps its visibility, and the plan names it. Discord makes that change in synced channels by itself when a category's permissions change one role at a time, so while a build changes a category it holds them with an empty permission entry (allow nothing, deny nothing) and removes it straight after; the audit log shows both, and nothing changes that the plan does not show. Each change shows before and after, and changes that widen access or grant powerful permissions are flagged. Deleting is a separate list, `remove`, of roles, categories, and channels by name or id; leaving something out of a blueprint never deletes it, and a saved blueprint never carries deletions. Deletions run last, so a failure earlier leaves nothing deleted, and each one says what it loses: a channel's messages, the members a role is taken from, the channels a category leaves behind, a server setting that points at the channel. Discord's required Community channels, roles an integration manages, and roles above the bot are refused at planning time. Such a plan is the approval of exactly those changes: it is saved, runs once, and is refused at execution if anything it touches changed in the meantime, checked against the server as it is then: gateway events clear the cached channel and role lists the moment something changes, and without a gateway connection they are read fresh. Discord allows only 10 reads of a server's channel list a minute, so a burst of plans can still wait about a minute. Reordering is not part of this.

Every change to a server's structure made through discord-mcp keeps a record in the data folder, newest 50 per server: a build, and each single create_channel, update_channel, delete_channel, clone_channel, set_channel_permissions, clear_channel_permissions, lock_channel, unlock_channel, create_role, update_role, delete_role, clone_role, assign_role, remove_role, bulk_update_roles, and update_server. A record holds what was created, each changed setting before and after, and a full copy of anything deleted, including who had a deleted role and which server settings pointed at a deleted channel. Each of those tools returns a `change_id`, and `undo_change` reverses that change from its record, whichever tool made it, so undo never depends on the AI rebuilding something from memory. A setting goes back only if it still holds the value the change set, and a permission overwrite only per role or member under the same rule, so changes made since are kept and reported. Deleted items are recreated and get new ids, which the undo maps through everything that pointed at them: channel overwrites, a category's channels, the system messages channel and similar settings, and up to 100 members who had a deleted role. A deleted channel's messages, threads, pins, invites, and webhooks cannot come back, and the preview says so. An item recreated by an undo leaves a forwarding note, old id to new, so an older change that names the deleted item reaches the one that replaced it: undoing a channel's creation after undoing its deletion removes the recreated channel. Undoing a category's permission change holds the channels synced to it the same way: a channel that followed the category when the change was made goes back by its own record, and one that only matches the category now keeps what it has, named in the preview. `undo_change` takes one change, every change since a time ("everything today"), or a list, undone newest first after one confirmation. The preview plans each change against the server as undoing the newer ones would leave it, so an item an earlier step deletes or brings back is accounted for, and each change is checked again against the real server when its turn comes. Each step's outcome is saved as it happens, so if one fails (a rate limit, say) running the undo again finishes only what is left. Reordering channels or roles is not recorded.

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| plan_server_build | no | none | guild, blueprint (structured; the client AI composes it from the user's request, optionally starting from a reference layout or an export), update_existing, remove (roles, categories, channels) | Validates the blueprint against the live server and stages an ordered build plan. Makes no changes on Discord. Reports every problem at once (collisions, limits, bad role references, feature gates, missing bot permissions, role hierarchy, conversions Discord does not allow, renames onto a name in use). Existing items with matching names or ids are reused, never duplicated; with `update_existing` they are also changed to match, each change shown before and after, with risks flagged and settings left out reported as kept. Items in `remove` are deleted, each with what it loses. Plans are saved for 30 minutes, so another copy of the server can execute them. |
| execute_build_plan | yes | aggregate of the plan's needs, typically Manage Channels + Manage Roles | guild, plan_id or blueprint | Executes a plan. The plan from plan_server_build is its preview, so there is no confirm_token. The blueprint is re-validated against live server state at execution time, so staged plans can never act on stale data. A plan that changes existing items runs once and only if those items are as the plan saw them; otherwise nothing runs. Where the app can show a confirmation dialog (1.4), such a plan runs only after the user ticks the box in a dialog listing its steps and risks; a declined dialog leaves the plan usable. A plan whose new channels or categories give @everyone or a role already on the server a power (1.4b) is treated the same way, since those people get the power the moment the channel exists. Other plans that only create run without a dialog. A blueprint passed directly only adds, and is refused when it would hand out such a power: it has had no preview at all. The bot always grants itself access to what it restricts. Runs in dependency order (roles highest first, then categories, then channels, creating before changing, deleting last), sends each channel's setting changes as one request, and halts on failure with a created/changed/failed/not-attempted report; planning again finishes the rest. Afterwards it plans the same blueprint against the server again and reports, under `check`, anything that did not take effect and anything the build did not touch that changed while it ran. New roles are then given distinct positions in one bulk call when the bot's own role sits high enough for Discord to allow it; when it does not, which is the case on a fresh server, they share a position and the client still ranks them in blueprint order. `role_positions` in the result says which happened. Reconcile mode (destructive, drift-correcting) is deferred to the diff_blueprint work. |
| list_reference_layouts | no | none | (none) | The three server archetypes shipped with discord-mcp: `gaming-community`, `product-support`, and `friends-hangout`. Each is a vetted blueprint with a stated audience and rationale. |
| get_reference_layout | no | none | layout_id | One archetype in full, with commentary on why its structure works. |
| export_server_blueprint | no | none | guild, save_as, include_ids | Snapshots a live guild into a blueprint, with each item's id, decompiling permission overwrites back into the visibility sugar where they fit and warning per channel where they do not. Roles sharing a name are exported with a numeric suffix, since the format keys everything by name; overwrites for integration-managed roles are reported rather than exported, because those roles are not recreatable. Roles come out highest first, with tied positions ordered the way the client shows them, so a rebuild reproduces the hierarchy. Seed content and anything outside the schema above are not captured. |
| import_server_template | no | none | template (discord.new link or code), save_as | Turns a Discord server template into a blueprint without building anything: roles highest first, categories, channels, and visibility decompiled from the template's overwrites the same way an export reads a live server, with no ids, since it is for another server. Template ids are numbered from 0 and every channel position reads 0, so the template's own order is kept. Lists the template's verification level, media filter, and notifications for update_server, since blueprints do not carry server settings, and flags a template whose source server changed since it was synced. |
| save_blueprint | no | none | name, blueprint, description | Saves a blueprint to the discord-mcp store. |
| list_blueprints | no | none | (none) | Saved blueprints with names and dates. |
| get_blueprint | no | none | blueprint (saved name or ID) | One saved blueprint. |
| delete_blueprint | yes | none | blueprint (saved name or ID), dry_run, confirm_token | Deletes a saved blueprint. Gated: previews first, executes on the token. |
| list_changes | no | none | guild, limit | Recent recorded changes on a server, newest first, with the tool that made each, what it created, changed, and deleted, and whether it has been undone. |
| undo_change | yes | the reverse of the change's needs | guild, change_id, since, or change_ids (default: the latest not yet undone), dry_run, confirm_token | Reverses a recorded change, as described above. Gated: the first call previews every step, and the token lasts ten minutes. It is bound to those steps as worded: the undo is planned again when the confirmed call arrives, and if the server moved in between so that the steps differ, the token is refused and a fresh preview is needed. A run that fails partway is finished by running it again, including an item recreated without all that belonged to it. |
| diff_blueprint | no | none | guild, blueprint (saved name or ID, or a blueprint) | Drift report: how the live server differs from a blueprint (missing items, changed fields, renames for items with ids, extras). It reads the blueprint as the whole truth, so a setting left out counts as its default. Reporting only; `plan_server_build` with `update_existing` applies changes, and its `remove` deletes extras. |

## 19. Events and notifications (4 tools)

Real-time gateway events surfaced through MCP. No notable competitor ships this.

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| subscribe_events | no | intents vary by type | guild, types[] (14: message_created, message_deleted, member_joined, member_left, reaction_added, reaction_removed, channel_created, channel_deleted, role_created, role_updated, role_deleted, ban_added, ban_removed, voice_state_changed), channel, include_bots | Records one server's gateway events into a buffer you then read with `get_recent_events`: the named server, or the default. Events come over the default bot's connection, so with several bots only the default bot's servers can be watched, and another bot's server is refused. A server the default bot shares with another bot is watched through the default bot, whichever of them handles it otherwise. There is no push delivery; nothing is sent to the client unprompted. |
| unsubscribe_events | no | none | subscription_id | Ends a subscription. |
| list_event_subscriptions | no | none | (none) | Active subscriptions, across every guild, each with the server it records. |
| get_recent_events | no | none | subscription_id, limit | Drains buffered events, for clients that cannot receive notifications. Draining is destructive and there is no paging. |

## 20. Diagnostics, security review, and utility (7 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| run_setup_check | no | none | bot (optional) | End-to-end health check: token presence and validity, the three privileged intents (enabled in the portal versus needed), App Verification by server count and the privileged intent review by user count (10,000 users since June 2026), gateway connection, default-guild membership, and how destructive actions are confirmed in the connected app (`confirmations`: dialog or token, and a warning when `DISCORD_MCP_CONFIRM=dialog` meets an app that cannot show one), plus an `install_location` warning when the client points into npm's npx cache, which breaks once that cache is cleared. Pass bot to check a specific bot when several are configured. Output is a plain-English pass or fix list, with a `version` warning and the update command when a newer release is out. Run on first connect and whenever things act weird. |
| explain_permissions | no | none | actor (bot or member), permission, guild, channel | Answers "can X do Y in Z, and if not, why not" by resolving the full permission chain. The yes or no is Discord's own check when it gives one, and a mismatch with the role chain is explained as Discord's implicit rules. The server owner has every permission, and the reason given is ownership. |
| get_rate_limit_status | no | none | (none) | Rate-limit hits and the invalid-request counter since the server started, across every configured bot. |
| audit_server_security | no | none; reads more with Manage Server and Manage Webhooks | guild | Reviews the server's security posture and returns findings ranked high, medium, low, and info, each with a plain fix, plus what was checked and what could not be. See 20.1. |
| get_channel_access | no | none; Server Members intent for include_members | channel, guild, include_members | Who can see and use a channel: @everyone, each role that can see it with its member count, whether it can post (or join, for voice), its powers there, Administrator roles, members with a personal overwrite, and the owner. Roles are judged one at a time; `include_members` checks every member (up to 10,000) and lists up to 100 who can see it. Threads are refused in favor of their parent. |
| get_member_access | no | none | member, guild | What one member reaches: server-wide powers, every channel they can see with whether they can post or join, channels where they hold powers beyond their server-wide ones, and the channels closed to them. |
| find | no | none | query, types[] (channel, role, member), guild | The fuzzy resolver as a tool. Returns ranked candidates with IDs and context so the caller can disambiguate once and reuse the ID. Emojis, threads, and events are found through their own list tools. |

### 20.1 What the security review checks

Each finding has a stable `id`, a severity, a title, the detail, a fix, and the roles, channels, bots, invites, or webhooks it is about. High means someone can hurt other members or take the server; medium means a weaker power held too widely or a Discord safety default left off; low and info are worth a look.

- Powers held by @everyone, server-wide, and in each channel through its overwrites. Webhooks, Manage Permissions, or Manage Channels for everyone in a channel is high.
- A powerful role held by a large share of the server (at least 10 members and a quarter of them): high for ban, kick, time out, or managing the server, roles, channels, or webhooks; medium for weaker powers.
- Roles with Administrator and how many hold them; medium when more than 5 people and a tenth of the server do.
- Manage Roles above a stronger role: Discord lets Manage Roles hand out any role below the holder's highest one, themselves included, so a Manage Roles role above an Administrator role is a way to become admin (high), and above a role with other powers it lacks, medium. Low when nobody holds it yet.
- This bot with Administrator (low), other bots with Administrator (medium), and other bots that can moderate (info).
- Roles with powers offered in onboarding, where anyone can pick them, and invites that hand out a role with powers (both high).
- Invites that never expire and have no use limit, and incoming webhooks with who made them (info).
- Verification level None (medium) or Low (low), the explicit media filter off (medium) or only for members without roles (low), 2FA not required for moderator actions while roles can moderate (medium; only the owner can change it), and AutoMod with no rules on or no mention spam rule (low).

Role counts come from Discord's member count endpoint. Invites and AutoMod rules need Manage Server, and webhooks Manage Webhooks; whatever the bot cannot read is listed under `not_checked` rather than guessed, as are channels hidden from the bot.

## 21. Explicit non-goals

- Voice audio (play, capture, transcribe). Planned v2 flagship; blocked on DAVE E2EE work.
- Acting as a user account in any form. Self-bot patterns violate Discord ToS and will never ship.
- Guild creation from nothing (`create_server`). Deferred; requires the dedicated builder-bot model due to the under-10-guilds API restriction.
- Monetization endpoints (SKUs, entitlements), Activities, and the Social SDK surface.
- Answering Discord interactions: component buttons with a `custom_id`, select menus, modals, and app command invocations. Registering an app command is supported; responding when someone runs it is not, and would mean an always-on listener with a three-second budget rather than a request-response tool. Only link buttons ship, per 7.1.
- Training any model on message content obtained through the API (Developer Policy rule 21). Runtime inference only.

## 22. Open questions

1. Blueprint schema versioning: semver the format, or stay loose for now.
