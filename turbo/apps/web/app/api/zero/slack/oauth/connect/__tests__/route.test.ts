import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../../src/__tests__/api-test-helpers";
import { createTestSlackOrgInstallation } from "../../../../../../../src/__tests__/db-test-seeders/slack";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../../src/env";

const context = testContext();

describe("/api/zero/slack/oauth/connect", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should redirect to Slack OAuth v2 URL with team parameter", async () => {
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    await createTestSlackOrgInstallation({ workspaceId, orgId });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/connect?orgId=${orgId}&vm0UserId=user_123`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);

    const locationHeader = response.headers.get("Location");
    expect(locationHeader).toBeDefined();

    const redirectUrl = new URL(locationHeader!);
    expect(redirectUrl.origin).toBe("https://slack.com");
    expect(redirectUrl.pathname).toBe("/oauth/v2/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe(
      "test-slack-client-id",
    );
    expect(redirectUrl.searchParams.get("user_scope")).toBe("identity.basic");
    expect(redirectUrl.searchParams.get("team")).toBe(workspaceId);
  });

  it("should include orgId, vm0UserId, and flow in state", async () => {
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    await createTestSlackOrgInstallation({ workspaceId, orgId });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/connect?orgId=${orgId}&vm0UserId=user_456`,
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    expect(state.orgId).toBe(orgId);
    expect(state.vm0UserId).toBe("user_456");
    expect(state.flow).toBe("connect");
  });

  it("should return 404 when no Slack installation exists for org", async () => {
    const orgId = uniqueId("org");

    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/connect?orgId=${orgId}&vm0UserId=user_123`,
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe(
      "No Slack workspace installed for this organization",
    );
  });

  it("should return 400 when orgId is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/connect?vm0UserId=user_123",
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Missing orgId or vm0UserId");
  });

  it("should return 400 when vm0UserId is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/connect?orgId=org_123",
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Missing orgId or vm0UserId");
  });

  it("should return 503 when Slack is not configured", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/connect?orgId=org_123&vm0UserId=user_123",
    );
    const response = await GET(request);

    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toBe("Slack integration is not configured");
  });

  it("should include prompt in state when present in query", async () => {
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    await createTestSlackOrgInstallation({ workspaceId, orgId });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/connect?orgId=${orgId}&vm0UserId=user_123&prompt=summarize%20my%20inbox`,
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    expect(state.prompt).toBe("summarize my inbox");
    expect(state.flow).toBe("connect");
    expect(state.orgId).toBe(orgId);
  });

  it("should truncate long prompts to protect OAuth state length", async () => {
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    await createTestSlackOrgInstallation({ workspaceId, orgId });

    const longPrompt = "x".repeat(1200);
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/connect?orgId=${orgId}&vm0UserId=user_123&prompt=${encodeURIComponent(longPrompt)}`,
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    expect(typeof state.prompt).toBe("string");
    expect(state.prompt.length).toBe(500);
    expect(state.prompt).toBe("x".repeat(500));
  });

  it("should truncate prompts with unicode characters without splitting codepoints", async () => {
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    await createTestSlackOrgInstallation({ workspaceId, orgId });

    // Each emoji is one codepoint but multiple UTF-16 code units
    const emojiPrompt = "\u{1F600}".repeat(600);
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/connect?orgId=${orgId}&vm0UserId=user_123&prompt=${encodeURIComponent(emojiPrompt)}`,
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    // Should have exactly 500 codepoints, not split surrogate pairs
    expect([...state.prompt].length).toBe(500);
    // Every character should be a complete emoji, not a broken surrogate
    for (const char of state.prompt) {
      expect(char).toBe("\u{1F600}");
    }
  });

  it("should omit prompt from state when absent", async () => {
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    await createTestSlackOrgInstallation({ workspaceId, orgId });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/connect?orgId=${orgId}&vm0UserId=user_123`,
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    expect(state.prompt).toBeUndefined();
  });

  it("should use VM0_API_URL for redirect_uri when configured", async () => {
    vi.stubEnv("VM0_API_URL", "https://tunnel.example.com");
    reloadEnv();

    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    await createTestSlackOrgInstallation({ workspaceId, orgId });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/connect?orgId=${orgId}&vm0UserId=user_123`,
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "https://tunnel.example.com/api/zero/slack/oauth/callback",
    );
  });
});
