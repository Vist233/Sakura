// Permission presets: which plugins guard the agent. None of them restricts the working directory.
import { redactionPlugin, reviewPlugin } from "./framework.ts";
import type { LlmClient, Plugin, ThinkingLevel } from "./framework.ts";

export const PERMISSION_NAMES = ["auto", "read-only", "strict", "full-access"] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

export interface PermissionPreset {
  name: PermissionName;
  summary: string;
  review: boolean;
  /** Built-in tools the model gets; undefined means all four. */
  tools: Array<"read" | "write" | "edit" | "bash"> | undefined;
  /** Stop the run after this many refusals in a row; undefined means never. */
  breakerConsecutive: number | undefined;
}

export const PERMISSION_PRESETS: Record<PermissionName, PermissionPreset> = {
  auto: { name: "auto", summary: "every call is reviewed (hard rules, then a reviewer model); refusals go back to the agent", review: true, tools: undefined, breakerConsecutive: undefined },
  "read-only": { name: "read-only", summary: "reviewed, and the agent only gets the read tool", review: true, tools: ["read"], breakerConsecutive: undefined },
  strict: { name: "strict", summary: "reviewed; three refusals in a row pause the run", review: true, tools: undefined, breakerConsecutive: 3 },
  "full-access": { name: "full-access", summary: "nothing is reviewed", review: false, tools: undefined, breakerConsecutive: undefined },
};

/**
 * What Shift+Tab switches to: auto, then strict, then read-only, then auto again. `full-access` is never reached by the key
 * (it needs the explicit `/permissions full-access`); from it the key goes back to auto.
 */
export function nextPermission(current: PermissionName): PermissionName {
  const cycle: PermissionName[] = ["auto", "strict", "read-only"];
  const index = cycle.indexOf(current);
  return index === -1 ? "auto" : cycle[(index + 1) % cycle.length]!;
}

export function isPermissionName(value: string): value is PermissionName {
  return (PERMISSION_NAMES as readonly string[]).includes(value);
}

export interface GuardOptions {
  permissions: PermissionName;
  redaction: boolean;
  /** The model that judges calls when review is on. */
  reviewLlm: LlmClient;
}

export interface Guards {
  /** Plugins to add after the core plugins. */
  plugins: Plugin[];
  /** The model client the reviewer should use (wrapped by redaction when that is on). */
  tools: PermissionPreset["tools"];
}

/**
 * The plugins for a permission preset and the redaction switch. Redaction is added first so that the reviewer's own requests are masked too.
 * Review is on unless the preset is full-access; redaction is off unless asked for.
 */
export function buildGuards(options: GuardOptions): Guards {
  const preset = PERMISSION_PRESETS[options.permissions];
  const plugins: Plugin[] = [];
  const redaction = options.redaction ? redactionPlugin() : undefined;
  if (redaction) plugins.push(redaction);
  if (preset.review) {
    const llm = redaction ? redaction.wrap(options.reviewLlm) : options.reviewLlm;
    plugins.push(reviewPlugin({ llm, directoryRules: false, ...(preset.breakerConsecutive !== undefined ? { breaker: { consecutive: preset.breakerConsecutive } } : {}) }));
  }
  return { plugins, tools: preset.tools };
}

export function describeThinking(level: ThinkingLevel | undefined): string {
  return level ?? "default";
}
