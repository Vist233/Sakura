// Drives one agent run at a time: feeds the framework's events to the transcript and to listeners, and keeps track of the
// messages the user sent while the agent was working (steered ones are delivered before the next model request, queued ones
// when the agent would stop).
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
  let current: { agent: Agent } | undefined;
  let pending: PendingMessage[] = [];
  const eventListeners = new Set<(event: Event) => void>();
  const changeListeners = new Set<() => void>();
  const changed = () => {
    for (const listener of changeListeners) listener();
  };

  /** The kernel announces a steered or queued message with a user `message_end` when it takes it. */
  function delivered(event: Event): void {
    if (event.type !== "message_end" || event.message.role !== "user") return;
    const text = textOf(event.message.content);
    const index = pending.findIndex((item) => item.text === text);
    if (index !== -1) {
      pending.splice(index, 1);
      changed();
    }
  }

  return {
    get working() {
      return working;
    },
    pending: () => pending,
    async run(agent, input, options) {
      working = true;
      pending = [];
      current = { agent };
      changed();
      const handle = agent.run(input, options);
      try {
        for await (const event of handle.events) {
          transcript.apply(event);
          for (const listener of eventListeners) listener(event);
          delivered(event);
        }
        const result = await handle.result;
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
