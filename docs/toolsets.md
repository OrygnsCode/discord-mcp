# Toolsets

discord-mcp ships 164 tools. Every one of them is described to your AI client
before you type anything, which costs context on every request and gives the
model more options to choose between than most sessions need. The full set is
about 205 KB of JSON, roughly 51,000 tokens.

`DISCORD_MCP_TOOLS` narrows that to the groups you actually use.

This is optional. Leave the variable unset and all 164 tools load, exactly as
they always have.

## Using it

Set the variable to a comma separated list of group names:

```
DISCORD_MCP_TOOLS=messaging,moderation
```

In a client configuration:

```json
{
  "mcpServers": {
    "discord-mcp": {
      "command": "npx",
      "args": ["-y", "@orygn/discord-mcp"],
      "env": { "DISCORD_MCP_TOOLS": "messaging,moderation" }
    }
  }
}
```

Restart the client afterwards. The tool list is read when the session starts.
The setup wizard keeps this `env` block when it re-registers or updates the
entry.

## The groups

`core` is always loaded and does not need to be listed. Without it the server
cannot tell you which servers it can reach or whether your setup works, which
makes every other group harder to use.

Size is the group's own weight: the `tools/list` payload with that group
selected, minus the payload of `core` alone.

| Group | Tools | Size | What it covers |
|---|---|---|---|
| `core` | 15 | 11.7 KB | Always on. Diagnostics, setup check, server and channel and role listings, message and member search, `find`, `catch_up`. |
| `messaging` | 21 | 30.6 KB | Sending (with files), editing, replies, DMs, reactions, polls, pins, scheduled messages. |
| `moderation` | 17 | 19.9 KB | Bans, kicks, timeouts, prune, the audit log, raid actions, AutoMod rules. |
| `structure` | 28 | 37.0 KB | Channels, roles, and permission overwrites, including locking and cloning, undoing any recorded change, and the security review with its who-can-reach views. |
| `builder` | 11 | 31.4 KB | Planning a server from a brief or a template link, editing an existing one, executing plans, blueprints and diffs. |
| `threads` | 8 | 6.4 KB | Threads and their members. |
| `forums` | 8 | 9.0 KB | Forum posts, replies, and tags. |
| `community` | 31 | 29.0 KB | Invites, webhooks, events, stages, emojis, stickers, soundboard. |
| `server` | 21 | 22.9 KB | Server settings, widget, welcome screen, onboarding, templates, the bot's presence and profile, leaving a server, slash commands. |
| `realtime` | 4 | 2.8 KB | Live gateway event subscriptions. |

## What it saves

Measured from the real `tools/list` response, with tokens approximated at four
bytes each:

| Setting | Tools | Payload | Tokens | Saved |
|---|---|---|---|---|
| unset (everything) | 164 | 205,478 B | ~51,400 | |
| `core` only | 15 | 11,992 B | ~3,000 | 94% |
| `messaging` | 36 | 43,325 B | ~10,800 | 79% |
| `builder` | 26 | 44,117 B | ~11,000 | 79% |
| `messaging,moderation` | 53 | 63,652 B | ~15,900 | 69% |
| `messaging,moderation,structure` | 81 | 101,540 B | ~25,400 | 51% |
| `DISCORD_MCP_READ_ONLY=true` | 60 | 49,984 B | ~12,500 | 76% |
| read-only with `messaging,moderation` | 24 | 18,303 B | ~4,600 | 91% |

## Choosing a set

- **Running a community day to day**: `messaging,moderation`.
- **Building or restructuring a server**: `builder,structure`.
- **A bot that only posts**: `messaging`.
- **Read only, for reporting**: `DISCORD_MCP_READ_ONLY=true`. It keeps every
  lookup, the security review included, and drops everything that changes
  something, at about a quarter of the full size. It combines with
  `DISCORD_MCP_TOOLS`: read-only applies to whichever groups are loaded.
  `core` on its own is smaller still.
- **Not sure**: leave it unset. Nothing breaks; you carry the whole surface.

Groups are assigned per tool, not per source file, so a group holds what you
would expect it to hold rather than mirroring the code layout.

## If you get the name wrong

discord-mcp refuses to start and tells you which name it did not recognise, along
with the full list of valid groups. It does not quietly load a smaller set,
because tools disappearing without explanation is much harder to debug than a
server that will not boot.

In stdio mode the startup line on stderr also names the active groups, so you
can confirm what a session loaded:

```
discord-mcp v2.2.1 on stdio (toolsets: core, messaging, moderation)
```

## Adding a tool

Every tool must belong to exactly one group. The group map lives in
[`src/toolsets.ts`](../src/toolsets.ts), and the smoke suite fails if a
registered tool has no group, or if a group names a tool that does not exist.
See [CONTRIBUTING.md](../CONTRIBUTING.md).
