import { z } from "zod";
import type { RawFile } from "@discordjs/rest";
import { fetchPublicUrl } from "./fetchUrl.js";

// Files attached to a message, fetched from URLs.
//
// Only URLs, never paths on this machine. An AI that can be talked into
// "attach C:\Users\...\.env" by a message in a channel would post the file
// for everyone in that channel to read, so there is no way to name a local
// file here at all. URLs are fetched through fetchPublicUrl, which refuses
// private and local network addresses for the same reason.

// Discord: "The default limit is 20 MiB for all users", per file; boosted
// servers allow more, but 20 MiB is what this server fetches per file, and
// at most 10 files (Discord's cap per message) and 50 MiB in all are held in
// memory for one message.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_FILES_TOTAL_BYTES = 50 * 1024 * 1024;

export const filesParam = z
  .array(
    z.object({
      url: z.string().url().describe("Public http or https URL of the file. Local paths are not accepted."),
      filename: z.string().min(1).max(100).optional()
        .describe("Name to show, such as chart.png. Default: taken from the URL."),
      description: z.string().max(1024).optional()
        .describe("Alt text describing the file, read by screen readers."),
      spoiler: z.boolean().optional().describe("Blur it until clicked."),
    })
  )
  .min(1)
  .max(MAX_FILES)
  .optional()
  .describe(
    "Up to 10 files to attach, each fetched from a public URL (20 MiB each). " +
      "Needs the Attach Files permission."
  );

export type FileInput = NonNullable<z.infer<typeof filesParam>>[number];

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/html": "html",
};

// A file name Discord will keep as given: letters, digits, dot, dash and
// underscore, an extension that fits the content when there is none, and
// no leading dot. Pure.
export function fileNameFor(given: string | undefined, url: string, contentType: string): string {
  let base = given;
  if (!base) {
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
      base = decodeURIComponent(last);
    } catch {
      base = "";
    }
  }
  let name = (base ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 100);
  const ext = EXT_BY_TYPE[contentType];
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    name = `${name || "file"}.${ext ?? "bin"}`;
  }
  return name.slice(-100);
}

// Names must be unique within a message, or attachment:// references and
// Discord's own matching get ambiguous. Pure.
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    if (!used.has(n.toLowerCase())) {
      used.add(n.toLowerCase());
      return n;
    }
    const dot = n.lastIndexOf(".");
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : "";
    for (let i = 2; ; i++) {
      const next = `${stem}-${i}${ext}`;
      if (!used.has(next.toLowerCase())) {
        used.add(next.toLowerCase());
        return next;
      }
    }
  });
}

export interface PreparedFiles {
  files: RawFile[];
  // The message body's attachments array, matching files by index.
  attachments: Array<{ id: number; filename: string; description?: string }>;
  summary: Array<{ filename: string; bytes: number; content_type: string; spoiler: boolean }>;
}

// Fetches every file. The first failure stops it, naming the file, so
// nothing is sent with a file missing.
export async function prepareFiles(inputs: FileInput[]): Promise<{ ok: true; value: PreparedFiles } | { ok: false; error: string }> {
  const fetched: Array<{ input: FileInput; data: Buffer; contentType: string; name: string }> = [];
  let total = 0;
  for (const [i, input] of inputs.entries()) {
    const res = await fetchPublicUrl(input.url, MAX_FILE_BYTES);
    if (!res.ok) return { ok: false, error: `File ${i + 1} (${input.url}): ${res.error}` };
    if (res.data.length === 0) return { ok: false, error: `File ${i + 1} (${input.url}) is empty.` };
    total += res.data.length;
    if (total > MAX_FILES_TOTAL_BYTES) {
      return { ok: false, error: `The files come to more than ${MAX_FILES_TOTAL_BYTES / (1024 * 1024)} MiB together; send them in more than one message.` };
    }
    fetched.push({ input, data: res.data, contentType: res.contentType, name: fileNameFor(input.filename, res.finalUrl, res.contentType) });
  }
  const names = uniqueNames(fetched.map((f) => (f.input.spoiler ? `SPOILER_${f.name}` : f.name)));
  return {
    ok: true,
    value: {
      files: fetched.map((f, i) => ({ name: names[i], data: f.data, ...(f.contentType ? { contentType: f.contentType } : {}) })),
      attachments: fetched.map((f, i) => ({
        id: i,
        filename: names[i],
        ...(f.input.description ? { description: f.input.description } : {}),
      })),
      summary: fetched.map((f, i) => ({
        filename: names[i],
        bytes: f.data.length,
        content_type: f.contentType || "unknown",
        spoiler: f.input.spoiler ?? false,
      })),
    },
  };
}

// Components V2 messages show a file only where a component points at it
// with attachment://name. Names given in files that nothing points at.
// Pure.
export function unreferencedFiles(components: unknown, names: string[]): string[] {
  const text = JSON.stringify(components ?? []);
  return names.filter((n) => !text.includes(`"attachment://${n}"`));
}
