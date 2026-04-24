import { vi } from "vitest";
import { http as mswHttp, HttpResponse } from "msw";
import type { ConnectorType } from "@vm0/core/contracts/connectors";
import { server } from "../../mocks/server";
import { reloadEnv } from "../../env";
import { GET as connectorCallbackRoute } from "../../../app/api/connectors/[type]/callback/route";
import { POST as setSecretRoute } from "../../../app/api/zero/secrets/route";
import { createTestRequest } from "./core";

// ---------------------------------------------------------------------------
// Re-exports: DB-direct seeders and assertion helpers.
//
// These functions were moved to dedicated directories but are re-exported
// here for backward compatibility — existing test files import from
// api-test-helpers and should continue to work unchanged.
// ---------------------------------------------------------------------------

export {
  createTestUserConnector,
  insertTestConnectorSecret,
  insertTestPlatformConnector,
  createTestConnectorSession,
} from "../db-test-seeders/connectors";

export {
  findTestConnectorSecret,
  findTestConnectorTokenExpiresAt,
  countPlatformConnectorRows,
} from "../db-test-assertions/connectors";

// ---------------------------------------------------------------------------
// API-based helpers.
//
// These call production route handlers (not raw DB) and are valid
// API-based helpers.
// ---------------------------------------------------------------------------

// OAuth provider mock configurations for test setup
const OAUTH_PROVIDER_MOCKS: Record<
  string,
  {
    tokenUrl: string;
    userUrl: string;
    userMethod?: "get" | "post";
    envVars: Record<string, string>;
    buildTokenResponse: (accessToken: string) => Record<string, unknown>;
    buildUserResponse: (opts: {
      userId?: number;
      username?: string;
      email?: string;
    }) => Record<string, unknown>;
  }
> = {
  github: {
    tokenUrl: "https://github.com/login/oauth/access_token",
    userUrl: "https://api.github.com/user",
    envVars: {
      GH_OAUTH_CLIENT_ID: "test-client-id",
      GH_OAUTH_CLIENT_SECRET: "test-client-secret",
    },
    buildTokenResponse: (accessToken) => {
      return {
        access_token: accessToken,
        scope: "repo,project",
        token_type: "bearer",
      };
    },
    buildUserResponse: (opts) => {
      return {
        id: opts.userId ?? 12345,
        login: opts.username ?? "testuser",
        email: opts.email ?? "test@example.com",
      };
    },
  },
  slack: {
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    userUrl: "https://slack.com/api/users.info",
    envVars: {},
    buildTokenResponse: (accessToken) => {
      return {
        ok: true,
        authed_user: {
          id: "U12345",
          access_token: accessToken,
          scope: "channels:read,chat:write",
        },
      };
    },
    buildUserResponse: (opts) => {
      return {
        ok: true,
        user: {
          id: opts.userId?.toString() ?? "U12345",
          name: opts.username ?? "testuser",
          real_name: opts.username ?? "Test User",
          profile: { email: opts.email ?? "test@example.com" },
        },
      };
    },
  },
  figma: {
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    userUrl: "https://api.figma.com/v1/me",
    envVars: {
      FIGMA_OAUTH_CLIENT_ID: "figma-test-client-id",
      FIGMA_OAUTH_CLIENT_SECRET: "figma-test-client-secret",
    },
    buildTokenResponse: (accessToken) => {
      return {
        access_token: accessToken,
        refresh_token: "figma-refresh-token",
        expires_in: 7776000,
      };
    },
    buildUserResponse: (opts) => {
      return {
        id: opts.userId?.toString() ?? "12345",
        email: opts.email ?? "test@example.com",
        handle: opts.username ?? "testuser",
      };
    },
  },
  linear: {
    tokenUrl: "https://api.linear.app/oauth/token",
    userUrl: "https://api.linear.app/graphql",
    userMethod: "post",
    envVars: {
      LINEAR_OAUTH_CLIENT_ID: "linear-test-client-id",
      LINEAR_OAUTH_CLIENT_SECRET: "linear-test-client-secret",
    },
    buildTokenResponse: (accessToken) => {
      return {
        access_token: accessToken,
        refresh_token: "linear-refresh-token",
        expires_in: 86399,
        token_type: "Bearer",
        scope: "read,write,issues:create,comments:create,timeSchedule:write",
      };
    },
    buildUserResponse: (opts) => {
      return {
        data: {
          viewer: {
            id: opts.userId?.toString() ?? "linear-user-123",
            name: opts.username ?? "Linear User",
            email: opts.email ?? "user@linear.app",
          },
        },
      };
    },
  },
};

/**
 * Create an api-token connector by storing user secrets via PUT /api/secrets.
 * Api-token connector status is now derived from user secrets, not DB records.
 */
async function createTestApiTokenConnector(options?: {
  type?: ConnectorType;
  accessToken?: string;
  secretName?: string;
}): Promise<void> {
  const type = options?.type ?? "github";
  const tokenValue = options?.accessToken ?? "test-api-token";
  const secretName =
    options?.secretName ?? `${type.toUpperCase().replace(/-/g, "_")}_TOKEN`;

  const request = createTestRequest("http://localhost:3000/api/zero/secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: secretName,
      value: tokenValue,
      description: `API token for ${type} connector`,
    }),
  });
  const response = await setSecretRoute(request);
  if (response.status !== 200 && response.status !== 201) {
    const data = await response.json();
    throw new Error(
      `Failed to create api-token connector user secret: ${data.error?.message ?? response.status}`,
    );
  }
}

/**
 * Create an OAuth connector via GET /api/connectors/:type/callback with MSW mocks.
 */
async function createTestOAuthConnector(options?: {
  type?: ConnectorType;
  accessToken?: string;
  externalUsername?: string;
}): Promise<void> {
  const type = options?.type ?? "github";
  const accessToken = options?.accessToken ?? "test-github-token";
  const providerMock = OAUTH_PROVIDER_MOCKS[type];
  if (!providerMock) {
    throw new Error(
      `No OAuth mock config for connector type "${type}". ` +
        `Supported: ${Object.keys(OAUTH_PROVIDER_MOCKS).join(", ")}`,
    );
  }

  // Stub OAuth client env vars if the provider needs them
  for (const [key, value] of Object.entries(providerMock.envVars)) {
    vi.stubEnv(key, value);
  }
  reloadEnv();

  // Set up MSW handlers for token exchange + user info
  server.use(
    mswHttp.post(providerMock.tokenUrl, () => {
      return HttpResponse.json(providerMock.buildTokenResponse(accessToken));
    }),
    mswHttp[providerMock.userMethod ?? "get"](providerMock.userUrl, () => {
      return HttpResponse.json(
        providerMock.buildUserResponse({
          username: options?.externalUsername ?? "testuser",
        }),
      );
    }),
  );

  // Create callback request with proper cookies
  const state = "test-oauth-state";
  const url = new URL(`http://localhost:3000/api/connectors/${type}/callback`);
  url.searchParams.set("code", "test-code");
  url.searchParams.set("state", state);

  const request = createTestRequest(url.toString(), {
    headers: { Cookie: `connector_oauth_state=${state}` },
  });
  const response = await connectorCallbackRoute(request, {
    params: Promise.resolve({ type }),
  });

  // Callback redirects to /connector/success on success
  const location = response.headers.get("location") ?? "";
  if (!location.includes("/connector/success")) {
    throw new Error(
      `OAuth callback failed: status=${response.status} location=${location}`,
    );
  }
}

/**
 * Create a test connector via API routes.
 *
 * - api-token: calls POST /api/connectors/:type/token
 * - oauth: calls GET /api/connectors/:type/callback with MSW mocks
 *
 * @param options - Connector configuration
 */
export async function createTestConnector(options?: {
  type?: ConnectorType;
  authMethod?: "oauth" | "api-token";
  accessToken?: string;
  /** Secret name for api-token (e.g. "FIGMA_TOKEN"). Required for api-token. */
  secretName?: string;
  externalUsername?: string;
  externalId?: string | null;
  externalEmail?: string | null;
  oauthScopes?: string[];
  userId?: string;
}): Promise<void> {
  const authMethod = options?.authMethod ?? "oauth";

  if (authMethod === "api-token") {
    await createTestApiTokenConnector(options);
  } else {
    await createTestOAuthConnector(options);
  }
}
