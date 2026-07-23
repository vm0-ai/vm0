import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type { ConnectorCatalogSyncFailureCode } from "@vm0/api-contracts/contracts/cron";
import { z } from "zod";

import { safeJsonParse, safeSync } from "../../utils";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  CONNECTOR_CATALOG_MAX_RAW_BYTES,
  connectorCatalogArtifactSchema,
  connectorCatalogVersionSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
} from "./artifacts";
import { artifactKeySchema, digestSchema } from "./common";
import { validateConnectorCatalogPublicProjection } from "./public-leak";
import { validateConnectorCatalogArtifact } from "./relationships";

const ACTIVE_POINTER_MAX_BYTES = 16 * 1024;
const CONNECTOR_CATALOG_MAX_GZIP_BYTES = CONNECTOR_CATALOG_MAX_RAW_BYTES * 2;

const connectorCatalogObjectKeySchema = artifactKeySchema.refine((key) => {
  const namespace = `connectors/v${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION}/`;
  return (
    key.startsWith(namespace) &&
    key !== CONNECTOR_CATALOG_ACTIVE_KEY &&
    key.endsWith(".json") &&
    !key.includes("?") &&
    !key.includes("#")
  );
}, "Catalog key must be a trusted connector JSON object key");

const connectorCatalogActivePointerSchema = z
  .object({
    catalogVersion: connectorCatalogVersionSchema,
    catalogKey: connectorCatalogObjectKeySchema,
    catalogDigest: digestSchema,
  })
  .strict();

export type ConnectorCatalogActivePointer = z.infer<
  typeof connectorCatalogActivePointerSchema
>;

export interface ConnectorCatalogIdentity {
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly catalogKey: string;
  readonly catalogDigest: string;
}

export interface ValidatedConnectorCatalogCandidate {
  readonly identity: ConnectorCatalogIdentity;
  readonly artifact: ConnectorCatalogArtifact;
  readonly rawBytes: Buffer;
}

interface DecodedConnectorCatalogSnapshot {
  readonly artifact: ConnectorCatalogArtifact;
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

function connectorCatalogDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertDigest(bytes: Uint8Array, expectedDigest: string): void {
  if (connectorCatalogDigest(bytes) !== expectedDigest) {
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

function decodedJson(bytes: Uint8Array): unknown {
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
  return value;
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

function parseAndValidateCatalog(args: {
  readonly bytes: Uint8Array;
  readonly catalogVersion: string;
}): ConnectorCatalogArtifact {
  const json = decodedJson(args.bytes);
  assertSupportedArtifactSchema(json);
  const artifact = parseStrict(
    json,
    connectorCatalogArtifactSchema,
    "invalid-artifact",
  );
  if (artifact.catalogVersion !== args.catalogVersion) {
    fail("invalid-reference");
  }
  const publicProjection = safeSync(() => {
    validateConnectorCatalogPublicProjection(artifact);
  });
  if (!("ok" in publicProjection)) {
    fail("public-leakage");
  }
  const relationships = safeSync(() => {
    validateConnectorCatalogArtifact(artifact);
  });
  if (!("ok" in relationships)) {
    fail("relationship-mismatch");
  }
  return artifact;
}

export const CONNECTOR_CATALOG_ACTIVE_MAX_BYTES = ACTIVE_POINTER_MAX_BYTES;

export function parseConnectorCatalogActivePointer(
  bytes: Uint8Array,
): ConnectorCatalogActivePointer {
  if (bytes.length > ACTIVE_POINTER_MAX_BYTES) {
    fail("object-too-large");
  }
  return parseStrict(
    decodedJson(bytes),
    connectorCatalogActivePointerSchema,
    "invalid-pointer",
  );
}

export async function loadConnectorCatalogCandidate(args: {
  readonly reader: ConnectorCatalogArtifactReader;
  readonly pointer: ConnectorCatalogActivePointer;
}): Promise<ValidatedConnectorCatalogCandidate> {
  const rawBytes = await readBoundedArtifact(
    args.reader,
    args.pointer.catalogKey,
    CONNECTOR_CATALOG_MAX_RAW_BYTES,
  );
  assertDigest(rawBytes, args.pointer.catalogDigest);
  const artifact = parseAndValidateCatalog({
    bytes: rawBytes,
    catalogVersion: args.pointer.catalogVersion,
  });
  return {
    identity: {
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      catalogVersion: args.pointer.catalogVersion,
      catalogKey: args.pointer.catalogKey,
      catalogDigest: args.pointer.catalogDigest,
    },
    artifact,
    rawBytes,
  };
}

export function encodeConnectorCatalogSnapshot(rawBytes: Uint8Array): Buffer {
  return gzipSync(rawBytes);
}

function gunzipCatalog(bytes: Uint8Array): Buffer {
  const decompressed = safeSync(() => {
    return gunzipSync(bytes, {
      maxOutputLength: CONNECTOR_CATALOG_MAX_RAW_BYTES,
    });
  });
  if ("ok" in decompressed) {
    return decompressed.ok;
  }
  if (
    isRecord(decompressed.error) &&
    decompressed.error.code === "ERR_BUFFER_TOO_LARGE"
  ) {
    fail("object-too-large");
  }
  fail("invalid-compression");
}

export function decodeConnectorCatalogSnapshot(args: {
  readonly catalogGzip: Uint8Array;
  readonly catalogRawSize: number;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
}): DecodedConnectorCatalogSnapshot {
  if (
    args.catalogGzip.byteLength > CONNECTOR_CATALOG_MAX_GZIP_BYTES ||
    args.catalogRawSize > CONNECTOR_CATALOG_MAX_RAW_BYTES
  ) {
    fail("object-too-large");
  }
  const rawBytes = gunzipCatalog(args.catalogGzip);
  if (rawBytes.byteLength !== args.catalogRawSize) {
    fail("invalid-reference");
  }
  assertDigest(rawBytes, args.catalogDigest);
  return {
    artifact: parseAndValidateCatalog({
      bytes: rawBytes,
      catalogVersion: args.catalogVersion,
    }),
  };
}
