/** Splits text into lowercase words; `fooBar_baz-qux` gives foo, bar, baz, qux. */
export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

export interface Ranked {
  index: number;
  score: number;
}

/** Ranks documents against a query with BM25 (k1 = 1.2, b = 0.75). Documents with no matching word are left out. Best first; ties keep the original order. */
export function rank(documents: string[], query: string): Ranked[] {
  const k1 = 1.2;
  const b = 0.75;
  const words = documents.map(tokenize);
  const average = words.reduce((sum, list) => sum + list.length, 0) / Math.max(1, words.length);
  const frequency = new Map<string, number>();
  for (const list of words) for (const word of new Set(list)) frequency.set(word, (frequency.get(word) ?? 0) + 1);

  const wanted = [...new Set(tokenize(query))];
  const ranked: Ranked[] = [];
  words.forEach((list, index) => {
    let score = 0;
    for (const word of wanted) {
      const count = list.filter((candidate) => candidate === word).length;
      if (count === 0) continue;
      const documentsWithWord = frequency.get(word) ?? 0;
      const idf = Math.log(1 + (words.length - documentsWithWord + 0.5) / (documentsWithWord + 0.5));
      score += (idf * count * (k1 + 1)) / (count + k1 * (1 - b + (b * list.length) / Math.max(1, average)));
    }
    if (score > 0) ranked.push({ index, score });
  });
  return ranked.sort((left, right) => right.score - left.score || left.index - right.index);
}
