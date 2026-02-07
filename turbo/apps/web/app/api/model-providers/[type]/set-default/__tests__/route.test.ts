import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestModelProvider,
  listTestModelProviders,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

function setDefault(type: string) {
  return createTestRequest(
    `http://localhost:3000/api/model-providers/${type}/set-default`,
    { method: "POST" },
  );
}

describe("POST /api/model-providers/[type]/set-default", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(setDefault("anthropic-api-key"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 when provider does not exist", async () => {
    const response = await POST(setDefault("anthropic-api-key"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should return provider unchanged when already default", async () => {
    const provider = await createTestModelProvider(
      "anthropic-api-key",
      "test-secret",
    );

    const response = await POST(setDefault("anthropic-api-key"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe(provider.id);
    expect(body.type).toBe("anthropic-api-key");
    expect(body.isDefault).toBe(true);
  });

  it("should set provider as default and clear other defaults in same framework", async () => {
    await createTestModelProvider("anthropic-api-key", "key1");
    await createTestModelProvider("openrouter-api-key", "key2");

    const response = await POST(setDefault("openrouter-api-key"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.type).toBe("openrouter-api-key");
    expect(body.isDefault).toBe(true);

    const providers = await listTestModelProviders();
    const anthropic = providers.find((p) => p.type === "anthropic-api-key");
    const openrouter = providers.find((p) => p.type === "openrouter-api-key");

    expect(anthropic?.isDefault).toBe(false);
    expect(openrouter?.isDefault).toBe(true);
  });
});
