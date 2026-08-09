import { describe, expect, it } from "vitest";

import { chatSearchMatchRanges } from "../chat-search-bigram";

describe("chatSearchMatchRanges", () => {
  it("finds repeated CJK phrases without overlapping matches", () => {
    expect(
      chatSearchMatchRanges("今天天气很好，今天天气", "今天天气"),
    ).toStrictEqual([
      { start: 0, end: 4 },
      { start: 7, end: 11 },
    ]);
  });

  it("matches regular-expression metacharacters literally", () => {
    expect(chatSearchMatchRanges("alpha+beta+gamma", "+")).toStrictEqual([
      { start: 5, end: 6 },
      { start: 10, end: 11 },
    ]);
  });

  it("returns no ranges for an empty keyword", () => {
    expect(chatSearchMatchRanges("anything", "")).toStrictEqual([]);
  });
});
