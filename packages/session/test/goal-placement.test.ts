import { describe, expect, it } from "vitest";
import { COMPACTION_PREFIX } from "@sakura/kernel";
import type { Log } from "@sakura/kernel";
import { createMemoryLog } from "../src/index.ts";
import { projectMessages } from "../src/projection.ts";
import { text, textOf } from "./helpers.ts";

const say = (role: "user" | "assistant", value: string) => ({ type: "message" as const, message: { role, content: text(value), ts: 1 } });
const goalStatement = (value: string) => ({ type: "custom_message" as const, customType: "goal", pinned: true, content: text(value) });

/** Project instructions, then `turns` question/answer pairs. */
async function longConversation(turns: number): Promise<Log> {
  const log = createMemoryLog();
  await log.append({ type: "custom_message", customType: "agents_md", pinned: true, content: text("RULES") });
  for (let turn = 1; turn <= turns; turn++) {
    await log.append(say("user", `q${turn}`));
    await log.append(say("assistant", `a${turn}`));
  }
  return log;
}
const shown = async (log: Log) => (await log.project()).map(textOf);

describe("the goal statement is appended where it is set", () => {
  it("setting a goal leaves everything before it byte for byte as it was", async () => {
    const log = await longConversation(30);
    const before = JSON.stringify(await log.project());
    await log.append({ type: "goal", goal: { objective: "ship", status: "active", humanStreak: 0 } });
    await log.append(goalStatement("GOAL: ship"));
    const after = await log.project();
    expect(JSON.stringify(after.slice(0, -1))).toBe(before);
    expect(textOf(after.at(-1)!)).toBe("GOAL: ship");
  });
  it("project instructions stay first, with or without a goal", async () => {
    const log = await longConversation(5);
    await log.append(goalStatement("GOAL"));
    const messages = await shown(log);
    expect(messages[0]).toBe("RULES");
    expect(messages.filter((m) => m === "GOAL")).toHaveLength(1);
    expect(messages.indexOf("GOAL")).toBe(messages.length - 1);
  });
  it("messages after the goal come after it, in order", async () => {
    const log = await longConversation(2);
    await log.append(goalStatement("GOAL"));
    await log.append(say("user", "next"));
    expect(await shown(log)).toEqual(["RULES", "q1", "a1", "q2", "a2", "GOAL", "next"]);
  });
});

describe("the goal after a compaction", () => {
  async function compacted(log: Log, keepFrom: string): Promise<void> {
    const entry = (await log.branch()).find((candidate) => candidate.type === "message" && candidate.message.content.some((part) => part.type === "text" && part.text === keepFrom))!;
    await log.append({ type: "compaction", summary: "SUMMARY", firstKeptEntryId: entry.id, tokensBefore: 1 });
  }
  it("appears once, right after the summary, when the compaction took it out of the history", async () => {
    const log = await longConversation(6);
    await log.append(goalStatement("GOAL"));
    await log.append(say("user", "q7"));
    await log.append(say("assistant", "a7"));
    await compacted(log, "q7");
    const messages = await shown(log);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toBe("RULES");
    expect(messages[1]).toContain(COMPACTION_PREFIX);
    expect(messages.slice(2)).toEqual(["GOAL", "q7", "a7"]);
  });
  it("appears once, in its place, when the compaction kept it", async () => {
    const log = await longConversation(3);
    await log.append(goalStatement("GOAL"));
    await log.append(say("user", "q4"));
    await log.append(say("assistant", "a4"));
    const keep = (await log.branch()).find((entry) => entry.type === "custom_message" && entry.customType === "goal")!;
    await log.append({ type: "compaction", summary: "SUMMARY", firstKeptEntryId: keep.id, tokensBefore: 1 });
    const messages = await shown(log);
    expect(messages.filter((m) => m === "GOAL")).toHaveLength(1);
    expect(messages.slice(2)).toEqual(["GOAL", "q4", "a4"]);
  });
  it("is not invented when there was no goal", async () => {
    const log = await longConversation(4);
    await compacted(log, "q4");
    expect((await shown(log)).some((m) => m.includes("GOAL"))).toBe(false);
  });
  it("a second compaction still carries the goal, and the part before the first summary stays out", async () => {
    const log = await longConversation(4);
    await log.append(goalStatement("GOAL"));
    for (const turn of [5, 6, 7, 8]) {
      await log.append(say("user", `q${turn}`));
      await log.append(say("assistant", `a${turn}`));
    }
    await compacted(log, "q5");
    await log.append(say("user", "q9"));
    await compacted(log, "q8");
    const messages = await shown(log);
    expect(messages.filter((m) => m === "GOAL")).toHaveLength(1);
    expect(messages.indexOf("GOAL")).toBe(2);
    expect(messages.slice(3)).toEqual(["q8", "a8", "q9"]);
  });
  it("the part after the goal is the same before and after a later append (nothing in front moves)", async () => {
    const log = await longConversation(6);
    await log.append(goalStatement("GOAL"));
    await log.append(say("user", "q7"));
    await compacted(log, "q7");
    const before = await log.project();
    await log.append(say("assistant", "a7"));
    expect(JSON.stringify((await log.project()).slice(0, -1))).toBe(JSON.stringify(before));
  });
});

describe("withdrawing, replacing and resuming a goal", () => {
  const withdraw = async (log: Log) => {
    for (const entry of await log.branch()) if (entry.type === "custom_message" && entry.customType === "goal") await log.append({ type: "context_edit", targetId: entry.id, replacement: null });
  };
  it("a withdrawn goal is gone, also after a compaction", async () => {
    const log = await longConversation(4);
    await log.append(goalStatement("GOAL"));
    await withdraw(log);
    await log.append(say("user", "q5"));
    expect(await shown(log)).not.toContain("GOAL");
    const keep = (await log.branch()).find((entry) => entry.type === "message" && entry.message.content.some((part) => part.type === "text" && part.text === "q5"))!;
    await log.append({ type: "compaction", summary: "SUMMARY", firstKeptEntryId: keep.id, tokensBefore: 1 });
    expect(await shown(log)).not.toContain("GOAL");
  });
  it("a replaced goal shows only the new statement, at its end position, also after a compaction", async () => {
    const log = await longConversation(4);
    await log.append(goalStatement("OLD"));
    await log.append(say("user", "q5"));
    await withdraw(log);
    await log.append(goalStatement("NEW"));
    expect(await shown(log)).toEqual(["RULES", "q1", "a1", "q2", "a2", "q3", "a3", "q4", "a4", "q5", "NEW"]);
    const keep = (await log.branch()).find((entry) => entry.type === "message" && entry.message.content.some((part) => part.type === "text" && part.text === "q5"))!;
    await log.append({ type: "compaction", summary: "SUMMARY", firstKeptEntryId: keep.id, tokensBefore: 1 });
    const messages = await shown(log);
    expect(messages.filter((m) => m === "NEW")).toHaveLength(1);
    expect(messages).not.toContain("OLD");
  });
  it("projecting the same entries again (a resumed log) gives the same messages", async () => {
    const log = await longConversation(5);
    await log.append(goalStatement("GOAL"));
    await log.append(say("user", "q6"));
    const keep = (await log.branch()).find((entry) => entry.type === "message" && entry.message.content.some((part) => part.type === "text" && part.text === "q6"))!;
    await log.append({ type: "compaction", summary: "SUMMARY", firstKeptEntryId: keep.id, tokensBefore: 1 });
    const entries = await log.branch();
    expect(projectMessages(entries).map(textOf)).toEqual(await shown(log));
  });
});
