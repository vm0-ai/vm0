import { command } from "ccstate";
import {
  testCronSyncSkillsStateContract,
  type TestCronSyncSkillsStateActionBody,
  type TestCronSyncSkillsStateSkillVersionSeed,
} from "@vm0/api-contracts/contracts/test-cron-sync-skills-state";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { skills } from "@vm0/db/schema/skill";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { eq, inArray, like, sql } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testCronSyncSkillsStateContract.action);

type CronSyncSkillsAction<
  TAction extends TestCronSyncSkillsStateActionBody["action"],
> = Extract<TestCronSyncSkillsStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

async function cleanupOfficialTestSkillsForAction(
  db: Db,
  body: CronSyncSkillsAction<"cleanup-official-test-skills">,
  signal: AbortSignal,
) {
  const skillRows = await db
    .select({ id: skills.id, storageId: skills.storageId })
    .from(skills)
    .where(like(skills.url, `${body.url_prefix}%`));
  signal.throwIfAborted();

  if (skillRows.length === 0) {
    return actionOk();
  }

  const skillIds = skillRows.map((row) => {
    return row.id;
  });
  const storageIds = skillRows
    .map((row) => {
      return row.storageId;
    })
    .filter((id): id is string => {
      return id !== null;
    });

  await db.delete(skills).where(inArray(skills.id, skillIds));
  signal.throwIfAborted();
  if (storageIds.length > 0) {
    await db.delete(storages).where(inArray(storages.id, storageIds));
    signal.throwIfAborted();
  }
  return actionOk();
}

async function setAllSkillsCommitShaForAction(
  db: Db,
  body: CronSyncSkillsAction<"set-all-skills-commit-sha">,
  signal: AbortSignal,
) {
  await db
    .insert(skills)
    .values({
      url: body.url,
      name: body.skill_name,
      fullPath: body.full_path,
      commitSha: body.commit_sha,
      frontmatter: body.frontmatter,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();

  await db.update(skills).set({ commitSha: body.commit_sha });
  signal.throwIfAborted();
  return actionOk();
}

async function seedStorageRows(
  db: Db,
  versions: readonly TestCronSyncSkillsStateSkillVersionSeed[],
) {
  const storageRows = await db
    .insert(storages)
    .values(
      versions.map((version) => {
        return {
          orgId: SYSTEM_ORG_ID,
          userId: VOLUME_ORG_USER_ID,
          name: version.storage_name,
          type: "volume",
          s3Prefix: version.s3_prefix,
          size: version.size,
          fileCount: version.file_count,
        };
      }),
    )
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name, storages.type],
      set: {
        s3Prefix: sql`excluded.s3_prefix`,
        size: sql`excluded.size`,
        fileCount: sql`excluded.file_count`,
      },
    })
    .returning({ id: storages.id, name: storages.name });

  return new Map(
    storageRows.map((row) => {
      return [row.name, row.id];
    }),
  );
}

async function seedCurrentSkillVersionsForAction(
  db: Db,
  body: CronSyncSkillsAction<"seed-current-skill-versions">,
  signal: AbortSignal,
) {
  if (body.versions.length === 0) {
    return actionOk();
  }

  const storageIdsByName = await seedStorageRows(db, body.versions);
  signal.throwIfAborted();

  await db
    .insert(storageVersions)
    .values(
      body.versions.map((version) => {
        const storageId = storageIdsByName.get(version.storage_name);
        if (!storageId) {
          throw new Error(`Missing storage for ${version.name}`);
        }
        return {
          id: version.version_hash,
          storageId,
          s3Key: version.s3_key,
          size: version.size,
          fileCount: version.file_count,
          message: "Preseeded by cron sync skills route test",
          createdBy: "system",
        };
      }),
    )
    .onConflictDoUpdate({
      target: storageVersions.id,
      set: {
        storageId: sql`excluded.storage_id`,
        s3Key: sql`excluded.s3_key`,
        size: sql`excluded.size`,
        fileCount: sql`excluded.file_count`,
      },
    });
  signal.throwIfAborted();

  await Promise.all(
    body.versions.map((version) => {
      const storageId = storageIdsByName.get(version.storage_name);
      if (!storageId) {
        throw new Error(`Missing storage for ${version.name}`);
      }
      return db
        .update(storages)
        .set({ headVersionId: version.version_hash })
        .where(eq(storages.id, storageId));
    }),
  );
  signal.throwIfAborted();

  await db
    .insert(skills)
    .values(
      body.versions.map((version) => {
        const storageId = storageIdsByName.get(version.storage_name);
        if (!storageId) {
          throw new Error(`Missing storage for ${version.name}`);
        }
        return {
          url: version.url,
          name: version.name,
          fullPath: version.full_path,
          storageId,
          versionHash: version.version_hash,
          commitSha: body.stale_commit_sha,
          frontmatter: version.frontmatter,
          s3Key: version.s3_key,
          size: version.size,
          fileCount: version.file_count,
        };
      }),
    )
    .onConflictDoUpdate({
      target: skills.url,
      set: {
        name: sql`excluded.name`,
        fullPath: sql`excluded.full_path`,
        storageId: sql`excluded.storage_id`,
        versionHash: sql`excluded.version_hash`,
        commitSha: sql`excluded.commit_sha`,
        frontmatter: sql`excluded.frontmatter`,
        s3Key: sql`excluded.s3_key`,
        size: sql`excluded.size`,
        fileCount: sql`excluded.file_count`,
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function readSkillByUrlForAction(
  db: Db,
  body: CronSyncSkillsAction<"read-skill-by-url">,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({
      fullPath: skills.fullPath,
      commitSha: skills.commitSha,
      versionHash: skills.versionHash,
      fileCount: skills.fileCount,
      frontmatter: skills.frontmatter,
    })
    .from(skills)
    .where(eq(skills.url, body.url))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    skill: row
      ? {
          full_path: row.fullPath,
          commit_sha: row.commitSha,
          version_hash: row.versionHash,
          file_count: row.fileCount,
          frontmatter: row.frontmatter,
        }
      : null,
  });
}

async function readStorageByNameForAction(
  db: Db,
  body: CronSyncSkillsAction<"read-storage-by-name">,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({
      type: storages.type,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(eq(storages.name, body.name))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    storage: row
      ? { type: row.type, head_version_id: row.headVersionId }
      : null,
  });
}

const mutateCronSyncSkillsState$ = command(
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
      case "cleanup-official-test-skills": {
        return await cleanupOfficialTestSkillsForAction(db, body, signal);
      }
      case "set-all-skills-commit-sha": {
        return await setAllSkillsCommitShaForAction(db, body, signal);
      }
      case "seed-current-skill-versions": {
        return await seedCurrentSkillVersionsForAction(db, body, signal);
      }
      case "read-skill-by-url": {
        return await readSkillByUrlForAction(db, body, signal);
      }
      case "read-storage-by-name": {
        return await readStorageByNameForAction(db, body, signal);
      }
    }
  },
);

export const testCronSyncSkillsStateRoutes: readonly RouteEntry[] = [
  {
    route: testCronSyncSkillsStateContract.action,
    handler: mutateCronSyncSkillsState$,
  },
];
