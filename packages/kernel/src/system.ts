import type { LogEntry, ToolDecl } from "./types.ts";

/** The system prompt and the tool declarations as the log says they are. */
export interface SystemState {
  sections: Record<string, string>;
  tools: ToolDecl[];
}

export interface SystemPatch {
  sections?: Record<string, string | null>;
  toolsAdded?: ToolDecl[];
  toolsRemoved?: string[];
}

const sameDeclaration = (a: ToolDecl, b: ToolDecl): boolean => a.name === b.name && a.description === b.description && JSON.stringify(a.parameters) === JSON.stringify(b.parameters);

/** Replays every system_patch on the current branch, oldest first. */
export function replaySystem(branch: readonly LogEntry[]): SystemState {
  const state: SystemState = { sections: {}, tools: [] };
  for (const entry of branch) {
    if (entry.type !== "system_patch") continue;
    for (const [name, text] of Object.entries(entry.sections ?? {})) {
      if (text === null) delete state.sections[name];
      else state.sections[name] = text;
    }
    for (const name of entry.toolsRemoved ?? []) state.tools = state.tools.filter((tool) => tool.name !== name);
    for (const tool of entry.toolsAdded ?? []) state.tools = [...state.tools.filter((existing) => existing.name !== tool.name), tool];
  }
  return state;
}

/**
 * What has to be written so that replaying gives the system prompt the configuration wants. The tool list only grows:
 * a tool that the configuration no longer has stays declared (so the start of every request stays the same, which keeps
 * the provider's prompt cache); a tool whose declaration changed is removed and added again at the end.
 * Returns undefined when nothing differs.
 */
export function diffSystem(state: SystemState, desired: { system: string; tools: readonly ToolDecl[] }): SystemPatch | undefined {
  const patch: SystemPatch = {};
  if (state.sections.system !== desired.system) patch.sections = { system: desired.system };
  const added: ToolDecl[] = [];
  const removed: string[] = [];
  for (const tool of desired.tools) {
    const existing = state.tools.find((candidate) => candidate.name === tool.name);
    if (!existing) added.push(tool);
    else if (!sameDeclaration(existing, tool)) {
      removed.push(tool.name);
      added.push(tool);
    }
  }
  if (added.length > 0) patch.toolsAdded = added;
  if (removed.length > 0) patch.toolsRemoved = removed;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** The sections joined into the text that is sent as the system prompt. */
export const renderSystem = (state: SystemState): string => Object.values(state.sections).join("\n\n");
