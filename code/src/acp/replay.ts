// A session log as the updates that rebuild the conversation for `session/load`. It runs the same mapper as a live run (assistant
// text, tool cards), so a loaded conversation looks like the one that was streamed; user messages have no live counterpart and
// become `user_message_chunk`. Pure. Message ids are the log entry ids, so loading twice gives the same ids.
import type { LogEntry, ToolCall } from "../framework.ts";
import { createUpdateMapper } from "./events-to-updates.ts";
import type { AcpUpdate } from "./types.ts";

export function replayUpdates(entries: readonly LogEntry[], options: { cwd: string }): AcpUpdate[] {
  const out: AcpUpdate[] = [];
  let current = "";
  const mapper = createUpdateMapper({ cwd: options.cwd, contextWindow: 0, newId: () => current });
  const calls = new Map<string, ToolCall>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    current = entry.id;
    if (message.role === "user") {
      const text = message.content.map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[image]" : "")).filter((part) => part !== "").join("\n\n");
      if (text !== "") out.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, messageId: entry.id });
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") out.push(...mapper.push({ type: "message_update", delta: part }));
        else if (part.type === "tool_call") calls.set(part.id, { id: part.id, name: part.name, args: part.args });
      }
      const { usage: _reported, ...withoutUsage } = message;
      out.push(...mapper.push({ type: "message_end", message: withoutUsage }));
      for (const part of message.content) if (part.type === "tool_call") out.push(...mapper.push({ type: "tool_start", call: { id: part.id, name: part.name, args: part.args } }));
    } else if (message.role === "tool" && message.toolCallId) {
      const call = calls.get(message.toolCallId) ?? { id: message.toolCallId, name: message.toolName ?? "tool", args: {} };
      out.push(...mapper.push({ type: "tool_end", call, result: { content: message.content, ...(message.isError ? { isError: true } : {}) } }));
    }
  }
  return out;
}
