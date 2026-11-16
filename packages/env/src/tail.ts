// The output a command leaves: its last part, bounded. One rule for every place that collects output (a shell, a program, a background command).

/** At most this many characters of a command's output are kept: the last ones. */
export const MAX_OUTPUT_CHARS = 20_000_000;
/** How far past the limit a text may grow before it is cut back: cutting at every chunk would copy the whole text each time. */
const SLACK = 1_000_000;

/** Adds `more` to `text`, keeping memory bounded while a command prints without end (`yes`, a huge `cat`). */
export function appendTail(text: string, more: string, max = MAX_OUTPUT_CHARS): string {
  const joined = text + more;
  return joined.length > max + Math.min(SLACK, max) ? joined.slice(joined.length - max) : joined;
}

/** The last `max` characters of a text. */
export const lastChars = (text: string, max = MAX_OUTPUT_CHARS): string => (text.length > max ? text.slice(text.length - max) : text);
