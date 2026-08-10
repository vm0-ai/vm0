import { Buffer } from "node:buffer";

import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { zeroSeoContract } from "@vm0/api-contracts/contracts/zero-seo";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroSeoRoutes } from "../zero-seo";

const context = testContext();
const SEO_ROUTES = Object.freeze([
  ...zeroBillingStatusRoutes,
  ...zeroSeoRoutes,
]);
const DATAFORSEO_BASE_URL = "https://api.dataforseo.com";
const SERPAPI_SEARCH_URL = "https://serpapi.com/search.json";

type OrgApiTestUser = ApiTestUser & { readonly orgId: string };

function authenticate(actor: ApiTestUser) {
  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: SEO_ROUTES });
}

async function seedSeoPricing(): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "seo",
      provider: "dataforseo",
      category: "provider_cost_usd_micros",
      unitPrice: 1250,
      unitSize: 1_000_000,
    },
    {
      kind: "seo",
      provider: "serpapi",
      category: "search",
      unitPrice: 32,
      unitSize: 1,
    },
  ]);
}

async function seedActor(featureEnabled = true): Promise<OrgApiTestUser> {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Zero SEO test actor must belong to an organization");
  }
  const orgActor = { ...actor, orgId: actor.orgId };
  await createRunsApi(context).grantProEntitlement(orgActor);
  await seedSeoPricing();
  if (featureEnabled) {
    await updateFeatureSwitchesForUser(context, orgActor, {
      [FeatureSwitchKey.SeoBuiltIn]: true,
    });
  }
  return orgActor;
}

async function seedUnfundedActor(): Promise<OrgApiTestUser> {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Zero SEO test actor must belong to an organization");
  }
  const orgActor = { ...actor, orgId: actor.orgId };
  const onboarding = await createBddApi(context).completeOnboarding(orgActor);
  expect(onboarding.status).toBe(200);
  await seedOrgMetadata({ orgId: orgActor.orgId, tier: "pro", credits: 0 });
  await seedSeoPricing();
  await updateFeatureSwitchesForUser(context, orgActor, {
    [FeatureSwitchKey.SeoBuiltIn]: true,
  });
  return orgActor;
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

function configureProviders(): void {
  mockEnv("ZERO_SEO_SERPAPI_TOKEN", "test-serpapi-token");
  mockEnv("ZERO_SEO_DATAFORSEO_LOGIN", "test-dataforseo-login");
  mockEnv("ZERO_SEO_DATAFORSEO_PASSWORD", "test-dataforseo-password");
}

function dataForSeoResponse(cost: number, result: unknown) {
  return {
    version: "0.1.20260810",
    status_code: 20_000,
    status_message: "Ok.",
    time: "0.1000 sec.",
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: "seo-task",
        status_code: 20_000,
        status_message: "Ok.",
        time: "0.1000 sec.",
        cost,
        result_count: 1,
        result,
      },
    ],
  };
}

describe("zero SEO routes", () => {
  it("rejects requests while the built-in feature is disabled", async () => {
    const actor = await seedActor(false);
    configureProviders();
    let providerRequests = 0;
    server.use(
      http.post(`${DATAFORSEO_BASE_URL}/v3/backlinks/summary/live`, () => {
        providerRequests += 1;
        return HttpResponse.json(dataForSeoResponse(0.024, [{}]));
      }),
    );

    const response = await accept(
      client()(zeroSeoContract).backlinksSummary({
        headers: authenticate(actor),
        body: { target: "example.com", includeSubdomains: true },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Zero SEO is not enabled", code: "FORBIDDEN" },
    });
    expect(providerRequests).toBe(0);
  });

  it("rejects zero tokens without the seo capability", async () => {
    const actor = await seedActor();
    if (!actor.orgId) {
      throw new Error("Zero SEO test actor must belong to an organization");
    }
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_zero_seo_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(zeroSeoContract).serp({
        headers: { authorization: `Bearer ${token}` },
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
          countryCode: "us",
          device: "desktop",
          limit: 10,
        },
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: seo:read",
    );
  });

  it("rejects insufficient credits before calling the provider", async () => {
    const actor = await seedUnfundedActor();
    configureProviders();
    let providerRequests = 0;
    server.use(
      http.get(SERPAPI_SEARCH_URL, () => {
        providerRequests += 1;
        return HttpResponse.json({});
      }),
    );

    const response = await accept(
      client()(zeroSeoContract).serp({
        headers: authenticate(actor),
        body: {
          query: "technical seo",
          provider: "serpapi",
          engine: "google",
          location: "United States",
          languageCode: "en",
          countryCode: "us",
          device: "desktop",
          limit: 10,
        },
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("does not charge credits when the provider fails", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    server.use(
      http.get(SERPAPI_SEARCH_URL, () => {
        return HttpResponse.json({ error: "slow down" }, { status: 429 });
      }),
    );

    const response = await accept(
      client()(zeroSeoContract).serp({
        headers: authenticate(actor),
        body: {
          query: "technical seo",
          provider: "serpapi",
          engine: "google",
          location: "United States",
          languageCode: "en",
          countryCode: "us",
          device: "desktop",
          limit: 10,
        },
      }),
      [502],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("SEO_PROVIDER_RATE_LIMITED");
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("maps DataForSEO operations and bills the reported cost with a 25% markup", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    const authorization = `Basic ${Buffer.from(
      "test-dataforseo-login:test-dataforseo-password",
    ).toString("base64")}`;
    const observed: unknown[] = [];
    server.use(
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/organic/live/advanced`,
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(authorization);
          observed.push(await request.json());
          return HttpResponse.json(
            dataForSeoResponse(0.002, [{ keyword: "technical seo" }]),
          );
        },
      ),
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/dataforseo_labs/keyword_ideas/live`,
        async ({ request }) => {
          observed.push(await request.json());
          return HttpResponse.json(
            dataForSeoResponse(0.024, [{ keyword: "seo audit" }]),
          );
        },
      ),
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/dataforseo_labs/ranked_keywords/live`,
        async ({ request }) => {
          observed.push(await request.json());
          return HttpResponse.json(
            dataForSeoResponse(0.012, [{ keyword: "example" }]),
          );
        },
      ),
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/backlinks/summary/live`,
        async ({ request }) => {
          observed.push(await request.json());
          return HttpResponse.json(
            dataForSeoResponse(0.024, [{ backlinks: 100 }]),
          );
        },
      ),
    );
    const headers = authenticate(actor);
    const seoClient = client()(zeroSeoContract);

    const serp = await accept(
      seoClient.serp({
        headers,
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
          countryCode: "us",
          device: "desktop",
          limit: 10,
        },
      }),
      [200],
    );
    const ideas = await accept(
      seoClient.keywordIdeas({
        headers,
        body: {
          keyword: "technical seo",
          location: "United States",
          languageCode: "en",
          limit: 100,
        },
      }),
      [200],
    );
    const ranked = await accept(
      seoClient.rankedKeywords({
        headers,
        body: {
          target: "example.com",
          location: "United States",
          languageCode: "en",
          limit: 50,
        },
      }),
      [200],
    );
    const backlinks = await accept(
      seoClient.backlinksSummary({
        headers,
        body: { target: "example.com", includeSubdomains: false },
      }),
      [200],
    );

    expect(serp.body).toMatchObject({
      operation: "serp",
      provider: "dataforseo",
      billingQuantity: 2000,
      providerCostUsd: 0.002,
      creditsCharged: 3,
    });
    expect(ideas.body.creditsCharged).toBe(30);
    expect(ranked.body.creditsCharged).toBe(15);
    expect(backlinks.body.creditsCharged).toBe(30);
    expect(observed).toStrictEqual([
      [
        {
          keyword: "technical seo",
          location_name: "United States",
          language_code: "en",
          device: "desktop",
          depth: 10,
        },
      ],
      [
        {
          keywords: ["technical seo"],
          location_name: "United States",
          language_code: "en",
          limit: 100,
        },
      ],
      [
        {
          target: "example.com",
          location_name: "United States",
          language_code: "en",
          limit: 50,
        },
      ],
      [{ target: "example.com", include_subdomains: false }],
    ]);
    expect(beforeCredits - (await credits(actor))).toBe(78);
  });

  it("routes supported DataForSEO search engines to their live endpoints", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    const observed: unknown[] = [];
    server.use(
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/bing/organic/live/advanced`,
        async ({ request }) => {
          observed.push(await request.json());
          return HttpResponse.json(
            dataForSeoResponse(0.002, [{ keyword: "technical seo" }]),
          );
        },
      ),
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/maps/live/advanced`,
        async ({ request }) => {
          observed.push(await request.json());
          return HttpResponse.json(
            dataForSeoResponse(0.002, [{ keyword: "coffee shops" }]),
          );
        },
      ),
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/news/live/advanced`,
        async ({ request }) => {
          observed.push(await request.json());
          return HttpResponse.json(
            dataForSeoResponse(0.02, [{ keyword: "ai news" }]),
          );
        },
      ),
    );
    const seoClient = client()(zeroSeoContract);
    const headers = authenticate(actor);

    const bing = await accept(
      seoClient.serp({
        headers,
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "bing",
          location: "United States",
          languageCode: "en",
          countryCode: "us",
          device: "mobile",
          limit: 20,
        },
      }),
      [200],
    );
    const maps = await accept(
      seoClient.serp({
        headers,
        body: {
          query: "coffee shops",
          provider: "dataforseo",
          engine: "google_maps",
          location: "Austin, Texas, United States",
          languageCode: "en",
          countryCode: "us",
          device: "mobile",
          limit: 100,
        },
      }),
      [200],
    );
    const news = await accept(
      seoClient.serp({
        headers,
        body: {
          query: "ai news",
          provider: "dataforseo",
          engine: "google_news",
          location: "United States",
          languageCode: "en",
          countryCode: "us",
          device: "desktop",
          limit: 100,
        },
      }),
      [200],
    );

    expect([bing.body, maps.body, news.body]).toStrictEqual([
      expect.objectContaining({
        operation: "serp",
        provider: "dataforseo",
        billingQuantity: 2000,
        providerCostUsd: 0.002,
        creditsCharged: 3,
      }),
      expect.objectContaining({
        operation: "serp",
        provider: "dataforseo",
        billingQuantity: 2000,
        providerCostUsd: 0.002,
        creditsCharged: 3,
      }),
      expect.objectContaining({
        operation: "serp",
        provider: "dataforseo",
        billingQuantity: 20_000,
        providerCostUsd: 0.02,
        creditsCharged: 25,
      }),
    ]);
    expect(observed).toStrictEqual([
      [
        {
          keyword: "technical seo",
          location_name: "United States",
          language_code: "en",
          device: "mobile",
          depth: 20,
        },
      ],
      [
        {
          keyword: "coffee shops",
          location_name: "Austin, Texas, United States",
          language_code: "en",
          device: "mobile",
          depth: 100,
        },
      ],
      [
        {
          keyword: "ai news",
          location_name: "United States",
          language_code: "en",
          depth: 100,
        },
      ],
    ]);
    expect(beforeCredits - (await credits(actor))).toBe(31);
  });

  it("charges fresh SerpAPI results and leaves confirmed cache hits free", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    let requestCount = 0;
    server.use(
      http.get(SERPAPI_SEARCH_URL, ({ request }) => {
        requestCount += 1;
        const url = new URL(request.url);
        expect(url.searchParams.get("api_key")).toBe("test-serpapi-token");
        expect(url.searchParams.get("engine")).toBe("google_maps");
        expect(url.searchParams.get("q")).toBe("coffee shops");
        expect(url.searchParams.get("location")).toBe(
          "Austin, Texas, United States",
        );
        expect(url.searchParams.get("z")).toBe("14");
        return HttpResponse.json({
          search_metadata: {
            id: `search-${requestCount}`,
            status: "Success",
            created_at:
              requestCount === 1
                ? nowDate().toISOString()
                : "2000-01-01 00:00:00 UTC",
          },
          search_parameters: {
            api_key: "test-serpapi-token",
            engine: "google_maps",
            q: "coffee shops",
          },
          local_results: [{ title: "Coffee" }],
        });
      }),
    );
    const request = {
      query: "coffee shops",
      provider: "serpapi" as const,
      engine: "google_maps" as const,
      location: "Austin, Texas, United States",
      languageCode: "en",
      countryCode: "us",
      device: "mobile" as const,
      limit: 10,
    };
    const seoClient = client()(zeroSeoContract);

    const fresh = await accept(
      seoClient.serp({ headers: authenticate(actor), body: request }),
      [200],
    );
    const cached = await accept(
      seoClient.serp({ headers: authenticate(actor), body: request }),
      [200],
    );

    expect(fresh.body).toMatchObject({
      provider: "serpapi",
      billingQuantity: 1,
      cached: false,
      creditsCharged: 32,
      result: {
        search_parameters: { engine: "google_maps", q: "coffee shops" },
      },
    });
    expect(fresh.body.result).not.toMatchObject({
      search_parameters: { api_key: expect.anything() },
    });
    expect(cached.body).toMatchObject({
      provider: "serpapi",
      billingQuantity: 0,
      cached: true,
      creditsCharged: 0,
    });
    expect(beforeCredits - (await credits(actor))).toBe(32);
  });
});
