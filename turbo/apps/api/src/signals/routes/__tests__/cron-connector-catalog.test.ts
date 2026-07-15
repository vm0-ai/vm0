import { createHash, randomUUID } from "node:crypto";

import { cronConnectorCatalogContract } from "@vm0/api-contracts/contracts/cron";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createDeferredPromise, settle } from "../../utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const zeroMocks = createZeroRouteMocks(context);
const CRON_SECRET = "connector-catalog-cron-secret";
const ACTIVE_KEY = "catalog-v1/active.json";
const FIRST_SYNC_TIME = "2026-07-15T08:00:00.000Z";
const PRIVATE_VALUE = "SECRET_TOKEN";
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

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

function valueDigest(value: unknown): string {
  return digest(jsonBytes(value));
}

function catalogTemplate(reference: string): string {
  return `\${{ ${reference} }}`;
}

function artifactReference(key: string, content: string): JsonRecord {
  return { key, digest: digest(Buffer.from(content)) };
}

function releaseKeys(version: string): {
  readonly integrity: string;
  readonly publicCatalog: string;
  readonly privateCatalog: string;
  readonly privateFirewalls: string;
  readonly runnerFirewalls: string;
} {
  const prefix = `catalog-v1/releases/${version}`;
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

function requiredCapabilities(generatedFirewall: boolean): readonly string[] {
  const capabilities = [
    "bundle.required-resources@1",
    "catalog.public@1",
    "catalog.private@1",
    "firewall.private@1",
    "firewall.runner@1",
    "icon.static-files-path@1",
    "skill-none@1",
    generatedFirewall ? "firewall-generated@1" : "firewall-none@1",
  ];
  if (generatedFirewall) {
    capabilities.push("firewall.categories@1", "firewall.defaults@1");
  }
  capabilities.push("grant.manual@1", "access.static@1");
  return capabilities;
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
  const currentPublicConnector = firstRecord(
    publicArtifact.connectors,
    "public connectors",
  );
  const currentPrivateConnector = firstRecord(
    privateArtifact.connectors,
    "private connectors",
  );
  const privateFirewallConnectors = arrayValue(
    privateFirewallsArtifact.connectors,
    "private firewall connectors",
  );
  const runnerFirewalls = arrayValue(
    runnerFirewallsArtifact.firewalls,
    "runner firewalls",
  );
  const integrityConnector: JsonRecord = {
    connectorRef,
    sourceFiles: [
      artifactReference(
        `catalog/connectors/${connectorRef}/connector.yaml`,
        "a",
      ),
      artifactReference(`catalog/connectors/${connectorRef}/setup.yaml`, "b"),
      artifactReference(`catalog/connectors/${connectorRef}/icon.svg`, "c"),
      artifactReference(
        `catalog/connectors/${connectorRef}/firewall.yaml`,
        "d",
      ),
      artifactReference(
        `catalog/connectors/${connectorRef}/metadata.yaml`,
        "e",
      ),
    ],
    publicDigest: valueDigest(currentPublicConnector),
    privateDigest: valueDigest(currentPrivateConnector),
    privateFirewallDigest:
      privateFirewallConnectors.length === 0
        ? null
        : valueDigest(
            firstRecord(privateFirewallConnectors, "private firewalls"),
          ),
    runnerFirewallDigest:
      runnerFirewalls.length === 0
        ? null
        : valueDigest(firstRecord(runnerFirewalls, "runner firewalls")),
    skill: { kind: "none" },
    icon: { key: iconKey, digest: iconDigest },
  };
  const publicBytes = options.publicBytes ?? jsonBytes(publicArtifact);
  const privateBytes = jsonBytes(privateArtifact);
  const privateFirewallsBytes = jsonBytes(privateFirewallsArtifact);
  const runnerFirewallsBytes = jsonBytes(runnerFirewallsArtifact);
  const staticFilesPublicationArtifact: JsonRecord = {
    artifactSchemaVersion: 1,
    files: [
      {
        key: iconKey,
        digest: iconDigest,
        contentType: "image/svg+xml",
        size: iconBytes.length,
      },
    ],
  };
  const integrity: JsonRecord = {
    artifactSchemaVersion: 1,
    catalogVersion: options.version,
    requiredCapabilities: requiredCapabilities(
      options.generatedFirewall === true,
    ),
    catalogSource: artifactReference("catalog/catalog.yaml", "catalog"),
    generatorSources: [
      artifactReference("compiler/firewall-generator.ts", "generator"),
    ],
    artifacts: {
      publicCatalog: { key: keys.publicCatalog, digest: digest(publicBytes) },
      privateCatalog: {
        key: keys.privateCatalog,
        digest: digest(privateBytes),
      },
      privateFirewalls: {
        key: keys.privateFirewalls,
        digest: digest(privateFirewallsBytes),
      },
      runnerFirewalls: {
        key: keys.runnerFirewalls,
        digest: digest(runnerFirewallsBytes),
      },
      staticFilesPublication: {
        key: "icons/static-files.json",
        digest: valueDigest(staticFilesPublicationArtifact),
      },
    },
    assets: [
      {
        key: iconKey,
        digest: iconDigest,
        contentType: "image/svg+xml",
        size: iconBytes.length,
      },
    ],
    skillArtifacts: [],
    connectors: [integrityConnector],
  };
  options.mutateIntegrity?.(integrity);
  const integrityBytes = jsonBytes(integrity);
  const pointer: JsonRecord = {
    catalogVersion: options.version,
    integrity: { key: keys.integrity, digest: digest(integrityBytes) },
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
    return Promise.resolve({
      ContentLength: bytes.length,
      Body: s3Body(bytes),
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
    });
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeUnchanged).toBe(
      1,
    );

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

  it("rolls back a release identity when its state compare-and-swap loses", async () => {
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
    const activePointers = [
      losing.pointer,
      winning.pointer,
      winning.pointer,
      losing.pointer,
      winning.pointer,
    ];
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

  it("restarts when active changes during validation", async () => {
    configureSource();
    const superseded = buildRelease({ version: "2026-07-15.old" });
    const current = buildRelease({ version: "2026-07-15.current" });
    const objects = catalogObjects([superseded, current], current);
    let activeReads = 0;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const key = commandInput(command).Key;
      const bytes =
        key === ACTIVE_KEY
          ? ++activeReads === 1
            ? superseded.pointer
            : current.pointer
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
      active: { catalogVersion: current.version },
    });
    expect(activeReads).toBe(4);
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
      name: "wrong pointer reference",
      expected: "invalid-reference",
      release: () => {
        return buildRelease({
          version: "wrong-pointer-reference",
          mutatePointer: (pointer) => {
            recordValue(pointer.integrity, "pointer.integrity").key =
              "catalog-v1/releases/other/integrity/catalog.json";
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
            recordValue(pointer.integrity, "pointer.integrity").digest =
              ZERO_DIGEST;
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
      name: "unsupported capability",
      expected: "unsupported-capability",
      release: () => {
        return buildRelease({
          version: "unsupported-capability",
          mutateIntegrity: (integrity) => {
            arrayValue(
              integrity.requiredCapabilities,
              "requiredCapabilities",
            ).push("catalog.future@2");
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
            recordValue(artifacts.publicCatalog, "publicCatalog").digest =
              ZERO_DIGEST;
          },
        });
      },
    },
    {
      name: "static publication digest mismatch",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "bad-static-publication-digest",
          mutateIntegrity: (integrity) => {
            const artifacts = recordValue(integrity.artifacts, "artifacts");
            recordValue(
              artifacts.staticFilesPublication,
              "staticFilesPublication",
            ).digest = ZERO_DIGEST;
          },
        });
      },
    },
    {
      name: "unreferenced icon asset",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "unreferenced-icon",
          mutateIntegrity: (integrity) => {
            const extraBytes = Buffer.from("<svg>extra</svg>");
            const extraDigest = digest(extraBytes);
            const extraKey =
              "platform/views/zero-page/components/settings/icons/" +
              `zz-extra-${extraDigest.slice("sha256:".length, 19)}.svg`;
            const assets = arrayValue(integrity.assets, "assets");
            assets.push({
              key: extraKey,
              digest: extraDigest,
              contentType: "image/svg+xml",
              size: extraBytes.length,
            });
            const artifacts = recordValue(integrity.artifacts, "artifacts");
            recordValue(
              artifacts.staticFilesPublication,
              "staticFilesPublication",
            ).digest = valueDigest({ artifactSchemaVersion: 1, files: assets });
          },
        });
      },
    },
    {
      name: "local staging key",
      expected: "invalid-reference",
      release: () => {
        return buildRelease({
          version: "staging-key",
          mutateIntegrity: (integrity) => {
            const artifacts = recordValue(integrity.artifacts, "artifacts");
            recordValue(artifacts.publicCatalog, "publicCatalog").key =
              "connectors/catalog-v1/releases/staging-key/public/catalog.json";
          },
        });
      },
    },
    {
      name: "cross-release key",
      expected: "invalid-reference",
      release: () => {
        return buildRelease({
          version: "cross-release",
          mutateIntegrity: (integrity) => {
            const artifacts = recordValue(integrity.artifacts, "artifacts");
            recordValue(artifacts.publicCatalog, "publicCatalog").key =
              "catalog-v1/releases/other/public/catalog.json";
          },
        });
      },
    },
    {
      name: "unversioned key",
      expected: "invalid-reference",
      release: () => {
        return buildRelease({
          version: "unversioned-key",
          mutateIntegrity: (integrity) => {
            const artifacts = recordValue(integrity.artifacts, "artifacts");
            recordValue(artifacts.publicCatalog, "publicCatalog").key =
              "catalog-v1/public/catalog.json";
          },
        });
      },
    },
    {
      name: "wrong schema generation key",
      expected: "invalid-reference",
      release: () => {
        return buildRelease({
          version: "wrong-schema-key",
          mutateIntegrity: (integrity) => {
            const artifacts = recordValue(integrity.artifacts, "artifacts");
            recordValue(artifacts.publicCatalog, "publicCatalog").key =
              "catalog-v2/releases/wrong-schema-key/public/catalog.json";
          },
        });
      },
    },
    {
      name: "traversal key",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "traversal-key",
          mutateIntegrity: (integrity) => {
            const artifacts = recordValue(integrity.artifacts, "artifacts");
            recordValue(artifacts.publicCatalog, "publicCatalog").key =
              "catalog-v1/releases/traversal-key/../public/catalog.json";
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
      name: "cross-view icon mismatch",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "icon-mismatch",
          mutateIntegrity: (integrity) => {
            const connector = firstRecord(integrity.connectors, "connectors");
            recordValue(connector.icon, "icon").digest = ZERO_DIGEST;
          },
        });
      },
    },
    {
      name: "cross-view skill mismatch",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "skill-mismatch",
          mutateIntegrity: (integrity) => {
            const connector = firstRecord(integrity.connectors, "connectors");
            const versionId = "a".repeat(64);
            const prefix = `__system__/volume/connector-skill@external-test/${versionId}`;
            connector.skill = {
              kind: "bundled",
              storageName: "connector-skill@external-test",
              versionId,
              manifest: {
                key: `${prefix}/manifest.json`,
                digest: ZERO_DIGEST,
              },
              archive: {
                key: `${prefix}/archive.tar.gz`,
                digest: ZERO_DIGEST,
              },
            };
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

  it("rejects immutable catalog version reuse after acceptance", async () => {
    configureSource();
    const original = buildRelease({ version: "2026-07-15.conflict" });
    serveObjects(catalogObjects([original], original));
    await syncCatalog();

    const conflicting = buildRelease({
      version: original.version,
      label: "Conflicting Content",
    });
    serveObjects(catalogObjects([conflicting], conflicting));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      active: { catalogVersion: original.version },
      lastAttempt: {
        outcome: "rejected",
        failureCode: "conflicting-release",
      },
    });
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
