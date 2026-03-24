import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunInDb,
  createTestSlackOrgInstallation,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

const URL = "http://localhost:3000/api/zero/integrations/slack/message";

const context = testContext();

describe("POST /api/zero/integrations/slack/message", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  /** Helper: create a run and return a sandbox token with given capabilities */
  async function sandboxTokenWithRun(
    capabilities: Parameters<typeof generateSandboxToken>[2],
  ) {
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRunInDb(user.userId, composeId);
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, runId, capabilities);
    return { token, runId };
  }

  it("returns 401 when no auth token provided", async () => {
    // Clear Clerk session so no auth path succeeds
    mockClerk({ userId: null });

    const request = createTestRequest(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C123", text: "hello" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 403 when sandbox token lacks integration-slack:write", async () => {
    const { token } = await sandboxTokenWithRun(["agent:read"]);

    const request = createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "C123", text: "hello" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.message).toContain("integration-slack:write");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const { token } = await sandboxTokenWithRun(["integration-slack:write"]);

    const request = createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "C123", text: "hello" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.message).toContain("No Slack installation");
  });

  it("sends message successfully and returns Slack response", async () => {
    const { token } = await sandboxTokenWithRun(["integration-slack:write"]);

    // Create Slack installation for the user's org
    await createTestSlackOrgInstallation({ orgId: user.orgId });

    const request = createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: "C123456",
        text: "Hello from agent",
        threadTs: "1234567890.123456",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.ts).toBe("mock.ts");

    // Verify Slack client was called with correct params
    const mockClient = vi.mocked(new WebClient(""));
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123456",
        text: "Hello from agent",
        thread_ts: "1234567890.123456",
      }),
    );
  });

  it("forwards Slack API error with 400 status", async () => {
    const { token } = await sandboxTokenWithRun(["integration-slack:write"]);

    await createTestSlackOrgInstallation({ orgId: user.orgId });

    // Mock Slack postMessage to throw a Slack API error
    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.chat.postMessage).mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );

    const request = createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "C-invalid", text: "hello" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe("SLACK_ERROR");
    expect(data.error.message).toContain("channel_not_found");
  });
});
