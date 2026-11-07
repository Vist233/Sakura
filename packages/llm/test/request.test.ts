import { describe, expect, it } from "vitest";
import type { Content, LlmRequest, Message } from "@sakura/kernel";
import { defaultCompat } from "../src/chat/compat.ts";
import type { ChatCompat } from "../src/chat/compat.ts";
import { toWireRequest } from "../src/chat/request.ts";

const text = (value: string): Content[] => [{ type: "text", text: value }];
const message = (role: Message["role"], content: Content[], extra: Partial<Message> = {}): Message => ({ role, content, ts: 1, ...extra });
const build = (request: Partial<LlmRequest>, compat: Partial<ChatCompat> = {}) =>
  toWireRequest(
    { system: "sys", messages: [], tools: [], ...request },
    {
      model: "m",
      compat: { ...defaultCompat, ...compat },
      resolveImage: async (ref) => `data:image/png;base64,${ref}`,
    },
  );

describe("request: basic shape", () => {
  it("starts with the system prompt and asks for a stream with usage", async () => {
    const wire = await build({ messages: [message("user", text("hi"))] });
    expect(wire).toMatchObject({ model: "m", stream: true, stream_options: { include_usage: true } });
    expect((wire.messages as unknown[])[0]).toEqual({ role: "system", content: "sys" });
    expect((wire.messages as unknown[])[1]).toEqual({ role: "user", content: "hi" });
  });

  it("omits the system message when the prompt is empty", async () => {
    const wire = await build({ system: "", messages: [message("user", text("hi"))] });
    expect(wire.messages as unknown[]).toHaveLength(1);
  });

  it("omits stream_options when the provider does not support usage in streams", async () => {
    expect(await build({}, { streamUsage: false })).not.toHaveProperty("stream_options");
  });

  it("never sends store or developer roles", async () => {
    const wire = await build({ messages: [message("system", text("note"))] });
    expect(JSON.stringify(wire)).not.toContain("developer");
    expect(wire).not.toHaveProperty("store");
  });
});

describe("request: token limit and thinking", () => {
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    for (const value of [1, 100, 4096, 32000]) {
      it(`uses ${field} for ${value}`, async () => {
        const wire = await build({ maxTokens: value }, { maxTokensField: field });
        expect(wire[field]).toBe(value);
        expect(wire[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"]).toBeUndefined();
      });
    }
  }

  const thinking: Array<[ChatCompat["thinkingFormat"], "off" | "low" | "medium" | "high", Record<string, unknown>]> = [
    ["none", "high", {}],
    ["openai", "off", {}],
    ["openai", "low", { reasoning_effort: "low" }],
    ["openai", "medium", { reasoning_effort: "medium" }],
    ["openai", "high", { reasoning_effort: "high" }],
    ["deepseek", "off", { thinking: { type: "disabled" } }],
    ["deepseek", "medium", { thinking: { type: "enabled" }, reasoning_effort: "medium" }],
    ["deepseek", "high", { thinking: { type: "enabled" }, reasoning_effort: "high" }],
  ];
  for (const [format, level, expected] of thinking) {
    it(`thinking ${level} with format ${format}`, async () => {
      const wire = await build({ thinking: level }, { thinkingFormat: format });
      for (const [key, value] of Object.entries(expected)) expect(wire[key]).toEqual(value);
      if (Object.keys(expected).length === 0) {
        expect(wire).not.toHaveProperty("thinking");
        expect(wire).not.toHaveProperty("reasoning_effort");
      }
    });
  }

  it("sends no thinking parameters when no level is set", async () => {
    expect(await build({}, { thinkingFormat: "deepseek" })).not.toHaveProperty("thinking");
  });
});

describe("request: tools and tool calls", () => {
  it("lists tools in the function format", async () => {
    const wire = await build({ tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }] });
    expect(wire.tools).toEqual([{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }]);
  });

  it("omits the tools field when there are none", async () => {
    expect(await build({})).not.toHaveProperty("tools");
  });

  for (const args of [{}, { a: 1 }, { nested: { list: [1, 2, 3] } }, "raw string", { text: 'quote " and \n newline' }]) {
    it(`serialises assistant tool call arguments ${JSON.stringify(args).slice(0, 30)}`, async () => {
      const wire = await build({ messages: [message("assistant", [{ type: "tool_call", id: "c1", name: "t", args }])] });
      const assistant = (wire.messages as Array<Record<string, any>>)[1]!;
      expect(assistant.tool_calls[0].function.arguments).toBe(typeof args === "string" ? args : JSON.stringify(args));
      expect(assistant.tool_calls[0]).toMatchObject({ id: "c1", type: "function" });
      expect(assistant.content).toBe("");
    });
  }

  it("keeps assistant text next to its tool calls", async () => {
    const wire = await build({
      messages: [
        message("assistant", [
          { type: "text", text: "let me look" },
          { type: "tool_call", id: "c", name: "t", args: {} },
        ]),
      ],
    });
    expect((wire.messages as Array<Record<string, any>>)[1]).toMatchObject({ content: "let me look" });
  });

  it("sends tool results with the call id", async () => {
    const wire = await build({ messages: [message("tool", text("result"), { toolCallId: "c9", toolName: "t" })] });
    expect((wire.messages as unknown[])[1]).toEqual({ role: "tool", tool_call_id: "c9", content: "result" });
  });

  it("adds the tool name only where the provider needs it", async () => {
    const wire = await build({ messages: [message("tool", text("r"), { toolCallId: "c", toolName: "grep" })] }, { toolResultName: true });
    expect((wire.messages as Array<Record<string, any>>)[1]?.name).toBe("grep");
  });
});

describe("request: reasoning replay", () => {
  const withReasoning = message("assistant", [
    { type: "provider", vendor: "deepseek", data: { reasoning: "thought" } },
    { type: "text", text: "answer" },
  ]);
  it("replays reasoning_content to the vendor that produced it", async () => {
    const wire = await build({ messages: [withReasoning] }, { vendor: "deepseek", replayReasoning: true });
    expect((wire.messages as Array<Record<string, any>>)[1]?.reasoning_content).toBe("thought");
  });
  it("sends an empty reasoning_content when there is none but the provider requires the field", async () => {
    const wire = await build({ messages: [message("assistant", text("plain"))] }, { vendor: "deepseek", replayReasoning: true });
    expect((wire.messages as Array<Record<string, any>>)[1]?.reasoning_content).toBe("");
  });
  it("does not replay reasoning from another vendor", async () => {
    const wire = await build({ messages: [withReasoning] }, { vendor: "moonshot", replayReasoning: true });
    expect((wire.messages as Array<Record<string, any>>)[1]?.reasoning_content).toBe("");
  });
  it("does not send reasoning_content when replay is off", async () => {
    const wire = await build({ messages: [withReasoning] }, { vendor: "deepseek", replayReasoning: false });
    expect((wire.messages as Array<Record<string, any>>)[1]).not.toHaveProperty("reasoning_content");
  });
});

describe("request: images", () => {
  const image = (ref: string): Content => ({ type: "image", mediaType: "image/png", ref });
  for (const count of [1, 2, 3]) {
    it(`user message with text and ${count} image(s) becomes content parts`, async () => {
      const wire = await build({ messages: [message("user", [{ type: "text", text: "look" }, ...Array.from({ length: count }, (_, index) => image(`img${index}`))])] });
      const content = (wire.messages as Array<Record<string, any>>)[1]?.content as Array<Record<string, any>>;
      expect(content).toHaveLength(1 + count);
      expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,img0" } });
    });
  }

  it("replaces images with a note for models that cannot read them", async () => {
    const wire = await build({ messages: [message("user", [image("a")])] }, { images: false });
    expect(JSON.stringify(wire)).toContain("cannot read images");
    expect(JSON.stringify(wire)).not.toContain("image_url");
  });

  for (const count of [1, 2]) {
    it(`tool result images (${count}) move to a user message after the last tool result`, async () => {
      const wire = await build({
        messages: [
          message("assistant", [
            { type: "tool_call", id: "a", name: "shot", args: {} },
            { type: "tool_call", id: "b", name: "shot", args: {} },
          ]),
          message("tool", [{ type: "text", text: "first" }, ...Array.from({ length: count }, (_, index) => image(`p${index}`))], { toolCallId: "a" }),
          message("tool", text("second"), { toolCallId: "b" }),
        ],
      });
      const messages = wire.messages as Array<Record<string, any>>;
      expect(messages.map((item) => item.role)).toEqual(["system", "assistant", "tool", "tool", "user"]);
      expect(messages[2]?.content).toContain("(see attached image)");
      expect(messages[4]?.content).toHaveLength(1 + count);
    });
  }

  it("a tool image goes out before the next real user message", async () => {
    const wire = await build({ messages: [message("tool", [image("p")], { toolCallId: "a" }), message("user", text("next"))] });
    expect((wire.messages as Array<Record<string, any>>).map((item) => item.role)).toEqual(["system", "tool", "user", "user"]);
  });
});
