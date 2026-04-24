import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { POST } from "../route";
import {
  createTestRequest,
  setOrgCredits,
  insertTestUsagePricing,
  getOrgCredits,
} from "../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../src/env";

// Vertex AI is the route's only external dependency. A single mock instance
// is reused for every test in this file because the route caches the
// GoogleGenAI client module-globally; per-test behaviour is swapped via
// mockGenerateContent.mockResolvedValueOnce().
const mockGenerateContent = vi.fn();
vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent } };
    }),
  };
});

const context = testContext();

function postRequest(body: unknown): NextRequest {
  return createTestRequest("http://localhost:3000/api/generate-image", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/generate-image", () => {
  // The 503 branches depend on buildClient() observing an unconfigured env,
  // which only works on calls where the route has not yet cached a client
  // — once cached, subsequent calls skip the env check entirely. Keep this
  // block first, do NOT stub GEMINI_API_KEY in ways that would succeed
  // (e.g. outside production), and keep the tests ordered so every failed
  // buildClient() leaves cachedClient undefined.
  describe("When unconfigured", () => {
    it("returns 503 when neither GEMINI_API_KEY nor GCP_* vars are set", async () => {
      context.setupMocks();
      await context.setupUser();

      const response = await POST(postRequest({ prompt: "hello" }));

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_CONFIGURED");
    });

    it("ignores GEMINI_API_KEY in production and requires GCP vars", async () => {
      context.setupMocks();
      await context.setupUser();
      // Production must never fall back to the Gemini Developer API — that
      // bypasses OIDC and would route charges to an unmanaged billing
      // account. The dev-only escape hatch is gated to non-production envs.
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("GEMINI_API_KEY", "stray-prod-key");
      reloadEnv();

      const response = await POST(postRequest({ prompt: "hello" }));

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_CONFIGURED");
    });
  });

  describe("With Gemini API key configured", () => {
    let user: UserContext;

    beforeEach(async () => {
      context.setupMocks();
      user = await context.setupUser();
      vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
      reloadEnv();
      mockGenerateContent.mockReset();
    });

    it("returns 401 when there is no Clerk session", async () => {
      mockClerk({ userId: null });

      const response = await POST(postRequest({ prompt: "hello" }));

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when prompt is missing or blank", async () => {
      const response = await POST(postRequest({ prompt: "   " }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 402 when the org has no spendable credits", async () => {
      await setOrgCredits(user.orgId, 0);

      const response = await POST(postRequest({ prompt: "hello" }));

      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data.error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("returns 502 when the model returns no inlineData parts", async () => {
      await setOrgCredits(user.orgId, 1000);
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "sorry no image" }] } }],
      });

      const response = await POST(postRequest({ prompt: "hello" }));

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.error.code).toBe("NO_IMAGE_RETURNED");
    });

    it("returns 200 and settles credits inline on success", async () => {
      await setOrgCredits(user.orgId, 1000);
      await insertTestUsagePricing({
        kind: "image",
        provider: "gemini-2.5-flash-image",
        category: "output_image",
        unitPrice: 39,
        unitSize: 1,
      });
      mockGenerateContent.mockResolvedValueOnce({
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

      const response = await POST(postRequest({ prompt: "a cat" }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.images).toHaveLength(1);
      expect(data.images[0]).toEqual({
        mimeType: "image/png",
        base64: "base64data==",
      });

      // Balance is unchanged until the after() block drains, which proves
      // settlement happens out-of-band rather than inline with the response.
      expect(await getOrgCredits(user.orgId)).toBe(1000);

      await context.mocks.flushAfter();

      // One 1024×1024 image × 39 credits/image = 39 charged, 961 remaining.
      expect(await getOrgCredits(user.orgId)).toBe(961);
    });
  });
});
