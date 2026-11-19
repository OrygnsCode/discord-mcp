// How this copy reached the user when it is not a plain npm install: the
// Docker image and the Claude Desktop bundle set DISCORD_MCP_PACKAGING
// themselves (Dockerfile, mcpb/manifest.json). Both run the package from a
// folder that is not node_modules, and the bundle has no env section or
// .env for the user to edit: its settings are a form in Claude.

type Env = Record<string, string | undefined>;

export function packagedAs(env: Env = process.env): "docker" | "mcpb" | undefined {
  const kind = env.DISCORD_MCP_PACKAGING?.trim().toLowerCase();
  return kind === "docker" || kind === "mcpb" ? kind : undefined;
}

// Where a bundle user finds its settings, as Claude Desktop names them.
export const BUNDLE_SETTINGS = "Settings > Desktop app > Extensions > Discord MCP";
