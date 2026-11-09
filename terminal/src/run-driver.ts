// Drives one agent run at a time: feeds the framework's events to the transcript and to listeners, and keeps track of the
// messages the user sent while the agent was working (steered ones are delivered before the next model request, queued ones
// when the agent would stop). The framework emits no event when it takes such a message, so delivery is found in the log.
import type { Agent, Event, RunOptions, RunResult, UserInput } from "./framework.ts";
import type { Transcript } from "./transcript.ts";
import { textOf } from "./transcript.ts";

export type PendingKind = "steer" | "queue";

export interface PendingMessage {
  kind: PendingKind;
  text: string;
}

export interface RunDriver {
  readonly working: boolean;
  /** Messages sent during the run that the agent has not taken yet. */
  pending(): readonly PendingMessage[];
  /** Runs to the end. Messages that were never taken are returned in `leftover` for the caller to send as a new run. */
  run(agent: Agent, input: UserInput | undefined, options?: RunOptions): Promise<RunOutcome>;
  steer(text: string): void;
  queue(text: string): void;
  cancel(): void;
  /** Raw framework events, for the JSON output. */
  onEvent(listener: (event: Event) => void): () => void;
  /** Called whenever working/pending changes. */
  onChange(listener: () => void): () => void;
}

export interface RunOutcome {
  result: RunResult;
  leftover: PendingMessage[];
}

export function createRunDriver(transcript: Transcript): RunDriver {
  let working = false;
  let current: { agent: Agent; seen: Set<string> } | undefined;
  let pending: PendingMessage[] = [];
  const eventListeners = new Set<(event: Event) => void>();
  const changeListeners = new Set<() => void>();
  const changed = () => {
    for (const listener of changeListeners) listener();
  };

  /** Moves messages that the log now holds from "pending" to the transcript. */
  async function syncDelivered(): Promise<void> {
    if (!current || pending.length === 0) return;
    const entries = await current.agent.log.branch();
    for (const entry of entries) {
      if (current.seen.has(entry.id)) continue;
      current.seen.add(entry.id);
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const text = textOf(entry.message.content);
      const index = pending.findIndex((item) => item.text === text);
      if (index === -1) continue;
      const [item] = pending.splice(index, 1);
      transcript.add({ kind: "user", text: item!.text });
      transcript.add({ kind: "notice", level: "info", text: item!.kind === "steer" ? "Steering message delivered." : "Queued message delivered." });
    }
    changed();
  }

  return {
    get working() {
      return working;
    },
    pending: () => pending,
    async run(agent, input, options) {
      working = true;
      pending = [];
      const seen = new Set((await agent.log.branch()).map((entry) => entry.id));
      current = { agent, seen };
      changed();
      const handle = agent.run(input, options);
      try {
        for await (const event of handle.events) {
          transcript.apply(event);
          for (const listener of eventListeners) listener(event);
          if (event.type === "turn_start" || event.type === "run_end") await syncDelivered();
        }
        const result = await handle.result;
        await syncDelivered();
        const leftover = pending;
        pending = [];
        return { result, leftover };
      } finally {
        working = false;
        current = undefined;
        changed();
      }
    },
    steer(text) {
      if (!working || !current) return;
      pending.push({ kind: "steer", text });
      current.agent.steer(text);
      changed();
    },
    queue(text) {
      if (!working || !current) return;
      pending.push({ kind: "queue", text });
      current.agent.queue(text);
      changed();
    },
    cancel: () => current?.agent.cancel(),
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  };
}
