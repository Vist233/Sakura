/*
 * Adapted from Pi (https://github.com/badlogic/pi-mono), packages/coding-agent/src/core/tools/edit-diff.ts
 * Copyright (c) 2025 Mario Zechner. MIT License (see THIRD_PARTY_NOTICES.md).
 * Changes: removed the diff-rendering helpers and the file-system and `diff` package imports; kept the
 * matching, fuzzy-normalisation, overlap and line-preserving replacement logic and the error messages.
 */

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  if (lf === -1 || crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * Normalise text for fuzzy matching: strip trailing whitespace per line and map smart quotes,
 * Unicode dashes and special spaces to their ASCII forms.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ");
}

const splitLinesWithEndings = (content: string): string[] => content.match(/[^\n]*\n|[^\n]+/g) ?? [];

interface LineSpan {
  start: number;
  end: number;
}

interface Replacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface MatchedEdit extends Replacement {
  editIndex: number;
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: LineSpan[], replacement: Replacement): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  const startLine = lines.findIndex((line) => replacementStart >= line.start && replacementStart < line.end);
  if (startLine === -1) throw new Error("Replacement range is outside the base content.");
  let endLine = startLine;
  while (endLine < lines.length && (lines[endLine]?.end ?? 0) < replacementEnd) endLine++;
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index] as Replacement;
    const matchIndex = replacement.matchIndex - offset;
    result = result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * Apply replacements matched against a normalised view (`baseContent`) to the original content,
 * rewriting only the lines they touch so every other line keeps its original bytes.
 */
function applyReplacementsPreservingUnchangedLines(originalContent: string, baseContent: string, replacements: Replacement[]): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }
  const groups: Array<{ startLine: number; endLine: number; replacements: Replacement[] }> = [];
  for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else {
      groups.push({ ...range, replacements: [replacement] });
    }
  }
  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStart = (baseLines[group.startLine] as LineSpan).start;
    const groupEnd = (baseLines[group.endLine - 1] as LineSpan).end;
    result += applyReplacements(baseContent.slice(groupStart, groupEnd), group.replacements, groupStart);
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join("");
}

interface FuzzyMatch {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

/** Find oldText in content: exact first, then in fuzzy-normalised space. */
function fuzzyFindText(content: string, oldText: string): FuzzyMatch {
  const exact = content.indexOf(oldText);
  if (exact !== -1) return { found: true, index: exact, matchLength: oldText.length, usedFuzzyMatch: false };
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  const fuzzy = normalizeForFuzzyMatch(content).indexOf(fuzzyOld);
  if (fuzzy === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  return { found: true, index: fuzzy, matchLength: fuzzyOld.length, usedFuzzyMatch: true };
}

const countOccurrences = (content: string, oldText: string): number => normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;

export interface Edit {
  oldText: string;
  newText: string;
}

/**
 * Apply one or more exact-text replacements to LF-normalised content. Every edit is matched against the
 * same original content, so edits must be unique and must not overlap. Returns the new content.
 */
export function applyEdits(normalizedContent: string, edits: Edit[], path: string): string {
  const total = edits.length;
  const normalizedEdits = edits.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }));

  normalizedEdits.forEach((edit, index) => {
    if (edit.oldText.length === 0) {
      throw new Error(total === 1 ? `oldText must not be empty in ${path}.` : `edits[${index}].oldText must not be empty in ${path}.`);
    }
  });

  const usedFuzzy = normalizedEdits.some((edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch);
  const base = usedFuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

  const matched: MatchedEdit[] = [];
  normalizedEdits.forEach((edit, index) => {
    const match = fuzzyFindText(base, edit.oldText);
    if (!match.found) {
      throw new Error(
        total === 1
          ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
          : `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
      );
    }
    const occurrences = countOccurrences(base, edit.oldText);
    if (occurrences > 1) {
      throw new Error(
        total === 1
          ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
          : `Found ${occurrences} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
      );
    }
    matched.push({ editIndex: index, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText });
  });

  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let index = 1; index < matched.length; index++) {
    const previous = matched[index - 1] as MatchedEdit;
    const current = matched[index] as MatchedEdit;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    }
  }

  const result = usedFuzzy ? applyReplacementsPreservingUnchangedLines(normalizedContent, base, matched) : applyReplacements(base, matched);
  if (result === normalizedContent) {
    throw new Error(
      total === 1
        ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    );
  }
  return result;
}
