// The one-click install links in the README, made from one definition so
// they cannot drift apart. `node scripts/install-links.mjs` prints them;
// the unit tests check the README holds exactly these.
//
//   VS Code and Insiders: the server entry plus an input VS Code asks for
//     when the server first starts, as a password field, so the token never
//     sits in the config file. Format: vscode.dev/redirect/mcp/install with
//     name, inputs and config as URL-encoded JSON (quality=insiders for
//     Insiders).
//   Cursor: it has no prompt for secrets, so the entry carries an empty
//     DISCORD_TOKEN to fill in; the server says where when it is missing.
//     Format: cursor.com/en/install-mcp with name and the config as base64
//     JSON.
//   Claude Desktop: the bundle attached to the latest GitHub release.

export const NAME = "discord-mcp";
export const PACKAGE = "@orygn/discord-mcp";

export const vscodeConfig = {
  command: "npx",
  args: ["-y", PACKAGE],
  env: { DISCORD_TOKEN: "${input:discord_token}" },
};
export const vscodeInputs = [{ type: "promptString", id: "discord_token", description: "Discord bot token", password: true }];
export const cursorConfig = { command: "npx", args: ["-y", PACKAGE], env: { DISCORD_TOKEN: "" } };

const q = (v) => encodeURIComponent(JSON.stringify(v));

export const links = {
  vscode: `https://vscode.dev/redirect/mcp/install?name=${NAME}&inputs=${q(vscodeInputs)}&config=${q(vscodeConfig)}`,
  vscodeInsiders: `https://insiders.vscode.dev/redirect/mcp/install?name=${NAME}&inputs=${q(vscodeInputs)}&config=${q(vscodeConfig)}&quality=insiders`,
  cursor: `https://cursor.com/en/install-mcp?name=${NAME}&config=${encodeURIComponent(Buffer.from(JSON.stringify(cursorConfig)).toString("base64"))}`,
  claudeDesktop: "https://github.com/OrygnsCode/discord-mcp/releases/latest/download/discord-mcp.mcpb",
};

// Run directly: print them.
if (process.argv[1]?.split(/[\\/]/).slice(-2).join("/") === "scripts/install-links.mjs") {
  for (const [k, v] of Object.entries(links)) console.log(`${k}\n${v}\n`);
}
