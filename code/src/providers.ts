// Model providers: the built-in ones, the ones from the config file, and turning a choice into the framework's ModelConfig.
import { compatPresets } from "./framework.ts";
import type { ModelConfig } from "./framework.ts";
import type { ProviderDefinition, Settings } from "./config.ts";

export class ProviderSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSetupError";
  }
}

/** Chat Completions providers that are known to work. The order is the order tried when the user chose none. */
export const BUILTIN_PROVIDERS: Record<string, ProviderDefinition> = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", keyEnv: "DEEPSEEK_API_KEY", contextWindow: 128_000, compat: "deepseek", images: true },
  // OpenCode Go refuses a request without a session id (error MissingSessionID); the id is the terminal session's id.
  opencode: { baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4.1-flash", keyEnv: "OPENCODE_API_KEY", contextWindow: 128_000, compat: "deepseek", images: true, sessionHeader: "x-opencode-session" },
};

export interface ProviderListing {
  name: string;
  definition: ProviderDefinition;
  /** Whether the key variable is set. The value is never read into a listing. */
  keyPresent: boolean;
  builtin: boolean;
}

type Environment = Record<string, string | undefined>;

export function allProviders(settings: Pick<Settings, "providers">): Record<string, ProviderDefinition> {
  return { ...BUILTIN_PROVIDERS, ...settings.providers };
}

export function listProviders(settings: Pick<Settings, "providers">, env: Environment): ProviderListing[] {
  return Object.entries(allProviders(settings)).map(([name, definition]) => ({ name, definition, keyPresent: Boolean(env[definition.keyEnv]), builtin: name in BUILTIN_PROVIDERS && !(name in settings.providers) }));
}

/** The provider to use: the one the user chose, else the first one whose key is set. */
export function chooseProvider(settings: Pick<Settings, "provider" | "providers">, env: Environment): string {
  const all = allProviders(settings);
  if (settings.provider !== undefined) {
    if (!(settings.provider in all)) throw new ProviderSetupError(`unknown provider "${settings.provider}" (known: ${Object.keys(all).join(", ")})`);
    return settings.provider;
  }
  const withKey = listProviders(settings, env).find((entry) => entry.keyPresent);
  if (!withKey) {
    const needed = Object.values(all).map((definition) => definition.keyEnv);
    throw new ProviderSetupError(`no API key found; set one of: ${needed.join(", ")} (\`sakuracode providers\` shows what is set)`);
  }
  return withKey.name;
}

export interface ModelRequest {
  settings: Pick<Settings, "providers">;
  provider: string;
  /** Overrides the provider's default model. */
  model?: string | undefined;
  /** Goes into the session header when the provider wants one. */
  sessionId: string;
  env: Environment;
}

export function buildModelConfig(request: ModelRequest): ModelConfig {
  const definition = allProviders(request.settings)[request.provider];
  if (!definition) throw new ProviderSetupError(`unknown provider "${request.provider}"`);
  const apiKey = request.env[definition.keyEnv];
  if (!apiKey) throw new ProviderSetupError(`provider "${request.provider}" needs the environment variable ${definition.keyEnv}`);
  const compat = definition.compat === undefined ? undefined : (compatPresets as Record<string, NonNullable<ModelConfig["compat"]>>)[definition.compat];
  if (definition.compat !== undefined && !compat) throw new ProviderSetupError(`provider "${request.provider}": unknown compat preset "${definition.compat}" (known: ${Object.keys(compatPresets).join(", ")})`);
  const headers = { ...definition.headers, ...(definition.sessionHeader ? { [definition.sessionHeader]: request.sessionId } : {}) };
  const withImages = compat || definition.images ? { ...compat, ...(definition.images ? { images: true } : {}) } : undefined;
  return {
    baseUrl: definition.baseUrl,
    apiKey,
    model: request.model ?? definition.model,
    contextWindow: definition.contextWindow,
    ...(withImages ? { compat: withImages } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}
