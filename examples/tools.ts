import { createFauxClient } from "@sakura/testing";
import { compatPresets, corePlugins, createAgent, limitsPlugin } from "../sdk/index.ts";
import type { Plugin, Tool } from "../sdk/index.ts";

const projectStatus: Tool = {
  name: "project_status",
  description: "Return the status of the sample project.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  effect: "read",
  async execute() {
    return { content: [{ type: "text", text: "Build passed." }] };
  },
};

const projectTools: Plugin = {
  name: "project-tools",
  setup(api) {
    api.registerTool(projectStatus);
  },
};

const apiKey = process.env.DEEPSEEK_API_KEY;
const model = apiKey
  ? {
      baseUrl: "https://api.deepseek.com",
      apiKey,
      model: "deepseek-flash",
      contextWindow: 128_000,
      compat: compatPresets.deepseek,
    }
  : createFauxClient([{ toolCalls: [{ name: "project_status", args: {}, id: "status" }] }, { text: "The build passed." }]);

const agent = await createAgent({
  model,
  tools: [],
  plugins: [...corePlugins().filter((plugin) => plugin.name !== "limits"), limitsPlugin({ maxTurns: 8 }), projectTools],
  maxTokens: 1_024,
});
try {
  const run = agent.run("Call project_status, then report its result.");
  for await (const event of run.events) {
    if (event.type === "tool_start") console.log(`Calling ${event.call.name}`);
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const part of event.message.content) if (part.type === "text") console.log(part.text);
    }
  }
  const result = await run.result;
  if (result.reason !== "done") throw new Error(result.error ?? result.reason);
} finally {
  await agent.close();
}
