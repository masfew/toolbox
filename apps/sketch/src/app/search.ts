/**
 * How well `query` matches `text`, for the command palette. Higher is better; null is no match.
 * The start of the text beats the start of a word, which beats anywhere, which beats every word
 * somewhere, which beats the letters in order ("svas" finds "Save As").
 */
export function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 100 - t.length / 100;
  const at = t.indexOf(q);
  if (at >= 0) return (/[\s\-(/]/.test(t[at - 1]) ? 80 : 60) - at / 100;
  const words = q.split(/\s+/);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 40;
  let i = 0;
  let gaps = 0;
  for (const ch of q.replace(/\s+/g, '')) {
    const found = t.indexOf(ch, i);
    if (found < 0) return null;
    gaps += found - i;
    i = found + 1;
  }
  return 20 - Math.min(gaps, 100) / 10;
}

export interface Searchable {
  label: string;
  group: string;
  keywords?: string;
}

/** The best score over a command's name, its menu and name together, and its extra words. */
export function commandScore(query: string, c: Searchable): number | null {
  const scores = [matchScore(query, c.label), matchScore(query, `${c.group} ${c.label}`), c.keywords ? scoreTimes(matchScore(query, c.keywords), 0.7) : null];
  const valid = scores.filter((s): s is number => s !== null);
  return valid.length ? Math.max(...valid) : null;
}

function scoreTimes(s: number | null, k: number): number | null {
  return s === null ? null : s * k;
}

/** Commands matching the query, best first; ties keep their list order. */
export function searchCommands<T extends Searchable>(query: string, list: T[]): T[] {
  return list
    .map((c, i) => ({ c, i, s: commandScore(query, c) }))
    .filter((r) => r.s !== null)
    .sort((a, b) => b.s! - a.s! || a.i - b.i)
    .map((r) => r.c);
}
