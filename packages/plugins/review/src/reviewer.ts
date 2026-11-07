import type { Content, LlmClient, Log, LogEntry, Message, ToolCall } from "@sakura/kernel";
import type { Authorizer, ReviewContext, Verdict } from "./chain.ts";
import { reviewerSystemPrompt } from "./policy.ts";
import type { PolicyLists } from "./policy.ts";

export type Risk = "low" | "medium" | "high" | "critical";
export type Authorization = "high" | "medium" | "low" | "unknown";

export interface Assessment {
  risk_level: Risk;
  user_authorization: Authorization;
  outcome: "allow" | "deny";
  rationale: string;
}

const RISKS: Risk[] = ["low", "medium", "high", "critical"];
const AUTHORIZATIONS: Authorization[] = ["high", "medium", "low", "unknown"];

/** Reads the first JSON object in the reviewer's answer. Returns undefined when it is not a valid assessment. */
export function parseAssessment(text: string): Assessment | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      if (RISKS.includes(value.risk_level as Risk) && AUTHORIZATIONS.includes(value.user_authorization as Authorization) && (value.outcome === "allow" || value.outcome === "deny")) {
        return {
          risk_level: value.risk_level as Risk,
          user_authorization: value.user_authorization as Authorization,
          outcome: value.outcome,
          rationale: typeof value.rationale === "string" ? value.rationale : "",
        };
      }
      return undefined;
    } catch {
      // try a shorter slice
    }
  }
  return undefined;
}

/** The outcome that follows from risk and authorization: low and medium pass, high needs clear authorization, critical never passes. */
export function outcomeFor(risk: Risk, authorization: Authorization): "allow" | "deny" {
  if (risk === "low" || risk === "medium") return "allow";
  if (risk === "high") return authorization === "high" || authorization === "medium" ? "allow" : "deny";
  return "deny";
}

const clip = (text: string, max = 2000) => (text.length > max ? `${text.slice(0, max)}… [cut]` : text);

const textOf = (content: Content[]): string => content.map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[image]" : "")).join("");

/**
 * What the reviewer is told since the last time: the user's words, project instructions and goal, and the tool
 * calls the agent made. Tool results and the agent's own text are left out on purpose.
 */
export function transcriptDelta(entries: readonly LogEntry[], from: number, skipCallId: string): string[] {
  const lines: string[] = [];
  for (const entry of entries.slice(from)) {
    if (entry.type === "custom_message") {
      const label = entry.customType === "goal" ? "goal" : entry.customType === "agents_md" ? "project instructions" : entry.customType;
      lines.push(`[${label}] ${clip(textOf(entry.content), 6000)}`);
    } else if (entry.type === "message" && entry.message.role === "user") {
      lines.push(`[user] ${clip(textOf(entry.message.content))}`);
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      for (const part of entry.message.content) {
        if (part.type === "tool_call" && part.id !== skipCallId) lines.push(`[agent tool call] ${part.name} ${clip(JSON.stringify(part.args ?? {}))}`);
      }
    }
  }
  return lines;
}

interface Thread {
  messages: Message[];
  cursor: number;
}

export interface ReviewerOptions {
  llm: LlmClient;
  policy: PolicyLists;
  /** Default 90 seconds. A timeout counts as a refusal. */
  timeoutMs?: number;
  /** Called with every assessment, for logs and evaluation. */
  onAssessment?(info: { call: ToolCall; assessment: Assessment; outcome: "allow" | "deny" }): void;
}

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], ts: 0 });

/**
 * A model asks "may this run?". One conversation per log is kept and only ever appended to, so the provider's
 * prompt cache keeps working. Anything unexpected (timeout, unreadable answer, error) is a refusal.
 */
export function createReviewer(options: ReviewerOptions): Authorizer & { reset(log: Log): void } {
  const system = reviewerSystemPrompt(options.policy);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const threads = new WeakMap<Log, Thread>();
  const queues = new WeakMap<Log, Promise<unknown>>();

  async function review(call: ToolCall, context: ReviewContext): Promise<Verdict> {
    const entries = await context.log.branch();
    const thread = threads.get(context.log) ?? { messages: [], cursor: 0 };
    const delta = transcriptDelta(entries, thread.cursor, call.id);
    const prompt = (delta.length > 0 ? `<context>\n${delta.join("\n")}\n</context>\n\n` : "") + `<action>\ntool: ${call.name}\narguments: ${clip(JSON.stringify(call.args ?? {}), 4000)}\n</action>`;
    const messages = [...thread.messages, userMessage(prompt)];

    let answer = "";
    try {
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
      for await (const event of options.llm.stream({ system, messages, tools: [], maxTokens: 1000 }, signal)) {
        if (event.type === "text_delta") answer += event.delta;
      }
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        kind: "deny",
        reason: timedOut
          ? "The safety review did not finish in time, so the action was not allowed."
          : `The safety review failed (${error instanceof Error ? error.message : "error"}), so the action was not allowed.`,
      };
    }

    const assessment = parseAssessment(answer);
    if (!assessment) return { kind: "deny", reason: "The safety review gave an answer that could not be read, so the action was not allowed." };

    // keep the conversation append-only: this exchange becomes part of the prefix of the next one
    threads.set(context.log, { messages: [...messages, { role: "assistant", content: [{ type: "text", text: answer }], ts: 0 }], cursor: entries.length });
    const computed = outcomeFor(assessment.risk_level, assessment.user_authorization);
    const outcome = computed === "deny" || assessment.outcome === "deny" ? "deny" : "allow";
    options.onAssessment?.({ call, assessment, outcome });
    return outcome === "allow"
      ? { kind: "allow", reason: assessment.rationale || "approved by the safety review" }
      : { kind: "deny", reason: assessment.rationale || `risk ${assessment.risk_level}, user authorization ${assessment.user_authorization}` };
  }

  return {
    name: "reviewer",
    // reviews for one log run one at a time so the shared conversation stays in order
    review(call, context) {
      const previous = queues.get(context.log) ?? Promise.resolve();
      const next = previous.then(
        () => review(call, context),
        () => review(call, context),
      );
      queues.set(
        context.log,
        next.catch(() => undefined),
      );
      return next;
    },
    reset(log) {
      threads.delete(log);
    },
  };
}
