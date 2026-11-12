// Application flag bits that report gateway intent enablement, taken from
// the application resource docs. Each intent has two bits: the full flag
// (granted after a review, which Discord requires once more than 10,000
// users can see the app; 100 servers before June 2026) and the LIMITED
// flag (the self-service toggle below that point). Either one means the
// toggle is on in the Developer Portal, so both are always tested.
export const INTENT_FLAGS = {
  presence: (1 << 12) | (1 << 13),
  members: (1 << 14) | (1 << 15),
  messageContent: (1 << 18) | (1 << 19),
} as const;

export interface IntentStatus {
  presence: boolean;
  members: boolean;
  messageContent: boolean;
}

export function readIntents(flags: number): IntentStatus {
  return {
    presence: (flags & INTENT_FLAGS.presence) !== 0,
    members: (flags & INTENT_FLAGS.members) !== 0,
    messageContent: (flags & INTENT_FLAGS.messageContent) !== 0,
  };
}
