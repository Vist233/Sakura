import { createHmac, randomBytes } from "node:crypto";
import { gitleaksRules } from "./rules.gen.ts";

export interface SecretRule {
  id: string;
  regex: RegExp;
  secretGroup: number;
  entropy: number;
  keywords: string[];
}

/** A few rules of our own, for things the gitleaks table does not describe well. */
const ownRules: SecretRule[] = [
  { id: "private-key-block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/dg, secretGroup: 0, entropy: 0, keywords: ["private key"] },
  { id: "bearer-token", regex: /\bBearer\s+([A-Za-z0-9\-._~+/]{20,}=*)/dgi, secretGroup: 1, entropy: 3, keywords: ["bearer"] },
  { id: "url-credentials", regex: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]{3,})@/dgi, secretGroup: 1, entropy: 0, keywords: ["://"] },
  { id: "sendgrid-style-key", regex: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/dg, secretGroup: 0, entropy: 3, keywords: ["sg."] },
  { id: "openai-style-key", regex: /\bsk-(?:proj-|svcacct-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{32,}\b/dg, secretGroup: 0, entropy: 3, keywords: ["sk-"] },
  { id: "mailgun-style-key", regex: /\bkey-[0-9a-f]{32}\b/dg, secretGroup: 0, entropy: 0, keywords: ["key-"] },
  { id: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/dg, secretGroup: 0, entropy: 0, keywords: ["eyj"] },
  {
    id: "env-secret-assignment",
    regex: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*[ \t]*=[ \t]*['"]?([^\s'"]{8,})/dgm,
    secretGroup: 1,
    entropy: 0,
    keywords: ["secret", "token", "password", "passwd", "api_key", "apikey", "private_key"],
  },
];

export function builtinRules(): SecretRule[] {
  const generated = gitleaksRules.map((rule) => ({
    id: rule.id,
    regex: new RegExp(rule.regex, `${rule.flags}gd`),
    secretGroup: rule.secretGroup,
    entropy: rule.entropy,
    keywords: rule.keywords,
  }));
  return [...ownRules, ...generated];
}

export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export const PLACEHOLDER = /\{\{[A-Z0-9_]+_[0-9a-f]{8}\}\}/g;
const kindOf = (id: string) =>
  id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

interface Span {
  start: number;
  end: number;
  kind: string;
  secret: string;
}

export interface Engine {
  mask(text: string): string;
  restore(text: string): string;
  /** Number of secrets seen so far. */
  size(): number;
}

/**
 * Finds secrets and swaps each for a placeholder like {{AWS_ACCESS_TOKEN_1a2b3c4d}}. The same secret always gets
 * the same placeholder (an HMAC of the secret under a key), so the text sent to the model stays stable between requests.
 */
export function createEngine(options: { key?: string; rules?: SecretRule[] } = {}): Engine {
  const key = options.key ?? randomBytes(16).toString("hex");
  // a rule you write may leave out the flags the engine relies on (d: where the secret is, g: every match) or write its keywords in capitals
  const rules = (options.rules ?? builtinRules()).map((rule) => ({
    ...rule,
    regex: rule.regex instanceof RegExp ? new RegExp(rule.regex.source, [...new Set(`${rule.regex.flags}dg`)].join("")) : rule.regex, // anything else is left to fail when it is used, and a failure closes the request
    keywords: rule.keywords.map((keyword) => keyword.toLowerCase()),
  }));
  const secrets = new Map<string, string>();

  const placeholderFor = (kind: string, secret: string): string => {
    const digest = createHmac("sha256", key).update(secret).digest("hex").slice(0, 8);
    const placeholder = `{{${kind}_${digest}}}`;
    secrets.set(placeholder, secret);
    return placeholder;
  };

  function mask(text: string): string {
    if (text.length < 8) return text;
    const lower = text.toLowerCase();
    const protectedRanges = [...text.matchAll(PLACEHOLDER)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const);
    const spans: Span[] = [];
    for (const rule of rules) {
      if (rule.keywords.length > 0 && !rule.keywords.some((keyword) => lower.includes(keyword))) continue;
      rule.regex.lastIndex = 0;
      for (const match of text.matchAll(rule.regex)) {
        const indices = (match as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices;
        const range = indices?.[rule.secretGroup] ?? indices?.[0];
        if (!range) continue;
        const secret = text.slice(range[0], range[1]);
        if (secret.length < 6 || /^(.)\1+$/.test(secret)) continue;
        if (rule.entropy > 0 && shannonEntropy(secret) < rule.entropy) continue;
        if (protectedRanges.some(([start, end]) => range[0] < end && range[1] > start)) continue;
        spans.push({ start: range[0], end: range[1], kind: kindOf(rule.id), secret });
      }
    }
    if (spans.length === 0) return text;
    spans.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      if (span.start < cursor) continue; // overlaps an earlier, larger-or-equal span
      out += text.slice(cursor, span.start) + placeholderFor(span.kind, span.secret);
      cursor = span.end;
    }
    return out + text.slice(cursor);
  }

  return {
    mask,
    restore: (text) => (text.includes("{{") ? text.replace(PLACEHOLDER, (placeholder) => secrets.get(placeholder) ?? placeholder) : text),
    size: () => secrets.size,
  };
}
