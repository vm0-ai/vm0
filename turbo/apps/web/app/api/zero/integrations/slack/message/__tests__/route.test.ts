import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunInDb,
  createTestZeroAgent,
  createTestSlackOrgInstallation,
  insertOrgMembersCacheEntry,
  createTestSchedule,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import {
  generateSandboxToken,
  generateZeroToken,
} from "../../../../../../../src/lib/auth/sandbox-token";

const URL = "http://localhost:3000/api/zero/integrations/slack/message";

const context = testContext();

describe("POST /api/zero/integrations/slack/message", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  /** Helper: create a run and return a sandbox token */
  async function sandboxTokenWithRun() {
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRunInDb(user.userId, composeId);
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, runId);
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

  it("returns 403 when sandbox token lacks slack:write", async () => {
    const { token } = await sandboxTokenWithRun();

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
    expect(data.error.message).toContain("slack:write");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

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
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

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
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

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

  it("sends DM via user field using conversations.open", async () => {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);
    await createTestSlackOrgInstallation({ orgId: user.orgId });

    const request = createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user: "U0A8V9X98QJ", text: "Hello DM!" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);

    // Verify conversations.open was called with the user ID
    const mockClient = vi.mocked(new WebClient(""));
    expect(mockClient.conversations.open).toHaveBeenCalledWith({
      users: "U0A8V9X98QJ",
    });

    // Verify postMessage was called with the resolved DM channel
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D-mock-dm",
        text: "Hello DM!",
      }),
    );
  });

  it("returns 404 when conversations.open fails with user_not_found", async () => {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);
    await createTestSlackOrgInstallation({ orgId: user.orgId });

    // Mock conversations.open to fail
    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.conversations.open).mockRejectedValueOnce(
      Object.assign(new Error("user_not_found"), {
        data: { ok: false, error: "user_not_found" },
      }),
    );

    const request = createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user: "U-invalid", text: "hello" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("user_not_found");
  });

  it("appends 'Sent via' footer when agent is resolvable from run", async () => {
    const agentName = uniqueId("agent");
    const { composeId } = await createTestCompose(agentName);
    await createTestZeroAgent(user.orgId, agentName, {
      displayName: "My Assistant",
    });
    const { runId } = await createTestRunInDb(user.userId, composeId);

    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, runId, user.orgId);

    await createTestSlackOrgInstallation({ orgId: user.orgId });

    const request = createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "C123456", text: "Hello" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const mockClient = vi.mocked(new WebClient(""));
    const call = vi.mocked(mockClient.chat.postMessage).mock.calls[0]![0] as {
      blocks: Array<{ type: string; elements?: Array<{ text: string }> }>;
    };

    // Text-only message should be wrapped in a section block + footer
    const blocks = call.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe("section");
    expect((blocks[0] as unknown as { text: { text: string } }).text.text).toBe(
      "Hello",
    );
    expect(blocks[blocks.length - 2]!.type).toBe("divider");
    const footerCtx = blocks[blocks.length - 1]!;
    expect(footerCtx.type).toBe("context");
    expect(footerCtx.elements![0]!.text).toBe("Sent via My Assistant");
  });

  it("appends schedule context in footer when run is triggered by a schedule", async () => {
    const agentName = uniqueId("agent");
    const { composeId } = await createTestCompose(agentName);
    await createTestZeroAgent(user.orgId, agentName, {
      displayName: "My Assistant",
    });

    // Create a schedule with a description
    const schedule = await createTestSchedule(composeId, "daily-standup", {
      description: "Daily standup summary",
    });

    // Create run linked to the schedule
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      scheduleId: schedule.id,
      triggerSource: "schedule",
    });

    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, runId, user.orgId);
    await createTestSlackOrgInstallation({ orgId: user.orgId });

    const request = createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "C123456", text: "Standup results" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const mockClient = vi.mocked(new WebClient(""));
    const call = vi.mocked(mockClient.chat.postMessage).mock.calls[0]![0] as {
      blocks: Array<{ type: string; elements?: Array<{ text: string }> }>;
    };

    const blocks = call.blocks;
    expect(blocks).toHaveLength(3); // section + divider + context

    const footerCtx = blocks[blocks.length - 1]!;
    expect(footerCtx.type).toBe("context");
    expect(footerCtx.elements![0]!.text).toBe(
      'Sent via My Assistant · Triggered by schedule "Daily standup summary"',
    );
  });
});
