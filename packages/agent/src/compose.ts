import type { Plugin, PluginApi, PrepareContext } from "@sakura/kernel";

/** A plugin that may say what it needs and what it offers. The kernel ignores the two extra fields. */
export interface Composable extends Plugin {
  /** Names (of plugins or of capabilities that plugins provide) that must be installed before this one. */
  requires?: string[];
  /** Capability names this plugin offers besides its own name, so others can depend on "what" rather than "who". */
  provides?: string[];
  /** Set by bundle(): lets compose() see through the bundle to the plugins inside it. */
  children?: Plugin[];
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/**
 * One plugin made of several: installing it installs them all, in the order given. All three entry points are passed on
 * (setup, prepare, afterCompaction); passing on only setup would silently drop the other two. Bundles may contain bundles.
 * Give a bundle to createAgent (or to compose) and a plugin that is in two bundles is installed once.
 */
export function bundle(name: string, children: Plugin[]): Composable {
  const compensates = children.flatMap((child) => (child.compensates ? [child.compensates] : []));
  const withPrepare = children.filter((child) => child.prepare);
  const withAfter = children.filter((child) => child.afterCompaction);
  return {
    name,
    children,
    ...(compensates.length > 0 ? { compensates: compensates.join("; ") } : {}),
    requires: unique(children.flatMap((child) => (child as Composable).requires ?? [])),
    provides: unique(children.flatMap((child) => [child.name, ...((child as Composable).provides ?? [])])),
    setup(api: PluginApi) {
      for (const child of children) child.setup(api);
    },
    ...(withPrepare.length > 0
      ? {
          async prepare(context: PrepareContext) {
            for (const child of withPrepare) await child.prepare?.(context);
          },
        }
      : {}),
    ...(withAfter.length > 0
      ? {
          async afterCompaction(context: PrepareContext) {
            for (const child of withAfter) await child.afterCompaction?.(context);
          },
        }
      : {}),
  };
}

export class CompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionError";
  }
}

/**
 * Turns a list of plugins that may contain and depend on each other into the flat, ordered list the kernel wants: bundles opened up,
 * each plugin once, every plugin after the ones it requires. Throws before anything runs when a requirement is missing, the requirements
 * form a cycle, or two different plugins share a name. Plugins keep the order they were listed in unless a requirement says otherwise.
 */
export function compose(listed: Plugin[]): Plugin[] {
  const providers = new Map<string, Set<string>>(); // capability -> names of the plugins that offer it
  const byName = new Map<string, Composable>();

  const open = (plugin: Composable, groups: string[]): void => {
    if (plugin.children) {
      for (const child of plugin.children) open(child as Composable, [...groups, plugin.name]);
      return;
    }
    const known = byName.get(plugin.name);
    if (known && known !== plugin) throw new CompositionError(`two different plugins are named '${plugin.name}'`);
    byName.set(plugin.name, plugin);
    for (const capability of [plugin.name, ...(plugin.provides ?? []), ...groups]) providers.set(capability, (providers.get(capability) ?? new Set()).add(plugin.name));
  };
  for (const plugin of listed) open(plugin as Composable, []);

  const ordered: Plugin[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") throw new CompositionError(`dependency cycle: ${[...path, name].join(" -> ")}`);
    state.set(name, "visiting");
    const plugin = byName.get(name) as Composable;
    for (const need of plugin.requires ?? []) {
      const offered = providers.get(need);
      if (!offered) throw new CompositionError(`plugin '${name}' requires '${need}', which nothing provides`);
      for (const provider of offered) if (provider !== name) visit(provider, [...path, name]);
    }
    state.set(name, "done");
    ordered.push(plugin);
  };
  for (const name of byName.keys()) visit(name, []);
  return ordered;
}
