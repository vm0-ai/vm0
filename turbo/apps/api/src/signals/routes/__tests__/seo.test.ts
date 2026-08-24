import { Buffer } from "node:buffer";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { seoContract } from "@okouai/api-contracts/contracts/seo";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { billingStatusRoutes } from "../billing-status";
import { seoRoutes } from "../seo";

const context = testContext();
const SEO_ROUTES = Object.freeze([...billingStatusRoutes, ...seoRoutes]);
const DATAFORSEO_BASE_URL = "https://api.dataforseo.com";

type OrgApiTestUser = ApiTestUser & {
  readonly orgId: string;
  readonly usagePricingResolution: UsagePricingFixture["resolution"];
};

const SEO_PRICING_ROWS = [
  {
    kind: "seo",
    provider: "dataforseo",
    category: "provider_cost_usd_micros",
    unitPrice: 1250,
    unitSize: 1_000_000,
  },
] as const satisfies readonly UsagePricingRow[];

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function client(usagePricingResolution?: UsagePricingFixture["resolution"]) {
  return setupApp({ context, routes: SEO_ROUTES, usagePricingResolution });
}

async function seedSeoPricing(): Promise<UsagePricingFixture> {
  const pricing = await createUsagePricingFixture({
    configured: SEO_PRICING_ROWS,
  });
  onTestFinished(pricing.cleanup);
  return pricing;
}

async function seedActor(): Promise<OrgApiTestUser> {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("SEO test actor must belong to an organization");
  }
  const orgActor = { ...actor, orgId: actor.orgId };
  await createRunsApi(context).grantProEntitlement(orgActor);
  const pricing = await seedSeoPricing();
  return { ...orgActor, usagePricingResolution: pricing.resolution };
}

async function seedUnfundedActor(): Promise<OrgApiTestUser> {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("SEO test actor must belong to an organization");
  }
  const orgActor = { ...actor, orgId: actor.orgId };
  const onboarding = await createBddApi(context).completeOnboarding(orgActor);
  expect(onboarding.status).toBe(200);
  await seedOrgMetadata({ orgId: orgActor.orgId, tier: "pro", credits: 0 });
  const pricing = await seedSeoPricing();
  return { ...orgActor, usagePricingResolution: pricing.resolution };
}

async function credits(actor: OrgApiTestUser): Promise<number> {
  const response = await accept(
    client(actor.usagePricingResolution)(billingStatusContract).get({
      headers: authenticate(actor),
    }),
    [200],
  );
  return response.body.credits;
}

function configureProviders(): void {
  mockEnv("OKOU_SEO_DATAFORSEO_LOGIN", "test-dataforseo-login");
  mockEnv("OKOU_SEO_DATAFORSEO_PASSWORD", "test-dataforseo-password");
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

function emptyDataForSeoResponse() {
  return {
    version: "0.1.20260810",
    status_code: 20_000,
    status_message: "Ok.",
    time: "0.1000 sec.",
    cost: 0,
    tasks_count: 0,
    tasks_error: 0,
    tasks: [],
  };
}

describe("SEO routes", () => {
  it("rejects agent tokens without the seo capability", async () => {
    const actor = await seedActor();
    if (!actor.orgId) {
      throw new Error("SEO test actor must belong to an organization");
    }
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_seo_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client(actor.usagePricingResolution)(seoContract).serp({
        headers: { authorization: `Bearer ${token}` },
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
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
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/organic/live/advanced`,
        () => {
          providerRequests += 1;
          return HttpResponse.json({});
        },
      ),
    );

    const response = await accept(
      client(actor.usagePricingResolution)(seoContract).serp({
        headers: authenticate(actor),
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
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

  it("does not charge DataForSEO authorization failures", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    context.mocks.axiomLogging.warn.mockClear();
    server.use(
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/organic/live/advanced`,
        () => {
          return HttpResponse.json(
            {
              status_code: 40_100,
              status_message:
                "You are not authorized. Check your login and password.",
            },
            { status: 401, statusText: "Unauthorized" },
          );
        },
      ),
    );

    const response = await accept(
      client(actor.usagePricingResolution)(seoContract).serp({
        headers: authenticate(actor),
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
          device: "desktop",
          limit: 10,
        },
      }),
      [502],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      code: "DATAFORSEO_AUTH_ERROR",
      message: "DataForSEO authentication failed",
    });
    await expect(credits(actor)).resolves.toBe(beforeCredits);
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledTimes(1);
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledWith(
      "DataForSEO API request failed",
      expect.objectContaining({
        operation: "serp",
        endpoint: "/v3/serp/google/organic/live/advanced",
        httpStatus: 401,
        httpStatusText: "Unauthorized",
        providerStatusCode: 40_100,
        providerStatusMessage:
          "You are not authorized. Check your login and password.",
      }),
    );
    const warningCalls = JSON.stringify(
      context.mocks.axiomLogging.warn.mock.calls,
    );
    expect(warningCalls).not.toContain("technical seo");
    expect(warningCalls).not.toContain("test-dataforseo-login");
    expect(warningCalls).not.toContain("test-dataforseo-password");
    expect(warningCalls).not.toContain("Basic ");
  });

  it("reports an unverified DataForSEO account without charging credits", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    server.use(
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/organic/live/advanced`,
        () => {
          return HttpResponse.json(
            {
              status_code: 40_104,
              status_message:
                "Please verify your account before using the API.",
            },
            { status: 403, statusText: "Forbidden" },
          );
        },
      ),
    );

    const response = await accept(
      client(actor.usagePricingResolution)(seoContract).serp({
        headers: authenticate(actor),
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
          device: "desktop",
          limit: 10,
        },
      }),
      [502],
    );

    expect(response.body.error).toStrictEqual({
      code: "DATAFORSEO_ACCOUNT_UNVERIFIED",
      message: "DataForSEO account requires verification",
    });
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("retries a zero-cost empty task response once and charges only the successful result", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    let providerRequests = 0;
    server.use(
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/organic/live/advanced`,
        () => {
          providerRequests += 1;
          return HttpResponse.json(
            providerRequests === 1
              ? emptyDataForSeoResponse()
              : dataForSeoResponse(0.002, [{ keyword: "technical seo" }]),
          );
        },
      ),
    );

    const response = await accept(
      client(actor.usagePricingResolution)(seoContract).serp({
        headers: authenticate(actor),
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
          device: "desktop",
          limit: 10,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      billingQuantity: 2000,
      providerCostUsd: 0.002,
      creditsCharged: 3,
    });
    expect(providerRequests).toBe(2);
    expect(beforeCredits - (await credits(actor))).toBe(3);
  });

  it("returns an explicit error when DataForSEO repeats an empty task response", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    let providerRequests = 0;
    server.use(
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/organic/live/advanced`,
        () => {
          providerRequests += 1;
          return HttpResponse.json(emptyDataForSeoResponse());
        },
      ),
    );

    const response = await accept(
      client(actor.usagePricingResolution)(seoContract).serp({
        headers: authenticate(actor),
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
          device: "desktop",
          limit: 10,
        },
      }),
      [502],
    );

    expect(response.body.error).toStrictEqual({
      code: "DATAFORSEO_EMPTY_TASKS",
      message: "DataForSEO returned no task",
    });
    expect(providerRequests).toBe(2);
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("returns DataForSEO task parameter errors as bad requests", async () => {
    const actor = await seedActor();
    configureProviders();
    const beforeCredits = await credits(actor);
    server.use(
      http.post(
        `${DATAFORSEO_BASE_URL}/v3/serp/google/maps/live/advanced`,
        () => {
          return HttpResponse.json({
            version: "0.1.20260810",
            status_code: 20_000,
            status_message: "Ok.",
            time: "0.1000 sec.",
            cost: 0,
            tasks_count: 1,
            tasks_error: 1,
            tasks: [
              {
                id: "seo-task",
                status_code: 40_501,
                status_message: "Invalid Field: 'location_name'.",
                time: "0.1000 sec.",
                cost: 0,
                result_count: 0,
                result: null,
              },
            ],
          });
        },
      ),
    );

    const response = await accept(
      client(actor.usagePricingResolution)(seoContract).serp({
        headers: authenticate(actor),
        body: {
          query: "coffee shops",
          provider: "dataforseo",
          engine: "google_maps",
          location: "Austin, Texas, United States",
          languageCode: "en",
          device: "desktop",
          limit: 10,
        },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      code: "DATAFORSEO_INVALID_REQUEST",
      message: "Invalid Field: 'location_name'.",
    });
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
    const seoClient = client(actor.usagePricingResolution)(seoContract);

    const serp = await accept(
      seoClient.serp({
        headers,
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
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
    const seoClient = client(actor.usagePricingResolution)(seoContract);
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
          location_name: "Austin,Texas,United States",
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
});
