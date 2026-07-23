import { command } from "ccstate";
import {
  testConnectorCatalogStateContract,
  type TestConnectorCatalogStateActionBody,
} from "@vm0/api-contracts/contracts/test-connector-catalog-state";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogSyncState,
} from "@vm0/db/schema/connector-catalog";
import { and, eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { connectorCatalogSource } from "../services/connector-catalog-source";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testConnectorCatalogStateContract.action);

type ConnectorCatalogStateAction<
  TAction extends TestConnectorCatalogStateActionBody["action"],
> = Extract<TestConnectorCatalogStateActionBody, { action: TAction }>;

function sourceIdentity(sourceId: string) {
  return and(
    eq(connectorCatalogSyncState.sourceId, sourceId),
    eq(connectorCatalogSyncState.schemaVersion, 1),
  );
}

async function deleteState(db: Db, sourceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(connectorCatalogCompatibilityEvaluation)
      .where(
        and(
          eq(connectorCatalogCompatibilityEvaluation.sourceId, sourceId),
          eq(connectorCatalogCompatibilityEvaluation.schemaVersion, 1),
        ),
      );
    await tx
      .delete(connectorCatalogActiveSnapshot)
      .where(
        and(
          eq(connectorCatalogActiveSnapshot.sourceId, sourceId),
          eq(connectorCatalogActiveSnapshot.schemaVersion, 1),
        ),
      );
    await tx.delete(connectorCatalogSyncState).where(sourceIdentity(sourceId));
  });
}

async function seedLegacyActive(
  db: Db,
  body: ConnectorCatalogStateAction<"seed-legacy-active">,
): Promise<string> {
  const sourceId = connectorCatalogSource().sourceId;
  const activatedAt = new Date(body.activated_at);
  await db.transaction(async (tx) => {
    await tx.insert(connectorCatalogSyncState).values({
      sourceId,
      schemaVersion: 1,
      revision: 1,
      lastObservedCatalogVersion: body.catalog_version,
      lastObservedIntegrityDigest: body.catalog_digest,
      lastAttemptAt: activatedAt,
      lastAttemptOutcome: "accepted",
      lastSuccessAt: activatedAt,
    });
    await tx.insert(connectorCatalogActiveSnapshot).values({
      sourceId,
      schemaVersion: 1,
      catalogVersion: body.catalog_version,
      integrityDigest: body.catalog_digest,
      publicCatalogDigest: body.catalog_digest,
      privateCatalogDigest: body.catalog_digest,
      privateFirewallsDigest: body.catalog_digest,
      runnerFirewallsDigest: body.catalog_digest,
      publicCatalog: "{}",
      privateCatalog: "{}",
      privateFirewalls: "{}",
      runnerFirewalls: "{}",
      activatedAt,
    });
  });
  return sourceId;
}

const mutateConnectorCatalogState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    const sourceId =
      body.action === "seed-legacy-active"
        ? await seedLegacyActive(db, body)
        : body.source_id;
    if (body.action === "delete") {
      await deleteState(db, sourceId);
    }
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { ok: true as const, source_id: sourceId },
    };
  },
);

export const testConnectorCatalogStateRoutes: readonly RouteEntry[] = [
  {
    route: testConnectorCatalogStateContract.action,
    handler: mutateConnectorCatalogState$,
  },
];
