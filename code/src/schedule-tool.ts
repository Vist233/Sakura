// The tool the agent uses to wake itself later: `schedule_wakeup`. A framework plugin on top of a scheduler (see schedule.ts).
import type { Plugin } from "./framework.ts";
import { clockTime } from "./schedule.ts";
import type { Scheduler } from "./schedule.ts";

export const WAKEUP_TOOL = "schedule_wakeup";

const DESCRIPTION =
  "Wake yourself up later in this session. Use it when you wait for something (a build, a deploy, a long job) and want to look again, " +
  "or to carry on with a long task after a pause. `reason` is what you will be told when you wake up, so write what to do then. " +
  "`minutes` is 1 to 60 (other values are clamped). Only one wake-up is pending: a new call replaces the earlier one. " +
  "It only works while the session stays open.";

export function schedulePlugin(scheduler: Scheduler): Plugin {
  return {
    name: "schedule",
    setup(api) {
      if (!scheduler.wakeupAvailable) return;
      api.registerTool({
        name: WAKEUP_TOOL,
        description: DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            minutes: { type: "number", description: "Minutes from now, 1 to 60." },
            reason: { type: "string", description: "What to do when you wake up." },
          },
          required: ["minutes", "reason"],
        },
        // it only moves the session's own timer, so there is nothing to review; the turn it starts is reviewed like any other
        effect: "read",
        executionMode: "serial",
        async execute(args) {
          const { minutes, reason } = (args ?? {}) as { minutes?: unknown; reason?: unknown };
          const result = scheduler.wakeup(typeof minutes === "number" ? minutes : Number(minutes), typeof reason === "string" ? reason : "");
          if ("error" in result) return { content: [{ type: "text", text: result.error }], isError: true };
          const note = result.minutes !== Number(minutes) ? ` (the time was changed to ${result.minutes}; the allowed range is 1 to 60)` : "";
          return { content: [{ type: "text", text: `You will be woken at ${clockTime(result.job.nextAt)}, in ${result.minutes} minutes${note}.${result.replaced ? " The earlier wake-up was replaced." : ""} Stop now if there is nothing else to do.` }] };
        },
      });
    },
  };
}
