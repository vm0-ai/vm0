import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { zeroScrapeContract } from "@vm0/api-contracts/contracts/zero-scrape";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import type { RouteEntry } from "../../route-entry";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroOnboardingSetupRoutes } from "../zero-onboarding-setup";
import { zeroScrapeRoutes } from "../zero-scrape";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

const scrapeRoutes: readonly RouteEntry[] = [
  ...zeroOnboardingSetupRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroScrapeRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
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
  return setupAppWithRoutes({ context, routes: scrapeRoutes });
}

async function setupOnboarding(actor: ApiTestUser): Promise<void> {
  await createBddApi(context).setupOnboarding(actor, {
    displayName: "Zero Scrape Test",
  });
}

async function grantCredits(actor: ApiTestUser): Promise<void> {
  createBddApi(context).acceptAgentStorageWrites();
  await createRunsAutomationsApi(context).grantProEntitlement(actor);
}

async function enableScrape(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Zero Scrape test actor must belong to an organization");
  }

  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: actor.orgId,
      ...(actor.orgRole ? { orgRole: actor.orgRole } : {}),
    },
    { [FeatureSwitchKey.ZeroScrape]: true },
  );
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

function allowExampleDotCom(): void {
  context.mocks.dns.lookupOverrides.set("example.com", [
    { address: "93.184.216.34", family: 4 },
  ]);
}

function configureProvider(): void {
  mockEnv("ZERO_SCRAPE_FIRECRAWL_TOKEN", "test-firecrawl-token");
}

describe("zero scrape route", () => {
  it("rejects scrape requests when the feature switch is disabled", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    allowExampleDotCom();
    configureProvider();
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe("Zero Scrape is not enabled");
    expect(firecrawlRequests).toBe(0);
  });

  it("rejects scrape requests when the provider is not configured", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    await enableScrape(actor);
    mockEnv("ZERO_SCRAPE_FIRECRAWL_TOKEN", undefined);

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_CONFIGURED");
  });

  it("blocks private targets before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    await enableScrape(actor);
    configureProvider();
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "http://127.0.0.1:3000/admin",
          format: "markdown",
          mode: "standard",
        },
      }),
      [400],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    expect(firecrawlRequests).toBe(0);
  });

  it("blocks target URLs with embedded credentials before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    allowExampleDotCom();
    await enableScrape(actor);
    configureProvider();
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://user:password@example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [400],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    expect(response.body.error.message).toBe(
      "Scrape URL must not include credentials",
    );
    expect(firecrawlRequests).toBe(0);
  });

  it("returns insufficient credits before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    allowExampleDotCom();
    await enableScrape(actor);
    configureProvider();
    await setupOnboarding(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(firecrawlRequests).toBe(0);
  });

  it("scrapes links through enhanced Firecrawl proxy and records usage", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    let authorization: string | null = null;
    allowExampleDotCom();
    await enableScrape(actor);
    configureProvider();
    await grantCredits(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        requestBody = await request.json();
        authorization = request.headers.get("authorization");
        return HttpResponse.json({
          success: true,
          data: {
            links: ["https://example.com/a", "https://example.com/b"],
            metadata: {
              title: "Example page",
              sourceURL: "https://example.com/final",
              statusCode: 200,
            },
          },
        });
      }),
    );

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "links",
          mode: "enhanced",
        },
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toStrictEqual({
      url: "https://example.com/page",
      formats: ["links"],
      proxy: "enhanced",
      skipTlsVerification: false,
      storeInCache: false,
    });
    expect(authorization).toBe("Bearer test-firecrawl-token");
    expect(response.body).toMatchObject({
      requestedUrl: "https://example.com/page",
      finalUrl: "https://example.com/final",
      format: "links",
      mode: "enhanced",
      provider: "firecrawl",
      creditsCharged: 20,
      billingCategory: "enhanced.links",
      billingQuantity: 1,
      result: {
        links: ["https://example.com/a", "https://example.com/b"],
      },
      metadata: {
        title: "Example page",
        statusCode: 200,
      },
    });
    expect(beforeCredits - afterCredits).toBe(20);
  });

  it("rejects unsafe final URLs without recording usage", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    await enableScrape(actor);
    configureProvider();
    await grantCredits(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Internal redirect",
            metadata: { sourceURL: "http://127.0.0.1/secret" },
          },
        });
      }),
    );

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNSAFE_FINAL_URL");
    expect(afterCredits).toBe(beforeCredits);
  });
});
