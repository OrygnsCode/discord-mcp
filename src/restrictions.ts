// Two ways to narrow what an install may do, both read once at startup:
//
//   DISCORD_MCP_READ_ONLY=true       only the tools that change nothing are
//                                    offered, and queued messages are not sent
//   DISCORD_MCP_ALLOWED_SERVERS=...  server ids the bots may act in; every
//                                    other server is refused, wherever the
//                                    call names it
//
// A value that cannot be read stops the server from starting. A typo in a
// setting that exists to hold the server back must not leave it with every
// tool and every server, looking as if the setting had worked.
import { setting, settingSource } from "./settings.js";

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

type Env = Record<string, string | undefined>;

export interface Restrictions {
  readOnly: boolean;
  // Undefined means no restriction.
  allowedServers?: ReadonlySet<string>;
  // Why the settings cannot be used, one line each. Non-empty means the
  // server refuses to start.
  problems: string[];
}

const TRUE_WORDS = ["true", "1", "yes", "on"];
const FALSE_WORDS = ["false", "0", "no", "off"];

export function parseReadOnly(raw: string | undefined, name = "DISCORD_MCP_READ_ONLY"): { value: boolean; problem?: string } {
  if (raw === undefined) return { value: false };
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.includes(word)) return { value: true };
  if (FALSE_WORDS.includes(word)) return { value: false };
  return { value: false, problem: `${name} is "${raw}". Use true or false.` };
}

export function parseAllowedServers(
  raw: string | undefined,
  name = "DISCORD_MCP_ALLOWED_SERVERS"
): { value?: Set<string>; problem?: string } {
  if (raw === undefined) return {};
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  // Only separators: an empty list would refuse every server, which is
  // never what was meant.
  if (entries.length === 0) {
    return { problem: `${name} holds no server ids. List server ids separated by commas, or remove it.` };
  }
  const bad = entries.filter((e) => !SNOWFLAKE_PATTERN.test(e));
  if (bad.length > 0) {
    return {
      problem:
        `${name} holds ${bad.map((b) => `"${b}"`).join(", ")}, which ${bad.length === 1 ? "is not a server id" : "are not server ids"}. ` +
        "List server ids separated by commas (in Discord: Developer Mode on, then right-click the server, Copy Server ID).",
    };
  }
  return { value: new Set(entries) };
}

export function loadRestrictions(env: Env = process.env, defaultGuild: string | undefined = setting("GUILD", env)): Restrictions {
  const readOnly = parseReadOnly(setting("READ_ONLY", env), settingSource("READ_ONLY", env));
  const allowed = parseAllowedServers(setting("ALLOWED_SERVERS", env), settingSource("ALLOWED_SERVERS", env));
  const problems = [readOnly.problem, allowed.problem].filter((p): p is string => p !== undefined);
  // A default server outside the list would make every call that leans on
  // the default fail. Said at startup, where it is fixed in one place. A
  // default given by name cannot be checked without asking Discord, so the
  // tools refuse it when it is used instead.
  if (allowed.value && defaultGuild && SNOWFLAKE_PATTERN.test(defaultGuild) && !allowed.value.has(defaultGuild)) {
    problems.push(
      `${settingSource("GUILD", env)} (${defaultGuild}) is not in ${settingSource("ALLOWED_SERVERS", env)}. ` +
        "Add it there, or change the default server."
    );
  }
  return { readOnly: readOnly.value, allowedServers: allowed.value, problems };
}
