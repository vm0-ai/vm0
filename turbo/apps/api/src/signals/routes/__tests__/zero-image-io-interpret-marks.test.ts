import { randomUUID } from "node:crypto";

import { CLIENT_REQUEST_ID_HEADER } from "@vm0/api-contracts/contracts/client-headers";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  deleteUsagePricingRows,
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroImageIoInterpretMarksRoutes } from "../zero-image-io-interpret-marks";
import { createFixtureTracker } from "./helpers/zero-route-test";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { seedCompose$, seedRun$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MARKED_IMAGE = "data:image/png;base64,bWFya2Vk";
const GEMINI_INTERPRET_STARTING_CREDITS = 1000;
const GEMINI_INTERPRET_EXPECTED_CHARGE = 13;
const GEMINI_INTERPRET_PRICING_ROWS = [
  {
    kind: "image-interpret-marks",
    provider: "google/gemini-3.5-flash",
    category: "tokens.input",
    unitPrice: 1500,
    unitSize: 1_000_000,
  },
  {
    kind: "image-interpret-marks",
    provider: "google/gemini-3.5-flash",
    category: "tokens.cache_read",
    unitPrice: 150,
    unitSize: 1_000_000,
  },
  {
    kind: "image-interpret-marks",
    provider: "google/gemini-3.5-flash",
    category: "tokens.output",
    unitPrice: 9000,
    unitSize: 1_000_000,
  },
] as const;

function createApp() {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [...zeroBillingStatusRoutes, ...zeroImageIoInterpretMarksRoutes],
  });
}

function zeroToken(userId: string, orgId: string, runId: string): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId,
    orgId,
    runId,
    capabilities: ["file:write", "billing:read"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function seedInterpretBilling(orgId: string): Promise<void> {
  await seedOrgMetadata({
    orgId,
    tier: "pro",
    credits: GEMINI_INTERPRET_STARTING_CREDITS,
  });
  await seedUsagePricingRows(GEMINI_INTERPRET_PRICING_ROWS);
}

async function deleteInterpretPricingRows() {
  return await deleteUsagePricingRows({
    kind: "image-interpret-marks",
    provider: "google/gemini-3.5-flash",
    categories: ["tokens.input", "tokens.cache_read", "tokens.output"],
  });
}

async function restoreInterpretPricingRows(
  snapshot: Awaited<ReturnType<typeof deleteInterpretPricingRows>>,
): Promise<void> {
  await seedUsagePricingRows(snapshot);
}

async function seedActor(): Promise<{
  orgId: string;
  userId: string;
  runId: string;
}> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId, userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    { orgId, userId, composeId, triggerSource: "web" },
    context.signal,
  );
  return { orgId, userId, runId };
}

function requestInterpret(
  app: ReturnType<typeof createApp>,
  token: string,
  body: unknown,
  clientRequestId?: string,
): Promise<Response> {
  return Promise.resolve(
    app.request("/api/zero/image-io/interpret-marks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(clientRequestId
          ? { [CLIENT_REQUEST_ID_HEADER]: clientRequestId }
          : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function orgCredits(
  app: ReturnType<typeof createApp>,
  token: string,
): Promise<number> {
  const response = await app.request("/api/zero/billing/status", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("credits" in body) ||
    typeof body.credits !== "number"
  ) {
    throw new Error("Expected billing status credits");
  }
  return body.credits;
}

describe("POST /api/zero/image-io/interpret-marks", () => {
  const trackPricing = createFixtureTracker(restoreInterpretPricingRows);

  it("resolves each mark into a targeted edit instruction", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let requestBody = "";
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-openrouter-key",
        );
        requestBody = await request.text();
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  regions: [
                    {
                      id: "region-comment-1",
                      target: "the dog's black nose (not the tongue below it)",
                      edit: "recolor the nose yellow",
                      confidence: 88,
                    },
                  ],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        });
      }),
    );
    const { orgId, userId, runId } = await seedActor();
    await seedInterpretBilling(orgId);
    const app = createApp();
    const token = zeroToken(userId, orgId, runId);

    await expect(orgCredits(app, token)).resolves.toBe(
      GEMINI_INTERPRET_STARTING_CREDITS,
    );

    const response = await requestInterpret(app, token, {
      imageUrl: MARKED_IMAGE,
      regions: [
        {
          id: "region-comment-1",
          mark: 1,
          instruction: "make it yellow",
          location: "center",
        },
      ],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      regions: readonly unknown[];
    };
    expect(body.regions).toStrictEqual([
      {
        id: "region-comment-1",
        target: "the dog's black nose (not the tongue below it)",
        edit: "recolor the nose yellow",
        confidence: 88,
      },
    ]);
    // The marked image is sent to the model as an image content part.
    expect(requestBody).toContain(MARKED_IMAGE);
    expect(requestBody).toContain("image_url");
    await expect(orgCredits(app, token)).resolves.toBe(
      GEMINI_INTERPRET_STARTING_CREDITS - GEMINI_INTERPRET_EXPECTED_CHARGE,
    );
  });

  it("rejects configured LLM calls when the org has no credits", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const { orgId, userId, runId } = await seedActor();
    await seedOrgMetadata({ orgId, tier: "pro", credits: 0 });
    const app = createApp();

    const response = await requestInterpret(
      app,
      zeroToken(userId, orgId, runId),
      {
        imageUrl: MARKED_IMAGE,
        regions: [
          { id: "region-comment-1", mark: 1, instruction: "make it yellow" },
        ],
      },
    );

    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      error: { readonly code: string };
    };
    expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("charges each model invocation when the client request id is reused", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let openRouterCalls = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        openRouterCalls += 1;
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  regions: [
                    {
                      id: "region-comment-1",
                      target: "the marked nose",
                      edit: "make the marked nose yellow",
                      confidence: 80,
                    },
                  ],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        });
      }),
    );
    const { orgId, userId, runId } = await seedActor();
    await seedInterpretBilling(orgId);
    const app = createApp();
    const token = zeroToken(userId, orgId, runId);
    const body = {
      imageUrl: MARKED_IMAGE,
      regions: [
        { id: "region-comment-1", mark: 1, instruction: "make it yellow" },
      ],
    };
    const clientRequestId = randomUUID();

    const first = await requestInterpret(app, token, body, clientRequestId);
    expect(first.status).toBe(200);
    await expect(orgCredits(app, token)).resolves.toBe(
      GEMINI_INTERPRET_STARTING_CREDITS - GEMINI_INTERPRET_EXPECTED_CHARGE,
    );

    const second = await requestInterpret(app, token, body, clientRequestId);
    expect(second.status).toBe(200);
    expect(openRouterCalls).toBe(2);
    await expect(orgCredits(app, token)).resolves.toBe(
      GEMINI_INTERPRET_STARTING_CREDITS - GEMINI_INTERPRET_EXPECTED_CHARGE * 2,
    );
  });

  it("rejects configured LLM calls when usage pricing is missing", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let openRouterCalled = false;
    server.use(
      http.post(OPENROUTER_URL, () => {
        openRouterCalled = true;
        return HttpResponse.json({});
      }),
    );
    await trackPricing(deleteInterpretPricingRows());
    const { orgId, userId, runId } = await seedActor();
    await seedOrgMetadata({
      orgId,
      tier: "pro",
      credits: GEMINI_INTERPRET_STARTING_CREDITS,
    });
    const app = createApp();

    const response = await requestInterpret(
      app,
      zeroToken(userId, orgId, runId),
      {
        imageUrl: MARKED_IMAGE,
        regions: [
          { id: "region-comment-1", mark: 1, instruction: "make it yellow" },
        ],
      },
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { readonly code: string };
    };
    expect(body.error.code).toBe("NOT_CONFIGURED");
    expect(openRouterCalled).toBeFalsy();
  });

  it("falls back to the raw instruction when the LLM is not configured", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const { orgId, userId, runId } = await seedActor();
    const app = createApp();

    const response = await requestInterpret(
      app,
      zeroToken(userId, orgId, runId),
      {
        imageUrl: MARKED_IMAGE,
        regions: [
          { id: "region-comment-1", mark: 1, instruction: "make it yellow" },
        ],
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      regions: readonly unknown[];
    };
    expect(body.regions).toStrictEqual([
      {
        id: "region-comment-1",
        target: "",
        edit: "make it yellow",
        confidence: 0,
      },
    ]);
  });
});
