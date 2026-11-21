# Connecting AI clients

discord-mcp speaks the Model Context Protocol, so it works with any MCP
client. This guide gives the exact configuration for the common ones. The
setup wizard writes most of these for you; this is the reference for doing
it by hand or for clients the wizard does not detect.

There are two transports:

- stdio, where the client launches discord-mcp as a local process. This is the
  default and what the configurations below use.
- Streamable HTTP, for clients that connect to a running server over the
  network, including remote and hosted setups. See
  [self-hosting.md](self-hosting.md).

In every stdio configuration, replace the path with the absolute path to
your built `dist/index.js`, or use the npx form (no clone needed). The npx
form needs Node 22 or newer. The token does not need to be in the client
configuration; discord-mcp reads it from its `.env`
file: next to the package for a source checkout, or `.orygn/discord-mcp/.env` in
your user folder for an npx or global install, or from `DISCORD_MCP_HOME` if
you set it. Multiple bots are configured in a `bots.json` in the same
directory; see [Multiple bots](multi-bot.md).

## The two command forms

From source:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/discord-mcp/dist/index.js"]
}
```

From npm:

```json
{
  "command": "npx",
  "args": ["-y", "@orygn/discord-mcp"]
}
```

## Claude Desktop

### The bundle

The simplest way in Claude Desktop, and it needs no Node of your own: Claude
runs it on its built-in one.

1. Download `discord-mcp.mcpb` from the
   [latest release](https://github.com/OrygnsCode/discord-mcp/releases/latest).
2. Open it with Claude Desktop, or drag it onto Settings > Desktop app >
   Extensions (Manage). Drop it on the Extensions area at the top of that
   page; on the Local MCP servers list below it, nothing happens. On
   Windows, double-clicking the file may open a "Pick an app" box instead of
   Claude; dragging it in always works.
3. Claude shows what it is installing, then a form for its settings: paste
   your bot token, and optionally a default server id. Read-only mode,
   allowed servers, and usage stats are there too.
4. Save, and switch the extension on at the top of its page. While the
   "Save these settings?" box is open, keep Claude's window in front: Claude
   ignores the answer if its window loses focus.

To change a setting later, open Settings > Desktop app > Extensions > Discord
MCP. The bundle does not update itself; to update, open the newest one the
same way. Claude shows Update instead of Install, and the token, the other
settings, and the extension's on switch all stay as they were.

### The config file

Edit `claude_desktop_config.json`. Claude Desktop opens the right file for
you under Settings, Developer, Edit Config. Its location depends on the
install:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows, current builds:
  `%LOCALAPPDATA%\Claude-Data\claude_*\claude_desktop_config.json`
- Windows, older builds: `%APPDATA%\Claude\claude_desktop_config.json`, or for
  the Microsoft Store build
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`

When Desktop moves its data to the new location, the old folder stays behind
with no config in it. A file created there is never read.

Add discord-mcp to the mcpServers object, leaving any existing servers in
place:

```json
{
  "mcpServers": {
    "discord-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp/dist/index.js"]
    }
  }
}
```

Fully quit Claude Desktop from the system tray and reopen it. discord-mcp
appears under Settings, Developer.

## Claude Code

Project scope (a `.mcp.json` in the project directory, shared with anyone
who opens it):

```json
{
  "mcpServers": {
    "discord-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp/dist/index.js"]
    }
  }
}
```

Or use the CLI if it is on your path:

```
claude mcp add --scope project discord-mcp -- node /absolute/path/to/discord-mcp/dist/index.js
```

A new session in that directory prompts to approve the server.

## VS Code

The [Install in VS Code](../README.md#one-click-installs) button (or the
Insiders one) adds the server to your user configuration. VS Code asks for the
bot token the first time the server starts and keeps it as a secret, so it
never sits in the file.

By hand, run **MCP: Open User Configuration** from the command palette, or
create `.vscode/mcp.json` in a project:

```json
{
  "servers": {
    "discord-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@orygn/discord-mcp"],
      "env": { "DISCORD_TOKEN": "${input:discord_token}" }
    }
  },
  "inputs": [
    { "type": "promptString", "id": "discord_token", "description": "Discord bot token", "password": true }
  ]
}
```

If you ran the setup wizard, the token is already saved and you can leave out
`env` and `inputs`. To make VS Code forget a stored token, open the
configuration, hover the `= **********` after the input, and choose Clear.

## Cursor

The [Install in Cursor](../README.md#one-click-installs) button opens Cursor's
install box, which has a field for the token under Secrets.

By hand, edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in a
project, with the same mcpServers shape as above.

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`, same shape.

## Codex CLI

```
codex mcp add discord-mcp -- npx -y @orygn/discord-mcp
```

Or add it to `~/.codex/config.toml`:

```toml
[mcp_servers.discord-mcp]
command = "npx"
args = ["-y", "@orygn/discord-mcp"]
startup_timeout_sec = 30
```

Codex waits 10 seconds for a server to start by default, and npx can take
longer than that the first time, while it downloads the package. The token
comes from the setup wizard's saved settings; to pass it here instead, add a
`[mcp_servers.discord-mcp.env]` table with `DISCORD_TOKEN`, or list
`DISCORD_TOKEN` in `env_vars` to forward it from your shell. The Codex IDE
extension reads the same file.

## Cline

In the Cline panel, open **MCP Servers**, then the **Configure** tab, then
**Configure MCP Servers**. Add discord-mcp to the JSON that opens:

```json
{
  "mcpServers": {
    "discord-mcp": {
      "command": "npx",
      "args": ["-y", "@orygn/discord-mcp"],
      "disabled": false
    }
  }
}
```

As with Codex, the token comes from the setup wizard's saved settings, or add
`"env": { "DISCORD_TOKEN": "..." }` to the entry.

## ChatGPT and other remote-only clients

Clients that only connect to remote MCP servers (over HTTP) cannot launch a
local process. For these, run discord-mcp in HTTP mode and point the client at
its URL with the bearer token. See [self-hosting.md](self-hosting.md) for
running the HTTP transport with authentication.

## Any other MCP client

If your client is not listed, it still works. It needs to either:

- launch `node /absolute/path/to/discord-mcp/dist/index.js` over stdio, using
  whatever configuration format the client documents, or
- connect to a running HTTP instance.

The wizard prints a ready-to-paste snippet for clients it does not write
automatically.

## After connecting

Restart the client so it picks up the new configuration, then ask it to run
a setup check on your Discord bot. If the tools do not appear, the client
almost always just needs a full restart. See
[troubleshooting.md](troubleshooting.md).
