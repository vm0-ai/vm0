import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearAllDetached } from "../../utils";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `generate-image.test.ts`. The 7
// legacy `it()`s collapse into 2 BDD `it()`s: (1) full chain
// (503 no Gemini config → 503 production ignores GEMINI_API_KEY →
// 401 no Clerk session → 400 blank prompt → 402 no credits → 502
// no image in response → 200 success + credits settled through
// waitUntil).
//
// Service-Level Exception: orgMetadata, orgMembersMetadata, and
// usagePricing rows are seeded directly via `writeDb$` because
// no public route creates them. Post-generation state (credits
// decrement, usage_event rows) is verified via direct DB reads.

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);
const mocks = createZeroRouteMocks(context);

interface GenerateImageFixture {
  readonly orgId: string;
  readonly userId: string;
}

function requestApp(body: unknown): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(
    app.request("/api/generate-image", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function clearGeminiEnv(): void {
  mockEnv("GEMINI_API_KEY", undefined);
  mockEnv("GCP_PROJECT_ID", undefined);
  mockEnv("GCP_PROJECT_NUMBER", undefined);
  mockEnv("GCP_SERVICE_ACCOUNT_EMAIL", undefined);
  mockEnv("GCP_WORKLOAD_IDENTITY_POOL_ID", undefined);
  mockEnv("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID", undefined);
}

async function seedFixture(credits: number): Promise<GenerateImageFixture> {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };

  await writeDb.insert(orgMetadata).values({
    orgId: fixture.orgId,
    credits,
    tier: "free",
  });
  await writeDb.insert(orgMembersMetadata).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
  });
  mocks.clerk.session(fixture.userId, fixture.orgId);

  return fixture;
}

async function setImagePricing(): Promise<void> {
  await writeDb
    .insert(usagePricing)
    .values({
      kind: "image",
      provider: "gemini-2.5-flash-image",
      category: "output_image",
      unitPrice: 39,
      unitSize: 1,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: 39,
        unitSize: 1,
      },
    });
}

async function orgCredits(orgId: string): Promise<number> {
  const [row] = await writeDb
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (!row) {
    throw new Error(`Missing org fixture: ${orgId}`);
  }
  return row.credits;
}

const trackFixture = createFixtureTracker(
  async (fixture: GenerateImageFixture): Promise<void> => {
    await writeDb.delete(usageEvent).where(eq(usageEvent.orgId, fixture.orgId));
    await writeDb
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, fixture.orgId));
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
  },
);

describe("BDD POST /api/generate-image — full chain", () => {
  // Each step re-seeds the mock + env so previous steps don't
  // leak.
  const resetMocksAndEnv = (): void => {
    context.mocks.googleGenAi.constructorArgs.mockClear();
    context.mocks.googleGenAi.generateContent.mockReset();
    context.mocks.vercelOidc.getToken.mockResolvedValue("test-oidc-token");
    mockEnv("ENV", "development");
    clearGeminiEnv();
  };

  it("gwt-wt-wt: 503 no Gemini config → 503 production ignores GEMINI_API_KEY → 401 no Clerk session → 400 blank prompt → 402 no credits → 502 no image in response → 200 success + credits settled", async () => {
    // Given: a fixture with credits, no Gemini config.
    resetMocksAndEnv();
    await trackFixture(seedFixture(1000));

    // When + Then: 503 — Gemini is not configured.
    const noConfig = await requestApp({ prompt: "hello" });
    expect(noConfig.status).toBe(503);
    await expect(noConfig.json()).resolves.toStrictEqual({
      error: {
        message: "Gemini image generation is not configured",
        code: "NOT_CONFIGURED",
      },
    });

    // Given: production env ignores GEMINI_API_KEY.
    resetMocksAndEnv();
    await trackFixture(seedFixture(1000));
    mockEnv("ENV", "production");
    mockEnv("GEMINI_API_KEY", "stray-prod-key");

    // When + Then: 503 — production requires GCP vars.
    const prodNoConfig = await requestApp({ prompt: "hello" });
    expect(prodNoConfig.status).toBe(503);
    await expect(prodNoConfig.json()).resolves.toStrictEqual({
      error: {
        message: "Gemini image generation is not configured",
        code: "NOT_CONFIGURED",
      },
    });

    // Given: no Clerk session + GEMINI_API_KEY is set.
    resetMocksAndEnv();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    mockEnv("GEMINI_API_KEY", "test-gemini-key");

    // When + Then: 401 — not authenticated.
    const noAuth = await requestApp({ prompt: "hello" });
    expect(noAuth.status).toBe(401);
    await expect(noAuth.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture + GEMINI_API_KEY.
    resetMocksAndEnv();
    await trackFixture(seedFixture(1000));
    mockEnv("GEMINI_API_KEY", "test-gemini-key");

    // When + Then: 400 — prompt is blank.
    const blankPrompt = await requestApp({ prompt: "   " });
    expect(blankPrompt.status).toBe(400);
    await expect(blankPrompt.json()).resolves.toStrictEqual({
      error: {
        message: "prompt is required and must be a non-empty string",
        code: "BAD_REQUEST",
      },
    });

    // Given: a fixture with 0 credits.
    resetMocksAndEnv();
    await trackFixture(seedFixture(0));
    mockEnv("GEMINI_API_KEY", "test-gemini-key");

    // When + Then: 402 — insufficient credits; Gemini is not
    // called.
    const noCredits = await requestApp({ prompt: "hello" });
    expect(noCredits.status).toBe(402);
    await expect(noCredits.json()).resolves.toStrictEqual({
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    expect(context.mocks.googleGenAi.generateContent).not.toHaveBeenCalled();

    // Given: a fixture + Gemini returns a response with no
    // image-bearing inlineData parts.
    resetMocksAndEnv();
    await trackFixture(seedFixture(1000));
    mockEnv("GEMINI_API_KEY", "test-gemini-key");
    context.mocks.googleGenAi.generateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            parts: [{ text: "sorry no image" }, { inlineData: null }],
          },
        },
      ],
    });

    // When + Then: 502 — no image returned.
    const noImage = await requestApp({ prompt: "hello" });
    expect(noImage.status).toBe(502);
    await expect(noImage.json()).resolves.toStrictEqual({
      error: {
        message: "Model returned no image data",
        code: "NO_IMAGE_RETURNED",
      },
    });

    // Given: a fixture with credits + image pricing + Gemini
    // returns a base64 image.
    resetMocksAndEnv();
    const successFixture = await trackFixture(seedFixture(1000));
    await setImagePricing();
    mockEnv("GEMINI_API_KEY", "test-gemini-key");
    context.mocks.googleGenAi.generateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: "image/png", data: "base64data==" } },
            ],
          },
        },
      ],
    });

    // When: post a generation request.
    const success = await requestApp({ prompt: "a cat" });

    // Then: 200 + the image is echoed + Gemini is called with
    // the right args.
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toStrictEqual({
      images: [{ mimeType: "image/png", base64: "base64data==" }],
    });
    expect(context.mocks.googleGenAi.generateContent).toHaveBeenCalledWith({
      model: "gemini-2.5-flash-image",
      contents: [{ role: "user", parts: [{ text: "a cat" }] }],
    });

    // When: waitUntil settles.
    await clearAllDetached();

    // Then: credits are debited.
    await expect(orgCredits(successFixture.orgId)).resolves.toBe(961);
  });
});
