import { randomUUID } from "node:crypto";

import {
  CONNECTOR_TYPES,
  type ConnectorOAuthClientConfig,
  type OAuthConnectorType,
} from "@vm0/connectors/connectors";
import { getConnectorOAuthSecretMetadata } from "@vm0/connectors/oauth-providers";
import { testOauthProvider } from "@vm0/connectors/oauth-providers/providers/test-oauth-provider";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { connectors } from "@vm0/db/schema/connector";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { decryptSecretValue } from "../../services/crypto.utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";
const API_ORIGIN = "https://api.vm0.ai";
const WEB_ORIGIN = "https://www.vm0.ai";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL =
  "https://www.googleapis.com/gmail/v1/users/me/profile";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_USER_INFO_URL = "https://slack.com/api/users.info";
const DOCUSIGN_TOKEN_URL = "https://account-d.docusign.com/oauth/token";
const DOCUSIGN_USERINFO_URL = "https://account-d.docusign.com/oauth/userinfo";
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
const X_USER_INFO_URL = "https://api.twitter.com/2/users/me";
const VERCEL_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";
const VERCEL_USERINFO_URL = "https://api.vercel.com/v2/user";
const SENTRY_TOKEN_URL = "https://sentry.io/oauth/token/";
const INTERVALS_ICU_TOKEN_URL = "https://intervals.icu/api/oauth/token";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_USERINFO_URL = "https://identity.xero.com/connect/userinfo";

function callbackUrl(
  type: string,
  query: Record<string, string | undefined>,
  origin = BASE_URL,
): string {
  const url = new URL(`/api/connectors/${type}/callback`, origin);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url.toString();
}

function callbackHeaders(args: {
  readonly stateCookie?: string;
  readonly sessionId?: string;
  readonly codeVerifier?: string;
  readonly oauthContext?: string;
  readonly webOrigin?: string;
}): HeadersInit {
  const cookies = ["__session=opaque"];
  if (args.stateCookie) {
    cookies.push(
      `connector_oauth_state=${encodeURIComponent(args.stateCookie)}`,
    );
  }
  if (args.sessionId) {
    cookies.push(
      `connector_oauth_session=${encodeURIComponent(args.sessionId)}`,
    );
  }
  if (args.codeVerifier) {
    cookies.push(
      `connector_oauth_pkce=${encodeURIComponent(args.codeVerifier)}`,
    );
  }
  if (args.oauthContext) {
    cookies.push(
      `connector_oauth_context=${encodeURIComponent(args.oauthContext)}`,
    );
  }
  const headers: Record<string, string> = { cookie: cookies.join("; ") };
  if (args.webOrigin) {
    headers["x-vm0-web-origin"] = args.webOrigin;
  }
  return headers;
}

function authenticate(args: {
  readonly userId: string;
  readonly orgId: string;
}): void {
  mocks.clerk.session(args.userId, args.orgId);
}

async function requestCallback(args: {
  readonly type: string;
  readonly query: Record<string, string | undefined>;
  readonly headers?: HeadersInit;
  readonly origin?: string;
}): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(callbackUrl(args.type, args.query, args.origin), {
    method: "GET",
    headers: args.headers,
  });
}

function expectConnectorErrorRedirect(
  response: Response,
  args: { readonly type: string; readonly message: string },
): void {
  expect(response.status).toBe(307);
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  const url = new URL(location!);
  expect(url.pathname).toBe("/connector/error");
  expect(url.searchParams.get("type")).toBe(args.type);
  expect(url.searchParams.get("message")).toBe(args.message);
}

function mockOAuthEnv(): void {
  mockOptionalEnv("DEEL_OAUTH_CLIENT_ID", "deel-client-id");
  mockOptionalEnv("DEEL_OAUTH_CLIENT_SECRET", "deel-client-secret");
  mockOptionalEnv("DOCUSIGN_OAUTH_CLIENT_ID", "docusign-client-id");
  mockOptionalEnv("DOCUSIGN_OAUTH_CLIENT_SECRET", "docusign-client-secret");
  mockOptionalEnv("FIGMA_OAUTH_CLIENT_ID", "figma-client-id");
  mockOptionalEnv("FIGMA_OAUTH_CLIENT_SECRET", "figma-client-secret");
  mockOptionalEnv("GARMIN_CONNECT_OAUTH_CLIENT_ID", "garmin-client-id");
  mockOptionalEnv("GARMIN_CONNECT_OAUTH_CLIENT_SECRET", "garmin-client-secret");
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", "github-client-id");
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "github-client-secret");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  mockOptionalEnv("INTERVALS_ICU_OAUTH_CLIENT_ID", "intervals-icu-client-id");
  mockOptionalEnv(
    "INTERVALS_ICU_OAUTH_CLIENT_SECRET",
    "intervals-icu-client-secret",
  );
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_ID", "linear-client-id");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_SECRET", "linear-client-secret");
  mockOptionalEnv("MERCURY_OAUTH_CLIENT_ID", "mercury-client-id");
  mockOptionalEnv("MERCURY_OAUTH_CLIENT_SECRET", "mercury-client-secret");
  mockOptionalEnv("NEON_OAUTH_CLIENT_ID", "neon-client-id");
  mockOptionalEnv("NEON_OAUTH_CLIENT_SECRET", "neon-client-secret");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-client-secret");
  mockOptionalEnv("REDDIT_OAUTH_CLIENT_ID", "reddit-client-id");
  mockOptionalEnv("REDDIT_OAUTH_CLIENT_SECRET", "reddit-client-secret");
  mockOptionalEnv("SENTRY_OAUTH_CLIENT_ID", "sentry-client-id");
  mockOptionalEnv("SENTRY_OAUTH_CLIENT_SECRET", "sentry-client-secret");
  mockOptionalEnv("SLACK_CLIENT_ID", "slack-client-id");
  mockOptionalEnv("SLACK_CLIENT_SECRET", "slack-client-secret");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_ID", "strava-client-id");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_SECRET", "strava-client-secret");
  mockOptionalEnv("VERCEL_INTEGRATION_SLUG", "vm0-test");
  mockOptionalEnv("VERCEL_OAUTH_CLIENT_ID", "vercel-client-id");
  mockOptionalEnv("VERCEL_OAUTH_CLIENT_SECRET", "vercel-client-secret");
  mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-client-id");
  mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-client-secret");
  mockOptionalEnv("XERO_OAUTH_CLIENT_ID", "xero-client-id");
  mockOptionalEnv("XERO_OAUTH_CLIENT_SECRET", "xero-client-secret");
}

const dynamicPublicClient = {
  clientRegistration: "dynamic",
  clientType: "public",
  tokenEndpointAuthMethod: "none",
} as const satisfies ConnectorOAuthClientConfig;

type CapturedOAuthExchange = {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
};

function useDynamicTestOAuthExchange(): {
  readonly exchanges: readonly CapturedOAuthExchange[];
  readonly restore: () => void;
} {
  const exchanges: CapturedOAuthExchange[] = [];

  return {
    exchanges,
    restore: configureDynamicTestOAuthExchange(exchanges),
  };
}

function configureDynamicTestOAuthExchange(
  exchanges: CapturedOAuthExchange[],
): () => void {
  const oauth = CONNECTOR_TYPES["test-oauth"].oauth;
  if (!oauth) {
    throw new Error("test-oauth OAuth config is missing");
  }

  const mutableOAuth = oauth as { client: ConnectorOAuthClientConfig };
  const originalClient = oauth.client;
  const provider = testOauthProvider;
  const originalExchangeCode = provider.grant.exchangeCode;

  mutableOAuth.client = dynamicPublicClient;
  provider.grant.exchangeCode = (args) => {
    exchanges.push({
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      code: args.code,
      redirectUri: args.redirectUri,
      state: args.state,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
    });
    return Promise.resolve({
      accessToken: "dynamic-access-token",
      refreshToken: "dynamic-refresh-token",
      expiresIn: 3600,
      scopes: ["read"],
      userInfo: {
        id: "dynamic-user-id",
        username: "dynamic-user",
        email: "dynamic@example.com",
      },
    });
  };

  return () => {
    mutableOAuth.client = originalClient;
    provider.grant.exchangeCode = originalExchangeCode;
  };
}

function mockGitHubOAuth(options: {
  readonly accessToken?: string;
  readonly tokenError?: string;
  readonly userId?: number;
  readonly username?: string;
  readonly email?: string | null;
  readonly userError?: boolean;
}): void {
  server.use(
    http.post(GITHUB_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "bad_verification_code",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "github-access-token",
        scope: "repo",
        token_type: "bearer",
      });
    }),
    http.get(GITHUB_USER_URL, () => {
      if (options.userError) {
        return HttpResponse.json(
          { message: "Bad credentials" },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        id: options.userId ?? 12_345,
        login: options.username ?? "octocat",
        email: options.email ?? "octocat@example.com",
      });
    }),
  );
}

function mockNotionOAuth(options: {
  readonly accessToken?: string;
  readonly refreshToken?: string | null;
  readonly expiresIn?: number;
  readonly tokenError?: string;
}): void {
  server.use(
    http.post(NOTION_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "notion-access-token",
        refresh_token:
          options.refreshToken !== undefined
            ? options.refreshToken
            : "notion-refresh-token",
        expires_in: options.expiresIn ?? 7200,
        token_type: "bearer",
        owner: {
          user: {
            id: "notion-user-123",
            name: "Notion User",
            person: {
              email: "notion@example.com",
            },
          },
        },
      });
    }),
  );
}

function mockSlackOAuth(options: {
  readonly accessToken?: string;
  readonly tokenError?: string;
  readonly userError?: boolean;
}): void {
  server.use(
    http.post(SLACK_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          ok: false,
          error: options.tokenError,
        });
      }
      return HttpResponse.json({
        ok: true,
        authed_user: {
          id: "U012AB3CD",
          access_token: options.accessToken ?? "xoxp-user-token",
          scope: "channels:read,channels:history,chat:write",
        },
      });
    }),
    http.get(SLACK_USER_INFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({
          ok: false,
          error: "user_not_found",
        });
      }
      return HttpResponse.json({
        ok: true,
        user: {
          id: "U012AB3CD",
          name: "slackuser",
          real_name: "Slack User",
          profile: {
            email: "slack@example.com",
          },
        },
      });
    }),
  );
}

interface ProviderMockOptions {
  readonly type: OAuthConnectorType;
  readonly accessToken?: string;
  readonly refreshToken?: string | null;
  readonly expiresIn?: number;
  readonly tokenError?: string;
  readonly userError?: boolean;
}

interface ResolvedProviderMockOptions extends ProviderMockOptions {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn: number;
}

type ProviderMocker = (options: ResolvedProviderMockOptions) => void;

function mockTokenResponse(args: {
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly expiresIn?: number;
  readonly scope?: string;
  readonly extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    access_token: args.accessToken,
    refresh_token: args.refreshToken,
    ...(args.expiresIn === undefined ? {} : { expires_in: args.expiresIn }),
    token_type: "Bearer",
    ...(args.scope === undefined ? {} : { scope: args.scope }),
    ...args.extra,
  };
}

function mockJsonTokenEndpoint(
  url: string,
  options: ProviderMockOptions,
  successBody: Record<string, unknown>,
): ReturnType<typeof http.post> {
  return http.post(url, () => {
    if (options.tokenError) {
      return HttpResponse.json({
        error: "invalid_grant",
        error_description: options.tokenError,
      });
    }
    return HttpResponse.json(successBody);
  });
}

function resolvedProviderMockOptions(
  options: ProviderMockOptions,
): ResolvedProviderMockOptions {
  return {
    ...options,
    accessToken: options.accessToken ?? `${options.type}-access-token`,
    refreshToken:
      options.refreshToken === undefined
        ? `${options.type}-refresh-token`
        : options.refreshToken,
    expiresIn: options.expiresIn ?? 3600,
  };
}

function mockGmailProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      GMAIL_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope: "https://mail.google.com/",
      }),
    ),
    http.get(GMAIL_PROFILE_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        emailAddress: "user@gmail.com",
        messagesTotal: 1000,
        threadsTotal: 500,
        historyId: "123456",
      });
    }),
  );
}

function mockGoogleWorkspaceProvider(
  options: ResolvedProviderMockOptions,
): void {
  server.use(
    mockJsonTokenEndpoint(
      GOOGLE_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope:
          "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email",
      }),
    ),
    http.get(GOOGLE_USERINFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        id: "google-user-123",
        email: "user@gmail.com",
        name: "Google User",
      });
    }),
  );
}

function mockLinearProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      LINEAR_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope: "read,write",
      }),
    ),
    http.post(LINEAR_GRAPHQL_URL, () => {
      if (options.userError) {
        return HttpResponse.json(
          { errors: [{ message: "Unauthorized" }] },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        data: {
          viewer: {
            id: "linear-user-123",
            name: "Linear User",
            email: "user@linear.app",
          },
        },
      });
    }),
  );
}

function mockDocusignProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      DOCUSIGN_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope: "signature",
      }),
    ),
    http.get(DOCUSIGN_USERINFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        sub: "docusign-user-123",
        name: "DocuSign User",
        email: "user@docusign.com",
      });
    }),
  );
}

function mockFigmaProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      FIGMA_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
      }),
    ),
    http.get(FIGMA_ME_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        id: "figma-user-123",
        email: "user@figma.com",
        handle: "figmauser",
      });
    }),
  );
}

function mockStravaProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      STRAVA_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        extra: {
          athlete: {
            id: 12_345_678,
            firstname: "Strava",
            lastname: "Athlete",
          },
        },
      }),
    ),
    http.get(STRAVA_ATHLETE_URL, () => {
      if (options.userError) {
        return HttpResponse.json(
          { message: "Authorization Error" },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        id: 12_345_678,
        firstname: "Strava",
        lastname: "Athlete",
      });
    }),
  );
}

function mockGarminProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      GARMIN_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
      }),
    ),
    http.get(GARMIN_USER_ID_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        userId: "garmin-user-123",
        displayName: "Garmin User",
      });
    }),
  );
}

function mockDeelProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      DEEL_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
      }),
    ),
    http.get(DEEL_PEOPLE_ME_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        data: {
          id: "deel-entity-123",
          full_name: "Deel Test Org",
          emails: [{ type: "work", value: "test@deel.com" }],
        },
      });
    }),
  );
}

function mockMercuryProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      MERCURY_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope: "offline_access",
      }),
    ),
    http.get(MERCURY_ACCOUNTS_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        accounts: [
          {
            id: "mercury-account-123",
            name: "My Business Account",
            legalBusinessName: "My Business LLC",
          },
        ],
      });
    }),
  );
}

function mockNeonProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      NEON_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope: "openid offline_access urn:neoncloud:projects:read",
      }),
    ),
    http.get(NEON_USER_INFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        id: "neon-user-123",
        name: "Neon User",
        email: "user@neon.tech",
      });
    }),
  );
}

function mockRedditProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      REDDIT_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope: "identity read",
      }),
    ),
    http.get(REDDIT_USER_INFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({ id: "abc123", name: "testreddituser" });
    }),
  );
}

function mockXProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      X_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope: "tweet.read users.read follows.read offline.access",
      }),
    ),
    http.get(X_USER_INFO_URL, ({ request }) => {
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
          id: "x-user-123",
          username: "testxuser",
          name: "Test X User",
        },
      });
    }),
  );
}

function mockVercelProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      VERCEL_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        extra: {
          team_id: null,
          installation_id: "icfg_test123",
        },
      }),
    ),
    http.get(VERCEL_USERINFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        user: {
          id: "abc123vercel",
          username: "verceluser",
          email: "user@vercel.com",
        },
      });
    }),
  );
}

function mockSentryProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      SENTRY_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope:
          "org:read project:read team:read member:read event:read event:write",
        extra: {
          user: {
            id: "sentry-user-123",
            name: "Sentry User",
            email: "user@sentry.io",
          },
        },
      }),
    ),
  );
}

function mockIntervalsIcuProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(INTERVALS_ICU_TOKEN_URL, options, {
      access_token: options.accessToken,
      athlete: { id: "i12345", name: "Test Athlete" },
    }),
  );
}

function mockXeroProvider(options: ResolvedProviderMockOptions): void {
  server.use(
    mockJsonTokenEndpoint(
      XERO_TOKEN_URL,
      options,
      mockTokenResponse({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresIn: options.expiresIn,
        scope:
          "openid profile email offline_access accounting.transactions accounting.contacts accounting.settings",
      }),
    ),
    http.get(XERO_USERINFO_URL, () => {
      if (options.userError) {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      }
      return HttpResponse.json({
        sub: "xero-user-123",
        name: "Xero User",
        email: "user@xero.com",
      });
    }),
  );
}

function mockProviderOAuth(options: ProviderMockOptions): void {
  const providerMockers: Partial<Record<OAuthConnectorType, ProviderMocker>> = {
    github: (resolvedOptions) => {
      mockGitHubOAuth({
        accessToken: resolvedOptions.accessToken,
        tokenError: resolvedOptions.tokenError,
        userError: resolvedOptions.userError,
      });
    },
    slack: (resolvedOptions) => {
      mockSlackOAuth({
        accessToken: resolvedOptions.accessToken,
        tokenError: resolvedOptions.tokenError,
        userError: resolvedOptions.userError,
      });
    },
    notion: (resolvedOptions) => {
      mockNotionOAuth({
        accessToken: resolvedOptions.accessToken,
        refreshToken: resolvedOptions.refreshToken,
        expiresIn: resolvedOptions.expiresIn,
        tokenError: resolvedOptions.tokenError,
      });
    },
    gmail: mockGmailProvider,
    "google-sheets": mockGoogleWorkspaceProvider,
    "google-docs": mockGoogleWorkspaceProvider,
    "google-drive": mockGoogleWorkspaceProvider,
    "google-calendar": mockGoogleWorkspaceProvider,
    linear: mockLinearProvider,
    docusign: mockDocusignProvider,
    figma: mockFigmaProvider,
    strava: mockStravaProvider,
    "garmin-connect": mockGarminProvider,
    deel: mockDeelProvider,
    mercury: mockMercuryProvider,
    neon: mockNeonProvider,
    reddit: mockRedditProvider,
    x: mockXProvider,
    vercel: mockVercelProvider,
    sentry: mockSentryProvider,
    "intervals-icu": mockIntervalsIcuProvider,
    xero: mockXeroProvider,
  };
  const mocker = providerMockers[options.type];
  if (!mocker) {
    throw new Error(`No callback test mock for ${options.type}`);
  }
  mocker(resolvedProviderMockOptions(options));
}

async function seedSession(userId: string): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(connectorSessions)
    .values({
      code: randomUUID().slice(0, 9).toUpperCase(),
      type: "github",
      userId,
      status: "pending",
      expiresAt: new Date(now() + 15 * 60 * 1000),
    })
    .returning({ id: connectorSessions.id });
  expect(session).toBeDefined();
  return session!.id;
}

async function seedOauthState(args: {
  readonly type: string;
  readonly userId: string;
  readonly orgId: string;
  readonly state?: string;
  readonly sessionId?: string;
  readonly redirectUri?: string;
  readonly codeVerifier?: string;
  readonly oauthContext?: string;
  readonly expiresAt?: Date;
  readonly consumedAt?: Date | null;
}): Promise<string> {
  const db = store.set(writeDb$);
  const [oauthState] = await db
    .insert(connectorOauthStates)
    .values({
      state: args.state ?? `state-${randomUUID()}`,
      type: args.type,
      userId: args.userId,
      orgId: args.orgId,
      sessionId: args.sessionId,
      redirectUri:
        args.redirectUri ?? `${BASE_URL}/api/connectors/${args.type}/callback`,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
      expiresAt: args.expiresAt ?? new Date(now() + 15 * 60 * 1000),
      consumedAt: args.consumedAt,
    })
    .returning({ id: connectorOauthStates.id });
  expect(oauthState).toBeDefined();
  return oauthState!.id;
}

async function findConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}) {
  const db = store.set(writeDb$);
  const [connector] = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.type, args.type),
      ),
    );
  return connector;
}

async function findSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}) {
  const db = store.set(writeDb$);
  const [secret] = await db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, args.name),
        eq(secrets.type, "connector"),
      ),
    );
  return secret;
}

async function findDecryptedSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}): Promise<string | undefined> {
  const secret = await findSecret(args);
  return secret ? decryptSecretValue(secret.encryptedValue) : undefined;
}

interface ProviderSuccessCase {
  readonly type: OAuthConnectorType;
  readonly externalId: string;
  readonly externalUsername: string;
  readonly externalEmail: string | null;
}

const providerSuccessCases = [
  {
    type: "github",
    externalId: "12345",
    externalUsername: "octocat",
    externalEmail: "octocat@example.com",
  },
  {
    type: "slack",
    externalId: "U012AB3CD",
    externalUsername: "Slack User",
    externalEmail: "slack@example.com",
  },
  {
    type: "notion",
    externalId: "notion-user-123",
    externalUsername: "Notion User",
    externalEmail: "notion@example.com",
  },
  {
    type: "gmail",
    externalId: "user@gmail.com",
    externalUsername: "user@gmail.com",
    externalEmail: "user@gmail.com",
  },
  {
    type: "google-sheets",
    externalId: "google-user-123",
    externalUsername: "Google User",
    externalEmail: "user@gmail.com",
  },
  {
    type: "google-docs",
    externalId: "google-user-123",
    externalUsername: "Google User",
    externalEmail: "user@gmail.com",
  },
  {
    type: "google-drive",
    externalId: "google-user-123",
    externalUsername: "Google User",
    externalEmail: "user@gmail.com",
  },
  {
    type: "google-calendar",
    externalId: "google-user-123",
    externalUsername: "Google User",
    externalEmail: "user@gmail.com",
  },
  {
    type: "linear",
    externalId: "linear-user-123",
    externalUsername: "Linear User",
    externalEmail: "user@linear.app",
  },
  {
    type: "docusign",
    externalId: "docusign-user-123",
    externalUsername: "DocuSign User",
    externalEmail: "user@docusign.com",
  },
  {
    type: "figma",
    externalId: "figma-user-123",
    externalUsername: "figmauser",
    externalEmail: "user@figma.com",
  },
  {
    type: "strava",
    externalId: "12345678",
    externalUsername: "Strava Athlete",
    externalEmail: null,
  },
  {
    type: "garmin-connect",
    externalId: "garmin-user-123",
    externalUsername: "Garmin User",
    externalEmail: null,
  },
  {
    type: "deel",
    externalId: "deel-entity-123",
    externalUsername: "Deel Test Org",
    externalEmail: "test@deel.com",
  },
  {
    type: "mercury",
    externalId: "mercury-account-123",
    externalUsername: "My Business Account",
    externalEmail: null,
  },
  {
    type: "neon",
    externalId: "neon-user-123",
    externalUsername: "Neon User",
    externalEmail: "user@neon.tech",
  },
  {
    type: "reddit",
    externalId: "abc123",
    externalUsername: "testreddituser",
    externalEmail: null,
  },
  {
    type: "x",
    externalId: "x-user-123",
    externalUsername: "testxuser",
    externalEmail: null,
  },
  {
    type: "vercel",
    externalId: "abc123vercel",
    externalUsername: "verceluser",
    externalEmail: "user@vercel.com",
  },
  {
    type: "sentry",
    externalId: "sentry-user-123",
    externalUsername: "Sentry User",
    externalEmail: "user@sentry.io",
  },
  {
    type: "intervals-icu",
    externalId: "i12345",
    externalUsername: "Test Athlete",
    externalEmail: null,
  },
  {
    type: "xero",
    externalId: "xero-user-123",
    externalUsername: "Xero User",
    externalEmail: "user@xero.com",
  },
] as const satisfies readonly ProviderSuccessCase[];

function hasFetchableUserInfo(type: OAuthConnectorType): boolean {
  return type !== "notion" && type !== "sentry" && type !== "intervals-icu";
}

const providerUserInfoErrorCases = providerSuccessCases.filter(
  (providerCase) => {
    return hasFetchableUserInfo(providerCase.type);
  },
);

describe("GET /api/connectors/:type/callback", () => {
  const orgIds: string[] = [];
  const sessionIds: string[] = [];
  const oauthStateIds: string[] = [];
  let restoreDynamicTestOAuthExchange: (() => void) | undefined;

  beforeEach(() => {
    mockEnv("VM0_WEB_URL", BASE_URL);
    mockOAuthEnv();
  });

  afterEach(async () => {
    restoreDynamicTestOAuthExchange?.();
    restoreDynamicTestOAuthExchange = undefined;

    server.resetHandlers();

    const db = store.set(writeDb$);
    while (orgIds.length > 0) {
      const orgId = orgIds.pop();
      if (orgId) {
        await db
          .delete(githubInstallations)
          .where(eq(githubInstallations.orgId, orgId));
        await db.delete(connectors).where(eq(connectors.orgId, orgId));
        await db.delete(secrets).where(eq(secrets.orgId, orgId));
        await db.delete(agentComposes).where(eq(agentComposes.orgId, orgId));
      }
    }
    while (sessionIds.length > 0) {
      const sessionId = sessionIds.pop();
      if (sessionId) {
        await db
          .delete(connectorSessions)
          .where(eq(connectorSessions.id, sessionId));
      }
    }
    while (oauthStateIds.length > 0) {
      const oauthStateId = oauthStateIds.pop();
      if (oauthStateId) {
        await db
          .delete(connectorOauthStates)
          .where(eq(connectorOauthStates.id, oauthStateId));
      }
    }
  });

  it("redirects unauthenticated users to the connector error page", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("type")).toBe("github");
    expect(url.searchParams.get("message")).toBe("Not authenticated");
  });

  it("redirects unknown connector types to the connector error page", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "invalid",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("type")).toBe("invalid");
    expect(url.searchParams.get("message")).toBe("Unknown connector type");
  });

  it("redirects OAuth provider errors and clears OAuth cookies", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "github",
      query: {
        error: "access_denied",
        error_description: "The user denied access",
        state: "state-123",
      },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe("The user denied access");
    expect(response.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([
        "connector_oauth_state=; Max-Age=0; Path=/",
        "connector_oauth_session=; Max-Age=0; Path=/",
        "connector_oauth_pkce=; Max-Age=0; Path=/",
      ]),
    );
  });

  it("redirects missing authorization codes and clears OAuth cookies", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "github",
      query: { state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe("Missing authorization code");
    expect(response.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([
        "connector_oauth_state=; Max-Age=0; Path=/",
        "connector_oauth_session=; Max-Age=0; Path=/",
        "connector_oauth_pkce=; Max-Age=0; Path=/",
      ]),
    );
  });

  it("redirects missing state values and clears OAuth cookies", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe("Missing state parameter");
    expect(response.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([
        "connector_oauth_state=; Max-Age=0; Path=/",
        "connector_oauth_session=; Max-Age=0; Path=/",
        "connector_oauth_pkce=; Max-Age=0; Path=/",
      ]),
    );
  });

  it("redirects computer callbacks because the connector is not OAuth-backed", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "computer",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe(
      "Computer connector does not use OAuth",
    );
  });

  it("redirects device authorization callbacks to the connector error page", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "test-oauth-device",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("type")).toBe("test-oauth-device");
    expect(url.searchParams.get("message")).toBe(
      "test-oauth-device connector does not use authorization-code OAuth",
    );
  });

  it("rejects state mismatch and clears OAuth cookies", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "returned-state" },
      headers: callbackHeaders({
        stateCookie: "saved-state",
        oauthContext: "opaque-context",
      }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe(
      "Invalid state - please try again",
    );
    const cookies = response.headers.getSetCookie();
    expect(cookies).toStrictEqual(
      expect.arrayContaining([
        "connector_oauth_state=; Max-Age=0; Path=/",
        "connector_oauth_session=; Max-Age=0; Path=/",
        "connector_oauth_pkce=; Max-Age=0; Path=/",
        "connector_oauth_context=; Max-Age=0; Path=/",
      ]),
    );
  });

  it("uses VM0_WEB_URL for callback error redirects", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "returned-state" },
      origin: API_ORIGIN,
      headers: callbackHeaders({
        stateCookie: "saved-state",
        webOrigin: WEB_ORIGIN,
      }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.origin).toBe(BASE_URL);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("type")).toBe("github");
    expect(url.searchParams.get("message")).toBe(
      "Invalid state - please try again",
    );
  });

  it("redirects direct API host callback requests to the canonical web route", async () => {
    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${WEB_ORIGIN}/api/connectors/github/callback?code=code-123&state=state-123`,
    );
  });

  it("marks CLI sessions as error when user info fetch fails", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    const sessionId = await seedSession(userId);
    sessionIds.push(sessionId);
    mockGitHubOAuth({ accessToken: "github-token", userError: true });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123", sessionId }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe(
      "OAuth authorization failed. Please try again.",
    );

    const db = store.set(writeDb$);
    const [session] = await db
      .select()
      .from(connectorSessions)
      .where(eq(connectorSessions.id, sessionId));
    expect(session?.status).toBe("error");
    expect(session?.errorMessage).toContain("GitHub user API failed");
  });

  it("stores a GitHub OAuth connector and completes the CLI session", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    const sessionId = await seedSession(userId);
    sessionIds.push(sessionId);
    mockGitHubOAuth({
      accessToken: "github-token",
      userId: 98_765,
      username: "octocat",
      email: "octocat@example.com",
    });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({
        stateCookie: "state-123",
        sessionId,
        oauthContext: "opaque-context",
      }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/success");
    expect(url.searchParams.get("type")).toBe("github");
    expect(url.searchParams.get("username")).toBe("octocat");
    expect(response.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([
        "connector_oauth_state=; Max-Age=0; Path=/",
        "connector_oauth_session=; Max-Age=0; Path=/",
        "connector_oauth_pkce=; Max-Age=0; Path=/",
        "connector_oauth_context=; Max-Age=0; Path=/",
      ]),
    );

    const connector = await findConnector({ orgId, userId, type: "github" });
    expect(connector).toMatchObject({
      type: "github",
      authMethod: "oauth",
      externalId: "98765",
      externalUsername: "octocat",
      externalEmail: "octocat@example.com",
      needsReconnect: false,
    });
    expect(connector?.oauthScopes).toBe(
      JSON.stringify(["repo", "project", "workflow"]),
    );
    expect(connector?.tokenExpiresAt).toBeNull();

    const secret = await findSecret({
      orgId,
      userId,
      name: "GITHUB_ACCESS_TOKEN",
    });
    expect(secret).toBeDefined();
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("github-token");

    const db = store.set(writeDb$);
    const [session] = await db
      .select()
      .from(connectorSessions)
      .where(eq(connectorSessions.id, sessionId));
    expect(session?.status).toBe("complete");
    expect(session?.completedAt).toBeInstanceOf(Date);
  });

  it("links a GitHub integration after GitHub connector OAuth completes", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    const db = store.set(writeDb$);
    const composeId = randomUUID();
    await db.insert(agentComposes).values({
      id: composeId,
      orgId,
      userId,
      name: `github-callback-${composeId}`,
    });
    const [installation] = await db
      .insert(githubInstallations)
      .values({
        installationId: "123456789",
        status: "active",
        orgId,
        targetType: "Organization",
        targetId: "98765",
        targetName: "vm0-test",
        defaultComposeId: composeId,
      })
      .returning({ id: githubInstallations.id });
    if (!installation) {
      throw new Error("Expected GitHub installation insert to return a row");
    }
    mockGitHubOAuth({
      accessToken: "github-token",
      userId: 98_765,
      username: "octocat",
      email: "octocat@example.com",
    });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const links = await db
      .select()
      .from(githubUserLinks)
      .where(
        and(
          eq(githubUserLinks.installationId, installation.id),
          eq(githubUserLinks.vm0UserId, userId),
        ),
      );
    expect(links).toMatchObject([{ githubUserId: "98765" }]);
  });

  it("stores a connector from a server-side OAuth handoff without Clerk cookies", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "github",
      userId,
      orgId,
      state,
      oauthContext: "opaque-context",
    });
    oauthStateIds.push(oauthStateId);
    mockGitHubOAuth({
      accessToken: "github-token",
      userId: 98_765,
      username: "octocat",
      email: "octocat@example.com",
    });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state },
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/success");
    expect(url.searchParams.get("type")).toBe("github");
    expect(url.searchParams.get("username")).toBe("octocat");

    const connector = await findConnector({ orgId, userId, type: "github" });
    expect(connector).toMatchObject({
      type: "github",
      authMethod: "oauth",
      externalId: "98765",
      externalUsername: "octocat",
      externalEmail: "octocat@example.com",
      needsReconnect: false,
    });

    const db = store.set(writeDb$);
    const [storedState] = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.id, oauthStateId));
    expect(storedState?.consumedAt).toBeInstanceOf(Date);
  });

  it("rejects a reused server-side OAuth handoff state", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "github",
      userId,
      orgId,
      state,
    });
    oauthStateIds.push(oauthStateId);
    mockGitHubOAuth({
      accessToken: "github-token",
      userId: 98_765,
      username: "octocat",
      email: "octocat@example.com",
    });

    const first = await requestCallback({
      type: "github",
      query: { code: "code-123", state },
    });
    expect(first.status).toBe(307);
    expect(new URL(first.headers.get("location")!).pathname).toBe(
      "/connector/success",
    );

    const second = await requestCallback({
      type: "github",
      query: { code: "code-456", state },
    });

    expectConnectorErrorRedirect(second, {
      type: "github",
      message: "Invalid state - please try again",
    });
  });

  it("consumes server-side OAuth handoff state when the provider returns an error", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "github",
      userId,
      orgId,
      state,
    });
    oauthStateIds.push(oauthStateId);

    const response = await requestCallback({
      type: "github",
      query: {
        error: "access_denied",
        error_description: "The user denied access",
        state,
      },
    });

    expectConnectorErrorRedirect(response, {
      type: "github",
      message: "The user denied access",
    });

    const db = store.set(writeDb$);
    const [storedState] = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.id, oauthStateId));
    expect(storedState?.consumedAt).toBeInstanceOf(Date);
  });

  it("rejects an invalid server-side OAuth handoff state before provider errors", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "github",
      userId,
      orgId,
      state,
      consumedAt: new Date(now()),
    });
    oauthStateIds.push(oauthStateId);

    const response = await requestCallback({
      type: "github",
      query: {
        error: "access_denied",
        error_description: "The user denied access",
        state,
      },
    });

    expectConnectorErrorRedirect(response, {
      type: "github",
      message: "Invalid state - please try again",
    });
  });

  it("rejects an already consumed server-side OAuth handoff state", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "github",
      userId,
      orgId,
      state,
      consumedAt: new Date(now()),
    });
    oauthStateIds.push(oauthStateId);

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state },
    });

    expectConnectorErrorRedirect(response, {
      type: "github",
      message: "Invalid state - please try again",
    });
  });

  it("rejects an expired server-side OAuth handoff state", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "github",
      userId,
      orgId,
      state,
      expiresAt: new Date(now() - 1000),
    });
    oauthStateIds.push(oauthStateId);

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state },
    });

    expectConnectorErrorRedirect(response, {
      type: "github",
      message: "Invalid state - please try again",
    });
  });

  it("rejects a server-side OAuth handoff state for another connector type", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "slack",
      userId,
      orgId,
      state,
    });
    oauthStateIds.push(oauthStateId);

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state },
    });

    expectConnectorErrorRedirect(response, {
      type: "github",
      message: "Invalid state - please try again",
    });
  });

  it("does not consume server-side OAuth handoff state when the code is missing", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "github",
      userId,
      orgId,
      state,
    });
    oauthStateIds.push(oauthStateId);

    const response = await requestCallback({
      type: "github",
      query: { state },
    });

    expectConnectorErrorRedirect(response, {
      type: "github",
      message: "Missing authorization code",
    });

    const db = store.set(writeDb$);
    const [storedState] = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.id, oauthStateId));
    expect(storedState?.consumedAt).toBeNull();
  });

  it("rejects an invalid server-side OAuth handoff state before missing code", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const state = `state-${randomUUID()}`;
    orgIds.push(orgId);
    const oauthStateId = await seedOauthState({
      type: "github",
      userId,
      orgId,
      state,
      consumedAt: new Date(now()),
    });
    oauthStateIds.push(oauthStateId);

    const response = await requestCallback({
      type: "github",
      query: { state },
    });

    expectConnectorErrorRedirect(response, {
      type: "github",
      message: "Invalid state - please try again",
    });
  });

  it("uses cookie-backed direct callback state when no stored handoff state exists", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    mockGitHubOAuth({
      accessToken: "github-token",
      userId: 98_765,
      username: "octocat",
      email: "octocat@example.com",
    });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/success");
    expect(url.searchParams.get("type")).toBe("github");
    expect(url.searchParams.get("username")).toBe("octocat");
  });

  it("passes OAuth context to dynamic public connector exchange", async () => {
    const dynamicOAuth = useDynamicTestOAuthExchange();
    restoreDynamicTestOAuthExchange = dynamicOAuth.restore;
    const { exchanges } = dynamicOAuth;
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "test-oauth",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({
        stateCookie: "state-123",
        codeVerifier: "pkce-verifier",
        oauthContext: "dynamic-oauth-context; tenant=example",
      }),
    });

    expect(response.status).toBe(307);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toStrictEqual({
      clientId: undefined,
      clientSecret: undefined,
      code: "code-123",
      redirectUri: `${BASE_URL}/api/connectors/test-oauth/callback`,
      state: "state-123",
      codeVerifier: "pkce-verifier",
      oauthContext: "dynamic-oauth-context; tenant=example",
    });
    expect(response.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([
        "connector_oauth_state=; Max-Age=0; Path=/",
        "connector_oauth_session=; Max-Age=0; Path=/",
        "connector_oauth_pkce=; Max-Age=0; Path=/",
        "connector_oauth_context=; Max-Age=0; Path=/",
      ]),
    );

    const connector = await findConnector({
      orgId,
      userId,
      type: "test-oauth",
    });
    expect(connector).toMatchObject({
      type: "test-oauth",
      authMethod: "oauth",
      externalId: "dynamic-user-id",
      externalUsername: "dynamic-user",
      externalEmail: "dynamic@example.com",
      needsReconnect: false,
    });

    const secret = await findSecret({
      orgId,
      userId,
      name: "TEST_OAUTH_ACCESS_TOKEN",
    });
    expect(secret).toBeDefined();
    expect(decryptSecretValue(secret!.encryptedValue)).toBe(
      "dynamic-access-token",
    );
  });

  it("uses VM0_WEB_URL for token exchange and success redirects", async () => {
    const dynamicOAuth = useDynamicTestOAuthExchange();
    restoreDynamicTestOAuthExchange = dynamicOAuth.restore;
    const { exchanges } = dynamicOAuth;
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "test-oauth",
      query: { code: "code-123", state: "state-123" },
      origin: API_ORIGIN,
      headers: callbackHeaders({
        stateCookie: "state-123",
        codeVerifier: "pkce-verifier",
        oauthContext: "dynamic-oauth-context; tenant=example",
        webOrigin: WEB_ORIGIN,
      }),
    });

    expect(response.status).toBe(307);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.redirectUri).toBe(
      `${BASE_URL}/api/connectors/test-oauth/callback`,
    );
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.origin).toBe(BASE_URL);
    expect(url.pathname).toBe("/connector/success");
    expect(url.searchParams.get("type")).toBe("test-oauth");
    expect(url.searchParams.get("username")).toBe("dynamic-user");
  });

  it("stores a Slack user OAuth token without an expiry", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    mockSlackOAuth({ accessToken: "xoxp-stored-token" });

    const response = await requestCallback({
      type: "slack",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const connector = await findConnector({ orgId, userId, type: "slack" });
    expect(connector).toMatchObject({
      type: "slack",
      authMethod: "oauth",
      externalId: "U012AB3CD",
      externalUsername: "Slack User",
      externalEmail: "slack@example.com",
    });
    expect(connector?.tokenExpiresAt).toBeNull();

    const secret = await findSecret({
      orgId,
      userId,
      name: "SLACK_ACCESS_TOKEN",
    });
    expect(secret).toBeDefined();
    expect(decryptSecretValue(secret!.encryptedValue)).toBe(
      "xoxp-stored-token",
    );
  });

  it("stores a Notion refresh token and access-token expiry", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    mockNotionOAuth({
      accessToken: "notion-access",
      refreshToken: "notion-refresh",
      expiresIn: 7200,
    });

    const response = await requestCallback({
      type: "notion",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const connector = await findConnector({ orgId, userId, type: "notion" });
    expect(connector).toMatchObject({
      type: "notion",
      authMethod: "oauth",
      externalId: "notion-user-123",
      externalUsername: "Notion User",
      externalEmail: "notion@example.com",
    });
    expect(connector?.tokenExpiresAt).toBeInstanceOf(Date);
    expect(connector!.tokenExpiresAt!.getTime()).toBeGreaterThan(now());

    const accessSecret = await findSecret({
      orgId,
      userId,
      name: "NOTION_ACCESS_TOKEN",
    });
    const refreshSecret = await findSecret({
      orgId,
      userId,
      name: "NOTION_REFRESH_TOKEN",
    });
    expect(accessSecret).toBeDefined();
    expect(refreshSecret).toBeDefined();
    expect(decryptSecretValue(accessSecret!.encryptedValue)).toBe(
      "notion-access",
    );
    expect(decryptSecretValue(refreshSecret!.encryptedValue)).toBe(
      "notion-refresh",
    );
  });

  it.each(providerSuccessCases)(
    "stores $type OAuth connector data through the API callback route",
    async (providerCase) => {
      const orgId = `org_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const accessToken = `${providerCase.type}-stored-access-token`;
      const refreshToken = `${providerCase.type}-stored-refresh-token`;
      orgIds.push(orgId);
      authenticate({ userId, orgId });
      mockProviderOAuth({
        type: providerCase.type,
        accessToken,
        refreshToken,
        expiresIn: 3600,
      });

      const response = await requestCallback({
        type: providerCase.type,
        query: { code: "code-123", state: "state-123" },
        headers: callbackHeaders({
          stateCookie: "state-123",
          codeVerifier:
            providerCase.type === "x" ? "x-test-code-verifier" : undefined,
        }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      const url = new URL(location!);
      expect(url.pathname).toBe("/connector/success");
      expect(url.searchParams.get("type")).toBe(providerCase.type);
      expect(url.searchParams.get("username")).toBe(
        providerCase.externalUsername,
      );

      const connector = await findConnector({
        orgId,
        userId,
        type: providerCase.type,
      });
      expect(connector).toMatchObject({
        type: providerCase.type,
        authMethod: "oauth",
        externalId: providerCase.externalId,
        externalUsername: providerCase.externalUsername,
        externalEmail: providerCase.externalEmail,
        needsReconnect: false,
      });

      const secretMetadata = getConnectorOAuthSecretMetadata(providerCase.type);
      await expect(
        findDecryptedSecret({
          orgId,
          userId,
          name: secretMetadata.accessSecretName,
        }),
      ).resolves.toBe(accessToken);

      if (secretMetadata.isRefreshable) {
        await expect(
          findDecryptedSecret({
            orgId,
            userId,
            name: secretMetadata.refreshSecretName,
          }),
        ).resolves.toBe(refreshToken);
        expect(connector?.tokenExpiresAt).toBeInstanceOf(Date);
        expect(connector!.tokenExpiresAt!.getTime()).toBeGreaterThan(now());
      }
    },
  );

  it.each(providerSuccessCases)(
    "redirects when $type token exchange fails",
    async (providerCase) => {
      const orgId = `org_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      orgIds.push(orgId);
      authenticate({ userId, orgId });
      mockProviderOAuth({
        type: providerCase.type,
        tokenError: "bad code",
      });

      const response = await requestCallback({
        type: providerCase.type,
        query: { code: "code-123", state: "state-123" },
        headers: callbackHeaders({
          stateCookie: "state-123",
          codeVerifier:
            providerCase.type === "x" ? "x-test-code-verifier" : undefined,
        }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      const url = new URL(location!);
      expect(url.pathname).toBe("/connector/error");
      expect(url.searchParams.get("type")).toBe(providerCase.type);
      expect(url.searchParams.get("message")).toBe(
        "OAuth authorization failed. Please try again.",
      );
      expect(response.headers.getSetCookie()).toStrictEqual(
        expect.arrayContaining([
          "connector_oauth_state=; Max-Age=0; Path=/",
          "connector_oauth_session=; Max-Age=0; Path=/",
          "connector_oauth_pkce=; Max-Age=0; Path=/",
        ]),
      );

      await expect(
        findConnector({ orgId, userId, type: providerCase.type }),
      ).resolves.toBeUndefined();
    },
  );

  it.each(providerUserInfoErrorCases)(
    "redirects when $type user info fetch fails",
    async (providerCase) => {
      const orgId = `org_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      orgIds.push(orgId);
      authenticate({ userId, orgId });
      mockProviderOAuth({
        type: providerCase.type,
        userError: true,
      });

      const response = await requestCallback({
        type: providerCase.type,
        query: { code: "code-123", state: "state-123" },
        headers: callbackHeaders({
          stateCookie: "state-123",
          codeVerifier:
            providerCase.type === "x" ? "x-test-code-verifier" : undefined,
        }),
      });

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      const url = new URL(location!);
      expect(url.pathname).toBe("/connector/error");
      expect(url.searchParams.get("type")).toBe(providerCase.type);
      expect(url.searchParams.get("message")).toBe(
        "OAuth authorization failed. Please try again.",
      );

      await expect(
        findConnector({ orgId, userId, type: providerCase.type }),
      ).resolves.toBeUndefined();
    },
  );

  it("marks CLI sessions as error when token exchange fails", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    const sessionId = await seedSession(userId);
    sessionIds.push(sessionId);
    mockGitHubOAuth({ tokenError: "bad code" });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123", sessionId }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe(
      "OAuth authorization failed. Please try again.",
    );

    const db = store.set(writeDb$);
    const [session] = await db
      .select()
      .from(connectorSessions)
      .where(eq(connectorSessions.id, sessionId));
    expect(session?.status).toBe("error");
    expect(session?.errorMessage).toBe("bad code");
  });
});
