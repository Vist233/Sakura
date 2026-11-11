// Starting the agent: wires the registry, the agent and the connection together and handles the process lifecycle.
import { Readable, Writable } from "node:stream";
import type { AgentSessionFactory } from "../agent-session.ts";
import { openAgentSession } from "../agent-session.ts";
import type { Settings } from "../config.ts";
import type { LlmClient } from "../framework.ts";
import type { PermissionName } from "../permissions.ts";
import type { SessionStore } from "../session-store.ts";
import { createAcpAgent } from "./agent.ts";
import { connect } from "./connection.ts";
import type { Streams } from "./connection.ts";
import { createLogger, logLevelFromEnv } from "./log.ts";
import type { Logger } from "./log.ts";
import { createSessions } from "./sessions.ts";

export interface AcpOptions {
  settings: Settings;
  store: SessionStore;
  env: Record<string, string | undefined>;
  version: string;
  /** Review mode of new sessions. */
  permissions: PermissionName;
  /** The client may pick `full-access`: only when it was asked for on the command line. */
  allowFullAccess?: boolean;
  streams: Streams;
  log: Logger;
  open?: AgentSessionFactory;
  clients?: { agent: LlmClient; reviewer?: LlmClient } | undefined;
  /** Ends the run when it resolves (a signal, in the real process). */
  stop?: Promise<void>;
}

/** Serves one client until it closes its end (or `stop` resolves), then cancels running turns and closes every session. Returns the exit code. */
export async function runAcp(options: AcpOptions): Promise<number> {
  const sessions = createSessions({
    settings: options.settings,
    store: options.store,
    env: options.env,
    open: options.open ?? openAgentSession,
    permissions: options.permissions,
    allowFullAccess: options.allowFullAccess ?? false,
    clients: options.clients,
    log: options.log.child("sessions"),
  });
  const agent = createAcpAgent({ sessions, identity: { name: "sakuracode", title: "Sakura Code", version: options.version }, log: options.log.child("agent") });
  const connection = connect(agent, options.streams, options.log.child("connection"));
  options.log.info("serving", { version: options.version, permissions: options.permissions });
  await Promise.race([connection.closed, options.stop ?? new Promise<never>(() => undefined)]);
  await sessions.closeAll();
  options.log.info("stopped");
  return 0;
}

export interface ProcessIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
}

/**
 * The real process: stdin and stdout carry the protocol and nothing else. Anything the program or a library prints with
 * `console` goes to stderr instead, so a stray line can never corrupt the stream. The first SIGINT or SIGTERM ends the run
 * cleanly; a second one exits at once.
 */
export async function serveProcess(io: ProcessIO, options: Omit<AcpOptions, "streams" | "log" | "stop" | "env">): Promise<number> {
  const writeLog = (line: string) => void io.stderr.write(line);
  for (const name of ["log", "info", "debug", "warn", "error"] as const) console[name] = (...args: unknown[]) => void io.stderr.write(`${args.map(String).join(" ")}\n`);
  const log = createLogger(writeLog, logLevelFromEnv(io.env.SAKURACODE_ACP_LOG));

  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) process.exit(1);
    stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const streams: Streams = {
      input: Readable.toWeb(io.stdin as Readable) as unknown as ReadableStream<Uint8Array>,
      output: Writable.toWeb(io.stdout as Writable) as unknown as WritableStream<Uint8Array>,
    };
    return await runAcp({ ...options, env: io.env, streams, log, stop: stopped });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
