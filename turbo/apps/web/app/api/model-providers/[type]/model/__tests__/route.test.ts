import { describe, it, expect, beforeEach, vi } from "vitest";
import { PATCH } from "../route";
import { PUT } from "../../../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

/**
 * Helper to create a model provider for testing
 */
async function createModelProvider(
  type: string,
  secret: string,
  selectedModel?: string,
): Promise<{
  provider: { id: string; type: string; selectedModel: string | null };
}> {
  const request = createTestRequest(
    "http://localhost:3000/api/model-providers",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, secret, selectedModel }),
    },
  );
  const response = await PUT(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create provider: ${error.error?.message}`);
  }
  return response.json();
}

describe("PATCH /api/model-providers/:type/model - Update Model Selection", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/model-providers/moonshot-api-key/model",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedModel: "kimi-k2.5" }),
      },
    );
    const response = await PATCH(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should update model selection for existing provider", async () => {
    // Create provider first
    await createModelProvider("moonshot-api-key", "test-key", "kimi-k2.5");

    // Update model
    const request = createTestRequest(
      "http://localhost:3000/api/model-providers/moonshot-api-key/model",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedModel: "kimi-k2-thinking-turbo" }),
      },
    );
    const response = await PATCH(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe("moonshot-api-key");
    expect(data.selectedModel).toBe("kimi-k2-thinking-turbo");
  });

  it("should set model to null when selectedModel not provided", async () => {
    // Create provider with model
    await createModelProvider("moonshot-api-key", "test-key", "kimi-k2.5");

    // Update without model
    const request = createTestRequest(
      "http://localhost:3000/api/model-providers/moonshot-api-key/model",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await PATCH(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.selectedModel).toBeNull();
  });

  it("should return 404 for nonexistent provider", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/model-providers/anthropic-api-key/model",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedModel: "some-model" }),
      },
    );
    const response = await PATCH(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should preserve isDefault flag", async () => {
    // Create provider (will be default)
    const { provider } = await createModelProvider(
      "moonshot-api-key",
      "test-key",
      "kimi-k2.5",
    );
    expect(provider.id).toBeDefined();

    // Update model
    const request = createTestRequest(
      "http://localhost:3000/api/model-providers/moonshot-api-key/model",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedModel: "kimi-k2-thinking-turbo" }),
      },
    );
    const response = await PATCH(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.isDefault).toBe(true);
  });
});
