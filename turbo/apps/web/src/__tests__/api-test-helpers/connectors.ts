import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { http as mswHttp, HttpResponse } from "msw";
import type { ConnectorType } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import { connectors } from "../../db/schema/connector";
import { connectorSessions } from "../../db/schema/connector-session";
import { secrets } from "../../db/schema/secret";
import { userConnectors } from "../../db/schema/user-connector";
import {
  encryptSecretValue,
  decryptSecretValue,
} from "../../lib/shared/crypto/secrets-encryption";
import { server } from "../../mocks/server";
import { reloadEnv } from "../../env";
import { GET as connectorCallbackRoute } from "../../../app/api/connectors/[type]/callback/route";
import { POST as setSecretRoute } from "../../../app/api/zero/secrets/route";
import { createTestRequest } from "./core";

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

/**
 * Grant a user permission to use a connector for a specific agent.
 * Inserts into the user_connectors table (sparse: presence = enabled).
 */
export async function createTestUserConnector(
  orgId: string,
  userId: string,
  agentId: string,
  connectorType: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(userConnectors)
    .values({ orgId, userId, agentId, connectorType })
    .onConflictDoNothing();
}

/**
 * Find and decrypt a connector secret token from the database.
 * Used for verifying that the correct token was stored during connector OAuth flow.
 *
 * @param orgId - The org ID to look up the secret for
 * @param secretName - The secret name (e.g. "SLACK_ACCESS_TOKEN")
 * @returns The decrypted token value, or undefined if not found
 */
export async function findTestConnectorSecret(
  orgId: string,
  secretName: string,
  type: "connector" | "user" = "connector",
): Promise<string | undefined> {
  const [storedSecret] = await globalThis.services.db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.name, secretName),
        eq(secrets.type, type),
      ),
    )
    .limit(1);

  if (!storedSecret) return undefined;

  return decryptSecretValue(
    storedSecret.encryptedValue,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
}

/**
 * Get the tokenExpiresAt timestamp for a connector.
 * Used for verifying that token expiry was correctly stored during OAuth flow.
 *
 * @param orgId - The org ID
 * @param type - The connector type (e.g. "notion", "github")
 * @returns The tokenExpiresAt Date, or null if not set, or undefined if connector not found
 */
export async function findTestConnectorTokenExpiresAt(
  orgId: string,
  type: string,
): Promise<Date | null | undefined> {
  const [row] = await globalThis.services.db
    .select({ tokenExpiresAt: connectors.tokenExpiresAt })
    .from(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.type, type)))
    .limit(1);

  if (!row) return undefined;
  return row.tokenExpiresAt;
}

/**
 * Insert an encrypted connector secret into the database.
 * Used for setting up test state (e.g., access tokens, refresh tokens) without going through the OAuth flow.
 */
export async function insertTestConnectorSecret(
  orgId: string,
  userId: string,
  name: string,
  value: string,
): Promise<void> {
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  await globalThis.services.db.insert(secrets).values({
    name,
    encryptedValue: encryptSecretValue(value, encryptionKey),
    type: "connector",
    userId,
    orgId,
  });
}

/**
 * Generate a unique session code for testing (format: XXXX-XXXX, max 9 chars)
 */
function generateTestSessionCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Create a test connector session directly in the database.
 * Used for setting up test data for session status tests.
 *
 * @param userId - The user ID to associate with the session
 * @param type - The connector type
 * @param options - Session configuration options
 */
export async function createTestConnectorSession(
  userId: string,
  type: ConnectorType,
  options?: {
    status?: "pending" | "complete" | "error";
    errorMessage?: string;
    expiresAt?: Date;
    completedAt?: Date;
  },
): Promise<typeof connectorSessions.$inferSelect> {
  const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000); // 15 minutes default

  const [session] = await globalThis.services.db
    .insert(connectorSessions)
    .values({
      code: generateTestSessionCode(),
      type,
      userId,
      status: options?.status ?? "pending",
      errorMessage: options?.errorMessage,
      expiresAt,
      completedAt: options?.completedAt,
    })
    .returning();

  return session!;
}
