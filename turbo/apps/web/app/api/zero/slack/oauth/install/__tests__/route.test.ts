import { describe, it, expect, vi } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../../../src/env";

describe("/api/zero/slack/oauth/install", () => {
  it("should redirect to Slack OAuth URL with correct parameters", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/install",
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
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/zero/slack/oauth/callback",
    );
  });

  it("should include all required bot scopes", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/install",
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const scopes = redirectUrl.searchParams.get("scope")!.split(",");

    expect(scopes).toContain("app_mentions:read");
    expect(scopes).toContain("assistant:write");
    expect(scopes).toContain("chat:write");
    expect(scopes).toContain("channels:history");
    expect(scopes).toContain("im:history");
    expect(scopes).toContain("commands");
    expect(scopes).toContain("users:read");
    expect(scopes).toContain("files:read");
    expect(scopes).toContain("files:write");
  });

  it("should pass orgId and vm0UserId in state for platform flow", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/install?orgId=org_123&vm0UserId=user_456",
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    expect(state.orgId).toBe("org_123");
    expect(state.vm0UserId).toBe("user_456");
  });

  it("should not include state parameter for slack-initiated flow", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/install",
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);

    expect(redirectUrl.searchParams.get("state")).toBeNull();
  });

  it("should use VM0_API_URL for redirect_uri when configured", async () => {
    vi.stubEnv("VM0_API_URL", "https://tunnel.example.com");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/install",
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "https://tunnel.example.com/api/zero/slack/oauth/callback",
    );
  });

  it("should include prompt in state when present in query", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/install?orgId=org_123&vm0UserId=user_456&prompt=summarize%20my%20inbox",
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    expect(state.prompt).toBe("summarize my inbox");
    expect(state.orgId).toBe("org_123");
  });

  it("should truncate long prompts to protect OAuth state length", async () => {
    const longPrompt = "x".repeat(1200);
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/install?prompt=${encodeURIComponent(longPrompt)}`,
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
    // Each emoji is one codepoint but multiple UTF-16 code units
    const emojiPrompt = "\u{1F600}".repeat(600);
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/install?prompt=${encodeURIComponent(emojiPrompt)}`,
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    // Should have exactly 500 codepoints, not split surrogate pairs
    expect([...state.prompt].length).toBe(500);
    for (const char of state.prompt) {
      expect(char).toBe("\u{1F600}");
    }
  });

  it("should omit prompt from state when absent", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/install?orgId=org_123&vm0UserId=user_456",
    );
    const response = await GET(request);

    const locationHeader = response.headers.get("Location");
    const redirectUrl = new URL(locationHeader!);
    const state = JSON.parse(redirectUrl.searchParams.get("state")!);

    expect(state.prompt).toBeUndefined();
  });

  it("should return 503 when Slack is not configured", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/install",
    );
    const response = await GET(request);

    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toBe("Slack integration is not configured");
  });
});
