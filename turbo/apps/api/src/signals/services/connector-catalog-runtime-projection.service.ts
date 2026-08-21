import { createHash } from "node:crypto";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogRuntimeProjections,
  connectorCatalogRuntimeProjectionSets,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import { command } from "ccstate";
import { and, count, eq, inArray, sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { singleton } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  connectorCatalogArtifactConnectorSchema,
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
  currentConnectorCatalogValidatorIdentity,
} from "./connector-catalog-validator-authority";

export const CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION = 1;

export type ConnectorCatalogRuntimeProjectionFallbackReason =
  | "schema_unavailable"
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
        | "schema_unavailable"
        | "not_ready"
        | "unsupported"
        | "compatibility_not_ready"
        | "invalid_compatibility"
      >;
    };

type ConnectorCatalogRuntimeProjectionRowsRead =
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

interface ProjectionSchemaAvailabilityCache {
  available: boolean;
}

const projectionSchemaAvailabilityCache = singleton(
  (): ProjectionSchemaAvailabilityCache => {
    return { available: false };
  },
);

function authMethodKey(connectorSlug: string, authMethodId: string): string {
  return `${connectorSlug}\0${authMethodId}`;
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

function connectorCatalogRuntimeProjectionDigest(
  connector: ConnectorCatalogArtifactConnector,
): string {
  const canonical = JSON.stringify(canonicalJsonValue(connector));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export async function connectorCatalogRuntimeProjectionSchemaAvailable(
  db: ReadonlyDb,
): Promise<boolean> {
  const cache = projectionSchemaAvailabilityCache();
  if (cache.available) {
    return true;
  }
  const [state] = await db
    .select({
      available: sql`
        to_regclass('public.connector_catalog_runtime_projection_sets') IS NOT NULL
        AND to_regclass('public.connector_catalog_runtime_projections') IS NOT NULL
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS connector_catalog_projection_schema_probe`)
    .limit(1);
  const available = state?.available ?? false;
  // New API instances can serve before migration 0960. Cache only success so
  // an already-warm instance observes the schema as soon as migration arrives.
  cache.available = available;
  return available;
}

export async function persistConnectorCatalogRuntimeProjection(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: {
    readonly catalogVersion: string;
    readonly catalogDigest: string;
  };
  readonly artifact: ConnectorCatalogArtifact;
  readonly projectedAt?: Date;
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
  const setIdentity = {
    sourceId: args.sourceId,
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    catalogVersion: args.identity.catalogVersion,
    catalogDigest: args.identity.catalogDigest,
    projectionVersion: CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
  };
  await args.db.insert(connectorCatalogRuntimeProjectionSets).values({
    ...setIdentity,
    connectorCount: args.artifact.connectors.length,
    projectedAt: args.projectedAt ?? nowDate(),
  });
  await args.db.insert(connectorCatalogRuntimeProjections).values(
    args.artifact.connectors.map((connector) => {
      return {
        ...setIdentity,
        connectorSlug: connector.slug,
        connectorDigest: connectorCatalogRuntimeProjectionDigest(connector),
        connector,
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
      schemaVersion: connectorCatalogActiveSnapshot.schemaVersion,
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
      projectionVersion:
        connectorCatalogRuntimeProjectionSets.projectionVersion,
      connectorCount: connectorCatalogRuntimeProjectionSets.connectorCount,
      evaluatedCapabilityDigest:
        connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      validationBackendVersion:
        connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
      validationBuildCommitSha:
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
  if (!(await connectorCatalogRuntimeProjectionSchemaAvailable(db))) {
    return { kind: "fallback", reason: "schema_unavailable" };
  }
  const sourceId = connectorCatalogSource().sourceId;
  const capabilityDigest = connectorCatalogExecutableCapabilityState().digest;
  const row = await queryProjectionIdentity(db, sourceId, capabilityDigest);
  if (row === undefined || row.projectionVersion === null) {
    return { kind: "fallback", reason: "not_ready" };
  }
  if (
    row.projectionVersion !== CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION ||
    row.connectorCount === null
  ) {
    return { kind: "fallback", reason: "unsupported" };
  }
  if (
    row.evaluatedCapabilityDigest === null ||
    row.validationBackendVersion === null
  ) {
    return { kind: "fallback", reason: "compatibility_not_ready" };
  }
  if (
    !connectorCatalogValidationAuthorityIsCurrent({
      authority: {
        backendVersion: row.validationBackendVersion,
        buildCommitSha: row.validationBuildCommitSha,
      },
      validator: currentConnectorCatalogValidatorIdentity(),
    })
  ) {
    return { kind: "fallback", reason: "compatibility_not_ready" };
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
  return and(
    eq(connectorCatalogRuntimeProjections.sourceId, identity.sourceId),
    eq(
      connectorCatalogRuntimeProjections.schemaVersion,
      identity.schemaVersion,
    ),
    eq(
      connectorCatalogRuntimeProjections.catalogVersion,
      identity.catalogVersion,
    ),
    eq(
      connectorCatalogRuntimeProjections.catalogDigest,
      identity.catalogDigest,
    ),
    eq(
      connectorCatalogRuntimeProjections.projectionVersion,
      identity.projectionVersion,
    ),
  );
}

export async function readConnectorCatalogRuntimeProjectionRows(args: {
  readonly db: ReadonlyDb;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectorSlugs: readonly ConnectorSlug[];
}): Promise<ConnectorCatalogRuntimeProjectionRowsRead> {
  if (args.connectorSlugs.length === 0) {
    return { kind: "ready", connectors: [], missingConnectorSlugs: [] };
  }
  const connectorSlugs = [...new Set(args.connectorSlugs)];
  const rows = await args.db
    .select({
      connectorSlug: connectorCatalogRuntimeProjections.connectorSlug,
      connectorDigest: connectorCatalogRuntimeProjections.connectorDigest,
      connector: connectorCatalogRuntimeProjections.connector,
    })
    .from(connectorCatalogRuntimeProjections)
    .where(
      and(
        projectionIdentityWhere(args.projection.identity),
        inArray(connectorCatalogRuntimeProjections.connectorSlug, [
          ...connectorSlugs,
        ]),
      ),
    );
  const rowBySlug = new Map(
    rows.map((row) => {
      return [row.connectorSlug, row] as const;
    }),
  );
  const connectors: ConnectorCatalogArtifactConnector[] = [];
  const missingConnectorSlugs: ConnectorSlug[] = [];
  for (const connectorSlug of connectorSlugs) {
    const row = rowBySlug.get(connectorSlug);
    if (row === undefined) {
      missingConnectorSlugs.push(connectorSlug);
      continue;
    }
    const connector = connectorCatalogArtifactConnectorSchema.safeParse(
      row.connector,
    );
    if (!connector.success || connector.data.slug !== row.connectorSlug) {
      return { kind: "fallback", reason: "malformed" };
    }
    if (
      connectorCatalogRuntimeProjectionDigest(connector.data) !==
      row.connectorDigest
    ) {
      return { kind: "fallback", reason: "digest_mismatch" };
    }
    connectors.push(connector.data);
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
    if (!(await connectorCatalogRuntimeProjectionSchemaAvailable(db))) {
      signal.throwIfAborted();
      return;
    }
    const sourceId = connectorCatalogSource().sourceId;
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
          connectorCount: connectorCatalogRuntimeProjectionSets.connectorCount,
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
        const actualCount = await countConnectorCatalogRuntimeProjectionRows({
          db: tx,
          identity: {
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
      const decoded = decodeConnectorCatalogSnapshot(snapshot);
      await persistConnectorCatalogRuntimeProjection({
        db: tx,
        sourceId,
        identity: snapshot,
        artifact: decoded.artifact,
      });
    });
    signal.throwIfAborted();
  },
);
