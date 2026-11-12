import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { setting, settingSource } from "../settings.js";

// Fetching a URL the AI was handed, for anything this server uploads to
// Discord: files on a message, emoji, stickers, sounds, avatars, icons.
//
// Whatever is fetched ends up in a Discord channel or server where other
// people can see it. A URL pointing at the machine this server runs on, or
// at something on its private network (a router page, a local dev server,
// a cloud metadata address), would copy that into Discord. A message that
// talks the AI into "posting this link as a file" is all it would take. So
// by default only public internet addresses are fetched, and the check is
// made on the address actually connected to, after DNS, on every redirect.
// DISCORD_MCP_ALLOW_PRIVATE_URLS=true turns the check off for setups that
// really do serve their own files from a private address.

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4 written as IPv6 through the NAT64 prefix could carry any of the
  // addresses above, so that whole range is refused. IPv4-mapped addresses
  // (::ffff:a.b.c.d) need no rule of their own: BlockList checks them
  // against the IPv4 rules. A rule for ::ffff:0:0/96 would in turn match
  // every plain IPv4 address, public ones included.
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

// Whether an address is one this server will not fetch from.
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family === 6) return blocked.check(bare, "ipv6");
  return false;
}

export function privateUrlsAllowed(): boolean {
  return /^(1|true|yes|on)$/i.test(setting("ALLOW_PRIVATE_URLS") ?? "");
}

function privateRefusal(host: string): string {
  return (
    `Refused to fetch from ${host}: it is a private or local network address. ` +
    "Only public internet URLs are fetched, because whatever is fetched gets " +
    "posted to Discord. If this setup serves its own files from a private " +
    `address on purpose, set ${settingSource("ALLOW_PRIVATE_URLS")}=true.`
  );
}

class Refused extends Error {}

// DNS lookup that drops the connection when any answer is private, so a
// name that resolves to a local address is refused at connect time and a
// changing DNS answer cannot slip a different address in after a check.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as Array<{ address: string; family: number }>;
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      return callback(new Refused(privateRefusal(hostname)), "", 0);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    }
    return callback(null, list[0].address, list[0].family);
  });
};

export type FetchResult =
  | { ok: true; contentType: string; data: Buffer; finalUrl: string }
  // tooLarge is set when the size limit stopped it, with the size when the
  // server declared one, so callers can word it their own way.
  | { ok: false; error: string; tooLarge?: { bytes?: number } };

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

// One GET, without following redirects. Resolves with the response or a
// refusal; the body is read by the caller.
function getOnce(url: URL, allowPrivate: boolean, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        headers: { "user-agent": "discord-mcp (+https://github.com/OrygnsCode/discord-mcp)", accept: "*/*" },
        signal,
        ...(allowPrivate ? {} : { lookup: guardedLookup }),
      },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

export interface FetchOptions {
  // Says whether an address may be fetched, asked for the first one and for
  // every redirect. For fetches that expect one party's hosts only, so a
  // redirect cannot lead the request to someone else's server.
  stayOn?: (url: URL) => boolean;
}

// Fetches a public URL into memory, at most maxBytes, following up to five
// redirects and checking each hop. Never throws.
export async function fetchPublicUrl(
  rawUrl: string,
  maxBytes: number,
  options: FetchOptions = {}
): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: `"${rawUrl}" is not a valid URL.` };
  }
  const allowPrivate = privateUrlsAllowed();
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (options.stayOn && !options.stayOn(url)) {
        return {
          ok: false,
          error:
            hop === 0
              ? `${url.host} is not a host this fetch may use.`
              : `Fetching ${rawUrl} was redirected to ${url.host}, which this fetch does not follow.`,
        };
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { ok: false, error: `Only http and https URLs can be fetched, not ${url.protocol.replace(":", "")}.` };
      }
      if (url.username || url.password) {
        return { ok: false, error: "URLs with a user name or password in them are not fetched." };
      }
      // An address written straight into the URL never goes through DNS,
      // so it is checked here.
      if (!allowPrivate && isPrivateAddress(url.hostname)) {
        return { ok: false, error: privateRefusal(url.hostname.replace(/^\[|\]$/g, "")) };
      }
      let res: IncomingMessage;
      try {
        res = await getOnce(url, allowPrivate, aborter.signal);
      } catch (err) {
        if (err instanceof Refused) return { ok: false, error: err.message };
        if (aborter.signal.aborted) {
          return { ok: false, error: `Fetching ${url.host} took longer than ${TIMEOUT_MS / 1000} seconds.` };
        }
        return { ok: false, error: `Could not fetch ${url.href}.` };
      }
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop === MAX_REDIRECTS) {
          return { ok: false, error: `Fetching ${rawUrl} redirected more than ${MAX_REDIRECTS} times.` };
        }
        try {
          url = new URL(res.headers.location, url);
        } catch {
          return { ok: false, error: `Fetching ${rawUrl} redirected to an invalid address.` };
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return { ok: false, error: `Fetch failed with status ${status}.` };
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        return {
          ok: false,
          error: `The file at ${url.host} is ${describeSize(declared)}; the limit here is ${describeSize(maxBytes)}.`,
          tooLarge: { bytes: declared },
        };
      }
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of res) {
          total += (chunk as Buffer).length;
          if (total > maxBytes) {
            res.destroy();
            return {
              ok: false,
              error: `The file at ${url.host} is larger than the limit here, ${describeSize(maxBytes)}.`,
              tooLarge: {},
            };
          }
          chunks.push(chunk as Buffer);
        }
      } catch {
        if (aborter.signal.aborted) {
          return { ok: false, error: `Fetching ${url.host} took longer than ${TIMEOUT_MS / 1000} seconds.` };
        }
        return { ok: false, error: `The download from ${url.host} broke off.` };
      }
      const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      return { ok: true, contentType, data: Buffer.concat(chunks), finalUrl: url.href };
    }
    return { ok: false, error: `Fetching ${rawUrl} redirected too many times.` };
  } finally {
    clearTimeout(timer);
  }
}
