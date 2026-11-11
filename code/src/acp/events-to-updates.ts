// Framework events to ACP updates, as a pure state machine. It decides message ids: ACP groups chunks by `messageId`, and cannot
// take chunks back, so a reply that is sent again after a dropped connection gets a new id and the text already sent stays.
import { randomUUID } from "node:crypto";
import type { Event } from "../framework.ts";
import { describeCall, describeResult } from "./tool-mapping.ts";
import type { AcpUpdate } from "./types.ts";

/** The updates this mapper makes: chunks of a reply, tool cards and the context meter. */
export type MappedUpdate = Extract<AcpUpdate, { messageId: string } | { sessionUpdate: "tool_call" | "tool_call_update" | "usage_update" }>;
export type ChunkUpdate = MappedUpdate;

export interface MapperOptions {
  /** The session's directory (for the paths in tool cards). */
  cwd: string;
  /** The model's context window in tokens, for `usage_update`; 0 or less leaves the meter out. */
  contextWindow: number;
  /** What a file held before a `write` (see `CallContext.previous`). */
  previous?: (callId: string) => string | null | undefined;
  newId?: () => string;
}

export interface UpdateMapper {
  /** The updates for one event, in order; usually none or one. Never throws. */
  push(event: Event): ChunkUpdate[];
}

export function createUpdateMapper(options: MapperOptions): UpdateMapper {
  const newId = options.newId ?? randomUUID;
  // one id for the text and one for the reasoning of the current reply; both start again after the reply ends or is voided
  let messageId: string | undefined;
  let thoughtId: string | undefined;
  const startAgain = () => {
    messageId = undefined;
    thoughtId = undefined;
  };
  return {
    push(event) {
      switch (event.type) {
        case "message_update": {
          const delta = event.delta;
          if (delta.type !== "text" || delta.text === "") return [];
          messageId ??= newId();
          return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.text }, messageId }];
        }
        case "reasoning_update": {
          if (typeof event.delta !== "string" || event.delta === "") return [];
          thoughtId ??= newId();
          return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta }, messageId: thoughtId }];
        }
        case "message_reset":
          startAgain();
          return [];
        case "message_end": {
          startAgain();
          const usage = event.message.role === "assistant" ? event.message.usage : undefined;
          if (!usage || options.contextWindow <= 0) return [];
          return [{ sessionUpdate: "usage_update", used: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, size: options.contextWindow }];
        }
        case "goal": {
          // the framework says when the check has finished or given up; each is one short note for the person
          const note = event.status === "complete" ? "Goal reached: the check found nothing left to do." : event.status === "blocked" ? "Goal blocked: the remaining items need you to act or decide." : undefined;
          return note === undefined ? [] : [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${note}\n` }, messageId: newId() }];
        }
        case "tool_start": {
          const card = describeCall(event.call, { cwd: options.cwd, previous: options.previous?.(event.call.id) });
          return [{ sessionUpdate: "tool_call", toolCallId: event.call.id, name: event.call.name, title: card.title, kind: card.kind, status: "in_progress", content: card.content, locations: card.locations, rawInput: card.rawInput }];
        }
        case "tool_end": {
          const card = describeResult(event.call, event.result, { cwd: options.cwd, previous: options.previous?.(event.call.id) });
          return [{ sessionUpdate: "tool_call_update", toolCallId: event.call.id, status: card.status, content: card.content, rawOutput: card.rawOutput }];
        }
        default:
          return [];
      }
    },
  };
}
