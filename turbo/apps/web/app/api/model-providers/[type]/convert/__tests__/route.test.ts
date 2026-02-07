import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

function convertProvider(type: string) {
  return POST(
    createTestRequest(
      `http://localhost:3000/api/model-providers/${type}/convert`,
      { method: "POST" },
    ),
  );
}

describe("POST /api/model-providers/[type]/convert (deprecated)", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await convertProvider("anthropic-api-key");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toContain("Not authenticated");
  });

  it("should return 400 with deprecation message", async () => {
    const response = await convertProvider("anthropic-api-key");
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain("no longer needed");
  });
});
