import { createHash, randomUUID } from "node:crypto";

import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import { cronConnectorCatalogContract } from "@vm0/api-contracts/contracts/cron";
import { connectorsTypeCallbackContract } from "@vm0/api-contracts/contracts/connectors-type-callback";
import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@vm0/api-contracts/contracts/model-provider-firewalls";
import { runnersBuiltinFirewallsResolveContract } from "@vm0/api-contracts/contracts/runners";
import { zeroSecretsContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { zeroSteamPlayerContract } from "@vm0/api-contracts/contracts/zero-steam-player";
import {
  testSystemStoragePresignedUrlCacheStateContract,
  type TestSystemStoragePresignedUrlCacheStateActionBody,
} from "@vm0/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import {
  zeroConnectorOpenIdStartContract,
  zeroConnectorsSearchContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroConnectorCheckContract } from "@vm0/api-contracts/contracts/zero-connector-check";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  zeroWorkflowAutomationsContract,
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import apiPackage from "../../../../package.json";
import { createApp } from "../../../app-factory";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { singleton } from "../../../lib/singleton";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  mockApiTestConnectorProviderConfiguration,
  mutateApiTestConnectorCatalogRuntimeProjection,
} from "../../../test-fixtures/connector-catalog";
import {
  deleteOrgPlanEntitlementFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { createDeferredPromise, settle } from "../../utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
import { readConnectorCredentialStorageState } from "./helpers/connector-credential-storage-state";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsExternalCodeProvider,
  mockDatadogConnectorOAuth,
  mockGmailConnectorOAuth,
  mockSlackConnectorOAuth,
  mockTestOAuthAuthCodeProvider,
  mockTestOAuthDeviceConnectorProvider,
  requestOauthCallbackRaw,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";

const context = testContext();
const zeroMocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const miscApi = createMiscRoutesApi(context);
const CRON_SECRET = "connector-catalog-cron-secret";
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const ACTIVE_KEY = "connectors/v1/active.json";
const FIRST_SYNC_TIME = "2026-07-15T08:00:00.000Z";
const DIAGNOSTICS_USER_ID = `user_${randomUUID()}`;
const DIAGNOSTICS_ORG_ID = `org_${randomUUID()}`;
const PRIVATE_VALUE = "SECRET_TOKEN";
const DEFAULT_API_VERSION = apiPackage.version;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SLACK_OAUTH_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_REVOKE_URL = "https://slack.com/api/auth.revoke";
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const STEAM_TEST_ID = "76561198000000000";

type JsonRecord = Record<string, unknown>;
type JsonMutation = (value: JsonRecord) => void;

function apiDispatchTimingEventForRun(
  runId: string,
  actionType: string,
): JsonRecord {
  const event = context.mocks.axiom.sdkIngest.mock.calls
    .flatMap((call) => {
      const dataset = call[0];
      const events = call[1];
      if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
        return [];
      }
      return events.filter((candidate): candidate is JsonRecord => {
        return (
          typeof candidate === "object" &&
          candidate !== null &&
          !Array.isArray(candidate) &&
          candidate.run_id === runId &&
          candidate.op_type === actionType
        );
      });
    })
    .at(0);
  if (!event) {
    throw new Error(`Missing ${actionType} timing for run ${runId}`);
  }
  return event;
}

interface ReleaseFixtureOptions {
  readonly version: string;
  readonly connectorRef?: string;
  readonly label?: string;
  readonly generatedFirewall?: boolean;
  readonly catalogBytes?: Buffer;
  readonly mutateCatalog?: JsonMutation;
  readonly mutateRuntime?: JsonMutation;
  readonly mutateFirewall?: JsonMutation;
  readonly mutateArtifact?: JsonMutation;
  readonly mutatePointer?: JsonMutation;
}

function createConnectorCleanup(
  actor: ApiTestUser,
  connectorRef: ConnectorRef,
): () => Promise<void> {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  return async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockApiTestConnectorProviderConfiguration();
    await connectorsApi.deleteConnectorByType(actor, connectorRef, [204, 404]);
  };
}

interface ReleaseFixture {
  readonly version: string;
  readonly connectorRef: string;
  readonly pointer: Buffer;
  readonly catalogKey: string;
  readonly objects: ReadonlyMap<string, Buffer>;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array`);
  }
  return value;
}

function firstRecord(value: unknown, label: string): JsonRecord {
  const first = arrayValue(value, label)[0];
  return recordValue(first, `${label}[0]`);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return canonicalJsonValue(item);
    });
  }
  if (!isJsonRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        return [key, canonicalJsonValue(value[key])];
      }),
  );
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function objectEtag(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function catalogTemplate(reference: string): string {
  return `\${{ ${reference} }}`;
}

function releaseKeys(version: string): {
  readonly catalog: string;
} {
  const prefix = `connectors/v1/releases/${version}`;
  return {
    catalog: `${prefix}/catalog.json`,
  };
}

function buildCatalogConnector(args: {
  readonly connectorRef: string;
  readonly label: string;
  readonly iconKey: string;
  readonly firewall?: JsonRecord;
}): JsonRecord {
  const presentationMethod = publicAuthMethod({
    id: "api-token",
    grantKind: "manual",
    manual: true,
  });
  presentationMethod.label = "API Token";
  return {
    connectorRef: args.connectorRef,
    label: args.label,
    description: "An external connector used only by the sync fixture",
    category: "testing",
    generation: [],
    tags: ["fixture"],
    authMethods: [
      canonicalAuthMethod(presentationMethod, defaultRuntimeAuthMethod()),
    ],
    icon: {
      key: args.iconKey,
      invertInDarkMode: false,
    },
    skill: { kind: "none" },
    firewall: args.firewall ?? { kind: "none" },
  };
}

function defaultRuntimeAuthMethod(): JsonRecord {
  return {
    id: "api-token",
    storage: { version: 1, secrets: [PRIVATE_VALUE], variables: [] },
    grant: {
      kind: "manual",
      fields: [
        {
          privateName: PRIVATE_VALUE,
          publicId: "credential",
          storage: "secret",
        },
      ],
    },
    access: {
      kind: "static",
      envBindings: { SERVICE_TOKEN: `$secrets.${PRIVATE_VALUE}` },
    },
    revoke: { kind: "none" },
  };
}

interface FixtureAuthComponents {
  presentation: readonly JsonRecord[];
  runtime: readonly JsonRecord[];
}

const fixtureAuthComponents = singleton(() => {
  return new WeakMap<JsonRecord, FixtureAuthComponents>();
});

function setFixtureAuthComponents(
  artifact: JsonRecord,
  components: FixtureAuthComponents,
): void {
  fixtureAuthComponents().set(artifact, components);
  if (components.presentation.length !== components.runtime.length) {
    return;
  }
  firstRecord(artifact.connectors, "connectors").authMethods =
    components.presentation.map((presentation, index) => {
      return canonicalAuthMethod(presentation, components.runtime[index]);
    });
}

function setArtifactAuthMethods(
  artifact: JsonRecord,
  methods: readonly JsonRecord[],
): void {
  const current = fixtureAuthComponents().get(artifact);
  if (!current) {
    throw new Error("Catalog fixture auth components are not initialized");
  }
  const presentation = methods.every((method) => {
    return typeof method.grantKind === "string";
  });
  setFixtureAuthComponents(artifact, {
    presentation: presentation ? methods : current.presentation,
    runtime: presentation ? current.runtime : methods,
  });
}

function initializeFixtureAuthComponents(artifact: JsonRecord): void {
  const presentationMethod = publicAuthMethod({
    id: "api-token",
    grantKind: "manual",
    manual: true,
  });
  presentationMethod.label = "API Token";
  setFixtureAuthComponents(artifact, {
    presentation: [presentationMethod],
    runtime: [defaultRuntimeAuthMethod()],
  });
}

function assertFixtureAuthComponentsComplete(artifact: JsonRecord): void {
  const components = fixtureAuthComponents().get(artifact);
  if (
    components &&
    components.presentation.length !== components.runtime.length
  ) {
    firstRecord(artifact.connectors, "connectors").authMethods = [
      {
        invalidFixtureAuthMethodCount: {
          presentation: components.presentation.length,
          runtime: components.runtime.length,
        },
      },
    ];
  }
}

function publicAuthMethod(args: {
  readonly id: string;
  readonly grantKind:
    | "manual"
    | "auth-code"
    | "openid-auth"
    | "external-code"
    | "device-auth";
  readonly manual?: boolean;
}): JsonRecord {
  return {
    id: args.id,
    label: `${args.id} auth`,
    description: null,
    visible: true,
    featureSwitch: null,
    grantKind: args.grantKind,
    manualFields: args.manual
      ? [
          {
            id: "credential",
            label: "Credential",
            required: true,
            placeholder: null,
            inputType: "password",
          },
        ]
      : [],
    startOptions: [],
  };
}

function manualPrivateAuthMethod(args: {
  readonly id: string;
  readonly prefix: string;
  readonly access: "static" | "refresh-token";
  readonly revoke: "none" | "token-revoke";
}): JsonRecord {
  const credentialName = `${args.prefix}_CREDENTIAL`;
  const accessTokenName = `${args.prefix}_ACCESS_TOKEN`;
  return {
    id: args.id,
    storage: {
      version: 1,
      secrets:
        args.access === "refresh-token"
          ? [accessTokenName, credentialName]
          : [credentialName],
      variables: [],
    },
    grant: {
      kind: "manual",
      fields: [
        {
          privateName: credentialName,
          publicId: "credential",
          storage: "secret",
        },
      ],
    },
    access:
      args.access === "refresh-token"
        ? {
            kind: "refresh-token",
            envBindings: {
              SERVICE_TOKEN: `$secrets.${accessTokenName}`,
            },
            inputs: { refreshToken: `$secrets.${credentialName}` },
            outputs: {
              accessToken: `$secrets.${accessTokenName}`,
              refreshToken: `$secrets.${credentialName}`,
            },
            refreshableSecrets: [accessTokenName],
          }
        : {
            kind: "static",
            envBindings: { SERVICE_TOKEN: `$secrets.${credentialName}` },
          },
    revoke:
      args.revoke === "token-revoke"
        ? {
            kind: "token-revoke",
            inputs: { token: `$secrets.${credentialName}` },
          }
        : { kind: "none" },
  };
}

function testOauthPrivateAuthMethod(): JsonRecord {
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientId: "test-oauth-client",
      clientSecret: "test-oauth-secret",
    },
    storage: {
      version: 1,
      secrets: ["TEST_OAUTH_ACCESS_TOKEN", "TEST_OAUTH_REFRESH_TOKEN"],
      variables: ["TEST_OAUTH_API_TENANT_ID"],
    },
    grant: {
      kind: "auth-code",
      scopes: ["read"],
      callbackOrigin: "api",
      outputs: {
        accessToken: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
        refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
        tenantId: "$vars.TEST_OAUTH_API_TENANT_ID",
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
        TEST_OAUTH_TENANT_ID: "$vars.TEST_OAUTH_API_TENANT_ID",
      },
      inputs: {
        refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
      },
      outputs: {
        accessToken: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
        refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
      },
      refreshableSecrets: ["TEST_OAUTH_ACCESS_TOKEN"],
    },
    revoke: { kind: "none" },
  };
}

function devicePrivateAuthMethod(args?: {
  readonly accessTokenName?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
}): JsonRecord {
  const accessTokenName = args?.accessTokenName ?? "DEVICE_ACCESS_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "public",
      clientId: args?.clientId ?? "external-device-client",
    },
    storage: { version: 1, secrets: [accessTokenName], variables: [] },
    grant: {
      kind: "device-auth",
      scopes: [...(args?.scopes ?? [])],
      outputs: { accessToken: `$secrets.${accessTokenName}` },
      startOptionMappings: [],
    },
    access: {
      kind: "static",
      envBindings: {
        TEST_OAUTH_DEVICE_TOKEN: `$secrets.${accessTokenName}`,
      },
    },
    revoke: { kind: "none" },
  };
}

function steamPrivateAuthMethod(args?: {
  readonly callbackOrigin?: "web" | "api";
  readonly platformSecret?: string;
  readonly steamIdName?: string;
}): JsonRecord {
  const platformSecret = args?.platformSecret ?? "STEAM_WEB_API_KEY";
  const steamIdName = args?.steamIdName ?? "STEAM_ID";
  return {
    id: "openid",
    storage: { version: 1, secrets: [], variables: [steamIdName] },
    grant: {
      kind: "openid-auth",
      callbackOrigin: args?.callbackOrigin ?? "api",
      outputs: { steamId: `$vars.${steamIdName}` },
    },
    access: {
      kind: "static",
      platformSecrets: [platformSecret],
      envBindings: {
        STEAM_ID: `$vars.${steamIdName}`,
        STEAM_WEB_API_KEY: `$secrets.${platformSecret}`,
      },
    },
    revoke: { kind: "none" },
  };
}

function awsPrivateAuthMethod(): JsonRecord {
  const refreshTokenName = "CATALOG_AWS_LOGIN_REFRESH_TOKEN";
  const dpopKeyName = "CATALOG_AWS_LOGIN_DPOP_KEY";
  const accessKeyIdName = "CATALOG_AWS_ACCESS_KEY_ID";
  const secretAccessKeyName = "CATALOG_AWS_SECRET_ACCESS_KEY";
  const sessionTokenName = "CATALOG_AWS_SESSION_TOKEN";
  const signinRegionName = "CATALOG_AWS_SIGNIN_REGION";
  const runtimeRegionName = "CATALOG_AWS_REGION";
  return {
    id: "cli",
    client: {
      clientRegistration: "static",
      clientType: "public",
      clientId: "arn:aws:signin:::devtools/cross-device",
    },
    storage: {
      version: 1,
      secrets: [
        refreshTokenName,
        dpopKeyName,
        accessKeyIdName,
        secretAccessKeyName,
        sessionTokenName,
      ],
      variables: [signinRegionName, runtimeRegionName],
    },
    grant: {
      kind: "external-code",
      scopes: ["openid"],
      outputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
        dpopKey: `$secrets.${dpopKeyName}`,
        accessKeyId: `$secrets.${accessKeyIdName}`,
        secretAccessKey: `$secrets.${secretAccessKeyName}`,
        sessionToken: `$secrets.${sessionTokenName}`,
        signinRegion: `$vars.${signinRegionName}`,
        runtimeRegion: `$vars.${runtimeRegionName}`,
      },
    },
    access: {
      kind: "refresh-token",
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
        dpopKey: `$secrets.${dpopKeyName}`,
        signinRegion: `$vars.${signinRegionName}`,
      },
      outputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
        accessKeyId: `$secrets.${accessKeyIdName}`,
        secretAccessKey: `$secrets.${secretAccessKeyName}`,
        sessionToken: `$secrets.${sessionTokenName}`,
      },
      refreshableSecrets: [
        accessKeyIdName,
        secretAccessKeyName,
        sessionTokenName,
      ],
      envBindings: {
        AWS_ACCESS_KEY_ID: `$secrets.${accessKeyIdName}`,
        AWS_SECRET_ACCESS_KEY: `$secrets.${secretAccessKeyName}`,
        AWS_SESSION_TOKEN: `$secrets.${sessionTokenName}`,
        AWS_REGION: `$vars.${runtimeRegionName}`,
        AWS_DEFAULT_REGION: `$vars.${runtimeRegionName}`,
      },
    },
    revoke: { kind: "none" },
  };
}

function deelPrivateAuthMethod(): JsonRecord {
  const accessTokenName = "CATALOG_DEEL_ACCESS_TOKEN";
  const refreshTokenName = "CATALOG_DEEL_REFRESH_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "DEEL_OAUTH_CLIENT_ID",
      clientSecretEnv: "DEEL_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName, refreshTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: [],
      callbackOrigin: "web",
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        DEEL_TOKEN: `$secrets.${accessTokenName}`,
      },
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      refreshableSecrets: [accessTokenName],
    },
    revoke: { kind: "none" },
  };
}

function gmailPrivateAuthMethod(): JsonRecord {
  const accessTokenName = "CATALOG_GMAIL_ACCESS_TOKEN";
  const refreshTokenName = "CATALOG_GMAIL_REFRESH_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
      clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName, refreshTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      callbackOrigin: "web",
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        GMAIL_TOKEN: `$secrets.${accessTokenName}`,
      },
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      refreshableSecrets: [accessTokenName],
    },
    revoke: { kind: "none" },
  };
}

function cloudflarePrivateAuthMethod(): JsonRecord {
  const accessTokenName = "CATALOG_CLOUDFLARE_ACCESS_TOKEN";
  const refreshTokenName = "CATALOG_CLOUDFLARE_REFRESH_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "CLOUDFLARE_OAUTH_CLIENT_ID",
      clientSecretEnv: "CLOUDFLARE_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName, refreshTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: [],
      callbackOrigin: "api",
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        CLOUDFLARE_TOKEN: `$secrets.${accessTokenName}`,
      },
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      refreshableSecrets: [accessTokenName],
    },
    revoke: {
      kind: "token-revoke",
      inputs: { refreshToken: `$secrets.${refreshTokenName}` },
    },
  };
}

function unsupportedWebAuthCodePrivateAuthMethod(): JsonRecord {
  const accessTokenName = "FUTURE_WEB_ACCESS_TOKEN";
  return {
    id: "future-web",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "CLOUDFLARE_OAUTH_CLIENT_ID",
      clientSecretEnv: "CLOUDFLARE_OAUTH_CLIENT_SECRET",
    },
    storage: { version: 1, secrets: [accessTokenName], variables: [] },
    grant: {
      kind: "auth-code",
      scopes: [],
      callbackOrigin: "web",
      outputs: { accessToken: `$secrets.${accessTokenName}` },
    },
    access: {
      kind: "static",
      envBindings: { FUTURE_WEB_TOKEN: `$secrets.${accessTokenName}` },
    },
    revoke: { kind: "none" },
  };
}

function slackPrivateAuthMethod(
  accessTokenName = "CATALOG_SLACK_ACCESS_TOKEN",
  storageVersion = 1,
): JsonRecord {
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
      clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: storageVersion,
      secrets: [accessTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: ["channels:read", "chat:write"],
      callbackOrigin: "web",
      outputs: { accessToken: `$secrets.${accessTokenName}` },
    },
    access: {
      kind: "static",
      envBindings: { SLACK_TOKEN: `$secrets.${accessTokenName}` },
    },
    revoke: {
      kind: "token-revoke",
      inputs: { accessToken: `$secrets.${accessTokenName}` },
    },
  };
}

function datadogPrivateAuthMethod(scopes: readonly string[]): JsonRecord {
  const accessTokenName = "CATALOG_DATADOG_ACCESS_TOKEN";
  const refreshTokenName = "CATALOG_DATADOG_REFRESH_TOKEN";
  const domainName = "CATALOG_DATADOG_DOMAIN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "DATADOG_OAUTH_CLIENT_ID",
      clientSecretEnv: "DATADOG_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName, refreshTokenName],
      variables: [domainName],
    },
    grant: {
      kind: "auth-code",
      scopes: [...scopes],
      callbackOrigin: "web",
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
        domain: `$vars.${domainName}`,
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        DATADOG_TOKEN: `$secrets.${accessTokenName}`,
        DATADOG_DOMAIN: `$vars.${domainName}`,
      },
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
        domain: `$vars.${domainName}`,
      },
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      refreshableSecrets: [accessTokenName],
    },
    revoke: { kind: "none" },
  };
}

function buildBundledSkill(
  connectorRef: string,
  versionId = "a".repeat(64),
  metadata: {
    readonly size: number;
    readonly archiveSize: number;
    readonly fileCount: number;
  } = {
    size: Buffer.byteLength(`# ${connectorRef}\n`),
    archiveSize: 321,
    fileCount: 1,
  },
  storageName = `connector-skill@${connectorRef}`,
): JsonRecord {
  const prefix = `__system__/volume/${storageName}/${versionId}`;
  return {
    kind: "bundled",
    storageName,
    versionId,
    storageVersionPrefix: prefix,
    size: metadata.size,
    archiveSize: metadata.archiveSize,
    fileCount: metadata.fileCount,
  };
}

interface BundledSkillFixture {
  readonly descriptor: JsonRecord;
  readonly storageName: string;
  readonly s3Prefix: string;
  readonly versionId: string;
  readonly contentSize: number;
  readonly archiveSize: number;
  readonly manifestKey: string;
  readonly archiveKey: string;
}

function buildBundledSkillFixture(
  connectorRef: string,
  versionId = "a".repeat(64),
  storageName = `connector-skill@${connectorRef}`,
): BundledSkillFixture {
  const contentSize = Buffer.byteLength(`# ${connectorRef}\n`);
  const archiveSize = 321;
  const fileCount = 1;
  const s3Prefix = `${SYSTEM_ORG_ID}/volume/${storageName}`;
  const versionPrefix = `${s3Prefix}/${versionId}`;
  const manifestKey = `${versionPrefix}/manifest.json`;
  const archiveKey = `${versionPrefix}/archive.tar.gz`;
  return {
    descriptor: buildBundledSkill(
      connectorRef,
      versionId,
      {
        size: contentSize,
        archiveSize,
        fileCount,
      },
      storageName,
    ),
    storageName,
    s3Prefix,
    versionId,
    contentSize,
    archiveSize,
    manifestKey,
    archiveKey,
  };
}

function setFirewallBase(artifact: JsonRecord, base: string): void {
  const connector = firstRecord(artifact.connectors, "connectors");
  const firewall = recordValue(connector.firewall, "firewall");
  const config = recordValue(firewall.config, "firewall.config");
  firstRecord(config.apis, "firewall.apis").base = base;
}

function buildGeneratedFirewall(): JsonRecord {
  const base = "https://api.example.test/v1";
  const auth = (): JsonRecord => {
    return {
      headers: {
        Authorization: `Bearer ${catalogTemplate("secrets.SERVICE_TOKEN")}`,
      },
    };
  };
  const permissions = [
    {
      name: "items.read",
      description: "Read items",
      rules: ["GET /items"],
    },
  ];
  return {
    kind: "generated",
    billable: false,
    config: {
      placeholders: { SERVICE_TOKEN: "placeholder-token" },
      apis: [{ base, auth: auth(), permissions }],
    },
    categories: {
      byPermission: { "items.read": "Items" },
      displayOrder: ["Items"],
    },
    defaultAllowed: ["items.read"],
    defaultUnknownPolicy: "deny",
  };
}

const DUPLICATE_DYNAMIC_FIREWALL_BASE = `https://${catalogTemplate("vars.SERVICE_HOST")}.example.test/v1`;
const DUPLICATE_DYNAMIC_FIREWALL_HOST_POLICY = {
  kind: "providerOwned",
  suffixes: [".example.test"],
} as const;

function addDynamicFirewallVariableBinding(artifact: JsonRecord): void {
  const connector = firstRecord(artifact.connectors, "connectors");
  const method = firstRecord(connector.authMethods, "authMethods");
  recordValue(method.storage, "storage").variables = ["SERVICE_HOST"];
  recordValue(
    recordValue(method.access, "access").envBindings,
    "envBindings",
  ).SERVICE_HOST = "$vars.SERVICE_HOST";
}

function addDuplicateDynamicPrivateFirewallApi(
  artifact: JsonRecord,
  options: { readonly conflictingHostPolicy?: boolean } = {},
): void {
  const connector = firstRecord(artifact.connectors, "connectors");
  const firewall = recordValue(connector.firewall, "firewall");
  const config = recordValue(firewall.config, "firewall.config");
  const apis = arrayValue(config.apis, "firewall.apis");
  const firstApi = firstRecord(apis, "firewall.apis");
  firstApi.base = DUPLICATE_DYNAMIC_FIREWALL_BASE;
  firstApi.hostPolicy = DUPLICATE_DYNAMIC_FIREWALL_HOST_POLICY;
  const fallbackApi = structuredClone(firstApi);
  fallbackApi.auth = {};
  fallbackApi.permissions = [];
  fallbackApi.hostPolicy = options.conflictingHostPolicy
    ? { kind: "publicDestination" }
    : DUPLICATE_DYNAMIC_FIREWALL_HOST_POLICY;
  apis.push(fallbackApi);
}

function canonicalGrant(
  publicMethod: JsonRecord,
  privateMethod: JsonRecord,
): JsonRecord {
  const privateGrant = structuredClone(
    recordValue(privateMethod.grant, "private auth method grant"),
  );
  if (privateGrant.kind === "manual") {
    const publicFields = arrayValue(
      publicMethod.manualFields,
      "public manual fields",
    ).map((field) => {
      return recordValue(field, "public manual field");
    });
    privateGrant.fields = arrayValue(
      privateGrant.fields,
      "private manual fields",
    ).map((fieldValue) => {
      const field = recordValue(fieldValue, "private manual field");
      const publicField = publicFields.find((candidate) => {
        return candidate.id === field.publicId;
      });
      return {
        ...field,
        label: publicField?.label,
        required: publicField?.required,
        placeholder: publicField?.placeholder,
      };
    });
  }
  if (privateGrant.kind === "device-auth") {
    const publicOptions = arrayValue(
      publicMethod.startOptions,
      "public device start options",
    ).map((option) => {
      return recordValue(option, "public device start option");
    });
    privateGrant.startOptions = arrayValue(
      privateGrant.startOptionMappings,
      "private device start option mappings",
    ).map((mappingValue) => {
      const mapping = recordValue(
        mappingValue,
        "private device start option mapping",
      );
      const publicOption = publicOptions.find((candidate) => {
        return candidate.id === mapping.publicId;
      });
      return {
        privateName: mapping.privateName,
        publicId: mapping.publicId,
        kind: publicOption?.kind,
        label: publicOption?.label,
        required: publicOption?.required,
        defaultValue: publicOption?.defaultValue,
        options: publicOption?.options,
      };
    });
    delete privateGrant.startOptionMappings;
  }
  return privateGrant;
}

function canonicalAuthMethod(
  publicMethodValue: unknown,
  privateMethodValue: unknown,
): JsonRecord {
  const publicMethod = recordValue(publicMethodValue, "public auth method");
  const privateMethod = recordValue(privateMethodValue, "private auth method");
  const publicExtras = Object.fromEntries(
    Object.entries(publicMethod).filter(([key]) => {
      return ![
        "id",
        "label",
        "description",
        "visible",
        "featureSwitch",
        "grantKind",
        "manualFields",
        "startOptions",
      ].includes(key);
    }),
  );
  const method: JsonRecord = {
    ...privateMethod,
    ...publicExtras,
    id: publicMethod.id,
    label: publicMethod.label,
    description: publicMethod.description,
    visible: publicMethod.visible,
    featureSwitch: publicMethod.featureSwitch,
    ...(privateMethod.client === undefined
      ? {}
      : { client: privateMethod.client }),
    storage: privateMethod.storage,
    grant: canonicalGrant(publicMethod, privateMethod),
    access: privateMethod.access,
    revoke: privateMethod.revoke,
  };
  if (
    publicMethod.id !== privateMethod.id ||
    publicMethod.grantKind !==
      recordValue(privateMethod.grant, "private auth method grant").kind
  ) {
    method.invalidSplitFixtureRelationship = true;
  }
  return method;
}

function buildRelease(options: ReleaseFixtureOptions): ReleaseFixture {
  const connectorRef = options.connectorRef ?? "external-test";
  const label = options.label ?? "External Test";
  const keys = releaseKeys(options.version);
  const iconBytes = Buffer.from(`<svg>${connectorRef}</svg>`);
  const iconDigest = digest(iconBytes);
  const iconKey =
    "platform/views/zero-page/components/settings/icons/" +
    `${connectorRef}-${iconDigest.slice("sha256:".length, 19)}.svg`;
  const catalog: JsonRecord = {
    artifactSchemaVersion: 1,
    catalogVersion: options.version,
    categoryMetadata: {
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    },
    connectors: [
      buildCatalogConnector({
        connectorRef,
        label,
        iconKey,
        ...(options.generatedFirewall
          ? { firewall: buildGeneratedFirewall() }
          : {}),
      }),
    ],
  };

  initializeFixtureAuthComponents(catalog);
  options.mutateCatalog?.(catalog);
  options.mutateRuntime?.(catalog);
  options.mutateFirewall?.(catalog);
  assertFixtureAuthComponentsComplete(catalog);
  options.mutateArtifact?.(catalog);
  const catalogBytes = options.catalogBytes ?? jsonBytes(catalog);
  const pointer: JsonRecord = {
    catalogVersion: options.version,
    catalogKey: keys.catalog,
    catalogDigest: digest(catalogBytes),
  };
  options.mutatePointer?.(pointer);

  return {
    version: options.version,
    connectorRef,
    pointer: jsonBytes(pointer),
    catalogKey: keys.catalog,
    objects: new Map([[keys.catalog, catalogBytes]]),
  };
}

function catalogObjects(
  releases: readonly ReleaseFixture[],
  active: ReleaseFixture,
): ReadonlyMap<string, Buffer> {
  const objects = new Map<string, Buffer>();
  for (const release of releases) {
    for (const [key, bytes] of release.objects) {
      objects.set(key, bytes);
    }
  }
  objects.set(ACTIVE_KEY, active.pointer);
  return objects;
}

function commandInput(command: unknown): JsonRecord {
  if (!isJsonRecord(command)) {
    return {};
  }
  return isJsonRecord(command.input) ? command.input : {};
}

function steamOpenIdCallbackQuery(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  const returnTo = url.searchParams.get("openid.return_to");
  if (!returnTo) {
    throw new Error("Steam authorization URL is missing openid.return_to");
  }
  const state = new URL(returnTo).searchParams.get("state");
  if (!state) {
    throw new Error("Steam return_to is missing state");
  }
  const claimedId = `https://steamcommunity.com/openid/id/${STEAM_TEST_ID}`;
  return {
    state,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": returnTo,
    "openid.response_nonce": "2026-07-15T08:00:00Znonce",
    "openid.assoc_handle": "catalog-assoc-handle",
    "openid.signed":
      "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "catalog-signature",
  };
}

function mockSteamOpenIdVerification(): void {
  server.use(
    http.post(
      "https://steamcommunity.com/openid/login",
      async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("openid.mode")).toBe("check_authentication");
        return new HttpResponse(
          ["ns:http://specs.openid.net/auth/2.0", "is_valid:true", ""].join(
            "\n",
          ),
          { headers: { "content-type": "text/plain" } },
        );
      },
    ),
  );
}

function mockSteamPlayerApisForCatalog(): void {
  server.use(
    http.get(/https:\/\/api\.steampowered\.com\/.*/u, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("key")).toBe("catalog-steam-api-key");
      expect(
        url.searchParams.get("steamid") ?? url.searchParams.get("steamids"),
      ).toBe(STEAM_TEST_ID);
      switch (url.pathname) {
        case "/ISteamUser/GetPlayerSummaries/v0002/": {
          return HttpResponse.json({
            response: {
              players: [
                {
                  steamid: STEAM_TEST_ID,
                  personaname: "catalog-player",
                },
              ],
            },
          });
        }
        case "/IPlayerService/GetOwnedGames/v0001/": {
          return HttpResponse.json({
            response: { game_count: 0, games: [] },
          });
        }
        case "/IPlayerService/GetRecentlyPlayedGames/v0001/": {
          return HttpResponse.json({
            response: { total_count: 0, games: [] },
          });
        }
        case "/IPlayerService/GetSteamLevel/v1/": {
          return HttpResponse.json({ response: { player_level: 1 } });
        }
        case "/IPlayerService/GetBadges/v1/": {
          return HttpResponse.json({ response: { badges: [] } });
        }
        case "/IWishlistService/GetWishlist/v1/": {
          return HttpResponse.json({ response: { items: [] } });
        }
        case "/IWishlistService/GetWishlistItemCount/v1/": {
          return HttpResponse.json({ response: { count: 0 } });
        }
        case "/IStoreService/GetGamesFollowed/v1/": {
          return HttpResponse.json({ response: { appids: [] } });
        }
        case "/IStoreService/GetGamesFollowedCount/v1/": {
          return HttpResponse.json({
            response: { followed_game_count: 0 },
          });
        }
        default: {
          return HttpResponse.text("Unexpected Steam API path", {
            status: 404,
          });
        }
      }
    }),
  );
}

function s3Body(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

function deferredGate(): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} {
  const deferred = createDeferredPromise<void>(context.signal);
  return {
    promise: deferred.promise,
    release: () => {
      if (!deferred.settled()) {
        deferred.resolve(undefined);
      }
    },
  };
}

function serveObjects(objects: ReadonlyMap<string, Buffer>): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const key = typeof input.Key === "string" ? input.Key : undefined;
    const bytes = key ? objects.get(key) : undefined;
    if (!bytes) {
      return Promise.reject(new Error("Object unavailable"));
    }
    const etag = objectEtag(bytes);
    if (input.IfNoneMatch === etag) {
      return Promise.reject(
        Object.assign(new Error("Not modified"), {
          $metadata: { httpStatusCode: 304 },
        }),
      );
    }
    return Promise.resolve({
      ContentLength: bytes.length,
      Body: s3Body(bytes),
      ETag: etag,
    });
  });
}

function configureSource(): string {
  const bucket = `connector-catalog-test-${randomUUID()}`;
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
  return bucket;
}

function setApiVersion(version: string): void {
  apiPackage.version = version;
}

function cronHeaders(secret = CRON_SECRET): { readonly authorization: string } {
  return { authorization: `Bearer ${secret}` };
}

function cronClient() {
  return setupApp({ context })(cronConnectorCatalogContract);
}

function diagnosticsClient() {
  return setupApp({ context })(zeroConnectorCatalogContract);
}

function runnerFirewallClient() {
  return setupApp({ context })(runnersBuiltinFirewallsResolveContract);
}

interface VolumeStorageState {
  readonly s3_prefix: string;
  readonly size: number;
  readonly file_count: number;
  readonly head_version_id: string | null;
}

function systemStorageStateClient() {
  return setupAppWithRoutes({
    context,
    routes: testSystemStoragePresignedUrlCacheStateRoutes,
  })(testSystemStoragePresignedUrlCacheStateContract);
}

async function systemStorageStateAction(
  body: TestSystemStoragePresignedUrlCacheStateActionBody,
) {
  return await accept(systemStorageStateClient().action({ body }), [200]);
}

async function readVolumeStorageState(args: {
  readonly orgId: string;
  readonly storageName: string;
}): Promise<VolumeStorageState | null> {
  const response = await systemStorageStateAction({
    action: "read-storage-state",
    org_id: args.orgId,
    user_id: VOLUME_ORG_USER_ID,
    storage_name: args.storageName,
  });
  return response.body.storage_state ?? null;
}

async function restoreVolumeStorageState(args: {
  readonly orgId: string;
  readonly storageName: string;
  readonly previous: VolumeStorageState | null;
}): Promise<void> {
  await systemStorageStateAction({
    action: "restore-storage-state",
    org_id: args.orgId,
    user_id: VOLUME_ORG_USER_ID,
    storage_name: args.storageName,
    previous: args.previous,
  });
}

async function seedVolumeStorageVersion(args: {
  readonly orgId: string;
  readonly storageName: string;
  readonly versionId: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
}): Promise<void> {
  await systemStorageStateAction({
    action: "seed-storage-version",
    org_id: args.orgId,
    user_id: VOLUME_ORG_USER_ID,
    storage_name: args.storageName,
    version_id: args.versionId,
    s3_prefix: args.s3Prefix,
    s3_key: args.s3Key,
    archive_size: 321,
  });
}

async function syncCatalog() {
  return await accept(cronClient().sync({ headers: cronHeaders() }), [200]);
}

async function enableDiagnosticsFeatureSwitch(): Promise<void> {
  zeroMocks.clerk.session(DIAGNOSTICS_USER_ID, DIAGNOSTICS_ORG_ID);
  await accept(
    setupApp({ context })(zeroFeatureSwitchesContract).update({
      headers: { authorization: "Bearer clerk-session" },
      body: { switches: { [FeatureSwitchKey.ZeroDebug]: true } },
    }),
    [200],
  );
  onTestFinished(async () => {
    zeroMocks.clerk.session(DIAGNOSTICS_USER_ID, DIAGNOSTICS_ORG_ID);
    await accept(
      setupApp({ context })(zeroFeatureSwitchesContract).delete({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });
}

async function readStatus() {
  await enableDiagnosticsFeatureSwitch();
  return await accept(
    diagnosticsClient().diagnostics({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
}

async function rawCronRequest(path: string): Promise<Response> {
  return await createApp({ signal: context.signal }).request(path, {
    method: "GET",
  });
}

function expectRejectedBeforeAcceptance(
  body: Awaited<ReturnType<typeof syncCatalog>>["body"],
  failureCode: string,
): void {
  expect(body).toMatchObject({
    outcome: "rejected",
    state: "never-synced",
    active: null,
    lastAttempt: {
      outcome: "rejected",
      failureCode,
    },
    lastSuccessAt: null,
  });
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockNow(new Date(FIRST_SYNC_TIME));
});

afterEach(() => {
  setApiVersion(DEFAULT_API_VERSION);
  clearMockNow();
});

describe("connector catalog cron authentication and initial state", () => {
  it("rejects missing and invalid cron credentials", async () => {
    const response = await accept(
      cronClient().sync({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    const missing = await rawCronRequest("/api/cron/sync-connector-catalog");
    expect(missing.status).toBe(401);
  });

  it("reports never-synced without reading the shared storage bucket", async () => {
    configureSource();
    expect((await readStatus()).body).toStrictEqual({
      state: "never-synced",
      active: null,
      lastAttempt: null,
      lastSuccessAt: null,
      rejectedCandidate: null,
      credentialStorage: {
        missingConnectorVersions: expect.any(Number),
        unownedConnectorSecrets: expect.any(Number),
        unownedConnectorVariables: expect.any(Number),
        unresolvedBridgeCredentials: expect.any(Number),
      },
      filtering: {
        capabilityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        evaluatedAt: null,
        stale: true,
        filteredAuthMethods: [],
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("reports zero final connector credential invariant violations", async () => {
    configureSource();

    const response = await readStatus();
    expect(response.body.credentialStorage).toStrictEqual({
      missingConnectorVersions: 0,
      unownedConnectorSecrets: 0,
      unownedConnectorVariables: 0,
      unresolvedBridgeCredentials: 0,
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});

describe("connector catalog valid lifecycle", () => {
  it("accepts, advances, rolls back, and serves the active database snapshot", async () => {
    const bucket = configureSource();
    const first = buildRelease({ version: "2026-07-15.1" });
    const second = buildRelease({
      version: "2026-07-15.2",
      label: "External Test Updated",
    });
    serveObjects(catalogObjects([first, second], first));
    const acceptedFirst = await syncCatalog();
    expect(acceptedFirst.body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: first.version },
      lastAttempt: { outcome: "accepted", failureCode: null },
      lastSuccessAt: FIRST_SYNC_TIME,
      filtering: {
        evaluatedAt: FIRST_SYNC_TIME,
        stale: false,
        filteredAuthMethods: [],
      },
    });
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: bucket,
      Key: ACTIVE_KEY,
    });

    const callsBeforeStatus = context.mocks.s3.send.mock.calls.length;
    expect((await readStatus()).body).toStrictEqual(
      (({ outcome: _outcome, ...status }) => {
        return status;
      })(acceptedFirst.body),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeStatus);

    mockNow(new Date("2026-07-15T08:01:00.000Z"));
    const callsBeforeUnchanged = context.mocks.s3.send.mock.calls.length;
    const unchanged = await syncCatalog();
    expect(unchanged.body).toMatchObject({
      outcome: "unchanged",
      state: "current",
      active: { catalogVersion: first.version },
      lastAttempt: { outcome: "unchanged", failureCode: null },
      lastSuccessAt: "2026-07-15T08:01:00.000Z",
      filtering: {
        evaluatedAt: FIRST_SYNC_TIME,
        stale: false,
        filteredAuthMethods: [],
      },
    });
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeUnchanged).toBe(
      1,
    );
    expect(
      commandInput(context.mocks.s3.send.mock.calls[callsBeforeUnchanged]?.[0]),
    ).toMatchObject({
      Bucket: bucket,
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(first.pointer),
    });

    serveObjects(catalogObjects([first, second], second));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: second.version },
    });

    serveObjects(catalogObjects([first, second], first));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: first.version },
    });

    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const callsBeforePublicCatalog = context.mocks.s3.send.mock.calls.length;
    const publicCatalog = await accept(
      setupApp({ context })(zeroConnectorCatalogContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      publicCatalog.body.connectors.some((connector) => {
        return connector.connectorRef === first.connectorRef;
      }),
    ).toBeTruthy();
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(
      callsBeforePublicCatalog,
    );
  });

  it("serves every public catalog surface from accepted database state", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-public-reader",
      generatedFirewall: true,
      mutateCatalog: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        recordValue(connector.icon, "icon").key =
          "connector-icons/resolved-icon.svg";
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({ context })(zeroConnectorCatalogContract);
    const searchClient = setupApp({ context })(zeroConnectorsSearchContract);
    const callsBeforePublicReads = context.mocks.s3.send.mock.calls.length;

    const list = await accept(catalogClient.list({ headers }), [200]);
    expect(list.body.connectors).toHaveLength(1);
    expect(list.body.connectors[0]).toMatchObject({
      connectorRef: release.connectorRef,
      label: "External Test",
      description: "An external connector used only by the sync fixture",
      category: "testing",
      generation: [],
      tags: ["fixture"],
      icon: {
        url: "https://static.vm0.io/connector-icons/resolved-icon.svg",
        invertInDarkMode: false,
      },
      authMethods: [
        {
          id: "api-token",
          label: "API Token",
          description: null,
          grantKind: "manual",
        },
      ],
      permissionSummary: {
        hasPermissions: true,
        permissionCount: 1,
        hasCategories: true,
        hasDefaultPolicyOverrides: true,
      },
    });
    expect(list.body.categoryMetadata).toStrictEqual({
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    });
    assertPublicConnectorCatalogHasNoPrivateFields(list.body);

    const detail = await accept(
      catalogClient.get({
        params: { connectorRef: release.connectorRef },
        headers,
      }),
      [200],
    );
    expect(detail.body.connector.authMethods[0]).toMatchObject({
      id: "api-token",
      manualFields: [
        {
          id: "credential",
          label: "Credential",
          required: true,
          placeholder: null,
          inputType: "password",
        },
      ],
      startOptions: [],
    });

    const permissions = await accept(
      catalogClient.permissions({
        params: { connectorRef: release.connectorRef },
        headers,
      }),
      [200],
    );
    expect(permissions.body.permissions).toMatchObject({
      connectorRef: release.connectorRef,
      permissionCount: 1,
      permissions: [{ name: "items.read", description: "Read items" }],
      categories: {
        categories: { "items.read": "Items" },
        displayOrder: ["Items"],
      },
      defaultPolicy: {
        permissionDefault: "allow",
        unknownPolicy: "deny",
      },
    });

    const status = await accept(catalogClient.status({ headers }), [200]);
    expect(status.body.connectors).toHaveLength(1);
    expect(status.body.connectors[0]).toMatchObject({
      connectorRef: release.connectorRef,
      connected: false,
      connection: null,
      connectionStatus: "not-connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: false,
      tokenExpiresAt: null,
      singleAuthCodeAuthMethodId: null,
      connectNotice: null,
    });
    assertPublicConnectorCatalogHasNoPrivateFields(status.body);

    const search = await accept(
      searchClient.search({
        query: { keyword: "fixture" },
        headers,
      }),
      [200],
    );
    expect(search.body.connectors).toStrictEqual([
      {
        id: release.connectorRef,
        label: "External Test",
        description: "An external connector used only by the sync fixture",
        authMethods: ["api-token"],
      },
    ]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforePublicReads);
    expect(JSON.stringify({ detail, permissions, search })).not.toContain(
      PRIVATE_VALUE,
    );
  });

  it("keeps the first firewall permission description and sorts public permissions", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-permission-projection",
      generatedFirewall: true,
      mutateFirewall: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        const firewall = recordValue(connector.firewall, "firewall");
        const config = recordValue(firewall.config, "firewall.config");
        const apis = arrayValue(config.apis, "firewall.apis");
        const secondApi = structuredClone(firstRecord(apis, "firewall.apis"));
        secondApi.base = "https://api.example.test/v2";
        secondApi.permissions = [
          {
            name: "items.read",
            description: "Later items description",
            rules: ["GET /later-items"],
          },
          {
            name: "alpha.read",
            description: "Read alpha",
            rules: ["GET /alpha"],
          },
        ];
        apis.push(secondApi);
        recordValue(
          recordValue(firewall.categories, "firewall.categories").byPermission,
          "firewall.categories.byPermission",
        )["alpha.read"] = "Items";
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const response = await accept(
      setupApp({ context })(zeroConnectorCatalogContract).permissions({
        params: { connectorRef: release.connectorRef },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.permissions.permissions).toStrictEqual([
      { name: "alpha.read", description: "Read alpha" },
      { name: "items.read", description: "Read items" },
    ]);
  });

  it("serves concurrent external catalog reads without returning to R2", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-concurrent-cold-reader",
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({ context })(zeroConnectorCatalogContract);
    const callsBeforePublicReads = context.mocks.s3.send.mock.calls.length;

    const [list, detail] = await Promise.all([
      accept(catalogClient.list({ headers }), [200]),
      accept(
        catalogClient.get({
          params: { connectorRef: release.connectorRef },
          headers,
        }),
        [200],
      ),
    ]);
    expect(list.body.connectors).toHaveLength(1);
    expect(detail.body.connector.connectorRef).toBe(release.connectorRef);

    await accept(catalogClient.list({ headers }), [200]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforePublicReads);
  });

  it("applies compatibility, authored visibility, and request rollout filters", async () => {
    configureSource();
    const gated = publicAuthMethod({
      id: "api-token",
      grantKind: "manual",
      manual: true,
    });
    gated.featureSwitch = "awsConnector";
    const visible = publicAuthMethod({
      id: "cli",
      grantKind: "manual",
      manual: true,
    });
    const hidden = publicAuthMethod({
      id: "api",
      grantKind: "manual",
      manual: true,
    });
    hidden.visible = false;
    const release = buildRelease({
      version: "2026-07-15.external-request-filters",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [gated, visible, hidden]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "api-token",
            prefix: "GATED",
            access: "static",
            revoke: "none",
          }),
          manualPrivateAuthMethod({
            id: "cli",
            prefix: "VISIBLE",
            access: "static",
            revoke: "none",
          }),
          manualPrivateAuthMethod({
            id: "api",
            prefix: "HIDDEN",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    zeroMocks.clerk.session(userId, orgId);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({ context })(zeroConnectorCatalogContract);
    const featureClient = setupApp({ context })(zeroFeatureSwitchesContract);

    const disabled = await accept(catalogClient.list({ headers }), [200]);
    expect(disabled.body.connectors[0]?.authMethods).toStrictEqual([
      {
        id: "cli",
        label: "cli auth",
        description: null,
        grantKind: "manual",
      },
    ]);

    await accept(
      featureClient.update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.AwsConnector]: true },
        },
      }),
      [200],
    );
    const enabled = await accept(catalogClient.list({ headers }), [200]);
    expect(
      enabled.body.connectors[0]?.authMethods.map((method) => {
        return method.id;
      }),
    ).toStrictEqual(["api-token", "cli"]);
    await accept(featureClient.delete({ headers }), [200]);

    const unsupported = buildRelease({
      version: "2026-07-15.external-all-incompatible",
      mutateCatalog: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        method.featureSwitch = "futureConnectorSwitch";
      },
    });
    serveObjects(catalogObjects([release, unsupported], unsupported));
    await syncCatalog();
    const allFiltered = await accept(catalogClient.list({ headers }), [200]);
    expect(allFiltered.body).toStrictEqual({
      connectors: [],
      categoryMetadata: { categories: [], groups: [] },
    });
  });

  it("executes an external manual grant with catalog-owned storage", async () => {
    configureSource();
    const optionalSecretName = "EXTERNAL_OPTIONAL_TOKEN";
    const release = buildRelease({
      version: "2026-07-15.external-manual-grant",
      connectorRef: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        const grant = recordValue(method.grant, "grant");
        arrayValue(grant.fields, "grant.fields").push({
          privateName: optionalSecretName,
          publicId: "optionalCredential",
          storage: "secret",
          label: "Optional credential",
          required: false,
          placeholder: null,
        });
      },
      mutateRuntime: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        arrayValue(
          recordValue(method.storage, "storage").secrets,
          "secrets",
        ).push(optionalSecretName);
        recordValue(
          recordValue(method.access, "access").envBindings,
          "envBindings",
        ).OPTIONAL_SERVICE_TOKEN = `$secrets.${optionalSecretName}`;
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "agora"));
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
    const connected = await connectorsApi.connectManualGrant(
      actor,
      "agora",
      "api-token",
      { credential: "catalog-manual-secret" },
    );
    expect(connected).toMatchObject({
      type: "agora",
      authMethod: "api-token",
      connectionStatus: "connected",
    });

    const listed = await connectorsApi.listConnectors(actor);
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "agora",
        authMethod: "api-token",
        namespace: "secrets",
        name: "SERVICE_TOKEN",
      }),
    );
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(secrets.body.secrets).toContainEqual(
      expect.objectContaining({ name: PRIVATE_VALUE, type: "connector" }),
    );
    expect(JSON.stringify(secrets.body)).not.toContain("catalog-manual-secret");
    const storageState = await readConnectorCredentialStorageState(context, {
      connectorRef: "agora",
      orgId: actor.orgId ?? "",
      userId: actor.userId,
      secretNames: [optionalSecretName],
    });
    expect(storageState.secrets).toStrictEqual([]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
  });

  it("seeds an external token credential through the CLI test endpoint", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-cli-seed",
      connectorRef: "test-oauth-device",
      label: "Catalog Device OAuth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "device-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          devicePrivateAuthMethod({
            accessTokenName: "CATALOG_CLI_DEVICE_ACCESS_TOKEN",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    const firewall = createFirewallApi(context);
    onTestFinished(createConnectorCleanup(actor, "test-oauth-device"));
    await firewall.provisionRunReadyOrg(actor);
    const callsBeforeSeed = context.mocks.s3.send.mock.calls.length;
    await firewall.seedTestConnector(actor, {
      connectorName: "test-oauth-device",
      authMethod: "oauth",
      accessToken: "catalog-cli-access-token",
    });

    await expect(
      connectorsApi.readConnectorByType(actor, "test-oauth-device"),
    ).resolves.toMatchObject({
      type: "test-oauth-device",
      authMethod: "oauth",
      connectionStatus: "connected",
    });
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(secrets.body.secrets).toContainEqual(
      expect.objectContaining({
        name: "CATALOG_CLI_DEVICE_ACCESS_TOKEN",
        type: "connector",
      }),
    );
    expect(JSON.stringify(secrets.body)).not.toContain(
      "catalog-cli-access-token",
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeSeed);
  });

  it("replaces and deletes connections with compatibility-filtered auth methods", async () => {
    configureSource();
    const legacyMethod = publicAuthMethod({
      id: "legacy",
      grantKind: "manual",
      manual: true,
    });
    const currentMethod = publicAuthMethod({
      id: "current",
      grantKind: "manual",
      manual: true,
    });
    const initial = buildRelease({
      version: "2026-07-15.external-legacy-method",
      connectorRef: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [legacyMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial], initial));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "agora"));
    await connectorsApi.connectManualGrant(actor, "agora", "legacy", {
      credential: "legacy-catalog-secret",
    });

    const replacement = buildRelease({
      version: "2026-07-15.external-replacement-method",
      connectorRef: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [legacyMethod, currentMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY",
            access: "refresh-token",
            revoke: "none",
          }),
          manualPrivateAuthMethod({
            id: "current",
            prefix: "CURRENT",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial, replacement], replacement));
    const synced = await syncCatalog();
    expect(synced.body.filtering.filteredAuthMethods).toStrictEqual([
      {
        connectorRef: "agora",
        authMethodId: "legacy",
        reasons: ["missing-access-provider"],
      },
    ]);

    const connected = await connectorsApi.connectManualGrant(
      actor,
      "agora",
      "current",
      { credential: "current-catalog-secret" },
    );
    expect(connected).toMatchObject({
      type: "agora",
      authMethod: "current",
      connectionStatus: "connected",
    });

    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const names = secrets.body.secrets.map((secret) => {
      return secret.name;
    });
    expect(names).toContain("CURRENT_CREDENTIAL");
    expect(names).not.toContain("LEGACY_CREDENTIAL");

    const unavailable = buildRelease({
      version: "2026-07-15.external-all-methods-filtered",
      connectorRef: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [legacyMethod, currentMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY",
            access: "refresh-token",
            revoke: "none",
          }),
          manualPrivateAuthMethod({
            id: "current",
            prefix: "CURRENT",
            access: "refresh-token",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(
      catalogObjects([initial, replacement, unavailable], unavailable),
    );
    const filtered = await syncCatalog();
    expect(filtered.body.filtering.filteredAuthMethods).toHaveLength(2);

    await connectorsApi.deleteConnectorByType(actor, "agora");
    const secretsAfterDelete = await accept(
      setupApp({ context })(zeroSecretsContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      secretsAfterDelete.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).not.toContain("CURRENT_CREDENTIAL");
  });

  it("replaces and deletes stored connector state when its method is removed", async () => {
    configureSource();
    const legacyMethod = publicAuthMethod({
      id: "legacy",
      grantKind: "manual",
      manual: true,
    });
    const currentMethod = publicAuthMethod({
      id: "current",
      grantKind: "manual",
      manual: true,
    });
    const initial = buildRelease({
      version: "2026-07-15.external-stored-method-present",
      connectorRef: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [legacyMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial], initial));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "agora"));
    await connectorsApi.connectManualGrant(actor, "agora", "legacy", {
      credential: "legacy-catalog-secret",
    });

    const removed = buildRelease({
      version: "2026-07-15.external-stored-method-removed",
      connectorRef: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [currentMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "current",
            prefix: "CURRENT",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial, removed], removed));
    await syncCatalog();

    const replacement = await connectorsApi.requestManualGrant(
      actor,
      "agora",
      "current",
      { credential: "current-catalog-secret" },
      { statuses: [200] },
    );
    expect(replacement.status).toBe(200);
    await connectorsApi.deleteConnectorByType(actor, "agora", [204]);

    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secretNames = secrets.body.secrets.map((secret) => {
      return secret.name;
    });
    expect(secretNames).not.toContain("LEGACY_CREDENTIAL");
    expect(secretNames).not.toContain("CURRENT_CREDENTIAL");
  });

  it("replaces token state when the stored method is removed", async () => {
    configureSource();
    const initial = buildRelease({
      version: "2026-07-15.external-token-stored-method-present",
      connectorRef: "gmail",
      label: "Catalog Gmail",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "legacy", grantKind: "manual", manual: true }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY_GMAIL",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial], initial));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "gmail"));
    await connectorsApi.connectManualGrant(actor, "gmail", "legacy", {
      credential: "legacy-gmail-secret",
    });

    mockGmailConnectorOAuth({ email: "removed-method@example.test" });
    const replacement = buildRelease({
      version: "2026-07-15.external-token-stored-method-removed",
      connectorRef: "gmail",
      label: "Catalog Gmail",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [gmailPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([initial, replacement], replacement));
    await syncCatalog();

    const oauth = await connectorsApi.startOauth(actor, "gmail", "oauth");
    const state = new URL(oauth.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Gmail authorization state");
    }
    const callback = await connectorsApi.completeOauthCallback("gmail", {
      code: "removed-stored-method",
      state,
    });
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.pathname).toBe("/connector/success");

    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secretNames = secrets.body.secrets.map((secret) => {
      return secret.name;
    });
    expect(secretNames).not.toContain("LEGACY_GMAIL_CREDENTIAL");
    expect(secretNames).toContain("CATALOG_GMAIL_ACCESS_TOKEN");
    expect(secretNames).toContain("CATALOG_GMAIL_REFRESH_TOKEN");
    await expect(
      connectorsApi.readConnectorByType(actor, "gmail"),
    ).resolves.toMatchObject({ authMethod: "oauth" });
  });

  it("materializes external runtime bindings for runs and firewall auth", async () => {
    const connectorRef = "external-runtime";
    configureSource();
    const buildRuntimeRelease = (version: string) => {
      return buildRelease({
        version,
        connectorRef,
        label: "External Runtime",
        generatedFirewall: true,
        mutateFirewall: (artifact) => {
          const connector = firstRecord(artifact.connectors, "connectors");
          recordValue(connector.firewall, "firewall").billable = true;
        },
      });
    };
    const release = buildRuntimeRelease(
      "2026-07-15.external-run-materialization-1",
    );
    const replacement = buildRuntimeRelease(
      "2026-07-15.external-run-materialization-2",
    );
    serveObjects(catalogObjects([release, replacement], release));
    await syncCatalog();

    const runs = createRunsApi(context);
    const firewall = createFirewallApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "External catalog runtime agent",
      visibility: "private",
    });
    const activeRunIds = new Set<string>();
    const cleanupConnector = createConnectorCleanup(actor, connectorRef);
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      for (const runId of activeRunIds) {
        await runs.requestCancelRun(actor, runId, [200, 404]);
      }
      await cleanupConnector();
      await bdd.deleteAgent(actor, agent.agentId);
    });
    await connectorsApi.connectManualGrant(
      actor,
      connectorRef,
      "api-token",
      { credential: "catalog-runtime-secret" },
      agent.agentId,
    );

    const callsBeforeRuntimeReads = context.mocks.s3.send.mock.calls.length;
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const check = await accept(
      setupApp({ context })(zeroConnectorCheckContract).check({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          mode: "url",
          method: "GET",
          url: "https://api.example.test/v1/items",
          connectorRef,
        },
      }),
      [200],
    );
    expect(check.body).toMatchObject({
      outcome: "resolved",
      mode: "url",
      connector: {
        connectorRef,
        label: "External Runtime",
      },
      base: "https://api.example.test/v1",
      relativePath: "/items",
      permission: {
        kind: "matched",
        permissions: [{ name: "items.read" }],
      },
    });
    const hostCollision = await connectorsApi.requestCreateCustomConnector(
      actor,
      {
        displayName: "External Host Collision",
        prefixes: ["https://api.example.test/custom/"],
        headerName: "Authorization",
        headerTemplate: "Bearer {{secret}}",
      },
      [400],
    );
    expectApiError(hostCollision.body);
    expect(hostCollision.body.error.message).toContain("api.example.test");
    expect(hostCollision.body.error.message).toContain("External Runtime");
    const grants = await accept(
      setupApp({ context })(zeroUserPermissionGrantsContract).apply({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentId: agent.agentId,
          connectorRef,
          mode: "replace",
          grants: [{ permission: "items.read", action: "deny" }],
        },
      }),
      [200],
    );
    expect(grants.body).toMatchObject([
      { connectorRef, permission: "items.read", action: "deny" },
    ]);
    const activatedRun = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the activated connector runtime projection",
      modelProvider: "anthropic-api-key",
    });
    activeRunIds.add(activatedRun.runId);
    expect(
      apiDispatchTimingEventForRun(
        activatedRun.runId,
        "api_dispatch_pre_create_zero_load_connector_runtime_selection",
      ),
    ).toMatchObject({
      connector_runtime_source: "projection",
      connector_runtime_cache_status: "miss",
    });
    await runs.requestCancelRun(actor, activatedRun.runId, [200]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(
      callsBeforeRuntimeReads,
    );

    serveObjects(catalogObjects([release, replacement], replacement));
    mockNow(new Date("2026-07-15T08:01:00.000Z"));
    expect((await syncCatalog()).body.outcome).toBe("accepted");
    // No production API can create an incomplete derived projection.
    await mutateApiTestConnectorCatalogRuntimeProjection({ kind: "clear" });
    mockNow(new Date("2026-07-15T08:02:00.000Z"));
    expect((await syncCatalog()).body.outcome).toBe("unchanged");

    const callsBeforeRun = context.mocks.s3.send.mock.calls.length;
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the externally sourced connector credential",
      modelProvider: "anthropic-api-key",
    });
    activeRunIds.add(run.runId);
    expect(
      apiDispatchTimingEventForRun(
        run.runId,
        "api_dispatch_pre_create_zero_load_connector_runtime_selection",
      ),
    ).toMatchObject({
      connector_runtime_source: "projection",
      connector_runtime_cache_status: "miss",
    });
    await runs.heartbeatRunner(runnerGroup);
    await expect
      .poll(
        async () => {
          return (await runs.pollRunner(runnerGroup)).body.job?.runId;
        },
        { timeout: 10_000 },
      )
      .toBe(run.runId);
    const claim = await runs.claimRunnerJob(run.runId);
    expect(claim.environment?.SERVICE_TOKEN).toBeTruthy();
    expect(claim.secretConnectorMap).toMatchObject({
      SERVICE_TOKEN: connectorRef,
    });
    expect(claim.firewalls).toContainEqual({
      kind: "builtin",
      name: connectorRef,
    });
    expect(claim.billableFirewalls).toContain(connectorRef);
    expect(claim.networkPolicies?.[connectorRef]).toStrictEqual({
      allow: [],
      deny: ["items.read"],
      ask: [],
      unknownPolicy: "deny",
    });
    expect(
      expectCanonicalStorageManifest(claim.storageManifest)?.storageMounts.some(
        (storage) => {
          return storage.mountPath.endsWith(`/skills/${connectorRef}`);
        },
      ),
    ).toBeFalsy();
    if (!claim.encryptedSecrets) {
      throw new Error("Expected encrypted connector secrets in the run claim");
    }
    const resolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: ["Bearer $", "{{ secrets.SERVICE_TOKEN }}"].join(""),
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected firewall auth to resolve connector secrets");
    }
    expect(resolved.body.headers).toStrictEqual({
      Authorization: "Bearer catalog-runtime-secret",
    });
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeRun);
    await runs.requestCancelRun(actor, run.runId, [200]);
  }, 15_000);

  it("composes accepted connector and local model-provider runner firewalls", async () => {
    const connectorRef = "external-runner-firewall";
    configureSource();
    const first = buildRelease({
      version: "2026-07-15.external-runner-firewall-1",
      connectorRef,
      label: "External Runner Firewall",
      generatedFirewall: true,
    });
    serveObjects(catalogObjects([first], first));
    const sync = await syncCatalog();
    const acceptedCatalogDigest = sync.body.active?.catalogDigest;
    if (!acceptedCatalogDigest) {
      throw new Error("Expected an accepted connector catalog digest");
    }

    const headers = { authorization: OFFICIAL_RUNNER_AUTHORIZATION };
    const providerName = "model-provider:openai-api-key";
    const callsBeforeReads = context.mocks.s3.send.mock.calls.length;
    const subset = await accept(
      runnerFirewallClient().resolve({
        headers,
        body: { names: [connectorRef, connectorRef, providerName] },
      }),
      [200],
    );
    expect(Object.keys(subset.body.firewalls).sort()).toStrictEqual([
      connectorRef,
      providerName,
    ]);
    expect(subset.body.firewalls[connectorRef]?.apis[0]?.base).toBe(
      "https://api.example.test/v1",
    );
    expect(subset.body.firewalls[providerName]?.apis[0]?.base).toBe(
      "https://api.openai.com/v1/responses",
    );

    const full = await accept(
      runnerFirewallClient().resolve({ headers, body: {} }),
      [200],
    );
    const providerNames = Object.values(MODEL_PROVIDER_FIREWALL_CONFIGS)
      .map((firewall) => {
        return firewall.name;
      })
      .sort();
    expect(Object.keys(full.body.firewalls).sort()).toStrictEqual(
      [connectorRef, ...providerNames].sort(),
    );
    expect(subset.body.catalogDigest).toBe(full.body.catalogDigest);
    expect(subset.body.catalogVersion).toBe(full.body.catalogVersion);
    const firstHex = createHash("sha256")
      .update(JSON.stringify(full.body.firewalls, null, 2))
      .digest("hex");
    expect(full.body.catalogDigest).toBe(`sha256:${firstHex}`);
    expect(full.body.catalogVersion).toBe(`sha256-${firstHex.slice(0, 12)}`);
    for (const [name, firewall] of Object.entries(full.body.firewalls)) {
      expect(firewall.name).toBe(name);
    }
    const serialized = JSON.stringify(full.body);
    expect(serialized).not.toContain("sourceId");
    expect(serialized).not.toContain(acceptedCatalogDigest);
    expect(serialized).not.toContain(first.catalogKey);

    const missing = await accept(
      runnerFirewallClient().resolve({
        headers,
        body: { names: ["github"] },
      }),
      [400],
    );
    expect(missing.body.error.message).toBe("Unknown builtin firewall: github");
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeReads);

    const changedBase = "https://api.example.test/v2";
    const second = buildRelease({
      version: "2026-07-15.external-runner-firewall-2",
      connectorRef,
      label: "External Runner Firewall",
      generatedFirewall: true,
      mutateFirewall: (artifact) => {
        setFirewallBase(artifact, changedBase);
      },
    });
    serveObjects(catalogObjects([first, second], second));
    await syncCatalog();
    const callsBeforeSecondRead = context.mocks.s3.send.mock.calls.length;
    const updated = await accept(
      runnerFirewallClient().resolve({ headers, body: {} }),
      [200],
    );
    expect(updated.body.catalogDigest).not.toBe(full.body.catalogDigest);
    expect(updated.body.catalogVersion).not.toBe(full.body.catalogVersion);
    expect(updated.body.firewalls[connectorRef]?.apis[0]?.base).toBe(
      changedBase,
    );
    expect(updated.body.firewalls[providerName]).toStrictEqual(
      full.body.firewalls[providerName],
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeSecondRead);
  });

  it("loads 17 exact connector skill versions in one bounded storage preload", async () => {
    const fixtureSuffix = randomUUID().slice(0, 8);
    const skills = Array.from({ length: 17 }, (_, index) => {
      const sequence = String(index + 1).padStart(2, "0");
      const connectorRef = `batch-skill-${fixtureSuffix}-${sequence}`;
      const selectedVersionId = createHash("sha256")
        .update(`selected:${connectorRef}`)
        .digest("hex");
      const newerVersionId = createHash("sha256")
        .update(`newer:${connectorRef}`)
        .digest("hex");
      return {
        connectorRef,
        selectedVersionId,
        newerVersionId,
        skill: buildBundledSkillFixture(connectorRef, selectedVersionId),
      };
    });
    configureSource();
    const previousSystemStates: (VolumeStorageState | null)[] = [];
    for (const skill of skills) {
      previousSystemStates.push(
        await readVolumeStorageState({
          orgId: SYSTEM_ORG_ID,
          storageName: skill.skill.storageName,
        }),
      );
    }

    const firstSkill = skills[0];
    if (!firstSkill) {
      throw new Error("Expected connector skill fixtures");
    }
    const release = buildRelease({
      version: `2026-07-15.external-batch-skills-${fixtureSuffix}`,
      connectorRef: firstSkill.connectorRef,
      label: "External Batch Skill 01",
      mutateArtifact: (artifact) => {
        const template = firstRecord(artifact.connectors, "connectors");
        const iconKey = recordValue(template.icon, "connector icon").key;
        if (typeof iconKey !== "string") {
          throw new Error("Expected connector icon key");
        }
        artifact.connectors = skills.map((skill, index) => {
          const sequence = String(index + 1).padStart(2, "0");
          const connector = buildCatalogConnector({
            connectorRef: skill.connectorRef,
            label: `External Batch Skill ${sequence}`,
            iconKey,
          });
          const presentation = publicAuthMethod({
            id: "api-token",
            grantKind: "manual",
            manual: true,
          });
          presentation.label = "API Token";
          const privateName = `BATCH_SKILL_${sequence}_TOKEN`;
          connector.authMethods = [
            canonicalAuthMethod(presentation, {
              id: "api-token",
              storage: {
                version: 1,
                secrets: [privateName],
                variables: [],
              },
              grant: {
                kind: "manual",
                fields: [
                  {
                    privateName,
                    publicId: "credential",
                    storage: "secret",
                  },
                ],
              },
              access: {
                kind: "static",
                envBindings: {
                  [privateName]: `$secrets.${privateName}`,
                },
              },
              revoke: { kind: "none" },
            }),
          ];
          connector.skill = skill.skill.descriptor;
          return connector;
        });
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped test actor");
    }
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "External batch connector skill agent",
      visibility: "private",
    });
    const activeRunIds = new Set<string>();
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      for (const runId of activeRunIds) {
        await runs.requestCancelRun(actor, runId, [200, 404]);
      }
      for (const [index, skill] of skills.entries()) {
        await systemStorageStateAction({
          action: "cleanup",
          object_key_prefix: skill.skill.s3Prefix,
        });
        await restoreVolumeStorageState({
          orgId: SYSTEM_ORG_ID,
          storageName: skill.skill.storageName,
          previous: previousSystemStates[index] ?? null,
        });
        await createConnectorCleanup(actor, skill.connectorRef)();
      }
      await bdd.deleteAgent(actor, agent.agentId);
    });

    for (const [index, skill] of skills.entries()) {
      await connectorsApi.connectManualGrant(
        actor,
        skill.connectorRef,
        "api-token",
        { credential: `batch-skill-secret-${index + 1}` },
        agent.agentId,
      );
    }

    const createAndClaimRun = async (prompt: string) => {
      const run = await runs.createRun(actor, {
        agentId: agent.agentId,
        prompt,
        modelProvider: "anthropic-api-key",
      });
      activeRunIds.add(run.runId);
      expect(run.status).not.toBe("failed");
      await runs.heartbeatRunner(runnerGroup);
      await expect
        .poll(
          async () => {
            return (await runs.pollRunner(runnerGroup)).body.job?.runId;
          },
          { timeout: 10_000 },
        )
        .toBe(run.runId);
      return {
        run,
        claim: await runs.claimRunnerJob(run.runId),
      };
    };
    const expectSkillMounts = (
      claim: Awaited<ReturnType<typeof runs.claimRunnerJob>>,
    ): void => {
      const storageMounts =
        expectCanonicalStorageManifest(
          claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return skills.some((skill) => {
            return mount.name === skill.skill.storageName;
          });
        }) ?? [];
      expect(storageMounts).toHaveLength(skills.length);
      for (const skill of skills) {
        expect(storageMounts).toContainEqual(
          expect.objectContaining({
            name: skill.skill.storageName,
            mountPath: `/home/user/.claude/skills/${skill.connectorRef}`,
            versionId: skill.selectedVersionId,
            archiveSize: 321,
            archiveUrl: expect.any(String),
          }),
        );
      }
    };

    const headRun = await createAndClaimRun(
      "Use all connector skills at their registered HEAD versions",
    );
    expectSkillMounts(headRun.claim);
    await runs.requestCancelRun(actor, headRun.run.runId, [200]);
    activeRunIds.delete(headRun.run.runId);

    for (const skill of skills) {
      await seedVolumeStorageVersion({
        orgId: SYSTEM_ORG_ID,
        storageName: skill.skill.storageName,
        versionId: skill.newerVersionId,
        s3Prefix: skill.skill.s3Prefix,
        s3Key: `${skill.skill.s3Prefix}/${skill.newerVersionId}`,
      });
    }

    const historicalRun = await createAndClaimRun(
      "Use all connector skills after their storage HEADs advance",
    );
    expectSkillMounts(historicalRun.claim);
    await runs.requestCancelRun(actor, historicalRun.run.runId, [200]);
    activeRunIds.delete(historicalRun.run.runId);
  }, 30_000);

  it("mounts an external connector skill from its exact system version", async () => {
    const connectorRef = `external-skill-${randomUUID().slice(0, 8)}`;
    const selectedVersionId = createHash("sha256")
      .update(`selected:${randomUUID()}`)
      .digest("hex");
    const otherVersionId = createHash("sha256")
      .update(`other:${randomUUID()}`)
      .digest("hex");
    const newerVersionId = createHash("sha256")
      .update(`newer:${randomUUID()}`)
      .digest("hex");
    const skill = buildBundledSkillFixture(connectorRef, selectedVersionId);
    const { storageName, s3Prefix: canonicalPrefix } = skill;
    configureSource();
    const previousSystemState = await readVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName,
    });
    const release = buildRelease({
      version: "2026-07-15.external-exact-skill",
      connectorRef,
      label: "External Exact Skill",
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill = skill.descriptor;
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped test actor");
    }
    const runtimeOrgId = actor.orgId;
    const previousRuntimeState = await readVolumeStorageState({
      orgId: runtimeOrgId,
      storageName,
    });
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "External exact connector skill agent",
      visibility: "private",
    });
    let successfulRunId: string | undefined;
    const cleanupConnector = createConnectorCleanup(actor, connectorRef);
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      if (successfulRunId) {
        await runs.requestCancelRun(actor, successfulRunId, [200, 404]);
      }
      await systemStorageStateAction({
        action: "cleanup",
        object_key_prefix: canonicalPrefix,
      });
      await restoreVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName,
        previous: previousSystemState,
      });
      await restoreVolumeStorageState({
        orgId: runtimeOrgId,
        storageName,
        previous: previousRuntimeState,
      });
      await cleanupConnector();
      await bdd.deleteAgent(actor, agent.agentId);
    });
    await connectorsApi.connectManualGrant(
      actor,
      connectorRef,
      "api-token",
      { credential: "catalog-skill-secret" },
      agent.agentId,
    );

    const createSkillRun = async () => {
      return await runs.createRun(actor, {
        agentId: agent.agentId,
        prompt: "Use the connector skill",
        modelProvider: "anthropic-api-key",
      });
    };
    const expectRegistrationFailure = async () => {
      const failed = await createSkillRun();
      expect(failed).toMatchObject({
        status: "failed",
        error: "Connector skill registration is unavailable",
      });
    };

    await seedVolumeStorageVersion({
      orgId: SYSTEM_ORG_ID,
      storageName,
      versionId: newerVersionId,
      s3Prefix: canonicalPrefix,
      s3Key: `${canonicalPrefix}/${newerVersionId}`,
    });

    const run = await createSkillRun();
    successfulRunId = run.runId;
    expect(run.status).not.toBe("failed");
    await runs.heartbeatRunner(runnerGroup);
    await expect
      .poll(
        async () => {
          return (await runs.pollRunner(runnerGroup)).body.job?.runId;
        },
        { timeout: 10_000 },
      )
      .toBe(run.runId);
    const claim = await runs.claimRunnerJob(run.runId);
    const mountedSkills =
      expectCanonicalStorageManifest(
        claim.storageManifest,
      )?.storageMounts.filter((storage) => {
        return (
          storage.mountPath === `/home/user/.claude/skills/${connectorRef}`
        );
      }) ?? [];
    expect(mountedSkills).toHaveLength(1);
    expect(mountedSkills[0]).toMatchObject({
      name: storageName,
      mountPath: `/home/user/.claude/skills/${connectorRef}`,
      versionId: selectedVersionId,
      archiveSize: 321,
      archiveUrl: expect.any(String),
    });
    await runs.requestCancelRun(actor, run.runId, [200]);
    successfulRunId = undefined;

    await restoreVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName,
      previous: previousSystemState,
    });
    await seedVolumeStorageVersion({
      orgId: runtimeOrgId,
      storageName,
      versionId: selectedVersionId,
      s3Prefix: canonicalPrefix,
      s3Key: `${canonicalPrefix}/${selectedVersionId}`,
    });
    await expectRegistrationFailure();
    await restoreVolumeStorageState({
      orgId: runtimeOrgId,
      storageName,
      previous: previousRuntimeState,
    });

    await seedVolumeStorageVersion({
      orgId: SYSTEM_ORG_ID,
      storageName,
      versionId: otherVersionId,
      s3Prefix: canonicalPrefix,
      s3Key: `${canonicalPrefix}/${otherVersionId}`,
    });
    await expectRegistrationFailure();

    const wrongPrefix = `${SYSTEM_ORG_ID}/volume/wrong-${storageName}`;
    await seedVolumeStorageVersion({
      orgId: SYSTEM_ORG_ID,
      storageName,
      versionId: selectedVersionId,
      s3Prefix: wrongPrefix,
      s3Key: `${wrongPrefix}/${selectedVersionId}`,
    });
    await expectRegistrationFailure();

    await seedVolumeStorageVersion({
      orgId: SYSTEM_ORG_ID,
      storageName,
      versionId: selectedVersionId,
      s3Prefix: canonicalPrefix,
      s3Key: `${canonicalPrefix}/wrong-${selectedVersionId}`,
    });
    await expectRegistrationFailure();
  }, 30_000);

  it("executes an external device grant with catalog-owned storage", async () => {
    mockTestOAuthDeviceConnectorProvider();
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-device-grant",
      connectorRef: "test-oauth-device",
      label: "Catalog Device OAuth",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "oauth",
          grantKind: "device-auth",
        });
        method.featureSwitch = "testOauthConnector";
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          devicePrivateAuthMethod({
            accessTokenName: "CATALOG_DEVICE_ACCESS_TOKEN",
            clientId: "test-oauth-device-client",
            scopes: ["read"],
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const cleanupConnector = createConnectorCleanup(actor, "test-oauth-device");
    onTestFinished(async () => {
      await cleanupConnector();
      await connectorsApi.deleteFeatureSwitches(actor);
    });
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: false,
    });
    const completed = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
    );
    expect(completed.status).toBe("complete");
    if (completed.status !== "complete") {
      throw new Error(
        `Expected completed device grant, got ${completed.status}`,
      );
    }
    expect(completed.connector).toMatchObject({
      type: "test-oauth-device",
      authMethod: "oauth",
      oauthScopes: ["read"],
    });
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(secrets.body.secrets).toContainEqual(
      expect.objectContaining({
        name: "CATALOG_DEVICE_ACCESS_TOKEN",
        type: "connector",
      }),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
  });

  it("executes an external OpenID grant with catalog-owned storage", async () => {
    mockEnv("VM0_API_BACKEND_URL", "https://api.vm0.ai");
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    mockEnv("STEAM_WEB_API_KEY", "catalog-steam-api-key");
    mockOptionalEnv("STEAM_WEB_API_KEY", "catalog-steam-api-key");
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-openid-grant",
      connectorRef: "steam",
      label: "Catalog Steam",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          steamPrivateAuthMethod({ steamIdName: "CATALOG_STEAM_ID" }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "steam"));
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
    const start = await accept(
      setupApp({ context })(zeroConnectorOpenIdStartContract).start({
        params: { type: "steam" },
        headers,
        body: { authMethod: "openid" },
      }),
      [200],
    );
    mockSteamOpenIdVerification();
    await accept(
      setupApp({ context })(connectorsTypeCallbackContract).callback({
        params: { type: "steam" },
        headers: {},
        query: steamOpenIdCallbackQuery(start.body.authorizationUrl),
      }),
      [307],
    );
    mockSteamPlayerApisForCatalog();
    const player = await accept(
      setupApp({ context })(zeroSteamPlayerContract).getPlayer({ headers }),
      [200],
    );
    expect(player.body).toMatchObject({
      steamId: STEAM_TEST_ID,
      profile: { personaName: "catalog-player" },
    });
    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
      connectorRef: "steam",
      variableNames: ["CATALOG_STEAM_ID"],
    });
    expect(storageState.connector?.storage_version).toBe(1);
    expect(storageState.variables).toStrictEqual([
      {
        name: "CATALOG_STEAM_ID",
        connector_id: storageState.connector?.id,
      },
    ]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
  });

  it("executes an external-code grant with catalog-owned storage", async () => {
    mockAwsExternalCodeProvider();
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-code-grant",
      connectorRef: "aws",
      label: "Catalog AWS",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "cli",
          grantKind: "external-code",
        });
        method.featureSwitch = "awsConnector";
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [awsPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.AwsConnector]: true,
    });
    const cleanupConnector = createConnectorCleanup(actor, "aws");
    onTestFinished(async () => {
      await cleanupConnector();
      await connectorsApi.deleteFeatureSwitches(actor);
    });
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.AwsConnector]: false,
    });
    const completed = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: awsVerificationCode(session.authorizationUrl),
    });
    expect(completed.connector).toMatchObject({
      type: "aws",
      authMethod: "cli",
      externalId: "123456789012",
      oauthScopes: ["openid"],
    });
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      secrets.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "CATALOG_AWS_ACCESS_KEY_ID",
        "CATALOG_AWS_LOGIN_DPOP_KEY",
        "CATALOG_AWS_LOGIN_REFRESH_TOKEN",
        "CATALOG_AWS_SECRET_ACCESS_KEY",
        "CATALOG_AWS_SESSION_TOKEN",
      ]),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
  });

  it("rejects new auth-code actions for an authored-hidden external method", async () => {
    mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", undefined);
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", undefined);
    configureSource();
    const hidden = publicAuthMethod({
      id: "oauth",
      grantKind: "auth-code",
    });
    hidden.visible = false;
    const release = buildRelease({
      version: "2026-07-15.external-hidden-auth-code",
      connectorRef: "slack",
      label: "Catalog Slack",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [hidden]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [slackPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const response = await connectorsApi.requestOauthStart(
      bdd.user(),
      "slack",
      "oauth",
      { statuses: [403] },
    );
    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "slack connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("revokes an external auth-code credential through its selected method", async () => {
    mockSlackConnectorOAuth();
    let revokeCalls = 0;
    server.use(
      http.post(SLACK_REVOKE_URL, ({ request }) => {
        revokeCalls += 1;
        expect(request.headers.get("authorization")).toBe(
          "Bearer xoxp-bdd-user-token",
        );
        return HttpResponse.json({ ok: true });
      }),
    );
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-auth-code-revoke",
      connectorRef: "slack",
      label: "Catalog Slack",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [slackPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
    const start = await connectorsApi.startOauth(actor, "slack", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Slack authorization state");
    }
    await connectorsApi.completeOauthCallback("slack", {
      code: "catalog-slack-code",
      state,
    });
    await connectorsApi.deleteConnectorByType(actor, "slack");
    expect(revokeCalls).toBe(1);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
  });

  it("keeps an in-flight provider operation on its selected external snapshot", async () => {
    mockSlackConnectorOAuth();
    configureSource();
    const firstRelease = buildRelease({
      version: "2026-07-15.external-in-flight-first",
      connectorRef: "slack",
      label: "Catalog Slack",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          slackPrivateAuthMethod("FIRST_RELEASE_SLACK_TOKEN", 7),
        ]);
      },
    });
    serveObjects(catalogObjects([firstRelease], firstRelease));
    await syncCatalog();

    const providerEntered = deferredGate();
    const providerResume = deferredGate();
    server.use(
      http.post(SLACK_OAUTH_TOKEN_URL, async () => {
        providerEntered.release();
        await providerResume.promise;
        return HttpResponse.json({
          ok: true,
          authed_user: {
            id: "U012AB3CD",
            access_token: "xoxp-in-flight-token",
            scope: "channels:read,chat:write",
          },
        });
      }),
      http.post(SLACK_REVOKE_URL, () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    const actor = bdd.user();
    const cleanupConnector = createConnectorCleanup(actor, "slack");
    onTestFinished(async () => {
      providerResume.release();
      await cleanupConnector();
    });
    const firstStart = await connectorsApi.startOauth(actor, "slack", "oauth");
    const firstState = new URL(firstStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!firstState) {
      throw new Error("Expected Slack authorization state");
    }
    const firstCallback = connectorsApi.completeOauthCallback("slack", {
      code: "first-release",
      state: firstState,
    });
    await providerEntered.promise;

    const secondRelease = buildRelease({
      version: "2026-07-15.external-in-flight-second",
      connectorRef: "slack",
      label: "Catalog Slack",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          slackPrivateAuthMethod("SECOND_RELEASE_SLACK_TOKEN", 8),
        ]);
      },
    });
    serveObjects(catalogObjects([firstRelease, secondRelease], secondRelease));
    await syncCatalog();
    const callsBeforeProviderResume = context.mocks.s3.send.mock.calls.length;
    providerResume.release();
    await firstCallback;

    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const firstSecrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({ headers }),
      [200],
    );
    expect(
      firstSecrets.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toContain("FIRST_RELEASE_SLACK_TOKEN");
    const firstStorageState = await readConnectorCredentialStorageState(
      context,
      {
        orgId: actor.orgId ?? "",
        userId: actor.userId,
        connectorRef: "slack",
        secretNames: ["FIRST_RELEASE_SLACK_TOKEN"],
      },
    );
    expect(firstStorageState.connector?.storage_version).toBe(7);
    expect(firstStorageState.secrets?.[0]?.connector_id).toBe(
      firstStorageState.connector?.id,
    );

    const secondStart = await connectorsApi.startOauth(actor, "slack", "oauth");
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!secondState) {
      throw new Error("Expected Slack authorization state");
    }
    await connectorsApi.completeOauthCallback("slack", {
      code: "second-release",
      state: secondState,
    });
    const secondSecrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({ headers }),
      [200],
    );
    expect(
      secondSecrets.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toContain("SECOND_RELEASE_SLACK_TOKEN");
    const secondStorageState = await readConnectorCredentialStorageState(
      context,
      {
        orgId: actor.orgId ?? "",
        userId: actor.userId,
        connectorRef: "slack",
      },
    );
    expect(secondStorageState.connector?.storage_version).toBe(8);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(
      callsBeforeProviderResume,
    );
  });

  it("uses one external release for readiness status and connector metadata", async () => {
    mockGmailConnectorOAuth({ email: "readiness@example.test" });
    configureSource();
    const connectedRelease = buildRelease({
      version: "2026-07-15.external-readiness",
      connectorRef: "gmail",
      label: "Catalog Gmail",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        const method = gmailPrivateAuthMethod();
        recordValue(method.storage, "storage").version = 7;
        setArtifactAuthMethods(artifact, [method]);
      },
    });
    serveObjects(catalogObjects([connectedRelease], connectedRelease));
    await syncCatalog();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    mockOptionalEnv(
      "GMAIL_PUBSUB_TOPIC_NAME",
      "projects/vm0-ai-488909/topics/gmail-events",
    );
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ connectors: [] }) },
            },
          ],
        });
      }),
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer catalog-refreshed-gmail-token",
          );
          return HttpResponse.json({
            historyId: "100",
            expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
          });
        },
      ),
    );

    const actor = bdd.user({ orgId: STAFF_ORG_ID });
    const created: { agentId?: string; workflowId?: string } = {};
    const cleanupConnector = createConnectorCleanup(actor, "gmail");
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      await cleanupConnector();
      if (created.workflowId) {
        await miscApi.deleteWorkflow(actor, created.workflowId, [204, 404]);
      }
      if (created.agentId) {
        await bdd.deleteAgent(actor, created.agentId);
      }
      await deleteOrgPlanEntitlementFixture(STAFF_ORG_ID);
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: STAFF_ORG_ID,
      status: "active",
      supportByok: true,
      restrictedVm0Models: false,
    });
    const oauth = await connectorsApi.startOauth(actor, "gmail", "oauth");
    const oauthState = new URL(oauth.authorizationUrl).searchParams.get(
      "state",
    );
    if (!oauthState) {
      throw new Error("Expected Gmail authorization state");
    }
    await connectorsApi.completeOauthCallback("gmail", {
      code: "external-readiness",
      state: oauthState,
    });
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const initialSecrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({ headers }),
      [200],
    );
    const initialAccessTokenDescription = initialSecrets.body.secrets.find(
      (secret) => {
        return secret.name === "CATALOG_GMAIL_ACCESS_TOKEN";
      },
    )?.description;
    expect(initialAccessTokenDescription).toBe(
      "Connector token output for gmail: CATALOG_GMAIL_ACCESS_TOKEN",
    );
    mockNow(new Date("2026-07-15T10:00:00.000Z"));
    const refreshBodies: URLSearchParams[] = [];
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        refreshBodies.push(body);
        return HttpResponse.json({
          access_token: "catalog-refreshed-gmail-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      }),
    );
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "External readiness agent",
      visibility: "private",
    });
    created.agentId = agent.agentId;
    const workflow = await accept(
      setupApp({ context })(zeroWorkflowsCollectionContract).create({
        headers,
        body: {
          agentId: agent.agentId,
          name: `external-readiness-${randomUUID().slice(0, 8)}`,
          instruction: "Handle incoming Gmail messages.",
        },
      }),
      [201],
    );
    created.workflowId = workflow.body.id;
    await accept(
      setupApp({ context })(zeroWorkflowAutomationsContract).create({
        headers,
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: {
            provider: "gmail",
            event: "new_message",
          },
        },
      }),
      [201],
    );
    expect(refreshBodies).toHaveLength(1);
    expect(refreshBodies[0]?.get("grant_type")).toBe("refresh_token");
    expect(refreshBodies[0]?.get("refresh_token")).toBe("gmail-refresh-token");
    const refreshedSecrets = await accept(
      setupApp({ context })(zeroSecretsContract).list({ headers }),
      [200],
    );
    expect(
      refreshedSecrets.body.secrets.find((secret) => {
        return secret.name === "CATALOG_GMAIL_ACCESS_TOKEN";
      })?.description,
    ).toBe(initialAccessTokenDescription);
    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
      connectorRef: "gmail",
      secretNames: [
        "CATALOG_GMAIL_ACCESS_TOKEN",
        "CATALOG_GMAIL_REFRESH_TOKEN",
      ],
    });
    expect(storageState.connector?.storage_version).toBe(7);
    expect(storageState.secrets).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "CATALOG_GMAIL_ACCESS_TOKEN",
          connector_id: storageState.connector?.id,
        }),
        expect.objectContaining({
          name: "CATALOG_GMAIL_REFRESH_TOKEN",
          connector_id: storageState.connector?.id,
        }),
      ]),
    );
    const unavailableRelease = buildRelease({
      version: "2026-07-15.external-readiness-unavailable",
      connectorRef: "gmail",
      label: "Catalog Gmail",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "oauth",
          grantKind: "auth-code",
        });
        method.visible = false;
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [gmailPrivateAuthMethod()]);
      },
    });
    serveObjects(
      catalogObjects(
        [connectedRelease, unavailableRelease],
        unavailableRelease,
      ),
    );
    await syncCatalog();

    const callsBeforeReadiness = context.mocks.s3.send.mock.calls.length;
    const readiness = await accept(
      setupApp({ context })(zeroWorkflowsDetailContract).connectorReadiness({
        headers,
        params: { workflowId: workflow.body.id },
      }),
      [200],
    );
    expect(readiness.body.connectors).toStrictEqual([
      {
        connectorRef: "gmail",
        label: "Catalog Gmail",
        icon: {
          url: expect.stringMatching(
            /^https:\/\/static\.vm0\.io\/platform\/views\/zero-page\/components\/settings\/icons\/gmail-[a-f0-9]{12}\.svg$/u,
          ),
          invertInDarkMode: false,
        },
        reason: "This workflow has a Gmail event automation.",
        status: "unavailable",
      },
    ]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeReadiness);
  });

  it("does not persist an in-flight refresh after the connector is replaced", async () => {
    mockGmailConnectorOAuth({ email: "refresh-race@example.test" });
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-refresh-replacement",
      connectorRef: "gmail",
      label: "Catalog Gmail",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [gmailPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    mockOptionalEnv(
      "GMAIL_PUBSUB_TOPIC_NAME",
      "projects/vm0-ai-488909/topics/gmail-events",
    );
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ connectors: [] }) },
            },
          ],
        });
      }),
    );

    const actor = bdd.user({ orgId: STAFF_ORG_ID });
    const created: { agentId?: string; workflowId?: string } = {};
    const refreshResume = deferredGate();
    const cleanupConnector = createConnectorCleanup(actor, "gmail");
    onTestFinished(async () => {
      refreshResume.release();
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      await cleanupConnector();
      if (created.workflowId) {
        await miscApi.deleteWorkflow(actor, created.workflowId, [204, 404]);
      }
      if (created.agentId) {
        await bdd.deleteAgent(actor, created.agentId);
      }
      await deleteOrgPlanEntitlementFixture(STAFF_ORG_ID);
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: STAFF_ORG_ID,
      status: "active",
      supportByok: true,
      restrictedVm0Models: false,
    });
    const initialOauth = await connectorsApi.startOauth(
      actor,
      "gmail",
      "oauth",
    );
    const initialState = new URL(
      initialOauth.authorizationUrl,
    ).searchParams.get("state");
    if (!initialState) {
      throw new Error("Expected initial Gmail authorization state");
    }
    await connectorsApi.completeOauthCallback("gmail", {
      code: "initial",
      state: initialState,
    });

    mockNow(new Date("2026-07-15T10:00:00.000Z"));
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Refresh replacement agent",
      visibility: "private",
    });
    created.agentId = agent.agentId;
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const workflow = await accept(
      setupApp({ context })(zeroWorkflowsCollectionContract).create({
        headers,
        body: {
          agentId: agent.agentId,
          name: `refresh-replacement-${randomUUID().slice(0, 8)}`,
          instruction: "Handle incoming Gmail messages.",
        },
      }),
      [201],
    );
    created.workflowId = workflow.body.id;

    const refreshEntered = deferredGate();
    const watchAuthorizations: string[] = [];
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") === "refresh_token") {
          refreshEntered.release();
          await refreshResume.promise;
          return HttpResponse.json({
            access_token: "stale-refreshed-gmail-token",
            refresh_token: "stale-rotated-gmail-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "https://www.googleapis.com/auth/gmail.modify",
          });
        }
        return HttpResponse.json({
          access_token: "replacement-gmail-token",
          refresh_token: "replacement-gmail-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      }),
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        ({ request }) => {
          watchAuthorizations.push(request.headers.get("authorization") ?? "");
          return HttpResponse.json({
            historyId: "100",
            expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
          });
        },
      ),
    );

    const firstCreate = accept(
      setupApp({ context })(zeroWorkflowAutomationsContract).create({
        headers,
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [400],
    );
    await refreshEntered.promise;

    const replacementOauth = await connectorsApi.startOauth(
      actor,
      "gmail",
      "oauth",
    );
    const replacementState = new URL(
      replacementOauth.authorizationUrl,
    ).searchParams.get("state");
    if (!replacementState) {
      throw new Error("Expected replacement Gmail authorization state");
    }
    await connectorsApi.completeOauthCallback("gmail", {
      code: "replacement",
      state: replacementState,
    });
    refreshResume.release();

    const rejected = await firstCreate;
    expect(rejected.body.error.message).toBe(
      "Reconnect Gmail before using Gmail event automations",
    );
    await expect(
      connectorsApi.readConnectorByType(actor, "gmail"),
    ).resolves.toMatchObject({
      connectionStatus: "connected",
      reconnectReason: null,
    });

    await accept(
      setupApp({ context })(zeroWorkflowAutomationsContract).create({
        headers,
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    expect(watchAuthorizations).toStrictEqual([
      "Bearer replacement-gmail-token",
    ]);
  });

  it("derives connected scope and refresh status from the accepted release", async () => {
    mockDatadogConnectorOAuth();
    configureSource();
    const matching = buildRelease({
      version: "2026-07-15.external-connected-status",
      connectorRef: "datadog",
      label: "Datadog",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "oauth",
          grantKind: "auth-code",
        });
        method.featureSwitch = "datadogConnector";
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          datadogPrivateAuthMethod(["dashboards_read", "logs_read_index_data"]),
        ]);
      },
    });
    serveObjects(catalogObjects([matching], matching));
    await syncCatalog();
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: false,
    });
    const cleanupConnector = createConnectorCleanup(actor, "datadog");
    onTestFinished(async () => {
      await cleanupConnector();
      await connectorsApi.deleteFeatureSwitches(actor);
    });
    const start = await connectorsApi.startOauth(actor, "datadog", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Datadog authorization state");
    }
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: false,
    });
    const callback = await connectorsApi.completeOauthCallback("datadog", {
      code: "external-catalog-status",
      state,
      domain: "us3.datadoghq.com",
    });
    const callbackLocation = callback.headers.get("location");
    expect(callbackLocation).not.toBeNull();
    expect(
      new URL(callbackLocation ?? "https://invalid.example").pathname,
    ).toBe("/connector/success");
    const hiddenConnectedList = await connectorsApi.listConnectors(actor);
    expect(hiddenConnectedList.configuredTypes).not.toContain("datadog");
    expect(hiddenConnectedList.connectors).toContainEqual(
      expect.objectContaining({ type: "datadog", authMethod: "oauth" }),
    );
    expect(hiddenConnectedList.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "datadog",
        authMethod: "oauth",
        name: "DATADOG_TOKEN",
      }),
    );
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: true,
    });

    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({ context })(zeroConnectorCatalogContract);
    const connected = await accept(catalogClient.status({ headers }), [200]);
    expect(connected.body.connectors[0]).toMatchObject({
      connectorRef: "datadog",
      connected: true,
      connectionStatus: "connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: true,
      tokenExpiresAt: expect.any(String),
      singleAuthCodeAuthMethodId: "oauth",
      connection: {
        authMethod: "oauth",
        externalUsername: "us3.datadoghq.com",
        externalEmail: null,
        reconnectReason: null,
      },
    });
    expect(connected.body.connectors[0]?.connection).not.toHaveProperty(
      "oauthScopes",
    );

    const changedScopes = buildRelease({
      version: "2026-07-15.external-scope-change",
      connectorRef: "datadog",
      label: "Datadog",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "oauth",
          grantKind: "auth-code",
        });
        method.featureSwitch = "datadogConnector";
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          datadogPrivateAuthMethod([
            "dashboards_read",
            "logs_read_index_data",
            "future_scope",
          ]),
        ]);
      },
    });
    serveObjects(catalogObjects([matching, changedScopes], changedScopes));
    await syncCatalog();
    const mismatched = await accept(catalogClient.status({ headers }), [200]);
    expect(mismatched.body.connectors[0]).toMatchObject({
      connectorRef: "datadog",
      connected: true,
      connectionStatus: "scope-mismatch",
      scopeMismatch: true,
      authMethodSupportsRefresh: true,
    });
  });

  it("fails closed without accepted catalog state", async () => {
    configureSource();
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const callsBeforeRead = context.mocks.s3.send.mock.calls.length;
    const catalogClient = setupApp({ context })(zeroConnectorCatalogContract);
    const headers = { authorization: "Bearer clerk-session" };

    const catalogResponse = await accept(
      catalogClient.list({ headers }),
      [503],
    );
    const catalogStatusResponse = await accept(
      catalogClient.status({ headers }),
      [503],
    );
    const searchResponse = await accept(
      setupApp({ context })(zeroConnectorsSearchContract).search({
        headers,
        query: {},
      }),
      [503],
    );
    const expectedError = {
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Connector catalog is temporarily unavailable",
      },
    };
    expect(catalogResponse.body).toStrictEqual(expectedError);
    expect(catalogStatusResponse.body).toStrictEqual(expectedError);
    expect(searchResponse.body).toStrictEqual(expectedError);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeRead);
  });

  it("accepts a complete generated firewall projection", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.generated-firewall",
      generatedFirewall: true,
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
  });

  it("merges duplicate dynamic firewall execution templates", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.duplicate-dynamic-firewall-base",
      connectorRef: "dynamic-firewall",
      label: "Dynamic Firewall",
      generatedFirewall: true,
      mutateRuntime: addDynamicFirewallVariableBinding,
      mutateFirewall: addDuplicateDynamicPrivateFirewallApi,
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const diagnostic = await accept(
      setupApp({ context })(zeroConnectorCheckContract).check({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          mode: "url",
          method: "GET",
          url: "https://tenant.example.test/v1/items",
          connectorRef: "dynamic-firewall",
        },
      }),
      [200],
    );
    expect(diagnostic.body).toMatchObject({
      outcome: "resolved",
      connector: {
        connectorRef: "dynamic-firewall",
        label: "Dynamic Firewall",
      },
      permission: {
        kind: "matched",
        permissions: [{ name: "items.read" }],
      },
    });
  });

  it("accepts canonical firewall bases with authority parameters", async () => {
    configureSource();
    const base = "https://{awsHost+}.amazonaws.com";
    const release = buildRelease({
      version: "2026-07-15.parameterized-firewall",
      generatedFirewall: true,
      mutateFirewall: (artifact) => {
        setFirewallBase(artifact, base);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts a complete bundled skill descriptor", async () => {
    configureSource();
    const resolvedStorageName = `connector-skill@resolved-${randomUUID().slice(0, 8)}`;
    const skill = buildBundledSkillFixture(
      "external-test",
      createHash("sha256").update(randomUUID()).digest("hex"),
      resolvedStorageName,
    );
    const previous = await readVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName: skill.storageName,
    });
    onTestFinished(async () => {
      await restoreVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: skill.storageName,
        previous,
      });
    });
    const release = buildRelease({
      version: "2026-07-15.bundled-skill",
      mutateRuntime: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        connector.skill = skill.descriptor;
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
    await expect(
      readVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: skill.storageName,
      }),
    ).resolves.toStrictEqual({
      s3_prefix: skill.s3Prefix,
      size: skill.contentSize,
      file_count: 1,
      head_version_id: skill.versionId,
    });
    const requestedKeys = context.mocks.s3.send.mock.calls.map((call) => {
      const input = commandInput(call[0]);
      return typeof input.Key === "string" ? input.Key : null;
    });
    expect(requestedKeys).not.toContain(skill.manifestKey);
    expect(requestedKeys).not.toContain(skill.archiveKey);
  });

  it("rejects incomplete or out-of-range bundled skill metadata", async () => {
    const cases = [
      {
        field: "size",
        label: "missing-size",
        value: undefined,
      },
      {
        field: "archiveSize",
        label: "oversized-archive",
        value: 2 * 1024 * 1024 + 1,
      },
      {
        field: "fileCount",
        label: "empty-manifest",
        value: 0,
      },
    ] as const;

    for (const testCase of cases) {
      configureSource();
      const connectorRef = `skill-${testCase.label}-${randomUUID().slice(0, 8)}`;
      const skill = buildBundledSkillFixture(
        connectorRef,
        createHash("sha256")
          .update(`${testCase.label}:${randomUUID()}`)
          .digest("hex"),
      );
      const previous = await readVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: skill.storageName,
      });
      onTestFinished(async () => {
        await restoreVolumeStorageState({
          orgId: SYSTEM_ORG_ID,
          storageName: skill.storageName,
          previous,
        });
      });
      const release = buildRelease({
        version: `2026-07-22.skill-${testCase.label}-${randomUUID().slice(0, 8)}`,
        connectorRef,
        mutateRuntime: (artifact) => {
          const descriptor = structuredClone(skill.descriptor);
          if (testCase.value === undefined) {
            delete descriptor[testCase.field];
          } else {
            descriptor[testCase.field] = testCase.value;
          }
          firstRecord(artifact.connectors, "connectors").skill = descriptor;
        },
      });
      serveObjects(catalogObjects([release], release));

      const response = await syncCatalog();
      expect(response.body).toMatchObject({
        outcome: "rejected",
        state: "never-synced",
        active: null,
        lastAttempt: { failureCode: "invalid-artifact" },
      });
      await expect(
        readVolumeStorageState({
          orgId: SYSTEM_ORG_ID,
          storageName: skill.storageName,
        }),
      ).resolves.toBeNull();
    }
  });

  it("reuses immutable skill versions without regressing HEAD", async () => {
    configureSource();
    const connectorRef = `skill-cache-${randomUUID().slice(0, 8)}`;
    const firstSkill = buildBundledSkillFixture(
      connectorRef,
      createHash("sha256").update(`first:${randomUUID()}`).digest("hex"),
    );
    const secondSkill = buildBundledSkillFixture(
      connectorRef,
      createHash("sha256").update(`second:${randomUUID()}`).digest("hex"),
    );
    const previous = await readVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName: firstSkill.storageName,
    });
    onTestFinished(async () => {
      await restoreVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: firstSkill.storageName,
        previous,
      });
    });
    const firstRelease = buildRelease({
      version: `2026-07-22.skill-cache-first-${randomUUID().slice(0, 8)}`,
      connectorRef,
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill =
          firstSkill.descriptor;
      },
    });
    const secondRelease = buildRelease({
      version: `2026-07-22.skill-cache-second-${randomUUID().slice(0, 8)}`,
      connectorRef,
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill =
          secondSkill.descriptor;
      },
    });
    const oldRetryRelease = buildRelease({
      version: `2026-07-22.skill-cache-old-${randomUUID().slice(0, 8)}`,
      connectorRef,
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill =
          firstSkill.descriptor;
      },
    });

    serveObjects(catalogObjects([firstRelease], firstRelease));
    expect((await syncCatalog()).body.outcome).toBe("accepted");

    serveObjects(catalogObjects([firstRelease, secondRelease], secondRelease));
    expect((await syncCatalog()).body.outcome).toBe("accepted");

    context.mocks.s3.send.mockClear();
    serveObjects(
      catalogObjects(
        [firstRelease, secondRelease, oldRetryRelease],
        oldRetryRelease,
      ),
    );
    expect((await syncCatalog()).body.outcome).toBe("accepted");
    const requestedKeys = context.mocks.s3.send.mock.calls.map((call) => {
      const input = commandInput(call[0]);
      return typeof input.Key === "string" ? input.Key : null;
    });
    expect(requestedKeys).not.toContain(firstSkill.manifestKey);
    expect(requestedKeys).not.toContain(firstSkill.archiveKey);
    await expect(
      readVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: firstSkill.storageName,
      }),
    ).resolves.toMatchObject({
      head_version_id: secondSkill.versionId,
    });
  });

  it("rolls back all skill registrations and retries a repaired conflict", async () => {
    configureSource();
    const suffix = randomUUID().slice(0, 8);
    const firstConnectorRef = `skill-atomic-a-${suffix}`;
    const conflictingConnectorRef = `skill-atomic-b-${suffix}`;
    const firstSkill = buildBundledSkillFixture(
      firstConnectorRef,
      createHash("sha256").update(`first:${randomUUID()}`).digest("hex"),
    );
    const conflictingSkill = buildBundledSkillFixture(
      conflictingConnectorRef,
      createHash("sha256").update(`conflict:${randomUUID()}`).digest("hex"),
    );
    const previousFirst = await readVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName: firstSkill.storageName,
    });
    const previousConflicting = await readVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName: conflictingSkill.storageName,
    });
    onTestFinished(async () => {
      await restoreVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: firstSkill.storageName,
        previous: previousFirst,
      });
      await restoreVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: conflictingSkill.storageName,
        previous: previousConflicting,
      });
    });
    const wrongPrefix = `${SYSTEM_ORG_ID}/volume/wrong-${conflictingSkill.storageName}`;
    const existingVersionId = createHash("sha256")
      .update(`existing:${randomUUID()}`)
      .digest("hex");
    await seedVolumeStorageVersion({
      orgId: SYSTEM_ORG_ID,
      storageName: conflictingSkill.storageName,
      versionId: existingVersionId,
      s3Prefix: wrongPrefix,
      s3Key: `${wrongPrefix}/${existingVersionId}`,
    });
    const conflictingIconBytes = Buffer.from(
      `<svg>${conflictingConnectorRef}</svg>`,
    );
    const conflictingIconDigest = digest(conflictingIconBytes);
    const release = buildRelease({
      version: `2026-07-22.skill-conflict-${randomUUID().slice(0, 8)}`,
      connectorRef: firstConnectorRef,
      mutateCatalog: (artifact) => {
        arrayValue(artifact.connectors, "connectors").push(
          buildCatalogConnector({
            connectorRef: conflictingConnectorRef,
            label: "Conflicting Skill",
            iconKey:
              "platform/views/zero-page/components/settings/icons/" +
              `${conflictingConnectorRef}-${conflictingIconDigest.slice("sha256:".length, 19)}.svg`,
          }),
        );
      },
      mutateRuntime: (artifact) => {
        const connectors = arrayValue(artifact.connectors, "connectors");
        firstRecord(connectors, "connectors").skill = firstSkill.descriptor;
        const conflictingConnector = recordValue(
          connectors[1],
          "connectors[1]",
        );
        const conflictingPrivateName = "ATOMIC_SKILL_B_TOKEN";
        const conflictingMethod = firstRecord(
          conflictingConnector.authMethods,
          "authMethods",
        );
        recordValue(conflictingMethod.storage, "storage").secrets = [
          conflictingPrivateName,
        ];
        firstRecord(
          recordValue(conflictingMethod.grant, "grant").fields,
          "grant.fields",
        ).privateName = conflictingPrivateName;
        recordValue(
          recordValue(conflictingMethod.access, "access").envBindings,
          "envBindings",
        ).SERVICE_TOKEN = `$secrets.${conflictingPrivateName}`;
        conflictingConnector.skill = conflictingSkill.descriptor;
      },
    });
    const objects = catalogObjects([release], release);
    serveObjects(objects);

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      active: null,
      lastAttempt: { failureCode: "invalid-reference" },
    });
    await expect(
      readVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: firstSkill.storageName,
      }),
    ).resolves.toBeNull();
    await expect(
      readVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: conflictingSkill.storageName,
      }),
    ).resolves.toStrictEqual({
      s3_prefix: wrongPrefix,
      size: 1,
      file_count: 1,
      head_version_id: existingVersionId,
    });

    await restoreVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName: conflictingSkill.storageName,
      previous: previousConflicting,
    });
    serveObjects(objects);
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
    for (const skill of [firstSkill, conflictingSkill]) {
      await expect(
        readVolumeStorageState({
          orgId: SYSTEM_ORG_ID,
          storageName: skill.storageName,
        }),
      ).resolves.toMatchObject({
        s3_prefix: skill.s3Prefix,
        head_version_id: skill.versionId,
      });
    }
  });

  it("rejects a connector skill version owned by another storage", async () => {
    configureSource();
    const connectorRef = `skill-owner-${randomUUID().slice(0, 8)}`;
    const skill = buildBundledSkillFixture(
      connectorRef,
      createHash("sha256").update(`shared:${randomUUID()}`).digest("hex"),
    );
    const ownerStorageName = `connector-skill@owner-${randomUUID().slice(0, 8)}`;
    const ownerPrefix = `${SYSTEM_ORG_ID}/volume/${ownerStorageName}`;
    const previousOwner = await readVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName: ownerStorageName,
    });
    const previousCandidate = await readVolumeStorageState({
      orgId: SYSTEM_ORG_ID,
      storageName: skill.storageName,
    });
    onTestFinished(async () => {
      await restoreVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: ownerStorageName,
        previous: previousOwner,
      });
      await restoreVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: skill.storageName,
        previous: previousCandidate,
      });
    });
    await seedVolumeStorageVersion({
      orgId: SYSTEM_ORG_ID,
      storageName: ownerStorageName,
      versionId: skill.versionId,
      s3Prefix: ownerPrefix,
      s3Key: `${ownerPrefix}/${skill.versionId}`,
    });
    const release = buildRelease({
      version: `2026-07-22.skill-owner-${randomUUID().slice(0, 8)}`,
      connectorRef,
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill = skill.descriptor;
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      active: null,
      lastAttempt: { failureCode: "invalid-reference" },
    });
    await expect(
      readVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: skill.storageName,
      }),
    ).resolves.toBeNull();
    const requestedKeys = context.mocks.s3.send.mock.calls.map((call) => {
      const input = commandInput(call[0]);
      return typeof input.Key === "string" ? input.Key : null;
    });
    expect(requestedKeys).not.toContain(skill.manifestKey);
    expect(requestedKeys).not.toContain(skill.archiveKey);
  });

  it.each(["storage name", "version ID"] as const)(
    "rejects bundled skills sharing one %s across connectors",
    async (sharedIdentity) => {
      configureSource();
      const suffix = randomUUID().slice(0, 8);
      const firstConnectorRef = `skill-identity-a-${suffix}`;
      const secondConnectorRef = `skill-identity-b-${suffix}`;
      const firstSkill = buildBundledSkillFixture(
        firstConnectorRef,
        createHash("sha256").update(`first:${randomUUID()}`).digest("hex"),
      );
      const secondSkill = buildBundledSkillFixture(
        secondConnectorRef,
        createHash("sha256").update(`second:${randomUUID()}`).digest("hex"),
      );
      const secondDescriptor = structuredClone(secondSkill.descriptor);
      if (sharedIdentity === "storage name") {
        secondDescriptor.storageName = firstSkill.storageName;
        secondDescriptor.storageVersionPrefix =
          `__system__/volume/${firstSkill.storageName}/` +
          `${secondSkill.versionId}`;
      } else {
        secondDescriptor.versionId = firstSkill.versionId;
        secondDescriptor.storageVersionPrefix =
          `__system__/volume/${secondSkill.storageName}/` +
          `${firstSkill.versionId}`;
      }
      const release = buildRelease({
        version:
          `2026-07-23.skill-identity-` +
          `${sharedIdentity === "storage name" ? "storage-name" : "version-id"}-${suffix}`,
        connectorRef: firstConnectorRef,
        mutateRuntime: (artifact) => {
          const connectors = arrayValue(artifact.connectors, "connectors");
          const first = firstRecord(connectors, "connectors");
          first.skill = firstSkill.descriptor;

          const second = structuredClone(first);
          second.connectorRef = secondConnectorRef;
          second.label = "Second Skill Identity";
          const secondMethod = firstRecord(second.authMethods, "authMethods");
          recordValue(secondMethod.storage, "storage").secrets = [
            "SECOND_SKILL_IDENTITY_TOKEN",
          ];
          firstRecord(
            recordValue(secondMethod.grant, "grant").fields,
            "grant.fields",
          ).privateName = "SECOND_SKILL_IDENTITY_TOKEN";
          recordValue(
            recordValue(secondMethod.access, "access").envBindings,
            "envBindings",
          ).SERVICE_TOKEN = "$secrets.SECOND_SKILL_IDENTITY_TOKEN";
          second.skill = secondDescriptor;
          connectors.push(second);
        },
      });
      serveObjects(catalogObjects([release], release));

      expect((await syncCatalog()).body).toMatchObject({
        outcome: "rejected",
        state: "never-synced",
        active: null,
        lastAttempt: { failureCode: "relationship-mismatch" },
      });
    },
  );

  it("accepts source identities and platform requirements without local support", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.future-capability",
      mutateCatalog: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        firstRecord(connector.authMethods, "authMethods").id =
          "service-account";
      },
      mutateRuntime: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        const method = firstRecord(connector.authMethods, "authMethods");
        method.id = "service-account";
        const access = recordValue(method.access, "access");
        access.platformSecrets = ["FUTURE_PLATFORM_KEY"];
        recordValue(access.envBindings, "envBindings").PLATFORM_KEY =
          "$secrets.FUTURE_PLATFORM_KEY";
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
    const response = await accept(
      runnerFirewallClient().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: {},
      }),
      [200],
    );
    expect(response.body.firewalls).not.toHaveProperty(release.connectorRef);
  });

  it("serializes overlapping syncs without a mixed snapshot", async () => {
    configureSource();
    const release = buildRelease({ version: "2026-07-15.concurrent" });
    serveObjects(catalogObjects([release], release));
    const results = await Promise.all([syncCatalog(), syncCatalog()]);
    expect(
      results
        .map((result) => {
          return result.body.outcome;
        })
        .sort(),
    ).toStrictEqual(["accepted", "unchanged"]);
    expect((await readStatus()).body).toMatchObject({
      state: "current",
      active: { catalogVersion: release.version },
    });
  });

  it("rolls back a candidate snapshot when its state compare-and-swap loses", async () => {
    configureSource();
    const losing = buildRelease({
      version: "2026-07-15.losing",
      label: "Losing Candidate",
    });
    const winning = buildRelease({
      version: "2026-07-15.winning",
      label: "Winning Candidate",
    });
    const replacement = buildRelease({
      version: losing.version,
      label: "Replacement Candidate",
    });
    const objects = catalogObjects([losing, winning], winning);
    const losingPublicKey = releaseKeys(losing.version).catalog;
    const blocked = deferredGate();
    const resume = deferredGate();
    const activePointers = [losing.pointer, winning.pointer, winning.pointer];
    let activeReads = 0;
    let blockedLosingPublic = false;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const key = commandInput(command).Key;
      if (key === losingPublicKey && !blockedLosingPublic) {
        blockedLosingPublic = true;
        blocked.release();
        await resume.promise;
      }
      const bytes =
        key === ACTIVE_KEY
          ? activePointers[activeReads++]
          : typeof key === "string"
            ? objects.get(key)
            : undefined;
      if (!bytes) {
        throw new Error("Object unavailable");
      }
      return {
        ContentLength: bytes.length,
        Body: s3Body(bytes),
      };
    });

    const losingSync = syncCatalog();
    await blocked.promise;
    const settledWinningResult = await settle(syncCatalog(), context.signal);
    resume.release();
    if (!settledWinningResult.ok) {
      throw settledWinningResult.error;
    }
    const winningResult = settledWinningResult.value;
    const losingResult = await losingSync;
    expect(winningResult.body.outcome).toBe("accepted");
    expect(losingResult.body.outcome).toBe("unchanged");

    serveObjects(catalogObjects([replacement], replacement));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: replacement.version },
    });
  });

  it("advances on the next sync when active changes during validation", async () => {
    configureSource();
    const observed = buildRelease({ version: "2026-07-15.observed" });
    const current = buildRelease({ version: "2026-07-15.current" });
    const objects = catalogObjects([observed, current], current);
    let activePointer = observed.pointer;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const key = commandInput(command).Key;
      if (key === observed.catalogKey) {
        activePointer = current.pointer;
      }
      const bytes =
        key === ACTIVE_KEY
          ? activePointer
          : typeof key === "string"
            ? objects.get(key)
            : undefined;
      if (!bytes) {
        return Promise.reject(new Error("Object unavailable"));
      }
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: s3Body(bytes),
      });
    });

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: observed.version },
    });
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: current.version },
    });
  });
});

describe("connector catalog executable compatibility", () => {
  it("leaves feature-switch rollout out of executable compatibility", async () => {
    configureSource();
    const unknownSwitch = buildRelease({
      version: "2026-07-15.unknown-feature-switch",
      mutateCatalog: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        method.featureSwitch = "futureConnectorSwitch";
      },
    });
    serveObjects(catalogObjects([unknownSwitch], unknownSwitch));

    expect((await syncCatalog()).body.filtering).toMatchObject({
      stale: false,
      filteredAuthMethods: [],
    });
  });

  it("accepts inline confidential test clients and applies rollout at request time", async () => {
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    const provider = mockTestOAuthAuthCodeProvider({
      refreshToken: "catalog-test-oauth-refresh",
    });
    configureSource();
    const method = publicAuthMethod({
      id: "oauth",
      grantKind: "auth-code",
    });
    method.featureSwitch = "testOauthConnector";
    const release = buildRelease({
      version: "2026-07-24.inline-confidential-test-client",
      connectorRef: "test-oauth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [testOauthPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body.filtering).toMatchObject({
      stale: false,
      filteredAuthMethods: [],
    });
    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "test-oauth"));
    zeroMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({ context })(zeroConnectorCatalogContract);
    const featureClient = setupApp({ context })(zeroFeatureSwitchesContract);

    expect(
      (await accept(catalogClient.list({ headers }), [200])).body,
    ).toStrictEqual({
      connectors: [],
      categoryMetadata: { categories: [], groups: [] },
    });
    await accept(
      featureClient.update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.TestOauthConnector]: true },
        },
      }),
      [200],
    );
    const enabled = await accept(catalogClient.list({ headers }), [200]);
    expect(enabled.body.connectors).toMatchObject([
      {
        connectorRef: "test-oauth",
        authMethods: [{ id: "oauth", grantKind: "auth-code" }],
      },
    ]);
    expect(JSON.stringify(enabled.body)).not.toContain("test-oauth-secret");

    const start = await connectorsApi.startOauth(actor, "test-oauth", "oauth");
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-oauth-client",
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected test OAuth authorization state");
    }
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "catalog-test-oauth-code",
      state,
    });
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("client_secret")).toBe(
      "test-oauth-secret",
    );
  });

  it("filters unsupported grant, access, and revoke handlers independently", async () => {
    configureSource();
    const publicMethods = [
      publicAuthMethod({ id: "oauth", grantKind: "device-auth" }),
      publicAuthMethod({
        id: "api-token",
        grantKind: "manual",
        manual: true,
      }),
      publicAuthMethod({ id: "cli", grantKind: "manual", manual: true }),
      publicAuthMethod({ id: "api", grantKind: "manual", manual: true }),
    ];
    const privateMethods = [
      devicePrivateAuthMethod(),
      manualPrivateAuthMethod({
        id: "api-token",
        prefix: "ACCESS",
        access: "refresh-token",
        revoke: "none",
      }),
      manualPrivateAuthMethod({
        id: "cli",
        prefix: "REVOKE",
        access: "static",
        revoke: "token-revoke",
      }),
      manualPrivateAuthMethod({
        id: "api",
        prefix: "GENERIC",
        access: "static",
        revoke: "none",
      }),
    ];
    const partial = buildRelease({
      version: "2026-07-15.partial-compatibility",
      connectorRef: "future-auth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, publicMethods);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, privateMethods);
      },
    });
    serveObjects(catalogObjects([partial], partial));

    expect((await syncCatalog()).body.filtering).toMatchObject({
      stale: false,
      filteredAuthMethods: [
        {
          connectorRef: "future-auth",
          authMethodId: "api-token",
          reasons: ["missing-access-provider"],
        },
        {
          connectorRef: "future-auth",
          authMethodId: "cli",
          reasons: ["missing-revoke-provider"],
        },
        {
          connectorRef: "future-auth",
          authMethodId: "oauth",
          reasons: ["missing-grant-provider"],
        },
      ],
    });
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const diagnostic = await accept(
      setupApp({ context })(zeroConnectorCheckContract).check({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          mode: "environment",
          environmentName: "TEST_OAUTH_DEVICE_TOKEN",
        },
      }),
      [200],
    );
    expect(diagnostic.body).toStrictEqual({
      outcome: "unknown-environment",
    });

    const allFiltered = buildRelease({
      version: "2026-07-15.all-filtered",
      connectorRef: "future-auth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, publicMethods.slice(0, 3));
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, privateMethods.slice(0, 3));
      },
    });
    serveObjects(catalogObjects([partial, allFiltered], allFiltered));
    expect(
      (await syncCatalog()).body.filtering.filteredAuthMethods,
    ).toHaveLength(3);
  });

  it("ignores filtered sibling methods when choosing the callback origin", async () => {
    configureSource();
    mockEnv("VM0_WEB_URL", "https://app.vm0.test");
    mockOptionalEnv("CLOUDFLARE_OAUTH_CLIENT_ID", "cloudflare-client-id");
    mockOptionalEnv(
      "CLOUDFLARE_OAUTH_CLIENT_SECRET",
      "cloudflare-client-secret",
    );
    const release = buildRelease({
      version: "2026-07-15.filtered-callback-origin",
      connectorRef: "cloudflare",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
          publicAuthMethod({ id: "future-web", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          cloudflarePrivateAuthMethod(),
          unsupportedWebAuthCodePrivateAuthMethod(),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect(
      (await syncCatalog()).body.filtering.filteredAuthMethods,
    ).toStrictEqual([
      {
        connectorRef: "cloudflare",
        authMethodId: "future-web",
        reasons: ["missing-grant-provider", "provider-contract-mismatch"],
      },
    ]);

    const response = await requestOauthCallbackRaw(context, {
      origin: "https://api.vm0.ai",
      type: "cloudflare",
      query: { code: "missing-state" },
    });
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://app.vm0.test");
    expect(location.pathname).toBe("/connector/error");
    expect(location.searchParams.get("message")).toBe(
      "Missing state parameter",
    );
  });

  it("rejects unapproved configuration identities without reading them", async () => {
    configureSource();
    const unapprovedName = "FUTURE_PLATFORM_KEY";
    const release = buildRelease({
      version: "2026-07-15.unapproved-configuration",
      mutateRuntime: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        const access = recordValue(method.access, "access");
        access.platformSecrets = [unapprovedName];
        recordValue(access.envBindings, "envBindings").FUTURE_KEY =
          `$secrets.${unapprovedName}`;
      },
    });
    serveObjects(catalogObjects([release], release));
    const accepted = await syncCatalog();
    expect(accepted.body.filtering).toMatchObject({
      evaluatedAt: FIRST_SYNC_TIME,
      stale: false,
      filteredAuthMethods: [
        {
          connectorRef: release.connectorRef,
          authMethodId: "api-token",
          reasons: ["provider-contract-mismatch"],
        },
      ],
    });

    mockNow(new Date("2026-07-15T08:10:00.000Z"));
    mockOptionalEnv(unapprovedName, "must-not-affect-capabilities");
    const unchanged = await syncCatalog();
    expect(unchanged.body.filtering).toStrictEqual(accepted.body.filtering);
    expect(JSON.stringify(unchanged.body)).not.toContain(unapprovedName);
  });

  it("matches provider fields without pinning catalog storage names", async () => {
    configureSource();
    mockOptionalEnv("DEEL_OAUTH_CLIENT_ID", "configured-client-id");
    mockOptionalEnv("DEEL_OAUTH_CLIENT_SECRET", "configured-client-secret");
    const release = buildRelease({
      version: "2026-07-15.deel-storage-mapping",
      connectorRef: "deel",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [deelPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));

    const response = await syncCatalog();
    expect(response.body.filtering).toMatchObject({
      evaluatedAt: FIRST_SYNC_TIME,
      stale: false,
      filteredAuthMethods: [],
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "CATALOG_DEEL_ACCESS_TOKEN",
    );
  });

  it("reconciles configuration changes and retains rolling-build evaluations", async () => {
    configureSource();
    mockOptionalEnv("STEAM_WEB_API_KEY", undefined);
    const first = buildRelease({
      version: "2026-07-15.steam-1",
      connectorRef: "steam",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [steamPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([first], first));
    const missingConfiguration = await syncCatalog();
    expect(missingConfiguration.body.filtering).toMatchObject({
      evaluatedAt: FIRST_SYNC_TIME,
      stale: false,
      filteredAuthMethods: [
        {
          connectorRef: "steam",
          authMethodId: "openid",
          reasons: ["missing-platform-configuration"],
        },
      ],
    });
    const firstDigest = missingConfiguration.body.filtering.capabilityDigest;
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const catalogClient = setupApp({ context })(zeroConnectorCatalogContract);
    const headers = { authorization: "Bearer clerk-session" };
    expect(
      (await accept(catalogClient.list({ headers }), [200])).body,
    ).toMatchObject({ connectors: [] });

    mockOptionalEnv("STEAM_WEB_API_KEY", "configured");
    const callsBeforeStaleStatus = context.mocks.s3.send.mock.calls.length;
    const stale = await readStatus();
    expect(stale.body.filtering).toMatchObject({
      evaluatedAt: null,
      stale: true,
      filteredAuthMethods: [],
    });
    expect(stale.body.filtering.capabilityDigest).not.toBe(firstDigest);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeStaleStatus);
    const stalePublicRead = await accept(
      catalogClient.list({ headers }),
      [503],
    );
    expect(stalePublicRead.body).toStrictEqual({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Connector catalog is temporarily unavailable",
      },
    });
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeStaleStatus);

    mockNow(new Date("2026-07-15T08:20:00.000Z"));
    const rejected = buildRelease({
      version: "2026-07-15.rejected-after-config-change",
      mutatePointer: (pointer) => {
        pointer.extra = true;
      },
    });
    serveObjects(catalogObjects([first, rejected], rejected));
    const configured = await syncCatalog();
    expect(configured.body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      active: { catalogVersion: first.version },
    });
    expect(configured.body.filtering).toMatchObject({
      evaluatedAt: "2026-07-15T08:20:00.000Z",
      stale: false,
      filteredAuthMethods: [],
    });
    expect(configured.body.filtering.capabilityDigest).not.toBe(firstDigest);
    expect(
      (await accept(catalogClient.list({ headers }), [200])).body.connectors,
    ).toStrictEqual([expect.objectContaining({ connectorRef: "steam" })]);

    mockOptionalEnv("STEAM_WEB_API_KEY", undefined);
    expect((await readStatus()).body.filtering).toStrictEqual(
      missingConfiguration.body.filtering,
    );

    const second = buildRelease({
      version: "2026-07-15.steam-2",
      connectorRef: "steam",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [steamPrivateAuthMethod()]);
      },
    });
    mockOptionalEnv("STEAM_WEB_API_KEY", "configured");
    serveObjects(catalogObjects([first, second], second));
    await syncCatalog();
    mockOptionalEnv("STEAM_WEB_API_KEY", undefined);
    expect((await readStatus()).body.filtering).toMatchObject({
      capabilityDigest: firstDigest,
      evaluatedAt: null,
      stale: true,
      filteredAuthMethods: [],
    });
  });

  it("reports a known provider contract mismatch without private details", async () => {
    configureSource();
    mockOptionalEnv("STEAM_WEB_API_KEY", "configured");
    const release = buildRelease({
      version: "2026-07-15.provider-contract-mismatch",
      connectorRef: "steam",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          steamPrivateAuthMethod({ callbackOrigin: "web" }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));

    const response = await syncCatalog();
    expect(response.body.filtering.filteredAuthMethods).toStrictEqual([
      {
        connectorRef: "steam",
        authMethodId: "openid",
        reasons: ["provider-contract-mismatch"],
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain("STEAM_WEB_API_KEY");
  });
});

describe("connector catalog rejection and latest-valid retention", () => {
  it("classifies unavailable and oversized objects before acceptance", async () => {
    configureSource();
    context.mocks.s3.send.mockRejectedValue(
      new Error("private source credentials and URL must stay private"),
    );
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "source-unavailable",
    );

    configureSource();
    context.mocks.s3.send.mockResolvedValue({
      ContentLength: 16 * 1024 + 1,
      Body: s3Body(Buffer.from("oversized")),
    });
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "object-too-large",
    );

    configureSource();
    context.mocks.s3.send.mockResolvedValue({
      Body: s3Body(Buffer.alloc(16 * 1024 + 1)),
    });
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "object-too-large",
    );
  });

  it("accepts one connector sharing storage names across auth methods", async () => {
    configureSource();
    const release = buildRelease({
      version: "same-connector-storage-sharing",
      mutateCatalog: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        const methods = arrayValue(connector.authMethods, "authMethods");
        const second = structuredClone(firstRecord(methods, "authMethods"));
        second.id = "backup-token";
        second.label = "Backup Token";
        methods.push(second);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts producer connector order and scopes private-value leak detection", async () => {
    configureSource();
    const release = buildRelease({
      version: "cross-connector-private-name-placeholder",
      mutateCatalog: (artifact) => {
        const connectors = arrayValue(artifact.connectors, "connectors");
        const first = firstRecord(connectors, "connectors");
        const firstMethod = firstRecord(first.authMethods, "authMethods");
        firstRecord(
          recordValue(firstMethod.grant, "grant").fields,
          "grant.fields",
        ).placeholder = "your-second-api-key";

        const second = structuredClone(first);
        second.connectorRef = "aa-external-other";
        second.label = "External Other";
        const secondMethod = firstRecord(second.authMethods, "authMethods");
        recordValue(secondMethod.storage, "storage").secrets = [
          "SECOND_API_KEY",
        ];
        const secondField = firstRecord(
          recordValue(secondMethod.grant, "grant").fields,
          "grant.fields",
        );
        secondField.privateName = "SECOND_API_KEY";
        secondField.placeholder = null;
        recordValue(
          recordValue(secondMethod.access, "access").envBindings,
          "envBindings",
        ).SERVICE_TOKEN = "$secrets.SECOND_API_KEY";
        connectors.push(second);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts credentialed path variables without a host policy", async () => {
    configureSource();
    const release = buildRelease({
      version: "credentialed-firewall-path-variable",
      generatedFirewall: true,
      mutateRuntime: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        recordValue(method.storage, "storage").variables = [
          "QUICKBOOKS_REALM_ID",
        ];
        recordValue(
          recordValue(method.access, "access").envBindings,
          "envBindings",
        ).QUICKBOOKS_REALM_ID = "$vars.QUICKBOOKS_REALM_ID";
      },
      mutateFirewall: (artifact) => {
        setFirewallBase(
          artifact,
          `https://api.example.test/v3/company/${catalogTemplate("vars.QUICKBOOKS_REALM_ID")}`,
        );
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts a shared fixed host for auth.base placeholder routes", async () => {
    configureSource();
    const release = buildRelease({
      version: "shared-firewall-placeholder-host",
      connectorRef: "collision-a",
      generatedFirewall: true,
      mutateCatalog: (artifact) => {
        const connectors = arrayValue(artifact.connectors, "connectors");
        const first = firstRecord(connectors, "connectors");
        const firstFirewall = recordValue(first.firewall, "firewall");
        const firstConfig = recordValue(
          firstFirewall.config,
          "firewall.config",
        );
        const firstApi = firstRecord(firstConfig.apis, "firewall.apis");
        firstApi.base = "https://firewall-placeholder.vm3.ai/collision-a/hook";
        recordValue(firstApi.auth, "firewall auth").base = catalogTemplate(
          "secrets.SERVICE_TOKEN",
        );

        const second = structuredClone(first);
        second.connectorRef = "collision-b";
        second.label = "Collision B";
        const secondMethod = firstRecord(second.authMethods, "authMethods");
        recordValue(secondMethod.storage, "storage").secrets = [
          "SECOND_SECRET_TOKEN",
        ];
        firstRecord(
          recordValue(secondMethod.grant, "grant").fields,
          "grant.fields",
        ).privateName = "SECOND_SECRET_TOKEN";
        recordValue(
          recordValue(secondMethod.access, "access").envBindings,
          "envBindings",
        ).SERVICE_TOKEN = "$secrets.SECOND_SECRET_TOKEN";
        const secondFirewall = recordValue(second.firewall, "firewall");
        const secondConfig = recordValue(
          secondFirewall.config,
          "firewall.config",
        );
        firstRecord(secondConfig.apis, "firewall.apis").base =
          "https://firewall-placeholder.vm3.ai/collision-b/hook";
        connectors.push(second);
        connectors.reverse();
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const diagnostic = await accept(
      setupApp({ context })(zeroConnectorCheckContract).check({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          mode: "url",
          method: "GET",
          url: "https://firewall-placeholder.vm3.ai/collision-a/hook/items",
        },
      }),
      [200],
    );
    expect(diagnostic.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "collision-a" },
    });
  });

  it.each([
    {
      name: "invalid JSON",
      expected: "invalid-json",
      release: () => {
        const fixture = buildRelease({ version: "invalid-json" });
        return { ...fixture, pointer: Buffer.from("{") };
      },
    },
    {
      name: "strict pointer property",
      expected: "invalid-pointer",
      release: () => {
        return buildRelease({
          version: "invalid-pointer",
          mutatePointer: (pointer) => {
            pointer.extra = true;
          },
        });
      },
    },
    {
      name: "overlong catalog version",
      expected: "invalid-pointer",
      release: () => {
        return buildRelease({ version: "a".repeat(256) });
      },
    },
    {
      name: "legacy pointer reference",
      expected: "invalid-pointer",
      release: () => {
        return buildRelease({
          version: "legacy-pointer-reference",
          mutatePointer: (pointer) => {
            pointer.integrity = {
              key: "connectors/v1/releases/legacy-pointer-reference/integrity/catalog.json",
              digest: pointer.catalogDigest,
            };
            delete pointer.catalogDigest;
          },
        });
      },
    },
    {
      name: "catalog digest mismatch",
      expected: "digest-mismatch",
      release: () => {
        return buildRelease({
          version: "bad-catalog-digest",
          mutatePointer: (pointer) => {
            pointer.catalogDigest = ZERO_DIGEST;
          },
        });
      },
    },
    {
      name: "unsupported schema",
      expected: "unsupported-schema",
      release: () => {
        return buildRelease({
          version: "unsupported-schema",
          mutateArtifact: (artifact) => {
            artifact.artifactSchemaVersion = 2;
          },
        });
      },
    },
    {
      name: "legacy catalog source property",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "legacy-catalog-source-property",
          mutateArtifact: (artifact) => {
            artifact.catalogSource = {
              key: "catalog/catalog.yaml",
              digest: ZERO_DIGEST,
            };
          },
        });
      },
    },
    {
      name: "strict artifact property",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "invalid-artifact",
          mutateCatalog: (artifact) => {
            artifact.extra = true;
          },
        });
      },
    },
    {
      name: "missing storage version",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "missing-storage-version",
          mutateRuntime: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const method = firstRecord(connector.authMethods, "authMethods");
            delete recordValue(method.storage, "storage").version;
          },
        });
      },
    },
    {
      name: "non-positive storage version",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "non-positive-storage-version",
          mutateRuntime: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const method = firstRecord(connector.authMethods, "authMethods");
            recordValue(method.storage, "storage").version = 0;
          },
        });
      },
    },
    {
      name: "unsafe storage version",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "unsafe-storage-version",
          mutateRuntime: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const method = firstRecord(connector.authMethods, "authMethods");
            recordValue(method.storage, "storage").version =
              Number.MAX_SAFE_INTEGER + 1;
          },
        });
      },
    },
    {
      name: "legacy auth-method visibility field",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "legacy-auth-method-visibility",
          mutateCatalog: (artifact) => {
            const method = firstRecord(
              firstRecord(artifact.connectors, "connectors").authMethods,
              "authMethods",
            );
            method.defaultVisible = method.visible;
            delete method.visible;
          },
        });
      },
    },
    {
      name: "invalid UTF-8 artifact",
      expected: "invalid-json",
      release: () => {
        return buildRelease({
          version: "invalid-utf8",
          catalogBytes: Buffer.from([0xc3, 0x28]),
        });
      },
    },
    {
      name: "header mismatch",
      expected: "invalid-reference",
      release: () => {
        return buildRelease({
          version: "header-mismatch",
          mutateCatalog: (artifact) => {
            artifact.catalogVersion = "other";
          },
        });
      },
    },
    {
      name: "public private-value leak",
      expected: "public-leakage",
      release: () => {
        return buildRelease({
          version: "public-leak",
          mutateCatalog: (artifact) => {
            firstRecord(artifact.connectors, "connectors").description =
              PRIVATE_VALUE;
          },
        });
      },
    },
    {
      name: "duplicate auth method id",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "duplicate-auth-method-id",
          mutateCatalog: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const methods = arrayValue(connector.authMethods, "authMethods");
            methods.push(structuredClone(firstRecord(methods, "authMethods")));
          },
        });
      },
    },
    {
      name: "cross-connector storage secret collision",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "cross-connector-storage-secret",
          mutateCatalog: (artifact) => {
            const connectors = arrayValue(artifact.connectors, "connectors");
            const second = structuredClone(
              firstRecord(connectors, "connectors"),
            );
            second.connectorRef = "zz-external-other";
            second.label = "External Other";
            connectors.push(second);
          },
        });
      },
    },
    {
      name: "cross-connector storage variable collision",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "cross-connector-storage-variable",
          mutateCatalog: (artifact) => {
            const connectors = arrayValue(artifact.connectors, "connectors");
            const second = structuredClone(
              firstRecord(connectors, "connectors"),
            );
            second.connectorRef = "zz-external-other";
            second.label = "External Other";
            connectors.push(second);
          },
          mutateRuntime: (artifact) => {
            const connectors = arrayValue(artifact.connectors, "connectors");
            const firstConnector = firstRecord(connectors, "connectors");
            const firstMethod = firstRecord(
              firstConnector.authMethods,
              "authMethods",
            );
            recordValue(firstMethod.storage, "storage").variables = [
              "SHARED_VARIABLE",
            ];
            recordValue(
              recordValue(firstMethod.access, "access").envBindings,
              "envBindings",
            ).SHARED_VARIABLE = "$vars.SHARED_VARIABLE";

            const second = recordValue(connectors[1], "connectors[1]");
            const secondMethod = firstRecord(second.authMethods, "authMethods");
            recordValue(secondMethod.storage, "storage").variables = [
              "SHARED_VARIABLE",
            ];
            recordValue(secondMethod.storage, "storage").secrets = [
              "OTHER_TOKEN",
            ];
            firstRecord(
              recordValue(secondMethod.grant, "grant").fields,
              "fields",
            ).privateName = "OTHER_TOKEN";
            recordValue(
              recordValue(secondMethod.access, "access").envBindings,
              "envBindings",
            ).SERVICE_TOKEN = "$secrets.OTHER_TOKEN";
          },
        });
      },
    },
    {
      name: "reserved model-provider identity",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "model-provider-ref",
          mutateCatalog: (artifact) => {
            firstRecord(artifact.connectors, "connectors").connectorRef =
              "model-provider:external";
          },
        });
      },
    },
    {
      name: "invalid icon reference",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "invalid-icon-reference",
          mutateCatalog: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const icon = recordValue(connector.icon, "icon");
            icon.key = "../icon.svg";
          },
        });
      },
    },
    {
      name: "invalid skill reference",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "invalid-skill-reference",
          mutateRuntime: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const skill = buildBundledSkill("wrong");
            skill.storageVersionPrefix =
              "__system__/volume/connector-skill@other/" + "a".repeat(64);
            connector.skill = skill;
          },
        });
      },
    },
    {
      name: "generated firewall missing canonical config",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "firewall-mismatch",
          mutateCatalog: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            connector.firewall = {
              kind: "generated",
              permissions: [],
              categories: null,
              defaultAllowed: null,
              defaultUnknownPolicy: "allow",
            };
          },
        });
      },
    },
    {
      name: "non-HTTPS firewall base URL",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-http-base",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const config = recordValue(firewall.config, "firewall.config");
            firstRecord(config.apis, "firewall.apis").base =
              "http://api.example.test/v1";
          },
        });
      },
    },
    {
      name: "non-canonical firewall base hostname",
      expected: "relationship-mismatch",
      release: () => {
        const base = "https://API.EXAMPLE.TEST/v1";
        return buildRelease({
          version: "firewall-noncanonical-hostname",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            setFirewallBase(artifact, base);
          },
        });
      },
    },
    {
      name: "unsafe firewall base path",
      expected: "relationship-mismatch",
      release: () => {
        const base = "https://api.example.test/v1/../admin";
        return buildRelease({
          version: "firewall-unsafe-base-path",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            setFirewallBase(artifact, base);
          },
        });
      },
    },
    {
      name: "non-canonical firewall host policy",
      expected: "invalid-artifact",
      release: () => {
        const hostPolicy = {
          kind: "providerOwned",
          exactHosts: ["API.EXAMPLE.TEST"],
        };
        return buildRelease({
          version: "firewall-noncanonical-host-policy",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const config = recordValue(firewall.config, "firewall.config");
            firstRecord(config.apis, "firewall.apis").hostPolicy = hostPolicy;
          },
        });
      },
    },
    {
      name: "invalid firewall auth base URL",
      expected: "relationship-mismatch",
      release: () => {
        const authBase = "http://webhook.example.test/token";
        return buildRelease({
          version: "firewall-invalid-auth-base",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const config = recordValue(firewall.config, "firewall.config");
            const api = firstRecord(config.apis, "firewall.apis");
            recordValue(api.auth, "firewall auth").base = authBase;
          },
        });
      },
    },
    {
      name: "unknown firewall environment binding",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-unknown-binding",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const config = recordValue(firewall.config, "firewall.config");
            const api = firstRecord(config.apis, "firewall.apis");
            const auth = recordValue(api.auth, "firewall api auth");
            recordValue(auth.headers, "firewall auth headers")["X-Unknown"] =
              catalogTemplate("secrets.UNKNOWN_SECRET");
          },
        });
      },
    },
    {
      name: "conflicting duplicate dynamic firewall host policies",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-dynamic-base-host-policy-conflict",
          generatedFirewall: true,
          mutateRuntime: addDynamicFirewallVariableBinding,
          mutateFirewall: (artifact) => {
            addDuplicateDynamicPrivateFirewallApi(artifact, {
              conflictingHostPolicy: true,
            });
          },
        });
      },
    },
  ])("rejects $name", async ({ expected, release }) => {
    configureSource();
    const fixture = release();
    serveObjects(catalogObjects([fixture], fixture));
    expectRejectedBeforeAcceptance((await syncCatalog()).body, expected);
  });

  it("retains the latest valid snapshot and exposes sanitized status", async () => {
    configureSource();
    const accepted = buildRelease({ version: "2026-07-15.valid" });
    serveObjects(catalogObjects([accepted], accepted));
    const acceptedResponse = await syncCatalog();
    const acceptedDigest = acceptedResponse.body.active?.catalogDigest;

    const invalid = buildRelease({
      version: "2026-07-15.invalid",
      mutatePointer: (pointer) => {
        pointer.extra = `private-${PRIVATE_VALUE}`;
      },
    });
    serveObjects(catalogObjects([accepted, invalid], invalid));
    const rejected = await syncCatalog();
    expect(rejected.body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      active: {
        catalogVersion: accepted.version,
        catalogDigest: acceptedDigest,
      },
      lastAttempt: {
        outcome: "rejected",
        failureCode: "invalid-pointer",
      },
      lastSuccessAt: FIRST_SYNC_TIME,
    });

    const callsBeforeStatus = context.mocks.s3.send.mock.calls.length;
    expect((await readStatus()).body).toStrictEqual(
      (({ outcome: _outcome, ...status }) => {
        return status;
      })(rejected.body),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeStatus);
    expect(JSON.stringify(rejected.body)).not.toContain(PRIVATE_VALUE);

    serveObjects(catalogObjects([accepted], accepted));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "unchanged",
      state: "current",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: null,
    });
  });

  it("skips large artifacts for a deterministically rejected candidate", async () => {
    configureSource();
    const accepted = buildRelease({ version: "2026-07-15.cache-valid" });
    serveObjects(catalogObjects([accepted], accepted));
    await syncCatalog();

    const invalid = buildRelease({
      version: "2026-07-15.cache-invalid",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([accepted, invalid], invalid));
    const callsBeforeFirstRejection = context.mocks.s3.send.mock.calls.length;
    const freshRejection = await syncCatalog();
    expect(freshRejection.body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      lastAttempt: {
        failureCode: "invalid-artifact",
        reusedCachedRejection: false,
      },
      rejectedCandidate: {
        catalogVersion: invalid.version,
        failureCode: "invalid-artifact",
        backendVersion: DEFAULT_API_VERSION,
      },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeFirstRejection,
    ).toBe(2);

    const callsBeforeCachedRejection = context.mocks.s3.send.mock.calls.length;
    const cachedRejection = await syncCatalog();
    expect(cachedRejection.body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      lastAttempt: {
        failureCode: "invalid-artifact",
        reusedCachedRejection: true,
      },
      rejectedCandidate: {
        catalogVersion: invalid.version,
        failureCode: "invalid-artifact",
        backendVersion: DEFAULT_API_VERSION,
      },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeCachedRejection,
    ).toBe(1);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeCachedRejection]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(invalid.pointer),
    });
    expect(JSON.stringify(cachedRejection.body)).not.toContain(
      invalid.catalogKey,
    );
    expect(JSON.stringify(cachedRejection.body)).not.toContain(
      objectEtag(invalid.pointer),
    );
  });

  it("revalidates a rejection when the production backend version advances", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const invalid = buildRelease({
      version: "2026-07-25.backend-version-rejection",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([invalid], invalid));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: "1.318.0" },
    });

    setApiVersion("1.319.0");
    const callsBeforeNewBackend = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeNewBackend,
    ).toBe(2);

    setApiVersion("1.318.0");
    const callsBeforeOlderBackend = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: true },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeOlderBackend,
    ).toBe(1);
  });

  it("activates a candidate after backend-version revalidation succeeds", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const candidate = buildRelease({
      version: "2026-07-25.backend-version-acceptance",
    });
    const rejectedObjects = new Map(catalogObjects([candidate], candidate));
    rejectedObjects.set(candidate.catalogKey, Buffer.from("{}"));
    serveObjects(rejectedObjects);
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: {
        failureCode: "digest-mismatch",
        reusedCachedRejection: false,
      },
      rejectedCandidate: { backendVersion: "1.318.0" },
    });

    setApiVersion("1.319.0");
    serveObjects(catalogObjects([candidate], candidate));
    const callsBeforeAcceptance = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: candidate.version },
      lastAttempt: {
        failureCode: null,
        reusedCachedRejection: false,
      },
      rejectedCandidate: null,
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeAcceptance,
    ).toBe(2);
  });

  it("uses build commits to invalidate preview rejections", async () => {
    configureSource();
    mockEnv("ENV", "preview");
    mockEnv("GIT_COMMIT_SHA", "a".repeat(40));
    const invalid = buildRelease({
      version: "2026-07-25.preview-commit-rejection",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([invalid], invalid));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: DEFAULT_API_VERSION },
    });

    mockEnv("GIT_COMMIT_SHA", "b".repeat(40));
    const callsBeforeNewCommit = context.mocks.s3.send.mock.calls.length;
    const revalidated = await syncCatalog();
    expect(revalidated.body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: DEFAULT_API_VERSION },
    });
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeNewCommit).toBe(
      2,
    );

    const callsBeforeCachedCommit = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: true },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeCachedCommit,
    ).toBe(1);
    expect(JSON.stringify(revalidated.body)).not.toContain("a".repeat(40));
    expect(JSON.stringify(revalidated.body)).not.toContain("b".repeat(40));
  });

  it("keeps the newer rejection authority across concurrent backend versions", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const invalid = buildRelease({
      version: "2026-07-25.concurrent-backend-rejection",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    const objects = catalogObjects([invalid], invalid);
    const blocked = deferredGate();
    const resume = deferredGate();
    let blockedFirstCatalogRead = false;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const input = commandInput(command);
      const key = typeof input.Key === "string" ? input.Key : undefined;
      const bytes = key ? objects.get(key) : undefined;
      if (!bytes) {
        throw new Error("Object unavailable");
      }
      if (key === invalid.catalogKey && !blockedFirstCatalogRead) {
        blockedFirstCatalogRead = true;
        blocked.release();
        await resume.promise;
      }
      const etag = objectEtag(bytes);
      if (input.IfNoneMatch === etag) {
        throw Object.assign(new Error("Not modified"), {
          $metadata: { httpStatusCode: 304 },
        });
      }
      return {
        ContentLength: bytes.length,
        Body: s3Body(bytes),
        ETag: etag,
      };
    });

    const olderSync = syncCatalog();
    await blocked.promise;
    setApiVersion("1.319.0");
    const newerResult = await syncCatalog();
    resume.release();
    const olderResult = await olderSync;

    expect(newerResult.body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
    expect(olderResult.body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: true },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
    expect((await readStatus()).body).toMatchObject({
      lastAttempt: { reusedCachedRejection: true },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
  });

  it("re-evaluates a rejected identity when the pointer ETag changes", async () => {
    configureSource();
    const invalid = buildRelease({
      version: "2026-07-15.changed-rejection-etag",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([invalid], invalid));
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "invalid-artifact",
    );

    const changedPointer = Buffer.concat([invalid.pointer, Buffer.from("\n")]);
    const changedObjects = new Map(catalogObjects([invalid], invalid));
    changedObjects.set(ACTIVE_KEY, changedPointer);
    serveObjects(changedObjects);
    const callsBeforeReevaluation = context.mocks.s3.send.mock.calls.length;
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "invalid-artifact",
    );
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeReevaluation,
    ).toBe(2);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeReevaluation]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(invalid.pointer),
    });
  });

  it("caches an oversized active pointer by its observed ETag", async () => {
    configureSource();
    const oversizedPointer = Buffer.alloc(16 * 1024 + 1);
    const etag = objectEtag(oversizedPointer);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      if (input.IfNoneMatch === etag) {
        return Promise.reject(
          Object.assign(new Error("Not modified"), {
            $metadata: { httpStatusCode: 304 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: oversizedPointer.length,
        Body: s3Body(oversizedPointer),
        ETag: etag,
      });
    });
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "object-too-large",
    );

    const callsBeforeCachedRejection = context.mocks.s3.send.mock.calls.length;
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "object-too-large",
    );
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeCachedRejection,
    ).toBe(1);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeCachedRejection]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: etag,
    });
  });

  it("revalidates an ETag-only pointer rejection after a backend release", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const invalid = buildRelease({
      version: "2026-07-15.malformed-pointer-cache",
      mutatePointer: (pointer) => {
        pointer.extra = true;
      },
    });
    serveObjects(catalogObjects([invalid], invalid));
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "invalid-pointer",
    );

    const callsBeforeCachedRejection = context.mocks.s3.send.mock.calls.length;
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "invalid-pointer",
    );
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeCachedRejection,
    ).toBe(1);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeCachedRejection]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(invalid.pointer),
    });

    setApiVersion("1.319.0");
    const callsBeforeNewBackend = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: {
        failureCode: "invalid-pointer",
        reusedCachedRejection: false,
      },
      rejectedCandidate: {
        catalogVersion: null,
        catalogDigest: null,
        backendVersion: "1.319.0",
      },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeNewBackend,
    ).toBe(1);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeNewBackend]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
    });
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeNewBackend]?.[0],
      ),
    ).toMatchObject({
      IfNoneMatch: undefined,
    });
  });

  it("retries transient candidate download failures", async () => {
    configureSource();
    const candidate = buildRelease({
      version: "2026-07-15.transient-candidate",
    });
    const unavailableObjects = new Map(catalogObjects([candidate], candidate));
    unavailableObjects.delete(releaseKeys(candidate.version).catalog);
    serveObjects(unavailableObjects);
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      state: "never-synced",
      lastAttempt: { failureCode: "source-unavailable" },
    });

    serveObjects(catalogObjects([candidate], candidate));
    const callsBeforeRetry = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: candidate.version },
    });
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeRetry).toBe(2);
    expect(
      commandInput(context.mocks.s3.send.mock.calls[callsBeforeRetry]?.[0]),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(candidate.pointer),
    });
  });

  it("replaces current content when a catalog version is reused", async () => {
    configureSource();
    const original = buildRelease({ version: "2026-07-15.conflict" });
    serveObjects(catalogObjects([original], original));
    const originalResponse = await syncCatalog();

    const conflicting = buildRelease({
      version: original.version,
      label: "Conflicting Content",
    });
    serveObjects(catalogObjects([conflicting], conflicting));
    const replacementResponse = await syncCatalog();
    expect(replacementResponse.body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: original.version },
    });
    expect(replacementResponse.body.active?.catalogDigest).not.toBe(
      originalResponse.body.active?.catalogDigest,
    );
  });

  it("does not return or log raw source failures", async () => {
    const bucket = configureSource();
    const privateError =
      `credential=${PRIVATE_VALUE} bucket=${bucket} key=${ACTIVE_KEY} ` +
      "url=https://signed.example.test/private";
    context.mocks.s3.send.mockRejectedValue(new Error(privateError));
    const response = await syncCatalog();
    const logged = JSON.stringify(context.mocks.axiomLogging.warn.mock.calls);

    expectRejectedBeforeAcceptance(response.body, "source-unavailable");
    for (const privateText of [
      PRIVATE_VALUE,
      bucket,
      ACTIVE_KEY,
      "signed.example.test",
    ]) {
      expect(JSON.stringify(response.body)).not.toContain(privateText);
      expect(logged).not.toContain(privateText);
    }
  });
});
