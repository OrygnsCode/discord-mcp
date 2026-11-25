import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { quoted } from "./names.js";
import { setting, settingSource } from "../settings.js";

// Files on this machine, read only from one folder the person running the
// server chose for it (DISCORD_MCP_FILES_DIR), and only for pictures and
// sounds that become part of the server or the bot (emoji, stickers,
// sounds, role icons, the server's and the bot's images), never for files
// posted in a message. Without the setting nothing local is read at all.
//
// The folder is the whole boundary: a message in a channel can talk an AI
// into naming any path, so a name is resolved inside the folder, links are
// followed to where they really point, and anything that ends up outside
// is refused. Callers then check the file's own first bytes, so only an
// image or a sound is ever uploaded, whatever its name says.

export function filesDir(): string | undefined {
  return setting("FILES_DIR");
}

export type LocalFile =
  | { ok: true; data: Buffer; name: string }
  | { ok: false; error: string; tooLarge?: { bytes: number } };

function inside(path: string, root: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const base = root.endsWith(sep) ? root : root + sep;
  return fold(path).startsWith(fold(base));
}

export function readLocalFile(name: string, maxBytes: number): LocalFile {
  const dir = filesDir();
  if (!dir) {
    return {
      ok: false,
      error:
        "Files on this computer are read only from a folder chosen for it, and none is set. " +
        `To allow it, set ${settingSource("FILES_DIR")} to that folder and put the file there; ` +
        "otherwise give a public link to the file.",
    };
  }
  let root: string;
  try {
    root = realpathSync(dir);
    if (!statSync(root).isDirectory()) throw new Error("not a folder");
  } catch {
    return { ok: false, error: `The files folder set in ${settingSource("FILES_DIR")} does not exist or is not a folder: ${dir}.` };
  }
  // Outside by its path alone is refused before anything is looked up, so
  // whether a file exists elsewhere on this machine is never revealed.
  const wanted = resolve(root, name);
  if (!inside(wanted, root)) {
    return { ok: false, error: `${quoted(name)} is not inside the files folder, and only that folder is read.` };
  }
  let real: string;
  try {
    real = realpathSync(wanted);
  } catch {
    return { ok: false, error: `There is no file named ${quoted(name)} in the files folder (${root}).` };
  }
  if (!inside(real, root)) {
    return { ok: false, error: `${quoted(name)} is not inside the files folder, and only that folder is read.` };
  }
  let size: number;
  try {
    const st = statSync(real);
    if (!st.isFile()) return { ok: false, error: `${quoted(name)} in the files folder is not a file.` };
    size = st.size;
  } catch {
    return { ok: false, error: `${quoted(name)} in the files folder could not be read.` };
  }
  if (size > maxBytes) {
    return { ok: false, error: `${quoted(name)} is ${Math.ceil(size / 1024)} KB; the limit here is ${Math.floor(maxBytes / 1024)} KB.`, tooLarge: { bytes: size } };
  }
  try {
    return { ok: true, data: readFileSync(real), name };
  } catch {
    return { ok: false, error: `${quoted(name)} in the files folder could not be read.` };
  }
}
