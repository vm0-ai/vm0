import { createHash } from "node:crypto";

import type { ConnectorCatalogSyncFailureCode } from "@vm0/api-contracts/contracts/cron";
import { z } from "zod";

import { safeJsonParse, safeSync } from "../../utils";
import {
  artifactReferenceSchema,
  connectorCatalogIntegrityArtifactSchema,
  connectorCatalogPrivateArtifactSchema,
  connectorCatalogPrivateFirewallsArtifactSchema,
  connectorCatalogPublicArtifactSchema,
  connectorCatalogReleaseArtifactKeys,
  connectorCatalogRunnerFirewallsArtifactSchema,
  connectorCatalogVersionSchema,
  SUPPORTED_CONNECTOR_CATALOG_CAPABILITIES,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogCapability,
  type ConnectorCatalogIntegrityArtifact,
  type ConnectorCatalogPrivateArtifact,
  type ConnectorCatalogPrivateFirewallsArtifact,
  type ConnectorCatalogPublicArtifact,
  type ConnectorCatalogRunnerFirewallsArtifact,
} from "./artifacts";
import {
  assertPublicCatalogArtifactHasNoPrivateFields,
  privateCatalogArtifactSensitiveValues,
} from "./public-leak";
import { validateConnectorCatalogRelationships } from "./relationships";

const CONNECTOR_CATALOG_ACTIVE_KEY = "catalog-v1/active.json";

const CONNECTOR_CATALOG_OBJECT_MAX_BYTES = {
  active: 16 * 1024,
  integrity: 4 * 1024 * 1024,
  publicCatalog: 8 * 1024 * 1024,
  privateCatalog: 8 * 1024 * 1024,
  privateFirewalls: 32 * 1024 * 1024,
  runnerFirewalls: 16 * 1024 * 1024,
} as const;

const connectorCatalogActivePointerSchema = z
  .object({
    catalogVersion: connectorCatalogVersionSchema,
    integrity: artifactReferenceSchema,
  })
  .strict();

export type ConnectorCatalogActivePointer = z.infer<
  typeof connectorCatalogActivePointerSchema
>;

interface ConnectorCatalogArtifactReference {
  readonly key: string;
  readonly digest: string;
}

export interface ConnectorCatalogReleaseIdentity {
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly integrity: ConnectorCatalogArtifactReference;
  readonly publicCatalog: ConnectorCatalogArtifactReference;
  readonly privateCatalog: ConnectorCatalogArtifactReference;
  readonly privateFirewalls: ConnectorCatalogArtifactReference;
  readonly runnerFirewalls: ConnectorCatalogArtifactReference;
  readonly requiredCapabilities: readonly ConnectorCatalogCapability[];
}

export interface ValidatedConnectorCatalogCandidate {
  readonly identity: ConnectorCatalogReleaseIdentity;
  readonly publicCatalogText: string;
}

export interface ConnectorCatalogArtifactReader {
  readArtifact(key: string, maxBytes: number): Promise<Uint8Array>;
}

class ConnectorCatalogArtifactError extends Error {
  constructor(readonly code: ConnectorCatalogSyncFailureCode) {
    super(code);
    this.name = "ConnectorCatalogArtifactError";
  }
}

export function connectorCatalogArtifactFailureCode(
  value: unknown,
): ConnectorCatalogSyncFailureCode | undefined {
  return value instanceof ConnectorCatalogArtifactError
    ? value.code
    : undefined;
}

function fail(code: ConnectorCatalogSyncFailureCode): never {
  throw new ConnectorCatalogArtifactError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertDigest(bytes: Uint8Array, expectedDigest: string): void {
  if (digest(bytes) !== expectedDigest) {
    fail("digest-mismatch");
  }
}

async function readBoundedArtifact(
  reader: ConnectorCatalogArtifactReader,
  key: string,
  maxBytes: number,
): Promise<Buffer> {
  const bytes = Buffer.from(await reader.readArtifact(key, maxBytes));
  if (bytes.length > maxBytes) {
    fail("object-too-large");
  }
  return bytes;
}

function decodedJson(bytes: Uint8Array): {
  readonly text: string;
  readonly value: unknown;
} {
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  });
  if (!("ok" in decoded)) {
    fail("invalid-json");
  }
  const value = safeJsonParse(decoded.ok);
  if (value === undefined) {
    fail("invalid-json");
  }
  return { text: decoded.ok, value };
}

function parseStrict<T>(
  value: unknown,
  schema: z.ZodType<T>,
  code: ConnectorCatalogSyncFailureCode,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    fail(code);
  }
  return parsed.data;
}

function assertSupportedArtifactSchema(value: unknown): void {
  if (
    isRecord(value) &&
    typeof value.artifactSchemaVersion === "number" &&
    value.artifactSchemaVersion !== SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION
  ) {
    fail("unsupported-schema");
  }
}

function assertSupportedCapabilities(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.requiredCapabilities)) {
    return;
  }
  if (
    value.requiredCapabilities.some((capability) => {
      return (
        typeof capability === "string" &&
        !SUPPORTED_CONNECTOR_CATALOG_CAPABILITIES.some((supported) => {
          return supported === capability;
        })
      );
    })
  ) {
    fail("unsupported-capability");
  }
}

function assertPointerIntegrityKey(
  pointer: ConnectorCatalogActivePointer,
): void {
  const expected = connectorCatalogReleaseArtifactKeys(
    pointer.catalogVersion,
  ).integrityCatalog;
  if (pointer.integrity.key !== expected) {
    fail("invalid-reference");
  }
}

function assertIntegrityReferences(args: {
  readonly pointer: ConnectorCatalogActivePointer;
  readonly integrity: ConnectorCatalogIntegrityArtifact;
}): void {
  if (args.integrity.catalogVersion !== args.pointer.catalogVersion) {
    fail("invalid-reference");
  }
  const expected = connectorCatalogReleaseArtifactKeys(
    args.pointer.catalogVersion,
  );
  const references = args.integrity.artifacts;
  if (
    references.publicCatalog.key !== expected.publicCatalog ||
    references.privateCatalog.key !== expected.privateCatalog ||
    references.privateFirewalls.key !== expected.privateFirewalls ||
    references.runnerFirewalls.key !== expected.runnerFirewalls ||
    references.staticFilesPublication.key !== "icons/static-files.json"
  ) {
    fail("invalid-reference");
  }
}

function assertCatalogVersion(
  value: { readonly catalogVersion: string },
  expected: string,
): void {
  if (value.catalogVersion !== expected) {
    fail("invalid-reference");
  }
}

function assertNoReservedModelProviderRefs(args: {
  readonly publicRefs: readonly string[];
  readonly privateRefs: readonly string[];
  readonly privateFirewallRefs: readonly string[];
  readonly runnerFirewallRefs: readonly string[];
  readonly integrityRefs: readonly string[];
}): void {
  const refs = [
    ...args.publicRefs,
    ...args.privateRefs,
    ...args.privateFirewallRefs,
    ...args.runnerFirewallRefs,
    ...args.integrityRefs,
  ];
  if (
    refs.some((ref) => {
      return ref.startsWith("model-provider:");
    })
  ) {
    fail("invalid-artifact");
  }
}

export function connectorCatalogPointersEqual(
  left: ConnectorCatalogActivePointer,
  right: ConnectorCatalogActivePointer,
): boolean {
  return (
    left.catalogVersion === right.catalogVersion &&
    left.integrity.key === right.integrity.key &&
    left.integrity.digest === right.integrity.digest
  );
}

export async function loadConnectorCatalogActivePointer(
  reader: ConnectorCatalogArtifactReader,
): Promise<ConnectorCatalogActivePointer> {
  const bytes = await readBoundedArtifact(
    reader,
    CONNECTOR_CATALOG_ACTIVE_KEY,
    CONNECTOR_CATALOG_OBJECT_MAX_BYTES.active,
  );
  const parsed = decodedJson(bytes);
  const pointer = parseStrict(
    parsed.value,
    connectorCatalogActivePointerSchema,
    "invalid-pointer",
  );
  assertPointerIntegrityKey(pointer);
  return pointer;
}

interface ConnectorCatalogViewBytes {
  readonly publicCatalog: Buffer;
  readonly privateCatalog: Buffer;
  readonly privateFirewalls: Buffer;
  readonly runnerFirewalls: Buffer;
}

interface ParsedConnectorCatalogViews {
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly publicCatalogText: string;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
  readonly privateFirewallsArtifact: ConnectorCatalogPrivateFirewallsArtifact;
  readonly runnerFirewallsArtifact: ConnectorCatalogRunnerFirewallsArtifact;
}

async function loadIntegrityArtifact(args: {
  readonly reader: ConnectorCatalogArtifactReader;
  readonly pointer: ConnectorCatalogActivePointer;
}): Promise<ConnectorCatalogIntegrityArtifact> {
  const bytes = await readBoundedArtifact(
    args.reader,
    args.pointer.integrity.key,
    CONNECTOR_CATALOG_OBJECT_MAX_BYTES.integrity,
  );
  assertDigest(bytes, args.pointer.integrity.digest);
  const json = decodedJson(bytes);
  assertSupportedArtifactSchema(json.value);
  assertSupportedCapabilities(json.value);
  const integrity = parseStrict(
    json.value,
    connectorCatalogIntegrityArtifactSchema,
    "invalid-artifact",
  );
  assertIntegrityReferences({ pointer: args.pointer, integrity });
  return integrity;
}

async function loadCatalogViewBytes(args: {
  readonly reader: ConnectorCatalogArtifactReader;
  readonly integrity: ConnectorCatalogIntegrityArtifact;
}): Promise<ConnectorCatalogViewBytes> {
  const references = args.integrity.artifacts;
  const [publicCatalog, privateCatalog, privateFirewalls, runnerFirewalls] =
    await Promise.all([
      readBoundedArtifact(
        args.reader,
        references.publicCatalog.key,
        CONNECTOR_CATALOG_OBJECT_MAX_BYTES.publicCatalog,
      ),
      readBoundedArtifact(
        args.reader,
        references.privateCatalog.key,
        CONNECTOR_CATALOG_OBJECT_MAX_BYTES.privateCatalog,
      ),
      readBoundedArtifact(
        args.reader,
        references.privateFirewalls.key,
        CONNECTOR_CATALOG_OBJECT_MAX_BYTES.privateFirewalls,
      ),
      readBoundedArtifact(
        args.reader,
        references.runnerFirewalls.key,
        CONNECTOR_CATALOG_OBJECT_MAX_BYTES.runnerFirewalls,
      ),
    ]);
  assertDigest(publicCatalog, references.publicCatalog.digest);
  assertDigest(privateCatalog, references.privateCatalog.digest);
  assertDigest(privateFirewalls, references.privateFirewalls.digest);
  assertDigest(runnerFirewalls, references.runnerFirewalls.digest);
  return { publicCatalog, privateCatalog, privateFirewalls, runnerFirewalls };
}

function parseCatalogViews(
  bytes: ConnectorCatalogViewBytes,
  catalogVersion: string,
): ParsedConnectorCatalogViews {
  const publicJson = decodedJson(bytes.publicCatalog);
  const privateJson = decodedJson(bytes.privateCatalog);
  const privateFirewallsJson = decodedJson(bytes.privateFirewalls);
  const runnerFirewallsJson = decodedJson(bytes.runnerFirewalls);
  for (const value of [
    publicJson.value,
    privateJson.value,
    privateFirewallsJson.value,
    runnerFirewallsJson.value,
  ]) {
    assertSupportedArtifactSchema(value);
  }
  const publicArtifact = parseStrict(
    publicJson.value,
    connectorCatalogPublicArtifactSchema,
    "invalid-artifact",
  );
  const privateArtifact = parseStrict(
    privateJson.value,
    connectorCatalogPrivateArtifactSchema,
    "invalid-artifact",
  );
  const privateFirewallsArtifact = parseStrict(
    privateFirewallsJson.value,
    connectorCatalogPrivateFirewallsArtifactSchema,
    "invalid-artifact",
  );
  const runnerFirewallsArtifact = parseStrict(
    runnerFirewallsJson.value,
    connectorCatalogRunnerFirewallsArtifactSchema,
    "invalid-artifact",
  );
  for (const artifact of [
    publicArtifact,
    privateArtifact,
    privateFirewallsArtifact,
    runnerFirewallsArtifact,
  ]) {
    assertCatalogVersion(artifact, catalogVersion);
  }
  return {
    publicArtifact,
    publicCatalogText: publicJson.text,
    privateArtifact,
    privateFirewallsArtifact,
    runnerFirewallsArtifact,
  };
}

function validateCatalogViews(
  views: ParsedConnectorCatalogViews,
  integrity: ConnectorCatalogIntegrityArtifact,
): void {
  assertNoReservedModelProviderRefs({
    publicRefs: views.publicArtifact.connectors.map((connector) => {
      return connector.connectorRef;
    }),
    privateRefs: views.privateArtifact.connectors.map((connector) => {
      return connector.connectorRef;
    }),
    privateFirewallRefs: views.privateFirewallsArtifact.connectors.map(
      (connector) => {
        return connector.connectorRef;
      },
    ),
    runnerFirewallRefs: views.runnerFirewallsArtifact.firewalls.map(
      (firewall) => {
        return firewall.name;
      },
    ),
    integrityRefs: integrity.connectors.map((connector) => {
      return connector.connectorRef;
    }),
  });
  const publicLeak = safeSync(() => {
    assertPublicCatalogArtifactHasNoPrivateFields(
      views.publicArtifact,
      privateCatalogArtifactSensitiveValues(views.privateArtifact),
    );
  });
  if (!("ok" in publicLeak)) {
    fail("public-leakage");
  }
  const relationships = safeSync(() => {
    validateConnectorCatalogRelationships({
      ...views,
      integrity,
    });
  });
  if (!("ok" in relationships)) {
    fail("relationship-mismatch");
  }
}

function releaseIdentity(
  pointer: ConnectorCatalogActivePointer,
  integrity: ConnectorCatalogIntegrityArtifact,
): ConnectorCatalogReleaseIdentity {
  return {
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    catalogVersion: pointer.catalogVersion,
    integrity: { ...pointer.integrity },
    publicCatalog: { ...integrity.artifacts.publicCatalog },
    privateCatalog: { ...integrity.artifacts.privateCatalog },
    privateFirewalls: { ...integrity.artifacts.privateFirewalls },
    runnerFirewalls: { ...integrity.artifacts.runnerFirewalls },
    requiredCapabilities: [...integrity.requiredCapabilities],
  };
}

export async function loadConnectorCatalogCandidate(args: {
  readonly reader: ConnectorCatalogArtifactReader;
  readonly pointer: ConnectorCatalogActivePointer;
}): Promise<ValidatedConnectorCatalogCandidate> {
  const integrity = await loadIntegrityArtifact(args);
  const bytes = await loadCatalogViewBytes({
    reader: args.reader,
    integrity,
  });
  const views = parseCatalogViews(bytes, args.pointer.catalogVersion);
  validateCatalogViews(views, integrity);
  return {
    identity: releaseIdentity(args.pointer, integrity),
    publicCatalogText: views.publicCatalogText,
  };
}
