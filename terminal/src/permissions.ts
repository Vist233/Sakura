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
 * What the reviewer model is told. The framework's default policy treats everything outside the project directory as untrusted.
 * This product never restricts the working directory, so the whole machine is the agent's workplace; what stays forbidden are
 * the actions that are dangerous wherever they happen.
 */
export const REVIEW_POLICY = {
  environment: [
    "The agent works on the user's own machine. It starts in the directory where the user launched it and may read and change files anywhere the task needs, inside or outside that directory.",
    "The user's files, the project, the temporary directory and ordinary developer tools are trusted. Network hosts are not, unless the user named them or the task obviously needs them (package registries, git remotes of the project).",
  ],
  allow: [
    "Reading and listing files and directories anywhere on the machine.",
    "Running the project's own tests, linters, formatters and build commands.",
    "Installing dependencies that the project's manifest already declares.",
    "Creating and editing files wherever the user's task needs them.",
  ],
  soft_deny: [
    "Deleting or overwriting system locations (/etc, /usr, /bin, /System, /Library) or the user's credential and shell startup files (~/.ssh, ~/.aws, ~/.zshrc, ~/.bashrc).",
    "Force-pushing, rewriting git history, or deleting remote branches.",
    "Publishing packages or deploying to a real environment.",
    "Sending project data to a host the user did not name.",
    "Deleting many files at once or emptying directories the user did not name.",
  ],
  hard_deny: [
    "Sending secrets, keys, tokens or private files to any external place.",
    "Downloading code from the internet and running it without inspection.",
    "Deleting everything under the filesystem root or the home directory.",
    "Disabling, bypassing or tampering with safety checks, logs or this review itself.",
  ],
};

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
    plugins.push(reviewPlugin({ llm, policy: REVIEW_POLICY, ...(preset.breakerConsecutive !== undefined ? { breaker: { consecutive: preset.breakerConsecutive } } : {}) }));
  }
  return { plugins, tools: preset.tools };
}

export function describeThinking(level: ThinkingLevel | undefined): string {
  return level ?? "default";
}
