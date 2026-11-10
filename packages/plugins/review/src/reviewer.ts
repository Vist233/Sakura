import type { Content, LlmClient, Log, LogEntry, Message, ToolCall, Usage } from "@sakura/kernel";
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

/** The sizes that keep the reviewer's conversation small. All are numbers of characters unless the name says tokens. */
export interface ReviewerLimits {
  /** When the reviewer's conversation is estimated to pass this many tokens, the next review starts a new one (default 24000). */
  maxThreadTokens: number;
  /** How many of the latest user messages a new conversation starts with (default 5). */
  recentUserMessages: number;
  /** How many of the latest earlier verdicts a new conversation starts with, one line each (default 10). */
  digestVerdicts: number;
  /** Cap for each user message and each tool call put into the conversation: head and tail, the middle left out (default 1200). */
  entryChars: number;
  /** Cap for the goal and the project instructions (default 4000). */
  instructionChars: number;
  /** Cap for the action under review (default 6000, head and tail). */
  actionChars: number;
}

export const defaultReviewerLimits: ReviewerLimits = { maxThreadTokens: 24_000, recentUserMessages: 5, digestVerdicts: 10, entryChars: 1200, instructionChars: 4000, actionChars: 6000 };

/** The limits with the defaults filled in; throws when one is not a positive whole number (a mistake in the definition is found at the definition). */
export function resolveReviewerLimits(given: Partial<ReviewerLimits> = {}): ReviewerLimits {
  const limits = { ...defaultReviewerLimits };
  for (const key of Object.keys(defaultReviewerLimits) as Array<keyof ReviewerLimits>) {
    const value = given[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`review: ${key} must be a whole number of at least 1, got ${String(value)}`);
    limits[key] = value;
  }
  return limits;
}

/** At most `max` characters: the beginning and the end, with a note of how much was left out between them. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = (left: number) => `… [${left} characters left out] …`;
  const room = Math.max(2, max - note(text.length).length);
  const head = Math.ceil(room / 2);
  const tail = Math.floor(room / 2);
  return `${text.slice(0, head)}${note(text.length - head - tail)}${text.slice(text.length - tail)}`;
}

const clip = shorten;

const textOf = (content: Content[]): string => content.map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[image]" : "")).join("");

/**
 * What the reviewer is told since the last time: the user's words, project instructions and goal, and the tool
 * calls the agent made. Tool results and the agent's own text are left out on purpose.
 */
export function transcriptDelta(entries: readonly LogEntry[], from: number, skipCallId: string, limits: ReviewerLimits = defaultReviewerLimits): string[] {
  const lines: string[] = [];
  for (const entry of entries.slice(from)) {
    if (entry.type === "custom_message") {
      const label = entry.customType === "goal" ? "goal" : entry.customType === "agents_md" ? "project instructions" : entry.customType;
      lines.push(`[${label}] ${clip(textOf(entry.content), limits.instructionChars)}`);
    } else if (entry.type === "message" && entry.message.role === "user") {
      lines.push(`[user] ${clip(textOf(entry.message.content), limits.entryChars)}`);
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      for (const part of entry.message.content) {
        if (part.type === "tool_call" && part.id !== skipCallId) lines.push(`[agent tool call] ${part.name} ${clip(JSON.stringify(part.args ?? {}), limits.entryChars)}`);
      }
    }
  }
  return lines;
}

/** One line per earlier verdict, from the `review` records in the log: the last `limit` of them, oldest first. A review that failed technically is not a verdict. */
export function verdictDigest(entries: readonly LogEntry[], limit: number): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "review") continue;
    const data = entry.data as { tool?: unknown; outcome?: unknown; reason?: unknown; technical?: unknown } | null;
    if (!data || data.technical === true || typeof data.tool !== "string" || (data.outcome !== "allow" && data.outcome !== "deny")) continue;
    const reason = typeof data.reason === "string" ? data.reason.replace(/\s+/g, " ").trim() : "";
    lines.push(`[earlier review] ${data.tool}: ${data.outcome}${reason ? ` - ${shorten(reason, 160)}` : ""}`);
  }
  return lines.slice(-limit);
}

/**
 * What a new conversation starts with: the active goal, the project instructions, the latest few user messages and the digest of the latest verdicts.
 * Everything before is left out, and the reviewer is told so.
 */
export function seedLines(entries: readonly LogEntry[], limits: ReviewerLimits): string[] {
  const withdrawn = new Set(entries.flatMap((entry) => (entry.type === "context_edit" && entry.replacement === null ? [entry.targetId] : [])));
  const newest = (customType: string) => entries.findLast((entry) => entry.type === "custom_message" && entry.customType === customType && !withdrawn.has(entry.id));
  const lines: string[] = ["(Earlier parts of the conversation are left out. What follows is the project's instructions, the goal, the latest user messages and the latest verdicts.)"];
  const instructions = newest("agents_md");
  const goal = newest("goal");
  if (instructions?.type === "custom_message") lines.push(`[project instructions] ${clip(textOf(instructions.content), limits.instructionChars)}`);
  if (goal?.type === "custom_message") lines.push(`[goal] ${clip(textOf(goal.content), limits.instructionChars)}`);
  const users = entries.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [`[user] ${clip(textOf(entry.message.content), limits.entryChars)}`] : []));
  lines.push(...users.slice(-limits.recentUserMessages), ...verdictDigest(entries, limits.digestVerdicts));
  return lines;
}

interface Thread {
  messages: Message[];
  cursor: number;
}

export interface ReviewerOptions {
  llm: LlmClient;
  policy: PolicyLists;
  /** Default 90 seconds for each try. A timeout counts as a technical failure. */
  timeoutMs?: number;
  /** See ReviewerLimits. */
  limits?: Partial<ReviewerLimits>;
  /** Called with every assessment, for logs and evaluation. */
  onAssessment?(info: { call: ToolCall; assessment: Assessment; outcome: "allow" | "deny" }): void;
}

/** The review is asked twice at most: a second try for a technical failure (timeout, error, unreadable answer). */
const ATTEMPTS = 2;

/** `{ usage }` when the reviewer spent any tokens, otherwise nothing. */
const usageOf = (spent: Usage): { usage?: Usage } => (spent.input + spent.output + spent.cacheRead + spent.cacheWrite > 0 ? { usage: spent } : {});

/** Four characters to a token, as everywhere else. */
const estimatedTokens = (texts: string[]): number => Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4);

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], ts: 0 });

/**
 * A model asks "may this run?". One conversation per log is kept and only ever appended to, so the provider's
 * prompt cache keeps working. Anything unexpected (timeout, unreadable answer, error) is tried once more and then refused, marked as a technical failure.
 */
export function createReviewer(options: ReviewerOptions): Authorizer & { reset(log: Log): void } {
  const system = reviewerSystemPrompt(options.policy);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const limits = resolveReviewerLimits(options.limits);
  const threads = new WeakMap<Log, Thread>();
  const queues = new WeakMap<Log, Promise<unknown>>();

  /** One request to the reviewer model; returns its text and adds the tokens it used to `spent`. Throws on a timeout or an error. */
  async function ask(messages: Message[], runSignal: AbortSignal, spent: Usage): Promise<string> {
    const signal = AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]);
    let answer = "";
    for await (const event of options.llm.stream({ system, messages, tools: [], maxTokens: 1000 }, signal)) {
      if (event.type === "text_delta") answer += event.delta;
      else if (event.type === "usage") {
        spent.input += event.usage.input;
        spent.output += event.usage.output;
        spent.cacheRead += event.usage.cacheRead;
        spent.cacheWrite += event.usage.cacheWrite;
      }
    }
    return answer;
  }

  async function review(call: ToolCall, context: ReviewContext): Promise<Verdict> {
    const entries = await context.log.branch();
    const known = threads.get(context.log) ?? { messages: [], cursor: 0 };
    const action = `<action>\ntool: ${call.name}\narguments: ${shorten(JSON.stringify(call.args ?? {}), limits.actionChars)}\n</action>`;
    const promptFor = (lines: string[]) => (lines.length > 0 ? `<context>\n${lines.join("\n")}\n</context>\n\n` : "") + action;

    // The conversation only grows, so the provider's cache keeps working, until it is too big or its basis changed; then a new one starts from a seed.
    const rewritten = entries.length < known.cursor || entries.slice(known.cursor).some((entry) => entry.type === "compaction");
    let thread = rewritten ? { messages: [], cursor: 0 } : known;
    let prompt = promptFor(thread.messages.length === 0 ? seedLines(entries, limits) : transcriptDelta(entries, thread.cursor, call.id, limits));
    if (thread.messages.length > 0 && estimatedTokens([system, ...thread.messages.map((message) => textOf(message.content)), prompt]) > limits.maxThreadTokens) {
      thread = { messages: [], cursor: 0 };
      prompt = promptFor(seedLines(entries, limits));
    }
    const messages = [...thread.messages, userMessage(prompt)];

    // a technical failure is tried once more; what the attempts cost is counted either way
    const spent: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let failure = "";
    let answer = "";
    let assessment: Assessment | undefined;
    for (let attempt = 1; attempt <= ATTEMPTS && !assessment; attempt++) {
      try {
        answer = await ask(messages, context.signal, spent);
        assessment = parseAssessment(answer);
        if (!assessment) failure = "it gave an answer that could not be read";
      } catch (error) {
        if (context.signal.aborted) return { kind: "deny", reason: "The run was stopped during the safety review, so the action was not allowed.", technical: true, ...usageOf(spent) };
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        failure = timedOut ? "it did not finish in time" : `it failed (${error instanceof Error ? error.message : "error"})`;
      }
    }
    if (!assessment)
      return { kind: "deny", reason: `The safety review failed technically (${failure}, also on a second try), so the action was not judged and not allowed.`, technical: true, ...usageOf(spent) };

    // keep the conversation append-only: this exchange becomes part of the prefix of the next one
    threads.set(context.log, { messages: [...messages, { role: "assistant", content: [{ type: "text", text: answer }], ts: 0 }], cursor: entries.length });
    const computed = outcomeFor(assessment.risk_level, assessment.user_authorization);
    const outcome = computed === "deny" || assessment.outcome === "deny" ? "deny" : "allow";
    options.onAssessment?.({ call, assessment, outcome });
    return outcome === "allow"
      ? { kind: "allow", reason: assessment.rationale || "approved by the safety review", ...usageOf(spent) }
      : { kind: "deny", reason: assessment.rationale || `risk ${assessment.risk_level}, user authorization ${assessment.user_authorization}`, ...usageOf(spent) };
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
