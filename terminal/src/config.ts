// The config file and how settings are resolved: defaults < file < profile < environment < command-line flags.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPermissionName } from "./permissions.ts";
import type { PermissionName } from "./permissions.ts";
import { parseToml } from "./toml.ts";
import type { TomlTable, TomlValue } from "./toml.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Thinking = "off" | "low" | "medium" | "high";
const THINKING: readonly string[] = ["off", "low", "medium", "high"];

/** A model provider that speaks chat completions. Built-in ones live in providers.ts; users can add more in the file. */
export interface ProviderDefinition {
  baseUrl: string;
  model: string;
  keyEnv: string;
  contextWindow: number;
  /** Name of a framework compat preset (for example "deepseek"). */
  compat?: string;
  /** Header sent with every request. */
  headers?: Record<string, string>;
  /** Header whose value is the session id (OpenCode Go requires one). */
  sessionHeader?: string;
}

export interface McpServerDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** The values a profile, the file or a flag may set. All optional. */
export interface SettingsLayer {
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: Thinking | undefined;
  permissions?: PermissionName | undefined;
  redaction?: boolean | undefined;
  maxTokens?: number | undefined;
}

export interface FileConfig extends SettingsLayer {
  profiles: Record<string, SettingsLayer>;
  providers: Record<string, ProviderDefinition>;
  mcpServers: Record<string, McpServerDefinition>;
}

export interface Settings {
  /** Chosen by the user; undefined means "the first built-in provider whose key is set". */
  provider: string | undefined;
  model: string | undefined;
  thinking: Thinking | undefined;
  permissions: PermissionName;
  redaction: boolean;
  maxTokens: number | undefined;
  providers: Record<string, ProviderDefinition>;
  mcpServers: Record<string, McpServerDefinition>;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: undefined,
  model: undefined,
  thinking: undefined,
  permissions: "auto",
  redaction: false,
  maxTokens: undefined,
  providers: {},
  mcpServers: {},
};

export const emptyFileConfig = (): FileConfig => ({ profiles: {}, providers: {}, mcpServers: {} });

export function configDirectory(env: Record<string, string | undefined>, home: string): string {
  return env.SAKURA_HOME ?? join(home, ".sakura");
}

export function readConfigFile(path: string): FileConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileConfig();
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  return parseConfig(text, path);
}

export function parseConfig(text: string, label = "config"): FileConfig {
  let table: TomlTable;
  try {
    table = parseToml(text);
  } catch (error) {
    throw new ConfigError(`${label}: ${(error as Error).message}`);
  }
  const { profiles, providers, mcp, ...top } = table;
  const config: FileConfig = { ...readLayer(top, label), profiles: {}, providers: {}, mcpServers: {} };
  for (const [name, value] of Object.entries(asTable(profiles, "profiles", label))) config.profiles[name] = readLayer(asTable(value, `profiles.${name}`, label), `${label} profile ${name}`);
  for (const [name, value] of Object.entries(asTable(providers, "providers", label))) config.providers[name] = readProvider(asTable(value, `providers.${name}`, label), name, label);
  const servers = asTable(asTable(mcp, "mcp", label).servers, "mcp.servers", label);
  for (const [name, value] of Object.entries(servers)) config.mcpServers[name] = readMcpServer(asTable(value, `mcp.servers.${name}`, label), name, label);
  return config;
}

function asTable(value: TomlValue | undefined, name: string, label: string): TomlTable {
  if (value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${label}: ${name} must be a table`);
  return value;
}

const LAYER_KEYS = new Set(["provider", "model", "thinking", "permissions", "redaction", "max_tokens"]);

function readLayer(table: TomlTable, label: string): SettingsLayer {
  for (const key of Object.keys(table)) if (!LAYER_KEYS.has(key)) throw new ConfigError(`${label}: unknown setting "${key}"`);
  const layer: SettingsLayer = {};
  if (table.provider !== undefined) layer.provider = text(table.provider, "provider", label);
  if (table.model !== undefined) layer.model = text(table.model, "model", label);
  if (table.thinking !== undefined) {
    const value = text(table.thinking, "thinking", label);
    if (!THINKING.includes(value)) throw new ConfigError(`${label}: thinking must be one of ${THINKING.join(", ")}`);
    layer.thinking = value as Thinking;
  }
  if (table.permissions !== undefined) {
    const value = text(table.permissions, "permissions", label);
    if (!isPermissionName(value)) throw new ConfigError(`${label}: unknown permissions preset "${value}"`);
    layer.permissions = value;
  }
  if (table.redaction !== undefined) {
    if (typeof table.redaction !== "boolean") throw new ConfigError(`${label}: redaction must be true or false`);
    layer.redaction = table.redaction;
  }
  if (table.max_tokens !== undefined) layer.maxTokens = positive(table.max_tokens, "max_tokens", label);
  return layer;
}

const text = (value: TomlValue, name: string, label: string): string => {
  if (typeof value !== "string" || value === "") throw new ConfigError(`${label}: ${name} must be a non-empty string`);
  return value;
};

const positive = (value: TomlValue, name: string, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`${label}: ${name} must be a positive integer`);
  return value;
};

function stringMap(value: TomlValue | undefined, name: string, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(asTable(value, name, label)).map(([key, inner]) => [key, text(inner, `${name}.${key}`, label)]));
}

function readProvider(table: TomlTable, name: string, label: string): ProviderDefinition {
  const where = `${label}: providers.${name}`;
  for (const required of ["base_url", "model", "key_env"]) if (table[required] === undefined) throw new ConfigError(`${where} needs ${required}`);
  const known = new Set(["base_url", "model", "key_env", "context_window", "compat", "headers", "session_header"]);
  for (const key of Object.keys(table)) if (!known.has(key)) throw new ConfigError(`${where}: unknown setting "${key}"`);
  const headers = stringMap(table.headers, "headers", where);
  return {
    baseUrl: text(table.base_url!, "base_url", where),
    model: text(table.model!, "model", where),
    keyEnv: text(table.key_env!, "key_env", where),
    contextWindow: table.context_window === undefined ? 128_000 : positive(table.context_window, "context_window", where),
    ...(table.compat !== undefined ? { compat: text(table.compat, "compat", where) } : {}),
    ...(headers ? { headers } : {}),
    ...(table.session_header !== undefined ? { sessionHeader: text(table.session_header, "session_header", where) } : {}),
  };
}

function readMcpServer(table: TomlTable, name: string, label: string): McpServerDefinition {
  const where = `${label}: mcp.servers.${name}`;
  if (table.command === undefined) throw new ConfigError(`${where} needs command`);
  const args = table.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== "string"))) throw new ConfigError(`${where}: args must be a list of strings`);
  const env = stringMap(table.env, "env", where);
  return { command: text(table.command, "command", where), ...(args ? { args: args as string[] } : {}), ...(env ? { env } : {}) };
}

export interface ResolveInput {
  file: FileConfig;
  profile?: string | undefined;
  env: Record<string, string | undefined>;
  /** Values from command-line flags; they win over everything. */
  flags?: SettingsLayer;
}

/** The environment variables that can set a layer (SAKURA_PROVIDER, SAKURA_MODEL). */
export function environmentLayer(env: Record<string, string | undefined>): SettingsLayer {
  return { ...(env.SAKURA_PROVIDER ? { provider: env.SAKURA_PROVIDER } : {}), ...(env.SAKURA_MODEL ? { model: env.SAKURA_MODEL } : {}) };
}

export function resolveSettings(input: ResolveInput): Settings {
  const profileName = input.profile ?? undefined;
  const profile = profileName === undefined ? {} : input.file.profiles[profileName];
  if (profile === undefined) throw new ConfigError(`unknown profile "${profileName}" (profiles: ${Object.keys(input.file.profiles).join(", ") || "none"})`);
  const { profiles: _profiles, providers: _providers, mcpServers: _mcp, ...fileLayer } = input.file;
  const layers: SettingsLayer[] = [fileLayer, profile, environmentLayer(input.env), input.flags ?? {}];
  const merged: SettingsLayer = Object.assign({}, ...layers.map(definedOnly));
  return {
    ...DEFAULT_SETTINGS,
    provider: merged.provider,
    model: merged.model,
    thinking: merged.thinking,
    permissions: merged.permissions ?? DEFAULT_SETTINGS.permissions,
    redaction: merged.redaction ?? DEFAULT_SETTINGS.redaction,
    maxTokens: merged.maxTokens,
    providers: input.file.providers,
    mcpServers: input.file.mcpServers,
  };
}

const definedOnly = (layer: SettingsLayer): SettingsLayer => Object.fromEntries(Object.entries(layer).filter(([, value]) => value !== undefined));
