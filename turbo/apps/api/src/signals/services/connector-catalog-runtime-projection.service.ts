import { createHash } from "node:crypto";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { BUILTIN_FIREWALL_CATALOG_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogRuntimeProjections,
  connectorCatalogRuntimeProjectionSets,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import { command } from "ccstate";
import { and, count, eq, inArray } from "drizzle-orm";

import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { safeJsonParse } from "../utils";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
} from "./connector-catalog-artifacts/artifacts";
import { decodeConnectorCatalogSnapshot } from "./connector-catalog-artifacts/loader";
import {
  connectorCatalogCompatibilityEvaluationSchema,
  connectorCatalogExecutableCapabilityState,
} from "./connector-catalog-compatibility.service";
import type { ExternalCatalogIdentity } from "./connector-catalog-external-reader.service";
import { connectorCatalogSource } from "./connector-catalog-source";
import {
  connectorCatalogValidationAuthorityIsCurrent,
  connectorCatalogValidationAuthorityIsCurrentOrNewer,
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidationAuthority,
  type ConnectorCatalogValidatorIdentity,
} from "./connector-catalog-validator-authority";

export const CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION = 2;

export type ConnectorCatalogRuntimeProjectionFallbackReason =
  | "not_ready"
  | "unsupported"
  | "compatibility_not_ready"
  | "invalid_compatibility"
  | "incomplete"
  | "malformed"
  | "digest_mismatch"
  | "unstable";

interface ConnectorCatalogRuntimeProjectionRowSetIdentity extends Omit<
  ExternalCatalogIdentity,
  "capabilityDigest"
> {
  readonly projectionSetId: string;
  readonly projectionVersion: number;
  readonly connectorCount: number;
}

export interface ConnectorCatalogRuntimeProjectionIdentity extends ConnectorCatalogRuntimeProjectionRowSetIdentity {
  readonly capabilityDigest: string;
}

export interface ConnectorCatalogRuntimeProjectionReadyIdentity {
  readonly identity: ConnectorCatalogRuntimeProjectionIdentity;
  readonly filteredMethodKeys: ReadonlySet<string>;
}

type ConnectorCatalogRuntimeProjectionIdentityRead =
  | {
      readonly kind: "ready";
      readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
    }
  | {
      readonly kind: "fallback";
      readonly reason: Extract<
        ConnectorCatalogRuntimeProjectionFallbackReason,
        | "not_ready"
        | "unsupported"
        | "compatibility_not_ready"
        | "invalid_compatibility"
      >;
    };

interface ConnectorCatalogRuntimeProjectionRow {
  readonly connectorSlug: ConnectorSlug;
  readonly connectorDigest: string;
  readonly connectorPayload: Buffer;
}

export type ConnectorCatalogRuntimeProjectionRowsRead =
  | {
      readonly kind: "ready";
      readonly connectors: readonly ConnectorCatalogArtifactConnector[];
      readonly missingConnectorSlugs: readonly ConnectorSlug[];
    }
  | {
      readonly kind: "fallback";
      readonly reason: Extract<
        ConnectorCatalogRuntimeProjectionFallbackReason,
        "malformed" | "digest_mismatch"
      >;
    };

export interface ConnectorCatalogRuntimeProjectionValidationTiming {
  measureParse<T>(operation: () => T): T;
  measureDigest<T>(operation: () => T): T;
}

type ConnectorCatalogRuntimeProjectionIdentityReadHook = () => Promise<void>;

const projectionIdentityReadHook = testOverride<
  ConnectorCatalogRuntimeProjectionIdentityReadHook | undefined
>(() => {
  return undefined;
});

export function setConnectorCatalogRuntimeProjectionIdentityReadHookForTest(
  hook: ConnectorCatalogRuntimeProjectionIdentityReadHook,
): void {
  projectionIdentityReadHook.set(hook);
}

export function clearConnectorCatalogRuntimeProjectionIdentityReadHookForTest(): void {
  projectionIdentityReadHook.clear();
}

function authMethodKey(connectorSlug: string, authMethodId: string): string {
  return `${connectorSlug}\0${authMethodId}`;
}

function persistedConnectorCatalogValidationAuthority(args: {
  readonly backendVersion: string | null;
  readonly validationRevision: string | null;
}): ConnectorCatalogValidationAuthority | null {
  return args.backendVersion === null
    ? null
    : {
        backendVersion: args.backendVersion,
        validationRevision: args.validationRevision,
      };
}

function isUnknownRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (!isUnknownRecord(value)) {
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

function connectorCatalogRuntimeProjectionPayload(
  connector: ConnectorCatalogArtifactConnector,
): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(connector)), "utf8");
}

function connectorCatalogRuntimeProjectionDigest(payload: Uint8Array): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export async function persistConnectorCatalogRuntimeProjection(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: {
    readonly catalogVersion: string;
    readonly catalogDigest: string;
  };
  readonly artifact: ConnectorCatalogArtifact;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): Promise<void> {
  await args.db
    .delete(connectorCatalogRuntimeProjectionSets)
    .where(
      and(
        eq(connectorCatalogRuntimeProjectionSets.sourceId, args.sourceId),
        eq(
          connectorCatalogRuntimeProjectionSets.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    );
  const [projectionSet] = await args.db
    .insert(connectorCatalogRuntimeProjectionSets)
    .values({
      sourceId: args.sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      catalogVersion: args.identity.catalogVersion,
      catalogDigest: args.identity.catalogDigest,
      projectionVersion: CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
      connectorCount: args.artifact.connectors.length,
      catalogValidationBackendVersion: args.validator.backendVersion,
      catalogValidationBuildCommitSha: args.validator.validationRevision,
    })
    .returning({ id: connectorCatalogRuntimeProjectionSets.id });
  if (projectionSet === undefined) {
    throw new Error("Connector runtime projection set insert returned no row");
  }
  await args.db.insert(connectorCatalogRuntimeProjections).values(
    args.artifact.connectors.map((connector) => {
      const connectorPayload =
        connectorCatalogRuntimeProjectionPayload(connector);
      return {
        projectionSetId: projectionSet.id,
        connectorSlug: connector.slug,
        connectorDigest:
          connectorCatalogRuntimeProjectionDigest(connectorPayload),
        connectorPayload,
      };
    }),
  );
}

async function queryProjectionIdentity(
  db: ReadonlyDb,
  sourceId: string,
  capabilityDigest: string,
) {
  const [row] = await db
    .select({
      projectionSetId: connectorCatalogRuntimeProjectionSets.id,
      schemaVersion: connectorCatalogActiveSnapshot.schemaVersion,
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
      projectionVersion:
        connectorCatalogRuntimeProjectionSets.projectionVersion,
      connectorCount: connectorCatalogRuntimeProjectionSets.connectorCount,
      projectionValidationBackendVersion:
        connectorCatalogRuntimeProjectionSets.catalogValidationBackendVersion,
      projectionValidationBuildCommitSha:
        connectorCatalogRuntimeProjectionSets.catalogValidationBuildCommitSha,
      evaluatedCapabilityDigest:
        connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      compatibilityValidationBackendVersion:
        connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
      compatibilityValidationBuildCommitSha:
        connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
      filteredAuthMethods:
        connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
    })
    .from(connectorCatalogActiveSnapshot)
    .leftJoin(
      connectorCatalogRuntimeProjectionSets,
      and(
        eq(
          connectorCatalogRuntimeProjectionSets.sourceId,
          connectorCatalogActiveSnapshot.sourceId,
        ),
        eq(
          connectorCatalogRuntimeProjectionSets.schemaVersion,
          connectorCatalogActiveSnapshot.schemaVersion,
        ),
        eq(
          connectorCatalogRuntimeProjectionSets.catalogVersion,
          connectorCatalogActiveSnapshot.catalogVersion,
        ),
        eq(
          connectorCatalogRuntimeProjectionSets.catalogDigest,
          connectorCatalogActiveSnapshot.catalogDigest,
        ),
      ),
    )
    .leftJoin(
      connectorCatalogCompatibilityEvaluation,
      and(
        eq(
          connectorCatalogCompatibilityEvaluation.sourceId,
          connectorCatalogActiveSnapshot.sourceId,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          connectorCatalogActiveSnapshot.schemaVersion,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.catalogVersion,
          connectorCatalogActiveSnapshot.catalogVersion,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.catalogDigest,
          connectorCatalogActiveSnapshot.catalogDigest,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          capabilityDigest,
        ),
      ),
    )
    .where(
      and(
        eq(connectorCatalogActiveSnapshot.sourceId, sourceId),
        eq(
          connectorCatalogActiveSnapshot.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .limit(1);
  return row;
}

async function readProjectionIdentity(
  db: ReadonlyDb,
): Promise<ConnectorCatalogRuntimeProjectionIdentityRead> {
  const sourceId = connectorCatalogSource().sourceId;
  const capabilityDigest = connectorCatalogExecutableCapabilityState().digest;
  const validator = currentConnectorCatalogValidatorIdentity();
  const row = await queryProjectionIdentity(db, sourceId, capabilityDigest);
  // Route integration tests use this seam to replace the active identity after
  // the read, making both retry generations deterministic without timing sleeps.
  await projectionIdentityReadHook.get()?.();
  if (
    row === undefined ||
    row.projectionSetId === null ||
    row.projectionVersion === null
  ) {
    return { kind: "fallback", reason: "not_ready" };
  }
  if (row.connectorCount === null) {
    return { kind: "fallback", reason: "unsupported" };
  }
  if (row.projectionVersion !== CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION) {
    return { kind: "fallback", reason: "unsupported" };
  }
  const compatibilityAuthority = persistedConnectorCatalogValidationAuthority({
    backendVersion: row.compatibilityValidationBackendVersion,
    validationRevision: row.compatibilityValidationBuildCommitSha,
  });
  if (
    row.evaluatedCapabilityDigest === null ||
    compatibilityAuthority === null
  ) {
    return { kind: "fallback", reason: "compatibility_not_ready" };
  }
  if (
    !connectorCatalogValidationAuthorityIsCurrent({
      authority: compatibilityAuthority,
      validator,
    })
  ) {
    return { kind: "fallback", reason: "compatibility_not_ready" };
  }
  const projectionAuthority = persistedConnectorCatalogValidationAuthority({
    backendVersion: row.projectionValidationBackendVersion,
    validationRevision: row.projectionValidationBuildCommitSha,
  });
  if (
    projectionAuthority === null ||
    !connectorCatalogValidationAuthorityIsCurrent({
      authority: projectionAuthority,
      validator,
    })
  ) {
    return { kind: "fallback", reason: "not_ready" };
  }
  const compatibility = connectorCatalogCompatibilityEvaluationSchema.safeParse(
    row.filteredAuthMethods,
  );
  if (!compatibility.success) {
    return { kind: "fallback", reason: "invalid_compatibility" };
  }
  return {
    kind: "ready",
    projection: {
      identity: {
        projectionSetId: row.projectionSetId,
        sourceId,
        schemaVersion: row.schemaVersion,
        catalogVersion: row.catalogVersion,
        catalogDigest: row.catalogDigest,
        capabilityDigest,
        projectionVersion: row.projectionVersion,
        connectorCount: row.connectorCount,
      },
      filteredMethodKeys: new Set(
        compatibility.data.filteredAuthMethods.map((method) => {
          return authMethodKey(method.connectorSlug, method.authMethodId);
        }),
      ),
    },
  };
}

export async function readConnectorCatalogRuntimeProjectionIdentity(
  db: ReadonlyDb,
): Promise<ConnectorCatalogRuntimeProjectionIdentityRead> {
  return await readProjectionIdentity(db);
}

function projectionIdentityWhere(
  identity: ConnectorCatalogRuntimeProjectionRowSetIdentity,
) {
  // The opaque set ID is the projection generation boundary. Querying child
  // rows by source/schema would allow a concurrent replacement to mix the
  // identity read from one generation with connector rows from the next.
  return eq(
    connectorCatalogRuntimeProjections.projectionSetId,
    identity.projectionSetId,
  );
}

export async function queryConnectorCatalogRuntimeProjectionRows(args: {
  readonly db: ReadonlyDb;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectorSlugs: readonly ConnectorSlug[];
}): Promise<readonly ConnectorCatalogRuntimeProjectionRow[]> {
  if (args.connectorSlugs.length === 0) {
    return [];
  }
  const where = and(
    projectionIdentityWhere(args.projection.identity),
    inArray(connectorCatalogRuntimeProjections.connectorSlug, [
      ...args.connectorSlugs,
    ]),
  );
  return await args.db
    .select({
      connectorSlug: connectorCatalogRuntimeProjections.connectorSlug,
      connectorDigest: connectorCatalogRuntimeProjections.connectorDigest,
      connectorPayload: connectorCatalogRuntimeProjections.connectorPayload,
    })
    .from(connectorCatalogRuntimeProjections)
    .where(where);
}

function isAttestedConnectorCatalogRuntimeProjection(
  value: unknown,
  connectorSlug: ConnectorSlug,
): value is ConnectorCatalogArtifactConnector {
  // The current validator authority on the exact projection generation
  // establishes deep schema and semantic validity. Raw payload SHA plus this
  // top-level row identity check binds the selected bytes without repeating
  // complete connector validation on request traffic.
  return isUnknownRecord(value) && value.slug === connectorSlug;
}

function parseAttestedConnectorCatalogRuntimeProjection(
  payload: Buffer,
  connectorSlug: ConnectorSlug,
): ConnectorCatalogArtifactConnector | undefined {
  if (
    payload.byteLength === 0 ||
    payload.byteLength > BUILTIN_FIREWALL_CATALOG_MAX_BYTES
  ) {
    return undefined;
  }
  const parsed = safeJsonParse(payload.toString("utf8"));
  return isAttestedConnectorCatalogRuntimeProjection(parsed, connectorSlug)
    ? parsed
    : undefined;
}

function validateAttestedConnectorCatalogRuntimeProjectionRow(args: {
  readonly row: ConnectorCatalogRuntimeProjectionRow;
  readonly timing: ConnectorCatalogRuntimeProjectionValidationTiming;
}):
  | {
      readonly kind: "ready";
      readonly connector: ConnectorCatalogArtifactConnector;
    }
  | {
      readonly kind: "fallback";
      readonly reason: "malformed" | "digest_mismatch";
    } {
  const payload = args.row.connectorPayload;
  const digestMatches = args.timing.measureDigest(() => {
    return (
      connectorCatalogRuntimeProjectionDigest(payload) ===
      args.row.connectorDigest
    );
  });
  if (!digestMatches) {
    return { kind: "fallback", reason: "digest_mismatch" };
  }
  const connector = args.timing.measureParse(() => {
    return parseAttestedConnectorCatalogRuntimeProjection(
      payload,
      args.row.connectorSlug,
    );
  });
  return connector === undefined
    ? { kind: "fallback", reason: "malformed" }
    : { kind: "ready", connector };
}

export function validateConnectorCatalogRuntimeProjectionRows(args: {
  readonly rows: readonly ConnectorCatalogRuntimeProjectionRow[];
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly timing: ConnectorCatalogRuntimeProjectionValidationTiming;
}): ConnectorCatalogRuntimeProjectionRowsRead {
  const rowBySlug = new Map(
    args.rows.map((row) => {
      return [row.connectorSlug, row] as const;
    }),
  );
  const connectors: ConnectorCatalogArtifactConnector[] = [];
  const missingConnectorSlugs: ConnectorSlug[] = [];
  for (const connectorSlug of args.connectorSlugs) {
    const row = rowBySlug.get(connectorSlug);
    if (row === undefined) {
      missingConnectorSlugs.push(connectorSlug);
      continue;
    }
    const validated = validateAttestedConnectorCatalogRuntimeProjectionRow({
      row,
      timing: args.timing,
    });
    if (validated.kind === "fallback") {
      return validated;
    }
    connectors.push(validated.connector);
  }
  return { kind: "ready", connectors, missingConnectorSlugs };
}

export async function countConnectorCatalogRuntimeProjectionRows(args: {
  readonly db: ReadonlyDb;
  readonly identity: ConnectorCatalogRuntimeProjectionRowSetIdentity;
}): Promise<number> {
  const [row] = await args.db
    .select({ value: count() })
    .from(connectorCatalogRuntimeProjections)
    .where(projectionIdentityWhere(args.identity));
  if (row === undefined) {
    throw new Error("Connector runtime projection count query returned no row");
  }
  return row.value;
}

async function lockSyncState(db: Db, sourceId: string): Promise<boolean> {
  const [state] = await db
    .select({ sourceId: connectorCatalogSyncState.sourceId })
    .from(connectorCatalogSyncState)
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .limit(1)
    .for("update");
  return state !== undefined;
}

export const reconcileConnectorCatalogRuntimeProjection$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const sourceId = connectorCatalogSource().sourceId;
    const validator = currentConnectorCatalogValidatorIdentity();
    await db.transaction(async (tx) => {
      if (!(await lockSyncState(tx, sourceId))) {
        return;
      }
      const [snapshot] = await tx
        .select({
          catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
          catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
          catalogRawSize: connectorCatalogActiveSnapshot.catalogRawSize,
          catalogGzip: connectorCatalogActiveSnapshot.catalogGzip,
        })
        .from(connectorCatalogActiveSnapshot)
        .where(
          and(
            eq(connectorCatalogActiveSnapshot.sourceId, sourceId),
            eq(
              connectorCatalogActiveSnapshot.schemaVersion,
              SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
            ),
          ),
        )
        .limit(1);
      if (snapshot === undefined) {
        return;
      }
      const [ready] = await tx
        .select({
          projectionSetId: connectorCatalogRuntimeProjectionSets.id,
          connectorCount: connectorCatalogRuntimeProjectionSets.connectorCount,
          validationBackendVersion:
            connectorCatalogRuntimeProjectionSets.catalogValidationBackendVersion,
          validationBuildCommitSha:
            connectorCatalogRuntimeProjectionSets.catalogValidationBuildCommitSha,
        })
        .from(connectorCatalogRuntimeProjectionSets)
        .where(
          and(
            eq(connectorCatalogRuntimeProjectionSets.sourceId, sourceId),
            eq(
              connectorCatalogRuntimeProjectionSets.schemaVersion,
              SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
            ),
            eq(
              connectorCatalogRuntimeProjectionSets.catalogVersion,
              snapshot.catalogVersion,
            ),
            eq(
              connectorCatalogRuntimeProjectionSets.catalogDigest,
              snapshot.catalogDigest,
            ),
            eq(
              connectorCatalogRuntimeProjectionSets.projectionVersion,
              CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
            ),
          ),
        )
        .limit(1);
      if (ready !== undefined) {
        const authority = persistedConnectorCatalogValidationAuthority({
          backendVersion: ready.validationBackendVersion,
          validationRevision: ready.validationBuildCommitSha,
        });
        // Legacy null revisions remain exact-release scoped. Non-null
        // authorities additionally preserve a newer overlapping writer.
        if (
          authority !== null &&
          (authority.validationRevision === null &&
          validator.validationRevision === null
            ? connectorCatalogValidationAuthorityIsCurrent({
                authority,
                validator,
              })
            : connectorCatalogValidationAuthorityIsCurrentOrNewer({
                authority,
                validator,
              }))
        ) {
          const actualCount = await countConnectorCatalogRuntimeProjectionRows({
            db: tx,
            identity: {
              projectionSetId: ready.projectionSetId,
              sourceId,
              schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
              catalogVersion: snapshot.catalogVersion,
              catalogDigest: snapshot.catalogDigest,
              projectionVersion: CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
              connectorCount: ready.connectorCount,
            },
          });
          if (actualCount === ready.connectorCount) {
            return;
          }
        }
      }
      const decoded = decodeConnectorCatalogSnapshot(snapshot);
      await persistConnectorCatalogRuntimeProjection({
        db: tx,
        sourceId,
        identity: snapshot,
        artifact: decoded.artifact,
        validator,
      });
    });
    signal.throwIfAborted();
  },
);
