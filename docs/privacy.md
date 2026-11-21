# Privacy

discord-mcp runs on your machine (or on a server you run). Everything it does
in your Discord servers goes between it and Discord's API. Your bot token stays
in a file on your machine, or in your AI app's settings if you installed the
Claude Desktop bundle.

Two small things go elsewhere, both described in full below, and both can be
turned off: a daily usage report, and a daily check for a newer version.

What the tools return (messages, member names, and so on) goes to your AI
app, and from there to whichever AI service the app uses, under that
service's terms.

## Usage stats

Once a day, discord-mcp sends a small, anonymous usage report so we can see
which features people use and what to improve. Nothing in it identifies you or
your servers: there are no names, IDs, or message text from Discord in it, and
no ID for your install.

### When it is sent

- At most once a day per install. An install is the folder that holds its
  settings, so several AI apps using the same install send one report between
  them.
- Only on a day the install actually reaches Discord. An install with no bot
  token, or one that only lists its tools, sends nothing.
- A day's tool counts are sent with the next day's report.
- The setup wizard sends one short report when it ends, including when you
  quit it.

### What a daily report holds

Every value is a number band or one of a fixed list.

| Field | Values |
|---|---|
| Version | The discord-mcp version, like `2.1.0`. |
| Operating system | `windows`, `macos`, `linux`, or `other`. |
| AI app | One of a fixed list, such as Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Cline, Codex, or `other`. |
| Install | How it was installed: the setup wizard, npx, a global npm install, Docker, the Claude Desktop bundle, or `other`. |
| Context | `default`, or `container` when it runs in one. |
| Bots | `1`, `2-3`, or `4+`. |
| Servers | How many servers the bots are in: `0`, `1`, `2-5`, `6-20`, or `21+`. With `DISCORD_MCP_ALLOWED_SERVERS` set, only those count. |
| Largest server | Members of the largest one: `<50`, `50-500`, `500-5k`, or `5k+`. |
| Install age | Days since the install first reported: `0`, `1-7`, `8-30`, `31-90`, or `90+`. |
| First of week, month, ever | Whether today is the install's first active day of the week, of the month, and ever. This is how weekly and monthly use is counted without an ID. |
| Report number | A random number, new each day, so a report sent twice is counted once. |

And for each of the last few days it was used (up to seven):

| Field | Values |
|---|---|
| Tools | Each tool called that day, with how often: `1-9`, `10-99`, or `100+`. |
| Confirmations | How many previews were shown, confirmed, and declined, in the same bands. |
| Errors | Failed calls by kind (missing permission, intents off, rate limited, not found, invalid parameters, no token, network, other), in the same bands. |
| AI apps | Which apps from the fixed list were used that day. |

### What the setup wizard's report holds

Every value is one of a fixed list, or a version number.

| Field | Values |
|---|---|
| Version, operating system, install | As in the daily report. |
| Node.js | Its major version, like `22`. |
| Path | First setup, adding a bot, re-registering, or upgrading. |
| Outcome | Completed, unfinished, cancelled, or failed. |
| Apps | Where it registered the server: Claude Desktop, Claude Code, Cursor, Windsurf, or a printed snippet. |
| What went wrong along the way | Any of these: a token prompt that could not hide what was typed; a token that came with spaces, quotes, or invisible characters to take out; Ctrl+V or other keys typed where the token should have been pasted; a token with characters no token has; a token Discord rejected, and whether it looked like the Client Secret, the Public Key, or an ID; Discord answering busy, blocked, or with an error of its own; a connection that worked only on a second try; intents that were off; a bot in no server yet, or whose servers could not be listed; a copy out of npx's cache that failed; an app config file that was not valid JSON. |
| Step | For a setup that did not complete, the step it stopped at: starting, the token, the intents, naming the bot, the invite, the default server, saving, or registering. |
| Error | For a setup that failed, the kind of error (network, certificate, files, terminal, a Node.js older than it supports, or other) and its code from a fixed list, like `ENOTFOUND` or `EPERM`. |
| Report number | A random number, so a report sent twice is counted once. |

The error's own text is never sent. It can hold your file paths, your user
name, or even your bot token.

### Where it goes

Reports go to `telemetry.orygn.tech`, a Cloudflare Worker run by Orygn. Its
code is in this repository, in [`telemetry/`](../telemetry). It accepts only
the values listed above and stores anything else as `other` or drops it.

- Your IP address is not stored. Cloudflare's country code for the request is
  kept with the counts.
- Daily counts are kept. Individual reports are deleted after seven days, and
  report numbers after three.
- The stats are private to Orygn.

### Turning it off

Any one of these does it:

- `DISCORD_MCP_TELEMETRY=off`, in your AI app's config for discord-mcp (its
  `env` section) or in the `.env` in your settings folder.
- `DO_NOT_TRACK=1` in the environment.
- In the Claude Desktop bundle, untick **Usage stats** in the extension's
  settings (Settings > Desktop app > Extensions > Discord MCP).

It is also off on its own in CI, and in a copy run from a source checkout
unless you set `DISCORD_MCP_TELEMETRY=on`. A setup check
(`run_setup_check`) says whether it is on.

## Update check

Once a day, an npm install or the Claude Desktop bundle asks the npm registry
for the latest version number of `@orygn/discord-mcp`. The request carries
the package name and the version you run (in its user agent), and nothing
about your servers. When a newer version is out, your AI hears about it once
per session, and the setup check mentions it.
`DISCORD_MCP_UPDATE_CHECK=false` turns it off. A source checkout and the Docker
image never ask.

## Everything else

- Server data goes only to Discord: its API, and its image servers when a tool
  fetches an attachment or an avatar.
- Files, emoji, stickers, and sounds you ask it to upload from a link are
  fetched from that link.
- Nothing else leaves your machine.

Discord's own privacy policy: https://discord.com/privacy
