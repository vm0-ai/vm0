import { testCustomConnectorSkillCleanupStateContract } from "@vm0/api-contracts/contracts/test-custom-connector-skill-cleanup-state";
import {
  getCustomConnectorSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import {
  customConnectorSkillPublications,
  deletedCustomConnectorSkillStorages,
} from "@vm0/db/schema/custom-connector-skill-cleanup";
import { storages } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { and, asc, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(
  testCustomConnectorSkillCleanupStateContract.action,
);

async function findSkillStorage(
  db: Db,
  args: { readonly orgId: string; readonly connectorId: string },
) {
  const [storage] = await db
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getCustomConnectorSkillStorageName(args.connectorId)),
      ),
    )
    .limit(1);
  return storage ?? null;
}

// Publication claims and tombstones have no production read surface, and the
// destructive cleanup route that will create claims intentionally belongs to
// #26366. This guarded fixture exposes only the state needed to prove the writer
// protocol without replacing production connector routes as the test boundary.
const action$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const bodyResult = await get(actionBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const db = set(writeDb$);
  const storage = await findSkillStorage(db, bodyResult.data);
  signal.throwIfAborted();
  if (bodyResult.data.action === "claim") {
    if (!storage) {
      return {
        status: 200 as const,
        body: { action: "claim" as const, claimed: false },
      };
    }
    const [claimed] = await db
      .update(customConnectorSkillPublications)
      .set({ state: "cleanup_claimed", stateUpdatedAt: nowDate() })
      .where(
        and(
          eq(
            customConnectorSkillPublications.versionId,
            bodyResult.data.versionId,
          ),
          eq(customConnectorSkillPublications.storageId, storage.id),
          eq(customConnectorSkillPublications.s3Prefix, storage.s3Prefix),
          eq(customConnectorSkillPublications.state, "preparing"),
        ),
      )
      .returning({ versionId: customConnectorSkillPublications.versionId });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { action: "claim" as const, claimed: !!claimed },
    };
  }

  const publications = storage
    ? await db
        .select({
          versionId: customConnectorSkillPublications.versionId,
          storageId: customConnectorSkillPublications.storageId,
          s3Prefix: customConnectorSkillPublications.s3Prefix,
          state: customConnectorSkillPublications.state,
          stateUpdatedAt: customConnectorSkillPublications.stateUpdatedAt,
        })
        .from(customConnectorSkillPublications)
        .where(eq(customConnectorSkillPublications.storageId, storage.id))
        .orderBy(asc(customConnectorSkillPublications.versionId))
    : [];
  const [tombstone] = await db
    .select({
      storageId: deletedCustomConnectorSkillStorages.storageId,
      connectorId: deletedCustomConnectorSkillStorages.connectorId,
      s3Prefix: deletedCustomConnectorSkillStorages.s3Prefix,
      deletedAt: deletedCustomConnectorSkillStorages.deletedAt,
    })
    .from(deletedCustomConnectorSkillStorages)
    .where(
      eq(
        deletedCustomConnectorSkillStorages.connectorId,
        bodyResult.data.connectorId,
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      action: "read" as const,
      storage,
      publications: publications.map((publication) => {
        return {
          ...publication,
          stateUpdatedAt: publication.stateUpdatedAt.toISOString(),
        };
      }),
      tombstone: tombstone
        ? { ...tombstone, deletedAt: tombstone.deletedAt.toISOString() }
        : null,
    },
  };
});

export const testCustomConnectorSkillCleanupStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testCustomConnectorSkillCleanupStateContract.action,
      handler: action$,
    },
  ];
