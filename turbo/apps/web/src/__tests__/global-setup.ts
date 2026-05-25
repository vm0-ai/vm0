/**
 * Vitest globalSetup — runs once before all test workers in a separate process.
 *
 * Seeds the skills + storage volumes tables so that every test file starts
 * with a pre-populated DB.  Because this runs in its own process it cannot
 * pollute module-level singletons (e.g. Stripe) in the test workers.
 *
 * Note: this file cannot use env() from src/env.ts because globalSetup runs
 * outside the vitest worker context where env stubs are applied. It reads
 * DATABASE_URL directly from the environment instead.
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "@vm0/db";
import { skills } from "@vm0/db/schema/skill";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { buildSeedSkillValues } from "./db-test-seeders/seed-skill-values";
import { getEligibleConnectorTypes } from "@vm0/connectors/connector-utils";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";

export async function setup() {
  console.log("[globalSetup] Seeding skill data…");
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

    const rows = await db.select({ count: sql<number>`count(*)` }).from(skills);
    const seedCount = rows[0]?.count ?? 0;
    const samples = await db.select({ url: skills.url }).from(skills).limit(1);
    console.log(
      `[globalSetup] Skills seeded: ${seedCount} rows, ${allNames.length} names, sample url: ${samples[0]?.url}`,
    );

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
          entries.map(({ storageName }) => {
            return {
              orgId: SYSTEM_ORG_ID,
              userId: VOLUME_ORG_USER_ID,
              name: storageName,
              type: "volume" as const,
              s3Prefix: `${SYSTEM_ORG_ID}/${storageName}`,
            };
          }),
        )
        .onConflictDoNothing()
        .returning({ id: storages.id, name: storages.name });

      if (inserted.length === 0) return;

      const nameToId = new Map(
        inserted.map((s) => {
          return [s.name, s.id];
        }),
      );
      const newEntries = entries.filter(({ storageName }) => {
        return nameToId.has(storageName);
      });

      await tx.insert(storageVersions).values(
        newEntries.map(({ storageName, versionId }) => {
          return {
            id: versionId,
            storageId: nameToId.get(storageName)!,
            s3Key: `${SYSTEM_ORG_ID}/${storageName}/${versionId}`,
            size: 100,
            fileCount: 1,
            createdBy: "test",
          };
        }),
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
  console.log("[globalSetup] Skill data seeded.");
}
