import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { VOLUME_ORG_USER_ID, SYSTEM_ORG_ID } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import { skills } from "../../db/schema/skill";
import { zeroAgents } from "../../db/schema/zero-agent";
import { zeroSkills } from "../../db/schema/zero-skill";
import { storages, storageVersions } from "../../db/schema/storage";
import { buildSeedSkillValues } from "../../lib/zero/seed-skills";

// ---------------------------------------------------------------------------
// DB-direct seeders for skill test setup.
//
// Each function has a @why-db-direct annotation explaining why it cannot be
// replaced by an API call.
// ---------------------------------------------------------------------------

/**
 * Seed a skill record in the skills table for testing.
 *
 * @why-db-direct Skills are reference data seeded via database migrations and
 * the sync-skills cron. No user-facing API creates individual skill records.
 */
export async function seedTestSkill(
  overrides: Partial<typeof skills.$inferInsert> = {},
) {
  initServices();
  const [row] = await globalThis.services.db
    .insert(skills)
    .values({
      url: "https://github.com/vm0-ai/vm0-skills/tree/main/slack",
      name: "slack",
      fullPath: "vm0-ai/vm0-skills/tree/main/slack",
      versionHash:
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      frontmatter: {
        name: "Slack",
        description: "Slack integration",
      },
      ...overrides,
    })
    .returning();
  return row;
}

/**
 * Re-seed specific skill names plus their storage volumes.
 * Used to restore skills + storages removed by orphan-deletion in tests.
 *
 * @why-db-direct Re-inserts skills and storage volumes removed by
 * orphan-deletion tests. No API restores deleted seed data.
 */
export async function reseedSkills(names: readonly string[]): Promise<void> {
  initServices();
  const db = globalThis.services.db;

  // 1. Re-insert skill rows
  await db
    .insert(skills)
    .values(buildSeedSkillValues(names))
    .onConflictDoNothing();

  // 2. Re-insert storage volumes + versions
  const entries = names.map((name) => {
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
}

/**
 * Set the commit SHA for all seeded skill rows.
 * Used by sync-skills route tests to force the freshness-check fast path.
 *
 * @why-db-direct The route's skip path depends on persisted skill metadata.
 * No API exists to mutate commit SHA for system-seeded skills in tests.
 */
export async function setAllTestSkillsCommitSha(
  commitSha: string,
): Promise<void> {
  initServices();
  await globalThis.services.db.update(skills).set({ commitSha });
}

/**
 * Bind an existing custom skill to an agent by updating its customSkills array.
 * Used for testing multi-agent skill sharing.
 *
 * @why-db-direct Binding a custom skill via the skills API requires
 * authenticated user context (Clerk session + org membership) that test
 * setup cannot easily provide. Direct DB update is the only practical path.
 */
export async function bindCustomSkillToAgent(
  agentId: string,
  skillName: string,
): Promise<void> {
  initServices();
  const [agent] = await globalThis.services.db
    .select({ customSkills: zeroAgents.customSkills })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  const updated = [...agent.customSkills, skillName];
  await globalThis.services.db
    .update(zeroAgents)
    .set({ customSkills: updated })
    .where(eq(zeroAgents.id, agentId));
}

/**
 * Create a custom skill record in the zero_skills table for testing.
 *
 * @why-db-direct Creating zero_skills via the skills API requires
 * authenticated user context (Clerk session + org membership) that test
 * setup cannot easily provide. Direct DB insert is the only practical path.
 */
export async function createTestZeroSkill(
  orgId: string,
  name: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(zeroSkills)
    .values({
      orgId,
      name,
      createdBy: "test",
    })
    .onConflictDoNothing();
}
