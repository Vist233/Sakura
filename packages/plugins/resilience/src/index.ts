import type { Content, LlmRequest, Message, Plugin } from "@sakura/kernel";

/** What to do about one kind of failed reply. */
export interface FixOptions {
  /** How many times in a row the agent is asked again before the run is left to end (default depends on the fix). */
  retries?: number;
  /** The message that asks the model again. It is added to the conversation as a user message. */
  message?: string;
}

export interface ResilienceOptions {
  /**
   * The reply was cut off by the output limit before any text or tool call: a reasoning model used the whole budget thinking.
   * The model is asked to continue and the next requests get a larger `maxTokens`. On by default, 2 retries.
   */
  cutEmpty?: false | FixOptions;
  /** The reply ended normally but contains neither text nor a tool call. On by default, 1 retry. */
  empty?: false | FixOptions;
  /** The reply was cut off by the output limit in the middle of its text. Off by default (a person can say "continue"). */
  cutText?: false | FixOptions;
  /** How much larger the limit gets after a cut reply. Default: from 8192 (when none is set) doubling at each retry, up to 32768. */
  maxTokens?: { start?: number; cap?: number; growth?: number };
}

const MARK = "[auto:";

interface Fix {
  id: "cut-empty" | "empty" | "cut-text";
  /** Does this reply need asking again? */
  matches(reply: Message): boolean;
  /** Does the next request need more room? */
  raises: boolean;
  retries: number;
  message: string;
}

const hasText = (content: Content[]) => content.some((part) => part.type === "text" && part.text.trim() !== "");
const hasCall = (content: Content[]) => content.some((part) => part.type === "tool_call");

const MESSAGES = {
  "cut-empty": "Your previous reply was cut off by the output limit before you wrote anything. Continue now: keep your reasoning short, then write your answer or make your tool call.",
  empty: "Your previous reply was empty. Say what you found, or make the tool call you meant to make.",
  "cut-text": "Your previous reply was cut off by the output limit. Continue exactly where you stopped.",
};

/** Which fix a user message belongs to, when this plugin wrote it. */
function nudgeOf(message: Message | undefined): string | undefined {
  if (message?.role !== "user") return undefined;
  const first = message.content[0];
  if (first?.type !== "text" || !first.text.startsWith(MARK)) return undefined;
  return first.text.slice(MARK.length, first.text.indexOf("] "));
}

/**
 * The fixes asked for at the end of the conversation, newest first: the replies that were asked again and have not been followed by anything else.
 * Counting from the conversation itself (not from memory) keeps this right after a restart and when sub-agents share one plugin.
 */
function trailingNudges(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  let index = messages.length - 1;
  if (messages[index]?.role === "assistant") index--; // at the end of a turn the reply being judged comes last
  while (index >= 0) {
    const id = nudgeOf(messages[index]);
    if (id === undefined) break;
    ids.push(id);
    if (messages[index - 1]?.role !== "assistant") break;
    index -= 2;
  }
  return ids;
}

/**
 * Small, common failures of a model that need no person: a reasoning model that spends its whole output limit thinking and says nothing,
 * a reply that is empty, a reply cut off in the middle of its text. Each one is asked again (with more room when the limit was the problem).
 * Every fix can be switched off or given another number of retries. Models fail in more such ways; new fixes belong here.
 */
export function resiliencePlugin(options: ResilienceOptions = {}): Plugin {
  const fixes: Fix[] = [];
  const add = (id: Fix["id"], setting: false | FixOptions | undefined, on: boolean, retries: number, raises: boolean, matches: Fix["matches"]) => {
    if (setting === false || (setting === undefined && !on)) return;
    fixes.push({ id, matches, raises, retries: setting?.retries ?? retries, message: setting?.message ?? MESSAGES[id] });
  };
  add("cut-empty", options.cutEmpty, true, 2, true, (reply) => reply.stop === "length" && !hasText(reply.content) && !hasCall(reply.content));
  add("empty", options.empty, true, 1, false, (reply) => reply.stop === "stop" && !hasText(reply.content) && !hasCall(reply.content));
  add("cut-text", options.cutText, false, 2, true, (reply) => reply.stop === "length" && hasText(reply.content) && !hasCall(reply.content));

  const start = options.maxTokens?.start ?? 8192;
  const cap = options.maxTokens?.cap ?? 32768;
  const growth = options.maxTokens?.growth ?? 2;
  const raising = new Set(fixes.filter((fix) => fix.raises).map((fix) => fix.id as string));

  return {
    name: "resilience",
    compensates: "models fail in small, common ways that need no person: a reasoning model that uses its whole output limit thinking, an empty reply, a reply cut off",
    setup(api) {
      api.on("request", (request: LlmRequest) => {
        const rounds = trailingNudges(request.messages).filter((id) => raising.has(id)).length;
        if (rounds === 0) return undefined;
        const base = request.maxTokens ?? start;
        const raised = Math.min(cap, Math.round(base * growth ** rounds));
        return raised > base ? { ...request, maxTokens: raised } : undefined;
      });
      api.on("turn.end", ({ messages }) => {
        const reply = messages.at(-1);
        if (reply?.role !== "assistant") return undefined;
        const fix = fixes.find((candidate) => candidate.matches(reply));
        if (!fix) return undefined;
        const attempts = trailingNudges(messages).filter((id) => id === fix.id).length;
        if (attempts >= fix.retries) {
          api.emit({ fix: fix.id, action: "gave up", attempts });
          return undefined;
        }
        api.emit({ fix: fix.id, action: "ask again", attempt: attempts + 1 });
        return { append: [{ role: "user", content: [{ type: "text", text: `${MARK}${fix.id}] ${fix.message}` }], ts: Date.now() }] };
      });
    },
  };
}
