# Self-hosting

Run discord-mcp as a networked service or a container when you want it always
on (so scheduled messages fire and live events keep flowing while your
computer is off), or when your AI client connects to remote MCP servers
rather than launching local ones.

## The HTTP transport

Start discord-mcp in HTTP mode:

```
node dist/index.js --http              # 127.0.0.1:3414/mcp
node dist/index.js --http --port 8080
```

The MCP endpoint is at `/mcp`. A health endpoint is at `/healthz` and
reports the server's name and version.

## Security model, on by default

A bot token sits behind this endpoint, so the defaults are strict and you
should understand them:

- Binding to anything other than localhost without `DISCORD_MCP_HTTP_TOKEN`
  refuses to start. This prevents accidentally exposing the bot to a
  network. The error message names the fix.
- With a token set, every request to `/mcp` must send
  `Authorization: Bearer <token>`. The comparison is constant time.
- Requests that carry a browser `Origin` header are rejected unless the
  origin is in `DISCORD_MCP_HTTP_ORIGINS`. In localhost mode the `Host` header
  is validated too. Together these close the DNS-rebinding path that lets a
  web page reach a service on your machine.
- Open subscription streams and request body size are capped.

When you serve beyond localhost, always set a strong `DISCORD_MCP_HTTP_TOKEN`
and put the service behind TLS, for example with a reverse proxy such as
Caddy or nginx. The token authenticates; TLS keeps it private in transit.

Example:

```
DISCORD_MCP_HTTP_TOKEN=a-long-random-secret \
  node dist/index.js --http --host 0.0.0.0 --port 8080
```

## Docker

The image runs the HTTP transport as a non-root user and wires the
container health check to `/healthz`. Because it binds beyond localhost, it
requires `DISCORD_MCP_HTTP_TOKEN` and exits with a clear message without one.
The token never lives in the image; it arrives through the environment at
run time.

Build and run:

```
docker build -t discord-mcp .
docker run -d -p 3414:3414 \
  -e DISCORD_TOKEN=your-bot-token \
  -e DISCORD_MCP_HTTP_TOKEN=a-long-random-secret \
  -e DISCORD_MCP_GUILD=your-default-server-id \
  discord-mcp
```

Or with compose, after exporting the secrets in your shell or an env file:

```
docker compose up -d
```

## Persistent data

Saved blueprints and scheduled messages are stored as JSON files under the
data directory, which can be moved with `DISCORD_MCP_DATA_DIR`. The default
is a `.discord-mcp` folder next to the package for a source checkout, or
`.orygn/discord-mcp` in the user folder for an installed copy. To keep the data
across container restarts, mount that directory as a volume.

To keep all config and data in one place, set `DISCORD_MCP_HOME` to a directory
and mount it as a volume: `.env`, `bots.json`, and saved data all live there.
This is also how to run several bots in a container, since there is no
multi-token environment variable: put a `bots.json` in the mounted
`DISCORD_MCP_HOME`. See [Multiple bots](multi-bot.md).

## Connecting a remote client

Point your client's remote MCP configuration at
`http://your-host:port/mcp` with the bearer token. Serving is stateless:
clients on the current protocol (2026-07-28) send their protocol version
with every request, and clients on the 2025 revisions are answered without
a session id, so no client is tied to one server process. Everything else
works exactly as it does locally. For a hosted, zero-setup version of this
without running anything yourself, see the project roadmap.
