import type { ThinkingLevel } from "@sakura/kernel";

/** Differences between providers that speak the Chat Completions protocol. Plain data, one set per model. */
export interface ChatCompat {
  /** Provider name; reasoning data is only replayed to the provider that produced it. */
  vendor: string;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /** How the thinking level is sent. */
  thinkingFormat: "none" | "openai" | "deepseek";
  /** The gateway may require a separate effort value even when the thinking toggle is disabled. */
  offEffort?: "off";
  /** The provider treats Extra high as High. */
  extraHighEffort?: "high";
  /** Extra effort values supported by this model profile. */
  thinkingLevels?: readonly ThinkingLevel[];
  /** Send reasoning_content back on assistant messages (DeepSeek rejects tool conversations without it). */
  replayReasoning: boolean;
  /** Ask for token usage in the stream. */
  streamUsage: boolean;
  /** Tool result messages must carry the tool name. */
  toolResultName: boolean;
  /** Whether the model can read images. */
  images: boolean;
  /** The image formats the model accepts (media types). What it does not accept is never sent: it becomes a note for the model. */
  imageFormats: readonly string[];
  /** The largest image the model accepts, in bytes; left out, no limit is applied. */
  imageMaxBytes?: number;
}

export const defaultCompat: ChatCompat = {
  vendor: "openai-compatible",
  maxTokensField: "max_completion_tokens",
  thinkingFormat: "none",
  replayReasoning: false,
  streamUsage: true,
  toolResultName: false,
  images: true,
  imageFormats: ["image/png", "image/jpeg", "image/gif", "image/webp"],
};

export function thinkingParameters(compat: ChatCompat, level: ThinkingLevel | undefined): Record<string, unknown> {
  if (level === undefined || compat.thinkingFormat === "none") return {};
  if (compat.thinkingFormat === "openai") return level === "off" ? {} : { reasoning_effort: level };
  const effort = level === "xhigh" ? (compat.extraHighEffort ?? level) : level;
  return level === "off" ? { thinking: { type: "disabled" }, ...(compat.offEffort ? { reasoning_effort: compat.offEffort } : {}) } : { thinking: { type: "enabled" }, reasoning_effort: effort };
}
