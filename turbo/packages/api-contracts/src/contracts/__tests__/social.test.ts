import { describe, expect, expectTypeOf, it } from "vitest";

import {
  managedSocialKitToolCatalog,
  MANAGED_SOCIALKIT_TOOLS,
  socialKitRequestSchema,
  socialKitResponseSchema,
  type SocialKitInput,
} from "../social";

describe("managed SocialKit contract", () => {
  it("publishes one typed input and output schema per reviewed tool", () => {
    const catalog = managedSocialKitToolCatalog();

    expect(catalog).toHaveLength(38);
    expect(
      new Set(
        catalog.map((tool) => {
          return tool.name;
        }),
      ).size,
    ).toBe(38);
    expect(MANAGED_SOCIALKIT_TOOLS).toHaveLength(38);
    expect(
      catalog.find((tool) => {
        return tool.name === "youtube_search";
      }),
    ).toMatchObject({
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cache: { type: "boolean" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          results: {
            type: "array",
            items: {
              properties: {
                title: { type: "string" },
                views: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    });
    expect(
      MANAGED_SOCIALKIT_TOOLS.find((tool) => {
        return tool.name === "tiktok_comments";
      })?.collection,
    ).toMatchObject({
      resultField: "comments",
      reportedTotalField: "commentCount",
    });
  });

  it.each([
    {
      tool: "linkedin_profile",
      input: { url: "https://linkedin.com/in/example" },
      result: { headline: "Engineer", followers: 10 },
    },
    {
      tool: "twitter_tweets",
      input: { url: "https://x.com/example", cache: false },
      result: { tweets: [{ text: "Hello" }], nextCursor: null },
    },
    {
      tool: "facebook_comments",
      input: { url: "https://facebook.com/example/posts/1", limit: 10 },
      result: { comments: [{ text: "Hello", user: { name: "A" } }] },
    },
    {
      tool: "instagram_reels_search",
      input: { query: "launch", page: 2 },
      result: { items: [{ author: { username: "example" } }] },
    },
    {
      tool: "tiktok_hashtag_search",
      input: { hashtag: "launch" },
      result: { results: [{ stats: { shares: 10 } }] },
    },
    {
      tool: "youtube_search",
      input: { query: "launch" },
      result: { results: [{ title: "Launch", views: 10 }] },
    },
  ])(
    "validates representative $tool input and output",
    ({ tool, input, result }) => {
      expect(
        socialKitRequestSchema.safeParse({ tool, input }).success,
      ).toBeTruthy();
      expect(
        socialKitResponseSchema.safeParse({
          provider: "socialkit",
          tool,
          billingCategory: "request",
          billingQuantity: 1,
          creditsCharged: 3,
          collection: null,
          result,
        }).success,
      ).toBeTruthy();
    },
  );

  it("validates real JSON scalar and enum input types", () => {
    const input: SocialKitInput<"youtube_search"> = {
      query: "typed tools",
      limit: 10,
      sortBy: "views",
      cache: false,
      cache_ttl: 3_600,
    };

    expect(
      socialKitRequestSchema.safeParse({ tool: "youtube_search", input })
        .success,
    ).toBeTruthy();
    expect(
      socialKitRequestSchema.safeParse({
        tool: "youtube_search",
        input: { query: "typed tools", limit: "10" },
      }).success,
    ).toBeFalsy();
    expect(
      socialKitRequestSchema.safeParse({
        tool: "youtube_transcript",
        input: { query: "wrong input family" },
      }).success,
    ).toBeFalsy();
  });

  it("narrows standard result fields and preserves JSON extensions", () => {
    const response = socialKitResponseSchema.parse({
      provider: "socialkit",
      tool: "youtube_search",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: { state: "provider_limited", itemsReturned: 1 },
      result: {
        query: "typed tools",
        results: [
          {
            videoId: "video-1",
            title: "Typed result",
            views: 10,
            providerRanking: 0.98,
          },
        ],
        providerTrace: { source: "search" },
      },
    });

    if (response.tool !== "youtube_search") {
      throw new Error("Expected a narrowed YouTube search response");
    }
    const title: string | undefined = response.result.results?.[0]?.title;
    expectTypeOf(title).toEqualTypeOf<string | undefined>();
    expect(title).toBe("Typed result");
    expect(response.result.results?.[0]?.providerRanking).toBe(0.98);
    expect(response.result.providerTrace).toStrictEqual({ source: "search" });
  });

  it("rejects incompatible values for documented output fields", () => {
    expect(
      socialKitResponseSchema.safeParse({
        provider: "socialkit",
        tool: "youtube_search",
        billingCategory: "request",
        billingQuantity: 1,
        creditsCharged: 3,
        collection: { state: "provider_limited", itemsReturned: 1 },
        result: {
          results: [{ title: "Typed result", views: "ten" }],
        },
      }).success,
    ).toBeFalsy();
  });

  it("validates additive collection evidence and rejects unsafe relationships", () => {
    const base = {
      provider: "socialkit",
      tool: "tiktok_comments",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      result: { comments: [{ id: "comment-1" }], commentCount: 100 },
    } as const;

    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "more",
          itemsReturned: 1,
          reportedTotal: 100,
          nextInput: { cursor: "next" },
        },
      }).success,
    ).toBeTruthy();
    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "provider_limited",
          itemsReturned: 1,
          reason: "reported_total_exceeds_page",
          reportedTotal: 100,
        },
      }).success,
    ).toBeTruthy();
    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "provider_limited",
          itemsReturned: 1,
          reason: "not-a-reason",
        },
      }).success,
    ).toBeFalsy();
    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "complete",
          itemsReturned: 1,
          reportedTotal: -1,
        },
      }).success,
    ).toBeFalsy();
    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "complete",
          itemsReturned: 1,
          reportedTotal: Number.MAX_SAFE_INTEGER + 1,
        },
      }).success,
    ).toBeFalsy();
  });

  it("preserves dynamic custom summary fields beside typed standards", () => {
    const response = socialKitResponseSchema.parse({
      provider: "socialkit",
      tool: "youtube_summarize",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: null,
      result: {
        summary: "A typed standard summary",
        title: "Caller-defined title",
        isMusic: true,
      },
    });

    if (response.tool !== "youtube_summarize") {
      throw new Error("Expected a narrowed YouTube summary response");
    }
    const summary: string | undefined = response.result.summary;
    expect(summary).toBe("A typed standard summary");
    expect(response.result.title).toBe("Caller-defined title");
    expect(response.result.isMusic).toBeTruthy();
  });
});
