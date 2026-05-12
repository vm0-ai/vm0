import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { beforeEach, describe, expect, it } from "vitest";
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
    creditEnabled: true,
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

beforeEach(() => {
  context.mocks.googleGenAi.constructorArgs.mockClear();
  context.mocks.googleGenAi.generateContent.mockReset();
  context.mocks.vercelOidc.getToken.mockResolvedValue("test-oidc-token");
  mockEnv("ENV", "development");
  clearGeminiEnv();
});

describe("POST /api/generate-image", () => {
  it("returns 503 when neither GEMINI_API_KEY nor GCP vars are set", async () => {
    await trackFixture(seedFixture(1000));

    const response = await requestApp({ prompt: "hello" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Gemini image generation is not configured",
        code: "NOT_CONFIGURED",
      },
    });
  });

  it("ignores GEMINI_API_KEY in production and requires GCP vars", async () => {
    await trackFixture(seedFixture(1000));
    mockEnv("ENV", "production");
    mockEnv("GEMINI_API_KEY", "stray-prod-key");

    const response = await requestApp({ prompt: "hello" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Gemini image generation is not configured",
        code: "NOT_CONFIGURED",
      },
    });
  });

  it("returns 401 when there is no Clerk session", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    mockEnv("GEMINI_API_KEY", "test-gemini-key");

    const response = await requestApp({ prompt: "hello" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when prompt is missing or blank", async () => {
    await trackFixture(seedFixture(1000));
    mockEnv("GEMINI_API_KEY", "test-gemini-key");

    const response = await requestApp({ prompt: "   " });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "prompt is required and must be a non-empty string",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 402 when the org has no spendable credits", async () => {
    await trackFixture(seedFixture(0));
    mockEnv("GEMINI_API_KEY", "test-gemini-key");

    const response = await requestApp({ prompt: "hello" });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    expect(context.mocks.googleGenAi.generateContent).not.toHaveBeenCalled();
  });

  it("returns 502 when the model returns no image-bearing inlineData parts", async () => {
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

    const response = await requestApp({ prompt: "hello" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Model returned no image data",
        code: "NO_IMAGE_RETURNED",
      },
    });
  });

  it("returns 200 and settles credits through waitUntil on success", async () => {
    const fixture = await trackFixture(seedFixture(1000));
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

    const response = await requestApp({ prompt: "a cat" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      images: [{ mimeType: "image/png", base64: "base64data==" }],
    });
    expect(context.mocks.googleGenAi.generateContent).toHaveBeenCalledWith({
      model: "gemini-2.5-flash-image",
      contents: [{ role: "user", parts: [{ text: "a cat" }] }],
    });

    await clearAllDetached();

    await expect(orgCredits(fixture.orgId)).resolves.toBe(961);
  });
});
