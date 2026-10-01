const normalize = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) || [];

/** Bounded edit distance, counting adjacent swapped letters as one typo. */
function withinEdits(query: string, candidate: string, limit: number): boolean {
  const a = [...query],
    b = [...candidate];
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let twoBack: number[] = [];
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        current[j] = Math.min(current[j], twoBack[j - 2] + 1);
    }
    if (Math.min(...current) > limit) return false;
    twoBack = previous;
    previous = current;
  }
  return previous[b.length] <= limit;
}

/** Filter only: callers retain their saved priority or project/recency order. */
export function createSearchMatcher(query: string): (text: string) => boolean {
  const phrase = normalize(query).trim();
  const terms = [...new Set(words(phrase))];
  if (!phrase) return () => true;
  return (text) => {
    const normalized = normalize(text);
    if (normalized.includes(phrase)) return true;
    if (!terms.length) return false;
    const candidates = [...new Set(words(normalized))];
    return terms.every((term) => {
      if (candidates.some((word) => word.includes(term))) return true;
      // Short queries and identifiers with numbers need literal matches. Longer
      // words tolerate one typo, or two once the query reaches eight letters.
      const length = [...term].length;
      if (length < 4 || /\p{N}/u.test(term)) return false;
      const limit = length >= 8 ? 2 : 1;
      return candidates.some((word) => !/\p{N}/u.test(word) && withinEdits(term, word, limit));
    });
  };
}
