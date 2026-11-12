// How the server identifies itself to AI apps. The name is the id clients
// key on; the title is what an app can show a person. The description opens
// with the same category phrase used on every listing.
export const SERVER_INFO = {
  name: "discord-mcp",
  title: "Discord MCP",
  description:
    "Discord server management MCP for AI agents: chat, moderation, admin, and full server building.",
  websiteUrl: "https://orygn.tech",
} as const;

// The npm package and the command it installs. The command carries the
// company name because a bare "discord-mcp" command is already installed by
// other packages, and npm refuses to install two packages that claim the
// same command.
export const PACKAGE_NAME = "@orygn/discord-mcp";
export const COMMAND = "orygn-discord-mcp";
