import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmEvent, LlmRequest } from "@sakura/kernel";
import { createChatClient } from "../src/index.ts";
import { chunk, collect, sse } from "./helpers.ts";

const request: LlmRequest = { system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], ts: 1 }], tools: [] };
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections?.(), server.close();
});

type Behaviour = "good" | "drop-after-text" | "drop-mid-tool" | "stall" | "stall-after-text" | "no-headers";

/** A real local HTTP server whose answer depends on which attempt this is. */
async function serve(behaviours: Behaviour[]): Promise<{ url: string; attempts: () => number }> {
  let attempts = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const behaviour = behaviours[Math.min(attempts++, behaviours.length - 1)];
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (behaviour === "good") {
        res.write(sse(chunk({ content: "whole " }), chunk({ content: "reply" }), chunk({}, "stop"), "[DONE]"));
        res.end();
      } else if (behaviour === "drop-after-text") {
        res.write(sse(chunk({ content: "par" })));
        setTimeout(() => res.socket?.destroy(), 20);
      } else if (behaviour === "drop-mid-tool") {
        res.write(sse(chunk({ tool_calls: [{ index: 0, id: "t", function: { name: "bash", arguments: '{"command":' } }] })));
        setTimeout(() => res.socket?.destroy(), 20);
      } else if (behaviour === "stall-after-text") {
        res.write(sse(chunk({ content: "par" })));
      } else if (behaviour === "stall") {
        res.flushHeaders(); // headers arrive, then silence
      } else if (behaviour === "no-headers") {
        // nothing is written at all
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, attempts: () => attempts };
}

const client = (url: string, extra: Record<string, unknown> = {}) =>
  createChatClient({ baseUrl: url, apiKey: "k", model: "m", contextWindow: 1000, idleTimeoutMs: 150, headerTimeoutMs: 150, retry: { sleep: async () => undefined, random: () => 0 }, ...extra });
const textOf = (events: LlmEvent[]) => {
  let text = "";
  for (const event of events) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "restart") text = "";
  }
  return text;
};

describe("a connection that drops in the middle of a reply (real sockets)", () => {
  for (const drops of [1, 2, 3]) {
    it(`is sent again ${drops} time(s) and the caller ends up with the whole reply`, async () => {
      const server = await serve([...Array.from({ length: drops }, () => "drop-after-text" as const), "good"]);
      const events = await collect(client(server.url).stream(request, new AbortController().signal));
      expect(events.filter((event) => event.type === "restart")).toHaveLength(drops);
      expect(textOf(events)).toBe("whole reply");
      expect(events.at(-1)).toEqual({ type: "done", stop: "stop" });
      expect(server.attempts()).toBe(drops + 1);
    });
  }

  it("gives up after the maximum number of retries and reports the error", async () => {
    const server = await serve(["drop-after-text"]);
    await expect(collect(client(server.url, { retry: { maxRetries: 2, sleep: async () => undefined, random: () => 0 } }).stream(request, new AbortController().signal))).rejects.toMatchObject({
      kind: "network",
    });
    expect(server.attempts()).toBe(3);
  });

  it("a tool call that was still being written when the connection dropped is never run half-finished: the request is sent again", async () => {
    const server = await serve(["drop-mid-tool", "good"]);
    const events = await collect(client(server.url).stream(request, new AbortController().signal));
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(textOf(events)).toBe("whole reply");
    expect(server.attempts()).toBe(2);
  });

  it("waits between attempts", async () => {
    const sleeps: number[] = [];
    const server = await serve(["drop-after-text", "drop-after-text", "good"]);
    await collect(client(server.url, { retry: { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0 } }).stream(request, new AbortController().signal));
    expect(sleeps).toEqual([500, 1000]);
  });
});

describe("a stalled stream (real sockets)", () => {
  it("is cut and tried again once", async () => {
    const server = await serve(["stall", "good"]);
    const started = Date.now();
    const events = await collect(client(server.url).stream(request, new AbortController().signal));
    expect(textOf(events)).toBe("whole reply");
    expect(server.attempts()).toBe(2);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a second stall is an error", async () => {
    const server = await serve(["stall"]);
    await expect(collect(client(server.url).stream(request, new AbortController().signal))).rejects.toMatchObject({ name: "StalledStreamError" });
    expect(server.attempts()).toBe(2);
  });

  it("a server that never sends headers counts as a stall too", async () => {
    const server = await serve(["no-headers", "good"]);
    expect(textOf(await collect(client(server.url).stream(request, new AbortController().signal)))).toBe("whole reply");
    expect(server.attempts()).toBe(2);
  });

  it("a stall after some text sends a restart before the second attempt", async () => {
    const server = await serve(["stall-after-text", "good"]);
    const events = await collect(client(server.url).stream(request, new AbortController().signal));
    expect(events.map((event) => event.type).includes("restart")).toBe(true);
    expect(textOf(events)).toBe("whole reply");
  });

  it("a stall and a drop count separately", async () => {
    const server = await serve(["stall", "drop-after-text", "good"]);
    expect(textOf(await collect(client(server.url).stream(request, new AbortController().signal)))).toBe("whole reply");
    expect(server.attempts()).toBe(3);
  });

  it("a reply that keeps sending data is never treated as stalled", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", async () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (let index = 0; index < 5; index++) {
          res.write(sse(chunk({ content: `${index}` })));
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        res.write(sse(chunk({}, "stop"), "[DONE]"));
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(textOf(await collect(client(url).stream(request, new AbortController().signal)))).toBe("01234");
  });
});

describe("cancelling while a reply is being retried", () => {
  it("stops promptly and does not retry", async () => {
    const server = await serve(["stall"]);
    const controller = new AbortController();
    const pending = collect(client(server.url, { idleTimeoutMs: 5000 }).stream(request, controller.signal));
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toBeDefined();
    expect(server.attempts()).toBe(1);
  });
});
