// Name resolution. Discord entities are addressed by snowflake IDs, but
// nobody talks that way. Every tool parameter that names an entity runs
// through this resolver so "the support channel" works as well as an ID.
// Resolution order, strongest first: exact ID, exact name, normalized
// name (case, spaces, hyphens, underscores, and channel/user sigils all
// ignored), prefix, substring. When the winner is not clear the caller
// gets candidates back instead of a guess.

const SNOWFLAKE = /^\d{17,20}$/;

export interface Resolvable {
  id: string;
  name: string;
  type: string;
  // Extra display context for disambiguation, like a channel's category
  // or a member's nickname.
  context?: string;
  // Other names the item answers to, scored like the name itself. A member
  // has three (username, display name, server nickname), and people are
  // asked for by the one that shows, which is rarely the username.
  aliases?: string[];
}

export interface Candidate extends Resolvable {
  score: number;
}

export function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s\-_#@]/g, "");
}

export function rankCandidates(
  query: string,
  items: Resolvable[]
): Candidate[] {
  const trimmed = query.trim();
  const norm = normalize(trimmed);
  const out: Candidate[] = [];

  const scoreName = (name: string): number => {
    if (name === trimmed) return 90;
    const itemNorm = normalize(name);
    if (itemNorm === norm) return 80;
    if (norm.length > 0 && itemNorm.startsWith(norm)) return 70;
    if (norm.length > 1 && itemNorm.includes(norm)) return 60;
    return 0;
  };
  for (const item of items) {
    let score = 0;
    if (SNOWFLAKE.test(trimmed) && item.id === trimmed) {
      score = 100;
    } else {
      // The best of its names.
      for (const name of [item.name, ...(item.aliases ?? [])]) {
        if (name) score = Math.max(score, scoreName(name));
      }
    }
    if (score > 0) out.push({ ...item, score });
  }

  // Higher score first; among equals, shorter names first since the query
  // matched a larger fraction of them.
  out.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return out;
}

export type Resolution =
  | { match: Candidate }
  | { candidates: Candidate[] };

// Picking a person. Stricter than resolveOne, because the wrong channel
// shows in a preview while the wrong person reads like the right one: when
// two people both carry the name exactly (in any letter case, as username,
// display name, or nickname), nobody is picked. "truncated" says the list
// may not hold everyone who matches; then only an exact name is trusted,
// since a better match may be among the ones not returned.
export function resolvePerson(
  query: string,
  items: Resolvable[],
  truncated = false
): Resolution {
  const ranked = rankCandidates(query, items);
  if (ranked.length === 0) return { candidates: [] };
  const exact = ranked.filter((c) => c.score >= 80);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { candidates: exact.slice(0, 5) };
  if (!truncated && (ranked.length === 1 || ranked[0].score > ranked[1].score)) {
    return { match: ranked[0] };
  }
  return { candidates: ranked.slice(0, 5) };
}

export function resolveOne(query: string, items: Resolvable[]): Resolution {
  const ranked = rankCandidates(query, items);
  if (ranked.length === 0) return { candidates: [] };
  if (ranked.length === 1) return { match: ranked[0] };
  // A unique top score wins. A tie means the caller has to pick.
  if (ranked[0].score > ranked[1].score) return { match: ranked[0] };
  return { candidates: ranked.slice(0, 5) };
}
