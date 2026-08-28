import { describe, expect, it } from "vitest";

import { parseMarkdownTree } from "../pipeline.ts";
import {
  createPlainMarkdownTree,
  plainTextFromMarkdownTree,
} from "../plain-markdown.ts";

const PLAIN_CASES = [
  "",
  "Plain response with punctuation: ready (now).",
  "Issue #29757 remains independent.",
  "First line\nsecond line",
  "中文内容，保持原样。",
] as const;

const RICH_CASES = [
  "**bold**",
  "`code`",
  "# Heading",
  "first paragraph\n\nsecond paragraph",
  "- list item",
  "1. ordered item",
  "> quote",
  "[link](https://example.com)",
  "Visit https://example.com",
  "name@example.com",
  "| A | B |",
  "<strong>html</strong>",
  "line with two spaces  \nnext",
  "    indented code",
] as const;

describe("plain Markdown classification", () => {
  it.each(PLAIN_CASES)("matches the full parser for %j", (source) => {
    const tree = createPlainMarkdownTree(source, { mathEnabled: true });
    expect(tree).not.toBeNull();
    expect(plainTextFromMarkdownTree(tree!)).toBe(source);

    const parsed = parseMarkdownTree(source, { mathEnabled: true });
    expect(plainTextFromMarkdownTree(parsed)).toBe(source);
  });

  it.each(RICH_CASES)("requires the rich parser for %j", (source) => {
    expect(createPlainMarkdownTree(source, { mathEnabled: true })).toBeNull();
  });

  it("loads math only when the surface enables it", () => {
    expect(
      createPlainMarkdownTree("Total: $5", { mathEnabled: false }),
    ).not.toBeNull();
    expect(
      createPlainMarkdownTree("Total: $5", { mathEnabled: true }),
    ).toBeNull();
  });
});
