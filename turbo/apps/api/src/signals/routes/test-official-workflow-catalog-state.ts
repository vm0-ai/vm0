import {
  testOfficialWorkflowCatalogStateContract,
  type TestOfficialWorkflowCatalogStateActionBody,
} from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, count, eq, like } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  readAcceptedOfficialWorkflowCatalog,
  readAcceptedOfficialWorkflowDefinition,
  readAcceptedOfficialWorkflowRevision,
} from "../services/official-workflow-catalog-read.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(
  testOfficialWorkflowCatalogStateContract.action,
);
const TEST_STORAGE_NAME_PATTERN = "official-workflow@api-test-%";

type ReadAction = Extract<
  TestOfficialWorkflowCatalogStateActionBody,
  { readonly action: "read" }
>;

async function cleanupTestState(db: Db, signal: AbortSignal): Promise<void> {
  // This route is test-only; clearing the singleton projection is the only way
  // to exercise independent initial-release scenarios through the public sync
  // boundary without importing database helpers into route tests.
  await db.delete(officialWorkflowCatalogState);
  await db.delete(officialWorkflowCatalogReleases);
  await db.delete(officialWorkflowDefinitionRevisions);
  await db
    .delete(storages)
    .where(
      and(
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        like(storages.name, TEST_STORAGE_NAME_PATTERN),
      ),
    );
  signal.throwIfAborted();
}

async function catalogCounts(db: Db, signal: AbortSignal) {
  const [[releaseCount], [revisionCount], [storageCount], [versionCount]] =
    await Promise.all([
      db.select({ value: count() }).from(officialWorkflowCatalogReleases),
      db.select({ value: count() }).from(officialWorkflowDefinitionRevisions),
      db
        .select({ value: count() })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, SYSTEM_ORG_ID),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            like(storages.name, TEST_STORAGE_NAME_PATTERN),
          ),
        ),
      db
        .select({ value: count() })
        .from(storageVersions)
        .innerJoin(storages, eq(storages.id, storageVersions.storageId))
        .where(
          and(
            eq(storages.orgId, SYSTEM_ORG_ID),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            like(storages.name, TEST_STORAGE_NAME_PATTERN),
          ),
        ),
    ]);
  signal.throwIfAborted();
  if (!releaseCount || !revisionCount || !storageCount || !versionCount) {
    throw new Error("Official Workflow catalog test counts are incomplete");
  }
  return {
    releases: releaseCount.value,
    revisions: revisionCount.value,
    storages: storageCount.value,
    storageVersions: versionCount.value,
  };
}

async function readStorageState(
  db: Db,
  definitionName: string | undefined,
  signal: AbortSignal,
) {
  if (definitionName === undefined) {
    return null;
  }
  const [row] = await db
    .select({
      storageName: storages.name,
      storageId: storages.id,
      orgId: storages.orgId,
      userId: storages.userId,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, `official-workflow@${definitionName}`),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row) {
    return null;
  }
  const [versionCount] = await db
    .select({ value: count() })
    .from(storageVersions)
    .where(eq(storageVersions.storageId, row.storageId));
  signal.throwIfAborted();
  if (!versionCount) {
    throw new Error("Official Workflow catalog storage count is incomplete");
  }
  return {
    ...row,
    versionCount: versionCount.value,
  };
}

async function stateResponse(
  db: Db,
  body: ReadAction | undefined,
  signal: AbortSignal,
) {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  const definition = body?.definitionName
    ? await readAcceptedOfficialWorkflowDefinition(
        db,
        body.definitionName,
        signal,
      )
    : null;
  const revision =
    body?.definitionName && body.revision
      ? await readAcceptedOfficialWorkflowRevision(
          db,
          { name: body.definitionName, revision: body.revision },
          signal,
        )
      : null;
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      catalog,
      definition,
      revision,
      storage: await readStorageState(db, body?.definitionName, signal),
      counts: await catalogCounts(db, signal),
    },
  };
}

const officialWorkflowCatalogTestStateRoute$ = command(
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
    if (bodyResult.data.action === "cleanup") {
      await cleanupTestState(db, signal);
      return await stateResponse(db, undefined, signal);
    }
    return await stateResponse(db, bodyResult.data, signal);
  },
);

export const testOfficialWorkflowCatalogStateRoutes: readonly RouteEntry[] = [
  {
    route: testOfficialWorkflowCatalogStateContract.action,
    handler: officialWorkflowCatalogTestStateRoute$,
  },
];
