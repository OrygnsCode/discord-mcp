// Message links. "Copy Message Link" in Discord gives
// https://discord.com/channels/<server>/<channel>/<message>, and that is
// what people paste when they mean "this message". A parameter that wants a
// message id takes the link too and reads the id out of it.
//
// The link also says which channel the message is in, and the tools take
// the channel separately. When the two disagree, the request would fail as
// an unknown message, or worse, address a different channel than the user
// pointed at. So the link's channel is remembered, and a request that names
// the message under another channel is refused with the reason.

// Both hosts Discord has used, its two test builds, a trailing slash, and
// the angle brackets people wrap a link in to stop its preview. A DM link
// has @me where the server id goes.
const LINK =
  /^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})\/?>?$/i;

export function parseMessageLink(text: string): { channelId: string; messageId: string } | undefined {
  const m = text.trim().match(LINK);
  return m ? { channelId: m[1], messageId: m[2] } : undefined;
}

export class MessageLinkError extends Error {
  constructor(linkChannelId: string) {
    super(
      `That message link is for a different channel (id ${linkChannelId}) than the one this call names, ` +
        "so nothing was sent. Pass that channel id as the channel. A message in a thread or forum post " +
        "is in the thread, not in its parent channel."
    );
    this.name = "MessageLinkError";
  }
}

// Message id to the channel its link named. Ids are unique across Discord,
// so this needs no server or caller. It holds what recent links said and
// nothing else: bounded, oldest out first.
const linked = new Map<string, string>();
const MAX_LINKS = 200;

export function rememberMessageLink(messageId: string, channelId: string): void {
  linked.delete(messageId);
  linked.set(messageId, channelId);
  if (linked.size > MAX_LINKS) linked.delete(linked.keys().next().value as string);
}

// Refuses a message addressed in a channel other than the one its link
// named. The link's word is used once: a link someone typed wrongly should
// not go on refusing the message's id afterwards.
export function assertLinkedChannel(messageId: string, channelId: string): void {
  const said = linked.get(messageId);
  if (said === undefined) return;
  linked.delete(messageId);
  if (said !== channelId) throw new MessageLinkError(said);
}

// The same check for a request about to be sent: any id after
// /channels/<channel>/ that a link placed in another channel. Covers
// messages, pins, reactions, polls, and threads started from a message.
export function assertRouteMatchesLinks(route: string): void {
  if (linked.size === 0) return;
  const parts = route.split("/");
  if (parts[1] !== "channels" || !/^\d{17,20}$/.test(parts[2] ?? "")) return;
  for (const part of parts.slice(3)) {
    if (linked.has(part)) assertLinkedChannel(part, parts[2]);
  }
}

export const __testing = {
  size: () => linked.size,
  clear: () => linked.clear(),
};
