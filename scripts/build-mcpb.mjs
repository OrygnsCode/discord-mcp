// Builds the Claude Desktop bundle, discord-mcp.mcpb, from the current build.
//   npm run build && node scripts/build-mcpb.mjs [output path]
//
// The bundle holds dist, the production dependencies, the manifest from
// mcpb/manifest.json with its version set to package.json's, the icons and
// the license. The manifest is copied as written, with only the version
// string replaced, so its layout never changes. The release workflow runs
// this and attaches the result to the GitHub release under a fixed name,
// which is what the README's Claude Desktop button downloads.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = resolve(process.argv[2] ?? join(root, "discord-mcp.mcpb"));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

// npm and npx are .cmd files on Windows, which only start through a shell,
// and a shell joins the arguments as text: anything with a space is quoted.
const windows = process.platform === "win32";
const quote = (a) => (windows && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args.map(quote), { cwd, stdio: "inherit", shell: windows });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed (${r.status}).`);
    process.exit(1);
  }
}

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("No dist/index.js. Run npm run build first.");
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "discord-mcp-bundle-"));
try {
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "LICENSE"]) cpSync(join(root, file), join(stage, file));
  cpSync(join(root, "assets", "icon-light.png"), join(stage, "icon-light.png"));
  cpSync(join(root, "assets", "icon-dark.png"), join(stage, "icon-dark.png"));

  const manifest = readFileSync(join(root, "mcpb", "manifest.json"), "utf8");
  const versioned = manifest.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(versioned).version !== version) {
    console.error("Could not set the manifest's version.");
    process.exit(1);
  }
  writeFileSync(join(stage, "manifest.json"), versioned);

  // Production dependencies only, exactly as locked, with no install scripts.
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  run("npx", ["--yes", MCPB, "validate", join(stage, "manifest.json")], stage);
  rmSync(out, { force: true });
  run("npx", ["--yes", MCPB, "pack", stage, out], stage);
  console.log(`\n${out}: ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, version ${version}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
