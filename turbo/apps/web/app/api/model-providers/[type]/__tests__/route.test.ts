import { describe, it, expect, beforeEach, vi } from "vitest";
import { DELETE } from "../route";
import {
  createTestRequest,
  createTestModelProvider,
  listTestModelProviders,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

function deleteProvider(type: string) {
  return DELETE(
    createTestRequest(`http://localhost:3000/api/model-providers/${type}`, {
      method: "DELETE",
    }),
  );
}

describe("DELETE /api/model-providers/[type]", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await deleteProvider("anthropic-api-key");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 when provider does not exist", async () => {
    const response = await deleteProvider("anthropic-api-key");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should delete provider and return 204", async () => {
    await createTestModelProvider("anthropic-api-key", "test-secret");

    const response = await deleteProvider("anthropic-api-key");

    expect(response.status).toBe(204);

    const providers = await listTestModelProviders();
    expect(
      providers.find((p) => p.type === "anthropic-api-key"),
    ).toBeUndefined();
  });

  it("should assign new default when deleting default provider", async () => {
    await createTestModelProvider("anthropic-api-key", "key1");
    await createTestModelProvider("openrouter-api-key", "key2");

    const response = await deleteProvider("anthropic-api-key");

    expect(response.status).toBe(204);

    const providers = await listTestModelProviders();
    const openrouter = providers.find((p) => p.type === "openrouter-api-key");
    expect(openrouter?.isDefault).toBe(true);
  });
});
