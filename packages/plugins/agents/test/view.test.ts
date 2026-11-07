import { describe, expect, it } from "vitest";
import type { LogEntry } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { renderChild, summarize } from "../src/view.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const entry = (index: number, body: Record<string, unknown>): LogEntry => ({ id: `e${index}`, parentId: index ? `e${index - 1}` : null, ts: 1000 + index, ...body }) as LogEntry;
const user = (index: number, text: string) => entry(index, { type: "message", message: { role: "user", content: [{ type: "text", text }], ts: 1 } });
const assistant = (index: number, parts: unknown[], usage?: unknown) => entry(index, { type: "message", message: { role: "assistant", content: parts, ts: 1, ...(usage ? { usage } : {}) } });
const toolResult = (index: number, id: string, text: string, isError = false) =>
  entry(index, { type: "message", message: { role: "tool", toolCallId: id, content: [{ type: "text", text }], ts: 1, ...(isError ? { isError: true } : {}) } });

const view = (entries: LogEntry[], options: Partial<Parameters<typeof renderChild>[2]> = {}) =>
  renderChild(summarize("w-1", "worker", "running", entries), entries, { last: 10, thinking: false, ...options });

describe("summarize", () => {
  for (const seed of range(30)) {
    it(`counts turns and tokens (seed ${seed})`, () => {
      const rng = createRng(seed);
      const turns = rng.int(0, 10);
      let tokens = 0;
      const entries: LogEntry[] = [user(0, "task")];
      for (let turn = 0; turn < turns; turn++) {
        const usage = { input: rng.int(1, 100), output: rng.int(1, 50), cacheRead: rng.int(0, 20), cacheWrite: 0 };
        tokens += usage.input + usage.output + usage.cacheRead;
        entries.push(assistant(entries.length, [{ type: "text", text: "x" }], usage));
      }
      const summary = summarize("a", "n", "idle", entries);
      expect(summary).toMatchObject({ id: "a", name: "n", status: "idle", turns, tokens });
      expect(summary.lastActivity).toBe(1000 + entries.length - 1);
    });
  }
  it("counts usage entries too and has no activity for an empty log", () => {
    expect(summarize("a", "n", "idle", [entry(0, { type: "usage", kind: "x", usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } })]).tokens).toBe(10);
    expect(summarize("a", "n", "idle", []).lastActivity).toBeUndefined();
  });
});

describe("renderChild", () => {
  it("starts with a status line", () => {
    expect(view([user(0, "do it")]).split("\n")[0]).toMatch(/^agent w-1 \(worker\): running, 0 turns, 0 tokens, last activity /);
  });

  it("shows readable lines, not log lines", () => {
    const text = view([
      user(0, "find the bug"),
      assistant(1, [
        { type: "text", text: "Looking at the code" },
        { type: "tool_call", id: "t1", name: "read", args: { path: "a.ts" } },
      ]),
      toolResult(2, "t1", "file contents"),
    ]);
    expect(text).toContain("user: find the bug");
    expect(text).toContain("assistant: Looking at the code");
    expect(text).toContain('tool read {"path":"a.ts"}');
    expect(text).toContain("tool result (read): file contents");
    expect(text).not.toContain('"parentId"');
    expect(text).not.toContain('"type":"message"');
  });

  it("marks failing tool results", () => {
    const text = view([assistant(0, [{ type: "tool_call", id: "t", name: "bash", args: {} }]), toolResult(1, "t", "boom", true)]);
    expect(text).toContain("tool result (bash) [error]: boom");
  });

  for (const last of [1, 2, 3, 5, 10, 50]) {
    for (const total of [0, 1, 4, 12, 30]) {
      it(`shows the latest ${last} of ${total} items`, () => {
        const entries = Array.from({ length: total }, (_, index) => user(index, `item ${index}`));
        const lines = view(entries, { last }).split("\n").slice(1);
        const shown = lines.filter((line) => line.startsWith("user: "));
        expect(shown).toHaveLength(Math.min(last, total));
        if (total > 0) expect(shown.at(-1)).toBe(`user: item ${total - 1}`);
        expect(lines.some((line) => line.includes("earlier items not shown"))).toBe(total > last);
      });
    }
  }

  it("hides reasoning unless asked", () => {
    const entries = [
      assistant(0, [
        { type: "provider", vendor: "x", data: { reasoning: "secret thoughts" } },
        { type: "text", text: "answer" },
      ]),
    ];
    expect(view(entries)).not.toContain("secret thoughts");
    expect(view(entries, { thinking: true })).toContain("thinking: secret thoughts");
  });
  it("cuts long reasoning even when shown", () => {
    const entries = [assistant(0, [{ type: "provider", vendor: "x", data: { reasoning: "r".repeat(2000) } }])];
    expect(view(entries, { thinking: true }).length).toBeLessThan(700);
  });

  for (const max of [50, 200, 600]) {
    it(`cuts items longer than ${max} characters and says how much is missing`, () => {
      const text = view([user(0, "y".repeat(max * 3))], { maxChars: max });
      expect(text).toContain(`[cut, ${max * 2} more characters]`);
      expect(text.split("\n")[1]!.length).toBeLessThan(max + 60);
    });
  }

  it("squeezes whitespace so each item is one line", () => {
    expect(view([user(0, "a\n\n  b\tc")]).split("\n")[1]).toBe("user: a b c");
  });
  it("ignores bookkeeping entries", () => {
    const text = view([entry(0, { type: "usage", kind: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }), entry(1, { type: "custom", customType: "c", data: 1 }), user(2, "hi")]);
    expect(text.split("\n")).toHaveLength(2);
  });
  it("shows images as a marker", () => {
    expect(view([entry(0, { type: "message", message: { role: "user", content: [{ type: "image", mediaType: "image/png", ref: "x" }], ts: 1 } })])).toContain("user: [image]");
  });

  for (const seed of range(30, 100)) {
    it(`never shows more than the requested number of items however the log looks (seed ${seed})`, () => {
      const rng = createRng(seed);
      const entries: LogEntry[] = [];
      for (let index = 0; index < rng.int(0, 40); index++) {
        if (rng.chance(0.4)) entries.push(user(entries.length, `u${index}`));
        else if (rng.chance(0.5))
          entries.push(
            assistant(entries.length, [
              { type: "text", text: `a${index}` },
              { type: "tool_call", id: `t${index}`, name: "read", args: { n: index } },
            ]),
          );
        else entries.push(toolResult(entries.length, `t${index - 1}`, `r${index}`));
      }
      const last = rng.int(1, 8);
      const lines = view(entries, { last })
        .split("\n")
        .slice(1)
        .filter((line) => !line.startsWith("("));
      expect(lines.length).toBeLessThanOrEqual(last);
    });
  }
});

describe("renderChild: the corners", () => {
  it("an image in a message is shown as [image]; a tool call without arguments as an empty object", () => {
    const text = view([
      entry(0, {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/png", ref: "r" },
          ],
          ts: 1,
        },
      }),
      assistant(1, [{ type: "tool_call", id: "t", name: "noargs", args: undefined }]),
    ]);
    expect(text).toContain("user: look[image]");
    expect(text).toContain("tool noargs {}");
  });
  it("reasoning is shown only when asked for, and a block without reasoning text shows nothing", () => {
    const entries = [
      assistant(0, [
        { type: "provider", vendor: "x", data: { reasoning: "weighing the options" } },
        { type: "provider", vendor: "x", data: {} },
        { type: "provider", vendor: "x" },
      ]),
    ];
    expect(view(entries)).not.toContain("thinking");
    expect(view(entries, { thinking: true })).toContain("thinking: weighing the options");
    expect(view(entries, { thinking: true }).match(/thinking:/g)).toHaveLength(1);
  });
  it("a tool result whose call is not in this log is still shown, without a name", () => {
    expect(view([toolResult(0, "unknown-call", "late result")])).toContain("tool result: late result");
    expect(view([toolResult(0, "", "no id")])).toContain("tool result: no id");
  });
  it("an assistant message with blank text adds no line", () => {
    expect(view([assistant(0, [{ type: "text", text: "   " }])]).split("\n")).toHaveLength(1);
  });
});
