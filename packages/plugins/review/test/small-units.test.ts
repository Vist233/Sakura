import { describe, expect, it } from "vitest";
import { mentionsSensitivePath } from "../src/hard-rules.ts";

describe("mentionsSensitivePath", () => {
  const sensitive = [
    "cat ~/.ssh/id_rsa",
    "cat .env",
    "cat .env.production",
    "ls ~/.aws/",
    "less /etc/shadow",
    "cat /etc/sudoers",
    "cat credentials",
    "cp ~/.netrc x",
    "type .npmrc",
    "cat ~/.docker/config.json",
    "cat .kube/config",
    '"~/.gnupg"',
    "id_ed25519",
  ];
  const harmless = ["cat README.md", "ls src", "echo environment", "cat .envelope", "cat myenv.txt", "grep credentialsx file", "cat shadowed.txt", "git status"];
  for (const text of sensitive) it(`sensitive: ${JSON.stringify(text)}`, () => expect(mentionsSensitivePath(text)).toBe(true));
  for (const text of harmless) it(`harmless: ${JSON.stringify(text)}`, () => expect(mentionsSensitivePath(text)).toBe(false));
});

describe("runChain: a check that fails", () => {
  it("denies with the reason even when what was thrown is not an Error", async () => {
    const { runChain } = await import("../src/chain.ts");
    const context = { log: {} as never, signal: new AbortController().signal, tool: () => undefined };
    const call = { id: "c", name: "bash", args: {} };
    const result = await runChain(
      [
        {
          name: "odd",
          review: async () => {
            throw "plain text";
          },
        },
      ],
      call,
      context,
    );
    expect(result).toMatchObject({ kind: "deny", decidedBy: "odd" });
    expect(result.reason).toContain("plain text");
  });
});

describe("runChain: how a failed check is told to the model", () => {
  const throwing = (error: unknown) => [
    {
      name: "broken",
      review: async () => {
        throw error;
      },
    },
  ];
  const context = { log: {} as never, signal: new AbortController().signal, tool: () => undefined };
  const call = { id: "c", name: "bash", args: {} };

  it("gives the first line only, without a stack, and at most 200 characters", async () => {
    const { runChain } = await import("../src/chain.ts");
    const stacked = await runChain(throwing(new Error("first line\n    at somewhere (file.ts:1:1)\n    at elsewhere")), call, context);
    expect(stacked.reason).toContain("(first line)");
    expect(stacked.reason).not.toContain("somewhere");
    const long = await runChain(throwing(new Error("x".repeat(500))), call, context);
    expect(long.reason).toContain(`${"x".repeat(200)}…`);
    expect(long.reason).not.toContain("x".repeat(201));
  });
});
