import { z } from "zod";
import { quoted } from "./discord/names.js";
import { fail, withWarning } from "./envelope.js";
import { setting } from "./settings.js";

// A tool's input schema strips what it does not declare, so a parameter a
// tool does not have used to vanish without a word, and the call ran as if
// it had never been passed. The worst case is dry_run: some tools take it,
// and on the rest a call marked as a rehearsal ran for real. The same goes
// one level down: a channel in a blueprint written with private: true, a
// key a channel does not have, was built for everyone to see.
//
// The check sits between the SDK and every tool (see buildServer). A tool
// that changes something refuses the call. A tool that only reads answers,
// and says what it ignored.

// Keys some hosts add to every tool call on their own. n8n's AI Agent sends
// these four with each call; they say nothing about what the tool should
// do, so they are dropped as before.
const HOST_KEYS: ReadonlySet<string> = new Set(["sessionId", "action", "chatInput", "toolCallId"]);

// Tools marked read-only that refuse all the same, because what they hand
// back is run by another tool. plan_server_build changes nothing in
// Discord, but the plan it stages is what execute_build_plan builds: a
// plan staged without a key the caller wrote, with only a warning beside
// it, is a server built differently from what was asked.
const STAGES_FOR_ANOTHER: ReadonlySet<string> = new Set(["plan_server_build"]);

// On unless DISCORD_MCP_STRICT_PARAMS says otherwise: the way out for a
// host that adds keys of its own that are not on the list above.
export function strictParams(env: Record<string, string | undefined> = process.env): boolean {
  const value = setting("STRICT_PARAMS", env)?.toLowerCase();
  return !(value === "false" || value === "0" || value === "off" || value === "no");
}

// Where validation leaves the list of what it stripped further down (see
// droppedInside), on the object it hands back. A symbol, so no tool and no
// result ever sees it.
const DROPPED = Symbol("dropped inside");

// The most stripped keys worth finding in one call.
const MAX_DROPPED = 20;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

// The keys a call passed inside its parameters that validation stripped: a
// channel in a blueprint written with a key a channel does not have, a file
// entry with one a file does not. Each comes back as the path to it, like
// blueprint.channels[2].private. The top level is not this function's
// business: the loose schema keeps those keys, so they are found by name.
// A key set to null counts like any other: null is how this API clears a
// setting, so private_to misspelled and set to null is an instruction that
// went missing. Where what came back is not the same kind of thing that
// went in, nothing is compared.
export function droppedInside(raw: unknown, parsed: unknown, path = "", found: string[] = []): string[] {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || parsed.length !== raw.length) return found;
    raw.forEach((item, i) => droppedInside(item, parsed[i], `${path}[${i}]`, found));
    return found;
  }
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return found;
  for (const [key, value] of Object.entries(raw)) {
    const at = path === "" ? key : `${path}.${key}`;
    if (Object.hasOwn(parsed, key)) droppedInside(value, parsed[key], at, found);
    else if (value !== undefined && found.length < MAX_DROPPED) found.push(at);
  }
  return found;
}

// A schema for the SDK that validates as the tool's own does but keeps the
// keys the tool does not declare, so they can be answered, and notes what
// was stripped inside them. What tools/list publishes is the tool's own
// schema, unchanged.
export function keepingUnknown(shape: z.ZodRawShape) {
  const declared = z.object(shape);
  const accepting = z.looseObject(shape);
  return {
    "~standard": {
      ...declared["~standard"],
      validate: async (value: unknown) => {
        const outcome = await accepting["~standard"].validate(value);
        if (outcome.issues) return outcome;
        const dropped = droppedInside(value, outcome.value);
        if (dropped.length > 0) Object.defineProperty(outcome.value, DROPPED, { value: dropped });
        return outcome;
      },
    },
  };
}

// What keepingUnknown noted on a validated call, if anything.
export function droppedFrom(parsed: unknown): string[] {
  const noted = (parsed as { [DROPPED]?: string[] } | null | undefined)?.[DROPPED];
  return Array.isArray(noted) ? noted : [];
}

export interface Screened {
  // The arguments the tool declares, and nothing else.
  args: Record<string, unknown>;
  // Set when the call must not run.
  refusal?: string;
  // Set when the call runs and has to say what it ignored.
  warning?: string;
}

// How many unknown names a sentence lists before it counts the rest.
const LISTED = 5;

function named(keys: string[], length = 40): string {
  const shown = keys.slice(0, LISTED).map((key) => quoted(key, length));
  const more = keys.length - shown.length;
  if (more > 0) return `${shown.join(", ")}, and ${more} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(", ")} or ${shown[shown.length - 1]}`;
}

// The parameters the paths start in, for pointing at the schema.
function roots(paths: string[]): string {
  const names = [...new Set(paths.map((path) => path.split(/[.[]/)[0]))];
  return names.length === 1 ? `${names[0]} takes` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} take`;
}

// Splits what a call passed into what the tool declares and what it does
// not, and decides what the second kind means. An undeclared key counts
// whatever its value, null included, since null is how this API clears a
// setting. The one exception is dry_run set to false or null on a tool
// with no dry run: running for real is what that tool does. inside is what
// validation stripped further down (see droppedInside); it is answered the
// same way, by its path.
export function screenArguments(
  tool: string,
  declared: readonly string[],
  readOnly: boolean,
  parsed: Record<string, unknown>,
  strict: boolean = strictParams(),
  inside: readonly string[] = []
): Screened {
  const known = new Set(declared);
  const args: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (known.has(key)) args[key] = value;
    else if (HOST_KEYS.has(key) || value === undefined) continue;
    else if (key === "dry_run" && (value === false || value === "false" || value === null)) continue;
    else unknown.push(key);
  }
  const nested = [...inside];
  if (!strict || (unknown.length === 0 && nested.length === 0)) return { args };

  const takes = declared.length > 0 ? `Its parameters are: ${declared.join(", ")}.` : "It takes no parameters.";
  const passed = nested.length > 0 ? `was passed ${named(nested, 80)}, which it does not read` : "";
  const schema = nested.length > 0 ? `Its schema lists what ${roots(nested)}.` : "";
  const count = unknown.length + nested.length;
  if (readOnly) {
    const ignored = `so ${count > 1 ? "they were" : "it was"} ignored`;
    if (unknown.length === 0) return { args, warning: `${tool} ${passed}, ${ignored}. ${schema}` };
    return {
      args,
      warning:
        `${tool} has no parameter named ${named(unknown)}` +
        (nested.length > 0 ? `, and ${passed}` : "") +
        `, ${ignored}. ${takes}`,
    };
  }
  const also = nested.length > 0 ? ` It ${passed.replace("was passed", "was also passed")}.` : "";
  if (unknown.includes("dry_run")) {
    const others = unknown.filter((key) => key !== "dry_run");
    return {
      args,
      refusal:
        `${tool} has no dry run, so this call would have run for real. Nothing was done. ` +
        "Call it again without dry_run to run it." +
        (others.length > 0 ? ` It also has no parameter named ${named(others)}. ${takes}` : "") +
        also,
    };
  }
  if (unknown.length === 0) return { args, refusal: `${tool} ${passed}. Nothing was done. ${schema}` };
  return { args, refusal: `${tool} has no parameter named ${named(unknown)}. Nothing was done. ${takes}${also}` };
}

type ToolCallback = (...a: unknown[]) => unknown;

interface ToolDefinition {
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

// A tool's inputSchema as every module passes it: a plain object of zod
// fields, not a schema of its own.
function rawShape(value: unknown): z.ZodRawShape | undefined {
  if (typeof value !== "object" || value === null || "~standard" in value) return undefined;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null ? (value as z.ZodRawShape) : undefined;
}

// What to register in place of a tool's own definition and callback so
// that a parameter it does not have is answered. The SDK is handed a
// schema that keeps undeclared keys, so they reach the wrapper; the tool
// still sees only what it declares.
//
// A tool with no parameters declares no schema at all, and the SDK then
// calls it with the context alone and never looks at the arguments. It is
// given an empty schema here, so what it is passed can be answered too.
export function answeringUnknown(
  name: string,
  def: ToolDefinition | undefined,
  run: ToolCallback
): { def: unknown; run: ToolCallback } {
  const takesArguments = def?.inputSchema !== undefined;
  const shape = takesArguments ? rawShape(def?.inputSchema) : {};
  if (!def || !shape) return { def, run };
  const declared = Object.keys(shape);
  const readOnly = def.annotations?.readOnlyHint === true && !STAGES_FOR_ANOTHER.has(name);
  return {
    def: { ...def, inputSchema: keepingUnknown(shape) },
    run: async (parsed: unknown, ...more: unknown[]) => {
      const screened = screenArguments(
        name,
        declared,
        readOnly,
        (parsed ?? {}) as Record<string, unknown>,
        strictParams(),
        droppedFrom(parsed)
      );
      if (screened.refusal) return fail(screened.refusal);
      const result = await (takesArguments ? run(screened.args, ...more) : run(...more));
      return screened.warning ? withWarning(result, screened.warning) : result;
    },
  };
}
