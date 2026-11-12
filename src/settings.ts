// Every DISCORD_MCP_* setting is read through here.
//
// Until 2.0 the settings were named OMNICORD_*. The old names still work
// through all of 2.x: a setting is read under its new name first, and under
// its old name only when the new one is not set at all. A new name that is
// set but empty counts as set, so tests and containers can blank a setting
// without an old-name value from some .env file leaking back in.
// DISCORD_TOKEN never had a prefix and is not affected.

export const PREFIX = "DISCORD_MCP_";
export const LEGACY_PREFIX = "OMNICORD_";

export const SETTING_NAMES = [
  "GUILD",
  "TOOLS",
  "SAFE_MODE",
  "CONFIRM",
  "GATEWAY",
  "HOME",
  "DATA_DIR",
  "PORT",
  "HTTP_HOST",
  "HTTP_TOKEN",
  "HTTP_ORIGINS",
  "SCHEDULER_TICK_MS",
  "ALLOW_PRIVATE_URLS",
  "UPDATE_CHECK",
  "STRICT_PARAMS",
] as const;

export type SettingName = (typeof SETTING_NAMES)[number];

type Env = Record<string, string | undefined>;

// The variable a setting is actually read from: the new name, unless only
// the old name is present.
export function settingSource(name: SettingName, env: Env = process.env): string {
  const current = PREFIX + name;
  const legacy = LEGACY_PREFIX + name;
  if (env[current] === undefined && env[legacy] !== undefined) return legacy;
  return current;
}

// The trimmed value, or undefined when unset or blank.
export function setting(name: SettingName, env: Env = process.env): string | undefined {
  const value = env[settingSource(name, env)]?.trim();
  return value ? value : undefined;
}

// Old names currently doing the work, for the setup check to point out.
export function legacySettingsInUse(env: Env = process.env): string[] {
  return SETTING_NAMES.filter(
    (name) => settingSource(name, env) === LEGACY_PREFIX + name
  ).map((name) => LEGACY_PREFIX + name);
}

// Renames old setting names in dotenv text to the new ones, keeping values,
// comments, and every other line as they are. When a file already has both
// names, the new one is kept and the old line is dropped, since the new
// name would win anyway.
export function renameLegacyEnvKeys(text: string): { text: string; renamed: string[] } {
  const lines = text.split(/\r?\n/);
  const present = new Set(
    lines
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1])
      .filter((key): key is string => key !== undefined)
  );
  const renamed: string[] = [];
  const out: string[] = [];
  for (const line of lines) {
    const key = line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
    const name = key?.startsWith(LEGACY_PREFIX) ? key.slice(LEGACY_PREFIX.length) : undefined;
    if (key && name && (SETTING_NAMES as readonly string[]).includes(name)) {
      renamed.push(key);
      if (present.has(PREFIX + name)) continue;
      out.push(line.replace(key, PREFIX + name));
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), renamed };
}
