import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { GET } from "../route";
import { GET as getConnector } from "../../route";
import { GET as getSessionStatus } from "../../sessions/[sessionId]/route";
import { handlers, http } from "../../../../../../src/__tests__/msw";
import { server } from "../../../../../../src/mocks/server";
import { reloadEnv } from "../../../../../../src/env";
import {
  createTestRequest,
  createTestConnectorSession,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

/**
 * Create MSW handlers for GitHub OAuth API
 */
function createGitHubOAuthMock(options: {
  accessToken?: string;
  scopes?: string;
  tokenError?: string;
  userId?: number;
  username?: string;
  email?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(GITHUB_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "bad_verification_code",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "test-access-token",
        scope: options.scopes ?? "repo",
        token_type: "bearer",
      });
    }),
    userInfo: http.get(GITHUB_USER_URL, () => {
      if (options.userError) {
        return HttpResponse.json(
          { message: "Bad credentials" },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        id: options.userId ?? 12345,
        login: options.username ?? "testuser",
        email: options.email ?? "test@example.com",
      });
    }),
  });
}

/**
 * Create MSW handlers for Notion OAuth API
 */
function createNotionOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  tokenError?: string;
  userId?: string;
  userName?: string;
  email?: string | null;
}) {
  return handlers({
    tokenExchange: http.post(NOTION_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "notion-test-access-token",
        refresh_token: options.refreshToken ?? "notion-test-refresh-token",
        token_type: "bearer",
        owner: {
          user: {
            id: options.userId ?? "notion-user-123",
            name: options.userName ?? "Notion User",
            person: {
              email: options.email ?? "notion@example.com",
            },
          },
        },
      });
    }),
  });
}

/**
 * Create a test request with OAuth callback parameters and cookies
 */
function createCallbackRequest(options: {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  savedState?: string;
  sessionId?: string;
  connectorType?: string;
}) {
  const type = options.connectorType ?? "github";
  const url = new URL(`http://localhost:3000/api/connectors/${type}/callback`);

  if (options.code) url.searchParams.set("code", options.code);
  if (options.state) url.searchParams.set("state", options.state);
  if (options.error) url.searchParams.set("error", options.error);
  if (options.errorDescription) {
    url.searchParams.set("error_description", options.errorDescription);
  }

  const cookies: string[] = [];
  if (options.savedState) {
    cookies.push(`connector_oauth_state=${options.savedState}`);
  }
  if (options.sessionId) {
    cookies.push(`connector_oauth_session=${options.sessionId}`);
  }

  return createTestRequest(url.toString(), {
    headers: cookies.length > 0 ? { Cookie: cookies.join("; ") } : {},
  });
}

describe("GET /api/connectors/:type/callback - OAuth Callback", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    vi.stubEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
    vi.stubEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
    reloadEnv();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  describe("Error Handling", () => {
    it("should redirect with error for unknown connector type", async () => {
      await context.setupUser();

      const request = createTestRequest(
        "http://localhost:3000/api/connectors/invalid/callback?code=test&state=test",
        { headers: { Cookie: "connector_oauth_state=test" } },
      );
      const response = await GET(request, {
        params: Promise.resolve({ type: "invalid" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
      expect(location).toContain("Unknown+connector+type");
    });

    it("should redirect with error for unauthenticated user", async () => {
      mockClerk({ userId: null });

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
      expect(location).toContain("Not+authenticated");
    });

    it("should redirect with error when OAuth provider returns error", async () => {
      await context.setupUser();

      const request = createCallbackRequest({
        error: "access_denied",
        errorDescription: "The user denied access",
        savedState: "test-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
      expect(location).toContain("denied");
    });

    it("should redirect with error when code is missing", async () => {
      await context.setupUser();

      const request = createCallbackRequest({
        state: "test-state",
        savedState: "test-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
      expect(location).toContain("Missing+authorization+code");
    });

    it("should redirect with error when state is missing", async () => {
      await context.setupUser();

      const request = createCallbackRequest({
        code: "test-code",
        savedState: "test-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
      expect(location).toContain("Missing+state");
    });

    it("should redirect with error when state does not match (CSRF protection)", async () => {
      await context.setupUser();

      const request = createCallbackRequest({
        code: "test-code",
        state: "received-state",
        savedState: "different-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
      expect(location).toContain("Invalid+state");
    });

    it("should redirect with error when token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGitHubOAuthMock({
        tokenError: "Invalid code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should redirect with error when user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGitHubOAuthMock({
        accessToken: "valid-token",
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Successful OAuth Flow", () => {
    it("should store connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGitHubOAuthMock({
        accessToken: "github-access-token",
        scopes: "repo",
        userId: 99999,
        username: "octocat",
        email: "octocat@github.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      // Should redirect to success page
      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=github");
      expect(location).toContain("username=octocat");

      // Verify connector was stored via API
      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/github",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("github");
      expect(connector.externalUsername).toBe("octocat");
      expect(connector.externalId).toBe("99999");
    });

    it("should clear OAuth cookies on success", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGitHubOAuthMock({});
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      // Check cookies are cleared
      const cookies = response.headers.getSetCookie();
      const stateCookie = cookies.find((c) =>
        c.startsWith("connector_oauth_state="),
      );
      expect(stateCookie).toContain("Max-Age=0");
    });
  });

  describe("CLI Session Flow", () => {
    it("should mark session as complete when session cookie is present", async () => {
      const user = await context.setupUser();

      // Create a pending session
      const session = await createTestConnectorSession(user.userId, "github", {
        status: "pending",
      });

      const { handlers: mswHandlers } = createGitHubOAuthMock({});
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        sessionId: session.id,
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);

      // Verify session was marked complete via API
      const statusRequest = createTestRequest(
        `http://localhost:3000/api/connectors/github/sessions/${session.id}`,
      );
      const statusResponse = await getSessionStatus(statusRequest);
      const sessionData = await statusResponse.json();

      expect(statusResponse.status).toBe(200);
      expect(sessionData.status).toBe("complete");
    });

    it("should mark session as error when OAuth fails", async () => {
      const user = await context.setupUser();

      // Create a pending session
      const session = await createTestConnectorSession(user.userId, "github", {
        status: "pending",
      });

      const { handlers: mswHandlers } = createGitHubOAuthMock({
        tokenError: "Invalid code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        sessionId: session.id,
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "github" }),
      });

      expect(response.status).toBe(307);

      // Verify session was marked as error via API
      const statusRequest = createTestRequest(
        `http://localhost:3000/api/connectors/github/sessions/${session.id}`,
      );
      const statusResponse = await getSessionStatus(statusRequest);
      const sessionData = await statusResponse.json();

      expect(statusResponse.status).toBe(200);
      expect(sessionData.status).toBe("error");
      expect(sessionData.errorMessage).toBeDefined();
    });
  });

  describe("Notion OAuth Flow", () => {
    it("should store Notion connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createNotionOAuthMock({
        accessToken: "notion-access-token",
        refreshToken: "notion-refresh-token",
        userId: "notion-user-456",
        userName: "My Workspace",
        email: "user@workspace.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "notion",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "notion" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=notion");
      expect(location).toContain("username=My+Workspace");

      // Verify connector was stored via API
      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/notion",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("notion");
      expect(connector.externalUsername).toBe("My Workspace");
      expect(connector.externalId).toBe("notion-user-456");
    });

    it("should redirect with error when Notion token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createNotionOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "notion",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "notion" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should handle Notion response without refresh token", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createNotionOAuthMock({
        accessToken: "notion-access-token",
        refreshToken: null,
        userId: "notion-user-789",
        userName: "No Refresh",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "notion",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "notion" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=notion");
    });
  });
});
