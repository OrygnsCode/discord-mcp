// Discord's two growth thresholds for a bot, which since June 10, 2026 are
// separate things:
//
// - App Verification still counts servers. An unverified bot cannot join
//   more than 100 servers, and verification can be requested from 75.
// - Privileged intents count people. Once more than 10,000 unique users can
//   see the bot across all its servers, Discord sends a notice and the owner
//   has 90 days to apply for continued access. Below that, the portal toggle
//   is all it takes. Before June 2026 this, too, was the 100 server line.
//
// A bot cannot count unique users. The closest it can see is each server's
// approximate member count, and their sum counts anyone in two servers twice,
// so it is an upper bound and is described as one.

export const VERIFICATION_OPENS_AT = 75;
export const UNVERIFIED_SERVER_LIMIT = 100;
export const INTENT_REVIEW_USERS = 10_000;
// Where the user check starts warning, ahead of the notice.
export const INTENT_REVIEW_WARN_AT = 7_500;

export interface ThresholdCheck {
  check: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export function growthChecks(input: {
  serverCount: number;
  // True when the guild list was cut off at its page size, so the counts
  // below are a floor.
  capped: boolean;
  verified: boolean;
  memberTotal: number;
  anyPrivilegedIntent: boolean;
}): ThresholdCheck[] {
  const checks: ThresholdCheck[] = [];
  const servers = `${input.serverCount}${input.capped ? " or more" : ""} server${input.serverCount === 1 && !input.capped ? "" : "s"}`;

  if (input.verified) {
    checks.push({
      check: "guild_count",
      status: "pass",
      detail: `Bot is in ${servers} and is verified, so no server limit applies.`,
    });
  } else if (input.serverCount >= UNVERIFIED_SERVER_LIMIT) {
    checks.push({
      check: "guild_count",
      status: "warn",
      detail: `Bot is in ${servers} and is not verified: Discord stops an unverified bot at ${UNVERIFIED_SERVER_LIMIT} servers.`,
      fix: "Apply for App Verification in the Developer Portal to grow past it.",
    });
  } else if (input.serverCount >= VERIFICATION_OPENS_AT) {
    checks.push({
      check: "guild_count",
      status: "warn",
      detail: `Bot is in ${servers} and is not verified. Discord stops an unverified bot at ${UNVERIFIED_SERVER_LIMIT}; verification can be requested from ${VERIFICATION_OPENS_AT}.`,
      fix: "Apply for App Verification in the Developer Portal now if it will keep growing.",
    });
  } else {
    checks.push({
      check: "guild_count",
      status: "pass",
      detail: `Bot is in ${servers}. Verification only becomes necessary to grow past ${UNVERIFIED_SERVER_LIMIT}.`,
    });
  }

  const members = `${input.memberTotal.toLocaleString("en-US")}${input.capped ? " or more" : ""}`;
  const howCounted =
    "summed across its servers, so anyone in more than one counts more than once";
  if (!input.anyPrivilegedIntent) {
    checks.push({
      check: "user_count",
      status: "pass",
      detail: `About ${members} members (${howCounted}). No privileged intent is on, so the ${INTENT_REVIEW_USERS.toLocaleString("en-US")} user review does not apply.`,
    });
  } else if (input.memberTotal >= INTENT_REVIEW_USERS) {
    checks.push({
      check: "user_count",
      status: "warn",
      detail: `About ${members} members (${howCounted}). Past ${INTENT_REVIEW_USERS.toLocaleString("en-US")} unique users, Discord requires a review to keep privileged intents. Its count is of unique users, so the real figure may be lower.`,
      fix:
        "Watch the Developer Portal for Discord's notice; once it arrives there are 90 days " +
        "to apply for continued access to each privileged intent in use.",
    });
  } else if (input.memberTotal >= INTENT_REVIEW_WARN_AT) {
    checks.push({
      check: "user_count",
      status: "warn",
      detail: `About ${members} members (${howCounted}), approaching the ${INTENT_REVIEW_USERS.toLocaleString("en-US")} unique users at which Discord requires a review to keep privileged intents.`,
      fix: "Nothing to do yet. Once Discord's notice arrives there are 90 days to apply.",
    });
  } else {
    checks.push({
      check: "user_count",
      status: "pass",
      detail: `About ${members} members (${howCounted}), under the ${INTENT_REVIEW_USERS.toLocaleString("en-US")} unique users at which Discord requires a review to keep privileged intents.`,
    });
  }
  return checks;
}
