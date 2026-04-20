import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { GET } from "../route";
import { GET as getConnector } from "../../../../zero/connectors/[type]/route";
import { GET as getSessionStatus } from "../../../../zero/connectors/[type]/sessions/[sessionId]/route";
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
const DOCUSIGN_TOKEN_URL = "https://account-d.docusign.com/oauth/token";
const DOCUSIGN_USERINFO_URL = "https://account-d.docusign.com/oauth/userinfo";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const FIGMA_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const FIGMA_ME_URL = "https://api.figma.com/v1/me";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_ATHLETE_URL = "https://www.strava.com/api/v3/athlete";
const GARMIN_TOKEN_URL =
  "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const GARMIN_USER_ID_URL = "https://apis.garmin.com/wellness-api/rest/user/id";
const DEEL_TOKEN_URL = "https://app.deel.com/oauth2/tokens";
const DEEL_PEOPLE_ME_URL = "https://api.letsdeel.com/rest/v2/people/me";
const MERCURY_TOKEN_URL = "https://oauth2.mercury.com/oauth2/token";
const MERCURY_ACCOUNTS_URL = "https://api.mercury.com/api/v1/accounts";
const NEON_TOKEN_URL = "https://oauth2.neon.tech/oauth2/token";
const NEON_USER_INFO_URL = "https://console.neon.tech/api/v2/users/me";
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_USER_INFO_URL = "https://oauth.reddit.com/api/v1/me";
const X_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const VERCEL_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";
const VERCEL_USERINFO_URL = "https://api.vercel.com/v2/user";
const SENTRY_TOKEN_URL = "https://sentry.io/oauth/token/";
const INTERVALS_ICU_TOKEN_URL = "https://intervals.icu/api/oauth/token";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_USERINFO_URL = "https://identity.xero.com/connect/userinfo";

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
    userInfo: http.get(DEEL_PEOPLE_ME_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        data: {
          id: options.entityId ?? "deel-entity-123",
          full_name:
            options.legalName !== undefined
              ? options.legalName
              : "Deel Test Org",
          emails: [{ type: "work", value: "test@deel.com" }],
        },
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
 * Create MSW handlers for Mercury OAuth API
 */
function createMercuryOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  accountId?: string;
  accountName?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(MERCURY_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "mercury-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "mercury-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
        scope: "offline_access",
      });
    }),
    userInfo: http.get(MERCURY_ACCOUNTS_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        accounts: [
          {
            id: options.accountId ?? "mercury-account-123",
            name:
              options.accountName !== undefined
                ? options.accountName
                : "My Business Account",
            legalBusinessName: "My Business LLC",
          },
        ],
      });
    }),
  });
}

/**
 * Create MSW handlers for Neon OAuth API
 */
function createNeonOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  name?: string | null;
  email?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(NEON_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "neon-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "neon-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "Bearer",
        scope: "openid offline_access urn:neoncloud:projects:read",
      });
    }),
    userInfo: http.get(NEON_USER_INFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        id: options.userId ?? "neon-user-123",
        name: options.name !== undefined ? options.name : "Neon User",
        email: options.email !== undefined ? options.email : "user@neon.tech",
      });
    }),
  });
}

/**
 * Create MSW handlers for Reddit OAuth API
 */
function createRedditOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  username?: string;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(REDDIT_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "reddit-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "reddit-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "bearer",
        scope: "identity read",
      });
    }),
    userInfo: http.get(REDDIT_USER_INFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        id: options.userId ?? "abc123",
        name: options.username ?? "testreddituser",
      });
    }),
  });
}

/**
 * Create MSW handlers for X (Twitter) OAuth API
 */
function createXOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  username?: string;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(X_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "x-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "x-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "bearer",
        scope: "tweet.read users.read follows.read offline.access",
      });
    }),
    userInfo: http.get("https://api.twitter.com/2/users/me", ({ request }) => {
      const url = new URL(request.url);
      if (!url.searchParams.get("user.fields")) {
        return HttpResponse.json(
          { errors: [{ message: "Missing fields" }] },
          { status: 400 },
        );
      }
      if (options.userError) {
        return HttpResponse.json(
          { errors: [{ message: "Unauthorized" }] },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        data: {
          id: options.userId ?? "x-user-123",
          username: options.username ?? "testxuser",
          name: "Test X User",
        },
      });
    }),
  });
}

/**
 * Create MSW handlers for Vercel OAuth API
 */
function createVercelOAuthMock(options: {
  accessToken?: string;
  tokenError?: string;
  userId?: string;
  username?: string;
  email?: string | null;
  userError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(VERCEL_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "vercel-test-access-token",
        token_type: "Bearer",
        team_id: null,
        installation_id: "icfg_test123",
      });
    }),
    userInfo: http.get(VERCEL_USERINFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        user: {
          id: options.userId ?? "abc123vercel",
          username: options.username ?? "verceluser",
          email:
            options.email !== undefined ? options.email : "user@vercel.com",
        },
      });
    }),
  });
}

/**
 * Create MSW handlers for Sentry OAuth API
 * Sentry embeds user info directly in the token response.
 */
function createSentryOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  userName?: string | null;
  email?: string | null;
}) {
  return handlers({
    tokenExchange: http.post(SENTRY_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "sentry-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "sentry-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "bearer",
        scope:
          "org:read project:read team:read member:read event:read event:write",
        user: {
          id: options.userId ?? "sentry-user-123",
          name:
            options.userName !== undefined ? options.userName : "Sentry User",
          email: options.email !== undefined ? options.email : "user@sentry.io",
        },
      });
    }),
  });
}

/**
 * Create MSW handlers for Intervals.icu OAuth API
 */
function createIntervalsIcuOAuthMock(options: {
  accessToken?: string;
  athleteId?: string;
  name?: string | null;
  tokenError?: string;
}) {
  return handlers({
    tokenExchange: http.post(INTERVALS_ICU_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "intervals-icu-test-access-token",
        athlete: {
          id: options.athleteId ?? "i12345",
          name: options.name !== undefined ? options.name : "Test Athlete",
        },
      });
    }),
  });
}

/**
 * Create MSW handlers for Xero OAuth API.
 * Xero uses a separate userinfo endpoint (OpenID Connect).
 */
function createXeroOAuthMock(options: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  tokenError?: string;
  userId?: string;
  userName?: string | null;
  email?: string | null;
  userInfoError?: boolean;
}) {
  return handlers({
    tokenExchange: http.post(XERO_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "xero-test-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "xero-test-refresh-token",
        ...(options.expiresIn != null ? { expires_in: options.expiresIn } : {}),
        token_type: "bearer",
        scope:
          "openid profile email offline_access accounting.transactions accounting.contacts accounting.settings",
      });
    }),
    userInfo: http.get(XERO_USERINFO_URL, () => {
      if (options.userInfoError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        sub: options.userId ?? "xero-user-123",
        name: options.userName !== undefined ? options.userName : "Xero User",
        email: options.email !== undefined ? options.email : "user@xero.com",
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
    vi.stubEnv("MERCURY_OAUTH_CLIENT_ID", "mercury-test-client-id");
    vi.stubEnv("MERCURY_OAUTH_CLIENT_SECRET", "mercury-test-client-secret");
    vi.stubEnv("NEON_OAUTH_CLIENT_ID", "neon-test-client-id");
    vi.stubEnv("NEON_OAUTH_CLIENT_SECRET", "neon-test-client-secret");
    vi.stubEnv("REDDIT_OAUTH_CLIENT_ID", "reddit-test-client-id");
    vi.stubEnv("REDDIT_OAUTH_CLIENT_SECRET", "reddit-test-client-secret");
    vi.stubEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
    vi.stubEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
    vi.stubEnv("VERCEL_OAUTH_CLIENT_ID", "vercel-test-client-id");
    vi.stubEnv("VERCEL_OAUTH_CLIENT_SECRET", "vercel-test-client-secret");
    vi.stubEnv("VERCEL_INTEGRATION_SLUG", "vm0-test");
    vi.stubEnv("SENTRY_OAUTH_CLIENT_ID", "sentry-test-client-id");
    vi.stubEnv("SENTRY_OAUTH_CLIENT_SECRET", "sentry-test-client-secret");
    vi.stubEnv("INTERVALS_ICU_OAUTH_CLIENT_ID", "intervals-icu-test-client-id");
    vi.stubEnv(
      "INTERVALS_ICU_OAUTH_CLIENT_SECRET",
      "intervals-icu-test-client-secret",
    );
    vi.stubEnv("XERO_OAUTH_CLIENT_ID", "xero-test-client-id");
    vi.stubEnv("XERO_OAUTH_CLIENT_SECRET", "xero-test-client-secret");
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
        "http://localhost:3000/api/zero/connectors/github",
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
      const stateCookie = cookies.find((c) => {
        return c.startsWith("connector_oauth_state=");
      });
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
        `http://localhost:3000/api/zero/connectors/github/sessions/${session.id}`,
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
        `http://localhost:3000/api/zero/connectors/github/sessions/${session.id}`,
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
        "http://localhost:3000/api/zero/connectors/slack",
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
        user.orgId,
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

    it("should keep tokenExpiresAt null for non-refreshable connector missing expires_in", async () => {
      // Slack user tokens are long-lived and the handler defines no
      // refreshToken method, so the #9836 fallback must NOT apply — we keep
      // null to signal "don't try to refresh" to the firewall auth path.
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createSlackOAuthMock({
        accessToken: "xoxp-no-expiry-token",
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
      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "slack",
      );
      expect(tokenExpiresAt).toBeNull();
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
        "http://localhost:3000/api/zero/connectors/notion",
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
        user.orgId,
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
        user.orgId,
        "notion",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should fallback to 1h tokenExpiresAt when provider does not return expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

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

      // Verify tokenExpiresAt falls back to now + 3600s so the firewall auth
      // endpoint can still judge freshness and trigger refresh on expiry.
      // See #9836.
      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "notion",
      );
      expect(tokenExpiresAt?.getTime()).toBe(frozenNow + 3600 * 1000);
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
        "http://localhost:3000/api/zero/connectors/gmail",
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
        user.orgId,
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
        user.orgId,
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
        "http://localhost:3000/api/zero/connectors/google-sheets",
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
        user.orgId,
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
        user.orgId,
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
        "http://localhost:3000/api/zero/connectors/google-docs",
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
        user.orgId,
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
        "http://localhost:3000/api/zero/connectors/google-drive",
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
        user.orgId,
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

  describe("Google Calendar OAuth Flow", () => {
    it("should store Google Calendar connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "calendar-access-token",
        refreshToken: "calendar-refresh-token",
        scope:
          "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email",
        email: "testuser@gmail.com",
        name: "Calendar User",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-calendar",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-calendar" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=google-calendar");
      expect(location).toContain("username=Calendar+User");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/google-calendar",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("google-calendar");
      expect(connector.externalUsername).toBe("Calendar User");
      expect(connector.externalId).toBe("google-user-123");
      expect(connector.externalEmail).toBe("testuser@gmail.com");
    });

    it("should redirect with error when Google Calendar token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-calendar",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-calendar" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Google Calendar returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        accessToken: "calendar-access-token",
        refreshToken: "calendar-refresh-token-stored",
        email: "testuser@gmail.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-calendar",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-calendar" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.orgId,
        "GOOGLE_CALENDAR_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("calendar-refresh-token-stored");
    });

    it("should redirect with error when Google Calendar user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createGoogleOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "google-calendar",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "google-calendar" }),
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
        "http://localhost:3000/api/zero/connectors/linear",
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
        user.orgId,
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
        user.orgId,
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
        "http://localhost:3000/api/zero/connectors/docusign",
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
        user.orgId,
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
        user.orgId,
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
        "http://localhost:3000/api/zero/connectors/figma",
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
        user.orgId,
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
        user.orgId,
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
        "http://localhost:3000/api/zero/connectors/strava",
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
        user.orgId,
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
        user.orgId,
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
        "http://localhost:3000/api/zero/connectors/garmin-connect",
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
        user.orgId,
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
        user.orgId,
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
        "http://localhost:3000/api/zero/connectors/deel",
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
        user.orgId,
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
        user.orgId,
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

  describe("Mercury OAuth Flow", () => {
    it("should store Mercury connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createMercuryOAuthMock({
        accessToken: "mercury-access-token",
        refreshToken: "mercury-refresh-token",
        accountId: "mercury-account-456",
        accountName: "My Business Account",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "mercury",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "mercury" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=mercury");
      expect(location).toContain("username=My+Business+Account");

      // Verify connector was stored via API
      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/mercury",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("mercury");
      expect(connector.externalUsername).toBe("My Business Account");
      expect(connector.externalId).toBe("mercury-account-456");
    });

    it("should redirect with error when Mercury token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createMercuryOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "mercury",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "mercury" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Mercury returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createMercuryOAuthMock({
        accessToken: "mercury-access-token",
        refreshToken: "mercury-refresh-token-stored",
        accountId: "mercury-account-456",
        accountName: "My Business Account",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "mercury",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "mercury" }),
      });

      expect(response.status).toBe(307);

      // Verify refresh token was stored as a secret
      const refreshToken = await findTestConnectorSecret(
        user.orgId,
        "MERCURY_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("mercury-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Mercury returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 3600;
      const { handlers: mswHandlers } = createMercuryOAuthMock({
        accessToken: "mercury-access-token",
        refreshToken: "mercury-refresh-token",
        expiresIn,
        accountId: "mercury-account-exp",
        accountName: "Expiring Account",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "mercury",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "mercury" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "mercury",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Mercury user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createMercuryOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "mercury",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "mercury" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Neon OAuth Flow", () => {
    it("should store Neon connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createNeonOAuthMock({
        accessToken: "neon-access-token",
        refreshToken: "neon-refresh-token",
        userId: "neon-user-456",
        name: "Neon Dev",
        email: "dev@neon.tech",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "neon",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "neon" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=neon");
      expect(location).toContain("username=Neon+Dev");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/neon",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("neon");
      expect(connector.externalUsername).toBe("Neon Dev");
      expect(connector.externalId).toBe("neon-user-456");
      expect(connector.externalEmail).toBe("dev@neon.tech");
    });

    it("should redirect with error when Neon token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createNeonOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "neon",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "neon" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Neon returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createNeonOAuthMock({
        accessToken: "neon-access-token",
        refreshToken: "neon-refresh-token-stored",
        userId: "neon-user-456",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "neon",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "neon" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.orgId,
        "NEON_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("neon-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Neon returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 3600;
      const { handlers: mswHandlers } = createNeonOAuthMock({
        accessToken: "neon-access-token",
        refreshToken: "neon-refresh-token",
        expiresIn,
        userId: "neon-user-456",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "neon",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "neon" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "neon",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Neon user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createNeonOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "neon",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "neon" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Reddit OAuth Flow", () => {
    it("should store Reddit connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createRedditOAuthMock({
        accessToken: "reddit-access-token",
        refreshToken: "reddit-refresh-token",
        userId: "xyz789",
        username: "reddituser",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "reddit",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "reddit" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=reddit");
      expect(location).toContain("username=reddituser");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/reddit",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("reddit");
      expect(connector.externalUsername).toBe("reddituser");
      expect(connector.externalId).toBe("xyz789");
      expect(connector.externalEmail).toBeNull();
    });

    it("should redirect with error when Reddit token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createRedditOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "reddit",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "reddit" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Reddit returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createRedditOAuthMock({
        accessToken: "reddit-access-token",
        refreshToken: "reddit-refresh-token-stored",
        userId: "xyz789",
        username: "reddituser",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "reddit",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "reddit" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.orgId,
        "REDDIT_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("reddit-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Reddit returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 3600;
      const { handlers: mswHandlers } = createRedditOAuthMock({
        accessToken: "reddit-access-token",
        refreshToken: "reddit-refresh-token",
        expiresIn,
        userId: "xyz789",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "reddit",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "reddit" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "reddit",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Reddit user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createRedditOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "reddit",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "reddit" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("X OAuth Flow", () => {
    it("should store X connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createXOAuthMock({
        accessToken: "x-access-token",
        refreshToken: "x-refresh-token",
        userId: "x-user-456",
        username: "xuser",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "x",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "x" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=x");
      expect(location).toContain("username=xuser");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/x",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("x");
      expect(connector.externalUsername).toBe("xuser");
      expect(connector.externalId).toBe("x-user-456");
      expect(connector.externalEmail).toBeNull();
    });

    it("should redirect with error when X token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createXOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "x",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "x" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when X returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createXOAuthMock({
        accessToken: "x-access-token",
        refreshToken: "x-refresh-token-stored",
        userId: "x-user-456",
        username: "xuser",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "x",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "x" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.orgId,
        "X_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("x-refresh-token-stored");
    });

    it("should set tokenExpiresAt when X returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 7200;
      const { handlers: mswHandlers } = createXOAuthMock({
        accessToken: "x-access-token",
        refreshToken: "x-refresh-token",
        expiresIn,
        userId: "x-user-456",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "x",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "x" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "x",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when X user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createXOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "x",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "x" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Vercel OAuth Flow", () => {
    it("should store Vercel connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createVercelOAuthMock({
        accessToken: "vercel-access-token",
        userId: "vercel123",
        username: "verceluser",
        email: "user@vercel.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "vercel",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "vercel" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=vercel");
      expect(location).toContain("username=verceluser");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/vercel",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("vercel");
      expect(connector.externalUsername).toBe("verceluser");
      expect(connector.externalId).toBe("vercel123");
      expect(connector.externalEmail).toBe("user@vercel.com");
    });

    it("should redirect with error when Vercel token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createVercelOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "vercel",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "vercel" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should redirect with error when Vercel user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createVercelOAuthMock({
        userError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "vercel",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "vercel" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Sentry OAuth Flow", () => {
    it("should store Sentry connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createSentryOAuthMock({
        accessToken: "sentry-access-token",
        refreshToken: "sentry-refresh-token",
        userId: "sentry-user-456",
        userName: "Sentry User",
        email: "user@sentry.io",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "sentry",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "sentry" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=sentry");
      expect(location).toContain("username=Sentry+User");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/sentry",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("sentry");
      expect(connector.externalUsername).toBe("Sentry User");
      expect(connector.externalId).toBe("sentry-user-456");
      expect(connector.externalEmail).toBe("user@sentry.io");
    });

    it("should redirect with error when Sentry token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createSentryOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "sentry",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "sentry" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Sentry returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createSentryOAuthMock({
        accessToken: "sentry-access-token",
        refreshToken: "sentry-refresh-token-stored",
        userId: "sentry-user-456",
        userName: "Sentry User",
        email: "user@sentry.io",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "sentry",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "sentry" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.orgId,
        "SENTRY_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("sentry-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Sentry returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 2592000; // 30 days
      const { handlers: mswHandlers } = createSentryOAuthMock({
        accessToken: "sentry-access-token",
        refreshToken: "sentry-refresh-token",
        expiresIn,
        userId: "sentry-user-exp",
        userName: "Expiring Sentry",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "sentry",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "sentry" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "sentry",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Sentry token response has no user info", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = handlers({
        tokenExchange: http.post(SENTRY_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "sentry-access-token",
            refresh_token: "sentry-refresh-token",
            token_type: "bearer",
            scope: "org:read",
            // No user field
          });
        }),
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "sentry",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "sentry" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Intervals.icu OAuth Flow", () => {
    it("should store Intervals.icu connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createIntervalsIcuOAuthMock({
        accessToken: "intervals-icu-access-token",
        athleteId: "i12345",
        name: "Test Athlete",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "intervals-icu",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "intervals-icu" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=intervals-icu");
      expect(location).toContain("username=Test+Athlete");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/intervals-icu",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("intervals-icu");
      expect(connector.externalUsername).toBe("Test Athlete");
      expect(connector.externalId).toBe("i12345");
      expect(connector.externalEmail).toBeNull();
    });

    it("should redirect with error when Intervals.icu token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createIntervalsIcuOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "intervals-icu",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "intervals-icu" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should redirect with error when Intervals.icu returns no athlete_id", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = handlers({
        tokenExchange: http.post(INTERVALS_ICU_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "intervals-icu-access-token",
            // No athlete object
          });
        }),
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "intervals-icu",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "intervals-icu" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });

  describe("Xero OAuth Flow", () => {
    it("should store Xero connector and redirect to success page", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createXeroOAuthMock({
        accessToken: "xero-access-token",
        refreshToken: "xero-refresh-token",
        userId: "xero-user-456",
        userName: "Xero User",
        email: "user@xero.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "xero",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "xero" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/success");
      expect(location).toContain("type=xero");
      expect(location).toContain("username=Xero+User");

      const getRequest = createTestRequest(
        "http://localhost:3000/api/zero/connectors/xero",
      );
      const getResponse = await getConnector(getRequest);
      const connector = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(connector.type).toBe("xero");
      expect(connector.externalUsername).toBe("Xero User");
      expect(connector.externalId).toBe("xero-user-456");
      expect(connector.externalEmail).toBe("user@xero.com");
    });

    it("should redirect with error when Xero token exchange fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createXeroOAuthMock({
        tokenError: "Invalid authorization code",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "invalid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "xero",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "xero" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });

    it("should store refresh token as a secret when Xero returns one", async () => {
      const user = await context.setupUser();

      const { handlers: mswHandlers } = createXeroOAuthMock({
        accessToken: "xero-access-token",
        refreshToken: "xero-refresh-token-stored",
        userId: "xero-user-456",
        userName: "Xero User",
        email: "user@xero.com",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "xero",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "xero" }),
      });

      expect(response.status).toBe(307);

      const refreshToken = await findTestConnectorSecret(
        user.orgId,
        "XERO_REFRESH_TOKEN",
      );
      expect(refreshToken).toBe("xero-refresh-token-stored");
    });

    it("should set tokenExpiresAt when Xero returns expires_in", async () => {
      const user = await context.setupUser();
      const frozenNow = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      const expiresIn = 1800; // 30 minutes
      const { handlers: mswHandlers } = createXeroOAuthMock({
        accessToken: "xero-access-token",
        refreshToken: "xero-refresh-token",
        expiresIn,
        userId: "xero-user-exp",
        userName: "Expiring Xero",
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "valid-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "xero",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "xero" }),
      });

      expect(response.status).toBe(307);

      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "xero",
      );
      const expectedExpiry = new Date(frozenNow + expiresIn * 1000);
      expect(tokenExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
    });

    it("should redirect with error when Xero user info fetch fails", async () => {
      await context.setupUser();

      const { handlers: mswHandlers } = createXeroOAuthMock({
        userInfoError: true,
      });
      server.use(...mswHandlers);

      const request = createCallbackRequest({
        code: "test-code",
        state: "test-state",
        savedState: "test-state",
        connectorType: "xero",
      });
      const response = await GET(request, {
        params: Promise.resolve({ type: "xero" }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/connector/error");
    });
  });
});
