import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../src/lib/auth/sandbox-token";

const context = testContext();

const URL = "http://localhost:3000/api/zero/runs";

describe("POST /api/zero/runs", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 403 for sandbox token without agent-run:write capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken("user-1", "run-1", ["agent:read"]);

    const response = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: "some-compose-id",
          prompt: "test prompt",
        }),
      }),
    );
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.message).toContain("agent-run:write");
  });
});
