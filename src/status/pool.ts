/**
 * The randomized status phrases.
 *
 * While an agent task is running, the product replaces ZCode's own status line
 * with a Tarkov-flavoured one and re-rolls it as the task progresses. The
 * phrases are this project's own writing in the established style — terse,
 * procedural, present-continuous radio chatter. They are **not** lines from
 * Escape from Tarkov: no dialogue, no character names and no mission text from
 * the game is reproduced anywhere in this file, and the defaults below were
 * written for this project.
 *
 * The pool is data, not code: a user can drop `texts.zh.txt` / `texts.en.txt`
 * into `status/` and every rule here applies to their file too.
 *
 * Parsing rules (deliberately strict, because the file is hand-edited):
 *  - one phrase per line;
 *  - a line whose first non-space character is `#` is a comment;
 *  - lines are trimmed, and control characters are removed;
 *  - blank lines are dropped;
 *  - duplicates are collapsed, keeping the first occurrence;
 *  - the pool is capped, and each phrase is capped in length, so a runaway file
 *    cannot turn into unbounded injected data.
 */

export const MAX_PHRASES = 500;
export const MAX_PHRASE_LENGTH = 120;

/** The bundled English pool, used when no user file exists. */
export const DEFAULT_PHRASES_EN: readonly string[] = [
  "Checking the exfil route…",
  "Repacking the tactical rig…",
  "Confirming the supply manifest…",
  "Scanning the workspace…",
  "Trading intel…",
  "Sweeping the sector…",
  "Recalculating the route…",
  "Holding position…",
  "Relaying coordinates…",
  "Cross-checking the inventory…",
  "Assessing the approach…",
  "Warming up the optics…",
  "Sorting recovered items…",
  "Waiting on the next report…",
  "Verifying the perimeter…",
  "Logging the contact…",
];

/** The bundled Chinese pool. */
export const DEFAULT_PHRASES_ZH: readonly string[] = [
  "正在检查撤离路线……",
  "正在整理战术背包……",
  "正在确认补给清单……",
  "正在扫描工作区……",
  "正在交换情报……",
  "正在搜索区域……",
  "正在重新规划路线……",
  "正在原地待命……",
  "正在传递坐标……",
  "正在核对库存……",
  "正在评估接近路线……",
  "正在调试瞄具……",
  "正在清点回收物资……",
  "正在等待下一份报告……",
  "正在确认周边安全……",
  "正在记录接触情况……",
];

export const DEFAULT_POOLS: Record<"zh" | "en", readonly string[]> = {
  zh: DEFAULT_PHRASES_ZH,
  en: DEFAULT_PHRASES_EN,
};

/**
 * Parses a status text file's contents into a bounded, deduplicated pool.
 *
 * Returns an empty array for input that yields nothing usable, so the caller can
 * tell "the user's file said nothing" from "the user has no file" and fall back
 * to the bundled pool in the first case only when it wants to.
 */
export function parsePhrasePool(text: unknown): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    if (out.length >= MAX_PHRASES) break;
    // Strip a BOM wherever it appears: a file saved by Notepad can carry one on
    // the first line, and it would otherwise attach itself to a phrase.
    const line = rawLine.replace(/\uFEFF/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    const phrase = line.length > MAX_PHRASE_LENGTH ? line.slice(0, MAX_PHRASE_LENGTH) : line;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

/** The bundled pool for a language, as a fresh mutable array. */
export function defaultPool(language: "zh" | "en"): string[] {
  return [...(DEFAULT_POOLS[language] ?? DEFAULT_POOLS.en)];
}

/**
 * Chooses the pool to use for a language.
 *
 * A user file that parses to nothing falls back to the bundled pool rather than
 * leaving the status line with no phrases at all, which would look like the
 * feature was broken rather than unconfigured.
 */
export function resolvePool(language: "zh" | "en", userFileText: string | undefined): { phrases: string[]; source: "user" | "bundled" } {
  if (typeof userFileText === "string") {
    const parsed = parsePhrasePool(userFileText);
    if (parsed.length > 0) return { phrases: parsed, source: "user" };
  }
  return { phrases: defaultPool(language), source: "bundled" };
}

/**
 * A random index that never repeats the previous one.
 *
 * With a single-phrase pool the only sensible answer is that phrase, so this
 * returns 0 rather than looping forever trying to avoid a repeat.
 *
 * `previous` may be `-1`, which is the sentinel the roller starts with to mean
 * "nothing has been shown yet". That case has to be handled explicitly rather
 * than left to fall through the avoidance arithmetic: with `previous = -1` the
 * comparison `bounded >= previous` is always true, so the mapping would skip
 * index 0 on the very first draw and the first phrase in the pool could never
 * appear first. A caller with no history gets a plain uniform draw.
 */
export function nextIndex(previous: number, length: number, random: () => number = Math.random): number {
  if (length <= 1) return 0;
  if (previous < 0 || previous >= length) return Math.floor(random() * length) % length;
  const raw = Math.floor(random() * (length - 1));
  const bounded = raw < 0 ? 0 : raw >= length - 1 ? length - 2 : raw;
  // Map the (length-1)-sized draw onto the pool, skipping the previous index.
  return bounded >= previous ? bounded + 1 : bounded;
}
