import type { EventTransform, LlmEvent } from "@sakura/kernel";

/** Where to start holding text back: the end of `text` could be the beginning of a placeholder that is not complete yet. */
function holdBackFrom(text: string): number {
  const last = text.lastIndexOf("{");
  if (last === -1) return text.length;
  const start = last > 0 && text[last - 1] === "{" ? last - 1 : last;
  const tail = text.slice(start);
  return tail.length <= 80 && /^\{(?:\{[A-Za-z0-9_]*\}?)?$/.test(tail) ? start : text.length;
}

function restoreDeep(value: unknown, restore: (text: string) => string): unknown {
  if (typeof value === "string") return restore(value);
  if (Array.isArray(value)) return value.map((item) => restoreDeep(item, restore));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, restoreDeep(inner, restore)]));
  return value;
}

/**
 * Puts the real values back into the model's reply while it streams. A placeholder can arrive split across
 * pieces, so text that might be the start of one is held back until it is complete or clearly is not one.
 */
export function createRestorer(restore: (text: string) => string): EventTransform {
  let pending = "";
  return {
    push(event: LlmEvent): LlmEvent[] {
      if (event.type === "text_delta") {
        pending += event.delta;
        const cut = holdBackFrom(pending);
        const ready = pending.slice(0, cut);
        pending = pending.slice(cut);
        return ready ? [{ type: "text_delta", delta: restore(ready) }] : [];
      }
      if (event.type === "tool_call") return [{ type: "tool_call", call: { ...event.call, args: restoreDeep(event.call.args, restore) } }];
      return [event];
    },
    flush(): LlmEvent[] {
      const rest = pending;
      pending = "";
      return rest ? [{ type: "text_delta", delta: restore(rest) }] : [];
    },
  };
}
