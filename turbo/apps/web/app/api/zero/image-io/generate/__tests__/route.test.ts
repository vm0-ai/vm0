import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import {
  createTestCompose,
  createTestRequest,
  createTestOrg,
  deleteTestUsagePricing,
  findTestUsageEventsByRunId,
  getOrgCredits,
  insertOrgMembersCacheEntry,
  insertTestChatThread,
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
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { findTestRunUploadedFiles } from "../../../../../../src/__tests__/db-test-assertions/run-uploaded-files";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";

vi.hoisted(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
});

const { POST } = await import("../route");

const context = testContext();
const IMAGE_URL = "http://localhost:3000/api/zero/image-io/generate";
const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const FAL_QWEN_IMAGE_URL = "https://fal.run/fal-ai/qwen-image";
const FAL_MEDIA_URL = "https://fal.media/files/test/qwen.jpg";
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
  provider: string;
  imageSize: string;
  quality: string;
  background: string;
  outputFormat: string;
  outputCompression?: number;
  moderation?: string;
  billingCategory?: string;
  billingQuantity?: number;
  sourceUrl?: string;
  seed?: number;
  usage?: {
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
    unitPrice: 6000,
    unitSize: 1_000_000,
  });
  await insertTestUsagePricing({
    kind: "image",
    provider: MODEL,
    category: "tokens.input.image",
    unitPrice: 9600,
    unitSize: 1_000_000,
  });
  await insertTestUsagePricing({
    kind: "image",
    provider: MODEL,
    category: "tokens.output.image",
    unitPrice: 36_000,
    unitSize: 1_000_000,
  });
}

async function seedFalImagePricing() {
  await insertTestUsagePricing({
    kind: "image",
    provider: "fal-ai/qwen-image",
    category: "output_megapixel",
    unitPrice: 24,
    unitSize: 1,
  });
}

async function setupRunScopedToken(userId: string, orgId: string) {
  const { composeId } = await createTestCompose(uniqueId("image-agent"));
  const threadId = await insertTestChatThread(userId, composeId, "Images");
  const { runId } = await seedTestRun(userId, composeId, {
    chatThreadId: threadId,
    orgId,
    triggerSource: "schedule",
  });
  await insertOrgMembersCacheEntry({
    orgId,
    userId,
    role: "admin",
  });
  mockClerk({ userId: null });
  const token = await generateZeroToken(userId, runId, orgId);
  return { token, runId, threadId };
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
    mockAblyPublish.mockClear();
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("FAL_KEY", "test-fal-key");
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

  it("returns 400 when transparent background is requested", async () => {
    const userId = uniqueId("image-transparent");
    await setupOrg(userId);

    const response = await POST(
      imageRequest({
        prompt: "a transparent badge",
        background: "transparent",
        outputFormat: "webp",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "gpt-image-2 does not support transparent backgrounds",
    });
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
    const { token, runId, threadId } = await setupRunScopedToken(userId, orgId);
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
          size: "2048x1152",
          quality: "auto",
          background: "opaque",
          output_format: "webp",
          output_compression: 50,
          moderation: "low",
        });

        return HttpResponse.json({
          created: 123,
          data: [
            {
              b64_json: IMAGE_BYTES.toString("base64"),
              revised_prompt: "A small robot paints a sunflower.",
            },
          ],
          output_format: "webp",
          size: "2048x1152",
          quality: "auto",
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
        {
          prompt: "a small robot painting a sunflower",
          size: "2048x1152",
          quality: "auto",
          background: "opaque",
          outputFormat: "webp",
          outputCompression: 50,
          moderation: "low",
        },
        { Authorization: `Bearer ${token}` },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ImageResponse;
    expect(body).toMatchObject({
      filename: expect.stringMatching(/^image-[0-9a-f-]{8}\.webp$/),
      contentType: "image/webp",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 78,
      model: MODEL,
      provider: "openai",
      imageSize: "2048x1152",
      quality: "auto",
      background: "opaque",
      outputFormat: "webp",
      outputCompression: 50,
      moderation: "low",
      usage: {
        textInputTokens: 1000,
        imageInputTokens: 0,
        imageOutputTokens: 2000,
        totalTokens: 3000,
      },
    });
    expect(body.id).toEqual(expect.any(String));
    expect(body.url).toBe(
      `http://localhost:3000/f/${encodeURIComponent(userId.replace(/^user_/, ""))}/${body.id}/${body.filename}`,
    );

    expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledTimes(1);
    const [bucket, key, uploadedBytes, contentType] =
      context.mocks.s3.uploadS3Buffer.mock.calls[0]!;
    expect(bucket).toBe("test-bucket");
    expect(key).toBe(`uploads/${userId}/${body.id}/${body.filename}`);
    expect(uploadedBytes.equals(IMAGE_BYTES)).toBe(true);
    expect(contentType).toBe("image/webp");

    const rows = await findTestRunUploadedFiles("schedule", body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      source: "schedule",
      externalId: body.id,
      userId,
      orgId,
      filename: body.filename,
      contentType: "image/webp",
      sizeBytes: IMAGE_BYTES.byteLength,
      url: body.url,
      metadata: expect.objectContaining({
        generatedBy: "zero-official-image",
        model: MODEL,
        provider: "openai",
        s3Key: `uploads/${userId}/${body.id}/${body.filename}`,
        imageSize: "2048x1152",
        quality: "auto",
        background: "opaque",
        outputFormat: "webp",
        outputCompression: 50,
        moderation: "low",
      }),
    });
    expect(mockAblyPublish).toHaveBeenCalledWith(
      `chatThreadArtifactsChanged:${threadId}`,
      null,
    );
    expect(await getOrgCredits(orgId)).toBe(922);
    expect(await findTestUsageEventsByRunId(runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "image",
          provider: MODEL,
          category: "tokens.input.text",
          quantity: 1000,
          status: "processed",
        }),
        expect.objectContaining({
          kind: "image",
          provider: MODEL,
          category: "tokens.output.image",
          quantity: 2000,
          status: "processed",
        }),
      ]),
    );
  });

  it("stores a /f image and settles fal megapixel usage inline", async () => {
    const userId = uniqueId("image-fal");
    const { orgId } = await setupOrg(userId);
    const { token, runId } = await setupRunScopedToken(userId, orgId);
    await setOrgCredits(orgId, 1000);
    await seedFalImagePricing();

    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(FAL_QWEN_IMAGE_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          images: [
            {
              url: FAL_MEDIA_URL,
              width: 1536,
              height: 1024,
              content_type: "image/jpeg",
            },
          ],
          prompt: "A precise product render.",
          seed: 99,
        });
      }),
      http.get(FAL_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const response = await POST(
      imageRequest(
        {
          prompt: "a precise product render",
          model: "qwen-image",
          size: "1536x1024",
          outputFormat: "jpeg",
          seed: 99,
        },
        { Authorization: `Bearer ${token}` },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ImageResponse;
    expect(body).toMatchObject({
      contentType: "image/jpeg",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 48,
      model: "fal-ai/qwen-image",
      provider: "fal",
      imageSize: "1536x1024",
      quality: "model-default",
      background: "auto",
      outputFormat: "jpeg",
      billingCategory: "output_megapixel",
      billingQuantity: 2,
      sourceUrl: FAL_MEDIA_URL,
      seed: 99,
    });
    expect(body.usage).toBeUndefined();
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a precise product render",
      image_size: { width: 1536, height: 1024 },
      num_images: 1,
      output_format: "jpeg",
      seed: 99,
    });

    const rows = await findTestUsageEventsByRunId(runId);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "image",
          provider: "fal-ai/qwen-image",
          category: "output_megapixel",
          quantity: 2,
          status: "processed",
        }),
      ]),
    );
    expect(await getOrgCredits(orgId)).toBe(952);
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
