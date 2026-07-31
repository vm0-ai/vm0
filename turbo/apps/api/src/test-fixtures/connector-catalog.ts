import { createHash } from "node:crypto";

import { createStore } from "ccstate";
import { getConnectorAuthProviderRegistrationCapabilities } from "@vm0/connectors/auth-providers";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogSyncState,
} from "@vm0/db/schema/connector-catalog";
import { and, asc, eq, sql } from "drizzle-orm";

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
import { connectorCatalogSource } from "../signals/services/connector-catalog-source";
import {
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidationAuthority,
} from "../signals/services/connector-catalog-validator-authority";
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

const DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION =
  API_TEST_CONNECTOR_CATALOG.catalogVersion;

function apiTestConnectorCatalogKey(catalogVersion: string): string {
  return (
    `connectors/v${String(SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION)}/` +
    `releases/${catalogVersion}/catalog.json`
  );
}

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

export async function installApiTestConnectorCatalog(
  options: { readonly catalogVersion?: string } = {},
): Promise<void> {
  const catalogVersion =
    options.catalogVersion ?? DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION;
  const catalog =
    catalogVersion === DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION
      ? API_TEST_CONNECTOR_CATALOG
      : connectorCatalogArtifactSchema.parse({
          ...API_TEST_CONNECTOR_CATALOG_ARTIFACT,
          catalogVersion,
        });
  validateConnectorCatalogArtifact(catalog);
  const rawBytes = Buffer.from(`${JSON.stringify(catalog)}\n`);
  const catalogDigest = sha256Digest(rawBytes);
  const catalogGzip = encodeConnectorCatalogSnapshot(rawBytes);
  const source = connectorCatalogSource();
  const capability = connectorCatalogExecutableCapabilityState();
  const activatedAt = nowDate();
  const db = store.set(writeDb$);
  const syncStateValues = {
    revision: 1,
    lastObservedCatalogVersion: catalogVersion,
    lastObservedCatalogKey: apiTestConnectorCatalogKey(catalogVersion),
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
    catalogVersion,
    catalogKey: apiTestConnectorCatalogKey(catalogVersion),
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
    await persistConnectorCatalogCompatibility({
      db: tx,
      sourceId: source.sourceId,
      identity: {
        catalogVersion,
        catalogDigest,
      },
      artifact: catalog,
      capability,
      validator: currentConnectorCatalogValidatorIdentity(),
    });
  });
}

interface ApiTestConnectorCatalogIdentity {
  readonly sourceId: string;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
}

async function currentApiTestConnectorCatalogIdentity(): Promise<ApiTestConnectorCatalogIdentity> {
  const sourceId = connectorCatalogSource().sourceId;
  const capabilityDigest = connectorCatalogExecutableCapabilityState().digest;
  const db = store.set(writeDb$);
  const [identity] = await db
    .select({
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
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
  if (identity === undefined) {
    throw new Error("Expected an active API test connector catalog");
  }
  return { sourceId, capabilityDigest, ...identity };
}

function currentApiTestConnectorCatalogCompatibilityWhere(
  identity: ApiTestConnectorCatalogIdentity,
) {
  return and(
    eq(connectorCatalogCompatibilityEvaluation.sourceId, identity.sourceId),
    eq(
      connectorCatalogCompatibilityEvaluation.schemaVersion,
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.catalogVersion,
      identity.catalogVersion,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.catalogDigest,
      identity.catalogDigest,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      identity.capabilityDigest,
    ),
  );
}

function requireSingleCatalogMutation(
  rows: readonly unknown[],
  operation: string,
): void {
  if (rows.length !== 1) {
    throw new Error(
      `Expected ${operation} to affect one connector catalog row`,
    );
  }
}

export function apiTestConnectorCatalogValidationAuthority(): ConnectorCatalogValidationAuthority {
  const validator = currentConnectorCatalogValidatorIdentity();
  return {
    backendVersion: validator.backendVersion,
    buildCommitSha: validator.buildCommitSha,
  };
}

interface ApiTestConnectorCatalogCompatibilityEvaluation {
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
  readonly validationAuthority: ConnectorCatalogValidationAuthority | null;
  readonly evaluatedAt: string;
  readonly payload: unknown;
}

export async function readApiTestConnectorCatalogCompatibilityEvaluations(): Promise<
  readonly ApiTestConnectorCatalogCompatibilityEvaluation[]
> {
  const sourceId = connectorCatalogSource().sourceId;
  const db = store.set(writeDb$);
  const rows = await db
    .select({
      catalogVersion: connectorCatalogCompatibilityEvaluation.catalogVersion,
      catalogDigest: connectorCatalogCompatibilityEvaluation.catalogDigest,
      capabilityDigest:
        connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      catalogValidationBackendVersion:
        connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
      catalogValidationBuildCommitSha:
        connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
      evaluatedAt: connectorCatalogCompatibilityEvaluation.evaluatedAt,
      payload: connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
    })
    .from(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .orderBy(
      asc(connectorCatalogCompatibilityEvaluation.catalogDigest),
      asc(connectorCatalogCompatibilityEvaluation.executableCapabilityDigest),
    );
  return rows.map((row) => {
    return {
      catalogVersion: row.catalogVersion,
      catalogDigest: row.catalogDigest,
      capabilityDigest: row.capabilityDigest,
      validationAuthority:
        row.catalogValidationBackendVersion === null
          ? null
          : {
              backendVersion: row.catalogValidationBackendVersion,
              buildCommitSha: row.catalogValidationBuildCommitSha,
            },
      evaluatedAt: row.evaluatedAt.toISOString(),
      payload: row.payload,
    };
  });
}

export async function readApiTestConnectorCatalogValidationAuthority(): Promise<ConnectorCatalogValidationAuthority | null> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      catalogValidationBackendVersion:
        connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
      catalogValidationBuildCommitSha:
        connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
    })
    .from(connectorCatalogCompatibilityEvaluation)
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .limit(1);
  if (row === undefined) {
    throw new Error(
      "Expected a current API test connector catalog compatibility evaluation",
    );
  }
  return row.catalogValidationBackendVersion === null
    ? null
    : {
        backendVersion: row.catalogValidationBackendVersion,
        buildCommitSha: row.catalogValidationBuildCommitSha,
      };
}

export async function setApiTestConnectorCatalogValidationAuthority(
  authority: ConnectorCatalogValidationAuthority | null,
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const updated = await db
    .update(connectorCatalogCompatibilityEvaluation)
    .set({
      catalogValidationBackendVersion: authority?.backendVersion ?? null,
      catalogValidationBuildCommitSha: authority?.buildCommitSha ?? null,
    })
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(updated, "validation-authority update");
}

export async function replaceApiTestConnectorCatalogStoredBytes(args: {
  readonly catalogVersion: string;
  readonly rawBytes: Uint8Array;
  readonly catalogValidationAuthority: ConnectorCatalogValidationAuthority | null;
  readonly retainCatalogDigest?: boolean;
}): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const rawBytes = Buffer.from(args.rawBytes);
  const catalogDigest =
    args.retainCatalogDigest === true
      ? identity.catalogDigest
      : sha256Digest(rawBytes);
  const db = store.set(writeDb$);
  await db.transaction(async (tx) => {
    const updatedCompatibility = await tx
      .update(connectorCatalogCompatibilityEvaluation)
      .set({
        catalogVersion: args.catalogVersion,
        catalogDigest,
        catalogValidationBackendVersion:
          args.catalogValidationAuthority?.backendVersion ?? null,
        catalogValidationBuildCommitSha:
          args.catalogValidationAuthority?.buildCommitSha ?? null,
      })
      .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
      .returning({
        sourceId: connectorCatalogCompatibilityEvaluation.sourceId,
      });
    requireSingleCatalogMutation(
      updatedCompatibility,
      "stored compatibility replacement",
    );
    const updatedSnapshot = await tx
      .update(connectorCatalogActiveSnapshot)
      .set({
        catalogVersion: args.catalogVersion,
        catalogDigest,
        catalogRawSize: rawBytes.byteLength,
        catalogGzip: encodeConnectorCatalogSnapshot(rawBytes),
      })
      .where(
        and(
          eq(connectorCatalogActiveSnapshot.sourceId, identity.sourceId),
          eq(
            connectorCatalogActiveSnapshot.schemaVersion,
            SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
          ),
        ),
      )
      .returning({ sourceId: connectorCatalogActiveSnapshot.sourceId });
    requireSingleCatalogMutation(
      updatedSnapshot,
      "stored catalog snapshot replacement",
    );
  });
}

export async function invalidateApiTestConnectorCatalogCompatibility(): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const updated = await db
    .update(connectorCatalogCompatibilityEvaluation)
    .set({
      filteredAuthMethods: {
        filteredAuthMethods: [
          {
            connectorSlug: "external-test",
            authMethodId: "api-token",
            reasons: [],
          },
        ],
      },
    })
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(updated, "compatibility corruption");
}

export async function insertApiTestLegacyConnectorCatalogCompatibilityEvaluation(
  capabilityDigest: string,
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const validator = currentConnectorCatalogValidatorIdentity();
  const evaluatedAt = nowDate();
  const legacyPayload = JSON.stringify([
    {
      connectorRef: "external-test",
      authMethodId: "api-token",
      reasons: ["missing-grant-provider"],
    },
  ]);
  const db = store.set(writeDb$);
  await db.execute(sql`
    INSERT INTO ${connectorCatalogCompatibilityEvaluation} (
      "source_id",
      "schema_version",
      "catalog_version",
      "catalog_digest",
      "executable_capability_digest",
      "catalog_validation_backend_version",
      "catalog_validation_build_commit_sha",
      "evaluated_at",
      "filtered_auth_methods"
    ) VALUES (
      ${identity.sourceId},
      ${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION},
      ${identity.catalogVersion},
      ${identity.catalogDigest},
      ${capabilityDigest},
      ${validator.backendVersion},
      ${validator.buildCommitSha},
      ${evaluatedAt},
      ${legacyPayload}::jsonb
    )
  `);
}

export async function deleteApiTestConnectorCatalogCompatibility(): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const deleted = await db
    .delete(connectorCatalogCompatibilityEvaluation)
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(deleted, "compatibility deletion");
}

export async function deleteApiTestConnectorCatalogCompatibilityEvaluation(
  capabilityDigest: string,
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const deleted = await db
    .delete(connectorCatalogCompatibilityEvaluation)
    .where(
      currentApiTestConnectorCatalogCompatibilityWhere({
        ...identity,
        capabilityDigest,
      }),
    )
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(deleted, "compatibility evaluation deletion");
}
