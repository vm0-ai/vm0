import { randomUUID } from "node:crypto";

import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";
import { command } from "ccstate";
import {
  testMemoryStateContract,
  type TestMemoryStateActionBody,
} from "@vm0/api-contracts/contracts/test-memory-state";
import {
  memoryChangeItems,
  type MemoryChangeDiff,
} from "@vm0/db/schema/memory-change-item";
import { memoryChangeSummaries } from "@vm0/db/schema/memory-change-summary";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { storageVersions, storages } from "@vm0/db/schema/storage";
import { and, asc, eq } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testMemoryStateContract.action);

type MemoryAction<TAction extends TestMemoryStateActionBody["action"]> =
  Extract<TestMemoryStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function emptyMemoryChangeDiff(): MemoryChangeDiff {
  return {
    format: "line",
    beforeExists: true,
    afterExists: true,
    truncated: false,
    stats: { added: 0, removed: 0 },
    hunks: [],
  };
}

function summaryToWire(row: typeof memoryChangeSummaries.$inferSelect) {
  return {
    id: row.id,
    date: row.date,
    from_version_id: row.fromVersionId,
    to_version_id: row.toVersionId,
    summary: row.summary,
  };
}

async function seedFixtureForAction(db: Db, signal: AbortSignal) {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await db.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });
  signal.throwIfAborted();

  return actionOk({ fixture: { org_id: orgId, user_id: userId } });
}

async function deleteFixtureForAction(
  db: Db,
  body: MemoryAction<"delete-fixture">,
  signal: AbortSignal,
) {
  await db.delete(storages).where(eq(storages.orgId, body.fixture.org_id));
  signal.throwIfAborted();
  await db
    .delete(memoryChangeSummaries)
    .where(eq(memoryChangeSummaries.orgId, body.fixture.org_id));
  signal.throwIfAborted();
  await db
    .delete(orgMetadata)
    .where(eq(orgMetadata.orgId, body.fixture.org_id));
  signal.throwIfAborted();
  return actionOk();
}

async function seedActivitySummaryForAction(
  db: Db,
  body: MemoryAction<"seed-activity-summary">,
  signal: AbortSignal,
) {
  const summaryId = randomUUID();
  await db.insert(memoryChangeSummaries).values({
    id: summaryId,
    orgId: body.org_id,
    userId: body.user_id,
    date: body.date,
    fromVersionId: body.from_version_id ?? null,
    toVersionId: body.to_version_id,
    summary: body.summary ?? null,
  });
  signal.throwIfAborted();

  const items = body.items ?? [];
  if (items.length > 0) {
    await db.insert(memoryChangeItems).values(
      items.map((item) => {
        return {
          summaryId,
          filePath: item.file_path,
          diff: (item.diff ?? emptyMemoryChangeDiff()) as MemoryChangeDiff,
        };
      }),
    );
    signal.throwIfAborted();
  }

  return actionOk({ summary_id: summaryId });
}

async function seedStorageForAction(
  db: Db,
  body: MemoryAction<"seed-storage">,
  signal: AbortSignal,
) {
  const storageId = randomUUID();
  const name = body.name ?? MEMORY_ARTIFACT_NAME;

  await db.insert(storages).values({
    id: storageId,
    userId: body.user_id,
    name,
    type: body.type ?? "artifact",
    orgId: body.org_id,
    s3Prefix: `orgs/${body.org_id}/users/${body.user_id}/${name}`,
    size: body.size ?? 0,
    fileCount: body.file_count ?? 0,
    updatedAt: body.updated_at
      ? new Date(body.updated_at)
      : new Date("2025-01-01T00:00:00.000Z"),
  });
  signal.throwIfAborted();

  if (body.head_version_id === null) {
    return actionOk({ storage_id: storageId, head_version_id: null });
  }

  const headVersionId = body.head_version_id ?? `head-${randomUUID()}`;
  await db.insert(storageVersions).values({
    id: headVersionId,
    storageId,
    s3Key: body.s3_key,
    size: body.size ?? 0,
    fileCount: body.file_count ?? 0,
    createdBy: body.user_id,
  });
  signal.throwIfAborted();

  await db
    .update(storages)
    .set({ headVersionId })
    .where(eq(storages.id, storageId));
  signal.throwIfAborted();

  return actionOk({ storage_id: storageId, head_version_id: headVersionId });
}

async function seedVersionForAction(
  db: Db,
  body: MemoryAction<"seed-version">,
  signal: AbortSignal,
) {
  await db.insert(storageVersions).values({
    id: body.version_id,
    storageId: body.storage_id,
    s3Key: body.s3_key,
    createdBy: body.user_id,
    createdAt: new Date(body.created_at),
  });
  signal.throwIfAborted();
  return actionOk();
}

async function updateVersionCreatedAtForAction(
  db: Db,
  body: MemoryAction<"update-version-created-at">,
  signal: AbortSignal,
) {
  await db
    .update(storageVersions)
    .set({ createdAt: new Date(body.created_at) })
    .where(eq(storageVersions.id, body.version_id));
  signal.throwIfAborted();
  return actionOk();
}

async function readStorageIdForAction(
  db: Db,
  body: MemoryAction<"read-storage-id">,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({ id: storages.id })
    .from(storages)
    .where(eq(storages.orgId, body.org_id))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ storage_id: row?.id });
}

async function readSummaryForAction(
  db: Db,
  body: MemoryAction<"read-summary">,
  signal: AbortSignal,
) {
  const [row] = await db
    .select()
    .from(memoryChangeSummaries)
    .where(
      and(
        eq(memoryChangeSummaries.orgId, body.org_id),
        eq(memoryChangeSummaries.userId, body.user_id),
        eq(memoryChangeSummaries.date, body.date),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ summary: row ? summaryToWire(row) : null });
}

async function readSummariesForAction(
  db: Db,
  body: MemoryAction<"read-summaries">,
  signal: AbortSignal,
) {
  const rows = await db
    .select()
    .from(memoryChangeSummaries)
    .where(
      and(
        eq(memoryChangeSummaries.orgId, body.org_id),
        eq(memoryChangeSummaries.userId, body.user_id),
      ),
    )
    .orderBy(asc(memoryChangeSummaries.date));
  signal.throwIfAborted();
  return actionOk({ summaries: rows.map(summaryToWire) });
}

async function readItemsForAction(
  db: Db,
  body: MemoryAction<"read-items">,
  signal: AbortSignal,
) {
  const rows = await db
    .select({ filePath: memoryChangeItems.filePath })
    .from(memoryChangeItems)
    .where(eq(memoryChangeItems.summaryId, body.summary_id))
    .orderBy(asc(memoryChangeItems.filePath));
  signal.throwIfAborted();
  return actionOk({
    file_paths: rows.map((row) => {
      return row.filePath;
    }),
  });
}

const mutateMemoryState$ = command(
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
    switch (body.action) {
      case "seed-fixture": {
        return await seedFixtureForAction(db, signal);
      }
      case "delete-fixture": {
        return await deleteFixtureForAction(db, body, signal);
      }
      case "seed-activity-summary": {
        return await seedActivitySummaryForAction(db, body, signal);
      }
      case "seed-storage": {
        return await seedStorageForAction(db, body, signal);
      }
      case "seed-version": {
        return await seedVersionForAction(db, body, signal);
      }
      case "update-version-created-at": {
        return await updateVersionCreatedAtForAction(db, body, signal);
      }
      case "read-storage-id": {
        return await readStorageIdForAction(db, body, signal);
      }
      case "read-summary": {
        return await readSummaryForAction(db, body, signal);
      }
      case "read-summaries": {
        return await readSummariesForAction(db, body, signal);
      }
      case "read-items": {
        return await readItemsForAction(db, body, signal);
      }
    }
  },
);

export const testMemoryStateRoutes: readonly RouteEntry[] = [
  {
    route: testMemoryStateContract.action,
    handler: mutateMemoryState$,
  },
];
