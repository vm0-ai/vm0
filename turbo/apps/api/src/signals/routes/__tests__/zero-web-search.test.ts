import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import {
  ZERO_WEB_SEARCH_MAX_SNIPPET_CHARS,
  ZERO_WEB_SEARCH_MAX_TITLE_CHARS,
  zeroWebSearchContract,
  type ZeroWebSearchRequest,
} from "@vm0/api-contracts/contracts/zero-web-search";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { zeroUsageRunsContract } from "@vm0/api-contracts/contracts/zero-usage-daily";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  deleteUsagePricingRows,
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now, nowDate } from "../../external/time";
import type { RouteEntry } from "../../route-entry";
import { createDeferredPromise } from "../../utils";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroWebSearchRoutes } from "../zero-web-search";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  generatedStripeCustomerId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;

const webSearchRoutes: readonly RouteEntry[] = [
  ...zeroBillingStatusRoutes,
  ...zeroWebSearchRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
}

interface RawRequestOptions {
  readonly instanceSignal?: AbortSignal;
  readonly requestSignal?: AbortSignal;
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

  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function client() {
  return setupAppWithRoutes({ context, routes: webSearchRoutes });
}

async function rawWebSearchRequest(
  actor: ApiTestUser | null,
  body: unknown,
  options: RawRequestOptions = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: options.instanceSignal ?? context.signal,
    routes: webSearchRoutes,
  });
  const request = new Request("http://api.test/api/zero/web-search", {
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
  await createBddApi(context).bootstrapOnboarding(actor, {
    displayName: "Zero Web Search Test",
  });
}

async function setActorCredits(
  actor: ApiTestUser,
  credits: number,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error(
      "Zero Web Search test actor must belong to an organization",
    );
  }
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits });
}

async function fundActor(actor: ApiTestUser): Promise<void> {
  await bootstrapOnboarding(actor);
  await setActorCredits(actor, 1000);
}

async function credits(actor: ApiTestUser): Promise<number> {
  const response = await accept(
    client()(zeroBillingStatusContract).get({
      headers: authenticate(actor),
    }),
    [200],
  );
  return response.body.credits;
}

function configureProvider(): void {
  mockEnv("ZERO_WEB_SEARCH_PERPLEXITY_TOKEN", "test-perplexity-token");
}

async function seedWebSearchPricing(): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "web-search",
      provider: "perplexity",
      category: "request",
      unitPrice: 5,
      unitSize: 1,
    },
  ]);
}

function defaultRequest(
  overrides: Partial<ZeroWebSearchRequest> = {},
): ZeroWebSearchRequest {
  return {
    query: "latest AI regulation",
    limit: 5,
    ...overrides,
  };
}

function providerResponse() {
  return {
    id: "search-request-id",
    server_time: "2026-07-14T10:00:00Z",
    results: [
      {
        title: "AI regulation update",
        url: "https://example.com/update",
        snippet: "A relevant public-web excerpt.",
        date: "2026-07-13",
        last_updated: "2026-07-14",
      },
    ],
  };
}

describe("zero web-search route", () => {
  it("rejects zero tokens without web-search:read capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error(
        "Zero Web Search test actor must belong to an organization",
      );
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_zero_web_search_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: { authorization: `Bearer ${token}` },
        body: defaultRequest(),
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: web-search:read",
    );
  });

  it("accepts agent tokens and attributes usage to their run", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error(
        "Zero Web Search test actor must belong to an organization",
      );
    }
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.grantProEntitlement(actor);
    await fundActor(actor);
    await seedWebSearchPricing();
    configureProvider();
    const name = `web-search-${randomUUID().slice(0, 8)}`;
    const compose = await api.createCompose(actor, {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });
    const run = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "Find current public information",
    });
    const token = api.zeroTokenForRunWithCapabilities(actor, run.runId, [
      "web-search:read",
    ]);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json(providerResponse());
      }),
    );
    context.mocks.ably.publish.mockClear();

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: { authorization: `Bearer ${token}` },
        body: defaultRequest(),
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
      setupApp({ context })(zeroUsageRunsContract).get({
        headers: authenticate(actor),
        query: { runId: run.runId },
      }),
      [200],
    );

    expect(response.body.creditsCharged).toBe(5);
    expect(usage.body.runs).toHaveLength(1);
    expect(usage.body.runs[0]?.runId).toBe(run.runId);
    expect(usage.body.runs[0]?.creditsCharged).toBe(5);
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      "billing:changed",
      null,
    );
  });

  it("rejects invalid filters before calling Perplexity", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await rawWebSearchRequest(actor, {
      query: "latest AI regulation",
      limit: 11,
      domains: ["https://example.com"],
    });

    expect(response.status).toBe(400);
    expect(providerRequests).toBe(0);
  });

  it("rejects requests when the provider is not configured", async () => {
    const actor = createBddApi(context).user();
    mockEnv("ZERO_WEB_SEARCH_PERPLEXITY_TOKEN", undefined);

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_CONFIGURED");
  });

  it("returns missing pricing before calling Perplexity", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    await fundActor(actor);
    await deleteUsagePricingRows({
      kind: "web-search",
      provider: "perplexity",
      categories: ["request"],
    });
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PRICING_NOT_CONFIGURED");
    expect(providerRequests).toBe(0);
  });

  it("returns insufficient credits before calling Perplexity", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    await seedWebSearchPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, 0);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("uses allowance for runless searches when org credits are exhausted", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error(
        "Zero Web Search test actor must belong to an organization",
      );
    }
    configureProvider();
    await seedWebSearchPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, 0);
    const effectiveAt = nowDate();
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId: actor.orgId,
      userId: actor.userId,
      customerId: generatedStripeCustomerId(),
      subscriptionId: `sub_web_search_allowance_${randomUUID()}`,
      effectiveAt,
      expiresAt: new Date(effectiveAt.getTime() + 365 * 24 * 60 * 60 * 1000),
      shortWindowSeconds: 5 * 60 * 60,
      shortWindowUnits: 100,
      weeklyWindowSeconds: 7 * 24 * 60 * 60,
      weeklyWindowUnits: 200,
    });
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );
    const status = await accept(
      client()(zeroBillingStatusContract).get({
        headers: authenticate(actor),
      }),
      [200],
    );

    expect(response.body.creditsCharged).toBe(0);
    expect(status.body.credits).toBe(0);
    expect(
      Object.fromEntries(
        status.body.usageAllowance?.windows.map((window) => {
          return [window.kind, window.consumedUnits];
        }) ?? [],
      ),
    ).toStrictEqual({ short: 5, weekly: 5 });
  });

  it("translates filtered searches and records successful usage", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    let authorization: string | null = null;
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, async ({ request }) => {
        requestBody = await request.json();
        authorization = request.headers.get("authorization");
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest({
          limit: 3,
          recency: "week",
          domains: ["example.com", "docs.example.com"],
        }),
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toStrictEqual({
      query: "latest AI regulation",
      max_results: 3,
      max_tokens: 6000,
      max_tokens_per_page: 1200,
      search_recency_filter: "week",
      search_domain_filter: ["example.com", "docs.example.com"],
    });
    expect(authorization).toBe("Bearer test-perplexity-token");
    expect(response.body).toStrictEqual({
      query: "latest AI regulation",
      limit: 3,
      recency: "week",
      domains: ["example.com", "docs.example.com"],
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
          publishedDate: "2026-07-13",
          lastUpdatedDate: "2026-07-14",
        },
      ],
    });
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("bills valid empty results", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json({ id: "empty", results: [] });
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(response.body.results).toStrictEqual([]);
    expect(response.body.creditsCharged).toBe(5);
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("truncates valid text under field and total output bounds", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const longTitle = `${"t".repeat(ZERO_WEB_SEARCH_MAX_TITLE_CHARS - 1)}😀`;
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json({
          results: Array.from({ length: 5 }, (_, index) => {
            return {
              title: index === 0 ? longTitle : `Result ${index + 1}`,
              url: `https://example.com/${index}`,
              snippet: "s".repeat(ZERO_WEB_SEARCH_MAX_SNIPPET_CHARS + 100),
            };
          }),
        });
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );

    expect(response.body.results[0]?.title).toHaveLength(
      ZERO_WEB_SEARCH_MAX_TITLE_CHARS - 1,
    );
    expect(
      response.body.results.slice(0, 4).every((result) => {
        return result.snippet.length === ZERO_WEB_SEARCH_MAX_SNIPPET_CHARS;
      }),
    ).toBeTruthy();
    expect(response.body.results[4]?.snippet).toBe("");
    expect(
      response.body.results.reduce((total, result) => {
        return total + result.snippet.length;
      }, 0),
    ).toBe(32_000);
  });

  it("neutralizes provider control characters in returned text", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json({
          results: [
            {
              title: "Result\u001b]52;c;clipboard\u0007 title",
              url: "https://example.com/result",
              snippet: "first line\rsecond line\u009b31m",
              date: "2026-07-14\nforged",
            },
          ],
        });
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );

    expect(response.body.results).toStrictEqual([
      {
        rank: 1,
        title: "Result ]52;c;clipboard  title",
        url: "https://example.com/result",
        snippet: "first line second line 31m",
        publishedDate: "2026-07-14 forged",
      },
    ]);
  });

  it.each([
    ["invalid JSON", "not-json", "PERPLEXITY_INVALID_RESPONSE"],
    [
      "missing results",
      JSON.stringify({ id: "missing" }),
      "PERPLEXITY_INVALID_RESPONSE",
    ],
    [
      "invalid URL",
      JSON.stringify({
        results: [{ title: "Bad", url: "file:///secret", snippet: "bad" }],
      }),
      "PERPLEXITY_INVALID_RESPONSE",
    ],
    [
      "URL containing a control character",
      JSON.stringify({
        results: [
          {
            title: "Bad",
            url: "https://exam\nple.com",
            snippet: "bad",
          },
        ],
      }),
      "PERPLEXITY_INVALID_RESPONSE",
    ],
    [
      "URL exceeding the bound after normalization",
      JSON.stringify({
        results: [
          {
            title: "Bad",
            url: `https://example.com/${"界".repeat(700)}`,
            snippet: "bad",
          },
        ],
      }),
      "PERPLEXITY_INVALID_RESPONSE",
    ],
  ])("rejects %s without recording usage", async (_name, body, code) => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.text(body);
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe(code);
    expect(afterCredits).toBe(beforeCredits);
  });

  it("maps and bounds provider errors without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json(
          { message: `\u001b]52;c;clipboard\u0007${"x".repeat(5000)}` },
          { status: 500 },
        );
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PERPLEXITY_ERROR");
    expect(response.body.error.message).toHaveLength(4096);
    expect(response.body.error.message.endsWith("...")).toBeTruthy();
    expect(response.body.error.message).not.toContain("\u001b");
    expect(response.body.error.message).not.toContain("\u0007");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("maps provider rate limiting without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json({ message: "slow down" }, { status: 429 });
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PERPLEXITY_RATE_LIMITED");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("maps provider transport timeouts without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException("timed out", "TimeoutError"));
          },
        });
        return new HttpResponse(stream);
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("WEB_SEARCH_TIMEOUT");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects an empty successful provider body without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PERPLEXITY_INVALID_RESPONSE");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects declared oversized responses before reading or billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.text(JSON.stringify(providerResponse()), {
          headers: {
            "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
          },
        });
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("WEB_SEARCH_OUTPUT_TOO_LARGE");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects streamed oversized responses with dishonest lengths", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
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
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("WEB_SEARCH_OUTPUT_TOO_LARGE");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("accepts a streamed response without a declared length and bills it", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const payload = JSON.stringify(providerResponse());
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        });
        return new HttpResponse(stream);
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(response.body.results).toHaveLength(1);
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("accepts an exact-size streamed response and bills it", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const json = JSON.stringify({ results: [] });
    const payload = `${json}${" ".repeat(MAX_PROVIDER_RESPONSE_BYTES - json.length)}`;
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        const midpoint = Math.floor(payload.length / 2);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(payload.slice(0, midpoint)));
            controller.enqueue(encoder.encode(payload.slice(midpoint)));
            controller.close();
          },
        });
        return new HttpResponse(stream, {
          headers: {
            "content-length": String(MAX_PROVIDER_RESPONSE_BYTES),
          },
        });
      }),
    );

    const response = await accept(
      client()(zeroWebSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(response.body.results).toStrictEqual([]);
    expect(beforeCredits - afterCredits).toBe(5);
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
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, async ({ request }) => {
        providerStarted.resolve(undefined);
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        await providerRelease.promise;
        return HttpResponse.json(providerResponse());
      }),
    );

    const responsePromise = rawWebSearchRequest(actor, defaultRequest(), {
      requestSignal: controller.signal,
    });
    await providerStarted.promise;
    providerRelease.resolve(undefined);
    const response = await responsePromise;
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    expect(providerSignalAborted).toBeTruthy();
    expect(afterCredits).toBe(beforeCredits);
  });

  it("records usage when the client disconnects after provider success", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected after provider success");
    abortError.name = "AbortError";
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
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

    const response = await rawWebSearchRequest(actor, defaultRequest(), {
      requestSignal: controller.signal,
    });
    const afterCredits = await credits(actor);

    expect(response.status).toBe(200);
    expect(controller.signal.aborted).toBeTruthy();
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("records both concurrent successful searches", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );
    const searchClient = client();

    const [first, second] = await Promise.all([
      accept(
        searchClient(zeroWebSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest({ query: "first query" }),
        }),
        [200],
      ),
      accept(
        searchClient(zeroWebSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest({ query: "second query" }),
        }),
        [200],
      ),
    ]);
    const afterCredits = await credits(actor);

    expect(first.body.creditsCharged).toBe(5);
    expect(second.body.creditsCharged).toBe(5);
    expect(providerRequests).toBe(2);
    expect(beforeCredits - afterCredits).toBe(10);
  });

  it("does not return success when usage processing fails", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await seedWebSearchPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, async () => {
        await deleteUsagePricingRows({
          kind: "web-search",
          provider: "perplexity",
          categories: ["request"],
        });
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await rawWebSearchRequest(actor, defaultRequest());
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
    expect(afterCredits).toBe(beforeCredits);
  });
});
