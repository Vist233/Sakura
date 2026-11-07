import { createRng } from "@sakura/testing";

export const digits = "0123456789";
export const hex = digits + "abcdef";
const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const alphanumeric = upper + "abcdefghijklmnopqrstuvwxyz" + digits;

/** Generate deterministic test strings locally. No service creates or accepts these fixtures. */
export function fixtureChars(length: number, seed: number, alphabet = alphanumeric): string {
  const rng = createRng(seed);
  return Array.from({ length }, () => alphabet[rng.int(0, alphabet.length - 1)]).join("");
}

export const githubToken = (seed: number) => `ghp_${fixtureChars(36, seed)}`;
export const awsAccessKey = `AKIA${fixtureChars(16, 31, upper + "234567")}`;
