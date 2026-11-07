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
