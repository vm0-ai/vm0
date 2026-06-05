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
  type ConnectorAuthMethodIds,
  type ConnectorAuthCodeGrantAuthMethodId,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorInvalidDefaultAuthMethodType,
  type ConnectorManualGrantFieldConfig,
  type ConnectorType,
  type AuthCodeGrantConnectorType,
  type RefreshTokenAccessConnectorType,
  type TokenRevokeConnectorType,
} from "../connectors";
import {
  connectorAuthClientIdentity,
  connectorAuthMethodHasGrantKind,
  connectorAuthMethodRefHasAccessKind,
  connectorAuthMethodRefHasGrantKind,
  connectorAuthMethodRefHasRevokeKind,
  getAvailableConnectorAuthMethodIds,
  getConnectorAuthMethodGrantScopes,
  getConnectorAuthMethodGrantMetadata,
  getConnectorAuthMethodRevokeMetadata,
  getConnectorAuthMethodIdsForAccessKind,
  getConnectorAuthMethodIdsForGrantKind,
  getConnectorAuthMethodIdsForRevokeKind,
  getConnectorAuthMethodScopeDiff,
  getConfiguredConnectorAuthMethodIds,
  hasRequiredConnectorAuthMethodScopes,
  getConnectorAuthMethodAuthCodeGrantConfig,
  getConnectorAuthMethodDeviceAuthGrantConfig,
  getConnectorAuthMethodAccessMetadata,
  getConnectorAuthMethodRuntimeMetadata,
  getConnectorGrantOutputSecretName,
  getConnectorRefreshOutputSecretName,
  getConnectorStoredSecretDisplayInfo,
  getDiagnosticConnectorTypeForRuntimeEnvName,
  resolveConnectorAuthClientForMethod,
  getConnectorAuthMethodEnvBindings,
  getConnectorAuthMethod,
  getConnectorEnvBindingEntries,
  getConnectorManualGrantFieldNames,
  getConnectorManualGrantFieldNamesForAuthMethod,
  getRuntimeAvailableConnectorTypes,
  getConnectorOwnedSecretNames,
  getConnectorOwnedVariableNames,
  hasConnectorAuthCodeGrant,
  hasConnectorDeviceAuthGrant,
  isStaticConfidentialConnectorAuthClient,
  isStaticConnectorAuthClient,
  type ConnectorAuthClient,
  type ConnectorAuthClientForMethod,
  type ConnectorAuthMethodRef,
  type ConnectorEnvReader,
} from "../connector-utils";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  buildConnectorAuthCodeAuthorizationUrl,
  pollConnectorDeviceAuthorization,
  refreshConnectorAuthProviderAccessToken,
  revokeConnectorAuthMethodAccessToken,
  startConnectorDeviceAuthorization,
} from "../auth-providers/connector-auth";
import type { ConnectorAuthProviderRefreshArgs } from "../auth-providers/types";
import {
  TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME,
  TEST_OAUTH_DEVICE_API_ACCESS_SECRET_NAME,
} from "../auth-providers/connectors/test-oauth-device/oauth";
import {
  GOOGLE_OAUTH_CONNECTOR_TYPES,
  isGoogleOAuthConnector,
} from "../auth-providers/oauth/google-connectors";
import { buildGoogleAuthorizationUrl } from "../auth-providers/oauth/google";
import { getConnectorFirewall } from "../firewalls";

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

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

type OAuthAuthMethodConnectorType = {
  readonly [Type in ConnectorType]: "oauth" extends ConnectorAuthMethodIds<Type>
    ? Type
    : never;
}[ConnectorType];

function getOauthAuthClient<Type extends OAuthAuthMethodConnectorType>(
  type: Type,
  readEnv: ConnectorEnvReader,
):
  | ConnectorAuthClientForMethod<Type, ConnectorAuthMethodIds<Type> & "oauth">
  | undefined;
function getOauthAuthClient(
  type: ConnectorType,
  readEnv: ConnectorEnvReader,
): ConnectorAuthClient | undefined {
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
  storage: {
    secrets: ["API_TOKEN"],
    variables: [],
  },
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

const multiAuthMethodFixture = {
  "multi-auth-method-fixture": {
    label: "Multi Auth Method Fixture",
    category: "data-automation-infrastructure",
    helpText: "Fixture used for connector auth method type coverage.",
    authMethods: {
      oauth: manualAuthMethodConfig,
      "api-token": manualAuthMethodConfig,
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;

type ConnectorConfigAuthMethodIds<Config extends ConnectorConfig> = Extract<
  keyof Config["authMethods"],
  string
>;

describe("connector auth method lifecycle helpers", () => {
  it("checks required scopes from the selected auth method grant", () => {
    expectTypeOf<"api">().toMatchTypeOf<ConnectorAuthCodeGrantAuthMethodId>();
    expect(
      getConnectorAuthMethodIdsForGrantKind("github", "auth-code"),
    ).toStrictEqual(["oauth"]);
    expect(
      getConnectorAuthMethodIdsForGrantKind("github", "manual"),
    ).toStrictEqual([]);
    expect(
      getConnectorAuthMethodIdsForAccessKind("github", "static"),
    ).toStrictEqual(["oauth"]);
    expect(
      getConnectorAuthMethodIdsForRevokeKind("github", "token-revoke"),
    ).toStrictEqual(["oauth"]);

    expect(
      getConnectorAuthMethodIdsForGrantKind("stripe", "auth-code"),
    ).toStrictEqual(["oauth"]);
    expect(
      getConnectorAuthMethodIdsForGrantKind("stripe", "manual"),
    ).toStrictEqual(["api-token"]);
    expect(
      getConnectorAuthMethodIdsForAccessKind("stripe", "refresh-token"),
    ).toStrictEqual(["oauth"]);
    expect(
      getConnectorAuthMethodIdsForAccessKind("stripe", "static"),
    ).toStrictEqual(["api-token"]);
    expect(
      getConnectorAuthMethodIdsForAccessKind("lark", "refresh-token"),
    ).toStrictEqual(["api-token"]);
    expect(
      getConnectorAuthMethodIdsForAccessKind("lark", "static"),
    ).toStrictEqual([]);
    expect(
      getConnectorAuthMethodIdsForRevokeKind("stripe", "token-revoke"),
    ).toStrictEqual([]);
    expect(
      getConnectorAuthMethodIdsForRevokeKind("stripe", "none"),
    ).toStrictEqual(["oauth", "api-token"]);

    expect(
      getConnectorAuthMethodIdsForGrantKind("test-oauth-device", "device-auth"),
    ).toStrictEqual(["oauth", "api"]);
    expect(
      getConnectorAuthMethodIdsForGrantKind("test-oauth-device", "auth-code"),
    ).toStrictEqual([]);
    expect(
      getConnectorAuthMethodIdsForGrantKind("test-oauth", "auth-code"),
    ).toStrictEqual(["oauth", "api"]);
    expect(
      getConnectorAuthMethodIdsForAccessKind("test-oauth", "refresh-token"),
    ).toStrictEqual(["oauth", "api-token", "api"]);

    expect(
      connectorAuthMethodHasGrantKind("github", "oauth", "auth-code"),
    ).toBe(true);
    expect(
      connectorAuthMethodHasGrantKind("github", "api-token", "auth-code"),
    ).toBe(false);
    expect(
      connectorAuthMethodRefHasGrantKind(
        { type: "github", authMethod: "oauth" },
        "auth-code",
      ),
    ).toBe(true);
    expect(
      connectorAuthMethodRefHasGrantKind(
        { type: "stripe", authMethod: "api-token" },
        "auth-code",
      ),
    ).toBe(false);
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
    type MultiFixtureConfig =
      (typeof multiAuthMethodFixture)["multi-auth-method-fixture"];

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
      ConnectorConfigAuthMethodIds<MultiFixtureConfig>
    >().toEqualTypeOf<"oauth" | "api-token">();
    expectTypeOf<
      FixtureConfig["defaultAuthMethod"]
    >().toEqualTypeOf<"api-token">();
    expectTypeOf<
      MultiFixtureConfig["defaultAuthMethod"]
    >().toEqualTypeOf<"api-token">();
    expectTypeOf<
      ConnectorInvalidDefaultAuthMethodType<typeof connectorAuthMethodFixture>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      ConnectorInvalidDefaultAuthMethodType<typeof multiAuthMethodFixture>
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

  it("does not silently choose one type-only auth-code grant when ambiguous", () => {
    const authMethods = CONNECTOR_TYPES.github.authMethods;
    Object.defineProperty(authMethods, "api", {
      value: {
        ...authMethods.oauth,
        label: "Secondary OAuth",
      },
      configurable: true,
      enumerable: true,
    });

    try {
      expect(
        getConnectorAuthMethodIdsForGrantKind("github", "auth-code"),
      ).toStrictEqual(["oauth", "api"]);
      expect(hasConnectorAuthCodeGrant("github")).toBe(true);
      expect(
        getConnectorAuthMethodAuthCodeGrantConfig("github", "api"),
      ).toStrictEqual(authMethods.oauth.grant);
    } finally {
      Reflect.deleteProperty(authMethods, "api");
    }
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

  it("gets manual grant field names for one auth method", () => {
    const authMethods = CONNECTOR_TYPES.github.authMethods;
    const apiTokenMethod = {
      label: "API Token",
      helpText: "Enter an API token.",
      storage: {
        secrets: ["GITHUB_API_TOKEN"],
        variables: ["GITHUB_API_HOST"],
      },
      grant: {
        kind: "manual",
        fields: {
          GITHUB_API_TOKEN: {
            label: "Token",
            required: true,
          },
          GITHUB_API_HOST: {
            label: "Host",
            required: false,
            storage: "variable",
          },
        },
      },
      access: {
        kind: "static",
        envBindings: {
          GITHUB_API_TOKEN: "$secrets.GITHUB_API_TOKEN",
          GITHUB_API_HOST: "$vars.GITHUB_API_HOST",
        },
      },
      revoke: { kind: "none" },
    } satisfies ConnectorAuthMethodConfig;
    const apiMethod = {
      label: "Secondary API Token",
      helpText: "Enter a secondary API token.",
      storage: {
        secrets: ["GITHUB_SECONDARY_TOKEN"],
        variables: ["GITHUB_SECONDARY_HOST"],
      },
      grant: {
        kind: "manual",
        fields: {
          GITHUB_SECONDARY_TOKEN: {
            label: "Token",
            required: true,
          },
          GITHUB_SECONDARY_HOST: {
            label: "Host",
            required: false,
            storage: "variable",
          },
        },
      },
      access: {
        kind: "static",
        envBindings: {
          GITHUB_SECONDARY_TOKEN: "$secrets.GITHUB_SECONDARY_TOKEN",
          GITHUB_SECONDARY_HOST: "$vars.GITHUB_SECONDARY_HOST",
        },
      },
      revoke: { kind: "none" },
    } satisfies ConnectorAuthMethodConfig;

    Object.defineProperty(authMethods, "api-token", {
      value: apiTokenMethod,
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(authMethods, "api", {
      value: apiMethod,
      configurable: true,
      enumerable: true,
    });

    try {
      expect(
        getConnectorManualGrantFieldNamesForAuthMethod("github", "oauth"),
      ).toBeNull();
      expect(
        getConnectorManualGrantFieldNamesForAuthMethod("github", "api-token"),
      ).toStrictEqual({
        secrets: ["GITHUB_API_TOKEN"],
        variables: ["GITHUB_API_HOST"],
      });
      expect(
        getConnectorManualGrantFieldNamesForAuthMethod("github", "api"),
      ).toStrictEqual({
        secrets: ["GITHUB_SECONDARY_TOKEN"],
        variables: ["GITHUB_SECONDARY_HOST"],
      });
      expect(getConnectorManualGrantFieldNames("github")).toStrictEqual({
        secrets: ["GITHUB_API_TOKEN", "GITHUB_SECONDARY_TOKEN"],
        variables: ["GITHUB_API_HOST", "GITHUB_SECONDARY_HOST"],
      });
    } finally {
      Reflect.deleteProperty(authMethods, "api-token");
      Reflect.deleteProperty(authMethods, "api");
    }
  });

  it("keeps connector-scoped secret and variable names globally unique", () => {
    const secretOwners = new Map<string, string[]>();
    const variableOwners = new Map<string, string[]>();

    for (const type of CONNECTOR_TYPE_KEYS) {
      for (const authMethod of Object.keys(CONNECTOR_TYPES[type].authMethods)) {
        for (const name of getConnectorOwnedSecretNames(type, authMethod)) {
          secretOwners.set(name, [
            ...(secretOwners.get(name) ?? []),
            `${type}:${authMethod}`,
          ]);
        }
        for (const name of getConnectorOwnedVariableNames(type, authMethod)) {
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

  it("keeps runtime env aliases unique across connector types", () => {
    const envAliasOwners = new Map<string, Set<ConnectorType>>();

    for (const type of CONNECTOR_TYPE_KEYS) {
      for (const { envName } of getConnectorEnvBindingEntries(type)) {
        const owners = envAliasOwners.get(envName) ?? new Set<ConnectorType>();
        owners.add(type);
        envAliasOwners.set(envName, owners);
      }
    }

    const crossConnectorDuplicates = [...envAliasOwners].flatMap(
      ([envName, owners]) => {
        return owners.size > 1
          ? [{ envName, connectorTypes: [...owners].sort() }]
          : [];
      },
    );

    expect(crossConnectorDuplicates).toStrictEqual([]);
  });
});

describe("connector selected auth method capability checks", () => {
  it("matches exactly the auth methods that declare auth-code and device-auth grants", () => {
    for (const type of connectorTypeSchema.options) {
      const authMethodIds = getConfiguredConnectorAuthMethodIds(type);
      expect(hasConnectorAuthCodeGrant(type)).toBe(
        authMethodIds.some((authMethod) => {
          return connectorAuthMethodHasGrantKind(type, authMethod, "auth-code");
        }),
      );
      expect(hasConnectorDeviceAuthGrant(type)).toBe(
        authMethodIds.some((authMethod) => {
          return connectorAuthMethodHasGrantKind(
            type,
            authMethod,
            "device-auth",
          );
        }),
      );
      for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
        expect(
          connectorAuthMethodHasGrantKind(type, authMethod, "auth-code"),
        ).toBe(
          getConnectorAuthMethod(type, authMethod)?.grant.kind === "auth-code",
        );
        expect(
          connectorAuthMethodHasGrantKind(type, authMethod, "device-auth"),
        ).toBe(
          getConnectorAuthMethod(type, authMethod)?.grant.kind ===
            "device-auth",
        );
      }
    }
  });

  it("matches exactly the auth methods that declare refresh-token access", () => {
    expectTypeOf<"base44">().toMatchTypeOf<RefreshTokenAccessConnectorType>();
    expectTypeOf<"lark">().toMatchTypeOf<RefreshTokenAccessConnectorType>();
    expectTypeOf<"notion">().toMatchTypeOf<RefreshTokenAccessConnectorType>();
    expectTypeOf<"github">().not.toMatchTypeOf<RefreshTokenAccessConnectorType>();

    for (const type of connectorTypeSchema.options) {
      for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
        const hasRefreshTokenAccess =
          getConnectorAuthMethodAccessMetadata(type, authMethod)?.kind ===
          "refresh-token";
        expect(
          connectorAuthMethodRefHasAccessKind(
            { type, authMethod },
            "refresh-token",
          ),
        ).toBe(hasRefreshTokenAccess);
      }
    }
  });

  it("types refresh provider auth clients from the selected auth method", () => {
    type ClientBackedRefreshArgs = ConnectorAuthProviderRefreshArgs<
      "test-oauth",
      "oauth"
    >;
    type InputOnlyRefreshArgs = ConnectorAuthProviderRefreshArgs<
      "test-oauth",
      "api-token"
    >;
    type LarkRefreshArgs = ConnectorAuthProviderRefreshArgs<
      "lark",
      "api-token"
    >;
    type DefaultRefreshArgs = ConnectorAuthProviderRefreshArgs<"test-oauth">;
    type DefaultInputOnlyRefreshArgs = Exclude<
      DefaultRefreshArgs,
      { readonly authClient: unknown }
    >;

    expectTypeOf<ClientBackedRefreshArgs["authClient"]>().toEqualTypeOf<
      ConnectorAuthClientForMethod<"test-oauth", "oauth">
    >();
    expectTypeOf<"authClient">().not.toMatchTypeOf<
      keyof InputOnlyRefreshArgs
    >();
    expectTypeOf<InputOnlyRefreshArgs["inputs"]>().toEqualTypeOf<{
      readonly inputSecret: string;
      readonly inputVariable: string;
    }>();
    expectTypeOf<"authClient">().not.toMatchTypeOf<
      keyof DefaultInputOnlyRefreshArgs
    >();
    expectTypeOf<DefaultInputOnlyRefreshArgs["inputs"]>().toEqualTypeOf<{
      readonly inputSecret: string;
      readonly inputVariable: string;
    }>();
    expectTypeOf<"authClient">().not.toMatchTypeOf<keyof LarkRefreshArgs>();
    expectTypeOf<LarkRefreshArgs["inputs"]>().toEqualTypeOf<{
      readonly appId: string;
      readonly appSecret: string;
    }>();
  });

  it("matches exactly the auth methods that declare token revoke", () => {
    expectTypeOf<"github">().toMatchTypeOf<TokenRevokeConnectorType>();
    expectTypeOf<"notion">().not.toMatchTypeOf<TokenRevokeConnectorType>();

    for (const type of connectorTypeSchema.options) {
      for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
        const supportsTokenRevoke = connectorAuthMethodRefHasRevokeKind(
          {
            type,
            authMethod,
          },
          "token-revoke",
        );
        expect(supportsTokenRevoke).toBe(
          getConnectorAuthMethod(type, authMethod)?.revoke.kind ===
            "token-revoke",
        );
      }
    }
  });

  it("detects token revoke support from selected auth method config", () => {
    expect(
      connectorAuthMethodRefHasRevokeKind(
        { type: "github", authMethod: "oauth" },
        "token-revoke",
      ),
    ).toBe(true);
    expect(
      connectorAuthMethodRefHasRevokeKind(
        { type: "notion", authMethod: "oauth" },
        "token-revoke",
      ),
    ).toBe(false);
    expect(
      connectorAuthMethodRefHasRevokeKind(
        { type: "stripe", authMethod: "api-token" },
        "token-revoke",
      ),
    ).toBe(false);
  });
  it("does not mark non-refreshable auth methods as refresh-token access", () => {
    expect(
      connectorAuthMethodRefHasAccessKind(
        { type: "github", authMethod: "oauth" },
        "refresh-token",
      ),
    ).toBe(false);
    expect(
      getConnectorAuthMethodAccessMetadata("github", "oauth")?.kind,
    ).not.toBe("refresh-token");
  });

  it("supports multiple provider-backed auth-code methods for one connector", async () => {
    expect(
      connectorAuthMethodHasGrantKind("test-oauth", "oauth", "auth-code"),
    ).toBe(true);
    expect(
      connectorAuthMethodHasGrantKind("test-oauth", "api", "auth-code"),
    ).toBe(true);
    expect(
      connectorAuthMethodHasGrantKind("test-oauth", "missing", "auth-code"),
    ).toBe(false);
    expect(
      connectorAuthMethodHasGrantKind("test-oauth", "api", "device-auth"),
    ).toBe(false);
    expect(
      connectorAuthMethodRefHasAccessKind(
        { type: "test-oauth", authMethod: "oauth" },
        "refresh-token",
      ),
    ).toBe(true);
    expect(
      connectorAuthMethodRefHasAccessKind(
        { type: "test-oauth", authMethod: "api" },
        "refresh-token",
      ),
    ).toBe(true);
    expect(
      connectorAuthMethodRefHasAccessKind(
        { type: "test-oauth", authMethod: "api-token" },
        "refresh-token",
      ),
    ).toBe(true);
    expect(
      getConnectorAuthMethodIdsForAccessKind("test-oauth", "refresh-token"),
    ).toStrictEqual(["oauth", "api-token", "api"]);
    expect(
      getConnectorAuthMethodEnvBindings("test-oauth", "api"),
    ).toStrictEqual({
      TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_API_ACCESS_TOKEN",
    });
    expect(
      getConnectorAuthMethodEnvBindings("test-oauth", "api-token"),
    ).toStrictEqual({
      TEST_OAUTH_API_TOKEN: "$secrets.TEST_OAUTH_API_TOKEN_ACCESS_TOKEN",
    });

    const authClient = resolveConnectorAuthClientForMethod(
      "test-oauth",
      "api",
      () => {
        return undefined;
      },
    );
    expect(authClient).toBeDefined();
    if (!authClient) {
      throw new Error("Expected test-oauth API auth client");
    }

    const authResult = await buildConnectorAuthCodeAuthorizationUrl({
      type: "test-oauth",
      authMethod: "api",
      authClient,
      redirectUri: "https://app.test/callback",
      state: "state-123",
    });
    const authorizationUrl =
      typeof authResult === "string" ? authResult : authResult.url;
    const url = new URL(authorizationUrl);

    expect(url.pathname).toBe("/api/test/oauth-provider/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-oauth-client");
    expect(url.searchParams.get("scope")).toBe("read");
  });

  it("revokes OAuth tokens through the provider registry", async () => {
    const readEnv: ConnectorEnvReader = (name) => {
      if (name === "GH_OAUTH_CLIENT_ID") {
        return "test-github-client";
      }
      if (name === "GH_OAUTH_CLIENT_SECRET") {
        return "test-github-secret";
      }
      return undefined;
    };

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
      revokeConnectorAuthMethodAccessToken({
        type: "github",
        authMethod: "oauth",
        readEnv,
        loadInputs: () => {
          return { accessToken: "gh-access-token" };
        },
      }),
    ).resolves.toStrictEqual({ status: "revoked" });
    expect(authorization).toBe(
      `Basic ${btoa("test-github-client:test-github-secret")}`,
    );
    expect(body).toBe(JSON.stringify({ access_token: "gh-access-token" }));
  });

  it("returns unsupported for connectors without revoke support", async () => {
    let loadedInputs = false;

    await expect(
      revokeConnectorAuthMethodAccessToken({
        type: "notion",
        authMethod: "oauth",
        readEnv: () => {
          return undefined;
        },
        loadInputs: () => {
          loadedInputs = true;
          return { accessToken: "notion-access-token" };
        },
      }),
    ).resolves.toStrictEqual({ status: "unsupported" });
    expect(loadedInputs).toBe(false);
  });

  it("returns unsupported for selected auth methods without token revoke", async () => {
    let loadedInputs = false;

    await expect(
      revokeConnectorAuthMethodAccessToken({
        type: "github",
        authMethod: "api-token",
        readEnv: () => {
          return undefined;
        },
        loadInputs: () => {
          loadedInputs = true;
          return { accessToken: "gh-access-token" };
        },
      }),
    ).resolves.toStrictEqual({ status: "unsupported" });
    expect(loadedInputs).toBe(false);
  });

  it("returns unsupported without loading inputs when revoke client env is missing", async () => {
    let loadedInputs = false;

    await expect(
      revokeConnectorAuthMethodAccessToken({
        type: "github",
        authMethod: "oauth",
        readEnv: () => {
          return undefined;
        },
        loadInputs: () => {
          loadedInputs = true;
          return { accessToken: "gh-access-token" };
        },
      }),
    ).resolves.toStrictEqual({ status: "unsupported" });
    expect(loadedInputs).toBe(false);
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
          authMethod: "oauth",
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
      authMethod: "oauth",
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
        authMethod: "oauth",
        authClient: oauthClient,
        deviceCode: "pending",
      }),
    ).resolves.toStrictEqual({ status: "pending" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authMethod: "oauth",
        authClient: oauthClient,
        deviceCode: "slow-down",
      }),
    ).resolves.toStrictEqual({ status: "slow_down" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "test-oauth-device",
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
        authClient: oauthClient,
        deviceCode: startResult.deviceCode,
      }),
    ).resolves.toStrictEqual({
      status: "complete",
      token: {
        outputs: {
          accessToken:
            "test-device-access:test-oauth-device-client:test-device:test-oauth-device-client:read",
        },
        expiresIn: 3600,
        scopes: ["read"],
        userInfo: {
          id: "test-oauth-device-user",
          username: "test-oauth-device-user",
          email: "test-oauth-device@example.com",
        },
      },
    });
  });

  it("keeps test OAuth device provider access secrets method-specific", () => {
    expect(
      getConnectorAuthMethodGrantMetadata("test-oauth-device", "oauth")?.outputs
        .accessToken?.secretName,
    ).toBe(TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME);
    expect(
      getConnectorAuthMethodGrantMetadata("test-oauth-device", "api")?.outputs
        .accessToken?.secretName,
    ).toBe(TEST_OAUTH_DEVICE_API_ACCESS_SECRET_NAME);
  });

  it("refreshes an input-only connector access provider without an auth client", async () => {
    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "test-oauth",
        authMethod: "api-token",
        inputs: {
          inputSecret: "secret-input",
          inputVariable: "variable-input",
        },
        signal: testRefreshSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "fresh-test-oauth-api-token:secret-input:variable-input",
      },
      expiresIn: 3600,
    });
  });

  it("refreshes Lark tenant access through the non-OAuth access provider", async () => {
    server.use(
      http.post(
        "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        async ({ request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            app_id: "lark-app-id",
            app_secret: "lark-app-secret",
          });
          return HttpResponse.json({
            code: 0,
            msg: "ok",
            tenant_access_token: "lark-tenant-access-token",
            expire: 7200,
          });
        },
      ),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "lark",
        authMethod: "api-token",
        inputs: {
          appId: "lark-app-id",
          appSecret: "lark-app-secret",
        },
        signal: testRefreshSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "lark-tenant-access-token",
      },
      expiresIn: 7200,
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
        authMethod: "oauth",
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
        authMethod: "oauth",
        authClient: oauthClient,
        deviceCode: "pending",
      }),
    ).resolves.toStrictEqual({ status: "pending" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "base44",
        authMethod: "oauth",
        authClient: oauthClient,
        deviceCode: "slow-down",
      }),
    ).resolves.toStrictEqual({ status: "slow_down" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "base44",
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
        authClient: oauthClient,
        deviceCode: "base44-device-code",
      }),
    ).resolves.toStrictEqual({
      status: "complete",
      token: {
        outputs: {
          accessToken: "base44-access-token",
          refreshToken: "base44-refresh-token",
        },
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
        authMethod: "oauth",
        authClient: oauthClient,
        inputs: {
          refreshToken: "base44-refresh-rotation",
        },
        signal: testRefreshSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "base44-access-refreshed",
        refreshToken: "base44-refresh-rotated",
      },
      expiresIn: 3600,
    });
    await expect(
      refreshConnectorAuthProviderAccessToken({
        type: "base44",
        authMethod: "oauth",
        authClient: oauthClient,
        inputs: {
          refreshToken: "base44-refresh-without-rotation",
        },
        signal: testRefreshSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "base44-access-refreshed",
      },
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
        authMethod: "oauth",
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
        authMethod: "oauth",
        authClient: oauthClient,
        deviceCode: "pending",
      }),
    ).resolves.toStrictEqual({ status: "pending" });
    await expect(
      pollConnectorDeviceAuthorization({
        type: "slock",
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
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
        authMethod: "oauth",
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
      authMethod: "oauth",
      authClient: oauthClient,
      deviceCode: "slock-device-code",
    });
    expect(completeResult).toMatchObject({
      status: "complete",
      token: {
        outputs: {
          accessToken: slockAccessToken,
          refreshToken: "slock-refresh-token",
        },
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
      authMethod: "oauth",
      authClient: oauthClient,
      deviceCode: "malformed-token",
    });
    expect(malformedCompleteResult).toMatchObject({
      status: "complete",
      token: {
        outputs: {
          accessToken: slockMalformedAccessToken,
          refreshToken: "slock-refresh-malformed",
        },
        expiresIn: undefined,
      },
    });

    const refreshResult = await refreshConnectorAuthProviderAccessToken({
      type: "slock",
      authMethod: "oauth",
      authClient: oauthClient,
      inputs: {
        refreshToken: "slock-refresh-token",
      },
      signal: testRefreshSignal(),
    });
    expect(refreshResult).toStrictEqual({
      outputs: {
        accessToken: slockRefreshedAccessToken,
        refreshToken: "slock-refresh-rotated",
      },
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
        authMethod: "oauth",
        authClient: oauthClient,
        inputs: {
          refreshToken: "slock-refresh-malformed",
        },
        signal: testRefreshSignal(),
      }),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: slockMalformedAccessToken,
        refreshToken: "slock-refresh-malformed-rotated",
      },
    });
  });
});

describe("getConfiguredConnectorAuthMethodIds", () => {
  it("returns configured auth methods without feature filtering", () => {
    expect(getConfiguredConnectorAuthMethodIds("stripe")).toStrictEqual([
      "oauth",
      "api-token",
    ]);
  });
});

describe("getAvailableConnectorAuthMethodIds", () => {
  it("exposes Stripe API-token auth without CLI auth", () => {
    expect(getAvailableConnectorAuthMethodIds("stripe", {})).toStrictEqual([
      "api-token",
    ]);
  });

  it("exposes BentoML API-token auth only when its switch is enabled", () => {
    expect(getAvailableConnectorAuthMethodIds("bentoml", {})).toStrictEqual([]);
    expect(
      getAvailableConnectorAuthMethodIds("bentoml", {
        [FeatureSwitchKey.BentomlConnector]: true,
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("exposes Base44 OAuth without a feature switch", () => {
    expect(getAvailableConnectorAuthMethodIds("base44", {})).toStrictEqual([
      "oauth",
    ]);
  });

  it("exposes Slock OAuth without a feature switch", () => {
    expect(getAvailableConnectorAuthMethodIds("slock", {})).toStrictEqual([
      "oauth",
    ]);
  });

  it("exposes Lark API-token auth only when its switch is enabled", () => {
    expect(getAvailableConnectorAuthMethodIds("lark", {})).toStrictEqual([]);
    expect(
      getAvailableConnectorAuthMethodIds("lark", {
        [FeatureSwitchKey.LarkConnector]: true,
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("exposes Doubao API-token auth without a feature switch", () => {
    expect(getAvailableConnectorAuthMethodIds("doubao", {})).toStrictEqual([
      "api-token",
    ]);
  });

  it("exposes WeRead API-token auth without a feature switch", () => {
    expect(getAvailableConnectorAuthMethodIds("weread", {})).toStrictEqual([
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
    expect(
      getConnectorAuthMethodAccessMetadata("stripe", "oauth"),
    ).toStrictEqual({
      kind: "refresh-token",
      inputs: {
        refreshToken: {
          valueRef: "$secrets.STRIPE_REFRESH_TOKEN",
          source: {
            kind: "connector-secret",
            name: "STRIPE_REFRESH_TOKEN",
          },
        },
      },
      outputs: {
        accessToken: {
          valueRef: "$secrets.STRIPE_ACCESS_TOKEN",
          secretName: "STRIPE_ACCESS_TOKEN",
        },
        refreshToken: {
          valueRef: "$secrets.STRIPE_REFRESH_TOKEN",
          secretName: "STRIPE_REFRESH_TOKEN",
        },
      },
      refreshableSecrets: ["STRIPE_ACCESS_TOKEN"],
      envBindings: {
        STRIPE_TOKEN: "$secrets.STRIPE_ACCESS_TOKEN",
      },
      platformSecrets: [],
    });
  });

  it("returns static access metadata for the selected API-token method", () => {
    expect(
      getConnectorAuthMethodAccessMetadata("stripe", "api-token"),
    ).toStrictEqual({
      kind: "static",
      envBindings: {
        STRIPE_TOKEN: "$secrets.STRIPE_TOKEN",
      },
      platformSecrets: [],
    });
  });

  it("returns platform-owned secret metadata for Google Ads", () => {
    expect(
      getConnectorAuthMethodAccessMetadata("google-ads", "oauth"),
    ).toStrictEqual({
      kind: "refresh-token",
      inputs: {
        refreshToken: {
          valueRef: "$secrets.GOOGLE_ADS_REFRESH_TOKEN",
          source: {
            kind: "connector-secret",
            name: "GOOGLE_ADS_REFRESH_TOKEN",
          },
        },
      },
      outputs: {
        accessToken: {
          valueRef: "$secrets.GOOGLE_ADS_ACCESS_TOKEN",
          secretName: "GOOGLE_ADS_ACCESS_TOKEN",
        },
        refreshToken: {
          valueRef: "$secrets.GOOGLE_ADS_REFRESH_TOKEN",
          secretName: "GOOGLE_ADS_REFRESH_TOKEN",
        },
      },
      refreshableSecrets: ["GOOGLE_ADS_ACCESS_TOKEN"],
      envBindings: {
        GOOGLE_ADS_TOKEN: "$secrets.GOOGLE_ADS_ACCESS_TOKEN",
        GOOGLE_ADS_DEVELOPER_TOKEN: "$secrets.GOOGLE_ADS_DEVELOPER_TOKEN",
      },
      platformSecrets: ["GOOGLE_ADS_DEVELOPER_TOKEN"],
    });
  });

  it("supports multi-input and multi-output refresh metadata", () => {
    expect(
      getConnectorAuthMethodAccessMetadata("test-oauth", "api"),
    ).toStrictEqual({
      kind: "refresh-token",
      inputs: {
        apiRefreshToken: {
          valueRef: "$secrets.TEST_OAUTH_API_REFRESH_TOKEN",
          source: {
            kind: "connector-secret",
            name: "TEST_OAUTH_API_REFRESH_TOKEN",
          },
        },
        tenantId: {
          valueRef: "$vars.TEST_OAUTH_API_TENANT_ID",
          source: {
            kind: "connector-variable",
            name: "TEST_OAUTH_API_TENANT_ID",
          },
        },
      },
      outputs: {
        refreshedAccessToken: {
          valueRef: "$secrets.TEST_OAUTH_API_ACCESS_TOKEN",
          secretName: "TEST_OAUTH_API_ACCESS_TOKEN",
        },
        refreshedRefreshToken: {
          valueRef: "$secrets.TEST_OAUTH_API_REFRESH_TOKEN",
          secretName: "TEST_OAUTH_API_REFRESH_TOKEN",
        },
        secondaryToken: {
          valueRef: "$secrets.TEST_OAUTH_API_SECONDARY_TOKEN",
          secretName: "TEST_OAUTH_API_SECONDARY_TOKEN",
        },
      },
      refreshableSecrets: ["TEST_OAUTH_API_ACCESS_TOKEN"],
      envBindings: {
        TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_API_ACCESS_TOKEN",
      },
      platformSecrets: [],
    });
  });

  it("supports input-only refresh metadata", () => {
    expect(
      getConnectorAuthMethodAccessMetadata("test-oauth", "api-token"),
    ).toStrictEqual({
      kind: "refresh-token",
      inputs: {
        inputSecret: {
          valueRef: "$secrets.TEST_OAUTH_TOKEN",
          source: {
            kind: "connector-secret",
            name: "TEST_OAUTH_TOKEN",
          },
        },
        inputVariable: {
          valueRef: "$vars.TEST_OAUTH_API_TOKEN_INPUT_VAR",
          source: {
            kind: "connector-variable",
            name: "TEST_OAUTH_API_TOKEN_INPUT_VAR",
          },
        },
      },
      outputs: {
        accessToken: {
          valueRef: "$secrets.TEST_OAUTH_API_TOKEN_ACCESS_TOKEN",
          secretName: "TEST_OAUTH_API_TOKEN_ACCESS_TOKEN",
        },
      },
      refreshableSecrets: ["TEST_OAUTH_API_TOKEN_ACCESS_TOKEN"],
      envBindings: {
        TEST_OAUTH_API_TOKEN: "$secrets.TEST_OAUTH_API_TOKEN_ACCESS_TOKEN",
      },
      platformSecrets: [],
    });
  });

  it("returns Lark refresh-token access metadata for manual app credentials", () => {
    expect(getApiTokenManualGrantFields("lark")).toStrictEqual({
      LARK_APP_ID: {
        label: "App ID",
        required: true,
        storage: "variable",
      },
      LARK_APP_SECRET: {
        label: "App Secret",
        required: true,
        storage: "secret",
      },
    });
    expect(
      getConnectorAuthMethodAccessMetadata("lark", "api-token"),
    ).toStrictEqual({
      kind: "refresh-token",
      inputs: {
        appId: {
          valueRef: "$vars.LARK_APP_ID",
          source: {
            kind: "connector-variable",
            name: "LARK_APP_ID",
          },
        },
        appSecret: {
          valueRef: "$secrets.LARK_APP_SECRET",
          source: {
            kind: "connector-secret",
            name: "LARK_APP_SECRET",
          },
        },
      },
      outputs: {
        accessToken: {
          valueRef: "$secrets.LARK_ACCESS_TOKEN",
          secretName: "LARK_ACCESS_TOKEN",
        },
      },
      refreshableSecrets: ["LARK_ACCESS_TOKEN"],
      envBindings: {
        LARK_TOKEN: "$secrets.LARK_ACCESS_TOKEN",
      },
      platformSecrets: [],
    });
    expect(
      getConnectorAuthMethodEnvBindings("lark", "api-token"),
    ).toStrictEqual({
      LARK_TOKEN: "$secrets.LARK_ACCESS_TOKEN",
    });
  });

  it("returns undefined for an unknown auth method", () => {
    expect(
      getConnectorAuthMethodAccessMetadata("stripe", "missing"),
    ).toBeUndefined();
  });

  it("keeps platform-owned secrets referenced by selected env bindings", () => {
    for (const type of connectorTypeSchema.options) {
      for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
        const accessMetadata = getConnectorAuthMethodAccessMetadata(
          type,
          authMethod,
        );
        if (!accessMetadata) {
          continue;
        }
        const secretRefs = new Set(Object.values(accessMetadata.envBindings));
        for (const secretName of accessMetadata.platformSecrets) {
          expect(
            secretRefs.has(`$secrets.${secretName}`),
            `${type}/${authMethod}: platform secret ${secretName} must be exposed through envBindings`,
          ).toBe(true);
        }
        const platformSecretNames: ReadonlySet<string> = new Set(
          accessMetadata.platformSecrets,
        );
        const ownedSecretNames: ReadonlySet<string> = new Set(
          getConnectorOwnedSecretNames(type, authMethod),
        );
        for (const secretName of platformSecretNames) {
          expect(
            ownedSecretNames.has(secretName),
            `${type}/${authMethod}: platform secret ${secretName} must not be connector-owned`,
          ).toBe(false);
        }
        const method = getConnectorAuthMethod(type, authMethod);
        if (method?.grant.kind === "manual") {
          for (const [name, field] of Object.entries(method.grant.fields)) {
            if (field.storage === "variable") {
              continue;
            }
            expect(
              platformSecretNames.has(name),
              `${type}/${authMethod}: manual grant secret ${name} must stay connector-owned`,
            ).toBe(false);
          }
        }
        if (accessMetadata.kind === "refresh-token") {
          for (const output of Object.values(accessMetadata.outputs)) {
            expect(
              platformSecretNames.has(output.secretName),
              `${type}/${authMethod}: refresh output storage must stay connector-owned`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("excludes platform-owned sources from connector-owned secret names", () => {
    expect(getConnectorOwnedSecretNames("google-ads", "oauth")).toStrictEqual([
      "GOOGLE_ADS_ACCESS_TOKEN",
      "GOOGLE_ADS_REFRESH_TOKEN",
    ]);
  });
});

describe("getConnectorAuthMethodRuntimeMetadata", () => {
  it("returns static provider storage and runtime bindings", () => {
    expect(
      getConnectorAuthMethodRuntimeMetadata("github", "oauth"),
    ).toStrictEqual({
      storage: {
        secrets: ["GITHUB_ACCESS_TOKEN"],
        variables: [],
      },
      runtimeBindings: [
        {
          envName: "GH_TOKEN",
          valueRef: "$secrets.GITHUB_ACCESS_TOKEN",
          optional: false,
          source: {
            kind: "connector-secret",
            name: "GITHUB_ACCESS_TOKEN",
          },
        },
        {
          envName: "GITHUB_TOKEN",
          valueRef: "$secrets.GITHUB_ACCESS_TOKEN",
          optional: false,
          source: {
            kind: "connector-secret",
            name: "GITHUB_ACCESS_TOKEN",
          },
        },
      ],
    });
  });

  it("keeps manual static API tokens role-free", () => {
    expect(
      getConnectorAuthMethodRuntimeMetadata("stripe", "api-token"),
    ).toStrictEqual({
      storage: {
        secrets: ["STRIPE_TOKEN"],
        variables: [],
      },
      runtimeBindings: [
        {
          envName: "STRIPE_TOKEN",
          valueRef: "$secrets.STRIPE_TOKEN",
          optional: false,
          source: {
            kind: "connector-secret",
            name: "STRIPE_TOKEN",
          },
        },
      ],
    });
  });

  it("represents provider extra secrets as storage-owned runtime sources", () => {
    expect(
      getConnectorAuthMethodRuntimeMetadata("slock", "oauth"),
    ).toStrictEqual({
      storage: {
        secrets: [
          "SLOCK_ACCESS_TOKEN",
          "SLOCK_SERVER_ID",
          "SLOCK_REFRESH_TOKEN",
        ],
        variables: [],
      },
      runtimeBindings: [
        {
          envName: "SLOCK_TOKEN",
          valueRef: "$secrets.SLOCK_ACCESS_TOKEN",
          optional: false,
          source: {
            kind: "connector-secret",
            name: "SLOCK_ACCESS_TOKEN",
          },
        },
        {
          envName: "SLOCK_SERVER_ID",
          valueRef: "$secrets.SLOCK_SERVER_ID",
          optional: false,
          source: {
            kind: "connector-secret",
            name: "SLOCK_SERVER_ID",
          },
        },
      ],
    });
  });

  it("represents platform secrets as platform runtime sources", () => {
    expect(
      getConnectorAuthMethodRuntimeMetadata("google-ads", "oauth"),
    ).toStrictEqual({
      storage: {
        secrets: ["GOOGLE_ADS_ACCESS_TOKEN", "GOOGLE_ADS_REFRESH_TOKEN"],
        variables: [],
      },
      runtimeBindings: [
        {
          envName: "GOOGLE_ADS_TOKEN",
          valueRef: "$secrets.GOOGLE_ADS_ACCESS_TOKEN",
          optional: false,
          source: {
            kind: "connector-secret",
            name: "GOOGLE_ADS_ACCESS_TOKEN",
          },
        },
        {
          envName: "GOOGLE_ADS_DEVELOPER_TOKEN",
          valueRef: "$secrets.GOOGLE_ADS_DEVELOPER_TOKEN",
          optional: false,
          source: {
            kind: "platform-secret",
            name: "GOOGLE_ADS_DEVELOPER_TOKEN",
          },
        },
      ],
    });
  });

  it("preserves optional env binding availability as optional runtime metadata", () => {
    expect(
      getConnectorAuthMethodRuntimeMetadata("agora", "api-token"),
    ).toMatchObject({
      runtimeBindings: expect.arrayContaining([
        {
          envName: "AGORA_APP_CERTIFICATE",
          valueRef: "$secrets.AGORA_APP_CERTIFICATE",
          optional: true,
          source: {
            kind: "connector-secret",
            name: "AGORA_APP_CERTIFICATE",
          },
        },
      ]),
    });
  });

  it("does not use legacy required metadata in connector envBindings", () => {
    for (const type of connectorTypeSchema.options) {
      for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
        const method = getConnectorAuthMethod(type, authMethod);
        if (!method) {
          continue;
        }
        if (method.access.kind === "none") {
          continue;
        }
        for (const [envName, binding] of Object.entries(
          method.access.envBindings,
        )) {
          if (typeof binding === "string") {
            continue;
          }
          expect(
            "required" in binding,
            `${type}/${authMethod}: env binding ${envName} must use optional: true instead of required: false`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps manual grant field requiredness separate from env binding availability", () => {
    expect(getConnectorAuthMethod("gitlab", "api-token")?.grant).toMatchObject({
      kind: "manual",
      fields: {
        GITLAB_HOST: {
          required: false,
          storage: "variable",
        },
      },
    });
  });

  it("marks runtime bindings for optional manual fields as optional", () => {
    for (const type of connectorTypeSchema.options) {
      for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
        const method = getConnectorAuthMethod(type, authMethod);
        const runtimeMetadata = getConnectorAuthMethodRuntimeMetadata(
          type,
          authMethod,
        );
        if (!method || !runtimeMetadata || method.grant.kind !== "manual") {
          continue;
        }

        for (const [fieldName, field] of Object.entries(method.grant.fields)) {
          if (field.required !== false) {
            continue;
          }
          const sourceKind =
            field.storage === "variable"
              ? "connector-variable"
              : "connector-secret";
          const runtimeBindings = runtimeMetadata.runtimeBindings.filter(
            (binding) => {
              return (
                binding.source.kind === sourceKind &&
                binding.source.name === fieldName
              );
            },
          );
          for (const binding of runtimeBindings) {
            expect(
              binding.optional,
              `${type}/${authMethod}: optional field ${fieldName} must be marked as an optional runtime binding`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe("getConnectorAuthMethodGrantMetadata", () => {
  it("returns provider output secret mappings for OAuth grants", () => {
    expect(
      getConnectorAuthMethodGrantMetadata("linear", "oauth"),
    ).toStrictEqual({
      kind: "auth-code",
      outputs: {
        accessToken: {
          valueRef: "$secrets.LINEAR_ACCESS_TOKEN",
          secretName: "LINEAR_ACCESS_TOKEN",
        },
        refreshToken: {
          valueRef: "$secrets.LINEAR_REFRESH_TOKEN",
          secretName: "LINEAR_REFRESH_TOKEN",
        },
      },
    });
  });
});

describe("getConnectorAuthMethodRevokeMetadata", () => {
  it("returns provider input secret mappings for token revoke", () => {
    expect(
      getConnectorAuthMethodRevokeMetadata("github", "oauth"),
    ).toStrictEqual({
      kind: "token-revoke",
      inputs: {
        accessToken: {
          valueRef: "$secrets.GITHUB_ACCESS_TOKEN",
          secretName: "GITHUB_ACCESS_TOKEN",
        },
      },
    });
  });
});

describe("getConnectorOwnedVariableNames", () => {
  it("returns manual grant variable fields for the exact auth method", () => {
    expect(
      new Set(getConnectorOwnedVariableNames("zendesk", "api-token")),
    ).toEqual(new Set(["ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"]));
  });

  it("returns no variables for an auth method without variable fields", () => {
    expect(getConnectorOwnedVariableNames("ahrefs", "oauth")).toEqual([]);
  });
});

describe("getConnectorEnvBindingEntries", () => {
  function envBindingsForSingleMethod(type: ConnectorType, authMethod: string) {
    return Object.fromEntries(
      getConnectorEnvBindingEntries(type)
        .filter((entry) => {
          return entry.authMethod === authMethod;
        })
        .map((entry) => {
          return [entry.envName, entry.valueRef];
        }),
    );
  }

  it("returns non-empty env binding entries for connector types that surface environment entries to the sandbox", () => {
    for (const type of connectorTypeSchema.options) {
      expect(
        getConnectorEnvBindingEntries(type).length,
        `${type} has empty env binding entries`,
      ).toBeGreaterThan(0);
    }
  });

  it("returns correct env binding entries for API-token-only connector", () => {
    expect(envBindingsForSingleMethod("axiom", "api-token")).toEqual({
      AXIOM_TOKEN: "$secrets.AXIOM_TOKEN",
    });
  });

  it("returns correct env binding entries for apollo connector", () => {
    expect(envBindingsForSingleMethod("apollo", "api-token")).toEqual({
      APOLLO_TOKEN: "$secrets.APOLLO_TOKEN",
    });
  });

  it("returns correct env binding entries for SproutGigs connector", () => {
    expect(envBindingsForSingleMethod("sproutgigs", "api-token")).toEqual({
      SPROUTGIGS_USER_ID: "$vars.SPROUTGIGS_USER_ID",
      SPROUTGIGS_API_SECRET: "$secrets.SPROUTGIGS_API_SECRET",
    });
  });

  it("returns correct env binding entries for API-token connector with variables", () => {
    expect(envBindingsForSingleMethod("jira", "api-token")).toEqual({
      JIRA_API_TOKEN: "$secrets.JIRA_API_TOKEN",
      JIRA_DOMAIN: "$vars.JIRA_DOMAIN",
      JIRA_EMAIL: "$vars.JIRA_EMAIL",
    });
  });

  it("preserves all env binding entries for hybrid connectors", () => {
    expect(getConnectorEnvBindingEntries("ahrefs")).toEqual([
      {
        authMethod: "oauth",
        envName: "AHREFS_TOKEN",
        valueRef: "$secrets.AHREFS_ACCESS_TOKEN",
      },
      {
        authMethod: "api-token",
        envName: "AHREFS_TOKEN",
        valueRef: "$secrets.AHREFS_TOKEN",
      },
    ]);
  });

  it("returns correct env binding entries for OAuth-only connector", () => {
    expect(envBindingsForSingleMethod("github", "oauth")).toEqual({
      GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
    });
  });

  it("returns correct env binding entries for Base44", () => {
    expect(envBindingsForSingleMethod("base44", "oauth")).toEqual({
      BASE44_TOKEN: "$secrets.BASE44_ACCESS_TOKEN",
    });
  });

  it("returns correct env binding entries for Slock", () => {
    expect(envBindingsForSingleMethod("slock", "oauth")).toEqual({
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

  it("authorization-grant auth methods keep the documented secret naming convention", () => {
    // This is a registry naming convention. Runtime behavior must use
    // grant output metadata and runtimeBindings, not infer roles from names.
    for (const type of connectorTypeSchema.options) {
      if (!hasConnectorAuthorizationGrant(type)) continue;

      const oauthAuthMethodRef: ConnectorAuthMethodRef = {
        type,
        authMethod: "oauth",
      };
      const hasRefreshTokenAccess = connectorAuthMethodRefHasAccessKind(
        oauthAuthMethodRef,
        "refresh-token",
      );
      const grantMetadata = getConnectorAuthMethodGrantMetadata(type, "oauth");
      const runtimeMetadata = getConnectorAuthMethodRuntimeMetadata(
        type,
        "oauth",
      );
      if (!runtimeMetadata) {
        throw new Error(`${type}: missing OAuth storage metadata`);
      }
      if (!grantMetadata) {
        throw new Error(`${type}: missing OAuth grant metadata`);
      }
      const accessSecretName = getConnectorGrantOutputSecretName(
        grantMetadata,
        "accessToken",
      );
      expect(
        accessSecretName,
        `${type}: OAuth auth method must declare access token storage`,
      ).toBeDefined();
      if (!accessSecretName) {
        continue;
      }
      expect(
        accessSecretName.endsWith("_ACCESS_TOKEN"),
        `${type}: access token role must keep the _ACCESS_TOKEN naming convention`,
      ).toBe(true);

      const oauthSecrets = getConnectorOwnedSecretNames(type, "oauth");
      const prefix = accessSecretName.replace(/_ACCESS_TOKEN$/, "");
      const refreshSecretName = `${prefix}_REFRESH_TOKEN`;
      expect(
        oauthSecrets,
        `${type}: oauth secrets must include ${accessSecretName}`,
      ).toContain(accessSecretName);

      if (hasRefreshTokenAccess) {
        const accessMetadata = getConnectorAuthMethodAccessMetadata(
          oauthAuthMethodRef.type,
          oauthAuthMethodRef.authMethod,
        );
        expect(
          getConnectorGrantOutputSecretName(grantMetadata, "refreshToken"),
          `${type}: grant must declare refresh token storage`,
        ).toBe(refreshSecretName);
        expect(
          getConnectorRefreshOutputSecretName(accessMetadata, "refreshToken"),
          `${type}: refresh-token access must declare refresh token storage`,
        ).toBe(refreshSecretName);
        expect(
          oauthSecrets,
          `${type}: refresh-token access must include ${refreshSecretName}`,
        ).toContain(refreshSecretName);
      }

      const runtimeSecretNames = runtimeMetadata.runtimeBindings.flatMap(
        (entry) => {
          return entry.source.kind === "connector-secret"
            ? [entry.source.name]
            : [];
        },
      );

      expect(
        runtimeSecretNames,
        `${type}: runtimeBindings must expose the access token role`,
      ).toContain(accessSecretName);

      for (const secretName of runtimeSecretNames) {
        expect(
          oauthSecrets,
          `${type}: runtime secret ${secretName} must be declared by OAuth auth method`,
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
          runtimeSecretNames,
          `${type}: extra OAuth secret ${secretName} must be exposed by runtimeBindings`,
        ).toContain(secretName);
      }

      const expectedAccessRef = `$secrets.${accessSecretName}`;
      const envBindings = getConnectorAuthMethodEnvBindings(type, "oauth");
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
          hasRefreshTokenAccess
            ? [accessSecretName, refreshSecretName]
            : [accessSecretName],
        ),
      );

      // api-token (if exists): exactly one secret XXX_TOKEN
      const apiTokenFields = getApiTokenManualGrantFields(type);
      if (apiTokenFields) {
        const apiTokenSecretFields = Object.entries(apiTokenFields)
          .filter(([, field]) => {
            return field.storage !== "variable";
          })
          .map(([name]) => {
            return name;
          });
        expect(
          apiTokenSecretFields,
          `${type}: api-token must have exactly one secret field ["${prefix}_TOKEN"]`,
        ).toEqual([`${prefix}_TOKEN`]);
      }
    }
  });

  it("static api-token-only connectors expose all fields via envBindings with same name", () => {
    for (const type of connectorTypeSchema.options) {
      if (hasConnectorAuthorizationGrant(type)) continue;
      const fields = getApiTokenManualGrantFields(type);
      if (!fields) continue;

      const fieldNames = Object.keys(fields);
      const envBindings = envBindingsForSingleMethod(type, "api-token");
      const accessMetadata = getConnectorAuthMethodAccessMetadata(
        type,
        "api-token",
      );
      if (accessMetadata?.kind === "refresh-token") {
        const bindingRefs = new Set(Object.values(envBindings));
        for (const refreshableSecretName of accessMetadata.refreshableSecrets) {
          expect(
            bindingRefs.has(`$secrets.${refreshableSecretName}`),
            `${type}: refresh-token api-token envBindings must expose derived access secret ${refreshableSecretName}`,
          ).toBe(true);
        }
        continue;
      }
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
      for (const { envName, valueRef } of getConnectorEnvBindingEntries(type)) {
        expect(
          valueRef.startsWith("$secrets.") || valueRef.startsWith("$vars."),
          `${type}.envBindings["${envName}"] = "${valueRef}" — must start with $secrets. or $vars.`,
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

  it("includes auth-code connectors only when client id and secret are configured", () => {
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
      const env = new Map([
        ["GH_OAUTH_CLIENT_ID", "github-client-id"],
        ["GH_OAUTH_CLIENT_SECRET", "github-client-secret"],
      ]);
      return env.get(name);
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
      const env = new Map([
        ["GH_OAUTH_CLIENT_ID", "github-client-id"],
        ["GH_OAUTH_CLIENT_SECRET", "github-client-secret"],
      ]);
      return env.get(name);
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
    const staticAuthClientIdentity =
      connectorAuthClientIdentity(staticAuthClient);
    expect(staticAuthClientIdentity).toStrictEqual({
      clientRegistration: "static",
      clientType: "confidential",
      clientId: "github-client-id",
    });
    expect("clientSecret" in staticAuthClientIdentity).toBe(false);

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

  it("includes active authorization-grant connectors when their runtime env is configured", () => {
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

describe("getConnectorAuthMethodGrantScopes - google-meet scopes", () => {
  it("uses meetings.space.readonly for google meet oauth scopes", () => {
    const grant = getConnectorAuthMethodAuthCodeGrantConfig(
      "google-meet",
      "oauth",
    );
    const scopes = getConnectorAuthMethodGrantScopes("google-meet", "oauth");
    expect(scopes).toStrictEqual(grant?.scopes);
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/meetings.space.readonly",
    );
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/meetings.conferencerecords.readonly",
    );

    scopes.push("test-mutated-scope");
    expect(
      getConnectorAuthMethodGrantScopes("google-meet", "oauth"),
    ).not.toContain("test-mutated-scope");
  });
});

describe("connector OAuth lifecycle grant helpers", () => {
  it("returns auth-code grant config for GitHub", () => {
    const method = getConnectorAuthMethod("github", "oauth");

    expectTypeOf(
      getConnectorAuthMethodAuthCodeGrantConfig("github", "oauth"),
    ).toEqualTypeOf<ConnectorAuthCodeGrantConfig>();
    const grant = getConnectorAuthMethodAuthCodeGrantConfig("github", "oauth");
    expect(grant).toStrictEqual(method?.grant);
    expect(grant).toMatchObject({
      kind: "auth-code",
      scopes: ["repo", "project", "workflow"],
    });
    expect("tokenUrl" in grant).toBe(false);
    expect("client" in grant).toBe(false);
    expect(method).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        clientIdEnv: "GH_OAUTH_CLIENT_ID",
        clientSecretEnv: "GH_OAUTH_CLIENT_SECRET",
      },
    });
  });

  it("returns device-auth grant config for device-auth connectors", () => {
    expectTypeOf(
      getConnectorAuthMethodDeviceAuthGrantConfig("test-oauth-device", "oauth"),
    ).toEqualTypeOf<ConnectorDeviceAuthGrantConfig>();
    expect(
      getConnectorAuthMethodDeviceAuthGrantConfig("test-oauth-device", "oauth"),
    ).toMatchObject({
      kind: "device-auth",
      scopes: ["read"],
    });
    expect(getConnectorAuthMethod("test-oauth-device", "oauth")).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "test-oauth-device-client",
      },
    });
    expect(
      getConnectorAuthMethodDeviceAuthGrantConfig("test-oauth-device", "api"),
    ).toMatchObject({
      kind: "device-auth",
      scopes: ["read"],
    });
    expect(getConnectorAuthMethod("test-oauth-device", "api")).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "test-oauth-device-api-client",
      },
    });
    expect(
      getConnectorAuthMethodDeviceAuthGrantConfig("base44", "oauth"),
    ).toMatchObject({
      kind: "device-auth",
      scopes: ["apps:read", "apps:write", "offline"],
    });
    expect(getConnectorAuthMethod("base44", "oauth")).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "base44_cli",
      },
    });
    expect(
      getConnectorAuthMethodDeviceAuthGrantConfig("slock", "oauth"),
    ).toMatchObject({
      kind: "device-auth",
      scopes: [],
    });
    expect(getConnectorAuthMethod("slock", "oauth")).toMatchObject({
      client: {
        clientRegistration: "dynamic",
        clientType: "public",
      },
    });
  });

  it("returns undefined for connectors without authorization grants", () => {
    expect(hasConnectorAuthorizationGrant("axiom")).toBe(false);
    expect(
      getConnectorAuthMethodAuthCodeGrantConfig("base44", "oauth"),
    ).toBeUndefined();
    expect(
      getConnectorAuthMethodDeviceAuthGrantConfig("github", "oauth"),
    ).toBeUndefined();
  });
});

describe("connector authorization-code grant config", () => {
  it("declares the current auth-code grant connectors with auth-code grants", () => {
    for (const type of connectorTypeSchema.options) {
      for (const authMethod of getConnectorAuthMethodIdsForGrantKind(
        type,
        "auth-code",
      )) {
        expect(
          getConnectorAuthMethodAuthCodeGrantConfig(type, authMethod)?.kind,
          `${type}:${authMethod}: auth-code grant kind`,
        ).toBe("auth-code");
      }
    }
  });

  it("keeps provider endpoint URLs out of connector OAuth grants", () => {
    for (const type of connectorTypeSchema.options) {
      for (const authMethod of getConnectorAuthMethodIdsForGrantKind(
        type,
        "auth-code",
      )) {
        const grant = getConnectorAuthMethodAuthCodeGrantConfig(
          type,
          authMethod,
        );
        if (!grant) {
          throw new Error(`${type}:${authMethod}: missing auth-code grant`);
        }
        expect(
          "authorizationEndpoint" in grant,
          `${type}:${authMethod}: authorization endpoint should be provider-owned`,
        ).toBe(false);
        expect(
          "authorizationUrl" in grant,
          `${type}:${authMethod}: authorization URL should be provider-owned`,
        ).toBe(false);
        expect(
          "tokenUrl" in grant,
          `${type}:${authMethod}: token URL should be provider-owned`,
        ).toBe(false);
      }
      for (const authMethod of getConnectorAuthMethodIdsForGrantKind(
        type,
        "device-auth",
      )) {
        const grant = getConnectorAuthMethodDeviceAuthGrantConfig(
          type,
          authMethod,
        );
        if (!grant) {
          throw new Error(`${type}:${authMethod}: missing device-auth grant`);
        }
        expect(
          "authorizationEndpoint" in grant,
          `${type}:${authMethod}: authorization endpoint should be provider-owned`,
        ).toBe(false);
        expect(
          "authorizationUrl" in grant,
          `${type}:${authMethod}: authorization URL should be provider-owned`,
        ).toBe(false);
        expect(
          "deviceAuthUrl" in grant,
          `${type}:${authMethod}: device authorization URL should be provider-owned`,
        ).toBe(false);
        expect(
          "tokenUrl" in grant,
          `${type}:${authMethod}: token URL should be provider-owned`,
        ).toBe(false);
      }
    }
  });
});

describe("connector OAuth device authorization config", () => {
  it("declares the test OAuth device connector as a device authorization flow", () => {
    expect(hasConnectorDeviceAuthGrant("test-oauth-device")).toBe(true);
    expect(
      getConnectorAuthMethodDeviceAuthGrantConfig("test-oauth-device", "oauth"),
    ).toMatchObject({
      kind: "device-auth",
      scopes: ["read"],
    });
    expect(getConnectorAuthMethod("test-oauth-device", "oauth")).toMatchObject({
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "test-oauth-device-client",
      },
    });
    expect(getConnectorAuthMethod("test-oauth-device", "api")).toMatchObject({
      grant: {
        kind: "device-auth",
        scopes: ["read"],
      },
      client: {
        clientRegistration: "static",
        clientType: "public",
        clientId: "test-oauth-device-api-client",
      },
    });
  });

  it("declares the Base44 connector as a device authorization flow", () => {
    expect(hasConnectorDeviceAuthGrant("base44")).toBe(true);
    expect(
      getConnectorAuthMethodDeviceAuthGrantConfig("base44", "oauth"),
    ).toMatchObject({
      kind: "device-auth",
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
    expect(
      getConnectorAuthMethodDeviceAuthGrantConfig("slock", "oauth"),
    ).toMatchObject({
      kind: "device-auth",
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

describe("getConnectorStoredSecretDisplayInfo", () => {
  it("returns display env aliases for stored connector secrets", () => {
    expect(
      getConnectorStoredSecretDisplayInfo("GITHUB_ACCESS_TOKEN"),
    ).toStrictEqual({
      connectorLabel: "GitHub",
      envNames: ["GH_TOKEN", "GITHUB_TOKEN"],
    });
  });

  it("returns null for stored connector secrets without runtime env aliases", () => {
    expect(
      getConnectorStoredSecretDisplayInfo("SLOCK_REFRESH_TOKEN"),
    ).toBeNull();
  });

  it("returns null for platform secrets referenced by runtime env aliases", () => {
    expect(
      getConnectorStoredSecretDisplayInfo("GOOGLE_ADS_DEVELOPER_TOKEN"),
    ).toBeNull();
  });

  it("returns null for unknown stored secret names", () => {
    expect(getConnectorStoredSecretDisplayInfo("UNKNOWN_SECRET")).toBeNull();
  });
});

describe("getDiagnosticConnectorTypeForRuntimeEnvName", () => {
  it("finds connector type for runtime env aliases", () => {
    expect(getDiagnosticConnectorTypeForRuntimeEnvName("GH_TOKEN")).toBe(
      "github",
    );
    expect(getDiagnosticConnectorTypeForRuntimeEnvName("GITHUB_TOKEN")).toBe(
      "github",
    );
    expect(getDiagnosticConnectorTypeForRuntimeEnvName("ATLASSIAN_TOKEN")).toBe(
      "atlassian",
    );
    expect(getDiagnosticConnectorTypeForRuntimeEnvName("ATLASSIAN_EMAIL")).toBe(
      "atlassian",
    );
    expect(
      getDiagnosticConnectorTypeForRuntimeEnvName("ATLASSIAN_DOMAIN"),
    ).toBe("atlassian");
  });

  it("does not treat stored secret names as runtime env aliases", () => {
    expect(
      getDiagnosticConnectorTypeForRuntimeEnvName("GITHUB_ACCESS_TOKEN"),
    ).toBeNull();
  });

  it("returns null for unknown runtime env aliases", () => {
    expect(
      getDiagnosticConnectorTypeForRuntimeEnvName("UNKNOWN_SECRET"),
    ).toBeNull();
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
          getConnectorAuthMethodAuthCodeGrantConfig(type, "oauth"),
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
