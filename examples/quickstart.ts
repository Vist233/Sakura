import { createAgent } from "@sakura/agent";
import { compatPresets } from "@sakura/llm";
import { createFauxClient } from "@sakura/testing";

const apiKey = process.env.DEEPSEEK_API_KEY;
const model = apiKey
  ? {
      baseUrl: "https://api.deepseek.com",
      apiKey,
      model: "deepseek-flash",
      contextWindow: 128_000,
      compat: compatPresets.deepseek,
    }
  : createFauxClient([{ text: "Sakura is ready." }]);

const agent = await createAgent({ model, tools: [], maxTokens: 256 });
try {
  const run = agent.run("Reply with exactly: Sakura is ready.");
  for await (const event of run.events) {
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const part of event.message.content) if (part.type === "text") console.log(part.text);
    }
  }
  const result = await run.result;
  if (result.reason !== "done") {
    console.error(result.error ?? result.reason);
    process.exitCode = 1;
  }
} finally {
  await agent.close();
}
