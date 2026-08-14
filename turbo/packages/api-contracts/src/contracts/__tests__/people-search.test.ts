import { describe, expect, it } from "vitest";

import {
  PEOPLE_SEARCH_MAX_NAME_CHARS,
  PEOPLE_SEARCH_MAX_QUERY_CHARS,
  PEOPLE_SEARCH_MAX_SUMMARY_CHARS,
  peopleSearchRequestSchema,
  peopleSearchResponseSchema,
} from "../people-search";

const baseResponse = {
  query: "platform engineering leaders at Notion",
  limit: 5,
  provider: "perplexity",
  billingCategory: "request",
  billingQuantity: 1,
  creditsCharged: 20,
  profiles: [
    {
      name: "Jordan Lee",
      title: "VP of Platform",
      company: "Example",
      location: "San Francisco",
      summary: "Leads public platform engineering work.",
      sources: [
        {
          title: "Example leadership",
          url: "https://example.com/leadership",
        },
      ],
    },
  ],
} as const;

describe("peopleSearchRequestSchema", () => {
  it("trims queries and applies the default limit", () => {
    expect(
      peopleSearchRequestSchema.parse({
        query: "  platform engineering leaders  ",
      }),
    ).toStrictEqual({
      query: "platform engineering leaders",
      limit: 5,
    });
  });

  it.each([
    { query: "", limit: 5 },
    { query: "x".repeat(PEOPLE_SEARCH_MAX_QUERY_CHARS + 1), limit: 5 },
    { query: "valid", limit: 0 },
    { query: "valid", limit: 21 },
    { query: "valid", limit: 1.5 },
  ])("rejects invalid requests", (request) => {
    expect(peopleSearchRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("peopleSearchResponseSchema", () => {
  it("accepts bounded profiles and a valid empty result", () => {
    expect(peopleSearchResponseSchema.safeParse(baseResponse).success).toBe(
      true,
    );
    expect(
      peopleSearchResponseSchema.safeParse({
        ...baseResponse,
        profiles: [],
      }).success,
    ).toBe(true);
  });

  it("rejects profiles without provider-backed sources", () => {
    expect(
      peopleSearchResponseSchema.safeParse({
        ...baseResponse,
        profiles: [{ ...baseResponse.profiles[0], sources: [] }],
      }).success,
    ).toBe(false);
  });

  it("rejects non-HTTP source URLs", () => {
    expect(
      peopleSearchResponseSchema.safeParse({
        ...baseResponse,
        profiles: [
          {
            ...baseResponse.profiles[0],
            sources: [
              {
                ...baseResponse.profiles[0].sources[0],
                url: "file:///private/profile",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects fields and profile counts beyond contract bounds", () => {
    for (const profile of [
      {
        ...baseResponse.profiles[0],
        name: "x".repeat(PEOPLE_SEARCH_MAX_NAME_CHARS + 1),
      },
      {
        ...baseResponse.profiles[0],
        summary: "x".repeat(PEOPLE_SEARCH_MAX_SUMMARY_CHARS + 1),
      },
    ]) {
      expect(
        peopleSearchResponseSchema.safeParse({
          ...baseResponse,
          profiles: [profile],
        }).success,
      ).toBe(false);
    }
    expect(
      peopleSearchResponseSchema.safeParse({
        ...baseResponse,
        limit: 20,
        profiles: Array.from({ length: 21 }, () => {
          return baseResponse.profiles[0];
        }),
      }).success,
    ).toBe(false);
  });
});
