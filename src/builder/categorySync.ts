import { Routes } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";

// Discord keeps the channels synced with a category in step with it. Change
// one of the category's permission overwrites (a PUT or DELETE on
// /channels/{category}/permissions/{id}) and Discord makes the same change,
// on its side and with no audit log entry, in every channel of the category
// whose overwrites matched the category's exactly a moment before. A channel
// given the same overwrites explicitly counts as synced too. Replacing the
// category's whole list with a PATCH does not do this. Both were checked
// against Discord in November 2026.
//
// A build or an undo changes only what its plan or preview shows, so while
// it changes a category's overwrites the channels synced with it are held:
// each gets an empty overwrite (allow nothing, deny nothing), which changes
// no permission but makes the channel differ from its category, and loses it
// again afterward. A channel that should follow the category gets a step of
// its own in the plan.

export interface OverwriteLike {
  id: string;
  type: number | string;
  allow: string;
  deny: string;
}

export interface ChannelLike {
  id: string;
  type: number;
  name?: string | null;
  parent_id?: string | null;
  permission_overwrites?: OverwriteLike[];
}

export interface HoldTarget {
  id: string;
  type: 0 | 1;
  // How to name it in a message: "the bot", "@everyone", a role's name.
  label: string;
}

// Hold targets in order of preference: the bot as a member, @everyone,
// then the roles.
export function holdCandidates(
  guildId: string,
  botUserId: string | undefined,
  roles: Array<{ id: string; name?: string | null }>
): HoldTarget[] {
  return [
    ...(botUserId ? [{ id: botUserId, type: 1 as const, label: "the bot" }] : []),
    { id: guildId, type: 0 as const, label: "@everyone" },
    ...roles
      .filter((r) => r.id !== guildId)
      .map((r) => ({ id: r.id, type: 0 as const, label: `the role ${r.name ?? r.id}` })),
  ];
}

export interface Held {
  channelId: string;
  name: string;
  target: HoldTarget;
}

function key(list: OverwriteLike[] | undefined): string {
  return (list ?? [])
    .map((o) => `${o.id}:${Number(o.type)}:${o.allow}:${o.deny}`)
    .sort()
    .join("|");
}

export function sameOverwriteList(
  a: OverwriteLike[] | undefined,
  b: OverwriteLike[] | undefined
): boolean {
  return key(a) === key(b);
}

// The channels in a category that Discord would change along with it.
export function syncedWith(categoryId: string, channels: Iterable<ChannelLike>): ChannelLike[] {
  const all = [...channels];
  const category = all.find((c) => c.id === categoryId);
  if (!category || category.type !== 4) return [];
  return all.filter(
    (c) =>
      c.type !== 4 &&
      c.parent_id === categoryId &&
      sameOverwriteList(c.permission_overwrites, category.permission_overwrites)
  );
}

// Something to hold a channel with: the first candidate that has no
// overwrite on it yet. Candidates come in order of preference (the bot as a
// member, then @everyone, then any role).
export function holdTarget(channel: ChannelLike, candidates: HoldTarget[]): HoldTarget | null {
  const taken = new Set((channel.permission_overwrites ?? []).map((o) => o.id));
  return candidates.find((c) => !taken.has(c.id)) ?? null;
}

export const HOLD_REASON = "discord-mcp: held while its category's permissions change";

// When a change fails and a hold then cannot be let go, the failure carries
// the stuck holds with it. Otherwise nothing would know those channels have
// an entry more than they should: no warning, no record for undo, and a
// channel that silently no longer matches its category.
const STUCK = Symbol("holds that could not be let go");

function carryStuck(err: unknown, stuck: Held[]): void {
  if (stuck.length === 0 || typeof err !== "object" || err === null) return;
  const bag = err as { [STUCK]?: Held[] };
  bag[STUCK] = [...(bag[STUCK] ?? []), ...stuck];
}

export function stuckFrom(err: unknown): Held[] {
  return (typeof err === "object" && err !== null && (err as { [STUCK]?: Held[] })[STUCK]) || [];
}

// Holds every channel synced with the category. All or nothing: if one
// cannot be held, the ones already held are let go and the error stands,
// before anything about the category has changed.
export async function holdSynced(
  rest: REST,
  categoryId: string,
  channels: Iterable<ChannelLike>,
  candidates: HoldTarget[]
): Promise<Held[]> {
  const held: Held[] = [];
  try {
    for (const child of syncedWith(categoryId, channels)) {
      const target = holdTarget(child, candidates);
      const name = child.name ?? child.id;
      if (!target) {
        throw new Error(
          `${name} matches its category's permissions, and there is nothing to hold it with, ` +
            "so changing the category would change it too."
        );
      }
      await rest.put(Routes.channelPermission(child.id, target.id), {
        body: { type: target.type, allow: "0", deny: "0" },
        reason: HOLD_REASON,
      });
      held.push({ channelId: child.id, name, target });
    }
  } catch (err) {
    carryStuck(err, await release(rest, held));
    throw err;
  }
  return held;
}

// Lets the held channels go. Returns the ones that could not be let go,
// which keep an empty overwrite: harmless, but worth saying.
export async function release(rest: REST, held: Held[]): Promise<Held[]> {
  const stuck: Held[] = [];
  for (const h of held) {
    try {
      await rest.delete(Routes.channelPermission(h.channelId, h.target.id), { reason: HOLD_REASON });
    } catch {
      stuck.push(h);
    }
  }
  return stuck;
}

// Runs a change to a category's overwrites with its synced channels held.
export async function withSyncedHeld<T>(
  rest: REST,
  categoryId: string,
  channels: Iterable<ChannelLike>,
  candidates: HoldTarget[],
  run: () => Promise<T>
): Promise<{ value: T; stuck: Held[] }> {
  const held = await holdSynced(rest, categoryId, channels, candidates);
  let value: T;
  try {
    value = await run();
  } catch (err) {
    carryStuck(err, await release(rest, held));
    throw err;
  }
  const stuck = await release(rest, held);
  return { value, stuck };
}

export function stuckWarning(stuck: Held[]): string[] {
  return stuck.map(
    (h) =>
      `${h.name} kept an empty permission entry (allow nothing, deny nothing) that changes no ` +
      `permission, for ${h.target.label}; clear_channel_permissions on ${h.channelId} with target ${h.target.id} removes it.`
  );
}
