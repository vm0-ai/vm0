import { createHash } from "node:crypto";

import {
  connectorCatalogFilteredAuthMethodsSchema,
  type ConnectorCatalogFilteredAuthMethod,
} from "@vm0/api-contracts/contracts/connector-catalog-diagnostics";
import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogRuntimeProjection,
  connectorCatalogSyncState,
} from "@vm0/db/schema/connector-catalog";
import { command } from "ccstate";
import { and, count, eq, inArray } from "drizzle-orm";

import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  connectorCatalogArtifactConnectorSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
} from "./connector-catalog-artifacts/artifacts";
import { decodeConnectorCatalogSnapshot } from "./connector-catalog-artifacts/loader";
import { connectorCatalogExecutableCapabilityDigest } from "./connector-catalog-compatibility.service";
import { connectorCatalogSource } from "./connector-catalog-source";

const CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION = 1;

export type ConnectorCatalogRuntimeProjectionFallbackReason =
  | "absent"
  | "stale"
  | "unsupported"
  | "incomplete"
  | "malformed"
  | "digest_mismatch"
  | "invalid_compatibility"
  | "unstable";

interface ConnectorCatalogRuntimeProjectionRowSetIdentity {
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly projectionVersion: number;
}

export interface ConnectorCatalogRuntimeProjectionIdentity extends ConnectorCatalogRuntimeProjectionRowSetIdentity {
  readonly capabilityDigest: string;
  readonly connectorCount: number;
}

export interface ConnectorCatalogRuntimeProjectionReadyIdentity {
  readonly identity: ConnectorCatalogRuntimeProjectionIdentity;
  readonly filteredAuthMethods: readonly ConnectorCatalogFilteredAuthMethod[];
}

type ConnectorCatalogRuntimeProjectionIdentityRead =
  | {
      readonly kind: "ready";
      readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
    }
  | {
      readonly kind: "fallback";
      readonly reason: ConnectorCatalogRuntimeProjectionFallbackReason;
    };

type ConnectorCatalogRuntimeProjectionRowsRead =
  | {
      readonly kind: "ready";
      readonly connectors: readonly ConnectorCatalogArtifactConnector[];
      readonly missingConnectorRefs: readonly ConnectorRef[];
    }
  | {
      readonly kind: "fallback";
      readonly reason: Extract<
        ConnectorCatalogRuntimeProjectionFallbackReason,
        "malformed" | "digest_mismatch"
      >;
    };

interface ConnectorCatalogRuntimeProjectionWriteIdentity {
  readonly catalogVersion: string;
  readonly catalogDigest: string;
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
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalJsonValue(value[key]);
  }
  return result;
}

function connectorCatalogRuntimeProjectionDigest(
  connector: ConnectorCatalogArtifactConnector,
): string {
  const canonical = JSON.stringify(canonicalJsonValue(connector));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export async function persistConnectorCatalogRuntimeProjection(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: ConnectorCatalogRuntimeProjectionWriteIdentity;
  readonly artifact: ConnectorCatalogArtifact;
}): Promise<void> {
  await args.db
    .delete(connectorCatalogRuntimeProjection)
    .where(
      and(
        eq(connectorCatalogRuntimeProjection.sourceId, args.sourceId),
        eq(
          connectorCatalogRuntimeProjection.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    );
  await args.db.insert(connectorCatalogRuntimeProjection).values(
    args.artifact.connectors.map((connector) => {
      return {
        sourceId: args.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        catalogVersion: args.identity.catalogVersion,
        catalogDigest: args.identity.catalogDigest,
        projectionVersion: CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
        connectorRef: connector.connectorRef,
        connectorDigest: connectorCatalogRuntimeProjectionDigest(connector),
        connector,
      };
    }),
  );
  const updated = await args.db
    .update(connectorCatalogActiveSnapshot)
    .set({
      runtimeProjectionVersion: CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
      runtimeProjectionCatalogDigest: args.identity.catalogDigest,
      runtimeProjectionConnectorCount: args.artifact.connectors.length,
    })
    .where(
      and(
        eq(connectorCatalogActiveSnapshot.sourceId, args.sourceId),
        eq(
          connectorCatalogActiveSnapshot.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(
          connectorCatalogActiveSnapshot.catalogVersion,
          args.identity.catalogVersion,
        ),
        eq(
          connectorCatalogActiveSnapshot.catalogDigest,
          args.identity.catalogDigest,
        ),
      ),
    )
    .returning({ sourceId: connectorCatalogActiveSnapshot.sourceId });
  if (updated.length !== 1) {
    throw new Error("Active connector catalog changed during projection write");
  }
}

async function readProjectionIdentity(db: ReadonlyDb): Promise<
  | {
      readonly sourceId: string;
      readonly schemaVersion: number;
      readonly catalogVersion: string;
      readonly catalogDigest: string;
      readonly capabilityDigest: string;
      readonly projectionVersion: number | null;
      readonly projectionCatalogDigest: string | null;
      readonly projectionConnectorCount: number | null;
      readonly filteredAuthMethods: unknown;
    }
  | undefined
> {
  const sourceId = connectorCatalogSource().sourceId;
  const capabilityDigest = connectorCatalogExecutableCapabilityDigest();
  const [row] = await db
    .select({
      schemaVersion: connectorCatalogActiveSnapshot.schemaVersion,
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
      projectionVersion:
        connectorCatalogActiveSnapshot.runtimeProjectionVersion,
      projectionCatalogDigest:
        connectorCatalogActiveSnapshot.runtimeProjectionCatalogDigest,
      projectionConnectorCount:
        connectorCatalogActiveSnapshot.runtimeProjectionConnectorCount,
      filteredAuthMethods:
        connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
    })
    .from(connectorCatalogActiveSnapshot)
    .innerJoin(
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
      ),
    )
    .where(
      and(
        eq(connectorCatalogActiveSnapshot.sourceId, sourceId),
        eq(
          connectorCatalogActiveSnapshot.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          capabilityDigest,
        ),
      ),
    )
    .limit(1);
  return row
    ? {
        sourceId,
        capabilityDigest,
        ...row,
      }
    : undefined;
}

export async function readConnectorCatalogRuntimeProjectionIdentity(
  db: ReadonlyDb,
): Promise<ConnectorCatalogRuntimeProjectionIdentityRead> {
  const current = await readProjectionIdentity(db);
  if (
    current === undefined ||
    current.projectionVersion === null ||
    current.projectionCatalogDigest === null ||
    current.projectionConnectorCount === null
  ) {
    return { kind: "fallback", reason: "absent" };
  }
  if (
    current.projectionVersion !== CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION
  ) {
    return { kind: "fallback", reason: "unsupported" };
  }
  if (current.projectionCatalogDigest !== current.catalogDigest) {
    return { kind: "fallback", reason: "stale" };
  }

  const filteredAuthMethods =
    connectorCatalogFilteredAuthMethodsSchema.safeParse(
      current.filteredAuthMethods,
    );
  if (!filteredAuthMethods.success) {
    return { kind: "fallback", reason: "invalid_compatibility" };
  }

  return {
    kind: "ready",
    projection: {
      identity: {
        sourceId: current.sourceId,
        schemaVersion: current.schemaVersion,
        catalogVersion: current.catalogVersion,
        catalogDigest: current.catalogDigest,
        capabilityDigest: current.capabilityDigest,
        projectionVersion: current.projectionVersion,
        connectorCount: current.projectionConnectorCount,
      },
      filteredAuthMethods: filteredAuthMethods.data,
    },
  };
}

export async function readConnectorCatalogRuntimeProjectionRows(args: {
  readonly db: ReadonlyDb;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectorRefs: readonly ConnectorRef[];
}): Promise<ConnectorCatalogRuntimeProjectionRowsRead> {
  const { identity } = args.projection;
  const rows = await args.db
    .select({
      connectorRef: connectorCatalogRuntimeProjection.connectorRef,
      connectorDigest: connectorCatalogRuntimeProjection.connectorDigest,
      connector: connectorCatalogRuntimeProjection.connector,
    })
    .from(connectorCatalogRuntimeProjection)
    .where(
      and(
        eq(connectorCatalogRuntimeProjection.sourceId, identity.sourceId),
        eq(
          connectorCatalogRuntimeProjection.schemaVersion,
          identity.schemaVersion,
        ),
        eq(
          connectorCatalogRuntimeProjection.catalogVersion,
          identity.catalogVersion,
        ),
        eq(
          connectorCatalogRuntimeProjection.catalogDigest,
          identity.catalogDigest,
        ),
        eq(
          connectorCatalogRuntimeProjection.projectionVersion,
          identity.projectionVersion,
        ),
        inArray(connectorCatalogRuntimeProjection.connectorRef, [
          ...args.connectorRefs,
        ]),
      ),
    );
  const rowsByRef = new Map(
    rows.map((row) => {
      return [row.connectorRef, row];
    }),
  );
  const connectors: ConnectorCatalogArtifactConnector[] = [];
  const missingConnectorRefs: ConnectorRef[] = [];
  for (const connectorRef of args.connectorRefs) {
    const row = rowsByRef.get(connectorRef);
    if (row === undefined) {
      missingConnectorRefs.push(connectorRef);
      continue;
    }
    const connector = connectorCatalogArtifactConnectorSchema.safeParse(
      row.connector,
    );
    if (
      !connector.success ||
      connector.data.connectorRef !== row.connectorRef
    ) {
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

  return {
    kind: "ready",
    connectors,
    missingConnectorRefs,
  };
}

export async function countConnectorCatalogRuntimeProjectionRows(args: {
  readonly db: ReadonlyDb;
  readonly identity: ConnectorCatalogRuntimeProjectionRowSetIdentity;
}): Promise<number> {
  const { identity } = args;
  const [row] = await args.db
    .select({ value: count() })
    .from(connectorCatalogRuntimeProjection)
    .where(
      and(
        eq(connectorCatalogRuntimeProjection.sourceId, identity.sourceId),
        eq(
          connectorCatalogRuntimeProjection.schemaVersion,
          identity.schemaVersion,
        ),
        eq(
          connectorCatalogRuntimeProjection.catalogVersion,
          identity.catalogVersion,
        ),
        eq(
          connectorCatalogRuntimeProjection.catalogDigest,
          identity.catalogDigest,
        ),
        eq(
          connectorCatalogRuntimeProjection.projectionVersion,
          identity.projectionVersion,
        ),
      ),
    );
  if (row === undefined) {
    throw new Error("Connector runtime projection count query returned no row");
  }
  return row.value;
}

export const reconcileConnectorCatalogRuntimeProjection$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const sourceId = connectorCatalogSource().sourceId;
    await db.transaction(async (tx) => {
      const [syncState] = await tx
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
      if (syncState === undefined) {
        return;
      }
      const [snapshot] = await tx
        .select({
          catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
          catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
          catalogRawSize: connectorCatalogActiveSnapshot.catalogRawSize,
          catalogGzip: connectorCatalogActiveSnapshot.catalogGzip,
          projectionVersion:
            connectorCatalogActiveSnapshot.runtimeProjectionVersion,
          projectionCatalogDigest:
            connectorCatalogActiveSnapshot.runtimeProjectionCatalogDigest,
          projectionConnectorCount:
            connectorCatalogActiveSnapshot.runtimeProjectionConnectorCount,
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
      if (
        snapshot.projectionVersion ===
          CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION &&
        snapshot.projectionCatalogDigest === snapshot.catalogDigest &&
        snapshot.projectionConnectorCount !== null
      ) {
        const actualCount = await countConnectorCatalogRuntimeProjectionRows({
          db: tx,
          identity: {
            sourceId,
            schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
            catalogVersion: snapshot.catalogVersion,
            catalogDigest: snapshot.catalogDigest,
            projectionVersion: snapshot.projectionVersion,
          },
        });
        if (actualCount === snapshot.projectionConnectorCount) {
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
