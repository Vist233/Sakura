import { describe, expect, it } from "vitest";
import { finish, setup } from "./helpers.ts";

describe("kernel.context: how full the conversation is", () => {
  it("is empty before anything was said", async () => {
    const built = setup({ script: [], contextWindow: 100_000 });
    expect(await built.kernel.context(built.log)).toEqual({ tokens: 0, window: 100_000, free: 100_000, compactAt: 100_000 - 17_000 });
  });

  it("counts what the model reported for the last reply", async () => {
    const built = setup({ script: [{ text: "ok", usage: { input: 4_000, output: 500 } }], contextWindow: 100_000 });
    await finish(built.kernel.run(built.log, "hello"));
    const context = await built.kernel.context(built.log);
    expect(context.tokens).toBe(4_500);
    expect(context.free).toBe(95_500);
  });

  it("puts the compaction line where the kernel compacts: the larger of the fixed reserve and the share", async () => {
    const small = setup({ script: [], contextWindow: 20_000 });
    expect((await small.kernel.context(small.log)).compactAt).toBe(20_000 - 16_384);
    const large = setup({ script: [], contextWindow: 200_000 });
    expect((await large.kernel.context(large.log)).compactAt).toBe(200_000 - 34_000);
  });

  it("honours a reserve given by the caller, and says there is no line when compaction is off", async () => {
    const given = setup({ script: [], contextWindow: 100_000, compaction: { reserveTokens: 5_000 } });
    expect((await given.kernel.context(given.log)).compactAt).toBe(95_000);
    const off = setup({ script: [], contextWindow: 100_000, compaction: false });
    expect((await off.kernel.context(off.log)).compactAt).toBeUndefined();
  });

  it("never reports negative free space when the conversation is over the window", async () => {
    const built = setup({ script: [{ text: "ok", usage: { input: 150_000, output: 10 } }], contextWindow: 100_000, compaction: false });
    await finish(built.kernel.run(built.log, "hello"));
    expect((await built.kernel.context(built.log)).free).toBe(0);
  });
});

describe("kernel.usage: what the session has spent", () => {
  it("is zero before anything was said", async () => {
    const built = setup({ script: [] });
    expect(await built.kernel.usage(built.log)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
  });

  it("adds up every reply, and is the same number the turn.end hook sees", async () => {
    const built = setup({
      script: [
        { text: "a", usage: { input: 10, output: 2 } },
        { text: "b", usage: { input: 20, output: 3 } },
      ],
    });
    await finish(built.kernel.run(built.log, "one"));
    await finish(built.kernel.run(built.log, "two"));
    expect(await built.kernel.usage(built.log)).toMatchObject({ input: 30, output: 5, turns: 2 });
  });
});
