import { randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  ZERO_TRANSLATION_MAX_SOURCE_TEXT_CHARS,
  zeroTranslationContract,
} from "@vm0/api-contracts/contracts/zero-translation";
import { zeroUsageRecordContract } from "@vm0/api-contracts/contracts/zero-usage-record";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  deleteUsagePricingRows,
  seedOrgMetadata,
  type UsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroTranslationRoutes } from "../zero-translation";
import { zeroUsageRecordRoutes } from "../zero-usage-record";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TRANSLATION_MODEL = "qwen/qwen-2.5-7b-instruct";
const STARTING_CREDITS = 1000;
const EXPECTED_CHARGE = 3;
const TRANSLATION_PRICING_ROWS = [
  {
    kind: "translation",
    provider: TRANSLATION_MODEL,
    category: "tokens.input",
    unitPrice: 100,
    unitSize: 1_000_000,
  },
  {
    kind: "translation",
    provider: TRANSLATION_MODEL,
    category: "tokens.cache_read",
    unitPrice: 100,
    unitSize: 1_000_000,
  },
  {
    kind: "translation",
    provider: TRANSLATION_MODEL,
    category: "tokens.output",
    unitPrice: 200,
    unitSize: 1_000_000,
  },
] as const;

interface TranslationActor extends ApiTestUser {
  readonly orgId: string;
  readonly runId: string;
}

function zeroToken(
  actor: TranslationActor,
  capabilities: readonly ZeroCapability[] = ["translation:write"],
): string {
  return createRunsApi(context).zeroTokenForRunWithCapabilities(
    actor,
    actor.runId,
    capabilities,
  );
}

async function seedActor(): Promise<TranslationActor> {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Translation tests require an organization");
  }
  await seedOrgMetadata({
    orgId: actor.orgId,
    tier: "pro",
    credits: STARTING_CREDITS,
  });
  const api = createRunsApi(context);
  const name = `translation-${randomUUID().slice(0, 8)}`;
  const compose = await api.createCompose(actor, {
    version: "1.0",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "translation-test-key" },
      },
    },
  });
  const run = await api.createDirectRun(actor, {
    agentComposeId: compose.composeId,
    prompt: "Translate text",
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role: actor.orgRole ?? "org:admin",
        organization: { id: actor.orgId },
        publicUserData: { userId: actor.userId },
      },
    ],
  });
  return { ...actor, orgId: actor.orgId, runId: run.runId };
}

function requestTranslation(args: {
  readonly token?: string;
  readonly text?: string;
  readonly targetLanguage?: string;
  readonly sourceLanguage?: string;
  readonly clientRequestId?: string;
  readonly usagePricingResolution?: UsagePricingFixture["resolution"];
}) {
  const headers = {
    ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
    ...(args.clientRequestId
      ? { "x-vm0-client-request-id": args.clientRequestId }
      : {}),
  };
  return setupApp({
    context,
    routes: zeroTranslationRoutes,
    usagePricingResolution: args.usagePricingResolution,
  })(zeroTranslationContract).translate({
    headers,
    body: {
      text: args.text ?? "Hello, world",
      targetLanguage: args.targetLanguage ?? "Simplified Chinese",
      ...(args.sourceLanguage === undefined
        ? {}
        : { sourceLanguage: args.sourceLanguage }),
    },
  });
}

async function createConfiguredTranslationPricing(): Promise<UsagePricingFixture> {
  const pricing = await createUsagePricingFixture({
    configured: TRANSLATION_PRICING_ROWS,
  });
  onTestFinished(pricing.cleanup);
  return pricing;
}

async function seedBilling(
  actor: TranslationActor,
): Promise<UsagePricingFixture> {
  await seedOrgMetadata({
    orgId: actor.orgId,
    tier: "pro",
    credits: STARTING_CREDITS,
  });
  return await createConfiguredTranslationPricing();
}

async function readUsageRecord(actor: TranslationActor) {
  context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  const response = await accept(
    setupApp({ context, routes: zeroUsageRecordRoutes })(
      zeroUsageRecordContract,
    ).get({
      headers: { authorization: "Bearer clerk-session" },
      query: {
        page: 1,
        pageSize: 20,
        scope: "mine",
        range: "24h",
        tz: "UTC",
      },
    }),
    [200],
  );
  return response.body.rows;
}

async function expectNoUsage(actor: TranslationActor): Promise<void> {
  await expect(readUsageRecord(actor)).resolves.toStrictEqual([]);
}

describe("POST /api/zero/translate", () => {
  it("translates with fixed Qwen routing and settles each invocation", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const requestBodies: unknown[] = [];
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        requestBodies.push(await request.json());
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "你好，世界" },
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
    const pricing = await seedBilling(actor);
    const clientRequestId = randomUUID();

    for (let invocation = 0; invocation < 2; invocation += 1) {
      const response = await requestTranslation({
        token: zeroToken(actor),
        text: "Hello, world",
        sourceLanguage: "English",
        targetLanguage: "Simplified Chinese",
        clientRequestId,
        usagePricingResolution: pricing.resolution,
      });
      expect(response.status).toBe(200);
      expect(response.body).toStrictEqual({
        text: "你好，世界",
        metadata: { creditsCharged: EXPECTED_CHARGE },
      });
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      model: TRANSLATION_MODEL,
      max_tokens: 8192,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: expect.stringContaining("dedicated translation engine"),
        },
        { role: "user" },
      ],
    });
    const firstBody = requestBodies[0] as {
      readonly messages: readonly { readonly content: string }[];
    };
    expect(JSON.parse(firstBody.messages[1]?.content ?? "")).toStrictEqual({
      sourceLanguage: "English",
      targetLanguage: "Simplified Chinese",
      text: "Hello, world",
    });
    await expect(readUsageRecord(actor)).resolves.toStrictEqual([
      expect.objectContaining({
        runId: actor.runId,
        tokens: 8000,
        credits: EXPECTED_CHARGE * 2,
      }),
    ]);
  });

  it("sends auto-detect as data when the source language is omitted", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let translationInput: unknown;
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        const body = (await request.json()) as {
          readonly messages: readonly { readonly content: string }[];
        };
        translationInput = JSON.parse(body.messages[1]?.content ?? "");
        return HttpResponse.json({
          choices: [{ finish_reason: "stop", message: { content: "Hello" } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        });
      }),
    );
    const actor = await seedActor();
    const pricing = await seedBilling(actor);

    const response = await requestTranslation({
      token: zeroToken(actor),
      text: "Bonjour",
      targetLanguage: "English",
      usagePricingResolution: pricing.resolution,
    });

    expect(response.status).toBe(200);
    expect(translationInput).toStrictEqual({
      sourceLanguage: "auto-detect",
      targetLanguage: "English",
      text: "Bonjour",
    });
  });

  it("enforces Zero-only capability authorization before provider work", async () => {
    const actor = await seedActor();

    const unauthenticated = await requestTranslation({});
    expect(unauthenticated.status).toBe(401);

    const missingCapability = await requestTranslation({
      token: zeroToken(actor, ["file:write"]),
    });
    expect(missingCapability.status).toBe(403);

    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const sessionResponse = await requestTranslation({
      token: "clerk-session",
    });
    expect(sessionResponse.status).toBe(403);
  });

  it("rejects invalid request text before provider work", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let providerCalled = false;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerCalled = true;
        return HttpResponse.json({});
      }),
    );
    const actor = await seedActor();

    for (const text of [
      "   ",
      "x".repeat(ZERO_TRANSLATION_MAX_SOURCE_TEXT_CHARS + 1),
    ]) {
      const response = await requestTranslation({
        token: zeroToken(actor),
        text,
      });
      expect(response.status).toBe(400);
    }
    expect(providerCalled).toBeFalsy();
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
    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 0 });
    const pricing = await createConfiguredTranslationPricing();

    const noCredits = await requestTranslation({
      token: zeroToken(actor),
      usagePricingResolution: pricing.resolution,
    });
    expect(noCredits.status).toBe(402);

    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro",
      credits: STARTING_CREDITS,
    });
    const missingPricing = await createUsagePricingFixture({
      missing: TRANSLATION_PRICING_ROWS,
    });
    onTestFinished(missingPricing.cleanup);
    const noPricing = await requestTranslation({
      token: zeroToken(actor),
      usagePricingResolution: missingPricing.resolution,
    });
    expect(noPricing.status).toBe(503);
    expect(providerCalled).toBeFalsy();
    await expectNoUsage(actor);
  });

  it("maps provider failures without exposing raw provider text", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(
          { error: { message: "raw-provider-secret-detail" } },
          { status: 429 },
        );
      }),
    );
    const actor = await seedActor();
    const pricing = await seedBilling(actor);

    const response = await requestTranslation({
      token: zeroToken(actor),
      usagePricingResolution: pricing.resolution,
    });

    expect(response.status).toBe(503);
    const responseText = JSON.stringify(response.body);
    expect(responseText).toContain("PROVIDER_UNAVAILABLE");
    expect(responseText).not.toContain("raw-provider-secret-detail");
    await expectNoUsage(actor);
  });

  it("rejects usable text when provider usage metadata is incomplete", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const usages = [
      undefined,
      { prompt_tokens: 10 },
      { completion_tokens: 10 },
      {
        prompt_tokens: 10,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 11 },
      },
    ] as const;
    let providerCall = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        const usage = usages[providerCall];
        providerCall += 1;
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Unbilled result" },
            },
          ],
          ...(usage === undefined ? {} : { usage }),
        });
      }),
    );
    const actor = await seedActor();
    const pricing = await seedBilling(actor);

    for (const _usage of usages) {
      const response = await requestTranslation({
        token: zeroToken(actor),
        usagePricingResolution: pricing.resolution,
      });
      expect(response.status).toBe(502);
      expect(response.body).toMatchObject({
        error: { code: "MISSING_PROVIDER_USAGE" },
      });
    }
    await expectNoUsage(actor);
  });

  it("rejects incomplete or empty provider output without recording usage", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let providerCall = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerCall += 1;
        return HttpResponse.json({
          choices: [
            providerCall === 1
              ? {
                  finish_reason: "length",
                  message: { content: "Incomplete result" },
                }
              : { finish_reason: "stop", message: { content: "   " } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
      }),
    );
    const actor = await seedActor();
    const pricing = await seedBilling(actor);

    for (let invocation = 0; invocation < 2; invocation += 1) {
      const response = await requestTranslation({
        token: zeroToken(actor),
        usagePricingResolution: pricing.resolution,
      });
      expect(response.status).toBe(502);
      expect(response.body).toMatchObject({
        error: { code: "TRANSLATION_FAILED" },
      });
    }
    expect(providerCall).toBe(2);
    await expectNoUsage(actor);
  });

  it("does not return text when settlement reports a billing error", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const actor = await seedActor();
    const pricing = await seedBilling(actor);
    const lookupProvider = pricing.resolution[0]?.lookupProvider;
    if (!lookupProvider) {
      throw new Error("Translation pricing fixture requires a lookup provider");
    }
    server.use(
      http.post(OPENROUTER_URL, async () => {
        await deleteUsagePricingRows({
          kind: "translation",
          provider: lookupProvider,
          categories: ["tokens.output"],
        });
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "This text must not be returned" },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        });
      }),
    );

    const response = await requestTranslation({
      token: zeroToken(actor),
      usagePricingResolution: pricing.resolution,
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(
      "This text must not be returned",
    );
  });
});
