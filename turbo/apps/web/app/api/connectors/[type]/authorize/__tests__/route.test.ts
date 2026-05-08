import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";

const context = testContext();

describe("GET /api/connectors/:type/authorize - OAuth Authorize", () => {
  beforeEach(() => {
    context.setupMocks();
    // Set required OAuth environment variables
    vi.stubEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    vi.stubEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
    vi.stubEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
    vi.stubEnv("SLACK_CLIENT_ID", "test-slack-client-id");
    vi.stubEnv("SLACK_CLIENT_SECRET", "test-slack-client-secret");
    vi.stubEnv("DOCUSIGN_OAUTH_CLIENT_ID", "docusign-test-client-id");
    vi.stubEnv("DOCUSIGN_OAUTH_CLIENT_SECRET", "docusign-test-client-secret");
    vi.stubEnv("MERCURY_OAUTH_CLIENT_ID", "mercury-test-client-id");
    vi.stubEnv("MERCURY_OAUTH_CLIENT_SECRET", "mercury-test-client-secret");
    vi.stubEnv("REDDIT_OAUTH_CLIENT_ID", "reddit-test-client-id");
    vi.stubEnv("REDDIT_OAUTH_CLIENT_SECRET", "reddit-test-client-secret");
    vi.stubEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
    vi.stubEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
    reloadEnv();
  });

  it("should return 400 for unknown connector type", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/invalid/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "invalid" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("Unknown connector type");
  });

  it("should redirect unauthenticated user to login", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/sign-in");
    expect(location).toContain("redirect_url");
  });

  it("should redirect to GitHub OAuth with correct parameters", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("redirect_uri=");
    expect(location).toContain("scope=repo");
    expect(location).toContain("state=");
  });

  it("should set state cookie for CSRF protection", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    const cookies = response.headers.getSetCookie();
    const stateCookie = cookies.find((c) => {
      return c.startsWith("connector_oauth_state=");
    });
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=Lax");
  });

  it("should store session ID in cookie when provided", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize?session=test-session-id",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find((c) => {
      return c.startsWith("connector_oauth_session=");
    });
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("test-session-id");
  });

  it("should not set session cookie when session parameter is absent", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "github" }),
    });

    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find((c) => {
      return c.startsWith("connector_oauth_session=");
    });
    expect(sessionCookie).toBeUndefined();
  });

  it("should return 400 for refresh-only codex-oauth connector", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/codex-oauth/authorize",
    );
    const response = await GET(request, {
      params: Promise.resolve({ type: "codex-oauth" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("auth.json paste flow");
  });

  describe("Slack connector", () => {
    it("should redirect to Slack OAuth with correct parameters", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/slack/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "slack" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("https://slack.com/oauth/v2/authorize");
      expect(location).toContain("client_id=test-slack-client-id");
      expect(location).toContain("redirect_uri=");
      expect(location).toContain("user_scope=");
      expect(location).not.toContain("&scope=");
      expect(location).toContain("state=");
    });

    it("should use user_scope not scope for Slack OAuth", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/slack/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "slack" }),
      });

      const location = response.headers.get("location");
      const url = new URL(location!);
      expect(url.searchParams.get("user_scope")).toContain("channels:read");
      expect(url.searchParams.get("scope")).toBeNull();
    });
  });

  describe("DocuSign connector", () => {
    it("should redirect to DocuSign OAuth with correct parameters", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/docusign/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "docusign" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("https://account-d.docusign.com/oauth/auth");
      expect(location).toContain("client_id=docusign-test-client-id");
      expect(location).toContain("redirect_uri=");
      expect(location).toContain("response_type=code");
      expect(location).toContain("scope=signature");
      expect(location).toContain("state=");
    });
  });

  describe("Mercury connector", () => {
    it("should redirect to Mercury OAuth with correct parameters", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/mercury/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "mercury" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("https://oauth2.mercury.com/oauth2/auth");
      expect(location).toContain("client_id=mercury-test-client-id");
      expect(location).toContain("redirect_uri=");
      expect(location).toContain("response_type=code");
      expect(location).toContain("scope=offline_access");
      expect(location).toContain("state=");
    });
  });

  describe("Notion connector", () => {
    it("should redirect to Notion OAuth with correct parameters", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/notion/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "notion" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("https://api.notion.com/v1/oauth/authorize");
      expect(location).toContain("client_id=notion-test-client-id");
      expect(location).toContain("redirect_uri=");
      expect(location).toContain("response_type=code");
      expect(location).toContain("owner=user");
      expect(location).toContain("state=");
    });

    it("should set state cookie for CSRF protection", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/notion/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "notion" }),
      });

      const cookies = response.headers.getSetCookie();
      const stateCookie = cookies.find((c) => {
        return c.startsWith("connector_oauth_state=");
      });
      expect(stateCookie).toBeDefined();
      expect(stateCookie).toContain("HttpOnly");
      expect(stateCookie).toContain("SameSite=Lax");
    });
  });

  describe("Reddit connector", () => {
    it("should redirect to Reddit OAuth with correct parameters", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/reddit/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "reddit" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("https://www.reddit.com/api/v1/authorize");
      expect(location).toContain("client_id=reddit-test-client-id");
      expect(location).toContain("redirect_uri=");
      expect(location).toContain("response_type=code");
      expect(location).toContain("scope=identity+read");
      expect(location).toContain("duration=permanent");
      expect(location).toContain("state=");
    });
  });

  describe("X connector", () => {
    it("should redirect to X OAuth with PKCE parameters", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/x/authorize",
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "x" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("twitter.com/i/oauth2/authorize");
      expect(location).toContain("client_id=x-test-client-id");
      expect(location).toContain("redirect_uri=");
      expect(location).toContain("response_type=code");
      expect(location).toContain("code_challenge=");
      expect(location).toContain("code_challenge_method=S256");
      expect(location).toContain("state=");
    });
  });
});
