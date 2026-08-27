import { randomUUID } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  findManagedSocialKitTool,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIALKIT_TOOLS,
  socialContract,
  socialKitRequestSchema,
  type SocialKitRequest,
} from "@okouai/api-contracts/contracts/social";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingKey,
} from "../../../test-fixtures/system-config-seeds";
import { mockEnv } from "../../../lib/env";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { RouteEntry } from "../../route-entry";
import { createDeferredPromise } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { socialRoutes } from "../social";
import { usageRecordRoutes } from "../usage-record";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { reconcileSocialKitDownloadsForTest } from "./helpers/runtime-state";

const context = testContext();
const SOCIALKIT_BASE = "https://api.socialkit.dev";
const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_CATEGORY = MANAGED_SOCIALKIT_BILLING_CATEGORY;
const SOCIALKIT_REQUEST_CREDITS = 3;
const DEFAULT_SOCIAL_REQUEST = {
  tool: "youtube_transcript",
  input: { url: "https://youtu.be/video123" },
} as const;

const EXPECTED_SOCIALKIT_TOOLS = [
  ["linkedin_profile", "/linkedin/profile"],
  ["linkedin_company", "/linkedin/company"],
  ["linkedin_company_posts", "/linkedin/company-posts"],
  ["linkedin_post", "/linkedin/post"],
  ["linkedin_transcript", "/linkedin/transcript"],
  ["twitter_profile", "/twitter/profile"],
  ["twitter_tweets", "/twitter/tweets"],
  ["twitter_tweet", "/twitter/tweet"],
  ["twitter_thread", "/twitter/thread"],
  ["twitter_transcript", "/twitter/transcript"],
  ["facebook_stats", "/facebook/stats"],
  ["facebook_channel_stats", "/facebook/channel-stats"],
  ["facebook_transcript", "/facebook/transcript"],
  ["facebook_comments", "/facebook/comments"],
  ["facebook_summarize", "/facebook/summarize"],
  ["instagram_stats", "/instagram/stats"],
  ["instagram_channel_stats", "/instagram/channel-stats"],
  ["instagram_transcript", "/instagram/transcript"],
  ["instagram_comments", "/instagram/comments"],
  ["instagram_channel_posts", "/instagram/channel-posts"],
  ["instagram_channel_reels", "/instagram/channel-reels"],
  ["instagram_reels_search", "/instagram/reels-search"],
  ["instagram_summarize", "/instagram/summarize"],
  ["tiktok_stats", "/tiktok/stats"],
  ["tiktok_comments", "/tiktok/comments"],
  ["tiktok_transcript", "/tiktok/transcript"],
  ["tiktok_channel_stats", "/tiktok/channel-stats"],
  ["tiktok_channel_videos", "/tiktok/channel-videos"],
  ["tiktok_search", "/tiktok/search"],
  ["tiktok_hashtag_search", "/tiktok/hashtag-search"],
  ["tiktok_summarize", "/tiktok/summarize"],
  ["youtube_transcript", "/youtube/transcript"],
  ["youtube_stats", "/youtube/stats"],
  ["youtube_comments", "/youtube/comments"],
  ["youtube_channel_stats", "/youtube/channel-stats"],
  ["youtube_search", "/youtube/search"],
  ["youtube_videos", "/youtube/videos"],
  ["youtube_summarize", "/youtube/summarize"],
] as const;

const socialTestRoutes: readonly RouteEntry[] = [
  ...billingStatusRoutes,
  ...socialRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
}

interface RawRequestOptions {
  readonly requestSignal?: AbortSignal;
  readonly usagePricingResolution?: UsagePricingFixture["resolution"];
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function authenticate(actor: ApiTestUser | null): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function client(usagePricingResolution?: UsagePricingFixture["resolution"]) {
  return setupAppWithRoutes({
    context,
    routes: socialTestRoutes,
    usagePricingResolution,
  });
}

async function rawSocialRequest(
  actor: ApiTestUser | null,
  body: unknown,
  options: RawRequestOptions = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: socialTestRoutes,
    usagePricingResolution: options.usagePricingResolution,
  });
  const request = new Request("http://api.test/api/social/request", {
    method: "POST",
    headers: {
      ...authenticate(actor),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...(options.requestSignal ? { signal: options.requestSignal } : {}),
  });
  return await app.request(request);
}

async function bootstrapOnboarding(actor: ApiTestUser): Promise<void> {
  const completed = await createBddApi(context).completeOnboarding(actor);
  expect(completed.status).toBe(200);
}

async function setActorCredits(
  actor: ApiTestUser,
  credits: number,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Social test actor must belong to an organization");
  }
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits });
}

async function fundActor(actor: ApiTestUser): Promise<void> {
  await bootstrapOnboarding(actor);
  await setActorCredits(actor, 10_000);
}

async function credits(actor: ApiTestUser): Promise<number> {
  const response = await accept(
    client()(billingStatusContract).get({
      headers: authenticate(actor),
    }),
    [200],
  );
  return response.body.credits;
}

function configureProvider(): void {
  mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", "test-socialkit-key");
}

function socialPricingKey(): UsagePricingKey {
  return {
    kind: "social",
    provider: "socialkit",
    category: DEFAULT_CATEGORY,
  };
}

async function setupConfiguredPricing(): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({
    configured: [
      {
        ...socialPricingKey(),
        unitPrice: SOCIALKIT_REQUEST_CREDITS,
        unitSize: 1,
      },
    ],
  });
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

async function setupMissingPricing(): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({
    missing: [socialPricingKey()],
  });
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

function providerResponse(data: unknown = { value: "provider result" }) {
  return { success: true, data };
}

function providerItems(count: number): { readonly marker: number }[] {
  return Array.from({ length: count }, (_, marker) => {
    return { marker };
  });
}

function validProviderData(path: string): Record<string, unknown> {
  const tool = MANAGED_SOCIALKIT_TOOLS.find((candidate) => {
    return candidate.path === path;
  });
  const collection = tool?.collection;
  if (!collection) {
    return { path };
  }
  const result: Record<string, unknown> = {
    [collection.resultField]: [],
  };
  return collection.pagination.kind === "cursor" ||
    collection.pagination.kind === "page"
    ? { ...result, hasMore: false }
    : result;
}

function toolForPath(path: string) {
  const tool = MANAGED_SOCIALKIT_TOOLS.find((candidate) => {
    return candidate.path === path;
  });
  if (!tool) {
    throw new Error(`No managed SocialKit tool for ${path}`);
  }
  return tool;
}

function requestForPath(
  path: string,
  input: Readonly<Record<string, unknown>>,
): SocialKitRequest {
  const tool = toolForPath(path);
  const normalizedInput = Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      if (
        typeof value === "string" &&
        (name === "limit" || name === "page" || name === "cache_ttl")
      ) {
        return [name, Number(value)];
      }
      if (
        typeof value === "string" &&
        (name === "cache" || name === "full_details")
      ) {
        return [name, value === "true"];
      }
      return [name, value];
    }),
  );
  return socialKitRequestSchema.parse({
    tool: tool.name,
    input: normalizedInput,
  });
}

function providerHandler(
  method: "GET" | "POST",
  path: string,
  response: () => Response = () => {
    return HttpResponse.json(providerResponse());
  },
) {
  const url = `${SOCIALKIT_BASE}${path}`;
  return method === "GET" ? http.get(url, response) : http.post(url, response);
}

function managedSocialKitWarningCalls(): unknown[][] {
  return context.mocks.axiomLogging.warn.mock.calls.filter(([message]) => {
    return message === "Managed SocialKit request failed";
  });
}

describe("managed SocialKit route", () => {
  it("pins the reviewed 38-tool inventory and typed inputs", () => {
    expect(
      MANAGED_SOCIALKIT_TOOLS.map((tool) => {
        return [tool.name, tool.path];
      }),
    ).toStrictEqual(EXPECTED_SOCIALKIT_TOOLS);
    expect(MANAGED_SOCIALKIT_BILLING_CATEGORY).toBe("request");
    expect(MANAGED_SOCIALKIT_TOOLS).toHaveLength(38);
    expect(
      socialKitRequestSchema.safeParse({
        tool: "youtube_search",
        input: { query: "typed tools", limit: 10, cache: false },
      }).success,
    ).toBeTruthy();
    expect(
      socialKitRequestSchema.safeParse({
        tool: "youtube_search",
        input: { query: "typed tools", limit: "10" },
      }).success,
    ).toBeFalsy();
    expect(findManagedSocialKitTool("youtube_download")).toBeUndefined();
  });

  it("rejects agent tokens without social:read capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Social test actor must belong to an organization");
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_zero_social_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(socialContract).request({
        headers: { authorization: `Bearer ${token}` },
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: social:read",
    );
  });

  it("accepts valid requests without a feature override", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [200],
    );

    expect(response.body.provider).toBe("socialkit");
    expect(providerRequests).toBe(1);
  });

  it("accepts agent tokens and attributes usage to their run", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Social test actor must belong to an organization");
    }
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.grantProEntitlement(actor);
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    configureProvider();
    const name = `social-${randomUUID().slice(0, 8)}`;
    const compose = await api.createDirectAgent(actor, {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });
    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "Retrieve public social data",
    });
    const token = api.okouTokenForRunWithCapabilities(actor, run.runId, [
      "social:read",
    ]);
    server.use(providerHandler("GET", "/youtube/transcript"));

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: { authorization: `Bearer ${token}` },
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [200],
    );
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: actor.userId,
          primaryEmailAddressId: `email_${actor.userId}`,
          emailAddresses: [
            {
              id: `email_${actor.userId}`,
              emailAddress: `${actor.userId}@example.com`,
            },
          ],
        },
      ],
    });
    const usage = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        {
          headers: authenticate(actor),
          query: {
            page: 1,
            pageSize: 20,
            scope: "mine",
            range: "24h",
            tz: "UTC",
          },
        },
      ),
      [200],
    );

    expect(response.body.creditsCharged).toBe(SOCIALKIT_REQUEST_CREDITS);
    expect(usage.body.rows).toHaveLength(1);
    expect(usage.body.rows[0]?.runId).toBe(run.runId);
    expect(usage.body.rows[0]?.credits).toBe(SOCIALKIT_REQUEST_CREDITS);
  });

  it("forwards representative GET operations with only managed auth", async () => {
    const actor = createBddApi(context).user();
    const cases = [
      ["/youtube/transcript", "url"],
      ["/tiktok/search", "query"],
      ["/instagram/comments", "url"],
      ["/facebook/stats", "url"],
      ["/twitter/profile", "url"],
      ["/linkedin/company", "url"],
    ] as const;
    const observed: {
      path: string;
      queryName: string;
      queryValue: string;
      accessKey: string | null;
    }[] = [];
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    for (const [path] of cases) {
      server.use(
        providerHandler("GET", path, () => {
          return HttpResponse.json(providerResponse(validProviderData(path)));
        }),
      );
    }
    server.use(
      http.get(/^https:\/\/api\.socialkit\.dev\//u, ({ request }) => {
        const url = new URL(request.url);
        const query = [...url.searchParams.entries()];
        observed.push({
          path: url.pathname,
          queryName: query[0]?.[0] ?? "",
          queryValue: query[0]?.[1] ?? "",
          accessKey: request.headers.get("x-access-key"),
        });
        return HttpResponse.json(
          providerResponse(validProviderData(url.pathname)),
        );
      }),
    );
    const beforeCredits = await credits(actor);

    for (const [path, queryName] of cases) {
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(path, {
            [queryName]:
              queryName === "url"
                ? "https://example.com/public-content"
                : "public content",
          }),
        }),
        [200],
      );
      const tool = toolForPath(path);
      expect(response.body).toMatchObject({
        provider: "socialkit",
        tool: tool.name,
        billingCategory: DEFAULT_CATEGORY,
        billingQuantity: 1,
        creditsCharged: SOCIALKIT_REQUEST_CREDITS,
        result: validProviderData(path),
      });
    }

    expect(observed).toStrictEqual(
      cases.map(([path, queryName]) => {
        return {
          path,
          queryName,
          queryValue:
            queryName === "url"
              ? "https://example.com/public-content"
              : "public content",
          accessKey: "test-socialkit-key",
        };
      }),
    );
    expect(beforeCredits - (await credits(actor))).toBe(
      cases.length * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("maps typed tools to canonical GET requests without a body", async () => {
    const actor = createBddApi(context).user();
    let observedUrl = "";
    let observedAccessKey: string | null = null;
    let observedBody = "";
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    const beforeCredits = await credits(actor);
    server.use(
      http.get(
        `${SOCIALKIT_BASE}/instagram/reels-search`,
        async ({ request }) => {
          observedUrl = request.url;
          observedAccessKey = request.headers.get("x-access-key");
          observedBody = await request.text();
          return HttpResponse.json(
            providerResponse({ items: [], hasMore: false, page: 2 }),
          );
        },
      ),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: requestForPath("/instagram/reels-search", {
          query: "cats",
          page: 2,
        }),
      }),
      [200],
    );

    expect(observedUrl).toBe(
      `${SOCIALKIT_BASE}/instagram/reels-search?query=cats&page=2`,
    );
    expect(observedAccessKey).toBe("test-socialkit-key");
    expect(observedBody).toBe("");
    expect(response.body).toMatchObject({
      billingCategory: DEFAULT_CATEGORY,
      billingQuantity: 1,
      creditsCharged: SOCIALKIT_REQUEST_CREDITS,
      collection: { state: "complete", itemsReturned: 0 },
      result: { items: [], hasMore: false, page: 2 },
    });
    expect(beforeCredits - (await credits(actor))).toBe(
      SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("forwards documented pagination, filter, cache, and customization fields", async () => {
    const actor = createBddApi(context).user();
    const cases = [
      {
        path: "/tiktok/channel-videos",
        input: {
          url: "https://tiktok.com/@example",
          limit: 10,
          cursor: "next-page",
          cache: true,
          cache_ttl: 3600,
        },
        expectedQuery: {
          url: "https://tiktok.com/@example",
          limit: "10",
          cursor: "next-page",
          cache: "true",
          cache_ttl: "3600",
        },
      },
      {
        path: "/youtube/search",
        input: {
          query: "product launch",
          limit: 10,
          sortBy: "date",
          uploadDate: "month",
          type: "video",
          cache: false,
          cache_ttl: 2_592_000,
        },
        expectedQuery: {
          query: "product launch",
          limit: "10",
          sortBy: "date",
          uploadDate: "month",
          type: "video",
          cache: "false",
          cache_ttl: "2592000",
        },
      },
      {
        path: "/instagram/comments",
        input: {
          url: "https://instagram.com/p/example",
          limit: 10,
          cursor: "next-page",
          sortBy: "recent",
        },
        expectedQuery: {
          url: "https://instagram.com/p/example",
          limit: "10",
          cursor: "next-page",
          sortBy: "recent",
        },
      },
      {
        path: "/youtube/summarize",
        input: {
          url: "https://youtu.be/video123",
          custom_response: { title: "Video title" },
          custom_prompt: "Return only the requested fields",
          cache: true,
          cache_ttl: 3600,
        },
        expectedQuery: {
          url: "https://youtu.be/video123",
          custom_response: '{"title":"Video title"}',
          custom_prompt: "Return only the requested fields",
          cache: "true",
          cache_ttl: "3600",
        },
      },
    ] as const;
    const observed: { path: string; query: Record<string, string> }[] = [];
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    server.use(
      http.get(/^https:\/\/api\.socialkit\.dev\//u, ({ request }) => {
        const url = new URL(request.url);
        observed.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        });
        return HttpResponse.json(
          providerResponse(validProviderData(url.pathname)),
        );
      }),
    );

    for (const request of cases) {
      await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(request.path, request.input),
        }),
        [200],
      );
    }

    expect(observed).toStrictEqual(
      cases.map(({ path, expectedQuery }) => {
        return { path, query: expectedQuery };
      }),
    );
  });

  it("settles result-metered pages from validated returned item counts", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    const beforeCredits = await credits(actor);
    const cases = [
      {
        path: "/youtube/search",
        query: { query: "launch", limit: "100" },
        data: { results: providerItems(20) },
        expectedQuantity: 1,
        expectedState: "provider_limited",
      },
      {
        path: "/youtube/search",
        query: { query: "launch", limit: "100" },
        data: { results: providerItems(100) },
        expectedQuantity: 2,
        expectedState: "provider_limited",
      },
      {
        path: "/instagram/channel-posts",
        query: { url: "https://instagram.com/example", limit: "100" },
        data: {
          items: providerItems(20),
          hasMore: false,
        },
        expectedQuantity: 1,
        expectedState: "complete",
      },
      {
        path: "/instagram/channel-posts",
        query: { url: "https://instagram.com/example", limit: "100" },
        data: {
          items: providerItems(21),
          hasMore: false,
        },
        expectedQuantity: 2,
        expectedState: "complete",
      },
    ] as const;

    for (const testCase of cases) {
      server.use(
        providerHandler("GET", testCase.path, () => {
          return HttpResponse.json(providerResponse(testCase.data));
        }),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(testCase.path, testCase.query),
        }),
        [200],
      );

      expect(response.body.billingQuantity).toBe(testCase.expectedQuantity);
      expect(response.body.creditsCharged).toBe(
        testCase.expectedQuantity * SOCIALKIT_REQUEST_CREDITS,
      );
      expect(response.body.collection).toMatchObject({
        state: testCase.expectedState,
        itemsReturned:
          testCase.path === "/youtube/search"
            ? testCase.data.results.length
            : testCase.data.items.length,
      });
    }

    expect(beforeCredits - (await credits(actor))).toBe(
      6 * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("sends the reviewed default limit used for credit preflight", async () => {
    const actor = createBddApi(context).user();
    let observedLimit: string | null = null;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS);
    server.use(
      http.get(`${SOCIALKIT_BASE}/youtube/search`, ({ request }) => {
        observedLimit = new URL(request.url).searchParams.get("limit");
        return HttpResponse.json(
          providerResponse({
            results: providerItems(10),
          }),
        );
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: requestForPath("/youtube/search", { query: "launch" }),
      }),
      [200],
    );

    expect(observedLimit).toBe("10");
    expect(response.body.billingQuantity).toBe(1);
    expect(response.body.collection).toStrictEqual({
      state: "provider_limited",
      itemsReturned: 10,
    });
    await expect(credits(actor)).resolves.toBe(0);
  });

  it("normalizes every reviewed pagination shape", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    const cases = [
      {
        path: "/tiktok/search",
        query: { query: "launch", limit: "10" },
        data: { results: [{ id: "1" }], hasMore: true, cursor: 30 },
        expected: {
          state: "more",
          itemsReturned: 1,
          nextInput: { cursor: "30" },
        },
      },
      {
        path: "/twitter/tweets",
        query: { url: "https://x.com/example", limit: "20" },
        data: { tweets: [{ id: "1" }], nextCursor: "next-tweet" },
        expected: {
          state: "more",
          itemsReturned: 1,
          nextInput: { cursor: "next-tweet" },
        },
      },
      {
        path: "/instagram/reels-search",
        query: { query: "cats", page: "1" },
        data: { items: [{ id: "1" }], hasMore: true },
        expected: {
          state: "more",
          itemsReturned: 1,
          nextInput: { page: 2 },
        },
      },
      {
        path: "/instagram/reels-search",
        query: { query: "cats", page: "2" },
        data: { items: [{ id: "2" }], hasMore: true },
        expected: { state: "provider_limited", itemsReturned: 1 },
      },
      {
        path: "/linkedin/company-posts",
        query: { url: "https://linkedin.com/company/example", limit: "50" },
        data: { posts: [{ id: "1" }] },
        expected: { state: "provider_limited", itemsReturned: 1 },
      },
    ] as const;

    for (const testCase of cases) {
      server.use(
        providerHandler("GET", testCase.path, () => {
          return HttpResponse.json(providerResponse(testCase.data));
        }),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(testCase.path, testCase.query),
        }),
        [200],
      );

      expect(response.body.collection).toStrictEqual(testCase.expected);
    }
  });

  it("preflights the maximum result-metered quantity before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS);
    server.use(
      providerHandler("GET", "/youtube/search", () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse({ results: [] }));
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: requestForPath("/youtube/search", {
          query: "launch",
          limit: 100,
        }),
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("rejects invalid collection successes without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const cases = [
      {
        path: "/youtube/search",
        query: { query: "launch", limit: "10" },
        data: { value: "missing results" },
      },
      {
        path: "/youtube/search",
        query: { query: "launch", limit: "10" },
        data: { results: providerItems(11) },
      },
      {
        path: "/instagram/comments",
        query: { url: "https://instagram.com/p/example", limit: "10" },
        data: { comments: [], hasMore: true },
      },
      {
        path: "/instagram/reels-search",
        query: { query: "cats", page: "1" },
        data: { items: [] },
      },
    ] as const;

    for (const testCase of cases) {
      server.use(
        providerHandler("GET", testCase.path, () => {
          return HttpResponse.json(providerResponse(testCase.data));
        }),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(testCase.path, testCase.query),
        }),
        [502],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("SOCIALKIT_INVALID_RESPONSE");
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it.each([
    {
      caseName: "an unknown tool",
      body: { tool: "youtube_unknown", input: {} },
    },
    {
      caseName: "a download tool",
      body: { tool: "youtube_download", input: {} },
    },
    {
      caseName: "the removed generic request shape",
      body: { method: "GET", path: "/youtube/transcript" },
    },
    {
      caseName: "an auth input field",
      body: {
        tool: "youtube_transcript",
        input: { url: "https://youtu.be/id", access_key: "caller-key" },
      },
    },
    {
      caseName: "an input field from another tool",
      body: {
        tool: "youtube_transcript",
        input: { query: "not a transcript input" },
      },
    },
    {
      caseName: "a missing URL",
      body: { tool: "youtube_transcript", input: {} },
    },
    {
      caseName: "a missing search query",
      body: { tool: "tiktok_search", input: { limit: 1 } },
    },
    {
      caseName: "a missing hashtag",
      body: { tool: "tiktok_hashtag_search", input: { limit: 1 } },
    },
    {
      caseName: "the obsolete Instagram Reels limit field",
      body: {
        tool: "instagram_reels_search",
        input: { query: "cats", limit: 1 },
      },
    },
    {
      caseName: "an out-of-range Instagram Reels page",
      body: {
        tool: "instagram_reels_search",
        input: { query: "cats", page: 3 },
      },
    },
    {
      caseName: "an invalid cache flag",
      body: {
        tool: "youtube_stats",
        input: { url: "https://youtu.be/id", cache: "yes" },
      },
    },
    {
      caseName: "an out-of-range cache TTL",
      body: {
        tool: "youtube_stats",
        input: { url: "https://youtu.be/id", cache_ttl: 3599 },
      },
    },
    {
      caseName: "an invalid search sort order",
      body: {
        tool: "youtube_search",
        input: { query: "launch", sortBy: "popular" },
      },
    },
    {
      caseName: "a prefixed TikTok hashtag",
      body: { tool: "tiktok_hashtag_search", input: { hashtag: "#launch" } },
    },
    {
      caseName: "an invalid full-details flag",
      body: {
        tool: "youtube_videos",
        input: { url: "https://youtube.com/", full_details: "yes" },
      },
    },
    {
      caseName: "a URL with embedded credentials",
      body: {
        tool: "youtube_transcript",
        input: { url: "https://user:password@youtube.com/watch?v=id" },
      },
    },
    {
      caseName: "a bulk tool",
      body: { tool: "youtube_stats_bulk", input: {} },
    },
    {
      caseName: "a direct-video tool",
      body: {
        tool: "video_transcript",
        input: { url: "https://example.com/video.mp4" },
      },
    },
    {
      caseName: "a result limit above the provider maximum",
      body: {
        tool: "youtube_comments",
        input: { url: "https://youtu.be/id", limit: 101 },
      },
    },
    {
      caseName: "a non-integer result limit",
      body: { tool: "tiktok_search", input: { query: "launch", limit: 1.5 } },
    },
    {
      caseName: "a string result limit",
      body: { tool: "youtube_search", input: { query: "launch", limit: "10" } },
    },
  ])("rejects $caseName before provider work", async ({ body }) => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    server.use(
      http.get(/^https:\/\/api\.socialkit\.dev\//u, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
      http.post(/^https:\/\/api\.socialkit\.dev\//u, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await rawSocialRequest(actor, body);

    expect(response.status).toBe(400);
    expect(providerRequests).toBe(0);
  });

  it("rejects requests when SocialKit is not configured", async () => {
    const actor = createBddApi(context).user();
    mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", undefined);

    const response = await accept(
      client()(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_CONFIGURED");
  });

  it("returns missing pricing before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    await fundActor(actor);
    const pricing = await setupMissingPricing();
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PRICING_NOT_CONFIGURED");
    expect(providerRequests).toBe(0);
  });

  it("returns insufficient credits before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS - 1);
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("maps provider HTTP failures without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const invalidInputWarnings = [
      [
        "Managed SocialKit request failed",
        expect.objectContaining({
          context: "ManagedSocialKit",
          tool: "youtube_transcript",
          path: "/youtube/transcript",
          failureKind: "http_error",
          httpStatus: 400,
        }),
      ],
    ];
    const noWarnings: readonly unknown[] = [];
    const cases = [
      [
        400,
        "raw invalid input payload",
        400,
        "SOCIALKIT_INVALID_INPUT",
        invalidInputWarnings,
      ],
      [401, "raw missing key payload", 502, "SOCIALKIT_AUTH_ERROR", noWarnings],
      [403, "Invalid Access key", 502, "SOCIALKIT_AUTH_ERROR", noWarnings],
      [
        403,
        "Request limit exceeded for this month",
        503,
        "SOCIALKIT_QUOTA_EXHAUSTED",
        noWarnings,
      ],
      [
        403,
        "unexpected forbidden response",
        502,
        "SOCIALKIT_UPSTREAM_ERROR",
        noWarnings,
      ],
      [
        404,
        "raw missing content payload",
        404,
        "SOCIALKIT_CONTENT_UNAVAILABLE",
        noWarnings,
      ],
      [
        429,
        "raw rate limit payload",
        502,
        "SOCIALKIT_RATE_LIMITED",
        noWarnings,
      ],
      [
        500,
        "raw provider failure payload",
        502,
        "SOCIALKIT_UPSTREAM_ERROR",
        noWarnings,
      ],
    ] as const;

    for (const [
      providerStatus,
      providerMessage,
      apiStatus,
      code,
      expectedWarnings,
    ] of cases) {
      context.mocks.axiomLogging.warn.mockClear();
      server.use(
        providerHandler("GET", "/youtube/transcript", () => {
          return HttpResponse.json(
            { message: providerMessage },
            { status: providerStatus },
          );
        }),
      );
      const response = await rawSocialRequest(actor, DEFAULT_SOCIAL_REQUEST, {
        usagePricingResolution: pricing.resolution,
      });
      const body: unknown = await response.json();

      expect(response.status).toBe(apiStatus);
      expect(body).toMatchObject({ error: { code } });
      expect(JSON.stringify(body)).not.toContain(providerMessage);
      expect(managedSocialKitWarningCalls()).toStrictEqual(expectedWarnings);
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("rejects invalid or credential-leaking successes without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const invalidResponses: (() => Response)[] = [
      () => {
        return HttpResponse.text("not-json");
      },
      () => {
        return HttpResponse.json({ success: false, message: "unavailable" });
      },
      () => {
        return HttpResponse.json({ success: true });
      },
      () => {
        return HttpResponse.json(
          providerResponse({ echoed: "test-socialkit-key" }),
        );
      },
    ];

    for (const responseFactory of invalidResponses) {
      context.mocks.axiomLogging.warn.mockClear();
      server.use(
        providerHandler("GET", "/youtube/transcript", responseFactory),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: DEFAULT_SOCIAL_REQUEST,
        }),
        [502],
      );
      expectApiError(response.body);
      expect(response.body.error.code).toBe("SOCIALKIT_INVALID_RESPONSE");
      expect(JSON.stringify(response.body)).not.toContain("test-socialkit-key");
      expect(managedSocialKitWarningCalls()).toStrictEqual([]);
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("rejects declared and streamed oversized responses before billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const responses: (() => Response)[] = [
      () => {
        return HttpResponse.text(JSON.stringify(providerResponse()), {
          headers: {
            "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
          },
        });
      },
      () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                "x".repeat(MAX_PROVIDER_RESPONSE_BYTES + 1),
              ),
            );
          },
        });
        return new HttpResponse(stream, {
          headers: { "content-length": "1" },
        });
      },
    ];

    for (const responseFactory of responses) {
      context.mocks.axiomLogging.warn.mockClear();
      server.use(
        providerHandler("GET", "/youtube/transcript", responseFactory),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: DEFAULT_SOCIAL_REQUEST,
        }),
        [502],
      );
      expectApiError(response.body);
      expect(response.body.error.code).toBe("SOCIALKIT_OUTPUT_TOO_LARGE");
      expect(managedSocialKitWarningCalls()).toStrictEqual([]);
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("maps timeout and network failures without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    context.mocks.axiomLogging.warn.mockClear();
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException("timed out", "TimeoutError"));
          },
        });
        return new HttpResponse(stream);
      }),
    );
    const timeout = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [502],
    );
    expectApiError(timeout.body);
    expect(timeout.body.error.code).toBe("SOCIALKIT_REQUEST_TIMEOUT");
    expect(managedSocialKitWarningCalls()).toStrictEqual([]);

    context.mocks.axiomLogging.warn.mockClear();
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        return HttpResponse.error();
      }),
    );
    const network = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [502],
    );
    expectApiError(network.body);
    expect(network.body.error.code).toBe("SOCIALKIT_UPSTREAM_ERROR");
    expect(managedSocialKitWarningCalls()).toStrictEqual([]);
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("does not record usage when the client aborts during provider work", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected during provider work");
    abortError.name = "AbortError";
    const providerStarted = createDeferredPromise<void>(context.signal);
    const providerRelease = createDeferredPromise<void>(context.signal);
    let providerSignalAborted = false;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.get(`${SOCIALKIT_BASE}/youtube/transcript`, async ({ request }) => {
        providerStarted.resolve(undefined);
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        await providerRelease.promise;
        return HttpResponse.json(providerResponse());
      }),
    );

    const responsePromise = rawSocialRequest(actor, DEFAULT_SOCIAL_REQUEST, {
      requestSignal: controller.signal,
      usagePricingResolution: pricing.resolution,
    });
    await providerStarted.promise;
    providerRelease.resolve(undefined);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(providerSignalAborted).toBeTruthy();
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("records usage when the client disconnects after provider success", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected after provider success");
    abortError.name = "AbortError";
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        const payload = new TextEncoder().encode(
          JSON.stringify(providerResponse()),
        );
        let payloadSent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(streamController) {
            if (!payloadSent) {
              payloadSent = true;
              streamController.enqueue(payload);
              return;
            }
            streamController.close();
            setImmediate(() => {
              controller.abort(abortError);
            });
          },
        });
        return new HttpResponse(stream);
      }),
    );

    const response = await rawSocialRequest(actor, DEFAULT_SOCIAL_REQUEST, {
      requestSignal: controller.signal,
      usagePricingResolution: pricing.resolution,
    });

    expect(response.status).toBe(200);
    expect(controller.signal.aborted).toBeTruthy();
    expect(beforeCredits - (await credits(actor))).toBe(
      SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("records concurrent multi-unit requests exactly once each", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      providerHandler("GET", "/youtube/search", () => {
        providerRequests += 1;
        return HttpResponse.json(
          providerResponse({
            results: providerItems(100),
          }),
        );
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);
    const request = requestForPath("/youtube/search", {
      query: "launch",
      limit: 100,
    });

    const [first, second] = await Promise.all([
      accept(
        socialClient.request({
          headers: authenticate(actor),
          body: request,
        }),
        [200],
      ),
      accept(
        socialClient.request({
          headers: authenticate(actor),
          body: request,
        }),
        [200],
      ),
    ]);

    expect(first.body.billingQuantity).toBe(2);
    expect(second.body.billingQuantity).toBe(2);
    expect(first.body.creditsCharged).toBe(2 * SOCIALKIT_REQUEST_CREDITS);
    expect(second.body.creditsCharged).toBe(2 * SOCIALKIT_REQUEST_CREDITS);
    expect(providerRequests).toBe(2);
    expect(beforeCredits - (await credits(actor))).toBe(
      4 * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("materializes a ready v2 download and bills provider credits once", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    mockNow(Date.UTC(2000, 0, 1));
    const payload = new TextEncoder().encode("downloaded social video");
    const providerJobId = `provider-download-${randomUUID()}`;
    let startBody: unknown;
    let providerPolls = 0;
    context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.post(
        `${SOCIALKIT_BASE}/v2/youtube/download`,
        async ({ request }) => {
          startBody = await request.json();
          return HttpResponse.json({
            success: true,
            data: {
              jobId: providerJobId,
              status: "queued",
              statusUrl: `${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`,
            },
          });
        },
      ),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        providerPolls += 1;
        if (providerPolls === 1) {
          return HttpResponse.json({
            success: true,
            data: {
              jobId: providerJobId,
              status: "processing",
            },
          });
        }
        return HttpResponse.json({
          success: true,
          data: {
            jobId: providerJobId,
            status: "ready",
            platform: "youtube",
            downloadUrl: "https://media.socialkit.test/download-1",
            durationSeconds: 61,
            fileSizeMB: "1.5 MB",
            creditsCost: 2,
            quality: "480p",
            format: "mp4",
            title: "Public video",
            thumbnail: "https://media.socialkit.test/thumbnail.jpg",
          },
        });
      }),
      http.get("https://media.socialkit.test/download-1", () => {
        return new HttpResponse(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      }),
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [] });
      }
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: "socialkit-upload-1" });
      }
      if (command instanceof UploadPartCommand) {
        return Promise.resolve({ ETag: '"socialkit-etag-1"' });
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const processing = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const completed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    const creditsAfterCompletion = await credits(actor);
    await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(startBody).toStrictEqual({
      url: "https://youtu.be/public-video",
      max_duration: 120,
      quality: "720p",
      format: "mp4",
    });
    expect(created.body.status).toBe("processing");
    expect(processing.body.status).toBe("processing");
    expect(completed.body).toMatchObject({
      status: "completed",
      provider: {
        durationSeconds: 61,
        creditsCost: 2,
        thumbnail: "https://media.socialkit.test/thumbnail.jpg",
      },
      billing: { quantity: 2, creditsCharged: 6 },
      artifact: {
        id: created.body.downloadId,
        contentType: "video/mp4",
        sizeBytes: payload.byteLength,
      },
    });
    expect(beforeCredits - creditsAfterCompletion).toBe(6);
    await expect(credits(actor)).resolves.toBe(creditsAfterCompletion);
    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        return command instanceof UploadPartCommand;
      }),
    ).toHaveLength(1);
  });

  it("rejects credential-bearing download URLs before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        providerRequests += 1;
        return HttpResponse.error();
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://user:password@youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [400],
    );

    expectApiError(response.body);
    expect(providerRequests).toBe(0);
  });

  it("preflights the maximum download duration before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        providerRequests += 1;
        return HttpResponse.error();
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("does not expose download state to another user", async () => {
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Social test owner must belong to an organization");
    }
    const other = createBddApi(context).user({ orgId: owner.orgId });
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(owner);
    const providerJobId = `provider-owner-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "failed" });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);
    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(owner),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();

    const response = await accept(
      socialClient.getDownload({
        headers: authenticate(other),
        params: { downloadId: created.body.downloadId },
      }),
      [404],
    );

    expect(response.status).toBe(404);
    expectApiError(response.body);
  });

  it("keeps transient provider polling failures unbilled and retryable", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerJobId = `provider-transient-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json(
          { message: "temporary outage" },
          { status: 503 },
        );
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const pending = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(pending.body).toMatchObject({
      status: "processing",
      billing: null,
      error: { billed: false, retryable: true },
    });
    await flushWaitUntilForTest();
    await expect(credits(actor)).resolves.toBe(beforeCredits);

    mockNow(now() + 61_000);
    server.use(
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "failed" });
      }),
    );
    await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const terminal = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    expect(terminal.body.status).toBe("provider_failed");
  });

  it("defers a claimed download when its reconciliation budget expires", async () => {
    const actor = createBddApi(context).user();
    const reconciliation = new AbortController();
    const abortError = new DOMException(
      "SocialKit reconciliation timed out",
      "TimeoutError",
    );
    let suppliedReconciliationSignal = false;
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      if (milliseconds === 280_000 && !suppliedReconciliationSignal) {
        suppliedReconciliationSignal = true;
        return reconciliation.signal;
      }
      return undefined;
    });
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerJobId = `provider-timeout-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        reconciliation.abort(abortError);
        return HttpResponse.json({
          jobId: providerJobId,
          status: "processing",
        });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await expect(flushWaitUntilForTest()).rejects.toBe(abortError);
    const deferred = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(deferred.body).toMatchObject({
      status: "processing",
      billing: null,
      error: {
        code: "SOCIALKIT_RECONCILIATION_FAILED",
        billed: false,
        retryable: true,
      },
    });
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("reconciles an expired claimed download through the bounded cron batch", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const payload = new TextEncoder().encode("cron-reconciled social video");
    const providerJobId = `provider-cron-${randomUUID()}`;
    let providerReady = false;
    context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        if (!providerReady) {
          return HttpResponse.json(
            { message: "temporary outage" },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          jobId: providerJobId,
          status: "ready",
          platform: "youtube",
          downloadUrl: "https://media.socialkit.test/cron-download",
          durationSeconds: 60,
          fileSizeMB: 1,
          creditsCost: 1,
          quality: "720p",
          format: "mp4",
        });
      }),
      http.get("https://media.socialkit.test/cron-download", () => {
        return new HttpResponse(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      }),
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: "socialkit-cron-upload" });
      }
      if (command instanceof UploadPartCommand) {
        return Promise.resolve({ ETag: '"socialkit-cron-etag"' });
      }
      return Promise.resolve({});
    });
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const blocked = await reconcileSocialKitDownloadsForTest(context, [
      created.body.downloadId,
    ]);
    providerReady = true;
    mockNow(now() + 61_000);

    const processed = await reconcileSocialKitDownloadsForTest(context, [
      created.body.downloadId,
    ]);
    const completed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(blocked).toBe(0);
    expect(processed).toBe(1);
    expect(completed.body).toMatchObject({
      status: "completed",
      billing: { quantity: 1, creditsCharged: 3 },
      artifact: { sizeBytes: payload.byteLength },
    });
    expect(beforeCredits - (await credits(actor))).toBe(3);
  });

  it("reuses a completed multipart result and bills concurrent retries once", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const payload = new TextEncoder().encode("retryable social video");
    const providerJobId = `provider-retry-${randomUUID()}`;
    let providerStarts = 0;
    let multipartAttempts = 0;
    let artifactStored = false;
    const createdDownload: { id?: string } = {};
    context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        providerStarts += 1;
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "ready",
          platform: "youtube",
          downloadUrl: "https://media.socialkit.test/retry-download",
          durationSeconds: 61,
          fileSizeMB: 1,
          creditsCost: 2,
          quality: "720p",
          format: "mp4",
          title: { untrusted: true },
          thumbnail: "https://media.socialkit.test/retry-download#preview",
        });
      }),
      http.get("https://media.socialkit.test/retry-download", () => {
        return new HttpResponse(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      }),
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        if (!artifactStored) {
          const error = new Error("Artifact not found");
          error.name = "NotFound";
          return Promise.reject(error);
        }
        const createdDownloadId = createdDownload.id;
        if (!createdDownloadId) {
          return Promise.reject(new Error("Missing created download id"));
        }
        const filename = `socialkit-${createdDownloadId.slice(0, 8)}.mp4`;
        const key = buildArtifactKeyV2(
          createdDownloadId,
          filename,
          "socialkit",
        );
        if (command.input.Key !== key) {
          return Promise.reject(new Error("Unexpected artifact key"));
        }
        return Promise.resolve({
          ContentLength: payload.byteLength,
          ContentType: "video/mp4",
          LastModified: new Date("2026-08-27T00:00:00.000Z"),
          Metadata: {
            "artifact-id": createdDownloadId,
            filename: encodeURIComponent(filename),
            "user-id": encodeURIComponent(actor.userId),
            "public-brand": "vm0",
          },
        });
      }
      if (command instanceof CreateMultipartUploadCommand) {
        multipartAttempts += 1;
        return Promise.resolve({
          UploadId: `socialkit-retry-${multipartAttempts}`,
        });
      }
      if (command instanceof UploadPartCommand) {
        return Promise.resolve({ ETag: '"socialkit-retry-etag"' });
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        artifactStored = true;
        return Promise.reject(new Error("R2 completion response was lost"));
      }
      return Promise.resolve({});
    });
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    createdDownload.id = created.body.downloadId;
    await flushWaitUntilForTest();
    const failed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    const creditsAfterFailure = await credits(actor);

    expect(failed.body).toMatchObject({
      status: "artifact_failed",
      billing: { quantity: 2, creditsCharged: 6 },
      error: { billed: true, retryable: true },
    });
    expect(failed.body.provider).not.toHaveProperty("title");
    expect(failed.body.provider).not.toHaveProperty("thumbnail");
    expect(beforeCredits - creditsAfterFailure).toBe(6);
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return command instanceof AbortMultipartUploadCommand;
      }),
    ).toBeTruthy();

    mockNow(now() + 61_000);
    await Promise.all([
      accept(
        socialClient.getDownload({
          headers: authenticate(actor),
          params: { downloadId: created.body.downloadId },
        }),
        [200],
      ),
      accept(
        socialClient.getDownload({
          headers: authenticate(actor),
          params: { downloadId: created.body.downloadId },
        }),
        [200],
      ),
    ]);
    await flushWaitUntilForTest();
    const completed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(completed.body.status).toBe("completed");
    expect(providerStarts).toBe(1);
    expect(multipartAttempts).toBe(1);
    await expect(credits(actor)).resolves.toBe(creditsAfterFailure);
  });

  it("marks provider download failures free and terminal", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerJobId = `provider-failed-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/tiktok/download`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "queued",
        });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "failed",
        });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "tiktok",
          url: "https://www.tiktok.com/@public/video/1",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const failed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(failed.body.status).toBe("provider_failed");
    expect(failed.body.billing).toBeNull();
    expect(failed.body.error).toMatchObject({
      billed: false,
      retryable: false,
    });
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("rejects a ready response for a different platform without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerJobId = `provider-platform-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "ready",
          platform: "facebook",
          downloadUrl: "https://media.socialkit.test/wrong-platform",
          durationSeconds: 60,
          fileSizeMB: "1 MB",
          creditsCost: 1,
          quality: "720p",
          format: "mp4",
        });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const failed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(failed.body).toMatchObject({
      status: "provider_failed",
      billing: null,
      error: {
        code: "SOCIALKIT_INVALID_DOWNLOAD_RESPONSE",
        billed: false,
        retryable: false,
      },
    });
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });
});
