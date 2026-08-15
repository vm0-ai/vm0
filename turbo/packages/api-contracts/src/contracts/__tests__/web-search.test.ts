import { describe, expect, it } from "vitest";

import {
  WEB_SEARCH_MAX_QUERY_CHARS,
  WEB_SEARCH_MAX_SNIPPET_CHARS,
  WEB_SEARCH_MAX_TITLE_CHARS,
  webSearchRequestSchema,
  webSearchResponseSchema,
} from "../web-search";

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

describe("webSearchRequestSchema", () => {
  it("applies defaults and normalizes queries and domains", () => {
    expect(
      webSearchRequestSchema.parse({
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
      webSearchRequestSchema.safeParse({
        query: "space launches",
        limit: 10,
        recency: "week",
        domains: ["nasa.gov"],
      }).success,
    ).toBe(true);
  });

  it.each([
    { query: "", limit: 5 },
    { query: "x".repeat(WEB_SEARCH_MAX_QUERY_CHARS + 1), limit: 5 },
    { query: "valid", limit: 0 },
    { query: "valid", limit: 11 },
    { query: "valid", limit: 1.5 },
    { query: "valid", recency: "forever" },
    { query: "valid", domains: ["https://example.com"] },
    { query: "valid", domains: ["example.com/path"] },
    { query: "valid", domains: ["-example.com"] },
    { query: "valid", domains: ["localhost"] },
  ])("rejects invalid requests: $query", (request) => {
    expect(webSearchRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("webSearchResponseSchema", () => {
  it("accepts a bounded web-search response", () => {
    expect(webSearchResponseSchema.safeParse(baseResponse).success).toBe(true);
  });

  it("rejects non-HTTP result URLs", () => {
    expect(
      webSearchResponseSchema.safeParse({
        ...baseResponse,
        results: [{ ...baseResponse.results[0], url: "ftp://example.com" }],
      }).success,
    ).toBe(false);
  });

  it("rejects response text beyond contract bounds", () => {
    for (const result of [
      {
        ...baseResponse.results[0],
        title: "x".repeat(WEB_SEARCH_MAX_TITLE_CHARS + 1),
      },
      {
        ...baseResponse.results[0],
        snippet: "x".repeat(WEB_SEARCH_MAX_SNIPPET_CHARS + 1),
      },
    ]) {
      expect(
        webSearchResponseSchema.safeParse({
          ...baseResponse,
          results: [result],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects more than ten ranked results", () => {
    expect(
      webSearchResponseSchema.safeParse({
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
