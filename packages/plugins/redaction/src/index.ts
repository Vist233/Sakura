import { FatalHookError } from "@sakura/kernel";
import type { Content, LlmClient, LlmRequest, Message, Plugin } from "@sakura/kernel";
import { createEngine } from "./engine.ts";
import type { SecretRule } from "./engine.ts";
import { createRestorer } from "./restore.ts";

export interface RedactionOptions {
  /** Key for the placeholders. A fixed key keeps placeholders the same across restarts (better prompt caching). */
  key?: string;
  /** Replaces the built-in rules (the gitleaks table plus a few of our own). */
  rules?: SecretRule[];
}

export interface RedactionPlugin extends Plugin {
  /** Swap secrets in a piece of text for placeholders, for logs and the like. */
  scrub(text: string): string;
  restore(text: string): string;
  /**
   * A client that masks every request before it is sent. For models that are not the agent's own (the reviewer, for example), whose
   * requests do not pass the agent's `request` hook. Only the request is masked: nothing real ever comes back from such a model.
   */
  wrap(llm: LlmClient): LlmClient;
}

const EXPLANATION = `<redaction>
Text such as {{KIND_xxxxxxxx}} stands for a secret that was redacted before it reached you. When you need such a value in a command, file or message, copy the placeholder exactly as written; the real value is restored when the command runs. Never guess, complete or alter a placeholder, and treat it as a real secret when judging risk.
</redaction>`;

const MAX_REMEMBERED = 5000;

/**
 * Keeps secrets away from the model. Every request is scanned; secrets become stable placeholders, and the model's
 * reply (text and tool arguments) gets the real values back before anything runs or is saved. If scanning fails the
 * request is not sent. Off unless you add it.
 *
 * It protects what is sent to the model provider, not what is stored here: the log (the session file), the events and any trace keep the real values,
 * because the tools need them and a resumed session is read from the log. Use `scrub` on anything you export or share.
 */
export function redactionPlugin(options: RedactionOptions = {}): RedactionPlugin {
  const engine = createEngine({ ...(options.key ? { key: options.key } : {}), ...(options.rules ? { rules: options.rules } : {}) });
  // Text that was sent before keeps the form it was sent in, so earlier parts of the request never change.
  const frozen = new Map<string, string>();

  const maskText = (text: string): string => {
    const known = frozen.get(text);
    if (known !== undefined) return known;
    const masked = engine.mask(text);
    if (frozen.size >= MAX_REMEMBERED) frozen.delete(frozen.keys().next().value as string);
    frozen.set(text, masked);
    return masked;
  };

  const maskDeep = (value: unknown): unknown => {
    if (typeof value === "string") return maskText(value);
    if (Array.isArray(value)) return value.map(maskDeep);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskDeep(inner)]));
    return value;
  };

  const maskPart = (part: Content): Content => {
    if (part.type === "text") return { ...part, text: maskText(part.text) };
    if (part.type === "tool_call") return { ...part, args: maskDeep(part.args) };
    if (part.type === "provider") return { ...part, data: maskDeep(part.data) };
    return part;
  };

  function maskRequest(request: LlmRequest): LlmRequest {
    const messages: Message[] = request.messages.map((message) => ({ ...message, content: message.content.map(maskPart) }));
    return { ...request, system: `${maskText(request.system)}\n\n${EXPLANATION}`, messages };
  }

  return {
    name: "redaction",
    compensates: "secrets that reach a model provider cannot be taken back",
    scrub: maskText,
    restore: engine.restore,
    wrap: (llm) => ({ model: llm.model, stream: (request, signal) => llm.stream(maskRequest(request), signal) }),
    setup(api) {
      api.on("request", (request: LlmRequest) => {
        try {
          return { request: maskRequest(request), transform: createRestorer(engine.restore) };
        } catch (error) {
          throw new FatalHookError(`redaction failed, so the request was not sent (${error instanceof Error ? error.message : String(error)})`);
        }
      });
    },
  };
}

export type { SecretRule } from "./engine.ts";
