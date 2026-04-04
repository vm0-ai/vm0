/**
 * Vitest globalSetup — runs once before all test workers in a separate process.
 *
 * Seeds the skills + storage volumes tables so that every test file starts
 * with a pre-populated DB.  Because this runs in its own process it cannot
 * pollute module-level singletons (e.g. Stripe) in the test workers.
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../db/db";
import { skills } from "../db/schema/skill";
import { storages, storageVersions } from "../db/schema/storage";
import { SEED_SKILLS, buildSeedSkillValues } from "../lib/zero/seed-skills";
import {
  getEligibleConnectorTypes,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@vm0/core";

export async function setup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  try {
    const allNames = [
      ...new Set([...SEED_SKILLS, ...getEligibleConnectorTypes()]),
    ];

    // 1. Seed skills
    await db
      .insert(skills)
      .values(buildSeedSkillValues(allNames))
      .onConflictDoNothing();

    // 2. Seed storage volumes
    const entries = allNames.map((name) => {
      const fullPath = `vm0-ai/vm0-skills/tree/main/${name}`;
      const storageName = `agent-skills@${fullPath}`;
      const versionId = randomUUID().replace(/-/g, "").repeat(2).slice(0, 64);
      return { storageName, versionId };
    });

    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(storages)
        .values(
          entries.map(({ storageName }) => ({
            orgId: SYSTEM_ORG_ID,
            userId: VOLUME_ORG_USER_ID,
            name: storageName,
            type: "volume" as const,
            s3Prefix: `${SYSTEM_ORG_ID}/${storageName}`,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: storages.id, name: storages.name });

      if (inserted.length === 0) return;

      const nameToId = new Map(inserted.map((s) => [s.name, s.id]));
      const newEntries = entries.filter(({ storageName }) =>
        nameToId.has(storageName),
      );

      await tx.insert(storageVersions).values(
        newEntries.map(({ storageName, versionId }) => ({
          id: versionId,
          storageId: nameToId.get(storageName)!,
          s3Key: `${SYSTEM_ORG_ID}/${storageName}/${versionId}`,
          size: 100,
          fileCount: 1,
          createdBy: "test",
        })),
      );

      for (const { storageName, versionId } of newEntries) {
        await tx
          .update(storages)
          .set({ headVersionId: versionId })
          .where(eq(storages.id, nameToId.get(storageName)!));
      }
    });
  } finally {
    await pool.end();
  }
}
