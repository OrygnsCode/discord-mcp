import type { CallToolResult } from "@modelcontextprotocol/server";
import { oneLine } from "./discord/names.js";

// Every tool returns the same envelope: a short human-readable
// summary, a lean typed payload, and any non-fatal warnings. The model
// reads the summary; the data is there when it needs specifics. This is
// the convention from docs/tool-catalog.md section 1.5.
export interface Envelope {
  summary: string;
  data: unknown;
  warnings: string[];
}

// The summary and the warnings are sentences. They never carry characters
// nobody can see, and each is one line whatever a name inside it holds (see
// oneLine). The data is left exactly as Discord has it: a name there is a
// value, and may be needed back unchanged.
export function ok(
  summary: string,
  data: unknown = {},
  warnings: string[] = []
): CallToolResult {
  const envelope: Envelope = { summary: oneLine(summary), data, warnings: warnings.map(oneLine) };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}

export function fail(summary: string, data: unknown = {}): CallToolResult {
  const envelope: Envelope = { summary: oneLine(summary), data, warnings: [] };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}

// Adds a warning to the envelope a tool returned. Anything that is not an
// envelope, such as a request for a confirmation dialog, passes through as
// it is.
export function withWarning<T>(result: T, warning: string): T {
  const content = (result as CallToolResult | undefined)?.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (!first || first.type !== "text") return result;
  try {
    const envelope = JSON.parse(first.text) as { summary?: unknown; warnings?: unknown };
    if (typeof envelope.summary !== "string" || !Array.isArray(envelope.warnings)) return result;
    envelope.warnings.push(oneLine(warning));
    return {
      ...(result as object),
      content: [{ ...first, text: JSON.stringify(envelope, null, 2) }, ...(content as CallToolResult["content"]).slice(1)],
    } as T;
  } catch {
    return result;
  }
}
