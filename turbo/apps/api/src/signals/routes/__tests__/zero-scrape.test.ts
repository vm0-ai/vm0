import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import {
  zeroScrapeContract,
  type ZeroScrapeRequest,
} from "@vm0/api-contracts/contracts/zero-scrape";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";

import { mockEnv } from "../../../lib/env";
import { createAppWithRoutes } from "../../../app-factory-core";
import { server } from "../../../mocks/server";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import {
  deleteUsagePricingRows,
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { createDeferredPromise } from "../../utils";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../external/time";
import type { RouteEntry } from "../../route-entry";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroScrapeRoutes } from "../zero-scrape";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

const scrapeRoutes: readonly RouteEntry[] = [
  ...zeroBillingStatusRoutes,
  ...zeroScrapeRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
}

interface RawScrapeRequestOptions {
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
  return setupAppWithRoutes({
    context,
    routes: scrapeRoutes,
  });
}

async function rawScrapeRequest(
  actor: ApiTestUser | null,
  body: ZeroScrapeRequest,
  options: RawScrapeRequestOptions = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: options.instanceSignal ?? context.signal,
    routes: scrapeRoutes,
  });
  const request = new Request("http://api.test/api/zero/scrape", {
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
    throw new Error("Zero Scrape test actor must belong to an organization");
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

function allowExampleDotCom(): void {
  context.mocks.dns.lookupOverrides.set("example.com", [
    { address: "93.184.216.34", family: 4 },
  ]);
}

function configureProvider(): void {
  mockEnv("ZERO_SCRAPE_FIRECRAWL_TOKEN", "test-firecrawl-token");
}

async function seedScrapePricing(): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "scrape",
      provider: "firecrawl",
      category: "standard.markdown",
      unitPrice: 4,
      unitSize: 1,
    },
    {
      kind: "scrape",
      provider: "firecrawl",
      category: "standard.links",
      unitPrice: 4,
      unitSize: 1,
    },
    {
      kind: "scrape",
      provider: "firecrawl",
      category: "enhanced.markdown",
      unitPrice: 20,
      unitSize: 1,
    },
    {
      kind: "scrape",
      provider: "firecrawl",
      category: "enhanced.links",
      unitPrice: 20,
      unitSize: 1,
    },
  ]);
}

describe("zero scrape route", () => {
  it("rejects zero tokens without scrape:read capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Zero Scrape test actor must belong to an organization");
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_zero_scrape_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: { authorization: `Bearer ${token}` },
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe(
      "Missing required capability: scrape:read",
    );
  });

  it("rejects scrape requests when the provider is not configured", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
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
    configureProvider();
    context.mocks.dns.lookupOverrides.set("private.example.test", [
      { address: "10.0.0.5", family: 4 },
    ]);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    for (const url of [
      "http://127.0.0.1:3000/admin",
      "http://localhost/admin",
      "https://private.example.test/admin",
    ]) {
      const response = await accept(
        client()(zeroScrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url,
            format: "markdown",
            mode: "standard",
          },
        }),
        [400],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    }
    expect(firecrawlRequests).toBe(0);
  });

  it("blocks special-use IPv4 literal targets before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    configureProvider();
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    for (const url of [
      "http://192.0.2.10/page",
      "http://198.51.100.10/page",
      "http://203.0.113.10/page",
      "http://224.0.0.1/page",
      "http://240.0.0.1/page",
    ]) {
      const response = await accept(
        client()(zeroScrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url,
            format: "markdown",
            mode: "standard",
          },
        }),
        [400],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    }
    expect(firecrawlRequests).toBe(0);
  });

  it("blocks non-public IPv6 literal targets before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    configureProvider();
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    for (const url of [
      "http://[::1]:3000/admin",
      "http://[::]/admin",
      "http://[::ffff:192.168.1.1]/admin",
      "http://[64:ff9b::c0a8:101]/admin",
      "http://[100:0:0:1::1]/admin",
      "http://[3fff::1]/admin",
      "http://[5f00::1]/admin",
      "http://[4000::1]/admin",
    ]) {
      const response = await accept(
        client()(zeroScrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url,
            format: "markdown",
            mode: "standard",
          },
        }),
        [400],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    }
    expect(firecrawlRequests).toBe(0);
  });

  it("blocks target URLs with embedded credentials before calling Firecrawl", async () => {
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
    configureProvider();
    await seedScrapePricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, 0);
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

  it("scrapes markdown through standard Firecrawl proxy and records usage", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: {
              sourceURL: "https://example.com/page",
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
          format: "markdown",
          mode: "standard",
        },
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toStrictEqual({
      url: "https://example.com/page",
      formats: ["markdown"],
      parsers: [],
      proxy: "basic",
      skipTlsVerification: false,
      maxAge: 0,
      storeInCache: false,
      timeout: 25_000,
    });
    expect(response.body).toMatchObject({
      requestedUrl: "https://example.com/page",
      finalUrl: "https://example.com/page",
      format: "markdown",
      mode: "standard",
      provider: "firecrawl",
      creditsCharged: 4,
      billingCategory: "standard.markdown",
      billingQuantity: 1,
      result: {
        markdown: "# Example page",
      },
    });
    expect(beforeCredits - afterCredits).toBe(4);
  });

  it("records usage when the request aborts after Firecrawl succeeds", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected after provider success");
    abortError.name = "AbortError";
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    let providerCompleted = false;
    context.mocks.dns.lookupOverrides.set("final.example.test", () => {
      controller.abort(abortError);
      return [{ address: "93.184.216.35", family: 4 }];
    });

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        providerCompleted = true;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: {
              url: "https://final.example.test/page",
            },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      { requestSignal: controller.signal },
    );
    const afterCredits = await credits(actor);

    expect(response.status).toBe(200);
    expect(providerCompleted).toBeTruthy();
    expect(beforeCredits - afterCredits).toBe(4);
  });

  it("does not start Firecrawl when the request aborts before provider launch", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected before provider launch");
    abortError.name = "AbortError";
    let firecrawlRequests = 0;
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    context.mocks.dns.lookupOverrides.set("example.com", () => {
      controller.abort(abortError);
      return [{ address: "93.184.216.34", family: 4 }];
    });
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: { url: "https://example.com/page" },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      { requestSignal: controller.signal },
    );
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    expect(firecrawlRequests).toBe(0);
    expect(afterCredits).toBe(beforeCredits);
  });

  it("cancels Firecrawl when the request aborts while it is in flight", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected during provider work");
    abortError.name = "AbortError";
    const providerStarted = createDeferredPromise<void>(context.signal);
    const providerResponse = createDeferredPromise<void>(context.signal);
    let providerSignalAborted = false;
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        providerStarted.resolve(undefined);
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        await providerResponse.promise;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: {
              url: "https://example.com/page",
            },
          },
        });
      }),
    );

    const responsePromise = rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      { requestSignal: controller.signal },
    );
    await providerStarted.promise;
    providerResponse.resolve(undefined);
    const response = await responsePromise;
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    expect(providerSignalAborted).toBeTruthy();
    expect(afterCredits).toBe(beforeCredits);
  });

  it("stops in-flight Firecrawl work when the instance lifecycle aborts", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("function instance terminated");
    abortError.name = "AbortError";
    let providerSignalAborted = false;
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, ({ request }) => {
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: { url: "https://example.com/page" },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      { instanceSignal: controller.signal },
    );
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    expect(providerSignalAborted).toBeTruthy();
    expect(afterCredits).toBe(beforeCredits);
  });

  it("records both concurrent same-org scrape requests", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        firecrawlRequests += 1;
        const body = (await request.json()) as { readonly url?: string };
        return HttpResponse.json({
          success: true,
          data: {
            markdown: `# ${body.url ?? "unknown"}`,
            metadata: {
              sourceURL: body.url ?? "https://example.com/page",
            },
          },
        });
      }),
    );

    const scrapeClient = client();
    const [first, second] = await Promise.all([
      accept(
        scrapeClient(zeroScrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url: "https://example.com/one",
            format: "markdown",
            mode: "standard",
          },
        }),
        [200],
      ),
      accept(
        scrapeClient(zeroScrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url: "https://example.com/two",
            format: "markdown",
            mode: "standard",
          },
        }),
        [200],
      ),
    ]);
    const afterCredits = await credits(actor);

    expect(first.body.creditsCharged).toBe(4);
    expect(second.body.creditsCharged).toBe(4);
    expect(firecrawlRequests).toBe(2);
    expect(beforeCredits - afterCredits).toBe(8);
  });

  it("does not return successful content when usage processing records a billing error", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async () => {
        await deleteUsagePricingRows({
          kind: "scrape",
          provider: "firecrawl",
          categories: ["standard.markdown"],
        });
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: {
              sourceURL: "https://example.com/page",
            },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(actor, {
      url: "https://example.com/page",
      format: "markdown",
      mode: "standard",
    });
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
    expect(afterCredits).toBe(beforeCredits);
  });

  it("scrapes public IPv6 literal targets without DNS lookup", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# IPv6 page",
          },
        });
      }),
    );

    const response = await accept(
      client()(zeroScrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://[2606:4700:4700::1111]/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toMatchObject({
      url: "https://[2606:4700:4700::1111]/page",
      formats: ["markdown"],
      proxy: "basic",
    });
    expect(response.body.result).toStrictEqual({ markdown: "# IPv6 page" });
    expect(beforeCredits - afterCredits).toBe(4);
  });

  it("scrapes links through enhanced Firecrawl proxy and records usage", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    let authorization: string | null = null;
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
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
              sourceURL: "https://example.com/page",
              url: "https://example.com/final",
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
      parsers: [],
      proxy: "enhanced",
      skipTlsVerification: false,
      maxAge: 0,
      storeInCache: false,
      timeout: 25_000,
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

  it("rejects unsafe final URLs when the source URL is public", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Internal redirect",
            metadata: {
              sourceURL: "https://example.com/page",
              url: "http://127.0.0.1/secret",
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

  it("returns Firecrawl success false errors without recording usage", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          success: false,
          error: "Firecrawl rejected this scrape",
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
    expect(response.body.error.code).toBe("FIRECRAWL_ERROR");
    expect(response.body.error.message).toBe("Firecrawl rejected this scrape");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("bounds provider error messages without recording usage", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          success: false,
          error: "x".repeat(5000),
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
    expect(response.body.error.code).toBe("FIRECRAWL_ERROR");
    expect(response.body.error.message).toHaveLength(4096);
    expect(response.body.error.message.endsWith("...")).toBeTruthy();
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects provider data without an explicit success marker", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          status: 400,
          body: {
            error: {
              message: "Provider controlled error",
              code: "PROVIDER_CONTROLLED",
            },
          },
          data: {
            markdown: "# Provider controlled content",
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
    expect(response.body.error.code).toBe("FIRECRAWL_ERROR");
    expect(response.body.error.message).toBe(
      "Firecrawl response did not include scrape data",
    );
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects oversized Firecrawl responses without recording usage", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    await seedScrapePricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.text("x".repeat(4 * 1024 * 1024 + 1));
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
    expect(response.body.error.code).toBe("SCRAPE_OUTPUT_TOO_LARGE");
    expect(afterCredits).toBe(beforeCredits);
  });
});
