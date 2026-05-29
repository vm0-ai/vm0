import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { z } from "zod";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  CONNECTOR_TYPES,
  CONNECTOR_TYPE_KEYS,
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorInvalidDefaultAuthMethodType,
  type ConnectorManualGrantFieldConfig,
  type ConnectorType,
  type AuthCodeGrantConnectorType,
} from "../connectors";
import {
  connectorAuthMethodSupportsTokenRevoke,
  connectorAuthMethodHasGrantKind,
  getAvailableConnectorAuthMethods,
  getConnectorAuthMethodGrantScopes,
  getConnectorAuthMethodIdForGrantKind,
  getConnectorAuthMethodScopeDiff,
  getConfiguredConnectorAuthMethods,
  hasRequiredScopes,
  hasRequiredConnectorAuthMethodScopes,
  getConnectorAuthCodeGrantConfig,
  getConnectorAuthMethodAccessMetadata,
  resolveConnectorAuthClientForMethod,
  getConnectorAuthMethodEnvBindings,
  getConnectorAuthMethod,
  getConnectorDeviceAuthGrantConfig,
  getConnectorTypeForSecretName,
  getConnectorEnvBindings,
  getConnectorOAuthScopes,
  getConnectorManualGrantFieldNames,
  getRuntimeAvailableConnectorTypes,
  getConnectorSecretNames,
  getConnectorVariableNames,
  hasConnectorAuthCodeGrant,
  hasConnectorDeviceAuthGrant,
  isStaticConfidentialConnectorAuthClient,
  isStaticConnectorAuthClient,
  isGoogleOAuthConnector,
  type ConnectorEnvReader,
} from "../connector-utils";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  buildConnectorAuthCodeAuthorizationUrl,
  getConnectorAuthProviderClientArgs,
  hasConnectorAuthCodeGrantProvider,
  hasConnectorDeviceAuthGrantProvider,
  getConnectorAuthProviderSecretMetadata,
  pollConnectorDeviceAuthorization,
  refreshConnectorAuthProviderAccessToken,
  revokeConnectorAuthProviderAccessToken,
  startConnectorDeviceAuthorization,
} from "../auth-providers/connector-auth";
import { GOOGLE_OAUTH_CONNECTOR_TYPES } from "../auth-providers/oauth/google-connectors";
import { buildGoogleAuthorizationUrl } from "../auth-providers/oauth/google";
import { getConnectorFirewall } from "../firewalls";

function getApiTokenManualGrantFields(
  type: ConnectorType,
): Record<string, ConnectorManualGrantFieldConfig> | undefined {
  const method = getConnectorAuthMethod(type, "api-token");
  if (method?.grant.kind !== "manual") {
    return undefined;
  }
  return method.grant.fields;
}

function hasConnectorAuthorizationGrant(type: ConnectorType): boolean {
  return hasConnectorAuthCodeGrant(type) || hasConnectorDeviceAuthGrant(type);
}

const server = setupServer();
const SLOCK_ACCESS_TOKEN_TTL_SECONDS = 900;

function getOauthAuthClient(type: ConnectorType, readEnv: ConnectorEnvReader) {
  return resolveConnectorAuthClientForMethod(type, "oauth", readEnv);
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function jwtAccessToken(subject: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  };
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      sub: subject,
      type: "access",
      iat: issuedAt,
      exp: issuedAt + SLOCK_ACCESS_TOKEN_TTL_SECONDS,
    }),
    "signature",
  ].join(".");
}

const EXPECTED_PROVIDER_AUTHORIZATION_BASE_URLS = {
  ahrefs: "https://app.ahrefs.com/api/auth",
  airtable: "https://airtable.com/oauth2/v1/authorize",
  asana: "https://app.asana.com/-/oauth_authorize",
  canva: "https://www.canva.com/api/oauth/authorize",
  close: "https://app.close.com/oauth2/authorize/",
  deel: "https://app.deel.com/oauth2/authorize",
  docusign: "https://account-d.docusign.com/oauth/auth",
  dropbox: "https://www.dropbox.com/oauth2/authorize",
  figma: "https://www.figma.com/oauth",
  "garmin-connect": "https://connect.garmin.com/oauth2Confirm",
  github: "https://github.com/login/oauth/authorize",
  gmail: "https://accounts.google.com/o/oauth2/v2/auth",
  "google-ads": "https://accounts.google.com/o/oauth2/v2/auth",
  "google-calendar": "https://accounts.google.com/o/oauth2/v2/auth",
  "google-docs": "https://accounts.google.com/o/oauth2/v2/auth",
  "google-drive": "https://accounts.google.com/o/oauth2/v2/auth",
  "google-meet": "https://accounts.google.com/o/oauth2/v2/auth",
  "google-sheets": "https://accounts.google.com/o/oauth2/v2/auth",
  gumroad: "https://gumroad.com/oauth/authorize",
  hubspot: "https://app.hubspot.com/oauth/authorize",
  "intervals-icu": "https://intervals.icu/oauth/authorize",
  linear: "https://linear.app/oauth/authorize",
  mailchimp: "https://login.mailchimp.com/oauth2/authorize",
  mercury: "https://oauth2.mercury.com/oauth2/auth",
  "meta-ads": "https://www.facebook.com/v22.0/dialog/oauth",
  monday: "https://auth.monday.com/oauth2/authorize",
  neon: "https://oauth2.neon.tech/oauth2/auth",
  notion: "https://api.notion.com/v1/oauth/authorize",
  "outlook-calendar":
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  "outlook-mail":
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  posthog: "https://us.posthog.com/oauth/authorize",
  reddit: "https://www.reddit.com/api/v1/authorize",
  sentry: "https://sentry.io/oauth/authorize/",
  slack: "https://slack.com/oauth/v2/authorize",
  spotify: "https://accounts.spotify.com/authorize",
  strava: "https://www.strava.com/oauth/authorize",
  stripe: "https://connect.stripe.com/oauth/authorize",
  supabase: "https://api.supabase.com/v1/oauth/authorize",
  "test-oauth": "https://api.test/api/test/oauth-provider/authorize",
  todoist: "https://todoist.com/oauth/authorize",
  vercel: "https://vercel.com/integrations/test-integration/new",
  webflow: "https://webflow.com/oauth/authorize",
  x: "https://x.com/i/oauth2/authorize",
  xero: "https://login.xero.com/identity/connect/authorize",
  zoom: "https://zoom.us/oauth/authorize",
} as const satisfies Record<AuthCodeGrantConnectorType, string>;

function authorizationBaseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

const manualAuthMethodConfig = {
  label: "API Token",
  helpText: "Enter an API token.",
  grant: {
    kind: "manual",
    fields: {
      API_TOKEN: {
        label: "Token",
        required: true,
      },
    },
  },
  access: {
    kind: "static",
    envBindings: {
      API_TOKEN: "$secrets.API_TOKEN",
    },
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodConfig;

const connectorAuthMethodFixture = {
  "connector-auth-method-fixture": {
    label: "Connector Auth Method Fixture",
    category: "data-automation-infrastructure",
    helpText: "Fixture used for connector auth method type coverage.",
    authMethods: {
      "api-token": manualAuthMethodConfig,
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;

type ConnectorConfigAuthMethodIds<Config extends ConnectorConfig> = Extract<
  keyof Config["authMethods"],
  string
>;

describe("hasRequiredScopes", () => {
  it("returns true for non-OAuth connector type", () => {
    expect(hasRequiredScopes("cloudinary", null)).toBe(true);
    expect(
      hasRequiredConnectorAuthMethodScopes("cloudinary", "api-token", null),
    ).toBe(true);
  });

  it("returns true when connector has empty required scopes", () => {
    // notion has scopes: []
    expect(hasRequiredScopes("notion", null)).toBe(true);
    expect(hasRequiredScopes("notion", [])).toBe(true);
    expect(hasRequiredScopes("notion", ["some-scope"])).toBe(true);
  });

  it("returns false when storedScopes is null", () => {
    // github requires ["repo"]
    expect(hasRequiredScopes("github", null)).toBe(false);
  });

  it("returns false when required scope is missing", () => {
    expect(hasRequiredScopes("github", [])).toBe(false);
    expect(hasRequiredScopes("github", ["read:org"])).toBe(false);
    expect(hasRequiredScopes("github", ["repo"])).toBe(false);
    // tokens without "workflow" scope (e.g. pre-existing tokens) must reconnect
    expect(hasRequiredScopes("github", ["repo", "project"])).toBe(false);
  });

  it("returns true when all required scopes are present", () => {
    expect(hasRequiredScopes("github", ["repo", "project", "workflow"])).toBe(
      true,
    );
  });

  it("returns true when stored scopes are a superset of required", () => {
    expect(
      hasRequiredScopes("github", [
        "repo",
        "project",
        "workflow",
        "read:org",
        "user",
      ]),
    ).toBe(true);
  });

  it("checks required scopes from the selected auth method grant", () => {
    expect(getConnectorAuthMethodIdForGrantKind("github", "auth-code")).toBe(
      "oauth",
    );
    expect(
      getConnectorAuthMethodIdForGrantKind("test-oauth-device", "device-auth"),
    ).toBe("oauth");
    expect(getConnectorAuthMethodIdForGrantKind("stripe", "manual")).toBe(
      "api-token",
    );
    expect(
      getConnectorAuthMethodIdForGrantKind("github", "manual"),
    ).toBeUndefined();

    expect(
      connectorAuthMethodHasGrantKind("github", "oauth", "auth-code"),
    ).toBe(true);
    expect(getConnectorAuthMethodGrantScopes("github", "oauth")).toStrictEqual([
      "repo",
      "project",
      "workflow",
    ]);
    expect(hasRequiredConnectorAuthMethodScopes("github", "oauth", null)).toBe(
      false,
    );
    expect(
      hasRequiredConnectorAuthMethodScopes("github", "oauth", [
        "repo",
        "project",
        "workflow",
      ]),
    ).toBe(true);
    expect(
      hasRequiredConnectorAuthMethodScopes("test-oauth-device", "oauth", []),
    ).toBe(false);
    expect(
      hasRequiredConnectorAuthMethodScopes("test-oauth-device", "oauth", [
        "read",
      ]),
    ).toBe(true);
  });

  it("does not require OAuth scopes for selected manual grants", () => {
    expect(
      connectorAuthMethodHasGrantKind("stripe", "api-token", "manual"),
    ).toBe(true);
    expect(
      getConnectorAuthMethodGrantScopes("stripe", "api-token"),
    ).toStrictEqual([]);
    expect(
      hasRequiredConnectorAuthMethodScopes("stripe", "api-token", null),
    ).toBe(true);
    expect(
      getConnectorAuthMethodScopeDiff("stripe", "api-token", null),
    ).toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });
  });
});

describe("connector auth method config", () => {
  it("keeps connector auth method ids explicit and typed", () => {
    type FixtureConfig =
      (typeof connectorAuthMethodFixture)["connector-auth-method-fixture"];

    expectTypeOf<ConnectorAuthMethodId>().toEqualTypeOf<
      "oauth" | "api-token" | "api"
    >();
    expectTypeOf<"app-credential">().not.toMatchTypeOf<ConnectorAuthMethodId>();
    expectTypeOf<"app-credential">().not.toMatchTypeOf<
      keyof ConnectorConfig["authMethods"]
    >();
    expectTypeOf<"app-credential">().not.toMatchTypeOf<
      ConnectorConfig["defaultAuthMethod"]
    >();
    expectTypeOf<
      ConnectorConfigAuthMethodIds<FixtureConfig>
    >().toEqualTypeOf<"api-token">();
    expectTypeOf<
      FixtureConfig["defaultAuthMethod"]
    >().toEqualTypeOf<"api-token">();
    expectTypeOf<
      ConnectorInvalidDefaultAuthMethodType<typeof connectorAuthMethodFixture>
    >().toEqualTypeOf<never>();

    const missingDefaultMethodFixture = {
      "missing-default-method-fixture": {
        label: "Missing Default Method Fixture",
        category: "data-automation-infrastructure",
        helpText: "Fixture used for connector auth method type coverage.",
        authMethods: {
          "api-token": manualAuthMethodConfig,
        },
        defaultAuthMethod: "oauth",
      },
    } as const satisfies Record<string, ConnectorConfig>;
    expectTypeOf<
      ConnectorInvalidDefaultAuthMethodType<typeof missingDefaultMethodFixture>
    >().toEqualTypeOf<"missing-default-method-fixture">();
  });

  it("returns a single auth method config when present", () => {
    expect(getConnectorAuthMethod("stripe", "api-token")?.label).toBe(
      "API Key",
    );
    expect(getConnectorAuthMethod("github", "api-token")).toBeUndefined();
  });

  it("groups all manual grant field names by storage", () => {
    expect(getConnectorManualGrantFieldNames("atlassian")).toStrictEqual({
      secrets: ["ATLASSIAN_TOKEN"],
      variables: ["ATLASSIAN_EMAIL", "ATLASSIAN_DOMAIN"],
    });
    expect(getConnectorManualGrantFieldNames("gitlab")).toStrictEqual({
      secrets: ["GITLAB_TOKEN"],
      variables: ["GITLAB_HOST"],
    });
    expect(getConnectorManualGrantFieldNames("github")).toBeNull();
  });

  it("keeps connector-scoped secret and variable names globally unique", () => {
    const secretOwners = new Map<string, string[]>();
    const variableOwners = new Map<string, string[]>();

    for (const type of CONNECTOR_TYPE_KEYS) {
      for (const authMethod of Object.keys(CONNECTOR_TYPES[type].authMethods)) {
        for (const name of getConnectorSecretNames(type, authMethod)) {
          secretOwners.set(name, [
            ...(secretOwners.get(name) ?? []),
            `${type}:${authMethod}`,
          ]);
        }
        for (const name of getConnectorVariableNames(type, authMethod)) {
          variableOwners.set(name, [
            ...(variableOwners.get(name) ?? []),
            `${type}:${authMethod}`,
          ]);
        }
      }
    }

    const duplicateSecrets = [...secretOwners].filter(([, owners]) => {
      return owners.length > 1;
    });
    const duplicateVariables = [...variableOwners].filter(([, owners]) => {
      return owners.length > 1;
    });

    expect(duplicateSecrets).toStrictEqual([]);
    expect(duplicateVariables).toStrictEqual([]);
  });
});

describe("connector grant provider capability checks", () => {
  it("matches exactly the connector types that declare auth-code and device-auth grants", () => {
    const authCodeGrantTypes = new Set<ConnectorType>(
      connectorTypeSchema.options.filter(hasConnectorAuthCodeGrant),
    );
    const deviceAuthGrantTypes = new Set<ConnectorType>(
      connectorTypeSchema.options.filter(hasConnectorDeviceAuthGrant),
    );

    for (const type of connectorTypeSchema.options) {
      expect(hasConnectorAuthCodeGrantProvider(type)).toBe(
        authCodeGrantTypes.has(type),
      );
      expect(hasConnectorDeviceAuthGrantProvider(type)).toBe(
        deviceAuthGrantTypes.has(type),
      );
    }
  });

  it("detects token revoke support from provider capability", () => {
    expect(connectorAuthMethodSupportsTokenRevoke("github", "oauth")).toBe(
      true,
    );
    expect(connectorAuthMethodSupportsTokenRevoke("notion", "oauth")).toBe(
      false,
    );
    expect(connectorAuthMethodSupportsTokenRevoke("stripe", "api-token")).toBe(
      false,
    );
  });

  it("exposes connector OAuth secret metadata without provider access", () => {
    expect(getConnectorAuthProviderSecretMetadata("test-oauth")).toEqual({
      accessSecretName: "TEST_OAUTH_ACCESS_TOKEN",
      refreshSecretName: "TEST_OAUTH_REFRESH_TOKEN",
      isRefreshable: true,
    });
    expect(getConnectorAuthProviderSecretMetadata("github")).toEqual({
      accessSecretName: "GITHUB_ACCESS_TOKEN",
      isRefreshable: false,
    });
  });

  it("rejects refresh for OAuth connectors without refresh-token access", async () => {
    const oauthClient = getOauthAuthClient("github", (name) => {
      if (name === "GH_OAUTH_CLIENT_ID") {
        return "test-github-client";
      }
      if (name === "GH_OAUTH_CLIENT_SECRET") {
        return "test-github-secret";
      }
      return undefined;
    });
    expect(oauthClient).toBeDefined();

    if (!oauthClient) {
      throw new Error("Expected github OAuth client");
    }

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "github",
        clientArgs: getConnectorAuthProviderClientArgs(oauthClient),
        refreshToken: "refresh-token",
      }),
    ).rejects.toThrow("github connector does not support token refresh");
  });

  it("revokes OAuth tokens through the provider registry", async () => {
    const oauthClient = getOauthAuthClient("github", (name) => {
      if (name === "GH_OAUTH_CLIENT_ID") {
        return "test-github-client";
      }
      if (name === "GH_OAUTH_CLIENT_SECRET") {
        return "test-github-secret";
      }
      return undefined;
    });
    expect(oauthClient).toBeDefined();

    if (!oauthClient) {
      throw new Error("Expected github OAuth client");
    }

    let authorization: string | null = null;
    let body = "";
    server.use(
      http.delete(
        "https://api.github.com/applications/test-github-client/grant",
        async ({ request }) => {
          authorization = request.headers.get("authorization");
          body = await request.text();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    await expect(
      revokeConnectorAuthProviderAccessToken({
        type: "github",
        authClient: oauthClient,
        loadAccessToken: () => {
          return "gh-access-token";
        },
      }),
    ).resolves.toStrictEqual({ status: "revoked" });
    expect(authorization).toBe(
      `Basic ${btoa("test-github-client:test-github-secret")}`,
    );
    expect(body).toBe(JSON.stringify({ access_token: "gh-access-token" }));
  });

  it("returns unsupported for OAuth connectors without revoke support", async () => {
    const oauthClient = getOauthAuthClient("notion", (name) => {
      if (name === "NOTION_OAUTH_CLIENT_ID") {
        return "test-notion-client";
      }
      if (name === "NOTION_OAUTH_CLIENT_SECRET") {
        return "test-notion-secret";
      }
      return undefined;
    });
    expect(oauthClient).toBeDefined();

    if (!oauthClient) {
      throw new Error("Expected notion OAuth client");
    }

    let loadedAccessToken = false;

    await expect(
      revokeConnectorAuthProviderAccessToken({
        type: "notion",
        authClient: oauthClient,
        loadAccessToken: () => {
          loadedAccessToken = true;
          return "notion-access-token";
        },
      }),
    ).resolves.toStrictEqual({ status: "unsupported" });
    expect(loadedAccessToken).toBe(false);
  });

  it("builds the expected authorization URL base for every OAuth provider", async () => {
    const previousEnv = {
      VM0_API_URL: process.env.VM0_API_URL,
      VERCEL_INTEGRATION_SLUG: process.env.VERCEL_INTEGRATION_SLUG,
    };

    process.env.VM0_API_URL = "https://api.test";
    process.env.VERCEL_INTEGRATION_SLUG = "test-integration";

    try {
      const providerTypes = connectorTypeSchema.options.filter(
        hasConnectorAuthCodeGrant,
      );

      for (const type of providerTypes) {
        const oauthClient = getOauthAuthClient(type, () => {
          return "test-client-credential";
        });
        expect(oauthClient, `${type}: OAuth client`).toBeDefined();
        if (!oauthClient) {
          throw new Error(`${type} OAuth client not found`);
        }
        const authResult = await buildConnectorAuthCodeAuthorizationUrl({
          type,
          authClient: oauthClient,
          redirectUri: "https://app.test/callback",
          state: "state-123",
        });
        const authorizationUrl =
          typeof authResult === "string" ? authResult : authResult.url;

        expect(authorizationBaseUrl(authorizationUrl), `${type}`).toBe(
          EXPECTED_PROVIDER_AUTHORIZATION_BASE_URLS[type],
        );
      }
    } finally {
      restoreEnv(previousEnv);
    }
  });

  it("starts and polls the test OAuth device provider", async () => {
    server.use(
      http.post(
        /\/api\/test\/oauth-provider\/device\/code$/,
        async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          return HttpResponse.json({
            device_code: `test-device:${body.get("client_id")}:${body.get("scope")}`,
            user_code: "TEST-DEVICE",
            verification_uri: "https://oauth-device.test/device",
            verification_uri_complete:
              "https://oauth-device.test/device?user_code=TEST-DEVICE",
            expires_in: 600,
            interval: 0,
          });
        },
      ),
      http.post(/\/api\/test\/oauth-provider\/token$/, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        const deviceCode = body.get("device_code");
        if (deviceCode === "pending") {
          return HttpResponse.json(
            { error: "authorization_pending" },
            { status: 400 },
          );
        }
        if (deviceCode === "slow-down") {
          return HttpResponse.json({ error: "slow_down" }, { status: 400 });
        }
        if (deviceCode === "denied") {
          return HttpResponse.json(
            {
              error: "access_denied",
              error_description: "User denied the device authorization request",
            },
            { status: 400 },
          );
        }
        if (deviceCode === "expired") {
          return HttpResponse.json(
            {
              error: "expired_token",
              error_description: "Device authorization expired",
            },
            { status: 400 },
          );
        }
        if (deviceCode === "error") {
          return HttpResponse.json(
            {
              error: "invalid_request",
              error_description: "Synthetic device authorization error",
            },
            { status: 400 },
          );
        }
        if (!deviceCode?.startsWith(`test-device:${body.get("client_id")}:`)) {
          return HttpResponse.json(
            {
              error: "invalid_grant",
              error_description: "Unknown device authorization code",
            },
            { status: 400 },
          );
        }

        return HttpResponse.json({
          access_token: `test-device-access:${body.get("client_id")}:${deviceCode}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read",
        });
      }),
    );

    const oauthClient = getOauthAuthClient("test-oauth-device", () => {
      return undefined;
    });
    expect(oauthClient).toBeDefined();

    if (!oauthClient) {
      throw new Error("Expected test-oauth-device OAuth client");
    }

    const startResult = await startConnectorDeviceAuthorization({
      type: "test-oauth-device",
      authClient: oauthClient,
    });
    expect(startResult).toStrictEqual({
      deviceCode: "test-device:test-oauth-device-client:read",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
      verificationUriComplete:
        "https://oauth-device.test/device?user_code=TEST-DEVICE",
      expiresIn: 600,
      interval: 0,
    });

    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authClient: oauthClient,
        deviceCode: "pending",
      }),
    ).resolves.toStrictEqual({ status: "pending" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authClient: oauthClient,
        deviceCode: "slow-down",
      }),
    ).resolves.toStrictEqual({ status: "slow_down" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authClient: oauthClient,
        deviceCode: "denied",
      }),
    ).resolves.toStrictEqual({
      status: "denied",
      error: "access_denied",
      errorDescription: "User denied the device authorization request",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authClient: oauthClient,
        deviceCode: "expired",
      }),
    ).resolves.toStrictEqual({
      status: "expired",
      error: "expired_token",
      errorDescription: "Device authorization expired",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authClient: oauthClient,
        deviceCode: "error",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "invalid_request",
      errorDescription: "Synthetic device authorization error",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authClient: oauthClient,
        deviceCode: "invalid-grant",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "invalid_grant",
      errorDescription: "Unknown device authorization code",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authClient: oauthClient,
        deviceCode: startResult.deviceCode,
      }),
    ).resolves.toStrictEqual({
      status: "complete",
      token: {
        accessToken:
          "test-device-access:test-oauth-device-client:test-device:test-oauth-device-client:read",
        expiresIn: 3600,
        refreshToken: null,
        scopes: ["read"],
        userInfo: {
          id: "test-oauth-device-user",
          username: "test-oauth-device-user",
          email: "test-oauth-device@example.com",
        },
      },
    });
  });

  it("starts, polls, and refreshes the Base44 OAuth device provider", async () => {
    server.use(
      http.post(
        "https://app.base44.com/oauth/device/code",
        async ({ request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            client_id: "base44_cli",
            scope: "apps:read apps:write offline",
          });
          return HttpResponse.json({
            device_code: "base44-device-code",
            user_code: "BASE-44",
            verification_uri: "https://app.base44.com/device",
            verification_uri_complete:
              "https://app.base44.com/device?user_code=BASE-44",
            expires_in: 600,
            interval: 5,
          });
        },
      ),
      http.post("https://app.base44.com/oauth/token", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") === "refresh_token") {
          expect(body.get("client_id")).toBe("base44_cli");
          if (body.get("refresh_token") === "base44-refresh-rotation") {
            return HttpResponse.json({
              access_token: "base44-access-refreshed",
              refresh_token: "base44-refresh-rotated",
              expires_in: 3600,
            });
          }
          return HttpResponse.json({
            access_token: "base44-access-refreshed",
            expires_in: 3600,
          });
        }

        expect(body.get("grant_type")).toBe(
          "urn:ietf:params:oauth:grant-type:device_code",
        );
        expect(body.get("client_id")).toBe("base44_cli");
        const deviceCode = body.get("device_code");
        if (deviceCode === "pending") {
          return HttpResponse.json(
            { error: "authorization_pending" },
            { status: 400 },
          );
        }
        if (deviceCode === "slow-down") {
          return HttpResponse.json({ error: "slow_down" }, { status: 400 });
        }
        if (deviceCode === "denied") {
          return HttpResponse.json(
            {
              error: "access_denied",
              error_description: "User denied Base44 access",
            },
            { status: 400 },
          );
        }
        if (deviceCode === "expired") {
          return HttpResponse.json(
            {
              error: "expired_token",
              error_description: "Base44 device authorization expired",
            },
            { status: 400 },
          );
        }
        if (deviceCode === "temporarily-unavailable") {
          return HttpResponse.json(
            {
              error: "temporarily_unavailable",
              error_description: "Base44 is temporarily unavailable",
            },
            { status: 400 },
          );
        }

        return HttpResponse.json({
          access_token: "base44-access-token",
          refresh_token: "base44-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "apps:read apps:write offline",
        });
      }),
      http.get("https://app.base44.com/oauth/userinfo", ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer base44-access-token",
        );
        return HttpResponse.json({
          sub: "base44-user-id",
          name: "Base44 User",
          email: "base44@example.com",
        });
      }),
    );

    const oauthClient = getOauthAuthClient("base44", () => {
      return undefined;
    });
    expect(oauthClient).toBeDefined();

    if (!oauthClient) {
      throw new Error("Expected base44 OAuth client");
    }

    await expect(
      startConnectorDeviceAuthorization({
        type: "base44",
        authClient: oauthClient,
      }),
    ).resolves.toStrictEqual({
      deviceCode: "base44-device-code",
      userCode: "BASE-44",
      verificationUri: "https://app.base44.com/device",
      verificationUriComplete:
        "https://app.base44.com/device?user_code=BASE-44",
      expiresIn: 600,
      interval: 5,
    });

    await expect(
      pollConnectorDeviceAuthorization({
        type: "base44",
        authClient: oauthClient,
        deviceCode: "pending",
      }),
    ).resolves.toStrictEqual({ status: "pending" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "base44",
        authClient: oauthClient,
        deviceCode: "slow-down",
      }),
    ).resolves.toStrictEqual({ status: "slow_down" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "base44",
        authClient: oauthClient,
        deviceCode: "denied",
      }),
    ).resolves.toStrictEqual({
      status: "denied",
      error: "access_denied",
      errorDescription: "User denied Base44 access",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "base44",
        authClient: oauthClient,
        deviceCode: "expired",
      }),
    ).resolves.toStrictEqual({
      status: "expired",
      error: "expired_token",
      errorDescription: "Base44 device authorization expired",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "base44",
        authClient: oauthClient,
        deviceCode: "temporarily-unavailable",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "temporarily_unavailable",
      errorDescription: "Base44 is temporarily unavailable",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "base44",
        authClient: oauthClient,
        deviceCode: "base44-device-code",
      }),
    ).resolves.toStrictEqual({
      status: "complete",
      token: {
        accessToken: "base44-access-token",
        refreshToken: "base44-refresh-token",
        expiresIn: 3600,
        scopes: ["apps:read", "apps:write", "offline"],
        userInfo: {
          id: "base44-user-id",
          username: "Base44 User",
          email: "base44@example.com",
        },
      },
    });

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "base44",
        clientArgs: getConnectorAuthProviderClientArgs(oauthClient),
        refreshToken: "base44-refresh-rotation",
      }),
    ).resolves.toStrictEqual({
      accessToken: "base44-access-refreshed",
      refreshToken: "base44-refresh-rotated",
      expiresIn: 3600,
    });
    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "base44",
        clientArgs: getConnectorAuthProviderClientArgs(oauthClient),
        refreshToken: "base44-refresh-without-rotation",
      }),
    ).resolves.toStrictEqual({
      accessToken: "base44-access-refreshed",
      refreshToken: null,
      expiresIn: 3600,
    });
  });

  it("starts, polls, and refreshes the Slock OAuth device provider", async () => {
    const slockAccessToken = jwtAccessToken("slock-user-id");
    const slockRefreshedAccessToken = jwtAccessToken("slock-user-id");
    const slockMalformedAccessToken = "slock-access-malformed";
    server.use(
      http.post(
        "https://api.slock.ai/api/auth/device/authorize",
        async ({ request }) => {
          await expect(request.json()).resolves.toStrictEqual({});
          return HttpResponse.json({
            deviceCode: "slock-device-code",
            userCode: "SLOCK-1",
            verificationUri: "/device",
            interval: 5,
          });
        },
      ),
      http.post(
        "https://api.slock.ai/api/auth/device/token",
        async ({ request }) => {
          const body = await request.json();
          const deviceCode = z
            .object({ deviceCode: z.string() })
            .parse(body).deviceCode;
          expect(body).toStrictEqual({ deviceCode });
          if (deviceCode === "pending") {
            return HttpResponse.json(
              {
                code: "authorization_pending",
                message: "Still waiting for user approval",
              },
              { status: 400 },
            );
          }
          if (deviceCode === "denied") {
            return HttpResponse.json(
              {
                code: "access_denied",
                message: "User denied Slock access",
              },
              { status: 400 },
            );
          }
          if (deviceCode === "expired") {
            return HttpResponse.json(
              {
                code: "expired_token",
                message: "Slock device authorization expired",
              },
              { status: 400 },
            );
          }
          if (deviceCode === "no-servers") {
            return HttpResponse.json({
              accessToken: "slock-access-no-servers",
              refreshToken: "slock-refresh-no-servers",
              userId: "slock-user-id",
            });
          }
          if (deviceCode === "missing-refresh") {
            return HttpResponse.json({
              accessToken: "slock-access-missing-refresh",
              userId: "slock-user-id",
            });
          }
          if (deviceCode === "server-error") {
            return HttpResponse.json({
              accessToken: "slock-access-server-error",
              refreshToken: "slock-refresh-server-error",
              userId: "slock-user-id",
            });
          }
          if (deviceCode === "userinfo-error") {
            return HttpResponse.json({
              accessToken: "slock-access-userinfo-error",
              refreshToken: "slock-refresh-userinfo-error",
              userId: "slock-user-id",
            });
          }
          if (deviceCode === "malformed-token") {
            return HttpResponse.json({
              accessToken: slockMalformedAccessToken,
              refreshToken: "slock-refresh-malformed",
              userId: "slock-user-id",
            });
          }
          return HttpResponse.json({
            accessToken: slockAccessToken,
            refreshToken: "slock-refresh-token",
            userId: "slock-user-id",
          });
        },
      ),
      http.get("https://api.slock.ai/api/servers", ({ request }) => {
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer slock-access-no-servers") {
          return HttpResponse.json([]);
        }
        if (authorization === "Bearer slock-access-server-error") {
          return HttpResponse.json(
            { code: "server_lookup_failed" },
            { status: 500 },
          );
        }
        if (authorization !== "Bearer slock-access-userinfo-error") {
          expect([
            `Bearer ${slockAccessToken}`,
            `Bearer ${slockMalformedAccessToken}`,
          ]).toContain(authorization);
        }
        return HttpResponse.json({
          currentServerId: "slock-server-primary",
          servers: [
            {
              id: "slock-server-secondary",
              name: "Secondary",
            },
            {
              id: "slock-server-primary",
              name: "Primary",
            },
          ],
        });
      }),
      http.get("https://api.slock.ai/api/auth/me", ({ request }) => {
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer slock-access-userinfo-error") {
          return HttpResponse.json(
            { code: "userinfo_lookup_failed" },
            { status: 500 },
          );
        }
        expect([
          `Bearer ${slockAccessToken}`,
          `Bearer ${slockMalformedAccessToken}`,
        ]).toContain(authorization);
        return HttpResponse.json({
          id: "slock-user-id",
          name: "Slock User",
          email: "slock@example.com",
        });
      }),
      http.post(
        "https://api.slock.ai/api/auth/refresh",
        async ({ request }) => {
          const body = await request.json();
          const refreshToken = z
            .object({ refreshToken: z.string() })
            .parse(body).refreshToken;
          if (refreshToken === "slock-refresh-malformed") {
            return HttpResponse.json({
              accessToken: slockMalformedAccessToken,
              refreshToken: "slock-refresh-malformed-rotated",
            });
          }
          expect(refreshToken).toBe("slock-refresh-token");
          return HttpResponse.json({
            accessToken: slockRefreshedAccessToken,
            refreshToken: "slock-refresh-rotated",
          });
        },
      ),
    );

    const oauthClient = getOauthAuthClient("slock", () => {
      return undefined;
    });
    expect(oauthClient).toBeDefined();

    if (!oauthClient) {
      throw new Error("Expected slock OAuth client");
    }

    await expect(
      startConnectorDeviceAuthorization({
        type: "slock",
        authClient: oauthClient,
      }),
    ).resolves.toStrictEqual({
      deviceCode: "slock-device-code",
      userCode: "SLOCK-1",
      verificationUri: "https://api.slock.ai/device",
      verificationUriComplete: undefined,
      expiresIn: 600,
      interval: 5,
    });

    await expect(
      pollConnectorDeviceAuthorization({
        type: "slock",
        authClient: oauthClient,
        deviceCode: "pending",
      }),
    ).resolves.toStrictEqual({ status: "pending" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "slock",
        authClient: oauthClient,
        deviceCode: "denied",
      }),
    ).resolves.toStrictEqual({
      status: "denied",
      error: "access_denied",
      errorDescription: "User denied Slock access",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "slock",
        authClient: oauthClient,
        deviceCode: "expired",
      }),
    ).resolves.toStrictEqual({
      status: "expired",
      error: "expired_token",
      errorDescription: "Slock device authorization expired",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "slock",
        authClient: oauthClient,
        deviceCode: "no-servers",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "no_servers",
      errorDescription: "No Slock servers found for this account",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "slock",
        authClient: oauthClient,
        deviceCode: "missing-refresh",
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: "token_response_invalid",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "slock",
        authClient: oauthClient,
        deviceCode: "server-error",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "post_token_lookup_failed",
      errorDescription:
        "Unable to load Slock account metadata after authorization.",
    });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "slock",
        authClient: oauthClient,
        deviceCode: "userinfo-error",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "post_token_lookup_failed",
      errorDescription:
        "Unable to load Slock account metadata after authorization.",
    });
    const completeResult = await pollConnectorDeviceAuthorization({
      type: "slock",
      authClient: oauthClient,
      deviceCode: "slock-device-code",
    });
    expect(completeResult).toMatchObject({
      status: "complete",
      token: {
        accessToken: slockAccessToken,
        refreshToken: "slock-refresh-token",
        expiresIn: expect.any(Number),
        scopes: [],
        userInfo: {
          id: "slock-user-id",
          username: "Slock User",
          email: "slock@example.com",
        },
        extraConnectorSecrets: {
          SLOCK_SERVER_ID: "slock-server-primary",
        },
      },
    });
    if (completeResult.status !== "complete") {
      throw new Error("Expected Slock device auth to complete");
    }
    const completeExpiresIn = completeResult.token.expiresIn;
    if (completeExpiresIn === undefined) {
      throw new Error("Expected Slock device auth to derive token expiry");
    }
    expect(completeExpiresIn).toBeGreaterThan(850);
    expect(completeExpiresIn).toBeLessThanOrEqual(
      SLOCK_ACCESS_TOKEN_TTL_SECONDS,
    );

    const malformedCompleteResult = await pollConnectorDeviceAuthorization({
      type: "slock",
      authClient: oauthClient,
      deviceCode: "malformed-token",
    });
    expect(malformedCompleteResult).toMatchObject({
      status: "complete",
      token: {
        accessToken: slockMalformedAccessToken,
        refreshToken: "slock-refresh-malformed",
        expiresIn: undefined,
      },
    });

    const refreshResult = await refreshConnectorAuthProviderAccessToken({
      type: "slock",
      clientArgs: getConnectorAuthProviderClientArgs(oauthClient),
      refreshToken: "slock-refresh-token",
    });
    expect(refreshResult).toStrictEqual({
      accessToken: slockRefreshedAccessToken,
      refreshToken: "slock-refresh-rotated",
      expiresIn: expect.any(Number),
    });
    if (refreshResult.expiresIn === undefined) {
      throw new Error("Expected Slock refresh to derive token expiry");
    }
    expect(refreshResult.expiresIn).toBeGreaterThan(850);
    expect(refreshResult.expiresIn).toBeLessThanOrEqual(
      SLOCK_ACCESS_TOKEN_TTL_SECONDS,
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "slock",
        clientArgs: getConnectorAuthProviderClientArgs(oauthClient),
        refreshToken: "slock-refresh-malformed",
      }),
    ).resolves.toStrictEqual({
      accessToken: slockMalformedAccessToken,
      refreshToken: "slock-refresh-malformed-rotated",
      expiresIn: undefined,
    });
  });
});

describe("getConfiguredConnectorAuthMethods", () => {
  it("returns configured auth methods without feature filtering", () => {
    expect(getConfiguredConnectorAuthMethods("stripe")).toStrictEqual([
      "oauth",
      "api-token",
    ]);
  });
});

describe("getAvailableConnectorAuthMethods", () => {
  it("exposes Stripe API-token auth without CLI auth", () => {
    expect(getAvailableConnectorAuthMethods("stripe", {})).toStrictEqual([
      "api-token",
    ]);
  });

  it("exposes BentoML API-token auth only when its switch is enabled", () => {
    expect(getAvailableConnectorAuthMethods("bentoml", {})).toStrictEqual([]);
    expect(
      getAvailableConnectorAuthMethods("bentoml", {
        [FeatureSwitchKey.BentomlConnector]: true,
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("exposes Base44 OAuth without a feature switch", () => {
    expect(getAvailableConnectorAuthMethods("base44", {})).toStrictEqual([
      "oauth",
    ]);
  });

  it("exposes Slock OAuth without a feature switch", () => {
    expect(getAvailableConnectorAuthMethods("slock", {})).toStrictEqual([
      "oauth",
    ]);
  });

  it("exposes Lark API-token auth only when its switch is enabled", () => {
    expect(getAvailableConnectorAuthMethods("lark", {})).toStrictEqual([]);
    expect(
      getAvailableConnectorAuthMethods("lark", {
        [FeatureSwitchKey.LarkConnector]: true,
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("exposes Doubao API-token auth without a feature switch", () => {
    expect(getAvailableConnectorAuthMethods("doubao", {})).toStrictEqual([
      "api-token",
    ]);
  });

  it("exposes WeRead API-token auth without a feature switch", () => {
    expect(getAvailableConnectorAuthMethods("weread", {})).toStrictEqual([
      "api-token",
    ]);
  });
});

describe("getConnectorAuthMethodEnvBindings", () => {
  it("returns env bindings for the exact auth method", () => {
    expect(getConnectorAuthMethodEnvBindings("ahrefs", "oauth")).toEqual({
      AHREFS_TOKEN: "$secrets.AHREFS_ACCESS_TOKEN",
    });
    expect(getConnectorAuthMethodEnvBindings("ahrefs", "api-token")).toEqual({
      AHREFS_TOKEN: "$secrets.AHREFS_TOKEN",
    });
  });

  it("returns empty env bindings for an unknown auth method", () => {
    expect(getConnectorAuthMethodEnvBindings("ahrefs", "missing")).toEqual({});
  });
});

describe("getConnectorAuthMethodAccessMetadata", () => {
  it("returns refresh-token access metadata for the selected OAuth method", () => {
    expect(getConnectorAuthMethodAccessMetadata("stripe", "oauth")).toEqual({
      kind: "refresh-token",
      accessToken: "STRIPE_ACCESS_TOKEN",
      refreshToken: "STRIPE_REFRESH_TOKEN",
      envBindings: {
        STRIPE_TOKEN: "$secrets.STRIPE_ACCESS_TOKEN",
      },
    });
  });

  it("returns static access metadata for the selected API-token method", () => {
    expect(getConnectorAuthMethodAccessMetadata("stripe", "api-token")).toEqual(
      {
        kind: "static",
        envBindings: {
          STRIPE_TOKEN: "$secrets.STRIPE_TOKEN",
        },
      },
    );
  });

  it("returns undefined for an unknown auth method", () => {
    expect(
      getConnectorAuthMethodAccessMetadata("stripe", "missing"),
    ).toBeUndefined();
  });

  it("keeps OAuth provider secret metadata aligned with OAuth access metadata", () => {
    for (const type of connectorTypeSchema.options) {
      if (!hasConnectorAuthorizationGrant(type)) {
        continue;
      }

      const providerMetadata = getConnectorAuthProviderSecretMetadata(type);
      if (!providerMetadata) {
        throw new Error(`${type}: OAuth provider metadata is missing`);
      }

      const accessMetadata = getConnectorAuthMethodAccessMetadata(
        type,
        "oauth",
      );

      if (providerMetadata.isRefreshable) {
        expect(
          accessMetadata,
          `${type}: refreshable OAuth provider must use refresh-token access`,
        ).toEqual(
          expect.objectContaining({
            kind: "refresh-token",
            accessToken: providerMetadata.accessSecretName,
            refreshToken: providerMetadata.refreshSecretName,
          }),
        );
      } else {
        expect(
          accessMetadata,
          `${type}: non-refreshable OAuth provider must not use refresh-token access`,
        ).not.toEqual(expect.objectContaining({ kind: "refresh-token" }));
      }
    }
  });
});

describe("getConnectorVariableNames", () => {
  it("returns manual grant variable fields for the exact auth method", () => {
    expect(new Set(getConnectorVariableNames("zendesk", "api-token"))).toEqual(
      new Set(["ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"]),
    );
  });

  it("returns no variables for an auth method without variable fields", () => {
    expect(getConnectorVariableNames("ahrefs", "oauth")).toEqual([]);
  });
});

describe("getConnectorEnvBindings", () => {
  it("returns non-empty envBindings for connector types that surface environment entries to the sandbox", () => {
    for (const type of connectorTypeSchema.options) {
      const envBindings = getConnectorEnvBindings(type);
      expect(
        Object.keys(envBindings).length,
        `${type} has empty envBindings`,
      ).toBeGreaterThan(0);
    }
  });

  it("returns correct envBindings for API-token-only connector", () => {
    expect(getConnectorEnvBindings("axiom")).toEqual({
      AXIOM_TOKEN: "$secrets.AXIOM_TOKEN",
    });
  });

  it("returns correct envBindings for apollo connector", () => {
    expect(getConnectorEnvBindings("apollo")).toEqual({
      APOLLO_TOKEN: "$secrets.APOLLO_TOKEN",
    });
  });

  it("returns correct envBindings for SproutGigs connector", () => {
    expect(getConnectorEnvBindings("sproutgigs")).toEqual({
      SPROUTGIGS_USER_ID: "$vars.SPROUTGIGS_USER_ID",
      SPROUTGIGS_API_SECRET: "$secrets.SPROUTGIGS_API_SECRET",
    });
  });

  it("returns correct envBindings for API-token connector with variables", () => {
    expect(getConnectorEnvBindings("jira")).toEqual({
      JIRA_API_TOKEN: "$secrets.JIRA_API_TOKEN",
      JIRA_DOMAIN: "$vars.JIRA_DOMAIN",
      JIRA_EMAIL: "$vars.JIRA_EMAIL",
    });
  });

  it("returns correct envBindings for hybrid connector", () => {
    expect(getConnectorEnvBindings("ahrefs")).toEqual({
      AHREFS_TOKEN: "$secrets.AHREFS_ACCESS_TOKEN",
    });
  });

  it("returns correct envBindings for OAuth-only connector", () => {
    expect(getConnectorEnvBindings("github")).toEqual({
      GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
    });
  });

  it("returns correct envBindings for Base44", () => {
    expect(getConnectorEnvBindings("base44")).toEqual({
      BASE44_TOKEN: "$secrets.BASE44_ACCESS_TOKEN",
    });
  });

  it("returns correct envBindings for Slock", () => {
    expect(getConnectorEnvBindings("slock")).toEqual({
      SLOCK_TOKEN: "$secrets.SLOCK_ACCESS_TOKEN",
      SLOCK_SERVER_ID: "$secrets.SLOCK_SERVER_ID",
    });
  });

  it("declares generated Slock firewall auth headers", () => {
    const firewall = getConnectorFirewall("slock");
    expect(firewall.apis).toHaveLength(1);
    expect(firewall.apis[0]?.base).toBe("https://api.slock.ai");
    expect(firewall.apis[0]?.auth?.headers).toMatchObject({
      Authorization: "Bearer ${{ secrets.SLOCK_TOKEN }}",
      "X-Server-Id": "${{ secrets.SLOCK_SERVER_ID }}",
    });
    expect(firewall.apis[0]?.permissions).toStrictEqual([]);
  });

  it("OAuth connectors have consistent secrets and envBindings naming", () => {
    // All naming derives from a single prefix XXX:
    //   oauth secrets:      XXX_ACCESS_TOKEN (required), XXX_REFRESH_TOKEN (optional)
    //   envBindings: values -> declared OAuth connector secrets
    //   api-token secrets:  XXX_TOKEN (if api-token auth method exists)
    for (const type of connectorTypeSchema.options) {
      if (!hasConnectorAuthorizationGrant(type)) continue;

      const oauthSecrets = getConnectorSecretNames(type, "oauth");
      const prefix = oauthSecrets
        .find((s) => {
          return s.endsWith("_ACCESS_TOKEN");
        })
        ?.replace(/_ACCESS_TOKEN$/, "");
      expect(
        prefix,
        `${type}: oauth secrets must include an _ACCESS_TOKEN key`,
      ).toBeDefined();

      const accessSecretName = `${prefix}_ACCESS_TOKEN`;
      const refreshSecretName = `${prefix}_REFRESH_TOKEN`;
      expect(
        oauthSecrets,
        `${type}: oauth secrets must include ${accessSecretName}`,
      ).toContain(accessSecretName);

      const oauthMethod = getConnectorAuthMethod(type, "oauth");
      if (oauthMethod?.access.kind === "refresh-token") {
        expect(
          oauthSecrets,
          `${type}: refresh-token access must include ${refreshSecretName}`,
        ).toContain(refreshSecretName);
      }

      const envBindings = getConnectorEnvBindings(type);
      const mappedSecretNames = Object.values(envBindings).map((valueRef) => {
        expect(
          valueRef.startsWith("$secrets."),
          `${type}: OAuth envBindings value ${valueRef} must reference a secret`,
        ).toBe(true);
        return valueRef.slice("$secrets.".length);
      });

      expect(
        mappedSecretNames,
        `${type}: envBindings must expose ${accessSecretName}`,
      ).toContain(accessSecretName);

      for (const secretName of mappedSecretNames) {
        expect(
          oauthSecrets,
          `${type}: mapped secret ${secretName} must be declared by OAuth auth method`,
        ).toContain(secretName);
      }

      for (const secretName of oauthSecrets) {
        if (
          secretName === accessSecretName ||
          secretName === refreshSecretName
        ) {
          continue;
        }
        expect(
          mappedSecretNames,
          `${type}: extra OAuth secret ${secretName} must be exposed by envBindings`,
        ).toContain(secretName);
      }

      const expectedAccessRef = `$secrets.${accessSecretName}`;
      expect(
        Object.values(envBindings),
        `${type}: envBindings must include ${expectedAccessRef}`,
      ).toContain(expectedAccessRef);

      if (envBindings[`${prefix}_TOKEN`] !== undefined) {
        expect(
          envBindings[`${prefix}_TOKEN`],
          `${type}: ${prefix}_TOKEN must reference ${accessSecretName}`,
        ).toBe(expectedAccessRef);
      }

      expect(oauthSecrets, `${type}: unexpected primary OAuth secrets`).toEqual(
        expect.arrayContaining(
          oauthMethod?.access.kind === "refresh-token"
            ? [accessSecretName, refreshSecretName]
            : [accessSecretName],
        ),
      );

      // api-token (if exists): exactly one secret XXX_TOKEN
      const apiTokenFields = getApiTokenManualGrantFields(type);
      if (apiTokenFields) {
        expect(
          Object.keys(apiTokenFields),
          `${type}: api-token must have exactly ["${prefix}_TOKEN"]`,
        ).toEqual([`${prefix}_TOKEN`]);
      }
    }
  });

  it("api-token-only connectors expose all secrets via envBindings with same name", () => {
    for (const type of connectorTypeSchema.options) {
      if (hasConnectorAuthorizationGrant(type)) continue;
      const fields = getApiTokenManualGrantFields(type);
      if (!fields) continue;

      const fieldNames = Object.keys(fields);
      const envBindings = getConnectorEnvBindings(type);
      const envBindingNames = Object.keys(envBindings);

      // envBindings names must be exactly the same set as secrets
      expect(
        envBindingNames.sort(),
        `${type}: envBindings names must match api-token secrets`,
      ).toEqual(fieldNames.sort());

      // each envBindings value must be $secrets.KEY or $vars.KEY (same name)
      for (const key of fieldNames) {
        expect(
          envBindings[key] === `$secrets.${key}` ||
            envBindings[key] === `$vars.${key}`,
          `${type}: envBindings["${key}"] = "${envBindings[key]}", expected $secrets.${key} or $vars.${key}`,
        ).toBe(true);
      }
    }
  });

  it("all envBindings values use $secrets. or $vars. prefix", () => {
    for (const type of connectorTypeSchema.options) {
      const envBindings = getConnectorEnvBindings(type);
      for (const [key, value] of Object.entries(envBindings)) {
        expect(
          value.startsWith("$secrets.") || value.startsWith("$vars."),
          `${type}.envBindings["${key}"] = "${value}" — must start with $secrets. or $vars.`,
        ).toBe(true);
      }
    }
  });
});

describe("getRuntimeAvailableConnectorTypes", () => {
  const emptyEnv = () => {
    return undefined;
  };

  it("includes manual-grant connectors without runtime OAuth client env or feature switches", () => {
    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(emptyEnv);

    expect(runtimeAvailableTypes).toContain("amplitude");
    expect(runtimeAvailableTypes).toContain("bentoml");
    expect(runtimeAvailableTypes).toContain("openai");
  });

  it("includes static OAuth test connectors without runtime OAuth client env", () => {
    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(emptyEnv);

    expect(runtimeAvailableTypes).toContain("test-oauth");
    expect(runtimeAvailableTypes).toContain("test-oauth-device");
  });

  it("includes OAuth connectors only when client id and secret are configured", () => {
    const env = new Map([
      ["AIRTABLE_OAUTH_CLIENT_ID", "airtable-client-id"],
      ["AIRTABLE_OAUTH_CLIENT_SECRET", "airtable-client-secret"],
      ["SENTRY_OAUTH_CLIENT_ID", "sentry-client-id"],
    ]);

    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes((name) => {
      return env.get(name);
    });

    expect(runtimeAvailableTypes).toContain("airtable");
    expect(runtimeAvailableTypes).not.toContain("sentry");
  });

  it("treats empty OAuth environment values as not configured", () => {
    const env = new Map([
      ["AIRTABLE_OAUTH_CLIENT_ID", "airtable-client-id"],
      ["AIRTABLE_OAUTH_CLIENT_SECRET", ""],
      ["SENTRY_OAUTH_CLIENT_ID", ""],
      ["SENTRY_OAUTH_CLIENT_SECRET", "sentry-client-secret"],
    ]);

    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes((name) => {
      return env.get(name);
    });

    expect(runtimeAvailableTypes).not.toContain("airtable");
    expect(runtimeAvailableTypes).not.toContain("sentry");
  });

  it("derives static confidential OAuth client from connector config", () => {
    const oauthClient = getOauthAuthClient("github", (name) => {
      return (
        {
          GH_OAUTH_CLIENT_ID: "github-client-id",
          GH_OAUTH_CLIENT_SECRET: "github-client-secret",
        } as Record<string, string>
      )[name];
    });

    expect(oauthClient).toStrictEqual({
      clientRegistration: "static",
      clientType: "confidential",
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
    });
  });

  it("does not configure static confidential OAuth when the secret is missing", () => {
    const oauthClient = getOauthAuthClient("github", (name) => {
      return name === "GH_OAUTH_CLIENT_ID" ? "github-client-id" : undefined;
    });

    expect(oauthClient).toBeUndefined();
  });

  it("supports literal static OAuth clients without runtime OAuth client env", () => {
    const oauthClient = getOauthAuthClient("test-oauth", emptyEnv);

    expect(oauthClient).toStrictEqual({
      clientRegistration: "static",
      clientType: "confidential",
      clientId: "test-oauth-client",
      clientSecret: "test-oauth-secret",
    });
  });

  it("supports static public OAuth clients with only a client id", () => {
    const oauthClient = getOauthAuthClient("test-oauth-device", emptyEnv);

    expect(oauthClient).toStrictEqual({
      clientRegistration: "static",
      clientType: "public",
      clientId: "test-oauth-device-client",
    });
  });

  it("identifies static OAuth client variants", () => {
    const staticAuthClient = getOauthAuthClient("github", (name) => {
      return (
        {
          GH_OAUTH_CLIENT_ID: "github-client-id",
          GH_OAUTH_CLIENT_SECRET: "github-client-secret",
        } as Record<string, string>
      )[name];
    });
    if (!staticAuthClient) {
      throw new Error("Expected GitHub OAuth client");
    }
    expect(isStaticConnectorAuthClient(staticAuthClient)).toBeTruthy();
    expect(
      isStaticConfidentialConnectorAuthClient(staticAuthClient),
    ).toBeTruthy();
    if (isStaticConfidentialConnectorAuthClient(staticAuthClient)) {
      const clientSecret: string = staticAuthClient.clientSecret;
      expect(clientSecret).toBe("github-client-secret");
    }

    const publicAuthClient = getOauthAuthClient("test-oauth-device", emptyEnv);
    if (!publicAuthClient) {
      throw new Error("Expected public OAuth client");
    }
    expect(isStaticConnectorAuthClient(publicAuthClient)).toBeTruthy();
    expect(
      isStaticConfidentialConnectorAuthClient(publicAuthClient),
    ).toBeFalsy();
    if (isStaticConnectorAuthClient(publicAuthClient)) {
      const clientId: string = publicAuthClient.clientId;
      expect(clientId).toBe("test-oauth-device-client");
    }
  });

  it("includes all connectors that share a configured OAuth app", () => {
    const env = new Map([
      ["GOOGLE_OAUTH_CLIENT_ID", "google-client-id"],
      ["GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret"],
    ]);

    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes((name) => {
      return env.get(name);
    });

    expect(runtimeAvailableTypes).toEqual(
      expect.arrayContaining([
        "gmail",
        "google-calendar",
        "google-docs",
        "google-drive",
        "google-meet",
        "google-sheets",
      ]),
    );
  });

  it("includes active OAuth connectors when their runtime env is configured", () => {
    const activeOAuthTypes = connectorTypeSchema.options.filter(
      hasConnectorAuthorizationGrant,
    );

    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(() => {
      return "configured";
    });

    expect(runtimeAvailableTypes).toEqual(
      expect.arrayContaining(activeOAuthTypes),
    );
  });

  it("includes Stripe without OAuth runtime env because API-token auth is runtime-available", () => {
    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(emptyEnv);

    expect(getConnectorAuthMethod("stripe", "api-token")).toBeDefined();
    expect(runtimeAvailableTypes).toContain("stripe");
  });

  it("returns connector types in sorted order", () => {
    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(emptyEnv);

    expect(runtimeAvailableTypes).toStrictEqual(
      [...runtimeAvailableTypes].sort(),
    );
  });
});

describe("getConnectorOAuthScopes - google-meet scopes", () => {
  it("uses meetings.space.readonly for google meet oauth scopes", () => {
    const grant = getConnectorAuthCodeGrantConfig("google-meet");
    const scopes = getConnectorOAuthScopes("google-meet");
    expect(scopes).toStrictEqual(grant?.scopes);
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/meetings.space.readonly",
    );
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/meetings.conferencerecords.readonly",
    );

    scopes.push("test-mutated-scope");
    expect(getConnectorOAuthScopes("google-meet")).not.toContain(
      "test-mutated-scope",
    );
  });
});

describe("connector OAuth lifecycle grant helpers", () => {
  it("returns auth-code grant config for GitHub", () => {
    const method = getConnectorAuthMethod("github", "oauth");

    expectTypeOf(
      getConnectorAuthCodeGrantConfig("github"),
    ).toEqualTypeOf<ConnectorAuthCodeGrantConfig>();
    expect(getConnectorAuthCodeGrantConfig("github")).toStrictEqual(
      method?.grant,
    );
    expect(getConnectorAuthCodeGrantConfig("github")).toMatchObject({
      kind: "auth-code",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "project", "workflow"],
    });
    expect("client" in getConnectorAuthCodeGrantConfig("github")).toBe(false);
    expect(method).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        clientIdEnv: "GH_OAUTH_CLIENT_ID",
        clientSecretEnv: "GH_OAUTH_CLIENT_SECRET",
      },
    });
  });

  it("returns device-auth grant config for device OAuth connectors", () => {
    expectTypeOf(
      getConnectorDeviceAuthGrantConfig("test-oauth-device"),
    ).toEqualTypeOf<ConnectorDeviceAuthGrantConfig>();
    expect(
      getConnectorDeviceAuthGrantConfig("test-oauth-device"),
    ).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "/api/test/oauth-provider/device/code",
      tokenUrl: "/api/test/oauth-provider/token",
      scopes: ["read"],
    });
    expect(getConnectorAuthMethod("test-oauth-device", "oauth")).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "test-oauth-device-client",
      },
    });
    expect(getConnectorDeviceAuthGrantConfig("base44")).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "https://app.base44.com/oauth/device/code",
      tokenUrl: "https://app.base44.com/oauth/token",
      scopes: ["apps:read", "apps:write", "offline"],
    });
    expect(getConnectorAuthMethod("base44", "oauth")).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "base44_cli",
      },
    });
    expect(getConnectorDeviceAuthGrantConfig("slock")).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "https://api.slock.ai/api/auth/device/authorize",
      tokenUrl: "https://api.slock.ai/api/auth/device/token",
      scopes: [],
    });
    expect(getConnectorAuthMethod("slock", "oauth")).toMatchObject({
      client: {
        clientRegistration: "dynamic",
        clientType: "public",
      },
    });
  });

  it("returns undefined for connectors without OAuth grants", () => {
    expect(hasConnectorAuthorizationGrant("axiom")).toBe(false);
    expect(getConnectorOAuthScopes("axiom")).toStrictEqual([]);
    expect(getConnectorAuthCodeGrantConfig("base44")).toBeUndefined();
    expect(getConnectorDeviceAuthGrantConfig("github")).toBeUndefined();
  });
});

describe("connector OAuth authorization-code config", () => {
  it("declares the current auth-code OAuth connectors with auth-code grants", () => {
    for (const type of connectorTypeSchema.options) {
      if (!hasConnectorAuthCodeGrant(type)) {
        continue;
      }

      expect(
        getConnectorAuthCodeGrantConfig(type).kind,
        `${type}: OAuth grant kind`,
      ).toBe("auth-code");
    }
  });

  it("keeps provider authorization URLs out of connector OAuth grants", () => {
    for (const type of connectorTypeSchema.options) {
      const grant =
        getConnectorAuthCodeGrantConfig(type) ??
        getConnectorDeviceAuthGrantConfig(type);
      if (!grant) {
        continue;
      }

      expect(
        "authorizationEndpoint" in grant,
        `${type}: authorization endpoint should be provider-owned`,
      ).toBe(false);
      expect(
        "authorizationUrl" in grant,
        `${type}: authorization URL should be provider-owned`,
      ).toBe(false);
    }
  });
});

describe("connector OAuth device authorization config", () => {
  it("declares the test OAuth device connector as a device authorization flow", () => {
    expect(hasConnectorDeviceAuthGrant("test-oauth-device")).toBe(true);
    expect(
      getConnectorDeviceAuthGrantConfig("test-oauth-device"),
    ).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "/api/test/oauth-provider/device/code",
      tokenUrl: "/api/test/oauth-provider/token",
      scopes: ["read"],
    });
    expect(getConnectorAuthMethod("test-oauth-device", "oauth")).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "test-oauth-device-client",
      },
    });
  });

  it("declares the Base44 connector as a device authorization flow", () => {
    expect(hasConnectorDeviceAuthGrant("base44")).toBe(true);
    expect(getConnectorDeviceAuthGrantConfig("base44")).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "https://app.base44.com/oauth/device/code",
      tokenUrl: "https://app.base44.com/oauth/token",
      scopes: ["apps:read", "apps:write", "offline"],
    });
    expect(getConnectorAuthMethod("base44", "oauth")).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "base44_cli",
      },
    });
  });

  it("declares the Slock connector as a device authorization flow", () => {
    expect(hasConnectorDeviceAuthGrant("slock")).toBe(true);
    expect(getConnectorDeviceAuthGrantConfig("slock")).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "https://api.slock.ai/api/auth/device/authorize",
      tokenUrl: "https://api.slock.ai/api/auth/device/token",
      scopes: [],
    });
    expect(getConnectorAuthMethod("slock", "oauth")).toMatchObject({
      client: {
        clientRegistration: "dynamic",
        clientType: "public",
      },
    });
  });
});

describe("getConnectorTypeForSecretName", () => {
  it("finds connector type for OAuth env bindings key", () => {
    expect(getConnectorTypeForSecretName("GH_TOKEN")).toBe("github");
    expect(getConnectorTypeForSecretName("GITHUB_TOKEN")).toBe("github");
  });

  it("finds connector type for api-token auth method secret", () => {
    expect(getConnectorTypeForSecretName("ATLASSIAN_TOKEN")).toBe("atlassian");
    expect(getConnectorTypeForSecretName("ATLASSIAN_EMAIL")).toBe("atlassian");
    expect(getConnectorTypeForSecretName("ATLASSIAN_DOMAIN")).toBe("atlassian");
  });

  it("finds connector type for OAuth auth method secret", () => {
    expect(getConnectorTypeForSecretName("GITHUB_ACCESS_TOKEN")).toBe("github");
  });

  it("returns null for unknown secret name", () => {
    expect(getConnectorTypeForSecretName("UNKNOWN_SECRET")).toBeNull();
  });
});

describe("isGoogleOAuthConnector", () => {
  it("returns true for all known Google OAuth connectors", () => {
    for (const type of GOOGLE_OAUTH_CONNECTOR_TYPES) {
      expect(
        isGoogleOAuthConnector(type),
        `${type} should be identified as a Google OAuth connector`,
      ).toBe(true);
    }
  });

  it("returns false for non-Google OAuth connectors", () => {
    const nonGoogleOAuth = ["github", "notion", "slack", "linear"] as const;
    for (const type of nonGoogleOAuth) {
      expect(
        isGoogleOAuthConnector(type),
        `${type} should not be identified as a Google OAuth connector`,
      ).toBe(false);
    }
  });

  it("returns false for connectors without Google OAuth", () => {
    const nonGoogleOAuth = ["axiom", "atlassian", "ahrefs"] as const;
    for (const type of nonGoogleOAuth) {
      expect(
        isGoogleOAuthConnector(type),
        `${type} should not be classified as Google OAuth`,
      ).toBe(false);
    }
  });

  it("returns true only for the shared Google OAuth provider connector set", () => {
    const detected = connectorTypeSchema.options.filter(isGoogleOAuthConnector);

    expect([...detected].sort()).toStrictEqual(
      [...GOOGLE_OAUTH_CONNECTOR_TYPES].sort(),
    );
  });

  it("builds Google OAuth authorization URLs at the provider boundary", () => {
    for (const type of GOOGLE_OAUTH_CONNECTOR_TYPES) {
      const authorizationUrl = new URL(
        buildGoogleAuthorizationUrl(
          type,
          "client-id",
          "https://app.test/callback",
          "state-123",
        ),
      );

      expect(
        authorizationUrl.hostname,
        `${type}: Google connector authorization endpoint must use accounts.google.com`,
      ).toBe("accounts.google.com");
      expect(authorizationUrl.searchParams.get("client_id")).toBe("client-id");
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        "https://app.test/callback",
      );
    }
  });
});
