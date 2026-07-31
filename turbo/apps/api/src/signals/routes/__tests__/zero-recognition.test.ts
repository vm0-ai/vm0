import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { ZERO_RECOGNITION_MAX_FILE_BYTES } from "@vm0/api-contracts/contracts/zero-recognition";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { HttpResponse, http } from "msw";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { buildArtifactKey } from "../../../lib/file-url";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  deleteUsagePricingRows,
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../external/time";
import { zeroRecognitionRoutes } from "../zero-recognition";
import { zeroUsageRunsRoutes } from "../zero-usage-runs";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  seedCompose$,
  seedRun$,
  readUsageStorageCounts$,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const STARTING_CREDITS = 1000;
const EXPECTED_CHARGE = 13;
const RECOGNITION_PRICING_ROWS = [
  {
    kind: "model",
    provider: "google/gemini-3.5-flash",
    category: "tokens.input",
    unitPrice: 1500,
    unitSize: 1_000_000,
  },
  {
    kind: "model",
    provider: "google/gemini-3.5-flash",
    category: "tokens.cache_read",
    unitPrice: 150,
    unitSize: 1_000_000,
  },
  {
    kind: "model",
    provider: "google/gemini-3.5-flash",
    category: "tokens.output",
    unitPrice: 9000,
    unitSize: 1_000_000,
  },
] as const;

interface RecognitionActor {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}

interface StoredObject {
  readonly userId: string;
  readonly id: string;
  readonly filename: string;
  readonly size: number;
}

function createApp() {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [...zeroRecognitionRoutes, ...zeroUsageRunsRoutes],
  });
}

function zeroToken(
  actor: RecognitionActor,
  capabilities: readonly ZeroCapability[] = ["image-recognition:write"],
): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: actor.runId,
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function seedActor(): Promise<RecognitionActor> {
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

function setStoredObjects(objects: readonly StoredObject[]): void {
  mocks.s3.listObjects(
    objects.map((object) => {
      return {
        bucket: "test-user-artifacts",
        key: buildArtifactKey(object.userId, object.id, object.filename),
        size: object.size,
      };
    }),
  );
}

function requestRecognition(args: {
  readonly app: ReturnType<typeof createApp>;
  readonly token?: string;
  readonly fileId: string;
  readonly prompt?: string;
  readonly clientRequestId?: string;
}): Promise<Response> {
  return Promise.resolve(
    args.app.request("/api/zero/recognize", {
      method: "POST",
      headers: {
        ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
        "content-type": "application/json",
        ...(args.clientRequestId
          ? { "x-vm0-client-request-id": args.clientRequestId }
          : {}),
      },
      body: JSON.stringify({
        fileId: args.fileId,
        prompt: args.prompt ?? "Describe this image",
      }),
    }),
  );
}

async function seedBilling(actor: RecognitionActor): Promise<void> {
  await seedOrgMetadata({
    orgId: actor.orgId,
    tier: "pro",
    credits: STARTING_CREDITS,
  });
  await seedUsagePricingRows(RECOGNITION_PRICING_ROWS);
}

function mockClerkUserLookup(): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
}

async function readRunUsage(
  app: ReturnType<typeof createApp>,
  actor: RecognitionActor,
) {
  mockClerkUserLookup();
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  const response = await app.request(
    `/api/zero/usage/runs?runId=${actor.runId}`,
    { headers: { authorization: "Bearer clerk-session" } },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    runs: readonly {
      runId: string;
      inputTokens: number;
      outputTokens: number;
      cacheTokens: number;
      creditsCharged: number;
    }[];
  };
  return body.runs;
}

async function expectNoUsage(actor: RecognitionActor): Promise<void> {
  await expect(
    store.set(
      readUsageStorageCounts$,
      { scope: "organization", id: actor.orgId },
      context.signal,
    ),
  ).resolves.toStrictEqual({ raw: 0, hourly: 0 });
}

describe("POST /api/zero/recognize", () => {
  const trackPricing = createFixtureTracker(
    async (
      rows: readonly {
        readonly kind: string;
        readonly provider: string;
        readonly category: string;
        readonly unitPrice: number;
        readonly unitSize: number;
      }[],
    ) => {
      await seedUsagePricingRows(rows);
    },
  );

  it("recognizes one owned image and settles each real invocation", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const requestBodies: unknown[] = [];
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        requestBodies.push(await request.json());
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "A red warning banner is visible." },
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
    const actor = await seedActor();
    await seedBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.png", size: 1024 },
    ]);
    const app = createApp();
    const clientRequestId = randomUUID();

    for (let invocation = 0; invocation < 2; invocation += 1) {
      const response = await requestRecognition({
        app,
        token: zeroToken(actor),
        fileId,
        prompt: "Read the warning",
        clientRequestId,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        text: "A red warning banner is visible.",
        metadata: { creditsCharged: EXPECTED_CHARGE },
      });
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      model: "google/gemini-3.5-flash",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the warning" },
            {
              type: "image_url",
              image_url: {
                url: expect.stringContaining(fileId),
              },
            },
          ],
        },
      ],
    });
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: actor.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 6, hourly: 0 });
    await expect(readRunUsage(app, actor)).resolves.toStrictEqual([
      expect.objectContaining({
        runId: actor.runId,
        inputTokens: 4000,
        outputTokens: 2000,
        cacheTokens: 2000,
        creditsCharged: EXPECTED_CHARGE * 2,
      }),
    ]);
  });

  it("enforces Zero-only capability authorization before object access", async () => {
    const actor = await seedActor();
    const app = createApp();
    const fileId = randomUUID();

    const unauthenticated = await requestRecognition({ app, fileId });
    expect(unauthenticated.status).toBe(401);

    const missingCapability = await requestRecognition({
      app,
      token: zeroToken(actor, ["file:write"]),
      fileId,
    });
    expect(missingCapability.status).toBe(403);

    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const sessionResponse = await requestRecognition({
      app,
      token: "clerk-session",
      fileId,
    });
    expect(sessionResponse.status).toBe(403);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("rejects non-owned and invalid uploaded image metadata", async () => {
    const actor = await seedActor();
    const app = createApp();
    const otherUserFileId = randomUUID();
    const gifId = randomUUID();
    const emptyId = randomUUID();
    const oversizedId = randomUUID();
    setStoredObjects([
      {
        userId: randomUUID(),
        id: otherUserFileId,
        filename: "other.png",
        size: 10,
      },
      { userId: actor.userId, id: gifId, filename: "image.gif", size: 10 },
      { userId: actor.userId, id: emptyId, filename: "empty.png", size: 0 },
      {
        userId: actor.userId,
        id: oversizedId,
        filename: "large.webp",
        size: ZERO_RECOGNITION_MAX_FILE_BYTES + 1,
      },
    ]);
    const token = zeroToken(actor);

    const cases = [
      { fileId: otherUserFileId, status: 404, code: "NOT_FOUND" },
      { fileId: gifId, status: 400, code: "UNSUPPORTED_IMAGE_TYPE" },
      { fileId: emptyId, status: 400, code: "EMPTY_IMAGE" },
      { fileId: oversizedId, status: 413, code: "IMAGE_TOO_LARGE" },
    ] as const;
    for (const testCase of cases) {
      const response = await requestRecognition({
        app,
        token,
        fileId: testCase.fileId,
      });
      expect(response.status).toBe(testCase.status);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe(testCase.code);
    }
    await expectNoUsage(actor);
  });

  it("fails before the provider when credits or pricing are unavailable", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let providerCalled = false;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerCalled = true;
        return HttpResponse.json({});
      }),
    );
    const actor = await seedActor();
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.jpg", size: 100 },
    ]);
    const app = createApp();
    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 0 });
    await seedUsagePricingRows(RECOGNITION_PRICING_ROWS);

    const noCredits = await requestRecognition({
      app,
      token: zeroToken(actor),
      fileId,
    });
    expect(noCredits.status).toBe(402);

    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro",
      credits: STARTING_CREDITS,
    });
    await trackPricing(
      deleteUsagePricingRows({
        kind: "model",
        provider: "google/gemini-3.5-flash",
        categories: ["tokens.input", "tokens.cache_read", "tokens.output"],
      }),
    );
    const noPricing = await requestRecognition({
      app,
      token: zeroToken(actor),
      fileId,
    });
    expect(noPricing.status).toBe(503);
    expect(providerCalled).toBeFalsy();
    await expectNoUsage(actor);
  });

  it("maps provider image errors without exposing raw provider text", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "raw-provider-secret-detail",
              metadata: { error_type: "invalid_image" },
            },
          },
          { status: 400 },
        );
      }),
    );
    const actor = await seedActor();
    await seedBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "broken.png", size: 12 },
    ]);

    const response = await requestRecognition({
      app: createApp(),
      token: zeroToken(actor),
      fileId,
    });
    expect(response.status).toBe(400);
    const responseText = await response.text();
    expect(responseText).toContain("INVALID_IMAGE");
    expect(responseText).not.toContain("raw-provider-secret-detail");
    await expectNoUsage(actor);
  });

  it("rejects usable text when provider usage metadata is missing", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Unbilled result" },
            },
          ],
        });
      }),
    );
    const actor = await seedActor();
    await seedBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.webp", size: 12 },
    ]);

    const response = await requestRecognition({
      app: createApp(),
      token: zeroToken(actor),
      fileId,
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "MISSING_PROVIDER_USAGE" },
    });
    await expectNoUsage(actor);
  });

  it("rejects incomplete or empty provider output without recording usage", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let providerCall = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerCall += 1;
        if (providerCall === 1) {
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "length",
                message: { content: "Incomplete result" },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          });
        }
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "   " },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
      }),
    );
    const actor = await seedActor();
    await seedBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.png", size: 12 },
    ]);
    const app = createApp();

    for (let invocation = 0; invocation < 2; invocation += 1) {
      const response = await requestRecognition({
        app,
        token: zeroToken(actor),
        fileId,
      });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "IMAGE_RECOGNITION_FAILED" },
      });
    }
    expect(providerCall).toBe(2);
    await expectNoUsage(actor);
  });

  it("does not return text when settlement reports a billing error", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, async () => {
        await trackPricing(
          deleteUsagePricingRows({
            kind: "model",
            provider: "google/gemini-3.5-flash",
            categories: ["tokens.output"],
          }),
        );
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "This text must not be returned" },
            },
          ],
          usage: { completion_tokens: 100 },
        });
      }),
    );
    const actor = await seedActor();
    await seedBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.png", size: 12 },
    ]);

    const response = await requestRecognition({
      app: createApp(),
      token: zeroToken(actor),
      fileId,
    });
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain(
      "This text must not be returned",
    );
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: actor.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 0 });
  });
});
