import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { db, uniqueId } from "../test-db";

async function runRename(orgId: string, userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE user_feature_switches
    SET switches = (switches - 'skillsViewer' - 'chatSlashSkillCommands')
                || CASE
                     WHEN switches ? 'skillsViewer'
                       AND NOT (switches ? 'workflowsViewer')
                     THEN jsonb_build_object('workflowsViewer', switches->'skillsViewer')
                     ELSE '{}'::jsonb
                   END
                || CASE
                     WHEN switches ? 'chatSlashSkillCommands'
                       AND NOT (switches ? 'chatSlashWorkflowCommands')
                     THEN jsonb_build_object('chatSlashWorkflowCommands', switches->'chatSlashSkillCommands')
                     ELSE '{}'::jsonb
                   END,
        updated_at = NOW()
    WHERE (switches ? 'skillsViewer'
       OR switches ? 'chatSlashSkillCommands')
      AND org_id = ${orgId}
      AND user_id = ${userId}
  `);
}

async function readSwitches(
  orgId: string,
  userId: string,
): Promise<Record<string, boolean> | undefined> {
  const [row] = await db
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, userId),
      ),
    )
    .limit(1);
  return row?.switches;
}

async function seed(
  orgId: string,
  userId: string,
  switches: Record<string, boolean>,
): Promise<void> {
  await db.insert(userFeatureSwitches).values({ orgId, userId, switches });
}

describe("migration 0468 rename skill feature switches to workflows", () => {
  it("renames skillsViewer to workflowsViewer preserving true values", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { skillsViewer: true });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      workflowsViewer: true,
    });
  });

  it("renames chatSlashSkillCommands to chatSlashWorkflowCommands preserving false values", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { chatSlashSkillCommands: false });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      chatSlashWorkflowCommands: false,
    });
  });

  it("renames both keys and leaves unrelated switches untouched", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, {
      skillsViewer: true,
      chatSlashSkillCommands: true,
      memoryViewer: true,
    });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      workflowsViewer: true,
      chatSlashWorkflowCommands: true,
      memoryViewer: true,
    });
  });

  it("preserves existing workflow key values when both old and new keys exist", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, {
      skillsViewer: true,
      workflowsViewer: false,
      chatSlashSkillCommands: false,
      chatSlashWorkflowCommands: true,
    });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      workflowsViewer: false,
      chatSlashWorkflowCommands: true,
    });
  });

  it("is idempotent", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, {
      skillsViewer: true,
      chatSlashSkillCommands: false,
    });

    await runRename(orgId, userId);
    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      workflowsViewer: true,
      chatSlashWorkflowCommands: false,
    });
  });
});
