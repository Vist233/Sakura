// The interactive session: connects the terminal (keys in, painted lines out) to the session controller.
// Everything that decides what a line means lives in the controller; everything about how it looks lives in the views.
import { complete } from "../slash-commands.ts";
import type { SlashCommand } from "../slash-commands.ts";
import { createController } from "../session-controller.ts";
import type { ControllerDeps, StartOptions, Surface } from "../session-controller.ts";
import { formatStatusLine } from "../status-line.ts";
import { createTranscript } from "../transcript.ts";
import type { Block } from "../transcript.ts";
import type { SessionMeta } from "../session-store.ts";
import { createKeyDecoder } from "./keys.ts";
import type { KeyEvent } from "./keys.ts";
import { createLineEditor } from "./line-editor.ts";
import { createLiveRegion } from "./live-region.ts";
import type { OutputStream } from "./live-region.ts";
import { composeLive } from "./screen.ts";
import type { PickerState } from "./screen.ts";
import { renderBanner, renderBlock, spacingBetween } from "./transcript-view.ts";

export interface TuiInput {
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  setEncoding?(encoding: "utf8"): unknown;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface TuiOutput extends OutputStream {
  on?(event: "resize", listener: () => void): unknown;
}

export interface TuiOptions {
  controller: Omit<ControllerDeps, "transcript" | "surface">;
  start: StartOptions;
  stdin: TuiInput;
  stdout: TuiOutput;
  color: boolean;
  version: string;
  initialPrompt?: string | undefined;
}

const EXIT_CONFIRM_MS = 2000;

export async function runTui(options: TuiOptions): Promise<number> {
  const { stdin, stdout, color } = options;
  const transcript = createTranscript();
  const live = createLiveRegion(stdout);
  const editor = createLineEditor();
  const decoder = createKeyDecoder();
  const width = () => Math.max(30, stdout.columns ?? 80);

  let picker: (PickerState & { resolve(meta: SessionMeta | undefined): void }) | undefined;
  let popupIndex = 0;
  let popupDismissedFor: string | undefined;
  let hint: string | undefined;
  let hintTimer: NodeJS.Timeout | undefined;
  let frame = 0;
  let workStartedAt = Date.now();
  let lastCtrlC = 0;
  let paintTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => (finish = resolve));
  let lastPrinted: Block | undefined;

  const surface: Surface = {
    changed: () => schedulePaint(),
    pickSession(sessions) {
      return new Promise((resolve) => {
        picker = { title: "Resume a session", items: sessions, index: 0, resolve };
        schedulePaint();
      });
    },
    clearScreen() {
      stdout.write("\u001b[2J\u001b[3J\u001b[H");
      live.forget();
      lastPrinted = undefined;
    },
    prefill: (text) => editor.set(text),
    exit: () => finish(0),
  };
  const controller = createController({ ...options.controller, transcript, surface });

  // ----- painting -----

  const popupCommands = (): SlashCommand[] => {
    const value = editor.value();
    return picker || value === popupDismissedFor ? [] : complete(value);
  };

  function paint() {
    paintTimer = undefined;
    if (finished) return;
    const state = transcript.state();
    const commands = popupCommands();
    popupIndex = Math.min(popupIndex, Math.max(0, commands.length - 1));
    const view = composeLive({
      width: width(),
      color,
      composer: editor.layout(width() - 3),
      statusLine: formatStatusLine(controller.statusInfo(), width() - 2, color),
      working: controller.driver.working,
      elapsedSeconds: Math.floor((Date.now() - workStartedAt) / 1000),
      frame,
      runningTools: state.running,
      streamingTail: state.pending,
      pending: controller.pending(),
      popup: commands.length > 0 ? { commands, index: popupIndex } : undefined,
      picker,
      hint,
    });
    live.setLive(view.lines, view.cursor);
  }

  function schedulePaint() {
    paintTimer ??= setTimeout(paint, 16);
  }

  function printBlock(block: Block) {
    const spacing = spacingBetween(lastPrinted, block);
    lastPrinted = block;
    live.print([...Array<string>(spacing).fill(""), ...renderBlock(block, { width: width(), color, cwd: options.controller.cwd })]);
  }

  controller.driver.onChange(() => {
    if (controller.driver.working) workStartedAt = Date.now();
    schedulePaint();
  });
  const spinner = setInterval(() => {
    if (!controller.driver.working) return;
    frame += 1;
    schedulePaint();
  }, 100);

  function showHint(text: string) {
    hint = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint = undefined;
      schedulePaint();
    }, EXIT_CONFIRM_MS);
    schedulePaint();
  }

  // ----- keys -----

  function submitLine(mode: "steer" | "queue") {
    let text = editor.value();
    const commands = popupCommands();
    if (commands.length > 0 && text !== `/${commands[popupIndex]!.name}`) text = `/${commands[popupIndex]!.name}`;
    if (text.trim() === "") return;
    if (mode === "queue" && !controller.driver.working) mode = "steer";
    editor.remember(text);
    editor.clear();
    popupIndex = 0;
    void controller.submit(text, mode).catch((error: Error) => transcript.add({ kind: "notice", level: "error", text: error.message }));
  }

  function onPickerKey(key: KeyEvent) {
    const current = picker!;
    if (key.name === "up") current.index = Math.max(0, current.index - 1);
    else if (key.name === "down") current.index = Math.min(current.items.length - 1, current.index + 1);
    else if (key.name === "enter") {
      picker = undefined;
      current.resolve(current.items[current.index]);
    } else if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
      picker = undefined;
      current.resolve(undefined);
    }
  }

  function onKey(key: KeyEvent) {
    if (picker) return onPickerKey(key);
    const commands = popupCommands();
    if (commands.length > 0 && (key.name === "up" || key.name === "down")) {
      popupIndex = (popupIndex + (key.name === "down" ? 1 : commands.length - 1)) % commands.length;
      return;
    }
    const action = editor.handle(key);
    if (action !== "none") popupIndex = action === "tab" ? popupIndex : 0;
    if (action === "submit") submitLine("steer");
    else if (action === "tab") {
      if (commands.length > 0) editor.set(`/${commands[popupIndex]!.name} `);
      else if (controller.driver.working && editor.value().trim() !== "") submitLine("queue");
    } else if (action === "escape") {
      if (controller.driver.working) controller.cancel();
      else if (commands.length > 0) popupDismissedFor = editor.value();
    } else if (action === "interrupt") {
      if (controller.driver.working) controller.cancel();
      else if (editor.value() !== "") editor.clear();
      else if (Date.now() - lastCtrlC < EXIT_CONFIRM_MS) finish(0);
      else {
        lastCtrlC = Date.now();
        showHint("Press Ctrl-C again to leave.");
      }
    } else if (action === "eof") finish(0);
  }

  // ----- lifecycle -----

  function restoreTerminal() {
    stdout.write("\u001b[?2004l\u001b[?25h");
    stdin.setRawMode?.(false);
    stdin.pause?.();
  }

  try {
    await controller.start(options.start);
  } catch (error) {
    clearInterval(spinner);
    stdout.write(`${(error as Error).message}\n`);
    return 1;
  }

  transcript.subscribe((change) => (change.type === "commit" ? printBlock(change.block) : schedulePaint()));
  stdin.setEncoding?.("utf8");
  stdin.setRawMode?.(true);
  stdin.resume?.();
  stdout.write("\u001b[?2004h");
  stdin.on("data", (chunk) => {
    if (finished) return;
    for (const key of decoder.push(chunk.toString())) onKey(key);
    schedulePaint();
  });
  stdout.on?.("resize", () => {
    live.forget();
    schedulePaint();
  });

  const info = controller.statusInfo();
  const meta = controller.currentMeta();
  live.print(renderBanner({ version: options.version, model: info.model, provider: info.provider, cwd: info.cwd, permissions: info.permissions, resumed: options.start.resume !== undefined ? meta?.title ?? meta?.id.slice(0, 8) : undefined }, { width: width(), color }));
  if (options.start.resume !== undefined) {
    for (const block of transcript.blocks()) printBlock(block);
  }
  paint();
  if (options.initialPrompt) void controller.submit(options.initialPrompt).catch((error: Error) => transcript.add({ kind: "notice", level: "error", text: error.message }));

  const code = await done;
  finished = true;
  clearInterval(spinner);
  clearTimeout(paintTimer);
  clearTimeout(hintTimer);
  if (controller.driver.working) {
    controller.cancel();
    for (let waited = 0; controller.driver.working && waited < 3000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  live.clear();
  restoreTerminal();
  const saved = controller.currentMeta();
  await controller.close();
  if (saved?.title !== undefined) stdout.write(`\nSession saved. Resume it with:\n  sakura-terminal resume ${saved.id}\n`);
  return code;
}
