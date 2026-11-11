// "Is there a provider to talk to?" Keys come from the environment of the agent process (or the config file) exactly as in the
// terminal application. The check reads whether a variable is set, never its value.
import type { Settings } from "../config.ts";
import { chooseProvider, listProviders, ProviderSetupError } from "../providers.ts";
import { AcpError, ErrorCode } from "./types.ts";

type Environment = Record<string, string | undefined>;

/** The provider to use, or the `auth_required` error with an instruction when there is none or its key is missing. */
export function providerFor(settings: Settings, env: Environment): string {
  let name: string;
  try {
    name = chooseProvider(settings, env);
  } catch (error) {
    if (!(error instanceof ProviderSetupError)) throw error;
    throw new AcpError(ErrorCode.authRequired, `${error.message}. Set the key in the environment of this agent (in T3 Code: the environment overrides of the ACP command), then start a new chat.`);
  }
  const entry = listProviders(settings, env).find((item) => item.name === name);
  if (entry && !entry.keyPresent) {
    throw new AcpError(
      ErrorCode.authRequired,
      `No API key for provider "${name}". Set ${entry.definition.keyEnv} in the environment of this agent (in T3 Code: the environment overrides of the ACP command), then start a new chat.`,
      { provider: name, keyEnv: entry.definition.keyEnv },
    );
  }
  return name;
}
