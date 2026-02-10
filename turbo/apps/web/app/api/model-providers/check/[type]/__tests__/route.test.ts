import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestModelProvider,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

function checkProvider(type: string) {
  return createTestRequest(
    `http://localhost:3000/api/model-providers/check/${type}`,
  );
}

describe("GET /api/model-providers/check/[type]", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(checkProvider("anthropic-api-key"));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return exists: true when provider secret exists", async () => {
    await createTestModelProvider("anthropic-api-key", "test-secret");

    const response = await GET(checkProvider("anthropic-api-key"));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.exists).toBe(true);
    expect(data.secretName).toBe("ANTHROPIC_API_KEY");
  });

  it("should return exists: false when no provider secret", async () => {
    const response = await GET(checkProvider("anthropic-api-key"));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.exists).toBe(false);
  });

  it("should return exists: false for multi-auth provider type", async () => {
    const response = await GET(checkProvider("aws-bedrock"));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.exists).toBe(false);
  });
});
