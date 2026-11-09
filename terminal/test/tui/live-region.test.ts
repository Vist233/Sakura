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
