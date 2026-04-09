import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { VOLUME_ORG_USER_ID, SYSTEM_ORG_ID } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import { skills } from "../../db/schema/skill";
import { zeroAgents } from "../../db/schema/zero-agent";
import { storages, storageVersions } from "../../db/schema/storage";
import { buildSeedSkillValues } from "../../lib/zero/seed-skills";

/**
 * Seed a skill record in the skills table for testing.
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
 * Find a skill by its canonical URL.
 */
export async function findTestSkillByUrl(url: string) {
  const [skill] = await globalThis.services.db
    .select()
    .from(skills)
    .where(eq(skills.url, url))
    .limit(1);
  return skill ?? null;
}

/**
 * Bind an existing custom skill to an agent by updating its customSkills array.
 * Used for testing multi-agent skill sharing.
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
 * Get the customSkills array for a given agent.
 */
export async function getAgentCustomSkills(agentId: string): Promise<string[]> {
  initServices();
  const [agent] = await globalThis.services.db
    .select({ customSkills: zeroAgents.customSkills })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  return agent.customSkills;
}
