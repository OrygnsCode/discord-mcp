# Troubleshooting

Common problems and their fixes. The fastest diagnostic is to ask your AI
to run a setup check; it reports each part of the setup and how to fix what
is wrong. If you are an AI assistant helping someone, run that check first
and read the results back.

## The tools do not appear in my AI client

Almost always the client needs a full restart to pick up a new MCP server.
Quit it completely (from the system tray on desktop apps, not just the
window) and reopen. Then start a fresh conversation. If it still does not
appear, confirm the configuration file is the one the client actually
reads and that the path to `dist/index.js` is correct and absolute.

## Setup check says the token is missing or invalid

- Missing: there is no `DISCORD_TOKEN`. Put it in a `.env` file next to the
  package (source checkouts), in `.orygn/discord-mcp/.env` in your user folder
  (installed copies; the wizard writes it there), or in the client's
  server configuration environment.
- Invalid: Discord rejected the token. It is wrong, expired, or was reset.
  Generate a fresh one on the Bot page in the Developer Portal and update
  `DISCORD_TOKEN`.

## Setup check says an intent is disabled

Member search and message reading need the Server Members and Message
Content intents. Open your application's Bot page in the Developer Portal,
scroll to Privileged Gateway Intents, turn the missing ones on, and save.
Below 10,000 users this needs no review. Then run the check again.

## A channel is missing from the list

Since November 16, 2026, Discord leaves every channel the bot lacks View
Channel on out of its channel list, the same way people do not see channels
they cannot view. Those channels cannot be named, edited, or exported until
the bot can see them. `list_channels` and `get_server_overview` say how many
are hidden and in which category, when any are; that count comes from the
gateway connection of the default bot, so with the gateway off or another
bot acting it is reported as unknown.

To manage a hidden channel, give the bot View Channel on it, or give the
bot a role that has it there. A server build also cannot check hidden
channels for name clashes, so the plan warns when any exist.

## The bot shows as offline

If you are using the default (gateway on), the bot shows online whenever an
discord-mcp process is running and connected. A short delay at startup is
normal while it connects. If it stays offline, run a setup check and read
the gateway line. Note that the bot can still do everything over REST even
when it appears offline; the online dot is presence, not capability. If you
set `DISCORD_MCP_GATEWAY=off`, the bot is intentionally offline.

## An action went to the wrong bot, or a bot is unreachable

These apply only when you run more than one bot (see
[Multiple bots](multi-bot.md)).

- Wrong server, or "no bot in that server": discord-mcp routes by which bot is
  a member of the named server. Ask it to "list servers" to see the map of
  which bot reaches which server. If a server is not listed, no configured
  bot is in it; invite one, or check the name.
- Ambiguous: if two of your bots share one server, name the bot to use (for
  example "as the main bot") so discord-mcp does not have to guess.
- A bot is unreachable: if one bot's token was reset, only that bot stops
  working, and `list_servers` flags it. Run a setup check on that bot by
  name ("run a setup check on the test bot") to see what is wrong, then fix
  its token in `bots.json`.

## A tool fails with a permissions error

The bot is missing a Discord permission, or its role is too low. discord-mcp
preflights most of these and tells you the exact permission and where to
grant it. Two frequent causes:

- The bot's highest role is below the role or member it is trying to act
  on. Move the bot's role higher in Server Settings, Roles.
- The bot lacks a permission in that specific channel because of a channel
  permission override. Grant it on the channel, or use the
  explain_permissions tool to see exactly why an action is blocked.

## Creating a forum, announcement, or stage channel fails

Announcement and stage channels require the server to have the Community
feature enabled (Server Settings, Enable Community). Forum channels work
without it. You can enable Community through discord-mcp with the update_server
tool, which also sets the channels Community requires.

## A destructive action did not happen

That is the safety gate working as intended. Destructive tools preview
first and return a confirmation token; the action only runs when the call
is repeated with that token. In an app that can show a confirmation
dialog, the call with the token shows you one, and nothing happens unless
you tick the box. Otherwise your AI should show you the preview and ask
before confirming. The same applies to changes that hand out power or
access: giving someone moderator powers, letting someone see a private
channel, or lifting a ban. If you want a tool to execute immediately without the
gate in a trusted automated setup, set `DISCORD_MCP_SAFE_MODE=false`.

In Claude Desktop, a call can also be stopped before it reaches
discord-mcp: if you declined Desktop's own prompt to run the tool, the AI
is told you said no, and nothing was sent to the server.

If the result says the confirmation dialog was closed without an answer
and you never saw one, the app closes dialogs on its own when nobody is
there to answer (Claude Code run with `-p` does). Set
`DISCORD_MCP_CONFIRM=token` for that setup, and `run_setup_check` will
show the change.

## Calls time out or feel slow

- A burst of writes can queue behind Discord's rate limits. discord-mcp waits
  politely rather than risking a ban, so a heavy sequence can take tens of
  seconds. The get_rate_limit_status tool shows what has been happening.
- Connection timeouts that mention a Cloudflare address are usually local
  network trouble between you and Discord, not discord-mcp or Discord itself.
  Retrying the same call typically works.

## Member pruning says the allowance is used up

Discord limits how often a server can run a real prune to a few times every
several minutes. The preview count is not limited, so you can always check
how many members would be removed; the execution simply needs to wait a few
minutes between runs.

## "Server disconnected" after it used to work

If it was set up with `npx @orygn/omnicord init` on version 1.4.0 or
earlier, when it was still called Omnicord, your AI client was pointed at a
copy inside npm's npx cache. That
folder is not permanent: `npm cache npx rm` empties it, and so does deleting
the npm cache folder or running a disk cleanup tool. (`npm cache clean` does
not; it leaves the npx cache alone.) Once the folder is gone, the client
cannot start it. Claude Desktop shows "Server disconnected", and its log
for the server, `mcp-server-omnicord.log`, shows `Cannot find module` with
a path containing `_npx`.

Your token and saved data are safe. They live in your user folder
(`.omnicord` before the 2.0 rename, `.orygn/discord-mcp` after it), which
none of this touches. To repair, run:

```
npx @orygn/discord-mcp@latest init
```

accept its offer to switch over (or choose **Re-register with your AI
client**), and fully restart the client. The wizard copies the program to
`.orygn/discord-mcp/app/<version>` before registering it, so this does not
recur. A setup that still works but points
into the npx cache gets an `install_location` warning from the setup check,
so you can fix it before it breaks.

## The HTTP server refuses to start

If you bind to a non-localhost address without `DISCORD_MCP_HTTP_TOKEN`,
discord-mcp refuses to start on purpose, so the bot is never exposed to a
network without authentication. Set a strong `DISCORD_MCP_HTTP_TOKEN`, or bind
to 127.0.0.1 for local-only use.

## Still stuck

Open an issue on the repository with what you tried and what the setup
check reported. For a security concern specifically, email
security@orygn.tech rather than posting it publicly.
