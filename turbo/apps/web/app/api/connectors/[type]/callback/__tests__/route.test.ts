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
  findTestConnectorSecret,
  findTestConnectorTokenExpiresAt,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL =
  "https://www.googleapis.com/gmail/v1/users/me/profile";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_USER_INFO_URL = "https://slack.com/api/users.info";
const DOCUSIGN_TOKEN_URL = "https://account.docusign.com/oauth/token";
const DOCUSIGN_USERINFO_URL = "https://account.docusign.com/oauth/userinfo";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const FIGMA_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const FIGMA_ME_URL = "https://api.figma.com/v1/me";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_ATHLETE_URL = "https://www.strava.com/api/v3/athlete";
const GARMIN_TOKEN_URL =
  "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const GARMIN_USER_ID_URL = "https://apis.garmin.com/wellness-api/rest/user/id";
const DEEL_TOKEN_URL = "https://app.deel.com/oauth/token";
const DEEL_LEGAL_ENTITIES_URL = "https://api.deel.com/rest/v2/legal-entities";

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
  expiresIn?: number;
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
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
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
 * Create MSW handlers for Slack OAuth API
 */
function createSlackOAuthMock(options: {
  accessToken?: string;
  scopes?: string;
  tokenError?: string;
  userId?: string;
  userName?: string;
  realName?: string;
  email?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(SLACK_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          ok: false,
          error: options.tokenError,
        });
      }
      return HttpResponse.json({
        ok: true,
        authed_user: {
          id: options.userId ?? "U012AB3CD",
          access_token: options.accessToken ?? "xoxp-test-user-token",
          scope: options.scopes ?? "channels:read,channels:history,chat:write",
        },
      });
    }),
    userInfo: http.get(SLACK_USER_INFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({
          ok: false,
          error: "user_not_found",
        });
      }
      return HttpResponse.json({
        ok: true,
        user: {
          id: options.userId ?? "U012AB3CD",
          name: options.userName ?? "slackuser",
          real_name: options.realName ?? "Slack User",
          profile: {
            email:
              options.email !== undefined ? options.email : "slack@example.com",
          },
        },
      });
    }),
  });
}

/**
 * Create MSW handlers for Gmail OAuth API
 */
function createGmailOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  email?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(GMAIL_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "gmail-test-access-token",
        refresh_token: options.refreshToken ?? "gmail-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
        scope: "https://mail.google.com/",
      });
    }),
    userInfo: http.get(GMAIL_PROFILE_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        emailAddress:
          options.email !== undefined ? options.email : "user@gmail.com",
        messagesTotal: 1000,
        threadsTotal: 500,
        historyId: "123456",
      });
    }),
  });
}

/**
 * Create MSW handlers for Google OAuth API (Sheets, Docs, Drive).
 * These connectors share the same Google token URL and userinfo endpoint.
 */
function createGoogleOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  scope?: string;
  tokenError?: string;
  userId?: string;
  email?: string | null;
  name?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(GOOGLE_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "google-test-access-token",
        refresh_token: options.refreshToken ?? "google-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
        scope:
          options.scope ??
          "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    userInfo: http.get(GOOGLE_USERINFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        id: options.userId ?? "google-user-123",
        email: options.email !== undefined ? options.email : "user@gmail.com",
        name: options.name !== undefined ? options.name : "Google User",
      });
    }),
  });
}

/**
 * Create MSW handlers for Figma OAuth API
 */
function createFigmaOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  handle?: string | null;
  email?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(FIGMA_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: options.tokenError },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "figma-test-access-token",
        refresh_token: options.refreshToken ?? "figma-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
      });
    }),
    userInfo: http.get(FIGMA_ME_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        id: options.userId ?? "figma-user-123",
        email: options.email !== undefined ? options.email : "user@figma.com",
        handle: options.handle !== undefined ? options.handle : "figmauser",
      });
    }),
  });
}

/**
 * Create MSW handlers for Strava OAuth API
 */
function createStravaOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  athleteId?: number;
  firstName?: string | null;
  lastName?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(STRAVA_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: options.tokenError },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "strava-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "strava-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
        athlete: {
          id: options.athleteId ?? 12345678,
          firstname:
            options.firstName !== undefined ? options.firstName : "Strava",
          lastname:
            options.lastName !== undefined ? options.lastName : "Athlete",
        },
      });
    }),
    userInfo: http.get(STRAVA_ATHLETE_URL, () => {
      if (options.userError) {
        return HttpResponse.json(
          { message: "Authorization Error" },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        id: options.athleteId ?? 12345678,
        firstname:
          options.firstName !== undefined ? options.firstName : "Strava",
        lastname: options.lastName !== undefined ? options.lastName : "Athlete",
      });
    }),
  });
}

/**
 * Create MSW handlers for Garmin Connect OAuth API
 */
function createGarminConnectOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  displayName?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(GARMIN_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: options.tokenError },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "garmin-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "garmin-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
      });
    }),
    userInfo: http.get(GARMIN_USER_ID_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        userId: options.userId ?? "garmin-user-123",
        displayName:
          options.displayName !== undefined
            ? options.displayName
            : "Garmin User",
      });
    }),
  });
}

/**
 * Create MSW handlers for Linear OAuth API
 */
function createLinearOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  userName?: string | null;
  email?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(LINEAR_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "linear-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "linear-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
        scope: "read,write",
      });
    }),
    userInfo: http.post(LINEAR_GRAPHQL_URL, () => {
      if (options.userError) {
        return HttpResponse.json(
          { errors: [{ message: "Unauthorized" }] },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        data: {
          viewer: {
            id: options.userId ?? "linear-user-123",
            name:
              options.userName !== undefined ? options.userName : "Linear User",
            email:
              options.email !== undefined ? options.email : "user@linear.app",
          },
        },
      });
    }),
  });
}

/**
 * Create MSW handlers for Deel OAuth API
 */
function createDeelOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  entityId?: string;
  legalName?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(DEEL_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "deel-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "deel-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
      });
    }),
    userInfo: http.get(DEEL_LEGAL_ENTITIES_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        data: [
          {
            id: options.entityId ?? "deel-entity-123",
            legal_name:
              options.legalName !== undefined
                ? options.legalName
                : "Deel Test Org",
          },
        ],
      });
    }),
  });
}

/**
 * Create MSW handlers for DocuSign OAuth API
 */
function createDocuSignOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  userName?: string | null;
  email?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(DOCUSIGN_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "docusign-test-access-token",
        refresh_token: options.refreshToken ?? "docusign-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
        scope: "signature",
      });
    }),
    userInfo: http.get(DOCUSIGN_USERINFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        sub: options.userId ?? "docusign-user-123",
        name:
          options.userName !== undefined ? options.userName : "DocuSign User",
        email:
          options.email !== undefined ? options.email : "user@docusign.com",
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
    vi.stubEnv("SLACK_CLIENT_ID", "test-slack-client-id");
    vi.stubEnv("SLACK_CLIENT_SECRET", "test-slack-client-secret");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "google-test-client-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-test-client-secret");
    vi.stubEnv("LINEAR_OAUTH_CLIENT_ID", "linear-test-client-id");
    vi.stubEnv("LINEAR_OAUTH_CLIENT_SECRET", "linear-test-client-secret");
    vi.stubEnv("DOCUSIGN_OAUTH_CLIENT_ID", "docusign-test-client-id");
    vi.stubEnv("DOCUSIGN_OAUTH_CLIENT_SECRET", "docusign-test-client-secret");
    vi.stubEnv("FIGMA_OAUTH_CLIENT_ID", "figma-test-client-id");
    vi.stubEnv("FIGMA_OAUTH_CLIENT_SECRET", "figma-test-client-secret");
    vi.stubEnv("STRAVA_OAUTH_CLIENT_ID", "strava-test-client-id");
    vi.stubEnv("STRAVA_OAUTH_CLIENT_SECRET", "strava-test-client-secret");
    vi.stubEnv("GARMIN_CONNECT_OAUTH_CLIENT_ID", "garmin-test-client-id");
    vi.stubEnv(
      "GARMIN_CONNECT_OAUTH_CLIENT_SECRET",
      "garmin-test-client-secret",
    );
    vi.stubEnv("DEEL_OAUTH_CLIENT_ID", "deel-test-client-id");
    vi.stubEnv("DEEL_OAUTH_CLIENT_SECRET", "deel-test-client-secret");
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

  describe("Slack OAuth Flow", () => {
    it("should store Slack connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createSlackOAuthMock({
        accessToken: "xoxp-slack-user-token",
        scopes: "channels:read,channels:history,chat:write",
        userId: "U012AB3CD",
        realName: "Slack User",
        email: "slack@example.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "slack",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "slack" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=slack");
      expect(location).toContain("username=Slack+User");

      // Verify connector was stored via API
      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/slack",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("slack");
      expect(connector.externalUsername).toBe("Slack User");
      expect(connector.externalId).toBe("U012AB3CD");
    });

    it("should store authed_user.access_token (xoxp-), not bot token", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createSlackOAuthMock({
        accessToken: "xoxp-user-token-12345",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "slack",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "slack" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");

      // Verify the stored token is the user token (xoxp-), not a bot token (xoxb-)
      const decryptedToken = await findTestConnectorSecret(
        user.scopeId,
        "SLACK_ACCESS_TOKEN",
      );
      expect(decryptedToken).toBe("xoxp-user-token-12345");
    });

    it("should redirect with error when Slack token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createSlackOAuthMock({
        tokenError: "invalid_code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "slack",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "slack" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should redirect with error when Slack user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createSlackOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "slack",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "slack" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
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

    it("should store refresh token as a secret when Notion returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createNotionOAuthMock({
        accessToken: "notion-access-token",
        refreshToken: "notion-refresh-token-stored",
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

      // Verify refresh token was stored as a secret
      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "NOTION_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("notion-refresh-token-stored");
    });

    it("should set tokenExpiresAt when provider returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 3600;
      const { handlers: mswHandlers } = createNotionOAuthMock({
        accessToken: "notion-access-token",
        refreshToken: "notion-refresh-token",
        expiresIn,
        userId: "notion-user-exp",
        userName: "Expiring Workspace",
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

      // Verify tokenExpiresAt is set to now + expiresIn seconds
      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "notion",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should leave tokenExpiresAt null when provider does not return expires_in", async () => {
      const user = await context.setupUser();

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

      // Verify tokenExpiresAt is null (non-expiring token)
      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "notion",
      );
      expect(tokenExpiresAt).toBeNull();
    });
  });

  describe("Gmail OAuth Flow", () => {
    it("should store Gmail connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGmailOAuthMock({
        accessToken: "gmail-access-token",
        refreshToken: "gmail-refresh-token",
        email: "testuser@gmail.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "gmail",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "gmail" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=gmail");
      expect(location).toContain("username=testuser%40gmail.com");

      // Verify connector was stored via API
      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/gmail",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("gmail");
      expect(connector.externalUsername).toBe("testuser@gmail.com");
      expect(connector.externalId).toBe("testuser@gmail.com");
      expect(connector.externalEmail).toBe("testuser@gmail.com");
    });

    it("should redirect with error when Gmail token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGmailOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "gmail",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "gmail" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Gmail returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createGmailOAuthMock({
        accessToken: "gmail-access-token",
        refreshToken: "gmail-refresh-token-stored",
        email: "testuser@gmail.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "gmail",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "gmail" }),
      });

      expect(response.status).toBe(307);

      // Verify refresh token was stored as a secret
      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "GMAIL_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("gmail-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Gmail returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 3600;
      const { handlers: mswHandlers } = createGmailOAuthMock({
        accessToken: "gmail-access-token",
        refreshToken: "gmail-refresh-token",
        expiresIn,
        email: "exp@gmail.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "gmail",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "gmail" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "gmail",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Gmail user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGmailOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "gmail",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "gmail" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Google Sheets OAuth Flow", () => {
    it("should store Google Sheets connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "sheets-access-token",
        refreshToken: "sheets-refresh-token",
        scope:
          "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email",
        email: "testuser@gmail.com",
        name: "Sheets User",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-sheets",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-sheets" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=google-sheets");
      expect(location).toContain("username=Sheets+User");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/google-sheets",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("google-sheets");
      expect(connector.externalUsername).toBe("Sheets User");
      expect(connector.externalId).toBe("google-user-123");
      expect(connector.externalEmail).toBe("testuser@gmail.com");
    });

    it("should redirect with error when Google Sheets token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-sheets",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-sheets" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Google Sheets returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "sheets-access-token",
        refreshToken: "sheets-refresh-token-stored",
        email: "testuser@gmail.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-sheets",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-sheets" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "GOOGLE_SHEETS_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("sheets-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Google Sheets returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 3600;
      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "sheets-access-token",
        refreshToken: "sheets-refresh-token",
        expiresIn,
        email: "exp@gmail.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-sheets",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-sheets" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "google-sheets",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Google Sheets user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-sheets",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-sheets" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Google Docs OAuth Flow", () => {
    it("should store Google Docs connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "docs-access-token",
        refreshToken: "docs-refresh-token",
        scope:
          "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/userinfo.email",
        email: "testuser@gmail.com",
        name: "Docs User",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-docs",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-docs" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=google-docs");
      expect(location).toContain("username=Docs+User");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/google-docs",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("google-docs");
      expect(connector.externalUsername).toBe("Docs User");
      expect(connector.externalId).toBe("google-user-123");
      expect(connector.externalEmail).toBe("testuser@gmail.com");
    });

    it("should redirect with error when Google Docs token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-docs",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-docs" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Google Docs returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "docs-access-token",
        refreshToken: "docs-refresh-token-stored",
        email: "testuser@gmail.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-docs",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-docs" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "GOOGLE_DOCS_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("docs-refresh-token-stored");
    });

    it("should redirect with error when Google Docs user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-docs",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-docs" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Google Drive OAuth Flow", () => {
    it("should store Google Drive connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "drive-access-token",
        refreshToken: "drive-refresh-token",
        scope:
          "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email",
        email: "testuser@gmail.com",
        name: "Drive User",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-drive",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-drive" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=google-drive");
      expect(location).toContain("username=Drive+User");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/google-drive",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("google-drive");
      expect(connector.externalUsername).toBe("Drive User");
      expect(connector.externalId).toBe("google-user-123");
      expect(connector.externalEmail).toBe("testuser@gmail.com");
    });

    it("should redirect with error when Google Drive token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-drive",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-drive" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Google Drive returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "drive-access-token",
        refreshToken: "drive-refresh-token-stored",
        email: "testuser@gmail.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-drive",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-drive" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "GOOGLE_DRIVE_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("drive-refresh-token-stored");
    });

    it("should redirect with error when Google Drive user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-drive",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-drive" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Linear OAuth Flow", () => {
    it("should store Linear connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createLinearOAuthMock({
        accessToken: "linear-access-token",
        refreshToken: "linear-refresh-token",
        userId: "linear-user-456",
        userName: "Linear User",
        email: "user@linear.app",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "linear",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "linear" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=linear");
      expect(location).toContain("username=Linear+User");

      // Verify connector was stored via API
      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/linear",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("linear");
      expect(connector.externalUsername).toBe("Linear User");
      expect(connector.externalId).toBe("linear-user-456");
    });

    it("should redirect with error when Linear token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createLinearOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "linear",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "linear" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Linear returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createLinearOAuthMock({
        accessToken: "linear-access-token",
        refreshToken: "linear-refresh-token-stored",
        userId: "linear-user-456",
        userName: "Linear User",
        email: "user@linear.app",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "linear",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "linear" }),
      });

      expect(response.status).toBe(307);

      // Verify refresh token was stored as a secret
      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "LINEAR_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("linear-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Linear returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 86400;
      const { handlers: mswHandlers } = createLinearOAuthMock({
        accessToken: "linear-access-token",
        refreshToken: "linear-refresh-token",
        expiresIn,
        email: "exp@linear.app",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "linear",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "linear" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "linear",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Linear user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createLinearOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "linear",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "linear" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("DocuSign OAuth Flow", () => {
    it("should store DocuSign connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createDocuSignOAuthMock({
        accessToken: "docusign-access-token",
        refreshToken: "docusign-refresh-token",
        userId: "docusign-user-456",
        userName: "DocuSign User",
        email: "testuser@docusign.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "docusign",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "docusign" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=docusign");
      expect(location).toContain("username=DocuSign+User");

      // Verify connector was stored via API
      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/docusign",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("docusign");
      expect(connector.externalUsername).toBe("DocuSign User");
      expect(connector.externalId).toBe("docusign-user-456");
      expect(connector.externalEmail).toBe("testuser@docusign.com");
    });

    it("should redirect with error when DocuSign token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createDocuSignOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "docusign",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "docusign" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when DocuSign returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createDocuSignOAuthMock({
        accessToken: "docusign-access-token",
        refreshToken: "docusign-refresh-token-stored",
        email: "testuser@docusign.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "docusign",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "docusign" }),
      });

      expect(response.status).toBe(307);

      // Verify refresh token was stored as a secret
      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "DOCUSIGN_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("docusign-refresh-token-stored");
    });

    it("should set tokenExpiresAt when DocuSign returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 28800; // DocuSign tokens typically expire in 8 hours
      const { handlers: mswHandlers } = createDocuSignOAuthMock({
        accessToken: "docusign-access-token",
        refreshToken: "docusign-refresh-token",
        expiresIn,
        email: "exp@docusign.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "docusign",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "docusign" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "docusign",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when DocuSign user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createDocuSignOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "docusign",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "docusign" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Figma OAuth Flow", () => {
    it("should store Figma connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createFigmaOAuthMock({
        accessToken: "figma-access-token",
        refreshToken: "figma-refresh-token",
        userId: "figma-user-123",
        handle: "figmauser",
        email: "testuser@figma.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "figma",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "figma" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=figma");
      expect(location).toContain("username=figmauser");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/figma",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("figma");
      expect(connector.externalUsername).toBe("figmauser");
      expect(connector.externalId).toBe("figma-user-123");
      expect(connector.externalEmail).toBe("testuser@figma.com");
    });

    it("should redirect with error when Figma token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createFigmaOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "figma",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "figma" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Figma returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createFigmaOAuthMock({
        accessToken: "figma-access-token",
        refreshToken: "figma-refresh-token-stored",
        handle: "figmauser",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "figma",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "figma" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "FIGMA_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("figma-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Figma returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 7776000;
      const { handlers: mswHandlers } = createFigmaOAuthMock({
        accessToken: "figma-access-token",
        refreshToken: "figma-refresh-token",
        expiresIn,
        handle: "expuser",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "figma",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "figma" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "figma",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Figma user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createFigmaOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "figma",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "figma" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Strava OAuth Flow", () => {
    it("should store Strava connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createStravaOAuthMock({
        accessToken: "strava-access-token",
        refreshToken: "strava-refresh-token",
        athleteId: 87654321,
        firstName: "Strava",
        lastName: "Runner",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "strava",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "strava" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=strava");
      expect(location).toContain("username=Strava+Runner");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/strava",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("strava");
      expect(connector.externalUsername).toBe("Strava Runner");
      expect(connector.externalId).toBe("87654321");
    });

    it("should redirect with error when Strava token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createStravaOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "strava",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "strava" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Strava returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createStravaOAuthMock({
        accessToken: "strava-access-token",
        refreshToken: "strava-refresh-token-stored",
        athleteId: 87654321,
        firstName: "Strava",
        lastName: "Runner",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "strava",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "strava" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "STRAVA_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("strava-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Strava returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 21600;
      const { handlers: mswHandlers } = createStravaOAuthMock({
        accessToken: "strava-access-token",
        refreshToken: "strava-refresh-token",
        expiresIn,
        athleteId: 87654321,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "strava",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "strava" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "strava",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Strava athlete info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createStravaOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "strava",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "strava" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Garmin Connect OAuth Flow", () => {
    it("should store Garmin Connect connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGarminConnectOAuthMock({
        accessToken: "garmin-access-token",
        refreshToken: "garmin-refresh-token",
        userId: "garmin-user-456",
        displayName: "Garmin User",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "garmin-connect",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "garmin-connect" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=garmin-connect");
      expect(location).toContain("username=Garmin+User");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/garmin-connect",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("garmin-connect");
      expect(connector.externalUsername).toBe("Garmin User");
      expect(connector.externalId).toBe("garmin-user-456");
    });

    it("should redirect with error when Garmin Connect token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGarminConnectOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "garmin-connect",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "garmin-connect" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Garmin Connect returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createGarminConnectOAuthMock({
        accessToken: "garmin-access-token",
        refreshToken: "garmin-refresh-token-stored",
        userId: "garmin-user-456",
        displayName: "Garmin User",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "garmin-connect",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "garmin-connect" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "GARMIN_CONNECT_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("garmin-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Garmin Connect returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 7776000;
      const { handlers: mswHandlers } = createGarminConnectOAuthMock({
        accessToken: "garmin-access-token",
        refreshToken: "garmin-refresh-token",
        expiresIn,
        userId: "garmin-user-exp",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "garmin-connect",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "garmin-connect" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "garmin-connect",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Garmin Connect user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGarminConnectOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "garmin-connect",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "garmin-connect" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Deel OAuth Flow", () => {
    it("should store Deel connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createDeelOAuthMock({
        accessToken: "deel-access-token",
        refreshToken: "deel-refresh-token",
        entityId: "deel-entity-456",
        legalName: "Deel Test Org",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "deel",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "deel" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=deel");
      expect(location).toContain("username=Deel+Test+Org");

      // Verify connector was stored via API
      const getRequest = createTestRequest(
        "http://localhost:3000/api/connectors/deel",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("deel");
      expect(connector.externalUsername).toBe("Deel Test Org");
      expect(connector.externalId).toBe("deel-entity-456");
    });

    it("should redirect with error when Deel token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createDeelOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "deel",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "deel" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Deel returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createDeelOAuthMock({
        accessToken: "deel-access-token",
        refreshToken: "deel-refresh-token-stored",
        entityId: "deel-entity-456",
        legalName: "Deel Test Org",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "deel",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "deel" }),
      });

      expect(response.status).toBe(307);

      // Verify refresh token was stored as a secret
      const refreshToken = await findTestConnectorSecret(
        user.scopeId,
        "DEEL_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("deel-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Deel returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 2592000;
      const { handlers: mswHandlers } = createDeelOAuthMock({
        accessToken: "deel-access-token",
        refreshToken: "deel-refresh-token",
        expiresIn,
        legalName: "Expiring Org",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "deel",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "deel" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.scopeId,
        "deel",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Deel user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createDeelOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "deel",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "deel" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });
});
