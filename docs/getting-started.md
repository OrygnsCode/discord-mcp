# Getting started

This guide takes you from nothing to a working discord-mcp in a few minutes.
There are two ways to do it: the setup wizard, which handles almost
everything for you, or a manual setup if you prefer to do each step
yourself. Both end in the same place.

If you are an AI assistant reading this to help someone set up discord-mcp,
the steps below are written to be followed in order; each one says what to
do and how to check it worked.

## What you need

- Node.js 22 or newer.
- A Discord account, and permission to add a bot to the server you want to
  manage.

## Install

The quickest path is npx, which needs no clone:

```
npx @orygn/discord-mcp init
```

Prefer to follow along on video? The full setup walkthrough, from a blank
machine to a working install, is here:
https://www.youtube.com/watch?v=Qk0lY5PGHSE
It is a little dated now, but the core steps still apply, and a fuller
updated walkthrough is planned.

To run from source instead (or to develop against it):

```
git clone https://github.com/OrygnsCode/discord-mcp
cd discord-mcp
npm install
npm run build
node dist/index.js init
```

Either `init` command starts the setup wizard.

## The wizard (recommended)

The wizard first asks how many bots you want to set up. Answer 1 for the
usual single-bot install described below, or a higher number to configure
several at once, one per server (see [Multiple bots](multi-bot.md)). For a
single bot it walks these steps, validating each one against Discord live so
you find out immediately if something is wrong rather than later:

1. It points you to the Discord Developer Portal to create an application
   and a bot, if you do not have one.
2. It takes the bot token. The screen echo is off, so the token is not
   displayed as you paste it. It then checks the token with Discord and
   tells you the bot's name if it worked.
3. It reads which privileged intents are enabled and waits while you turn
   on any that are missing, rechecking when you press Enter. This is the
   step that prevents the most common silent failures.
4. It generates an invite link with the permission level you choose. The
   recommended option is a curated set that excludes the Administrator bit;
   full Administrator is also offered for owners who prefer not to manage
   permissions, with the safety gate confirming destructive actions either
   way. It then lists the servers the bot joined and lets you pick a
   default.
5. It saves the token to a local `.env` file and writes the discord-mcp entry
   into your AI client's configuration, adding only that entry, leaving
   everything else in the file as-is, and backing up the original first.
   Claude Desktop, Cursor, Windsurf, and project-level Claude Code are
   detected automatically, even before you have configured MCP in them. If
   a config file is not valid JSON, the wizard leaves it untouched and
   prints a snippet to paste instead. Anything else also gets a snippet.
   Run through npx, it first copies discord-mcp to `.orygn/discord-mcp/app/<version>`
   in your user folder and registers that copy, because the folder npx
   runs it from is a cache npm does not keep.

After the wizard finishes, fully restart your AI client (quit from the
system tray, not just the window). Then in a new conversation, ask it to
"run a setup check on my Discord bot." A healthy setup reports all checks
passing.

To add another bot later, or to change your setup, run `init` again. It
detects your existing configuration and offers to add a bot, re-register
with your AI client, reconfigure from scratch, or quit.

To update, run `npx @orygn/discord-mcp@latest init` and choose to re-register.
The new version is copied alongside the old one and your client is pointed
at it; your bots and settings are left as they are. Older versions stay in
`.orygn/discord-mcp/app` until you delete them, which is safe once no client config
points at them.

## Manual setup

If you would rather not use the wizard:

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create a New Application, then open the Bot page and use Reset Token to
   get a token. Copy it; it is shown once.
2. On that same Bot page, turn on all three Privileged Gateway Intents
   (Presence, Server Members, Message Content) and save. Below 10,000 users
   this needs no review.
3. Put the token in a `.env` file next to the package:

   ```
   DISCORD_TOKEN=your-token-here
   DISCORD_MCP_GUILD=your-default-server-id
   ```

   The default server id is optional; with it set, tools can omit the
   server argument. For more than one bot, use a `bots.json` in the same
   directory instead of a single token; see [Multiple bots](multi-bot.md).
4. Invite the bot. Open this URL, replacing the client id with your
   application's id, pick your server, and authorize:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=8
   ```

   The permissions value 8 is Administrator, which is simplest for a test
   server. For a real server, prefer a least-privilege value.
5. Register discord-mcp with your AI client. See
   [clients.md](clients.md) for the exact configuration per client.
6. Restart the client and run a setup check.

## Configuration reference

| Variable | What it does |
|---|---|
| `DISCORD_TOKEN` | The bot token. Required for anything real. |
| `DISCORD_MCP_GUILD` | Optional default server id so tools can omit the server. |
| `DISCORD_MCP_SAFE_MODE` | Default on. Destructive tools preview and require a confirm token first. Set to `false` only for trusted automation. |
| `DISCORD_MCP_CONFIRM` | `auto` (default) confirms destructive actions in a dialog when the app can show one, by the preview token otherwise. `token` always uses the token, for setups with nobody to answer a dialog. `dialog` refuses destructive actions in apps that cannot show one. |
| `DISCORD_MCP_UPDATE_CHECK` | Default on for an installed copy: once a day it asks the npm registry for the latest version number, and a newer one is mentioned once per session and in `run_setup_check`. Set `false` to never ask. |
| `DISCORD_MCP_STRICT_PARAMS` | Default on: a tool that changes something refuses a parameter it does not have, or a key inside one, and a read-only tool says which it ignored. Set `false` only for a host that adds keys of its own to every call and is refused for it. |
| `DISCORD_MCP_ALLOW_PRIVATE_URLS` | Off by default: files, emoji, stickers, sounds, and avatars are fetched only from public addresses. Set `true` only if you serve your own files from a private address. |
| `DISCORD_MCP_GATEWAY` | Default on with a token: the bot shows online and live events work. `off` for REST only. |
| `DISCORD_MCP_HOME` | Optional. One directory to hold `.env`, `bots.json`, and saved data. When set, it is the only place the token is read from. Defaults to the package root for a source checkout, `.orygn/discord-mcp` in your user folder for an installed copy. |
| `DISCORD_MCP_DATA_DIR` | Where saved blueprints and scheduled messages live. Default: `.discord-mcp` next to the package for a source checkout, `.orygn/discord-mcp` in your user folder for an installed copy. |
| `DISCORD_MCP_PORT` | HTTP port, default 3414. |
| `DISCORD_MCP_HTTP_HOST` | HTTP bind address, default 127.0.0.1. |
| `DISCORD_MCP_HTTP_TOKEN` | Bearer token for the HTTP transport. Required to bind beyond localhost. |
| `DISCORD_MCP_HTTP_ORIGINS` | Comma-separated browser origins allowed to call the HTTP endpoint. |

## Next

- [clients.md](clients.md) for connecting specific AI clients.
- [multi-bot.md](multi-bot.md) to run several bots from one install.
- [self-hosting.md](self-hosting.md) to run discord-mcp as a networked or
  containerized service.
- [troubleshooting.md](troubleshooting.md) if a step did not work.
