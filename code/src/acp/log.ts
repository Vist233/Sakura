// Logs of the ACP agent: JSON lines on stderr, because stdout belongs to the protocol. The caller passes short facts only;
// prompts, tool output, keys, headers and MCP `env` or `headers` values never go through here.
export type LogLevel = "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  child(module: string): Logger;
}

export type LogFields = Record<string, string | number | boolean | undefined>;

/** `SAKURACODE_ACP_LOG` is off, error, warn (default), info or debug. */
export function logLevelFromEnv(value: string | undefined): LogLevel | "off" {
  const level = value?.trim().toLowerCase();
  if (level === "off" || level === "error" || level === "warn" || level === "info" || level === "debug") return level;
  return "warn";
}

export function createLogger(write: (line: string) => void, level: LogLevel | "off", module = "acp"): Logger {
  const emit = (at: LogLevel, message: string, fields?: LogFields) => {
    if (level === "off" || ORDER[at] > ORDER[level]) return;
    write(`${JSON.stringify({ ts: new Date().toISOString(), level: at, module, message, ...fields })}\n`);
  };
  return {
    error: (message, fields) => emit("error", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    info: (message, fields) => emit("info", message, fields),
    debug: (message, fields) => emit("debug", message, fields),
    child: (name) => createLogger(write, level, name),
  };
}
