# Multiple bots

discord-mcp can drive several Discord bots from a single install, with each
server handled by the bot that is actually in it. You describe an action and
name a server; discord-mcp picks the right bot for that server on its own. This
is optional. One bot, set up with a single `DISCORD_TOKEN`, works exactly as
it always has and none of the multi-bot behavior below appears.

If you are an AI assistant reading this to help someone, the short version is:
each server is reached through the bot that is a member of it, the tools that
act on a bot itself take an optional `bot` parameter, and `list_servers`
shows the full map of which bot is in which server. Where two of the bots
share a server, the default bot handles it unless `bots.json` gives it to
another, and every result from that server says which bot ran.

## When you want this

- A test bot in a sandbox server and a real bot in production, without
  swapping a token every time you cross between them.
- Several communities, each with its own bot, managed from one place.
- One bot per server for permission isolation.

## Setting it up

### With the wizard

Run `npx @orygn/discord-mcp init`. On a fresh setup it asks how many bots you
want to configure. Answer 1 for the usual single-bot install, or a higher
number to set several up now. For each bot it takes the token, waits for the
privileged intents, asks for a short name to tell the bots apart, and gives
you an invite link for that bot's server.

If you already have a bot configured, `init` instead offers to add another
bot, re-register with your AI client, reconfigure from scratch, or quit.
Adding a bot keeps your existing one and appends the new one, so you can
grow into multiple bots one at a time.

### By hand

Multiple bots live in a `bots.json` file next to your `.env` (see
[where config lives](#where-config-lives)). The format is a list of bots,
each with a name and a token, and exactly one marked as the default:

```json
{
  "bots": [
    { "name": "main", "token": "...", "default": true },
    { "name": "test", "token": "..." }
  ]
}
```

Names are how you refer to a bot when you need to be explicit; they are yours
to choose. The default bot is used for actions that are not tied to a server.
A `DISCORD_TOKEN` set in the environment or `.env` still counts as a bot too,
and if its token also appears in `bots.json` the two are recognized as one, so
nothing is loaded twice.

An optional `servers` object says which bot handles a server that more than
one of them is in. See [two bots in one server](#two-bots-in-one-server).

## How routing works

When a tool acts on a server, discord-mcp looks at which of your bots is a member
of that server and uses that one. In the normal case of one bot per server
there is nothing to think about: name the server, and the right bot acts.

When a request is ambiguous, discord-mcp stops and asks rather than guessing:

- A server name that matches more than one server asks you to be exact.
- A server no configured bot is in returns a clear message rather than a
  silent failure.

`list_servers` returns every server across all your bots, each labeled with
the bot that reaches it, which is the map to use when deciding.

## Two bots in one server

When more than one of your bots is in the same server, one of them handles
it, decided the same way every time:

1. The bot `bots.json` names for that server, if it does.
2. Otherwise the default bot, if it is one of the bots there.
3. Otherwise nothing is picked. The tool stops, names the bots, and gives
   the line to add to `bots.json`.

The choice goes in a `servers` object, keyed by server ID:

```json
{
  "bots": [
    { "name": "main", "token": "...", "default": true },
    { "name": "mod", "token": "..." }
  ],
  "servers": {
    "123456789012345678": "mod"
  }
}
```

Restart your AI client after editing it. An entry whose key is not a server
ID, or whose bot is not configured, is skipped with a line in the server
log. An entry naming a bot that has since left the server is passed over,
and the default bot handles the server again.

Every result from a shared server carries a line saying which bot ran and
why, on failures too: the two bots usually hold different roles, so a
refusal for a missing permission may only mean the other one was asked.
`list_servers` lists a shared server once per bot and marks the one that
handles it with `handles_server`.

## Choosing a bot explicitly

The tools that act on a bot itself take an optional `bot` parameter (a bot
name): `get_bot_info`, `run_setup_check`, `update_bot_profile`,
`leave_server`, and the application command tools. Without it they act as
the default bot, or when a server is named, as the bot that handles that
server.

`leave_server` is the exception. In a server two of your bots are in it
picks neither, and asks for `bot`: leaving cannot be taken back without a
new invite.

No other tool takes `bot`. Everything else routes by server and needs
nothing extra.

## Safety with multiple bots

The confirmation gate for destructive actions is bot-aware. When more than one
bot is configured, the preview names the bot and server up front, for example
"Acting as main in Community Server," so a misrouted action shows the wrong
name before anything happens and you can decline. The single-use confirm token
is also bound to the acting bot, so a token issued for one bot cannot be spent
as another. With a single bot, previews and tokens are unchanged.

`get_bot_info` and `run_setup_check` describe the bot they are asked about.
Only the default bot holds the live connection to Discord, so any other bot
shows as offline and reports no connection of its own.

## Live events

`subscribe_events` records what the default bot hears, one server at a
time. A server the default bot shares with another bot can be watched
whichever of them handles it for everything else. A server that only your
other bots are in cannot be watched: its events never reach this install,
and the tool says so instead of returning an empty buffer.

## Scheduled messages

A message queued with `schedule_message` is sent by the bot that scheduled
it, which is the bot in that server. If that bot is later removed from
`bots.json`, its queued messages stay queued and unsent until it is added
back or they are cancelled; the server log says so once per message.

## When a bot's token goes bad

If one bot's token is reset or otherwise stops working, only that bot is
affected; the others keep routing normally. `list_servers` marks the
unreachable bot so you can spot it, and `run_setup_check` with that bot's name
tells you exactly what is wrong:

```
run a setup check on the "test" bot
```

## Where config lives

Both `.env` and `bots.json` are read from one directory:

1. `DISCORD_MCP_HOME`, if that environment variable is set. Nothing else is
   read then.
2. Otherwise the package root (a source checkout) or `~/.orygn/discord-mcp`
   (an installed copy).

The folder your AI app starts the server from is not read: a bot project's
own `.env` there would otherwise replace the bot you set up.

Set `DISCORD_MCP_HOME` to keep all discord-mcp config, `.env`, `bots.json`, and saved
data, in one directory of your choosing. It is the same directory the wizard
writes to, so the wizard and the server always agree. `bots.json` holds bot
tokens and should be treated like `.env`: it is gitignored by default.

## One bot stays simple

If you only ever use one bot, you never see any of this. A single
`DISCORD_TOKEN` is one default bot, previews and tokens are byte-for-byte what
they were before, and there is no `bots.json` to think about. Multi-bot is
additive and stays out of the way until you opt in.
