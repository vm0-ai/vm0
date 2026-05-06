import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import {
  createTestRequest,
  createTestOrg,
  deleteTestUsagePricing,
  findTestRunlessUsageEventsByOrgProvider,
  getOrgCredits,
  insertTestUsagePricing,
  setOrgCredits,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import { generateZeroToken } from "../../../../../../src/lib/auth/sandbox-token";

vi.hoisted(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
});

const { POST } = await import("../route");

const context = testContext();
const IMAGE_URL = "http://localhost:3000/api/zero/image-io/generate";
const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const MODEL = "gpt-image-2";
const IMAGE_BYTES = Buffer.from("fake image bytes");

type ImageResponse = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  creditsCharged: number;
  model: string;
  imageSize: string;
  quality: string;
  outputFormat: string;
  usage: {
    textInputTokens: number;
    imageInputTokens: number;
    imageOutputTokens: number;
    totalTokens: number;
  };
};

async function setupOrg(userId: string) {
  const slug = uniqueId("image");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function imageRequest(
  body: unknown,
  headers?: Record<string, string>,
): Request {
  return createTestRequest(IMAGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function seedImagePricing() {
  await insertTestUsagePricing({
    kind: "image",
    provider: MODEL,
    category: "tokens.input.text",
    unitPrice: 5000,
    unitSize: 1_000_000,
  });
  await insertTestUsagePricing({
    kind: "image",
    provider: MODEL,
    category: "tokens.input.image",
    unitPrice: 8000,
    unitSize: 1_000_000,
  });
  await insertTestUsagePricing({
    kind: "image",
    provider: MODEL,
    category: "tokens.output.image",
    unitPrice: 30_000,
    unitSize: 1_000_000,
  });
}

async function deleteImagePricing() {
  for (const category of [
    "tokens.input.text",
    "tokens.input.image",
    "tokens.output.image",
  ]) {
    await deleteTestUsagePricing({
      kind: "image",
      provider: MODEL,
      category,
    });
  }
}

describe("POST /api/zero/image-io/generate", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(imageRequest({ prompt: "a cat" }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when prompt is empty", async () => {
    const userId = uniqueId("image-empty");
    await setupOrg(userId);

    const response = await POST(imageRequest({ prompt: "   " }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 402 when the org has no spendable credits", async () => {
    const userId = uniqueId("image-empty-wallet");
    const { orgId } = await setupOrg(userId);
    await setOrgCredits(orgId, 0);

    const response = await POST(imageRequest({ prompt: "a cat" }));
    const body = await response.json();

    expect(response.status).toBe(402);
    expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("returns 503 when image pricing is not configured", async () => {
    const userId = uniqueId("image-noprice");
    const { orgId } = await setupOrg(userId);
    await setOrgCredits(orgId, 1000);
    await deleteImagePricing();

    let openAiCalled = false;
    server.use(
      http.post(OPENAI_IMAGE_URL, () => {
        openAiCalled = true;
        return HttpResponse.json({ data: [] });
      }),
    );

    const response = await POST(imageRequest({ prompt: "a cat" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("NOT_CONFIGURED");
    expect(openAiCalled).toBe(false);
  });

  it("stores a /f image and settles OpenAI usage tokens inline", async () => {
    const userId = uniqueId("image-ok");
    const { orgId } = await setupOrg(userId);
    const runId = randomUUID();
    const token = await generateZeroToken(userId, runId, orgId);
    await setOrgCredits(orgId, 1000);
    await seedImagePricing();

    server.use(
      http.post(OPENAI_IMAGE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-openai-key",
        );
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          model: MODEL,
          prompt: "a small robot painting a sunflower",
          n: 1,
          size: "1024x1024",
          quality: "medium",
          background: "auto",
          output_format: "png",
        });

        return HttpResponse.json({
          created: 123,
          data: [
            {
              b64_json: IMAGE_BYTES.toString("base64"),
              revised_prompt: "A small robot paints a sunflower.",
            },
          ],
          output_format: "png",
          size: "1024x1024",
          quality: "medium",
          background: "opaque",
          usage: {
            total_tokens: 3000,
            input_tokens: 1000,
            output_tokens: 2000,
            input_tokens_details: {
              text_tokens: 1000,
              image_tokens: 0,
            },
          },
        });
      }),
    );

    const response = await POST(
      imageRequest(
        { prompt: "a small robot painting a sunflower" },
        { Authorization: `Bearer ${token}` },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ImageResponse;
    expect(body).toMatchObject({
      filename: expect.stringMatching(/^image-[0-9a-f-]{8}\.png$/),
      contentType: "image/png",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 65,
      model: MODEL,
      imageSize: "1024x1024",
      quality: "medium",
      outputFormat: "png",
      usage: {
        textInputTokens: 1000,
        imageInputTokens: 0,
        imageOutputTokens: 2000,
        totalTokens: 3000,
      },
    });
    expect(body.id).toEqual(expect.any(String));
    expect(body.url).toBe(
      `http://localhost:3000/f/${encodeURIComponent(userId)}/${body.id}/${body.filename}`,
    );

    expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledTimes(1);
    const [bucket, key, uploadedBytes, contentType] =
      context.mocks.s3.uploadS3Buffer.mock.calls[0]!;
    expect(bucket).toBe("test-bucket");
    expect(key).toBe(`uploads/${userId}/${body.id}/${body.filename}`);
    expect(uploadedBytes.equals(IMAGE_BYTES)).toBe(true);
    expect(contentType).toBe("image/png");

    expect(await getOrgCredits(orgId)).toBe(935);
    expect(await findTestRunlessUsageEventsByOrgProvider(orgId, MODEL)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: null,
          kind: "image",
          provider: MODEL,
          category: "tokens.input.text",
          quantity: 1000,
          creditsCharged: 5,
          status: "processed",
        }),
        expect.objectContaining({
          runId: null,
          kind: "image",
          provider: MODEL,
          category: "tokens.output.image",
          quantity: 2000,
          creditsCharged: 60,
          status: "processed",
        }),
      ]),
    );
  });

  it("returns 500 when OpenAI image generation fails", async () => {
    const userId = uniqueId("image-openai-fail");
    const { orgId } = await setupOrg(userId);
    await setOrgCredits(orgId, 1000);
    await seedImagePricing();

    server.use(
      http.post(OPENAI_IMAGE_URL, () => {
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const response = await POST(imageRequest({ prompt: "a cat" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
    expect(await getOrgCredits(orgId)).toBe(1000);
  });
});
