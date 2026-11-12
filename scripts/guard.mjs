// Dev scripts act on whatever server the configuration points at, and in a
// source checkout that is the .env next to package.json, which may well hold
// a real community's bot. This keeps a script that builds or deletes from
// running against a server nobody named: the known disposable test servers
// pass, as do any listed in DISCORD_MCP_ACCEPTANCE_GUILDS, and any other
// server has to be named on the command line with --server=<id>.
//
// Call it before starting the server under the script. It resolves the token
// and server exactly as the server does, by loading its config module, and
// leaves both in this process's environment for the child to inherit, so the
// child runs with what was checked.

export const DISPOSABLE_GUILDS = [
  "1514153264613167187", // OmniCord Dev
  "1526520926446026824", // Omnicord Dev 2
];

export async function requireNamedServer(argv, what) {
  await import("../dist/config.js");
  const { setting } = await import("../dist/settings.js");
  const token = process.env.DISCORD_TOKEN;
  const guildId = setting("GUILD");
  if (!token || !guildId) {
    console.error(
      `Refusing to ${what}: no bot token or default server is configured. Point DISCORD_MCP_HOME ` +
        "at a folder whose .env has DISCORD_TOKEN and DISCORD_MCP_GUILD."
    );
    process.exit(1);
  }
  const allowed = new Set([
    ...DISPOSABLE_GUILDS,
    ...(process.env.DISCORD_MCP_ACCEPTANCE_GUILDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ]);
  const named = argv.find((a) => a.startsWith("--server="))?.slice("--server=".length);
  if (!allowed.has(guildId) && named !== guildId) {
    console.error(
      `Refusing to ${what}: the configured server is ${guildId}, which is not a known test server. ` +
        `If that is the server you mean, add --server=${guildId}.`
    );
    process.exit(1);
  }
  process.env.DISCORD_MCP_GUILD = guildId;
  return guildId;
}
