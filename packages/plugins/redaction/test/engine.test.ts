import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { builtinRules, createEngine, shannonEntropy } from "../src/engine.ts";
import { skippedGitleaksRules } from "../src/rules.gen.ts";
import { gitleaksRules } from "../src/rules.gen.ts";
import { awsAccessKey, digits, fixtureChars, githubToken, hex } from "./fixtures.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const engine = () => createEngine({ key: "test-key" });

const jwtHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const jwtBody = Buffer.from(JSON.stringify({ sub: "fixture" })).toString("base64url");
const url = `postgres://fixture:${fixtureChars(18, 11)}@db.example.invalid:5432/app`;

const SAMPLES: Array<[string, string]> = [
  ["aws access key", awsAccessKey],
  ["github personal token", githubToken(1)],
  ["github fine-grained token", `github_pat_${fixtureChars(22, 2)}_${fixtureChars(59, 3)}`],
  ["slack bot token", `xoxb-${fixtureChars(12, 4, digits)}-${fixtureChars(13, 5, digits)}-${fixtureChars(24, 6)}`],
  ["stripe live key", `sk_live_${fixtureChars(24, 7)}`],
  ["google api key", `AIza${fixtureChars(35, 8)}`],
  ["npm token", `npm_${fixtureChars(36, 9)}`],
  ["jwt", `${jwtHeader}.${jwtBody}.${fixtureChars(43, 10)}`],
  ["private key block", ["-----BEGIN RSA PRIVATE KEY-----", fixtureChars(64, 12), "-----END RSA PRIVATE KEY-----"].join("\n")],
  ["url credentials", url],
  ["bearer header", `Authorization: Bearer ${fixtureChars(32, 13)}`],
  ["env assignment", `export DATABASE_PASSWORD=${fixtureChars(20, 14)}`],
  ["env assignment in a dotenv file", `API_SECRET=${fixtureChars(32, 15, hex)}`],
  ["sendgrid-style key", `SG.${fixtureChars(22, 16)}.${fixtureChars(43, 17)}`],
  ["openai-style key", `sk-proj-${fixtureChars(64, 18)}`],
  ["twilio sid and token", `SK${fixtureChars(32, 19, hex)}`],
  ["mailgun key", `key-${fixtureChars(32, 20, hex)}`],
  ["shopify token", `shpat_${fixtureChars(32, 21, hex)}`],
  ["digitalocean token", `dop_v1_${fixtureChars(64, 22, hex)}`],
  ["gitlab token", `glpat-${fixtureChars(20, 23)}`],
];

describe("rule table", () => {
  it("has about two hundred usable rules and lists the skipped ones", () => {
    expect(builtinRules().length).toBeGreaterThan(190);
    expect(gitleaksRules.length).toBeGreaterThan(190);
    expect(skippedGitleaksRules.length).toBeLessThan(30);
  });
  for (const rule of gitleaksRules) {
    it(`rule ${rule.id} compiles and is well formed`, () => {
      const regex = new RegExp(rule.regex, `${rule.flags}gd`);
      expect(regex.global).toBe(true);
      expect(rule.keywords.every((keyword) => keyword === keyword.toLowerCase())).toBe(true);
      expect(rule.secretGroup).toBeGreaterThanOrEqual(0);
    });
  }
});

describe("masking known token shapes", () => {
  for (const [name, secret] of SAMPLES) {
    it(`masks a ${name}`, () => {
      const masked = engine().mask(`here is the value:\n${secret}\nand some text after`);
      expect(masked).not.toContain(secret.split("\n")[1] ?? secret);
      expect(masked).toMatch(/\{\{[A-Z0-9_]+_[0-9a-f]{8}\}\}/);
      expect(masked).toContain("and some text after");
    });
    it(`restores a ${name} exactly`, () => {
      const e = engine();
      const original = `value=${secret}\n`;
      expect(e.restore(e.mask(original))).toBe(original);
    });
  }
});

describe("text that is not a secret", () => {
  const benign = [
    "function add(a, b) { return a + b; }",
    "Hello, world!",
    "git commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
    "const url = 'https://example.com/docs/index.html';",
    "npm install --save-dev typescript",
    "SELECT id, name FROM users WHERE id = 5",
    "The quick brown fox jumps over the lazy dog.",
    "ls -la /usr/local/bin",
    "version: 1.2.3-beta.4",
    "const TOKEN_LIMIT = 4096;",
    "password policy: at least 12 characters",
    "# TODO: rotate the api key next week",
    "export PATH=/usr/bin:/bin",
    "https://github.com/user/repo",
    "user@example.com",
    "color: #ff00aa;",
    "uuid 123e4567-e89b-12d3-a456-426614174000",
    "short",
    "",
    "    ",
    "if (token === undefined) throw new Error('missing token');",
    "MAX_TOKENS=4096",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "lorem ipsum dolor sit amet consectetur",
  ];
  for (const text of benign) {
    it(`leaves ${JSON.stringify(text).slice(0, 50)} alone`, () => {
      expect(engine().mask(text)).toBe(text);
    });
  }
});

describe("placeholders", () => {
  const secret = githubToken(1);
  it("the same secret always gets the same placeholder", () => {
    const e = engine();
    expect(e.mask(`a ${secret} b`)).toBe(e.mask(`a ${secret} b`));
    expect(e.mask(`x ${secret}`).split(" ")[1]).toBe(e.mask(`y ${secret}`).split(" ")[1]);
  });
  it("different secrets get different placeholders", () => {
    const e = engine();
    expect(e.mask(githubToken(1))).not.toBe(e.mask(githubToken(2)));
  });
  it("different keys give different placeholders; the same key gives the same", () => {
    expect(createEngine({ key: "a" }).mask(secret)).not.toBe(createEngine({ key: "b" }).mask(secret));
    expect(createEngine({ key: "a" }).mask(secret)).toBe(createEngine({ key: "a" }).mask(secret));
  });
  it("has the shape {{KIND_xxxxxxxx}}", () => {
    expect(engine().mask(secret)).toMatch(/^\{\{GITHUB_PAT_[0-9a-f]{8}\}\}$/);
  });
  it("does not mask a placeholder again", () => {
    const e = engine();
    const once = e.mask(`token ${secret}`);
    expect(e.mask(once)).toBe(once);
  });
  it("does not reveal the secret in the placeholder", () => {
    expect(engine().mask(secret)).not.toContain(secret.slice(8, 20));
  });
  it("leaves unknown placeholders as they are when restoring", () => {
    expect(engine().restore("see {{FAKE_KIND_0123abcd}} here")).toBe("see {{FAKE_KIND_0123abcd}} here");
  });
  for (const seed of range(20)) {
    it(`restores several different secrets in one text (seed ${seed})`, () => {
      const rng = createRng(seed);
      const e = engine();
      const tokens = Array.from({ length: rng.int(2, 5) }, () => `ghp_${Array.from({ length: 36 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[rng.int(0, 61)]).join("")}`);
      const original = tokens.map((token, index) => `item ${index}: ${token}`).join("\n");
      const masked = e.mask(original);
      for (const token of tokens) expect(masked).not.toContain(token);
      expect(e.restore(masked)).toBe(original);
    });
  }
  it("counts what it has seen", () => {
    const e = engine();
    e.mask(secret);
    e.mask(awsAccessKey);
    expect(e.size()).toBe(2);
  });
});

describe("entropy", () => {
  it("is zero for empty text and for one repeated character", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
  });
  it("grows with variety", () => {
    expect(shannonEntropy("abababab")).toBeCloseTo(1, 5);
    expect(shannonEntropy("abcdefgh")).toBeCloseTo(3, 5);
  });
});

describe("own rules", () => {
  it("a custom rule list replaces the built-in rules", () => {
    const e = createEngine({ key: "k", rules: [{ id: "internal-id", regex: /\bINT-[0-9]{6}\b/dg, secretGroup: 0, entropy: 0, keywords: ["int-"] }] });
    expect(e.mask(`ticket INT-123456 and ${githubToken(1)}`)).toMatch(/^ticket \{\{INTERNAL_ID_[0-9a-f]{8}\}\} and ghp_/);
  });
  it("only the secret group is replaced, not the context around it", () => {
    const masked = createEngine({ key: "k" }).mask(url);
    expect(masked.startsWith("postgres://fixture:{{URL_CREDENTIALS_")).toBe(true);
    expect(masked.endsWith("}}@db.example.invalid:5432/app")).toBe(true);
  });
});
