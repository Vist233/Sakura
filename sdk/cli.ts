#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { compatPresets, createAgent } from "./index.ts";
import type { AgentConfig } from "./index.ts";

const help = `Usage:
  sakura run "prompt" [--session FILE]
  sakura resume --session FILE

Options:
  --cwd DIR            Tool working directory
  --tools LIST         Comma-separated read,write,edit,bash (default: none)
  --model NAME         Model name (default: deepseek-flash)
  --base-url URL       Chat Completions base URL (default: https://api.deepseek.com)
  --context-window N   Model context window (default: 128000)
  --max-tokens N       Maximum output tokens per model request
  --json               Write agent events as JSON lines
  --help               Show this help

Set SAKURA_API_KEY or DEEPSEEK_API_KEY before running.`;

const toolNames = ["read", "write", "edit", "bash"] as const;
type ToolName = (typeof toolNames)[number];

function positiveInteger(flag: string, value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer.`);
  return number;
}

function selectTools(value: string): ToolName[] {
  if (!value) return [];
  return value.split(",").map((name) => {
    const tool = toolNames.find((candidate) => candidate === name.trim());
    if (!tool) throw new Error(`Unknown built-in tool: ${name}`);
    return tool;
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      cwd: { type: "string" },
      tools: { type: "string", default: "" },
      session: { type: "string" },
      model: { type: "string", default: "deepseek-flash" },
      "base-url": { type: "string", default: "https://api.deepseek.com" },
      "context-window": { type: "string", default: "128000" },
      "max-tokens": { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }

  const [command, ...words] = positionals;
  if (command !== "run" && command !== "resume") throw new Error(`Unknown command: ${command}`);
  if (command === "run" && !words.join(" ").trim()) throw new Error("A prompt is required.");
  if (command === "resume" && (!values.session || words.length > 0)) throw new Error("Resume requires --session FILE.");
  const apiKey = process.env.SAKURA_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Set SAKURA_API_KEY or DEEPSEEK_API_KEY.");
  delete process.env.SAKURA_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;

  const cwd = resolve(values.cwd ?? ".");
  const sessionFile = values.session ? resolve(cwd, values.session) : undefined;
  if (command === "resume" && sessionFile && !existsSync(sessionFile)) throw new Error("Session file does not exist.");
  const baseUrl = values["base-url"];
  const model: AgentConfig["model"] = {
    apiKey,
    baseUrl,
    model: values.model,
    contextWindow: positiveInteger("--context-window", values["context-window"]),
    ...(new URL(baseUrl).hostname === "api.deepseek.com" ? { compat: compatPresets.deepseek } : {}),
  };
  const agent = await createAgent({
    cwd,
    model,
    tools: selectTools(values.tools),
    ...(sessionFile ? { sessionFile } : {}),
    ...(values["max-tokens"] ? { maxTokens: positiveInteger("--max-tokens", values["max-tokens"]) } : {}),
  });
  const cancel = () => agent.cancel();
  process.once("SIGINT", cancel);
  try {
    const run = agent.run(command === "run" ? words.join(" ") : undefined);
    for await (const event of run.events) {
      if (values.json) console.log(JSON.stringify(event));
      else if (event.type === "message_end" && event.message.role === "assistant") {
        for (const part of event.message.content) if (part.type === "text") console.log(part.text);
      }
    }
    const result = await run.result;
    if (values.json) console.log(JSON.stringify({ type: "result", ...result }));
    if (result.reason !== "done") {
      if (!values.json) console.error(result.error ?? result.pause ?? result.reason);
      process.exitCode = result.reason === "cancelled" ? 130 : result.reason === "paused" ? 2 : 1;
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    await agent.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
