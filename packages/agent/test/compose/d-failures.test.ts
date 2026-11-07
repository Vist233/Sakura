import { describe, expect, it } from "vitest";
import type { Event, Plugin } from "@sakura/kernel";
import { bundle, compose } from "../../src/compose.ts";
import { drain, withAgent } from "./helpers.ts";

const ok = (name: string, hits: string[], hook: "context" | "turn.end" = "context"): Plugin => ({ name, setup: (api) => api.on(hook as "context", () => void hits.push(name)) });

describe("D. when a child misbehaves", () => {
  it("D1 a throwing hook in one child does not stop its siblings", async () => {
    const hits: string[] = [];
    const bad: Plugin = {
      name: "bad",
      setup: (api) =>
        api.on("context", () => {
          throw new Error("boom");
        }),
    };
    await withAgent([bundle("suite", [ok("a", hits), bad, ok("c", hits)])], [{ text: "ok" }], async (agent) => {
      expect((await drain(agent.run("hi"))).reason).toBe("done");
    });
    expect(hits).toEqual(["a", "c"]);
  });

  const failureEvents = async (plugins: Plugin[]) => {
    const events: Event[] = [];
    await withAgent(plugins, [{ text: "ok" }], async (agent) => {
      const handle = agent.run("hi");
      for await (const event of handle.events) events.push(event);
      await handle.result;
    });
    return events.filter((event) => event.type === "plugin").map((event) => (event as { name: string }).name);
  };
  const badChild: Plugin = {
    name: "bad-child",
    setup: (api) =>
      api.on("context", () => {
        throw new Error("boom");
      }),
  };

  it("D2 given to createAgent, a bundle is opened, so the failure is reported under the child's own name", async () => {
    expect(await failureEvents([bundle("the-bundle", [badChild])])).toEqual(["bad-child"]);
  });

  it("D2b opened up by compose() the failure is reported under the child's own name", async () => {
    expect(await failureEvents(compose([bundle("the-bundle", [badChild])]))).toEqual(["bad-child"]);
  });

  it("D3 setup that throws inside a child fails agent creation (not guarded by the kernel)", async () => {
    const broken: Plugin = {
      name: "broken",
      setup() {
        throw new Error("bad setup");
      },
    };
    await expect(withAgent([bundle("suite", [broken])], [{ text: "ok" }], async () => 1)).rejects.toThrow("bad setup");
  });

  it("D4 a tool.before that throws in a child denies the call (fail closed), through a bundle too", async () => {
    const guard: Plugin = {
      name: "guard",
      setup: (api) =>
        api.on("tool.before", () => {
          throw new Error("checker down");
        }),
    };
    const tool: Plugin = {
      name: "t",
      setup: (api) =>
        api.registerTool({ name: "act", description: "x", parameters: { type: "object", properties: {} }, effect: "write", execute: async () => ({ content: [{ type: "text", text: "RAN" }] }) }),
    };
    await withAgent([bundle("suite", [tool, guard])], [{ toolCalls: [{ name: "act", args: {} }] }, { text: "done" }], async (agent, client) => {
      await drain(agent.run("go"));
      const last = JSON.stringify(client.requests[1]!.messages);
      expect(last).not.toContain("RAN");
      expect(last).toContain("not allowed");
    });
  });

  it("D5 a throwing prepare in a child ends the run: prepare is not guarded by the kernel", async () => {
    const hits: string[] = [];
    const bad: Plugin = {
      name: "bad",
      setup() {},
      prepare: async () => {
        throw new Error("prepare failed");
      },
    };
    await withAgent([bundle("suite", [bad, ok("after", hits)])], [{ text: "ok" }], async (agent) => {
      expect(await drain(agent.run("hi"))).toMatchObject({ reason: "error", error: "prepare failed" });
    });
  });

  it("D6 a FatalHookError from a child still stops the request when wrapped in a bundle", async () => {
    const { FatalHookError } = await import("@sakura/kernel");
    const fatal: Plugin = {
      name: "fatal",
      setup: (api) =>
        api.on("request", () => {
          throw new FatalHookError("must not send");
        }),
    };
    await withAgent([bundle("suite", [fatal])], [{ text: "never" }], async (agent, client) => {
      const result = await drain(agent.run("hi"));
      expect(result.reason).toBe("error");
      expect(client.requests.length).toBe(0);
    });
  });
});
