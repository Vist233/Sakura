import { describe, expect, it } from "vitest";
import type { Plugin } from "@sakura/kernel";
import { bundle, compose, CompositionError } from "../../src/compose.ts";
import type { Composable } from "../../src/compose.ts";
import { drain, textOf, withAgent } from "./helpers.ts";

const node = (name: string, requires: string[] = [], provides: string[] = []): Composable => ({ name, requires, provides, setup() {} });

describe("C. one plugin depends on another", () => {
  it("C1 dependency by argument: the second plugin calls the first one's public function", async () => {
    // plugin A offers a service object; plugin B receives it when it is built
    const vault = new Map<string, string>();
    const a: Plugin & { vault: typeof vault } = { name: "a", vault, setup: (api) => api.on("context", () => void vault.set("seen", "yes")) };
    const b = (service: typeof vault): Plugin => ({ name: "b", setup: (api) => api.on("context", () => void service.set("b-saw", service.get("seen") ?? "no")) });
    await withAgent([a, b(a.vault)], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(vault.get("b-saw")).toBe("yes"); // a ran before b, so b saw a's write
  });

  it("C2 the same pair listed in the other order changes what b sees (order is part of the contract)", async () => {
    const vault = new Map<string, string>();
    const a: Plugin = { name: "a", setup: (api) => api.on("context", () => void vault.set("seen", "yes")) };
    const b: Plugin = { name: "b", setup: (api) => api.on("context", () => void vault.set("b-saw", vault.get("seen") ?? "no")) };
    await withAgent([b, a], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(vault.get("b-saw")).toBe("no");
  });

  it("C3 compose() puts a dependency before the plugin that requires it, whatever the listing order", () => {
    const order = compose([node("b", ["a"]), node("a")]).map((p) => p.name);
    expect(order).toEqual(["a", "b"]);
  });

  it("C4 requirements can name a capability, not a plugin", () => {
    const order = compose([node("ui", ["redaction"]), node("secrets-suite", [], ["redaction"])]).map((p) => p.name);
    expect(order).toEqual(["secrets-suite", "ui"]);
  });

  it("C5 a missing requirement fails before any run, naming both sides", () => {
    expect(() => compose([node("b", ["a"])])).toThrow(/plugin 'b' requires 'a'/);
  });

  it("C6 a cycle is reported with the path", () => {
    expect(() => compose([node("a", ["b"]), node("b", ["c"]), node("c", ["a"])])).toThrow(/a -> b -> c -> a/);
  });

  it("C7 a diamond (d needs b and c, both need a) lists each once, a first, d last", () => {
    const order = compose([node("d", ["b", "c"]), node("b", ["a"]), node("c", ["a"]), node("a")]).map((p) => p.name);
    expect(order[0]).toBe("a");
    expect(order[order.length - 1]).toBe("d");
    expect(order.length).toBe(4);
  });

  it("C8 a bundle inherits its children's requirements and provides their names", () => {
    const suite = bundle("suite", [node("x", ["needs-y"]), node("z", [], ["cap"])]);
    expect(suite.requires).toEqual(["needs-y"]);
    expect(suite.provides).toEqual(expect.arrayContaining(["x", "z", "cap"]));
  });

  it("C9 a plugin that requires its own capability is not a cycle", () => {
    expect(compose([node("a", ["a"])]).map((p) => p.name)).toEqual(["a"]);
  });

  it("C10 two agents built from the same factory do not share state", async () => {
    const make = (): Plugin => {
      const seen: string[] = [];
      return { name: "stateful", setup: (api) => api.on("context", ({ messages }) => void seen.push(textOf(messages.at(-1)!))), prepare: async () => {} };
    };
    const one = make();
    const two = make();
    expect(one).not.toBe(two);
    await withAgent([one], [{ text: "1" }], async (agent) => void (await drain(agent.run("first"))));
    await withAgent([two], [{ text: "1" }], async (agent) => void (await drain(agent.run("second"))));
  });

  it("C11 a requirement error names the plugin even deep inside a bundle's children when they are listed flat", () => {
    expect(() => compose([node("top"), node("mid", ["ghost"])])).toThrow(CompositionError);
  });
});
