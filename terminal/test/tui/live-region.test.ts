import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiveRegion } from "../../src/tui/live-region.ts";
import { VirtualTerminal } from "../support/vt.ts";

function setup(columns = 40) {
  const terminal = new VirtualTerminal(columns);
  const out = { write: (data: string) => terminal.write(data), columns };
  return { terminal, live: createLiveRegion(out) };
}

describe("live region", () => {
  it("draws the live area and puts the cursor where asked", () => {
    const { terminal, live } = setup();
    live.setLive(["status", "› hello", "footer"], { row: 1, col: 7 });
    assert.deepEqual(terminal.lines(), ["status", "› hello", "footer"]);
    assert.deepEqual([terminal.row, terminal.col], [1, 7]);
  });

  it("redraws in place without leaving old lines behind", () => {
    const { terminal, live } = setup();
    live.setLive(["a", "b", "c"], { row: 2, col: 1 });
    live.setLive(["x", "y"], { row: 1, col: 1 });
    assert.deepEqual(terminal.lines(), ["x", "y"]);
  });

  it("prints finished lines above the live area, which moves down", () => {
    const { terminal, live } = setup();
    live.setLive(["› typing"], { row: 0, col: 8 });
    live.print(["done one", "done two"]);
    live.print(["done three"]);
    assert.deepEqual(terminal.lines(), ["done one", "done two", "done three", "› typing"]);
    live.setLive(["› typing more", "status"], { row: 0, col: 13 });
    assert.deepEqual(terminal.lines(), ["done one", "done two", "done three", "› typing more", "status"]);
  });

  it("prints with no live area, and clear removes only the live area", () => {
    const { terminal, live } = setup();
    live.print(["first"]);
    live.setLive(["live"], { row: 0, col: 0 });
    live.clear();
    assert.equal(terminal.text(), "first");
  });

  it("handles a cursor on the first row of a tall live area", () => {
    const { terminal, live } = setup();
    live.setLive(["one", "two", "three"], { row: 0, col: 3 });
    live.print(["above"]);
    assert.deepEqual(terminal.lines(), ["above", "one", "two", "three"]);
    assert.deepEqual([terminal.row, terminal.col], [1, 3]);
  });

  it("reports the stream width", () => {
    assert.equal(setup(55).live.width(), 55);
  });
});

describe("pinned live region", () => {
  function pinned(rows: number, columns = 40) {
    const terminal = new VirtualTerminal(columns, rows);
    const out = { write: (data: string) => terminal.write(data), columns, rows };
    return { terminal, live: createLiveRegion(out, { pinned: true }) };
  }
  const live3 = ["── rule", "› typed", " status"];

  it("puts the live area on the last rows of a fresh screen", () => {
    const { terminal, live } = pinned(10);
    live.print(["banner"]);
    live.setLive(live3, { row: 1, col: 7 });
    const screen = terminal.screen();
    assert.equal(screen[0], "banner");
    assert.deepEqual(screen.slice(7), live3);
    assert.deepEqual(screen.slice(1, 7), ["", "", "", "", "", ""]);
    assert.deepEqual([terminal.row - terminal.top, terminal.col], [8, 7]);
  });

  it("fills the gap with printed lines while the live area stays on the bottom rows", () => {
    const { terminal, live } = pinned(10);
    live.print(["banner"]);
    live.setLive(live3, { row: 1, col: 7 });
    live.print(["one", "two"]);
    let screen = terminal.screen();
    assert.deepEqual(screen.slice(0, 3), ["banner", "one", "two"]);
    assert.deepEqual(screen.slice(7), live3);
    live.print(["a", "b", "c", "d", "e", "f"]);
    screen = terminal.screen();
    assert.deepEqual(screen.slice(7), live3);
    assert.equal(screen[6], "f");
    assert.equal(terminal.rows.length >= 11, true, "the first lines went into the scrollback, none were lost");
    assert.deepEqual(terminal.lines().slice(0, 9), ["banner", "one", "two", "a", "b", "c", "d", "e", "f"]);
  });

  it("keeps the live area on the bottom while it changes height", () => {
    const { terminal, live } = pinned(10);
    live.print(["banner"]);
    live.setLive(live3, { row: 1, col: 7 });
    live.setLive(["── rule", "› typed", "  more", " status"], { row: 2, col: 6 });
    assert.deepEqual(terminal.screen().slice(6), ["── rule", "› typed", "  more", " status"]);
    live.setLive(live3, { row: 1, col: 7 });
    assert.deepEqual(terminal.screen().slice(7), live3);
    assert.equal(terminal.screen()[6], "");
  });

  it("follows the output when the screen is already full, and after a resize leaves no padding", () => {
    const { terminal, live } = pinned(6);
    live.print(["1", "2", "3", "4", "5", "6", "7"]);
    live.setLive(["rule", "› x"], { row: 1, col: 3 });
    assert.deepEqual(terminal.screen().slice(4), ["rule", "› x"]);
    live.forget();
    live.setLive(["rule", "› y"], { row: 1, col: 3 });
    assert.equal(terminal.screen().at(-1), "› y");
  });

  it("starts at the top again after the screen was cleared", () => {
    const { terminal, live } = pinned(8);
    live.print(["old"]);
    live.setLive(live3, { row: 1, col: 3 });
    terminal.write("\u001b[2J\u001b[3J\u001b[H");
    live.cleared();
    live.print(["fresh"]);
    live.setLive(live3, { row: 1, col: 3 });
    assert.equal(terminal.screen()[0], "fresh");
    assert.deepEqual(terminal.screen().slice(5), live3);
  });

  it("clear removes the live area and the gap and leaves the output", () => {
    const { terminal, live } = pinned(10);
    live.print(["banner"]);
    live.setLive(live3, { row: 1, col: 3 });
    live.clear();
    assert.deepEqual(terminal.lines(), ["banner", ""], "only the empty line under the output is left");
    assert.equal(terminal.row, 1);
  });
});
