# Recipes

Prompts that work, for the jobs people use discord-mcp for most. Type them as
they are, or change the details. You do not need to name tools: the AI picks
them. With more than one server, say which one ("in the Lounge server").

Anything that deletes, punishes, or hands out power shows you a preview first
and waits for your yes. Reads and ordinary posts just happen.

## Catch up on a busy server

> What happened in the server since yesterday? Summarize each channel and
> list any questions nobody answered.

Reads every channel and active thread with new messages, busiest first. Needs
the Message Content intent, which the setup check verifies.

## Find a message

> Find the message where someone posted the tournament signup link, probably
> in #announcements, sometime last month.

Searches Discord's own message index across every channel the bot can read,
including embeds and polls. It matches whole words.

## Clean up after a raid

> Accounts are spamming "free nitro" links in #general. Pause new invites,
> delete the spam messages in #general, and time out everyone who posted them
> for 24 hours.

Pausing invites happens at once. The delete and each timeout show a preview
first. The delete removes exactly the messages its preview showed, even if
more spam lands while you read it; ask again afterwards for a fresh preview
that includes the newer ones. Discord only bulk deletes messages under 14
days old, up to 100 at a time.

To stop new posts while you clean up:

> Lock #general until I say otherwise.

Locking happens at once. Unlocking a channel that was not locked from here
asks first.

## Check who can see a channel

> Who can see #staff-only, and can anyone post there who should not?

Lists @everyone, each role that can see it with its member count, who can
post, members with their own overrides, and the owner. For one person:

> What can Sam see and do in this server?

## Review the server's security

> Review this server's security the way an attacker would look at it, and
> give me the fixes in order of importance.

Findings come ranked from high to info, each with a plain fix: powers held by
everyone or by everyday roles, roles that can raise their own power, bots with
Administrator, missing two-factor and filters, and more.

## Build a server from a brief

> Build a server for a 200-person indie game community: announcements,
> general chat, a bug-report forum with tags, two voice rooms, and a mod-only
> area. Show me the plan before you build it.

The AI writes a blueprint and stages a plan, which changes nothing on
Discord. You read it, ask for changes, and say go. Every structural change is
recorded, so it can be undone.

## Change a server that already exists

> Export this server's layout, add an Events category with an announcements
> channel and a stage, and show me exactly what would change before doing it.

Edits go through the same plan: you see each item it would create or change,
and nothing outside the plan is touched.

## Undo

> Undo the last change you made.

Shows every step the undo would take and asks first. It checks the server
again when it runs.

## Schedule posts and events

> Every Monday at 9am Eastern, post "This week's check-in thread is up!" in
> #general.

Scheduled messages go out while discord-mcp is running. One that came due
while it was off goes out when it next starts.

> Create a weekly event called Game Night, Fridays at 8pm in the Lounge voice
> channel.

## Set up AutoMod

> Set up AutoMod to block slurs, block invite links to other servers, and
> time out anyone who mentions more than 5 people in one message.

Uses Discord's own filters, which run even when discord-mcp is not running:
the maintained slur list, a keyword rule, and the mention spam limit.

## Find out who did something

> Who deleted the #memes channel yesterday?

Reads the audit log with readable action names. Every change discord-mcp
makes carries a reason there too.

## Check the setup

> Run a setup check on my Discord bot.

Token, intents, permissions, how this app confirms destructive actions, and
the exact fix for anything wrong.

## An assistant that only reads

For an assistant that reports and searches but can never change anything,
set `DISCORD_MCP_READ_ONLY=true` in its configuration. Add
`DISCORD_MCP_ALLOWED_SERVERS` with a server id to keep it to one server. Then:

> Give me a weekly report for the Lounge server: the busiest channels, new
> members, and anything the moderators should look at.
