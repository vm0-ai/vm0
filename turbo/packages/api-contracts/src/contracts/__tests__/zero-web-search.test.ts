import { describe, expect, it } from "vitest";

import {
  ZERO_WEB_SEARCH_MAX_QUERY_CHARS,
  ZERO_WEB_SEARCH_MAX_SNIPPET_CHARS,
  ZERO_WEB_SEARCH_MAX_TITLE_CHARS,
  zeroWebSearchRequestSchema,
  zeroWebSearchResponseSchema,
} from "../zero-web-search";

const baseResponse = {
  query: "latest AI regulation",
  limit: 5,
  provider: "perplexity",
  billingCategory: "request",
  billingQuantity: 1,
  creditsCharged: 5,
  results: [
    {
      rank: 1,
      title: "AI regulation update",
      url: "https://example.com/update",
      snippet: "A relevant public-web excerpt.",
      publishedDate: "2026-07-14",
    },
  ],
} as const;

describe("zeroWebSearchRequestSchema", () => {
  it("applies defaults and normalizes queries and domains", () => {
    expect(
      zeroWebSearchRequestSchema.parse({
        query: "  latest AI regulation  ",
        domains: ["EXAMPLE.com", "example.com", "docs.example.com"],
      }),
    ).toStrictEqual({
      query: "latest AI regulation",
      limit: 5,
      domains: ["example.com", "docs.example.com"],
    });
  });

  it("accepts bounded result, recency, and domain controls", () => {
    expect(
      zeroWebSearchRequestSchema.safeParse({
        query: "space launches",
        limit: 10,
        recency: "week",
        domains: ["nasa.gov"],
      }).success,
    ).toBe(true);
  });

  it.each([
    { query: "", limit: 5 },
    { query: "x".repeat(ZERO_WEB_SEARCH_MAX_QUERY_CHARS + 1), limit: 5 },
    { query: "valid", limit: 0 },
    { query: "valid", limit: 11 },
    { query: "valid", limit: 1.5 },
    { query: "valid", recency: "forever" },
    { query: "valid", domains: ["https://example.com"] },
    { query: "valid", domains: ["example.com/path"] },
    { query: "valid", domains: ["-example.com"] },
    { query: "valid", domains: ["localhost"] },
  ])("rejects invalid requests: $query", (request) => {
    expect(zeroWebSearchRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("zeroWebSearchResponseSchema", () => {
  it("accepts a bounded Zero-owned response", () => {
    expect(zeroWebSearchResponseSchema.safeParse(baseResponse).success).toBe(
      true,
    );
  });

  it("rejects non-HTTP result URLs", () => {
    expect(
      zeroWebSearchResponseSchema.safeParse({
        ...baseResponse,
        results: [{ ...baseResponse.results[0], url: "ftp://example.com" }],
      }).success,
    ).toBe(false);
  });

  it("rejects response text beyond contract bounds", () => {
    for (const result of [
      {
        ...baseResponse.results[0],
        title: "x".repeat(ZERO_WEB_SEARCH_MAX_TITLE_CHARS + 1),
      },
      {
        ...baseResponse.results[0],
        snippet: "x".repeat(ZERO_WEB_SEARCH_MAX_SNIPPET_CHARS + 1),
      },
    ]) {
      expect(
        zeroWebSearchResponseSchema.safeParse({
          ...baseResponse,
          results: [result],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects more than ten ranked results", () => {
    expect(
      zeroWebSearchResponseSchema.safeParse({
        ...baseResponse,
        limit: 10,
        results: Array.from({ length: 11 }, (_, index) => {
          return {
            ...baseResponse.results[0],
            rank: index + 1,
          };
        }),
      }).success,
    ).toBe(false);
  });
});
