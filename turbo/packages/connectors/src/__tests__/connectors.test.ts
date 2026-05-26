import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
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
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorConfig,
  type ConnectorInvalidDefaultAuthMethodType,
  type OAuthAuthCodeConnectorType,
} from "../connectors";
import {
  getApiTokenFieldStorageType,
  getAvailableConnectorAuthMethods,
  hasRequiredScopes,
  getConnectorAuthCodeGrantConfigIfSupported,
  getConnectorAuthMethod,
  getConnectorDeviceAuthGrantConfigIfSupported,
  getConnectorInteractivePairingGrantConfigIfSupported,
  getConnectorManagedSecretNames,
  getConnectorTypeForSecretName,
  getConnectorEnvironmentMapping,
  getConnectorProvidedSecretNames,
  getConnectorOAuthClientConfig,
  getConnectorOAuthCredentials,
  getConnectorOAuthGrantConfigIfSupported,
  getConnectorOAuthScopes,
  getConnectorManualGrantFields,
  getEligibleConnectorTypes,
  getRuntimeAvailableConnectorTypes,
  getConnectorSecretNames,
  isOAuthAuthCodeConnectorType,
  isOAuthDeviceAuthConnectorType,
  isStaticConfidentialConnectorOAuthCredentials,
  isStaticConnectorOAuthCredentials,
  isGoogleOAuthConnector,
  resolveConnectorOAuthClientCredentials,
} from "../connector-utils";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  buildConnectorOAuthAuthUrl,
  isOAuthConnectorType,
  getConnectorOAuthSecretMetadata,
  pollConnectorOAuthDeviceAuth,
  refreshConnectorOAuthToken,
  revokeConnectorOAuthToken,
  startConnectorOAuthDeviceAuth,
} from "../auth-providers/connector-auth";
import { GOOGLE_OAUTH_CONNECTOR_TYPES } from "../auth-providers/oauth/google-connectors";
import { buildGoogleAuthorizationUrl } from "../auth-providers/oauth/google";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

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
  x: "https://twitter.com/i/oauth2/authorize",
  xero: "https://login.xero.com/identity/connect/authorize",
  zoom: "https://zoom.us/oauth/authorize",
} as const satisfies Record<OAuthAuthCodeConnectorType, string>;

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

const localAuthMethodConfig = {
  label: "App Credentials",
  helpText: "Enter app credentials.",
  grant: {
    kind: "manual",
    fields: {
      APP_CREDENTIALS_TOKEN: {
        label: "Token",
        required: true,
      },
    },
  },
  access: {
    kind: "static",
    outputs: {
      APP_CREDENTIALS_TOKEN: "$secrets.APP_CREDENTIALS_TOKEN",
    },
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodConfig;

const connectorLocalAuthMethodFixture = {
  "connector-local-auth-method-fixture": {
    label: "Connector Local Auth Method Fixture",
    category: "data-automation-infrastructure",
    helpText: "Fixture used for connector auth method type coverage.",
    authMethods: {
      "app-credentials": localAuthMethodConfig,
    },
    defaultAuthMethod: "app-credentials",
  },
} as const satisfies Record<string, ConnectorConfig>;

type ConnectorConfigAuthMethodIds<Config extends ConnectorConfig> = Extract<
  keyof Config["authMethods"],
  string
>;

describe("hasRequiredScopes", () => {
  it("returns true for non-OAuth connector type", () => {
    // computer connector has no oauth config
    expect(hasRequiredScopes("computer", null)).toBe(true);
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
});

describe("connector auth method config", () => {
  it("keeps connector-local auth method ids explicit and typed", () => {
    type FixtureConfig =
      (typeof connectorLocalAuthMethodFixture)["connector-local-auth-method-fixture"];

    expectTypeOf<ConnectorAuthMethodId>().toEqualTypeOf<
      "oauth" | "api-token" | "api" | "cli-auth" | "app-credentials"
    >();
    expectTypeOf<"app-credentials">().toMatchTypeOf<ConnectorAuthMethodId>();
    expectTypeOf<"app-credential">().not.toMatchTypeOf<ConnectorAuthMethodId>();
    expectTypeOf<"app-credential">().not.toMatchTypeOf<
      keyof ConnectorConfig["authMethods"]
    >();
    expectTypeOf<"app-credential">().not.toMatchTypeOf<
      ConnectorConfig["defaultAuthMethod"]
    >();
    expectTypeOf<
      ConnectorConfigAuthMethodIds<FixtureConfig>
    >().toEqualTypeOf<"app-credentials">();
    expectTypeOf<
      FixtureConfig["defaultAuthMethod"]
    >().toEqualTypeOf<"app-credentials">();
    expectTypeOf<
      ConnectorInvalidDefaultAuthMethodType<
        typeof connectorLocalAuthMethodFixture
      >
    >().toEqualTypeOf<never>();

    const missingDefaultMethodFixture = {
      "missing-default-method-fixture": {
        label: "Missing Default Method Fixture",
        category: "data-automation-infrastructure",
        helpText: "Fixture used for connector auth method type coverage.",
        authMethods: {
          "api-token": localAuthMethodConfig,
        },
        defaultAuthMethod: "app-credentials",
      },
    } as const satisfies Record<string, ConnectorConfig>;
    expectTypeOf<
      ConnectorInvalidDefaultAuthMethodType<typeof missingDefaultMethodFixture>
    >().toEqualTypeOf<"missing-default-method-fixture">();
  });

  it("returns a single auth method config when present", () => {
    expect(getConnectorAuthMethod("stripe", "cli-auth")?.label).toBe(
      "Sign in with Stripe",
    );
    expect(getConnectorAuthMethod("github", "api-token")).toBeUndefined();
  });

  it("declares Stripe CLI auth as a gated connection flow with modes", () => {
    const method = getConnectorAuthMethod("stripe", "cli-auth");

    expect(method).toBeDefined();
    expect(method?.grant).toMatchObject({
      kind: "interactive-pairing",
      flow: "browser-verification",
    });
    expect(method?.access).toStrictEqual({ kind: "none" });
    expect(method?.revoke).toStrictEqual({ kind: "none" });
    expect(method?.featureFlag).toBe(FeatureSwitchKey.CliAuthStripe);
    expect(
      getConnectorInteractivePairingGrantConfigIfSupported("stripe"),
    ).toStrictEqual(method?.grant);
    expect(
      getConnectorInteractivePairingGrantConfigIfSupported("github"),
    ).toBeUndefined();
    expect(
      getConnectorInteractivePairingGrantConfigIfSupported("stripe")?.flow,
    ).toBe("browser-verification");
    expect(
      getConnectorInteractivePairingGrantConfigIfSupported("stripe")?.modes,
    ).toStrictEqual([
      {
        value: "test",
        label: "Test mode",
        description: "Import a Stripe test mode key.",
      },
      {
        value: "live",
        label: "Live mode",
        description: "Import a Stripe live mode key.",
      },
    ]);
  });

  it("returns api-token field storage types with secret default", () => {
    expect(getApiTokenFieldStorageType("zendesk", "ZENDESK_EMAIL")).toBe(
      "variable",
    );
    expect(getApiTokenFieldStorageType("zendesk", "ZENDESK_API_TOKEN")).toBe(
      "secret",
    );
    expect(getApiTokenFieldStorageType("zendesk", "UNKNOWN_FIELD")).toBe(
      "secret",
    );
  });
});

describe("isOAuthConnectorType", () => {
  it("matches exactly the connector types that declare OAuth grants", () => {
    const oauthConnectorTypes = connectorTypeSchema.options
      .filter((type) => {
        return getConnectorOAuthGrantConfigIfSupported(type) !== undefined;
      })
      .sort();

    for (const type of connectorTypeSchema.options) {
      expect(isOAuthConnectorType(type)).toBe(
        oauthConnectorTypes.includes(type),
      );
    }
  });

  it("exposes connector OAuth secret metadata without provider access", () => {
    expect(getConnectorOAuthSecretMetadata("test-oauth")).toEqual({
      accessSecretName: "TEST_OAUTH_ACCESS_TOKEN",
      refreshSecretName: "TEST_OAUTH_REFRESH_TOKEN",
      isRefreshable: true,
    });
    expect(getConnectorOAuthSecretMetadata("github")).toEqual({
      accessSecretName: "GITHUB_ACCESS_TOKEN",
      isRefreshable: false,
    });
    expect(getConnectorOAuthSecretMetadata("computer")).toBeUndefined();
  });

  it("rejects refresh for OAuth connectors without refresh-token access", async () => {
    const credentials = getConnectorOAuthCredentials("github", (name) => {
      return name === "GITHUB_CLIENT_ID"
        ? "test-github-client"
        : "test-github-secret";
    });
    expect(credentials?.configured).toBe(true);

    if (!credentials?.configured) {
      throw new Error("Expected github OAuth credentials");
    }

    await expect(
      refreshConnectorOAuthToken({
        type: "github",
        credentials,
        refreshToken: "refresh-token",
      }),
    ).rejects.toThrow("github OAuth provider does not support refresh");
  });

  it("revokes OAuth tokens through the provider registry", async () => {
    const credentials = getConnectorOAuthCredentials("github", (name) => {
      if (name === "GH_OAUTH_CLIENT_ID") {
        return "test-github-client";
      }
      if (name === "GH_OAUTH_CLIENT_SECRET") {
        return "test-github-secret";
      }
      return undefined;
    });
    expect(credentials?.configured).toBe(true);

    if (!credentials?.configured) {
      throw new Error("Expected github OAuth credentials");
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
      revokeConnectorOAuthToken({
        type: "github",
        credentials,
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
    const credentials = getConnectorOAuthCredentials("notion", (name) => {
      if (name === "NOTION_OAUTH_CLIENT_ID") {
        return "test-notion-client";
      }
      if (name === "NOTION_OAUTH_CLIENT_SECRET") {
        return "test-notion-secret";
      }
      return undefined;
    });
    expect(credentials?.configured).toBe(true);

    if (!credentials?.configured) {
      throw new Error("Expected notion OAuth credentials");
    }

    let loadedAccessToken = false;

    await expect(
      revokeConnectorOAuthToken({
        type: "notion",
        credentials,
        loadAccessToken: () => {
          loadedAccessToken = true;
          return "notion-access-token";
        },
      }),
    ).resolves.toStrictEqual({ status: "unsupported" });
    expect(loadedAccessToken).toBe(false);
  });

  it("returns unconfigured when OAuth credentials are unavailable for revoke", async () => {
    const credentials = getConnectorOAuthCredentials("github", () => {
      return undefined;
    });
    expect(credentials?.configured).toBe(false);

    if (!credentials) {
      throw new Error("Expected github OAuth credentials shape");
    }

    let loadedAccessToken = false;

    await expect(
      revokeConnectorOAuthToken({
        type: "github",
        credentials,
        loadAccessToken: () => {
          loadedAccessToken = true;
          return "gh-access-token";
        },
      }),
    ).resolves.toStrictEqual({ status: "unconfigured" });
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
        isOAuthAuthCodeConnectorType,
      );

      for (const type of providerTypes) {
        const client = getConnectorOAuthClientConfig(type);
        expect(client, `${type}: OAuth client config`).toBeDefined();
        if (!client) {
          throw new Error(`${type} OAuth client config not found`);
        }
        const credentials = resolveConnectorOAuthClientCredentials(
          client,
          () => {
            return "test-client-credential";
          },
        );
        const authResult = await buildConnectorOAuthAuthUrl({
          type,
          credentials,
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

    const credentials = getConnectorOAuthCredentials(
      "test-oauth-device",
      () => {
        return undefined;
      },
    );
    expect(credentials?.configured).toBe(true);

    if (!credentials?.configured) {
      throw new Error("Expected test-oauth-device OAuth credentials");
    }

    const startResult = await startConnectorOAuthDeviceAuth({
      type: "test-oauth-device",
      credentials,
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
      pollConnectorOAuthDeviceAuth({
        type: "test-oauth-device",
        credentials,
        deviceCode: "pending",
      }),
    ).resolves.toStrictEqual({ status: "pending" });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "test-oauth-device",
        credentials,
        deviceCode: "slow-down",
      }),
    ).resolves.toStrictEqual({ status: "slow_down" });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "test-oauth-device",
        credentials,
        deviceCode: "denied",
      }),
    ).resolves.toStrictEqual({
      status: "denied",
      error: "access_denied",
      errorDescription: "User denied the device authorization request",
    });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "test-oauth-device",
        credentials,
        deviceCode: "expired",
      }),
    ).resolves.toStrictEqual({
      status: "expired",
      error: "expired_token",
      errorDescription: "Device authorization expired",
    });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "test-oauth-device",
        credentials,
        deviceCode: "error",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "invalid_request",
      errorDescription: "Synthetic device authorization error",
    });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "test-oauth-device",
        credentials,
        deviceCode: "invalid-grant",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "invalid_grant",
      errorDescription: "Unknown device authorization code",
    });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "test-oauth-device",
        credentials,
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

    const credentials = getConnectorOAuthCredentials("base44", () => {
      return undefined;
    });
    expect(credentials?.configured).toBe(true);

    if (!credentials?.configured) {
      throw new Error("Expected base44 OAuth credentials");
    }

    await expect(
      startConnectorOAuthDeviceAuth({
        type: "base44",
        credentials,
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
      pollConnectorOAuthDeviceAuth({
        type: "base44",
        credentials,
        deviceCode: "pending",
      }),
    ).resolves.toStrictEqual({ status: "pending" });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "base44",
        credentials,
        deviceCode: "slow-down",
      }),
    ).resolves.toStrictEqual({ status: "slow_down" });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "base44",
        credentials,
        deviceCode: "denied",
      }),
    ).resolves.toStrictEqual({
      status: "denied",
      error: "access_denied",
      errorDescription: "User denied Base44 access",
    });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "base44",
        credentials,
        deviceCode: "expired",
      }),
    ).resolves.toStrictEqual({
      status: "expired",
      error: "expired_token",
      errorDescription: "Base44 device authorization expired",
    });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "base44",
        credentials,
        deviceCode: "temporarily-unavailable",
      }),
    ).resolves.toStrictEqual({
      status: "error",
      error: "temporarily_unavailable",
      errorDescription: "Base44 is temporarily unavailable",
    });
    await expect(
      pollConnectorOAuthDeviceAuth({
        type: "base44",
        credentials,
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
      refreshConnectorOAuthToken({
        type: "base44",
        credentials,
        refreshToken: "base44-refresh-rotation",
      }),
    ).resolves.toStrictEqual({
      accessToken: "base44-access-refreshed",
      refreshToken: "base44-refresh-rotated",
      expiresIn: 3600,
    });
    await expect(
      refreshConnectorOAuthToken({
        type: "base44",
        credentials,
        refreshToken: "base44-refresh-without-rotation",
      }),
    ).resolves.toStrictEqual({
      accessToken: "base44-access-refreshed",
      refreshToken: null,
      expiresIn: 3600,
    });
  });
});

describe("getAvailableConnectorAuthMethods", () => {
  it("exposes Stripe CLI auth only when its switch is enabled", () => {
    expect(getAvailableConnectorAuthMethods("stripe", {})).toStrictEqual([
      "api-token",
    ]);
    expect(
      getAvailableConnectorAuthMethods("stripe", {
        [FeatureSwitchKey.CliAuthStripe]: true,
      }),
    ).toStrictEqual(["api-token", "cli-auth"]);
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

describe("getEligibleConnectorTypes", () => {
  it("excludes Lark while every auth method is feature-gated", () => {
    expect(getEligibleConnectorTypes()).not.toContain("lark");
  });
});

describe("getConnectorManagedSecretNames", () => {
  it("includes OAuth environmentMapping keys for OAuth connectors", () => {
    const managed = getConnectorManagedSecretNames(["github"]);
    // OAuth env mapping keys
    expect(managed.has("GH_TOKEN")).toBe(true);
    expect(managed.has("GITHUB_TOKEN")).toBe(true);
    // OAuth auth method secret
    expect(managed.has("GITHUB_ACCESS_TOKEN")).toBe(true);
  });

  it("includes api-token auth method secrets for api-token-only connectors", () => {
    const managed = getConnectorManagedSecretNames(["atlassian"]);
    expect(managed.has("ATLASSIAN_TOKEN")).toBe(true);
    expect(managed.has("ATLASSIAN_EMAIL")).toBe(true);
    expect(managed.has("ATLASSIAN_DOMAIN")).toBe(true);
  });

  it("returns empty set for empty input", () => {
    const managed = getConnectorManagedSecretNames([]);
    expect(managed.size).toBe(0);
  });

  it("combines managed names across multiple connector types", () => {
    const managed = getConnectorManagedSecretNames(["github", "atlassian"]);
    expect(managed.has("GH_TOKEN")).toBe(true);
    expect(managed.has("ATLASSIAN_TOKEN")).toBe(true);
  });
});

describe("getConnectorEnvironmentMapping", () => {
  it("returns non-empty mapping for connector types that surface env vars to the sandbox", () => {
    for (const type of connectorTypeSchema.options) {
      const mapping = getConnectorEnvironmentMapping(type);
      if (type === "local-agent" || type === "local-browser") {
        expect(mapping).toEqual({});
        continue;
      }
      expect(
        Object.keys(mapping).length,
        `${type} has empty environmentMapping`,
      ).toBeGreaterThan(0);
    }
  });

  it("returns correct mapping for API-token-only connector", () => {
    expect(getConnectorEnvironmentMapping("axiom")).toEqual({
      AXIOM_TOKEN: "$secrets.AXIOM_TOKEN",
    });
  });

  it("returns correct mapping for apollo connector", () => {
    expect(getConnectorEnvironmentMapping("apollo")).toEqual({
      APOLLO_TOKEN: "$secrets.APOLLO_TOKEN",
    });
  });

  it("returns correct mapping for SproutGigs connector", () => {
    expect(getConnectorEnvironmentMapping("sproutgigs")).toEqual({
      SPROUTGIGS_USER_ID: "$vars.SPROUTGIGS_USER_ID",
      SPROUTGIGS_API_SECRET: "$secrets.SPROUTGIGS_API_SECRET",
    });
  });

  it("returns correct mapping for API-token connector with variables", () => {
    expect(getConnectorEnvironmentMapping("jira")).toEqual({
      JIRA_API_TOKEN: "$secrets.JIRA_API_TOKEN",
      JIRA_DOMAIN: "$vars.JIRA_DOMAIN",
      JIRA_EMAIL: "$vars.JIRA_EMAIL",
    });
  });

  it("returns correct mapping for hybrid connector", () => {
    expect(getConnectorEnvironmentMapping("ahrefs")).toEqual({
      AHREFS_TOKEN: "$secrets.AHREFS_ACCESS_TOKEN",
    });
  });

  it("returns correct mapping for OAuth-only connector", () => {
    expect(getConnectorEnvironmentMapping("github")).toEqual({
      GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
    });
  });

  it("returns correct mapping for Base44", () => {
    expect(getConnectorEnvironmentMapping("base44")).toEqual({
      BASE44_TOKEN: "$secrets.BASE44_ACCESS_TOKEN",
    });
  });

  it("OAuth connectors have consistent secrets and environmentMapping naming", () => {
    // All naming derives from a single prefix XXX:
    //   oauth secrets:      XXX_ACCESS_TOKEN (required), XXX_REFRESH_TOKEN (optional)
    //   environmentMapping: all values -> $secrets.XXX_ACCESS_TOKEN
    //   api-token secrets:  XXX_TOKEN (if api-token auth method exists)
    for (const type of connectorTypeSchema.options) {
      if (!getConnectorOAuthGrantConfigIfSupported(type)) continue;

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

      // oauth secrets: exactly [XXX_ACCESS_TOKEN] or [XXX_ACCESS_TOKEN, XXX_REFRESH_TOKEN]
      expect(oauthSecrets, `${type}: unexpected oauth secrets`).toSatisfy(
        (s: string[]) => {
          return s.length === 1
            ? s[0] === `${prefix}_ACCESS_TOKEN`
            : s.length === 2 &&
                s.includes(`${prefix}_ACCESS_TOKEN`) &&
                s.includes(`${prefix}_REFRESH_TOKEN`);
        },
      );

      // environmentMapping: must contain XXX_TOKEN, all values -> $secrets.XXX_ACCESS_TOKEN
      const mapping = getConnectorEnvironmentMapping(type);
      const expectedRef = `$secrets.${prefix}_ACCESS_TOKEN`;
      expect(
        mapping[`${prefix}_TOKEN`],
        `${type}: environmentMapping must include ${prefix}_TOKEN`,
      ).toBe(expectedRef);
      for (const [key, value] of Object.entries(mapping)) {
        expect(
          value,
          `${type}: environmentMapping["${key}"] must be ${expectedRef}`,
        ).toBe(expectedRef);
      }

      // api-token (if exists): exactly one secret XXX_TOKEN
      const apiTokenFields = getConnectorManualGrantFields(type, "api-token");
      if (apiTokenFields) {
        expect(
          Object.keys(apiTokenFields),
          `${type}: api-token must have exactly ["${prefix}_TOKEN"]`,
        ).toEqual([`${prefix}_TOKEN`]);
      }
    }
  });

  it("api-token-only connectors expose all secrets via environmentMapping with same name", () => {
    for (const type of connectorTypeSchema.options) {
      if (getConnectorOAuthGrantConfigIfSupported(type)) continue;
      const fields = getConnectorManualGrantFields(type, "api-token");
      if (!fields) continue;

      const fieldNames = Object.keys(fields);
      const mapping = getConnectorEnvironmentMapping(type);
      const mapKeys = Object.keys(mapping);

      // mapping keys must be exactly the same set as secrets
      expect(
        mapKeys.sort(),
        `${type}: environmentMapping keys must match api-token secrets`,
      ).toEqual(fieldNames.sort());

      // each mapping value must be $secrets.KEY or $vars.KEY (same name)
      for (const key of fieldNames) {
        expect(
          mapping[key] === `$secrets.${key}` || mapping[key] === `$vars.${key}`,
          `${type}: environmentMapping["${key}"] = "${mapping[key]}", expected $secrets.${key} or $vars.${key}`,
        ).toBe(true);
      }
    }
  });

  it("all mapping values use $secrets. or $vars. prefix", () => {
    for (const type of connectorTypeSchema.options) {
      const mapping = getConnectorEnvironmentMapping(type);
      for (const [key, value] of Object.entries(mapping)) {
        expect(
          value.startsWith("$secrets.") || value.startsWith("$vars."),
          `${type}.environmentMapping["${key}"] = "${value}" — must start with $secrets. or $vars.`,
        ).toBe(true);
      }
    }
  });
});

describe("getRuntimeAvailableConnectorTypes", () => {
  const emptyEnv = () => {
    return undefined;
  };

  it("includes manual-grant connectors without environment credentials or feature switches", () => {
    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(emptyEnv);

    expect(runtimeAvailableTypes).toContain("amplitude");
    expect(runtimeAvailableTypes).toContain("bentoml");
    expect(runtimeAvailableTypes).toContain("openai");
  });

  it("includes static OAuth test connectors without runtime environment credentials", () => {
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

  it("derives static confidential OAuth credentials from connector config", () => {
    const credentials = getConnectorOAuthCredentials("github", (name) => {
      return (
        {
          GH_OAUTH_CLIENT_ID: "github-client-id",
          GH_OAUTH_CLIENT_SECRET: "github-client-secret",
        } as Record<string, string>
      )[name];
    });

    expect(credentials).toStrictEqual({
      configured: true,
      client: getConnectorOAuthClientConfig("github"),
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
    });
  });

  it("does not configure static confidential OAuth when the secret is missing", () => {
    const credentials = getConnectorOAuthCredentials("github", (name) => {
      return name === "GH_OAUTH_CLIENT_ID" ? "github-client-id" : undefined;
    });

    expect(credentials).toStrictEqual({
      configured: false,
      client: getConnectorOAuthClientConfig("github"),
    });
  });

  it("supports literal static OAuth clients without environment credentials", () => {
    const credentials = getConnectorOAuthCredentials("test-oauth", emptyEnv);

    expect(credentials).toStrictEqual({
      configured: true,
      client: getConnectorOAuthClientConfig("test-oauth"),
      clientId: "test-oauth-client",
      clientSecret: "test-oauth-secret",
    });
  });

  it("supports static public OAuth clients with only a client id", () => {
    const credentials = resolveConnectorOAuthClientCredentials(
      {
        clientRegistration: "static",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        clientIdEnv: "PUBLIC_OAUTH_CLIENT_ID",
      },
      (name) => {
        return name === "PUBLIC_OAUTH_CLIENT_ID"
          ? "public-client-id"
          : undefined;
      },
    );

    expect(credentials).toStrictEqual({
      configured: true,
      client: {
        clientRegistration: "static",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        clientIdEnv: "PUBLIC_OAUTH_CLIENT_ID",
      },
      clientId: "public-client-id",
    });
  });

  it("supports dynamic public OAuth clients without environment credentials", () => {
    const client = {
      clientRegistration: "dynamic",
      clientType: "public",
      tokenEndpointAuthMethod: "none",
    } as const;

    expect(
      resolveConnectorOAuthClientCredentials(client, emptyEnv),
    ).toStrictEqual({
      configured: true,
      client,
    });
  });

  it("identifies static OAuth credential variants", () => {
    const staticCredentials = getConnectorOAuthCredentials("github", (name) => {
      return (
        {
          GH_OAUTH_CLIENT_ID: "github-client-id",
          GH_OAUTH_CLIENT_SECRET: "github-client-secret",
        } as Record<string, string>
      )[name];
    });
    if (!staticCredentials) {
      throw new Error("Expected GitHub OAuth credentials");
    }
    expect(isStaticConnectorOAuthCredentials(staticCredentials)).toBeTruthy();
    expect(
      isStaticConfidentialConnectorOAuthCredentials(staticCredentials),
    ).toBeTruthy();
    if (isStaticConfidentialConnectorOAuthCredentials(staticCredentials)) {
      const clientSecret: string = staticCredentials.clientSecret;
      expect(clientSecret).toBe("github-client-secret");
    }

    const publicCredentials = resolveConnectorOAuthClientCredentials(
      {
        clientRegistration: "static",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        clientId: "public-client-id",
      },
      emptyEnv,
    );
    expect(isStaticConnectorOAuthCredentials(publicCredentials)).toBeTruthy();
    expect(
      isStaticConfidentialConnectorOAuthCredentials(publicCredentials),
    ).toBeFalsy();
    if (isStaticConnectorOAuthCredentials(publicCredentials)) {
      const clientId: string = publicCredentials.clientId;
      expect(clientId).toBe("public-client-id");
    }

    const dynamicClient = {
      clientRegistration: "dynamic",
      clientType: "public",
      tokenEndpointAuthMethod: "none",
    } as const;
    const dynamicCredentials = resolveConnectorOAuthClientCredentials(
      dynamicClient,
      emptyEnv,
    );
    expect(isStaticConnectorOAuthCredentials(dynamicCredentials)).toBeFalsy();
    expect(
      isStaticConfidentialConnectorOAuthCredentials(dynamicCredentials),
    ).toBeFalsy();
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
    const activeOAuthTypes = connectorTypeSchema.options.filter((type) => {
      return getConnectorOAuthGrantConfigIfSupported(type);
    });

    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(() => {
      return "configured";
    });

    expect(runtimeAvailableTypes).toEqual(
      expect.arrayContaining(activeOAuthTypes),
    );
  });

  it("includes computer only when both ngrok env vars are configured", () => {
    const partialComputerEnv = new Map([["NGROK_API_KEY", "ngrok-api-key"]]);
    const fullComputerEnv = new Map([
      ["NGROK_API_KEY", "ngrok-api-key"],
      ["NGROK_COMPUTER_CONNECTOR_DOMAIN", "computer.example.com"],
    ]);

    expect(
      getRuntimeAvailableConnectorTypes((name) => {
        return partialComputerEnv.get(name);
      }),
    ).not.toContain("computer");
    expect(
      getRuntimeAvailableConnectorTypes((name) => {
        return fullComputerEnv.get(name);
      }),
    ).toContain("computer");
  });

  it("excludes API-managed local connectors without special runtime env support", () => {
    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(emptyEnv);

    expect(runtimeAvailableTypes).not.toContain("local-agent");
    expect(runtimeAvailableTypes).not.toContain("local-browser");
  });

  it("includes Stripe without OAuth runtime env because API-token auth is runtime-available", () => {
    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(emptyEnv);

    expect(getConnectorAuthMethod("stripe", "api-token")).toBeDefined();
    expect(getConnectorAuthMethod("stripe", "cli-auth")).toBeDefined();
    expect(runtimeAvailableTypes).toContain("stripe");
  });

  it("returns connector types in sorted order", () => {
    const runtimeAvailableTypes = getRuntimeAvailableConnectorTypes(emptyEnv);

    expect(runtimeAvailableTypes).toStrictEqual(
      [...runtimeAvailableTypes].sort(),
    );
  });
});

describe("getConnectorProvidedSecretNames", () => {
  it("returns env var names for API-token-only connector", () => {
    const names = getConnectorProvidedSecretNames(["axiom"]);
    expect(names.has("AXIOM_TOKEN")).toBe(true);
  });

  it("returns env var names for OAuth connector", () => {
    const names = getConnectorProvidedSecretNames(["github"]);
    expect(names.has("GH_TOKEN")).toBe(true);
    expect(names.has("GITHUB_TOKEN")).toBe(true);
  });
});

describe("getConnectorOAuthScopes - google-meet scopes", () => {
  it("uses meetings.space.readonly for google meet oauth scopes", () => {
    const grant = getConnectorAuthCodeGrantConfigIfSupported("google-meet");
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

    expect(getConnectorOAuthGrantConfigIfSupported("github")).toStrictEqual(
      method?.grant,
    );
    expect(getConnectorAuthCodeGrantConfigIfSupported("github")).toMatchObject({
      kind: "auth-code",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "project", "workflow"],
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "GH_OAUTH_CLIENT_ID",
        clientSecretEnv: "GH_OAUTH_CLIENT_SECRET",
      },
    });
  });

  it("returns device-auth grant config for device OAuth connectors", () => {
    expect(
      getConnectorDeviceAuthGrantConfigIfSupported("test-oauth-device"),
    ).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "/api/test/oauth-provider/device/code",
      tokenUrl: "/api/test/oauth-provider/token",
      client: {
        clientRegistration: "static",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        clientId: "test-oauth-device-client",
      },
      scopes: ["read"],
    });
    expect(
      getConnectorDeviceAuthGrantConfigIfSupported("base44"),
    ).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "https://app.base44.com/oauth/device/code",
      tokenUrl: "https://app.base44.com/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        clientId: "base44_cli",
      },
      scopes: ["apps:read", "apps:write", "offline"],
    });
  });

  it("returns undefined for connectors without OAuth grants", () => {
    expect(getConnectorOAuthGrantConfigIfSupported("axiom")).toBeUndefined();
    expect(getConnectorOAuthScopes("axiom")).toStrictEqual([]);
    expect(
      getConnectorAuthCodeGrantConfigIfSupported("base44"),
    ).toBeUndefined();
    expect(
      getConnectorDeviceAuthGrantConfigIfSupported("github"),
    ).toBeUndefined();
  });
});

describe("connector OAuth authorization-code config", () => {
  it("declares the current auth-code OAuth connectors with auth-code grants", () => {
    for (const type of connectorTypeSchema.options) {
      if (!isOAuthAuthCodeConnectorType(type)) {
        continue;
      }

      expect(
        getConnectorAuthCodeGrantConfigIfSupported(type)?.kind,
        `${type}: OAuth grant kind`,
      ).toBe("auth-code");
    }
  });

  it("keeps provider authorization URLs out of connector OAuth grants", () => {
    for (const type of connectorTypeSchema.options) {
      const grant = getConnectorOAuthGrantConfigIfSupported(type);
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
    expect(isOAuthDeviceAuthConnectorType("test-oauth-device")).toBe(true);
    expect(
      getConnectorDeviceAuthGrantConfigIfSupported("test-oauth-device"),
    ).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "/api/test/oauth-provider/device/code",
      tokenUrl: "/api/test/oauth-provider/token",
      client: {
        clientRegistration: "static",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        clientId: "test-oauth-device-client",
      },
      scopes: ["read"],
    });
  });

  it("declares the Base44 connector as a device authorization flow", () => {
    expect(isOAuthDeviceAuthConnectorType("base44")).toBe(true);
    expect(
      getConnectorDeviceAuthGrantConfigIfSupported("base44"),
    ).toMatchObject({
      kind: "device-auth",
      deviceAuthUrl: "https://app.base44.com/oauth/device/code",
      tokenUrl: "https://app.base44.com/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        clientId: "base44_cli",
      },
      scopes: ["apps:read", "apps:write", "offline"],
    });
  });
});

describe("getConnectorTypeForSecretName", () => {
  it("finds connector type for OAuth env mapping key", () => {
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
