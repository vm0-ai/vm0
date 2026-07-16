import { createHash, randomUUID } from "node:crypto";

import { cronConnectorCatalogContract } from "@vm0/api-contracts/contracts/cron";
import { zeroConnectorsSearchContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroWorkflowAutomationsContract,
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  deleteOrgPlanEntitlementFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settle } from "../../utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockDatadogConnectorOAuth,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";

const context = testContext();
const zeroMocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const miscApi = createMiscRoutesApi(context);
const CRON_SECRET = "connector-catalog-cron-secret";
const ACTIVE_KEY = "connectors/v1/active.json";
const FIRST_SYNC_TIME = "2026-07-15T08:00:00.000Z";
const PRIVATE_VALUE = "SECRET_TOKEN";
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

type JsonRecord = Record<string, unknown>;
type JsonMutation = (value: JsonRecord) => void;

interface ReleaseFixtureOptions {
  readonly version: string;
  readonly connectorRef?: string;
  readonly label?: string;
  readonly generatedFirewall?: boolean;
  readonly publicBytes?: Buffer;
  readonly mutatePublic?: JsonMutation;
  readonly mutatePrivate?: JsonMutation;
  readonly mutatePrivateFirewalls?: JsonMutation;
  readonly mutateRunnerFirewalls?: JsonMutation;
  readonly mutateIntegrity?: JsonMutation;
  readonly mutatePointer?: JsonMutation;
}

interface ReleaseFixture {
  readonly version: string;
  readonly connectorRef: string;
  readonly pointer: Buffer;
  readonly integrityKey: string;
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
  readonly integrity: string;
  readonly publicCatalog: string;
  readonly privateCatalog: string;
  readonly privateFirewalls: string;
  readonly runnerFirewalls: string;
} {
  const prefix = `connectors/v1/releases/${version}`;
  return {
    integrity: `${prefix}/integrity/catalog.json`,
    publicCatalog: `${prefix}/public/catalog.json`,
    privateCatalog: `${prefix}/private/catalog.json`,
    privateFirewalls: `${prefix}/private/firewalls.json`,
    runnerFirewalls: `${prefix}/runner/firewalls.json`,
  };
}

function buildPublicConnector(args: {
  readonly connectorRef: string;
  readonly label: string;
  readonly iconKey: string;
  readonly iconDigest: string;
  readonly firewall?: JsonRecord;
}): JsonRecord {
  return {
    connectorRef: args.connectorRef,
    label: args.label,
    description: "An external connector used only by the sync fixture",
    category: "testing",
    generation: [],
    tags: ["fixture"],
    authMethods: [
      {
        id: "api-token",
        label: "API Token",
        description: null,
        defaultVisible: true,
        featureSwitch: null,
        grantKind: "manual",
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
      },
    ],
    icon: {
      asset: { key: args.iconKey, digest: args.iconDigest },
      contentType: "image/svg+xml",
      invertInDarkMode: false,
    },
    firewall: args.firewall ?? { kind: "none" },
  };
}

function buildPrivateConnector(connectorRef: string): JsonRecord {
  return {
    connectorRef,
    skill: { kind: "none" },
    authMethods: [
      {
        id: "api-token",
        storage: { secrets: [PRIVATE_VALUE], variables: [] },
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
      },
    ],
  };
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
    defaultVisible: true,
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

function devicePrivateAuthMethod(): JsonRecord {
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "public",
      clientId: "external-device-client",
    },
    storage: { secrets: ["DEVICE_ACCESS_TOKEN"], variables: [] },
    grant: {
      kind: "device-auth",
      scopes: [],
      outputs: { accessToken: "$secrets.DEVICE_ACCESS_TOKEN" },
      startOptionMappings: [],
    },
    access: {
      kind: "static",
      envBindings: { SERVICE_TOKEN: "$secrets.DEVICE_ACCESS_TOKEN" },
    },
    revoke: { kind: "none" },
  };
}

function steamPrivateAuthMethod(args?: {
  readonly callbackOrigin?: "web" | "api";
  readonly platformSecret?: string;
}): JsonRecord {
  const platformSecret = args?.platformSecret ?? "STEAM_WEB_API_KEY";
  return {
    id: "openid",
    storage: { secrets: [], variables: ["STEAM_ID"] },
    grant: {
      kind: "openid-auth",
      callbackOrigin: args?.callbackOrigin ?? "api",
      outputs: { steamId: "$vars.STEAM_ID" },
    },
    access: {
      kind: "static",
      platformSecrets: [platformSecret],
      envBindings: {
        STEAM_ID: "$vars.STEAM_ID",
        STEAM_WEB_API_KEY: `$secrets.${platformSecret}`,
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

function datadogPrivateAuthMethod(scopes: readonly string[]): JsonRecord {
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "DATADOG_OAUTH_CLIENT_ID",
      clientSecretEnv: "DATADOG_OAUTH_CLIENT_SECRET",
    },
    storage: {
      secrets: ["DATADOG_ACCESS_TOKEN", "DATADOG_REFRESH_TOKEN"],
      variables: ["DATADOG_DOMAIN"],
    },
    grant: {
      kind: "auth-code",
      scopes: [...scopes],
      callbackOrigin: "web",
      outputs: {
        accessToken: "$secrets.DATADOG_ACCESS_TOKEN",
        refreshToken: "$secrets.DATADOG_REFRESH_TOKEN",
        domain: "$vars.DATADOG_DOMAIN",
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        DATADOG_TOKEN: "$secrets.DATADOG_ACCESS_TOKEN",
        DATADOG_DOMAIN: "$vars.DATADOG_DOMAIN",
      },
      inputs: {
        refreshToken: "$secrets.DATADOG_REFRESH_TOKEN",
        domain: "$vars.DATADOG_DOMAIN",
      },
      outputs: {
        accessToken: "$secrets.DATADOG_ACCESS_TOKEN",
        refreshToken: "$secrets.DATADOG_REFRESH_TOKEN",
      },
      refreshableSecrets: ["DATADOG_ACCESS_TOKEN"],
    },
    revoke: { kind: "none" },
  };
}

function setArtifactAuthMethods(
  artifact: JsonRecord,
  methods: readonly JsonRecord[],
): void {
  firstRecord(artifact.connectors, "connectors").authMethods = methods;
}

function buildBundledSkill(connectorRef: string): JsonRecord {
  const versionId = "a".repeat(64);
  const storageName = `connector-skill@${connectorRef}`;
  const prefix = `__system__/volume/${storageName}/${versionId}`;
  return {
    kind: "bundled",
    storageName,
    versionId,
    frontmatter: {
      name: `${connectorRef} skill`,
      description: `Use the ${connectorRef} connector`,
    },
    manifest: {
      key: `${prefix}/manifest.json`,
      digest: ZERO_DIGEST,
    },
    archive: {
      key: `${prefix}/archive.tar.gz`,
      digest: ZERO_DIGEST,
    },
  };
}

function setPrivateFirewallBase(artifact: JsonRecord, base: string): void {
  const connector = firstRecord(artifact.connectors, "connectors");
  const firewall = recordValue(connector.firewall, "firewall");
  firstRecord(firewall.apis, "firewall.apis").base = base;
  const routing = recordValue(connector.routing, "routing");
  firstRecord(routing.apis, "routing.apis").base = base;
}

function setRunnerFirewallBase(artifact: JsonRecord, base: string): void {
  const firewall = firstRecord(artifact.firewalls, "firewalls");
  firstRecord(firewall.apis, "firewall.apis").base = base;
}

function buildGeneratedFirewall(args: {
  readonly connectorRef: string;
  readonly label: string;
}): {
  readonly publicFirewall: JsonRecord;
  readonly privateFirewall: JsonRecord;
  readonly runnerFirewall: JsonRecord;
} {
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
    publicFirewall: {
      kind: "generated",
      permissions: [{ name: "items.read", description: "Read items" }],
      categories: {
        byPermission: { "items.read": "Items" },
        displayOrder: ["Items"],
      },
      defaultAllowed: ["items.read"],
      defaultUnknownPolicy: "deny",
    },
    privateFirewall: {
      connectorRef: args.connectorRef,
      label: args.label,
      billable: false,
      firewall: {
        name: args.connectorRef,
        placeholders: { SERVICE_TOKEN: "placeholder-token" },
        apis: [{ base, auth: auth(), permissions }],
      },
      categories: {
        byPermission: { "items.read": "Items" },
        displayOrder: ["Items"],
      },
      defaultAllowed: ["items.read"],
      defaultUnknownPolicy: "deny",
      routing: {
        fixedHosts: ["api.example.test"],
        baseUrlVarNames: [],
        baseUrlTemplates: [],
        apis: [
          {
            base,
            environmentNames: ["SERVICE_TOKEN"],
            routes: [{ permissionName: "items.read", rule: "GET /items" }],
          },
        ],
      },
      diagnostics: { apiCount: 1, permissionCount: 1, ruleCount: 1 },
    },
    runnerFirewall: {
      name: args.connectorRef,
      apis: [
        {
          base,
          auth: auth(),
          permissions: [{ name: "items.read", rules: ["GET /items"] }],
        },
      ],
    },
  };
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
  const generatedFirewall = options.generatedFirewall
    ? buildGeneratedFirewall({ connectorRef, label })
    : undefined;
  const publicConnector = buildPublicConnector({
    connectorRef,
    label,
    iconKey,
    iconDigest,
    ...(generatedFirewall === undefined
      ? {}
      : { firewall: generatedFirewall.publicFirewall }),
  });
  const privateConnector = buildPrivateConnector(connectorRef);
  const publicArtifact: JsonRecord = {
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
    connectors: [publicConnector],
  };
  const privateArtifact: JsonRecord = {
    artifactSchemaVersion: 1,
    catalogVersion: options.version,
    connectors: [privateConnector],
  };
  const privateFirewallsArtifact: JsonRecord = {
    artifactSchemaVersion: 1,
    catalogVersion: options.version,
    connectors:
      generatedFirewall === undefined
        ? []
        : [generatedFirewall.privateFirewall],
  };
  const runnerFirewallsArtifact: JsonRecord = {
    artifactSchemaVersion: 1,
    catalogVersion: options.version,
    firewalls:
      generatedFirewall === undefined ? [] : [generatedFirewall.runnerFirewall],
  };

  options.mutatePublic?.(publicArtifact);
  options.mutatePrivate?.(privateArtifact);
  options.mutatePrivateFirewalls?.(privateFirewallsArtifact);
  options.mutateRunnerFirewalls?.(runnerFirewallsArtifact);
  const publicBytes = options.publicBytes ?? jsonBytes(publicArtifact);
  const privateBytes = jsonBytes(privateArtifact);
  const privateFirewallsBytes = jsonBytes(privateFirewallsArtifact);
  const runnerFirewallsBytes = jsonBytes(runnerFirewallsArtifact);
  const integrity: JsonRecord = {
    artifactSchemaVersion: 1,
    catalogVersion: options.version,
    artifacts: {
      publicCatalog: digest(publicBytes),
      privateCatalog: digest(privateBytes),
      privateFirewalls: digest(privateFirewallsBytes),
      runnerFirewalls: digest(runnerFirewallsBytes),
    },
  };
  options.mutateIntegrity?.(integrity);
  const integrityBytes = jsonBytes(integrity);
  const pointer: JsonRecord = {
    catalogVersion: options.version,
    integrityDigest: digest(integrityBytes),
  };
  options.mutatePointer?.(pointer);

  return {
    version: options.version,
    connectorRef,
    pointer: jsonBytes(pointer),
    integrityKey: keys.integrity,
    objects: new Map([
      [keys.integrity, integrityBytes],
      [keys.publicCatalog, publicBytes],
      [keys.privateCatalog, privateBytes],
      [keys.privateFirewalls, privateFirewallsBytes],
      [keys.runnerFirewalls, runnerFirewallsBytes],
    ]),
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

function cronHeaders(secret = CRON_SECRET): { readonly authorization: string } {
  return { authorization: `Bearer ${secret}` };
}

function cronClient() {
  return setupApp({ context })(cronConnectorCatalogContract);
}

async function syncCatalog() {
  return await accept(cronClient().sync({ headers: cronHeaders() }), [200]);
}

async function readStatus() {
  return await accept(cronClient().status({ headers: cronHeaders() }), [200]);
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
  clearMockNow();
});

describe("connector catalog cron authentication and initial state", () => {
  it("rejects missing and invalid cron credentials for both operations", async () => {
    for (const operation of [cronClient().sync, cronClient().status]) {
      const response = await accept(
        operation({ headers: cronHeaders("wrong-secret") }),
        [401],
      );
      expect(response.body).toStrictEqual({
        error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
      });
    }
    for (const path of [
      "/api/cron/sync-connector-catalog",
      "/api/cron/connector-catalog-status",
    ]) {
      const response = await rawCronRequest(path);
      expect(response.status).toBe(401);
    }
  });

  it("reports never-synced without reading the shared storage bucket", async () => {
    configureSource();
    expect((await readStatus()).body).toStrictEqual({
      state: "never-synced",
      active: null,
      lastAttempt: null,
      lastSuccessAt: null,
      filtering: {
        capabilityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        evaluatedAt: null,
        stale: true,
        filteredAuthMethods: [],
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});

describe("connector catalog valid lifecycle", () => {
  it("accepts, advances, rolls back, and leaves the public catalog static", async () => {
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
    ).toBeFalsy();
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(
      callsBeforePublicCatalog,
    );
  });

  it("serves every public catalog surface from accepted database state", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-public-reader",
      generatedFirewall: true,
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    mockEnv("CONNECTOR_CATALOG_SOURCE_MODE", "external");
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
        url: expect.stringMatching(
          /^https:\/\/static\.vm0\.io\/platform\/views\/zero-page\/components\/settings\/icons\/external-test-[a-f0-9]{12}\.svg$/u,
        ),
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

  it("applies compatibility, default visibility, and request rollout filters", async () => {
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
    hidden.defaultVisible = false;
    const release = buildRelease({
      version: "2026-07-15.external-request-filters",
      mutatePublic: (artifact) => {
        setArtifactAuthMethods(artifact, [gated, visible, hidden]);
      },
      mutatePrivate: (artifact) => {
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

    mockEnv("CONNECTOR_CATALOG_SOURCE_MODE", "external");
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
      mutatePublic: (artifact) => {
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

  it("uses one external release for readiness status and fallback metadata", async () => {
    mockGmailConnectorOAuth({ email: "readiness@example.test" });
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-readiness",
      connectorRef: "gmail",
      label: "Catalog Gmail",
      mutatePublic: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        method.defaultVisible = false;
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    mockEnv("CONNECTOR_CATALOG_SOURCE_MODE", "external");
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
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json({
          historyId: "100",
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      }),
    );

    const actor = bdd.user({ orgId: STAFF_ORG_ID });
    const created: { agentId?: string; workflowId?: string } = {};
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      await connectorsApi.deleteConnectorByType(actor, "gmail", [204, 404]);
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
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "External readiness agent",
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

  it("derives connected scope and refresh status from the accepted release", async () => {
    mockDatadogConnectorOAuth();
    // Connector actions remain on the static execution boundary in this PR,
    // even while public catalog reads use the external backend.
    mockEnv("CONNECTOR_CATALOG_SOURCE_MODE", "external");
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: true,
    });
    onTestFinished(async () => {
      await connectorsApi.deleteConnectorByType(actor, "datadog", [204, 404]);
      await connectorsApi.deleteFeatureSwitches(actor);
    });
    const start = await connectorsApi.startOauth(actor, "datadog", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Datadog authorization state");
    }
    await connectorsApi.completeOauthCallback("datadog", {
      code: "external-catalog-status",
      state,
      domain: "us3.datadoghq.com",
    });

    configureSource();
    const matching = buildRelease({
      version: "2026-07-15.external-connected-status",
      connectorRef: "datadog",
      label: "Datadog",
      mutatePublic: (artifact) => {
        const method = publicAuthMethod({
          id: "oauth",
          grantKind: "auth-code",
        });
        method.featureSwitch = "datadogConnector";
        setArtifactAuthMethods(artifact, [method]);
      },
      mutatePrivate: (artifact) => {
        setArtifactAuthMethods(artifact, [
          datadogPrivateAuthMethod(["dashboards_read", "logs_read_index_data"]),
        ]);
      },
    });
    serveObjects(catalogObjects([matching], matching));
    await syncCatalog();

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
      mutatePublic: (artifact) => {
        const method = publicAuthMethod({
          id: "oauth",
          grantKind: "auth-code",
        });
        method.featureSwitch = "datadogConnector";
        setArtifactAuthMethods(artifact, [method]);
      },
      mutatePrivate: (artifact) => {
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

  it("fails closed in external mode when no accepted state is available", async () => {
    configureSource();
    mockEnv("CONNECTOR_CATALOG_SOURCE_MODE", "external");
    zeroMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const callsBeforeRead = context.mocks.s3.send.mock.calls.length;

    const catalogResponse = await accept(
      setupApp({ context })(zeroConnectorCatalogContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    const searchResponse = await accept(
      setupApp({ context })(zeroConnectorsSearchContract).search({
        headers: { authorization: "Bearer clerk-session" },
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
    expect(searchResponse.body).toStrictEqual(expectedError);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeRead);
  });

  it("keeps shadow reads static when no external state is available", async () => {
    configureSource();
    mockEnv("CONNECTOR_CATALOG_SOURCE_MODE", "shadow");
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    zeroMocks.clerk.session(userId, orgId);
    const response = await accept(
      setupApp({ context })(zeroConnectorCatalogContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.connectors.length).toBeGreaterThan(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    await flushWaitUntilForTest();
    const [message, data] =
      context.mocks.axiomLogging.warn.mock.calls.at(-1) ?? [];
    expect(message).toBe("Connector catalog shadow comparison unavailable");
    expect(data).toMatchObject({
      type: "connector_catalog_shadow_comparison",
      operation: "list",
      outcome: "unavailable",
      context: "connector-catalog:shadow",
    });
    expect(JSON.stringify([message, data])).not.toContain(userId);
    expect(JSON.stringify([message, data])).not.toContain(orgId);
  });

  it("reports only sanitized global diagnostics for shadow differences", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.shadow-difference",
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    mockEnv("CONNECTOR_CATALOG_SOURCE_MODE", "shadow");
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    zeroMocks.clerk.session(userId, orgId);
    const callsBeforePublicRead = context.mocks.s3.send.mock.calls.length;
    const response = await accept(
      setupApp({ context })(zeroConnectorCatalogContract).status({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      response.body.connectors.some((connector) => {
        return connector.connectorRef === release.connectorRef;
      }),
    ).toBeFalsy();

    await flushWaitUntilForTest();
    const [message, data] =
      context.mocks.axiomLogging.debug.mock.calls.at(-1) ?? [];
    expect(message).toBe("Connector catalog shadow comparison completed");
    expect(data).toMatchObject({
      type: "connector_catalog_shadow_comparison",
      operation: "status",
      outcome: "difference",
      schemaVersion: 1,
      catalogVersion: release.version,
      rawConnectorCount: 1,
      rawAuthMethodCount: 1,
      compatibilityFilteredMethodCount: 0,
      externalConnectorCount: 1,
      context: "connector-catalog:shadow",
    });
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforePublicRead);
    const logged = JSON.stringify([message, data]);
    expect(logged).not.toContain(userId);
    expect(logged).not.toContain(orgId);
    expect(logged).not.toContain(PRIVATE_VALUE);
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

  it("accepts canonical firewall bases with authority parameters", async () => {
    configureSource();
    const base = "https://{awsHost+}.amazonaws.com";
    const release = buildRelease({
      version: "2026-07-15.parameterized-firewall",
      generatedFirewall: true,
      mutatePrivateFirewalls: (artifact) => {
        setPrivateFirewallBase(artifact, base);
        const connector = firstRecord(artifact.connectors, "connectors");
        const routing = recordValue(connector.routing, "routing");
        routing.fixedHosts = ["{awshost+}.amazonaws.com"];
      },
      mutateRunnerFirewalls: (artifact) => {
        setRunnerFirewallBase(artifact, base);
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
    const release = buildRelease({
      version: "2026-07-15.bundled-skill",
      mutatePrivate: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        connector.skill = buildBundledSkill("external-test");
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts source identities and platform requirements without local support", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.future-capability",
      mutatePublic: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        firstRecord(connector.authMethods, "authMethods").id =
          "service-account";
      },
      mutatePrivate: (artifact) => {
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
    const losingPublicKey = releaseKeys(losing.version).publicCatalog;
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
      if (key === observed.integrityKey) {
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
  it("filters auth methods that reference an unknown feature switch", async () => {
    configureSource();
    const unknownSwitch = buildRelease({
      version: "2026-07-15.unknown-feature-switch",
      mutatePublic: (artifact) => {
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
      filteredAuthMethods: [
        {
          connectorRef: unknownSwitch.connectorRef,
          authMethodId: "api-token",
          reasons: ["unsupported-feature-switch"],
        },
      ],
    });

    const knownSwitch = buildRelease({
      version: "2026-07-15.known-feature-switch",
      mutatePublic: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        method.featureSwitch = "awsConnector";
      },
    });
    serveObjects(catalogObjects([unknownSwitch, knownSwitch], knownSwitch));

    expect(
      (await syncCatalog()).body.filtering.filteredAuthMethods,
    ).toStrictEqual([]);
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
      mutatePublic: (artifact) => {
        setArtifactAuthMethods(artifact, publicMethods);
      },
      mutatePrivate: (artifact) => {
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

    const allFiltered = buildRelease({
      version: "2026-07-15.all-filtered",
      connectorRef: "future-auth",
      mutatePublic: (artifact) => {
        setArtifactAuthMethods(artifact, publicMethods.slice(0, 3));
      },
      mutatePrivate: (artifact) => {
        setArtifactAuthMethods(artifact, privateMethods.slice(0, 3));
      },
    });
    serveObjects(catalogObjects([partial, allFiltered], allFiltered));
    expect(
      (await syncCatalog()).body.filtering.filteredAuthMethods,
    ).toHaveLength(3);
  });

  it("rejects unapproved configuration identities without reading them", async () => {
    configureSource();
    const unapprovedName = "FUTURE_PLATFORM_KEY";
    const release = buildRelease({
      version: "2026-07-15.unapproved-configuration",
      mutatePrivate: (artifact) => {
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
      mutatePublic: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutatePrivate: (artifact) => {
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
      mutatePublic: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutatePrivate: (artifact) => {
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

    mockEnv("CONNECTOR_CATALOG_SOURCE_MODE", "external");
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
      mutatePublic: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutatePrivate: (artifact) => {
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
      mutatePublic: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutatePrivate: (artifact) => {
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
              digest: pointer.integrityDigest,
            };
            delete pointer.integrityDigest;
          },
        });
      },
    },
    {
      name: "integrity digest mismatch",
      expected: "digest-mismatch",
      release: () => {
        return buildRelease({
          version: "bad-integrity-digest",
          mutatePointer: (pointer) => {
            pointer.integrityDigest = ZERO_DIGEST;
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
          mutateIntegrity: (integrity) => {
            integrity.artifactSchemaVersion = 2;
          },
        });
      },
    },
    {
      name: "legacy integrity property",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "legacy-integrity-property",
          mutateIntegrity: (integrity) => {
            integrity.catalogSource = {
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
          mutatePublic: (artifact) => {
            artifact.extra = true;
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
          publicBytes: Buffer.from([0xc3, 0x28]),
        });
      },
    },
    {
      name: "view digest mismatch",
      expected: "digest-mismatch",
      release: () => {
        return buildRelease({
          version: "bad-view-digest",
          mutateIntegrity: (integrity) => {
            const artifacts = recordValue(integrity.artifacts, "artifacts");
            artifacts.publicCatalog = ZERO_DIGEST;
          },
        });
      },
    },
    {
      name: "header mismatch",
      expected: "invalid-reference",
      release: () => {
        return buildRelease({
          version: "header-mismatch",
          mutatePublic: (artifact) => {
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
          mutatePublic: (artifact) => {
            firstRecord(artifact.connectors, "connectors").description =
              PRIVATE_VALUE;
          },
        });
      },
    },
    {
      name: "cross-view auth mismatch",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "relationship-mismatch",
          mutatePublic: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            firstRecord(connector.authMethods, "authMethods").id = "oauth";
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
          mutatePublic: (artifact) => {
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
          mutatePublic: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const icon = recordValue(connector.icon, "icon");
            recordValue(icon.asset, "icon asset").digest = ZERO_DIGEST;
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
          mutatePrivate: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            connector.skill = buildBundledSkill("wrong");
          },
        });
      },
    },
    {
      name: "cross-view firewall mismatch",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-mismatch",
          mutatePublic: (artifact) => {
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
          mutatePrivateFirewalls: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            firstRecord(firewall.apis, "firewall.apis").base =
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
          mutatePrivateFirewalls: (artifact) => {
            setPrivateFirewallBase(artifact, base);
          },
          mutateRunnerFirewalls: (artifact) => {
            setRunnerFirewallBase(artifact, base);
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
          mutatePrivateFirewalls: (artifact) => {
            setPrivateFirewallBase(artifact, base);
          },
          mutateRunnerFirewalls: (artifact) => {
            setRunnerFirewallBase(artifact, base);
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
          mutatePrivateFirewalls: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            firstRecord(firewall.apis, "firewall.apis").hostPolicy = hostPolicy;
          },
          mutateRunnerFirewalls: (artifact) => {
            const firewall = firstRecord(artifact.firewalls, "firewalls");
            firstRecord(firewall.apis, "firewall.apis").hostPolicy = hostPolicy;
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
          mutatePrivateFirewalls: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const api = firstRecord(firewall.apis, "firewall.apis");
            recordValue(api.auth, "firewall auth").base = authBase;
          },
          mutateRunnerFirewalls: (artifact) => {
            const firewall = firstRecord(artifact.firewalls, "firewalls");
            const api = firstRecord(firewall.apis, "firewall.apis");
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
          mutatePrivateFirewalls: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const api = firstRecord(firewall.apis, "firewall.apis");
            const auth = recordValue(api.auth, "firewall api auth");
            recordValue(auth.headers, "firewall auth headers")["X-Unknown"] =
              catalogTemplate("secrets.UNKNOWN_SECRET");
          },
        });
      },
    },
    {
      name: "stale firewall routing metadata",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-routing-mismatch",
          generatedFirewall: true,
          mutatePrivateFirewalls: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            recordValue(connector.routing, "routing").fixedHosts = [
              "stale.example.test",
            ];
          },
        });
      },
    },
    {
      name: "stale firewall diagnostics",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-diagnostics-mismatch",
          generatedFirewall: true,
          mutatePrivateFirewalls: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            recordValue(connector.diagnostics, "diagnostics").ruleCount = 2;
          },
        });
      },
    },
    {
      name: "cross-view firewall label mismatch",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-label-mismatch",
          generatedFirewall: true,
          mutatePrivateFirewalls: (artifact) => {
            firstRecord(artifact.connectors, "connectors").label =
              "Stale Label";
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
    const acceptedDigest = acceptedResponse.body.active?.integrityDigest;

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
        integrityDigest: acceptedDigest,
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
  });

  it("skips large artifacts for a deterministically rejected candidate", async () => {
    configureSource();
    const accepted = buildRelease({ version: "2026-07-15.cache-valid" });
    serveObjects(catalogObjects([accepted], accepted));
    await syncCatalog();

    const invalid = buildRelease({
      version: "2026-07-15.cache-invalid",
      mutatePublic: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([accepted, invalid], invalid));
    const callsBeforeFirstRejection = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      lastAttempt: { failureCode: "invalid-artifact" },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeFirstRejection,
    ).toBe(6);

    const callsBeforeCachedRejection = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      lastAttempt: { failureCode: "invalid-artifact" },
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
  });

  it("re-evaluates a rejected identity when the pointer ETag changes", async () => {
    configureSource();
    const invalid = buildRelease({
      version: "2026-07-15.changed-rejection-etag",
      mutatePublic: (artifact) => {
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
    ).toBe(6);
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

  it("caches a malformed active pointer by its observed ETag", async () => {
    configureSource();
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
  });

  it("retries transient candidate download failures", async () => {
    configureSource();
    const candidate = buildRelease({
      version: "2026-07-15.transient-candidate",
    });
    const unavailableObjects = new Map(catalogObjects([candidate], candidate));
    unavailableObjects.delete(releaseKeys(candidate.version).publicCatalog);
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
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeRetry).toBe(6);
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
    expect(replacementResponse.body.active?.integrityDigest).not.toBe(
      originalResponse.body.active?.integrityDigest,
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
