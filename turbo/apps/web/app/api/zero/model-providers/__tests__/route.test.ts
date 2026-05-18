import { describe, it, expect, beforeEach } from "vitest";
import { DELETE } from "../[type]/route";
import {
  createTestOrgModelProvider,
  createTestRequest,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/model-providers";

function deleteUrl(type: string): string {
  return `${BASE_URL}/${type}`;
}

async function deleteProvider(type: string): Promise<Response> {
  return DELETE(
    createTestRequest(deleteUrl(type), {
      method: "DELETE",
    }),
  );
}

async function expectUnauthorized(
  responsePromise: Promise<Response> | Response,
): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(401);
  const data = await response.json();
  expect(data.error.code).toBe("UNAUTHORIZED");
}

describe("DELETE /api/zero/model-providers/[type]", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 without an active organization", async () => {
    mockClerk({ userId: user.userId, orgId: null });

    await expectUnauthorized(deleteProvider("anthropic-api-key"));
  });

  it("returns 403 for organization members", async () => {
    mockClerk({
      userId: user.userId,
      orgId: user.orgId,
      orgRole: "org:member",
    });

    const response = await deleteProvider("anthropic-api-key");

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("deletes an org provider", async () => {
    await createTestOrgModelProvider("anthropic-api-key", "test-key");

    const response = await deleteProvider("anthropic-api-key");

    expect(response.status).toBe(204);
    expect((await deleteProvider("anthropic-api-key")).status).toBe(404);
  });

  it("returns 404 when deleting a missing org provider", async () => {
    const response = await deleteProvider("anthropic-api-key");

    expect(response.status).toBe(404);
  });
});
