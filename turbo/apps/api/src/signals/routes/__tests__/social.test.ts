import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { socialContract } from "@okouai/api-contracts/contracts/social";
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
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

const context = testContext();
const SOCIALKIT_TRANSCRIPT_URL = "https://api.socialkit.dev/youtube/transcript";
const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

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
  const request = new Request("http://api.test/api/zero/social/transcript", {
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
  await setActorCredits(actor, 1000);
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
  mockEnv("OKOU_SOCIAL_SOCIALKIT_ACCESS_KEY", undefined);
  mockEnv("ZERO_SOCIAL_SOCIALKIT_ACCESS_KEY", "test-socialkit-key");
}

function socialPricingKey(): UsagePricingKey {
  return {
    kind: "social",
    provider: "socialkit",
    category: "youtube.transcript",
  };
}

async function setupConfiguredPricing(): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({
    configured: [
      {
        ...socialPricingKey(),
        unitPrice: 5,
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

function providerResponse() {
  return {
    success: true,
    message: "Transcript generated",
    data: {
      url: "https://www.youtube.com/watch?v=video123",
      videoId: "provider-video-id",
      transcript: "Welcome to the transcript.",
      transcriptSegments: [
        {
          text: "Welcome to the transcript.",
          start: 0,
          duration: 1.5,
          timestamp: "00:00",
        },
      ],
      wordCount: 4,
      segments: 1,
      language: "en",
    },
  };
}

function providerHandler(
  response: () => Response = () => {
    return HttpResponse.json(providerResponse());
  },
) {
  return http.get(SOCIALKIT_TRANSCRIPT_URL, response);
}

describe("okou social transcript route", () => {
  it("rejects zero tokens without social:read capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Social test actor must belong to an organization");
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_zero_social_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(socialContract).transcript({
        headers: { authorization: `Bearer ${token}` },
        body: { url: "https://youtu.be/video123" },
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: social:read",
    );
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
    const compose = await api.createHistoricalCompose(actor, {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });
    const run = await api.createDirectRun(actor, {
      agentId: compose.composeId,
      prompt: "Retrieve a public transcript",
    });
    const token = api.zeroTokenForRunWithCapabilities(actor, run.runId, [
      "social:read",
    ]);
    server.use(providerHandler());

    const response = await accept(
      client(pricing.resolution)(socialContract).transcript({
        headers: { authorization: `Bearer ${token}` },
        body: { url: "https://youtu.be/video123" },
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

    expect(response.body.creditsCharged).toBe(5);
    expect(usage.body.rows).toHaveLength(1);
    expect(usage.body.rows[0]?.runId).toBe(run.runId);
    expect(usage.body.rows[0]?.credits).toBe(5);
  });

  it("accepts supported YouTube forms and bills every success", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerUrls: string[] = [];
    const accessKeys: (string | null)[] = [];
    server.use(
      http.get(SOCIALKIT_TRANSCRIPT_URL, ({ request }) => {
        const providerUrl = new URL(request.url);
        providerUrls.push(providerUrl.searchParams.get("url") ?? "");
        accessKeys.push(request.headers.get("x-access-key"));
        return HttpResponse.json(providerResponse());
      }),
    );
    const urls = [
      "https://youtube.com/watch?v=video123",
      "https://www.youtube.com/shorts/video123",
      "https://m.youtube.com/watch?v=video123",
      "https://youtu.be/video123",
    ];

    for (const url of urls) {
      const response = await accept(
        client(pricing.resolution)(socialContract).transcript({
          headers: authenticate(actor),
          body: { url },
        }),
        [200],
      );
      expect(response.body.requestedUrl).toBe(url);
      expect(response.body.creditsCharged).toBe(5);
    }
    const afterCredits = await credits(actor);

    expect(providerUrls).toStrictEqual(urls);
    expect(accessKeys).toStrictEqual(
      Array.from({ length: 4 }, () => {
        return "test-socialkit-key";
      }),
    );
    expect(beforeCredits - afterCredits).toBe(20);
  });

  it("returns a normalized result without provider-only fields", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(providerHandler());

    const response = await accept(
      client(pricing.resolution)(socialContract).transcript({
        headers: authenticate(actor),
        body: {
          url: "https://www.youtube.com/watch?v=video123#captions",
        },
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(response.body).toStrictEqual({
      requestedUrl: "https://www.youtube.com/watch?v=video123",
      platform: "youtube",
      provider: "socialkit",
      billingCategory: "youtube.transcript",
      billingQuantity: 1,
      creditsCharged: 5,
      result: {
        transcript: "Welcome to the transcript.",
        transcriptSegments: [
          {
            text: "Welcome to the transcript.",
            start: 0,
            duration: 1.5,
            timestamp: "00:00",
          },
        ],
        wordCount: 4,
        language: "en",
      },
    });
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it.each([
    "https://example.com/watch?v=video123",
    "https://evil.youtube.com/watch?v=video123",
    "https://youtube.com/embed/video123",
    "https://youtube.com/watch",
    "https://youtu.be/one/two",
    "https://user:password@youtube.com/watch?v=video123",
    "file:///tmp/video",
  ])("rejects unsupported URL %s before provider work", async (url) => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    server.use(
      providerHandler(() => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await rawSocialRequest(actor, { url });

    expect(response.status).toBe(400);
    expect(providerRequests).toBe(0);
  });

  it("rejects requests when SocialKit is not configured", async () => {
    const actor = createBddApi(context).user();
    mockEnv("OKOU_SOCIAL_SOCIALKIT_ACCESS_KEY", undefined);
    mockEnv("ZERO_SOCIAL_SOCIALKIT_ACCESS_KEY", undefined);

    const response = await accept(
      client()(socialContract).transcript({
        headers: authenticate(actor),
        body: { url: "https://youtu.be/video123" },
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
      providerHandler(() => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).transcript({
        headers: authenticate(actor),
        body: { url: "https://youtu.be/video123" },
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
    await setActorCredits(actor, 0);
    server.use(
      providerHandler(() => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).transcript({
        headers: authenticate(actor),
        body: { url: "https://youtu.be/video123" },
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
    const cases = [
      [400, 400, "SOCIALKIT_INVALID_CONTENT"],
      [401, 502, "SOCIALKIT_AUTH_ERROR"],
      [403, 503, "SOCIALKIT_QUOTA_EXHAUSTED"],
      [404, 404, "SOCIALKIT_CONTENT_UNAVAILABLE"],
      [429, 502, "SOCIALKIT_RATE_LIMITED"],
      [500, 502, "SOCIALKIT_UPSTREAM_ERROR"],
    ] as const;

    for (const [providerStatus, apiStatus, code] of cases) {
      server.use(
        providerHandler(() => {
          return HttpResponse.json(
            { message: "raw provider message must not escape" },
            { status: providerStatus },
          );
        }),
      );
      const response = await rawSocialRequest(
        actor,
        { url: "https://youtu.be/video123" },
        { usagePricingResolution: pricing.resolution },
      );
      const body: unknown = await response.json();

      expect(response.status).toBe(apiStatus);
      expect(body).toMatchObject({ error: { code } });
      expect(JSON.stringify(body)).not.toContain("raw provider message");
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("rejects invalid successful responses without recording usage", async () => {
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
        return HttpResponse.json({
          success: true,
          data: { transcript: "missing required fields" },
        });
      },
      () => {
        return HttpResponse.json({
          ...providerResponse(),
          data: { ...providerResponse().data, transcript: "\u001b" },
        });
      },
    ];

    for (const responseFactory of invalidResponses) {
      server.use(providerHandler(responseFactory));
      const response = await accept(
        client(pricing.resolution)(socialContract).transcript({
          headers: authenticate(actor),
          body: { url: "https://youtu.be/video123" },
        }),
        [502],
      );
      expectApiError(response.body);
      expect(response.body.error.code).toBe("SOCIALKIT_INVALID_RESPONSE");
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
      server.use(providerHandler(responseFactory));
      const response = await accept(
        client(pricing.resolution)(socialContract).transcript({
          headers: authenticate(actor),
          body: { url: "https://youtu.be/video123" },
        }),
        [502],
      );
      expectApiError(response.body);
      expect(response.body.error.code).toBe(
        "SOCIAL_TRANSCRIPT_OUTPUT_TOO_LARGE",
      );
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("maps timeout and network failures without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      providerHandler(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException("timed out", "TimeoutError"));
          },
        });
        return new HttpResponse(stream);
      }),
    );
    const timeout = await accept(
      client(pricing.resolution)(socialContract).transcript({
        headers: authenticate(actor),
        body: { url: "https://youtu.be/video123" },
      }),
      [502],
    );
    expectApiError(timeout.body);
    expect(timeout.body.error.code).toBe("SOCIAL_TRANSCRIPT_TIMEOUT");

    server.use(
      providerHandler(() => {
        return HttpResponse.error();
      }),
    );
    const network = await accept(
      client(pricing.resolution)(socialContract).transcript({
        headers: authenticate(actor),
        body: { url: "https://youtu.be/video123" },
      }),
      [502],
    );
    expectApiError(network.body);
    expect(network.body.error.code).toBe("SOCIALKIT_UPSTREAM_ERROR");
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
      http.get(SOCIALKIT_TRANSCRIPT_URL, async ({ request }) => {
        providerStarted.resolve(undefined);
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        await providerRelease.promise;
        return HttpResponse.json(providerResponse());
      }),
    );

    const responsePromise = rawSocialRequest(
      actor,
      { url: "https://youtu.be/video123" },
      {
        requestSignal: controller.signal,
        usagePricingResolution: pricing.resolution,
      },
    );
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
      providerHandler(() => {
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

    const response = await rawSocialRequest(
      actor,
      { url: "https://youtu.be/video123" },
      {
        requestSignal: controller.signal,
        usagePricingResolution: pricing.resolution,
      },
    );

    expect(response.status).toBe(200);
    expect(controller.signal.aborted).toBeTruthy();
    expect(beforeCredits - (await credits(actor))).toBe(5);
  });

  it("records both concurrent successful transcripts", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      providerHandler(() => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const [first, second] = await Promise.all([
      accept(
        socialClient.transcript({
          headers: authenticate(actor),
          body: { url: "https://youtu.be/first" },
        }),
        [200],
      ),
      accept(
        socialClient.transcript({
          headers: authenticate(actor),
          body: { url: "https://youtu.be/second" },
        }),
        [200],
      ),
    ]);

    expect(first.body.creditsCharged).toBe(5);
    expect(second.body.creditsCharged).toBe(5);
    expect(providerRequests).toBe(2);
    expect(beforeCredits - (await credits(actor))).toBe(10);
  });
});
