// Framework events to ACP updates, as a pure state machine. It decides message ids: ACP groups chunks by `messageId`, and cannot
// take chunks back, so a reply that is sent again after a dropped connection gets a new id and the text already sent stays.
import { randomUUID } from "node:crypto";
import type { Event } from "../framework.ts";
import type { AcpUpdate } from "./types.ts";

export interface UpdateMapper {
  /** The updates for one event, in order; usually none or one. Never throws. */
  push(event: Event): AcpUpdate[];
}

export function createUpdateMapper(newId: () => string = randomUUID): UpdateMapper {
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
        case "message_end":
          startAgain();
          return [];
        default:
          return [];
      }
    },
  };
}
