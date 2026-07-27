import { createHash } from "node:crypto";

import { createStore } from "ccstate";
import { getConnectorAuthProviderRegistrationCapabilities } from "@vm0/connectors/auth-providers";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogRuntimeProjection,
  connectorCatalogSyncState,
} from "@vm0/db/schema/connector-catalog";
import { and, eq } from "drizzle-orm";

import { mockOptionalEnv } from "../lib/env";
import { writeDb$ } from "../signals/external/db";
import { nowDate } from "../signals/external/time";
import {
  connectorCatalogArtifactSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
} from "../signals/services/connector-catalog-artifacts/artifacts";
import { encodeConnectorCatalogSnapshot } from "../signals/services/connector-catalog-artifacts/loader";
import {
  connectorCatalogFirewallConfig,
  validateConnectorCatalogArtifact,
} from "../signals/services/connector-catalog-artifacts/relationships";
import {
  connectorCatalogExecutableCapabilityState,
  persistConnectorCatalogCompatibility,
} from "../signals/services/connector-catalog-compatibility.service";
import { persistConnectorCatalogRuntimeProjection } from "../signals/services/connector-catalog-runtime-projection.service";
import { connectorCatalogSource } from "../signals/services/connector-catalog-source";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "./connector-catalog-artifact";

export const API_TEST_CONNECTOR_CATALOG = connectorCatalogArtifactSchema.parse(
  API_TEST_CONNECTOR_CATALOG_ARTIFACT,
);

validateConnectorCatalogArtifact(API_TEST_CONNECTOR_CATALOG);

export const API_TEST_CONNECTOR_FIREWALL_CONFIGS =
  API_TEST_CONNECTOR_CATALOG.connectors.flatMap((connector) => {
    const firewall = connectorCatalogFirewallConfig(connector);
    return firewall === null ? [] : [firewall];
  });

const API_TEST_CONNECTOR_CATALOG_VERSION =
  API_TEST_CONNECTOR_CATALOG.catalogVersion;

const API_TEST_CONNECTOR_CATALOG_KEY =
  `connectors/v${String(SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION)}/` +
  `releases/${API_TEST_CONNECTOR_CATALOG_VERSION}/catalog.json`;

const store = createStore();

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function mockApiTestConnectorProviderConfiguration(): void {
  const requiredNames = new Set(
    getConnectorAuthProviderRegistrationCapabilities().flatMap(
      (registration) => {
        return registration.requiredConfigurationNames;
      },
    ),
  );
  for (const name of requiredNames) {
    mockOptionalEnv(name, `api-test-${name.toLowerCase()}`);
  }
}

export async function installApiTestConnectorCatalog(): Promise<void> {
  const rawBytes = Buffer.from(
    `${JSON.stringify(API_TEST_CONNECTOR_CATALOG)}\n`,
  );
  const catalogDigest = sha256Digest(rawBytes);
  const catalogGzip = encodeConnectorCatalogSnapshot(rawBytes);
  const source = connectorCatalogSource();
  const capability = connectorCatalogExecutableCapabilityState();
  const activatedAt = nowDate();
  const db = store.set(writeDb$);
  const syncStateValues = {
    revision: 1,
    lastObservedCatalogVersion: API_TEST_CONNECTOR_CATALOG_VERSION,
    lastObservedCatalogKey: API_TEST_CONNECTOR_CATALOG_KEY,
    lastObservedCatalogDigest: catalogDigest,
    lastObservedPointerEtag: null,
    lastAttemptAt: activatedAt,
    lastAttemptOutcome: "accepted" as const,
    lastAttemptReusedCachedRejection: false,
    lastSuccessAt: activatedAt,
    lastFailureCode: null,
    lastRejectedCatalogVersion: null,
    lastRejectedCatalogKey: null,
    lastRejectedCatalogDigest: null,
    lastRejectedPointerEtag: null,
    lastRejectedFailureCode: null,
    lastRejectedBackendVersion: null,
    lastRejectedBuildCommitSha: null,
  };
  const snapshotValues = {
    catalogVersion: API_TEST_CONNECTOR_CATALOG_VERSION,
    catalogKey: API_TEST_CONNECTOR_CATALOG_KEY,
    catalogDigest,
    catalogRawSize: rawBytes.byteLength,
    catalogGzip,
    activatedAt,
  };

  await db.transaction(async (tx) => {
    await tx
      .insert(connectorCatalogSyncState)
      .values({
        sourceId: source.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ...syncStateValues,
      })
      .onConflictDoUpdate({
        target: [
          connectorCatalogSyncState.sourceId,
          connectorCatalogSyncState.schemaVersion,
        ],
        set: syncStateValues,
      });
    await tx
      .insert(connectorCatalogActiveSnapshot)
      .values({
        sourceId: source.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ...snapshotValues,
      })
      .onConflictDoUpdate({
        target: [
          connectorCatalogActiveSnapshot.sourceId,
          connectorCatalogActiveSnapshot.schemaVersion,
        ],
        set: snapshotValues,
      });
    await persistConnectorCatalogRuntimeProjection({
      db: tx,
      sourceId: source.sourceId,
      identity: {
        catalogVersion: API_TEST_CONNECTOR_CATALOG_VERSION,
        catalogDigest,
      },
      artifact: API_TEST_CONNECTOR_CATALOG,
    });
    await persistConnectorCatalogCompatibility({
      db: tx,
      sourceId: source.sourceId,
      identity: {
        catalogVersion: API_TEST_CONNECTOR_CATALOG_VERSION,
        catalogDigest,
      },
      artifact: API_TEST_CONNECTOR_CATALOG,
      capability,
    });
  });
}

type ApiTestConnectorCatalogRuntimeProjectionMutation =
  | { readonly kind: "clear" | "absent" | "stale" | "unsupported" }
  | {
      readonly kind: "delete-row" | "malformed-row" | "digest-mismatch";
      readonly connectorRef: string;
    };

export async function mutateApiTestConnectorCatalogRuntimeProjection(
  mutation: ApiTestConnectorCatalogRuntimeProjectionMutation,
): Promise<void> {
  const sourceId = connectorCatalogSource().sourceId;
  const db = store.set(writeDb$);
  const activeWhere = and(
    eq(connectorCatalogActiveSnapshot.sourceId, sourceId),
    eq(
      connectorCatalogActiveSnapshot.schemaVersion,
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    ),
  );
  const projectionWhere = and(
    eq(connectorCatalogRuntimeProjection.sourceId, sourceId),
    eq(
      connectorCatalogRuntimeProjection.schemaVersion,
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    ),
  );
  switch (mutation.kind) {
    case "clear": {
      await db.transaction(async (tx) => {
        await tx
          .delete(connectorCatalogRuntimeProjection)
          .where(projectionWhere);
        await tx
          .update(connectorCatalogActiveSnapshot)
          .set({
            runtimeProjectionVersion: null,
            runtimeProjectionCatalogDigest: null,
          })
          .where(activeWhere);
      });
      return;
    }
    case "absent": {
      await db
        .update(connectorCatalogActiveSnapshot)
        .set({
          runtimeProjectionVersion: null,
          runtimeProjectionCatalogDigest: null,
        })
        .where(activeWhere);
      return;
    }
    case "stale": {
      await db
        .update(connectorCatalogActiveSnapshot)
        .set({
          runtimeProjectionVersion: 1,
          runtimeProjectionCatalogDigest: `sha256:${"0".repeat(64)}`,
        })
        .where(activeWhere);
      return;
    }
    case "unsupported": {
      const [active] = await db
        .select({ catalogDigest: connectorCatalogActiveSnapshot.catalogDigest })
        .from(connectorCatalogActiveSnapshot)
        .where(activeWhere)
        .limit(1);
      if (!active) {
        throw new Error("Expected an active connector catalog test fixture");
      }
      await db
        .update(connectorCatalogActiveSnapshot)
        .set({
          runtimeProjectionVersion: 2,
          runtimeProjectionCatalogDigest: active.catalogDigest,
        })
        .where(activeWhere);
      return;
    }
    case "delete-row": {
      await db
        .delete(connectorCatalogRuntimeProjection)
        .where(
          and(
            projectionWhere,
            eq(
              connectorCatalogRuntimeProjection.connectorRef,
              mutation.connectorRef,
            ),
          ),
        );
      return;
    }
    case "malformed-row": {
      await db
        .update(connectorCatalogRuntimeProjection)
        .set({ connector: { connectorRef: mutation.connectorRef } })
        .where(
          and(
            projectionWhere,
            eq(
              connectorCatalogRuntimeProjection.connectorRef,
              mutation.connectorRef,
            ),
          ),
        );
      return;
    }
    case "digest-mismatch": {
      await db
        .update(connectorCatalogRuntimeProjection)
        .set({ connectorDigest: `sha256:${"0".repeat(64)}` })
        .where(
          and(
            projectionWhere,
            eq(
              connectorCatalogRuntimeProjection.connectorRef,
              mutation.connectorRef,
            ),
          ),
        );
    }
  }
}
