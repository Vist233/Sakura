import { FatalHookError } from "./types.ts";
import type { Decision, Event, EventTransform, HookContext, HookName, Hooks, LlmRequest, Message, Plugin, ProviderError, Tool, ToolCall, ToolResult, TurnInfo } from "./types.ts";
import type { PauseReason } from "./types.ts";

interface Registered<K extends HookName> {
  plugin: string;
  handler: Hooks[K];
}

type Registry = { [K in HookName]: Registered<K>[] };
export type ReportFailure = (plugin: string, hook: string, error: unknown) => void;

export interface TurnEndOutcome {
  append: Message[];
  pause: PauseReason | undefined;
}

/**
 * Holds the handlers that plugins registered. Handlers run in plugin order. A handler that throws
 * is reported and skipped, except in tool.before, where a failure denies the call.
 */
export interface HookSet {
  tools: Tool[];
  context(messages: Message[]): Message[];
  request(request: LlmRequest): { request: LlmRequest; transforms: EventTransform[] };
  toolBefore(call: ToolCall, context: HookContext): Promise<{ decision: Decision; args: unknown }>;
  toolRun(call: ToolCall, base: () => Promise<ToolResult>): Promise<ToolResult>;
  toolAfter(call: ToolCall, result: ToolResult): ToolResult;
  turnEnd(turn: TurnInfo): TurnEndOutcome;
  error(error: ProviderError): PauseReason | undefined;
  event(event: Event): void;
}

export function createHookSet(plugins: readonly Plugin[], builtinTools: readonly Tool[], report: ReportFailure, emitFromPlugin: (plugin: string, data: unknown) => void): HookSet {
  const registry: Registry = {
    context: [],
    request: [],
    "tool.before": [],
    "tool.run": [],
    "tool.after": [],
    "turn.end": [],
    error: [],
    event: [],
  };
  const tools = [...builtinTools];

  for (const plugin of plugins) {
    plugin.setup({
      on(hook, handler) {
        (registry[hook] as Registered<typeof hook>[]).push({ plugin: plugin.name, handler });
      },
      registerTool(tool) {
        if (tools.some((existing) => existing.name === tool.name)) {
          throw new Error(`plugin '${plugin.name}' registers a tool that already exists: ${tool.name}`);
        }
        tools.push(tool);
      },
      emit(data) {
        emitFromPlugin(plugin.name, data);
      },
    });
  }

  function guarded<K extends HookName, R>(hook: K, call: (handler: Hooks[K]) => R | undefined, onItem: (value: R) => void): void {
    for (const { plugin, handler } of registry[hook] as Registered<K>[]) {
      try {
        const value = call(handler);
        if (value !== undefined) onItem(value);
      } catch (error) {
        if (error instanceof FatalHookError) throw error;
        report(plugin, hook, error);
      }
    }
  }

  return {
    tools,
    context(messages) {
      let current = messages;
      guarded(
        "context",
        (handler) => handler({ messages: current }) as Message[] | undefined,
        (next) => (current = next),
      );
      return current;
    },
    request(request) {
      let current = request;
      const transforms: EventTransform[] = [];
      guarded(
        "request",
        (handler) => handler(current) as ReturnType<Hooks["request"]>,
        (next) => {
          if (next === undefined) return;
          if ("request" in next) {
            current = next.request;
            if (next.transform) transforms.push(next.transform);
          } else current = next;
        },
      );
      return { request: current, transforms };
    },
    async toolBefore(call, context) {
      let args = call.args;
      for (const { plugin, handler } of registry["tool.before"]) {
        try {
          const decision = await handler({ ...call, args }, context);
          if (!decision || decision.kind === "allow") continue;
          if (decision.kind === "deny") return { decision, args };
          args = decision.args;
        } catch (error) {
          report(plugin, "tool.before", error);
          return { decision: { kind: "deny", reason: `The check by '${plugin}' failed, so the call was not allowed.` }, args };
        }
      }
      return { decision: { kind: "allow" }, args };
    },
    toolRun(call, base) {
      // The first registered handler is the outermost wrapper.
      const chain = registry["tool.run"].reduceRight<() => Promise<ToolResult>>(
        (next, { plugin, handler }) =>
          async () => {
            try {
              return await handler(call, next);
            } catch (error) {
              report(plugin, "tool.run", error);
              return next();
            }
          },
        base,
      );
      return chain();
    },
    toolAfter(call, result) {
      let current = result;
      guarded(
        "tool.after",
        (handler) => handler(call, current) as ToolResult | undefined,
        (next) => (current = next),
      );
      return current;
    },
    turnEnd(turn) {
      const outcome: TurnEndOutcome = { append: [], pause: undefined };
      guarded(
        "turn.end",
        (handler) => handler(turn) as ReturnType<Hooks["turn.end"]>,
        (result) => {
          if (!result) return;
          outcome.append.push(...(result.append ?? []));
          if (result.pause) outcome.pause ??= result.pause;
        },
      );
      return outcome;
    },
    error(error) {
      let pause: PauseReason | undefined;
      guarded(
        "error",
        (handler) => handler(error) as ReturnType<Hooks["error"]>,
        (result) => {
          if (result?.pause) pause ??= result.pause;
        },
      );
      return pause;
    },
    event(event) {
      for (const { plugin, handler } of registry.event) {
        try {
          handler(event);
        } catch (error) {
          report(plugin, "event", error);
        }
      }
    },
  };
}
