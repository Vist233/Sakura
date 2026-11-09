// The command line: parses arguments, loads the config, and starts the interactive session or a non-interactive run.
import { existsSync, readFileSync } from "node:fs";
import { imageMediaType } from "./images.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, configDirectory, readConfigFile, resolveSettings } from "./config.ts";
import type { Settings, SettingsLayer } from "./config.ts";
import { runExec } from "./exec-mode.ts";
import { createFauxClient } from "./framework-testing.ts";
import type { FauxTurn } from "./framework-testing.ts";
import { parseInvocation } from "./invocation.ts";
import { isPermissionName, PERMISSION_NAMES } from "./permissions.ts";
import { listProviders, ProviderSetupError } from "./providers.ts";
import { createSessionStore, sessionLabel } from "./session-store.ts";
import type { ControllerDeps } from "./session-controller.ts";
import { runTui } from "./tui/app.ts";

export const VERSION = "0.1.0";

export interface CliIO {
  stdin: NodeJS.ReadStream & { fd: 0 };
  stdout: NodeJS.WriteStream & { fd: 1 };
  stderr: NodeJS.WriteStream & { fd: 2 };
  env: Record<string, string | undefined>;
  cwd: string;
}

const HELP = `Sakura Terminal ${VERSION}: a terminal coding agent on the Sakura framework.

Usage:
  sakura-terminal [options] [prompt]          interactive session (the prompt is sent at once)
  sakura-terminal exec [options] <prompt|->   run one prompt without a screen ("-" reads stdin)
  sakura-terminal exec resume [id|--last] [prompt]   continue a session without a screen
  sakura-terminal resume [id|--last] [prompt] continue a session (a picker without id)
  sakura-terminal fork <id|--last>            copy a session into a new one and continue there
  sakura-terminal review [--base BRANCH | --commit SHA] [focus]   review changes, then print the review
  sakura-terminal sessions                    list sessions
  sakura-terminal providers                   list providers and whether their key is set

Options:
  -m, --model NAME          model of the provider
      --provider NAME       deepseek, opencode, or one from the config file
  -p, --profile NAME        settings profile from the config file
      --permissions NAME    ${PERMISSION_NAMES.join(" | ")} (default auto: every call is reviewed)
      --yolo                same as --permissions full-access (nothing is reviewed)
  -i, --image FILE[,FILE]   attach image files to the first prompt (png, jpg, gif, webp, bmp)
      --redact              hide secrets from the model (off by default)
      --no-redact           force redaction off
      --thinking LEVEL      off | low | medium | high
      --max-tokens N        output limit per model request
  -C, --cwd DIR             directory to start in (tools are not restricted to it)
      --resume REF          continue the session REF (id, prefix, "last")
      --last                with resume/fork: the most recent session
      --json                exec: write events as JSON lines
      --raw                 exec: write the Markdown reply as it is even on a terminal
  -q, --quiet               exec: no progress on stderr
  -o, --output-last-message FILE   exec: also write the final reply to FILE
      --no-color            no colours
  -h, --help, -v, --version

Config: ${"~/.sakura/config.toml"} (SAKURA_HOME changes the directory). Keys: DEEPSEEK_API_KEY, OPENCODE_API_KEY.`;

interface Parsed {
  values: ReturnType<typeof parseCliArgs>["values"];
  positionals: string[];
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      provider: { type: "string" },
      model: { type: "string", short: "m" },
      profile: { type: "string", short: "p" },
      yolo: { type: "boolean" },
      image: { type: "string", short: "i", multiple: true },
      base: { type: "string" },
      commit: { type: "string" },
      permissions: { type: "string" },
      redact: { type: "boolean" },
      "no-redact": { type: "boolean" },
      thinking: { type: "string" },
      "max-tokens": { type: "string" },
      cwd: { type: "string", short: "C" },
      resume: { type: "string" },
      last: { type: "boolean" },
      json: { type: "boolean" },
      raw: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      "output-last-message": { type: "string", short: "o" },
      "no-color": { type: "boolean" },
    },
  });
}

function flagLayer(values: Parsed["values"]): SettingsLayer {
  const layer: SettingsLayer = {};
  if (values.provider) layer.provider = values.provider;
  if (values.model) layer.model = values.model;
  if (values.permissions) {
    if (!isPermissionName(values.permissions)) throw new ConfigError(`--permissions must be one of ${PERMISSION_NAMES.join(", ")}`);
    layer.permissions = values.permissions;
  }
  if (values.yolo) layer.permissions = "full-access";
  if (values.redact) layer.redaction = true;
  if (values["no-redact"]) layer.redaction = false;
  if (values.thinking) {
    if (!["off", "low", "medium", "high"].includes(values.thinking)) throw new ConfigError("--thinking must be off, low, medium or high");
    layer.thinking = values.thinking as SettingsLayer["thinking"];
  }
  if (values["max-tokens"]) {
    const number = Number(values["max-tokens"]);
    if (!Number.isSafeInteger(number) || number <= 0) throw new ConfigError("--max-tokens must be a positive integer");
    layer.maxTokens = number;
  }
  return layer;
}

/** The test hook: a JSON file of scripted turns replaces the real model. */
function fauxClients(env: CliIO["env"]): ControllerDeps["clients"] | undefined {
  const file = env.SAKURA_TERMINAL_FAUX_SCRIPT;
  if (!file) return undefined;
  const turns = JSON.parse(readFileSync(file, "utf8")) as FauxTurn[];
  const reviewerFile = env.SAKURA_TERMINAL_FAUX_REVIEWER;
  const reviewer = reviewerFile ? createFauxClient(JSON.parse(readFileSync(reviewerFile, "utf8")) as FauxTurn[]) : undefined;
  return { agent: createFauxClient(turns), ...(reviewer ? { reviewer } : {}) };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) text += chunk;
  return text;
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof ProviderSetupError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      const usage = (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? " (see --help)" : "";
      io.stderr.write(`sakura-terminal: ${(error as Error).message}${usage}\n`);
      return 2;
    }
    io.stderr.write(`sakura-terminal: ${(error as Error).stack ?? String(error)}\n`);
    return 1;
  }
}

async function run(argv: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseCliArgs(argv);
  if (values.help) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const home = homedir();
  const directory = configDirectory(io.env, home);
  const file = readConfigFile(join(directory, "config.toml"));
  const settings = resolveSettings({ file, profile: values.profile, env: io.env, flags: flagLayer(values) });
  const store = createSessionStore(join(directory, "sessions"));
  const cwd = resolve(io.cwd, values.cwd ?? ".");
  const clients = fauxClients(io.env);
  const images = (values.image ?? []).flatMap((entry) => entry.split(",")).map((entry) => resolve(cwd, entry.trim()));
  for (const image of images) if (imageMediaType(image) === undefined || !existsSync(image)) throw new ConfigError(`--image: ${image} is not an existing png, jpg, gif, webp or bmp file`);
  const controller: Omit<ControllerDeps, "transcript" | "surface"> = { settings, cwd, home, env: io.env, store, ...(images.length > 0 ? { images } : {}), ...(clients ? { clients } : {}) };
  const color = !values["no-color"] && !io.env.NO_COLOR && Boolean(io.stdout.isTTY);

  const invocation = parseInvocation(positionals, { last: values.last, resume: values.resume, base: values.base, commit: values.commit });
  if (invocation.mode === "providers") return listProvidersCommand(settings, io);
  if (invocation.mode === "sessions") return listSessionsCommand(store, io);

  if (invocation.mode === "exec") {
    let prompt = invocation.prompt;
    if (prompt === "-" || (prompt === "" && !io.stdin.isTTY)) prompt = (await readAll(io.stdin)).trim();
    if (prompt === "") throw new ConfigError("exec needs a prompt (an argument, or text on stdin)");
    let cancel: () => void = () => undefined;
    const onSigint = () => cancel();
    process.once("SIGINT", onSigint);
    try {
      return await runExec(
        { prompt, json: Boolean(values.json), render: Boolean(io.stdout.isTTY) && !values.raw, quiet: Boolean(values.quiet), color, outputLastMessage: values["output-last-message"], resume: invocation.resume },
        { controller, stdout: io.stdout, stderr: io.stderr, onCancelable: (fn) => (cancel = fn) },
      );
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  }

  if (!io.stdin.isTTY || !io.stdout.isTTY) throw new ConfigError("the interactive session needs a terminal; use `sakura-terminal exec` for pipes and scripts");
  return runTui({
    controller,
    start: invocation.resume !== undefined ? { resume: invocation.resume } : {},
    stdin: io.stdin,
    stdout: io.stdout,
    color,
    version: VERSION,
    initialPrompt: invocation.slash ?? (invocation.prompt.trim() === "" ? undefined : invocation.prompt),
  });
}

function listProvidersCommand(settings: Settings, io: CliIO): number {
  for (const entry of listProviders(settings, io.env)) io.stdout.write(`${entry.name.padEnd(12)} ${entry.definition.model.padEnd(24)} ${entry.definition.keyEnv} ${entry.keyPresent ? "set" : "NOT SET"}\n`);
  return 0;
}

async function listSessionsCommand(store: ReturnType<typeof createSessionStore>, io: CliIO): Promise<number> {
  const sessions = (await store.list()).filter((meta) => meta.title !== undefined);
  if (sessions.length === 0) io.stdout.write("No sessions yet.\n");
  for (const meta of sessions) io.stdout.write(`${meta.id}  ${new Date(meta.updatedAt).toISOString().slice(0, 16).replace("T", " ")}  ${meta.model}  ${sessionLabel(meta)}\n`);
  return 0;
}
