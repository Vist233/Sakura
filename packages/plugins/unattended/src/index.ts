import type { Log, Plugin } from "@sakura/kernel";

/** What the plugin needs from the limits plugin: a way to set the time. A structural type, because plugins do not import each other. */
export interface TimeLimited {
  update(budget: { maxRunSeconds: number }): void;
}

export interface UnattendedOptions {
  /** The time the whole task may take, in seconds. The run is stopped at this time minus the margin, so that there is still time to answer. Needs `limits`. */
  timeLimitSeconds?: number;
  /** Seconds kept free at the end for the final answer (default 60, and at most a fifth of the time limit). */
  marginSeconds?: number;
  /** The limits plugin of the agent. It gets the time limit; it also tells the model how much time is left. */
  limits?: TimeLimited;
  /** Replaces the rules the model is given. */
  rules?: string;
}

export const UNATTENDED_RULES = `You are running unattended: nobody is here to answer questions, approve a plan or fix a mistake for you.
- Do not stop at a plan and do not ask questions. Decide, act, and say in your final answer which assumptions you made.
- Keep working until the task is complete or the time is used up. The limits are shown to you; when you are told to finish, finish.
- Do not say you are done without evidence. Before you stop, list every requirement of the task and check each one with a command: run the program, run the tests, read the file back.
- When something fails, find the cause and fix it. Do not repeat a command that already failed in the same way.
- End with a short report: what you did, what you checked and how, and what is left.`;

const CUSTOM_TYPE = "unattended_rules";

/** The seconds a run may last so that a task limit is still met with time to answer. */
export function runSecondsFor(timeLimitSeconds: number, marginSeconds = 60): number {
  return Math.max(1, timeLimitSeconds - Math.min(marginSeconds, timeLimitSeconds * 0.2));
}

/**
 * The goal for a task that is done with nobody to ask. The kernel checks a goal before the run may end: the model lists the requirements of the
 * task and says for each whether it is done and how it knows (`verify`, a command that must succeed, can be added). Give it to `createAgent({ goal })`.
 */
export function unattendedGoal(task: string, verify?: string): { objective: string; verify?: string } {
  return {
    objective: `Complete this task:\n\n${task.trim()}\n\nIt is complete only when every requirement in it holds and you have checked each one with a command.`,
    ...(verify !== undefined ? { verify } : {}),
  };
}

const hasRules = async (log: Log): Promise<boolean> => (await log.branch()).some((entry) => entry.type === "custom_message" && entry.customType === CUSTOM_TYPE);

/**
 * What is specific to working with nobody to ask: the rules (put into the conversation once, pinned, so that they survive compaction) and the time limit
 * handed to the limits plugin. The final check of the result is the kernel's goal check; see `unattendedGoal`.
 */
export function unattendedPlugin(options: UnattendedOptions = {}): Plugin {
  const rules = options.rules ?? UNATTENDED_RULES;
  return {
    name: "unattended",
    compensates: "models stop at a plan, ask questions nobody answers and say they are done without checking",
    setup() {
      if (options.timeLimitSeconds !== undefined) options.limits?.update({ maxRunSeconds: runSecondsFor(options.timeLimitSeconds, options.marginSeconds) });
    },
    async prepare({ log }) {
      if (await hasRules(log)) return;
      await log.append({ type: "custom_message", customType: CUSTOM_TYPE, pinned: true, content: [{ type: "text", text: rules }] });
    },
  };
}
