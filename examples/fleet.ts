// A fleet: several agents with different jobs, each in its own directory with its own session file, all running at the same time.
// Without DEEPSEEK_API_KEY every agent is a scripted stand-in that writes one file, so the example runs offline.
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxClient } from "@sakura/testing";
import { compatPresets, createAgent } from "../sdk/index.ts";
import type { Agent } from "../sdk/index.ts";

const apiKey = process.env.DEEPSEEK_API_KEY;
const modelFor = (job: string) =>
  apiKey
    ? { baseUrl: "https://api.deepseek.com", apiKey, model: "deepseek-flash", contextWindow: 128_000, compat: compatPresets.deepseek }
    : createFauxClient([{ toolCalls: [{ name: "write", args: { path: "result.md", content: `# ${job}\ndone\n` }, id: "w" }] }, { text: `${job}: finished.` }]);

// each job is a few lines: where the agent works, which tools it gets, what it is told
const jobs = [
  { name: "docs", rules: ["Write short documentation."], tools: ["read", "write"] as const },
  { name: "tests", rules: ["Write tests, never change source files."], tools: ["read", "write", "bash"] as const },
  { name: "review", rules: ["Review only; do not change anything."], tools: ["read"] as const },
];

const root = await mkdtemp(join(tmpdir(), "sakura-fleet-"));
const started: Agent[] = [];
try {
  const results = await Promise.all(
    jobs.map(async (job) => {
      const cwd = join(root, job.name);
      await mkdir(cwd);
      const agent = await createAgent({ model: modelFor(job.name), cwd, confine: true, tools: [...job.tools], rules: job.rules, sessionFile: join(cwd, ".session.jsonl"), maxTokens: 512 });
      started.push(agent);
      const run = agent.run(`Do the ${job.name} job and save a short note in result.md.`);
      for await (const _event of run.events) {
        // a real program would stream events to its own log here
      }
      return {
        job: job.name,
        reason: (await run.result).reason,
        wrote: await readFile(join(cwd, "result.md"), "utf8").then(
          () => true,
          () => false,
        ),
      };
    }),
  );
  console.table(results);
  // the review agent has only the read tool, so it cannot have written anything; the others did, each in its own directory
} finally {
  await Promise.all(started.map((agent) => agent.close()));
}
