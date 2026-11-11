// The selectors the client shows for a session: which model (one entry per configured provider), how much the model thinks and
// the review mode (the permission presets). Pure: it turns a list of providers and the current choice into ACP config options, and a client's change into
// the next choice.
import { PERMISSION_PRESETS } from "../permissions.ts";
import type { PermissionName } from "../permissions.ts";
import { AcpError, ErrorCode } from "./types.ts";
import type { ConfigOption } from "./types.ts";

export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_THINKING: ThinkingLevel = "medium";

export interface ProviderChoice {
  /** The provider's name in the config file (this is the option value). */
  name: string;
  /** The model the provider uses. */
  model: string;
  keyEnv: string;
  /** Its key is set, so it can be used now. */
  available: boolean;
  /** The model has a reasoning effort to set. */
  thinking: boolean;
}

export interface Choice {
  provider: string;
  thinking: ThinkingLevel | undefined;
  permissions: PermissionName;
}

const LEVEL_NAMES: Record<ThinkingLevel, string> = { off: "Off", low: "Low", medium: "Medium", high: "High" };

export const isThinkingLevel = (value: unknown): value is ThinkingLevel => typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

/** The thinking level that shows for a provider: none when the model has no effort to set. */
export function thinkingFor(provider: ProviderChoice | undefined, wanted: ThinkingLevel | undefined): ThinkingLevel | undefined {
  return provider?.thinking ? (wanted ?? DEFAULT_THINKING) : undefined;
}

/** `modes` are the review modes the client may pick (full-access is only there when the person started the agent with it). */
export function buildConfigOptions(providers: readonly ProviderChoice[], choice: Choice, modes: readonly PermissionName[]): ConfigOption[] {
  const current = providers.find((provider) => provider.name === choice.provider);
  const options: ConfigOption[] = [
    {
      type: "select",
      id: "model",
      name: "Model",
      description: "The provider and model that answer. A provider needs its API key in the environment of the agent.",
      category: "model",
      currentValue: choice.provider,
      options: providers.map((provider) => ({
        value: provider.name,
        name: provider.model,
        description: provider.available ? provider.name : `${provider.name} (set ${provider.keyEnv} to use it)`,
      })),
    },
  ];
  const level = thinkingFor(current, choice.thinking);
  if (level !== undefined) {
    options.push({
      type: "select",
      id: "thought_level",
      name: "Thinking",
      description: "How much the model reasons before it answers.",
      category: "thought_level",
      currentValue: level,
      options: THINKING_LEVELS.map((value) => ({ value, name: LEVEL_NAMES[value] })),
    });
  }
  options.push({
    type: "select",
    id: "mode",
    name: "Review mode",
    description: "What is reviewed before the agent acts. Every call is reviewed in all modes but full-access.",
    category: "mode",
    currentValue: choice.permissions,
    options: modes.map((mode) => ({ value: mode, name: mode, description: PERMISSION_PRESETS[mode].summary })),
  });
  return options;
}

const invalid = (message: string, data?: unknown) => new AcpError(ErrorCode.invalidParams, message, data);

/** The choice after the client set `configId` to `value`; throws the error the client should get when that is not possible. */
export function applyChange(providers: readonly ProviderChoice[], choice: Choice, configId: string, value: unknown, modes: readonly PermissionName[]): Choice {
  if (typeof value !== "string") throw invalid(`The option "${configId}" takes one of its listed values`, { configId });
  if (configId === "model") {
    const target = providers.find((provider) => provider.name === value);
    if (!target) throw invalid(`Unknown model "${value}". Choose one of: ${providers.map((provider) => provider.name).join(", ")}`, { configId, value });
    if (!target.available) throw new AcpError(ErrorCode.authRequired, `${target.name} has no API key. Set ${target.keyEnv} in the environment of this agent, then start a new chat.`, { provider: target.name, keyEnv: target.keyEnv });
    return { ...choice, provider: target.name, thinking: thinkingFor(target, choice.thinking) };
  }
  if (configId === "thought_level") {
    const current = providers.find((provider) => provider.name === choice.provider);
    if (!current?.thinking) throw invalid("This model has no thinking level to set", { configId });
    if (!isThinkingLevel(value)) throw invalid(`Unknown thinking level "${value}". Choose one of: ${THINKING_LEVELS.join(", ")}`, { configId, value });
    return { ...choice, thinking: value };
  }
  if (configId === "mode") {
    const wanted = (modes as readonly string[]).includes(value) ? (value as PermissionName) : undefined;
    if (wanted === undefined) {
      const hint = value === "full-access" ? " Nothing is reviewed in full-access, so it is only available when the agent was started with --permissions full-access." : "";
      throw invalid(`Unknown or unavailable review mode "${value}". Choose one of: ${modes.join(", ")}.${hint}`, { configId, value });
    }
    return { ...choice, permissions: wanted };
  }
  throw invalid(`Unknown option "${configId}"`, { configId });
}
