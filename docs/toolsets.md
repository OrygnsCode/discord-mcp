# Toolsets

discord-mcp ships 164 tools. Every one of them is described to your AI client
before you type anything, which costs context on every request and gives the
model more options to choose between than most sessions need. The full set is
about 188 KB of JSON, roughly 47,000 tokens.

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
| `core` | 15 | 11.6 KB | Always on. Diagnostics, setup check, server and channel and role listings, message and member search, `find`, `catch_up`. |
| `messaging` | 21 | 29.2 KB | Sending (with files), editing, replies, DMs, reactions, polls, pins, scheduled messages. |
| `moderation` | 17 | 17.9 KB | Bans, kicks, timeouts, prune, the audit log, raid actions, AutoMod rules. |
| `structure` | 28 | 33.1 KB | Channels, roles, and permission overwrites, including locking and cloning, undoing any recorded change, and the security review with its who-can-reach views. |
| `builder` | 11 | 31.0 KB | Planning a server from a brief or a template link, editing an existing one, executing plans, blueprints and diffs. |
| `threads` | 8 | 5.6 KB | Threads and their members. |
| `forums` | 8 | 8.1 KB | Forum posts, replies, and tags. |
| `community` | 31 | 24.0 KB | Invites, webhooks, events, stages, emojis, stickers, soundboard. |
| `server` | 21 | 20.7 KB | Server settings, widget, welcome screen, onboarding, templates, the bot's presence and profile, leaving a server, slash commands. |
| `realtime` | 4 | 2.6 KB | Live gateway event subscriptions. |

## What it saves

Measured from the real `tools/list` response, with tokens approximated at four
bytes each:

| Setting | Tools | Payload | Tokens | Saved |
|---|---|---|---|---|
| unset (everything) | 164 | 188,326 B | ~47,100 | |
| `core` only | 15 | 11,858 B | ~3,000 | 94% |
| `messaging` | 36 | 41,808 B | ~10,500 | 78% |
| `builder` | 26 | 43,603 B | ~10,900 | 77% |
| `messaging,moderation` | 53 | 60,157 B | ~15,000 | 68% |
| `messaging,moderation,structure` | 81 | 94,041 B | ~23,500 | 50% |

## Choosing a set

- **Running a community day to day**: `messaging,moderation`.
- **Building or restructuring a server**: `builder,structure`.
- **A bot that only posts**: `messaging`.
- **Read only, for reporting**: `core` on its own. The security review is in
  `structure`.
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
discord-mcp v2.0.0 on stdio (toolsets: core, messaging, moderation)
```

## Adding a tool

Every tool must belong to exactly one group. The group map lives in
[`src/toolsets.ts`](../src/toolsets.ts), and the smoke suite fails if a
registered tool has no group, or if a group names a tool that does not exist.
See [CONTRIBUTING.md](../CONTRIBUTING.md).
