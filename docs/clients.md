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
your built `dist/index.js`, or use the npx form (no clone needed). No
token goes in the client configuration; discord-mcp reads it from its `.env`
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
claude mcp add discord-mcp -- node /absolute/path/to/discord-mcp/dist/index.js
```

A new session in that directory prompts to approve the server.

## Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in a project, with
the same mcpServers shape as above.

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`, same shape.

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
