/** Text normalization shared by the interpreter and the matcher. Pure and deterministic. */

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does for from get go has have help i i'm im in into is it its " +
    "just know like looking me my need needs of on or our out over person people please really should so some someone " +
    "somebody that the their them then there these they this those to up us want wants was we what when where which who " +
    "whom why will with would you your find intro introduction introduce connect connected connection meet talk speak chat " +
    "about also any anyone one ones get got who's whose more most very well new next this month week year quarter asap " +
    "based near remote not exclude excluding except avoid quietly confidential discreet without being ideally preferably maybe perhaps"
  ).split(/\s+/),
);

/** Two-letter terms that carry meaning in professional requests. */
const SHORT_TERMS = new Set(["ai", "ml", "ux", "ui", "qa", "hr", "os"]);

/** Lowercase content words in order, repeats kept (for phrase matching). Stopwords and short words removed. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9+#.]*/g) ?? []) {
    const word = raw.replace(/\.+$/, "");
    if ((word.length < 3 && !SHORT_TERMS.has(word)) || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    out.push(word);
  }
  return out;
}

/** Distinct content words, in first-seen order. */
export function tokens(text: string): string[] {
  return [...new Set(words(text))];
}

/**
 * Words too generic to carry a match on their own. They still count, at a low weight, and a
 * candidate matched only on them is labelled weak rather than hidden.
 */
const LOW_SIGNAL = new Set(
  ("system systems software tool tools project projects platform platforms product products solution solutions data tech technology " +
    "technologies team teams business businesses service services management manager work app apps application applications digital " +
    "online thing things stuff general various industry company companies startup startups professional").split(" "),
);

export function isLowSignal(word: string): boolean {
  return LOW_SIGNAL.has(word.toLowerCase());
}

/** Normalizes a user-supplied topic list ("Design Systems; feltkit") into tokens. */
export function normalizeTopics(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) for (const t of tokens(v)) if (!out.includes(t)) out.push(t);
  return out;
}

/** Loose, deterministic stem so "evaluating" meets "evaluate" and "databases" meets "database". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 4) return w;
  w = w.replace(/ies$/, "y").replace(/(ing|ed)$/, "");
  if (w.length > 4) w = w.replace(/s$/, "");
  if (w.length > 4) w = w.replace(/(er|e)$/, "");
  return w;
}

export function overlap(a: readonly string[], b: readonly string[]): string[] {
  const stems = new Map(b.map((w) => [stem(w), w]));
  return a.filter((w) => stems.has(stem(w)));
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
