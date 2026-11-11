// What a command line asks for, apart from the settings flags: which mode, which session, which prompt.
import { ConfigError } from "./config.ts";
import { reviewPrompt } from "./slash-commands.ts";

export interface InvocationFlags {
  last?: boolean | undefined;
  resume?: string | undefined;
  base?: string | undefined;
  commit?: string | undefined;
}

export type Invocation =
  | { mode: "providers" }
  | { mode: "sessions" }
  | { mode: "acp" }
  | { mode: "exec"; prompt: string; resume: string | undefined }
  /** The interactive session. `slash` is typed for the user at the start (the resume picker, /fork). */
  | { mode: "tui"; prompt: string; resume: string | undefined; slash: string | undefined };

export function parseInvocation(positionals: string[], flags: InvocationFlags): Invocation {
  const [command, ...rest] = positionals;
  const last = flags.last ? "last" : undefined;
  switch (command) {
    case "providers":
    case "sessions":
      return command === "providers" ? { mode: "providers" } : { mode: "sessions" };
    case "acp":
      return { mode: "acp" };
    case "exec": {
      if (rest[0] === "resume") {
        const reference = last ?? rest[1];
        if (reference === undefined) throw new ConfigError("exec resume needs a session id or --last");
        return { mode: "exec", resume: reference, prompt: rest.slice(last ? 1 : 2).join(" ") };
      }
      return { mode: "exec", resume: last ?? flags.resume, prompt: rest.join(" ") };
    }
    case "review":
      if ([flags.base, flags.commit].filter(Boolean).length > 1) throw new ConfigError("--base and --commit cannot be used together");
      return { mode: "exec", resume: undefined, prompt: reviewPrompt({ base: flags.base, commit: flags.commit, focus: rest.join(" ") }) };
    case "resume": {
      const reference = last ?? rest[0];
      if (reference === undefined) return { mode: "tui", resume: undefined, prompt: "", slash: "/resume" };
      return { mode: "tui", resume: reference, prompt: rest.slice(last ? 0 : 1).join(" "), slash: undefined };
    }
    case "fork": {
      const reference = last ?? rest[0];
      if (reference === undefined) throw new ConfigError("fork needs a session id or --last");
      return { mode: "tui", resume: reference, prompt: "", slash: "/fork" };
    }
    default:
      return { mode: "tui", resume: last ?? flags.resume, prompt: positionals.join(" "), slash: undefined };
  }
}
