import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { db, uniqueId } from "../test-db";

async function runRename(orgId: string, userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE user_feature_switches
    SET switches = (switches - 'orgSkills')
                || jsonb_build_object('skillsViewer', switches->'orgSkills'),
        updated_at = NOW()
    WHERE switches ? 'orgSkills'
      AND NOT (switches ? 'skillsViewer')
      AND org_id = ${orgId}
      AND user_id = ${userId}
  `);

  await db.execute(sql`
    UPDATE user_feature_switches
    SET switches = switches - 'orgSkills',
        updated_at = NOW()
    WHERE switches ? 'orgSkills'
      AND (switches ? 'skillsViewer')
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

describe("migration 0422 rename org skills feature switch", () => {
  it("renames orgSkills to skillsViewer preserving true values", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { orgSkills: true });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      skillsViewer: true,
    });
  });

  it("preserves false values across the rename", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { orgSkills: false });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      skillsViewer: false,
    });
  });

  it("leaves unrelated switches untouched", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, {
      orgSkills: true,
      memoryViewer: true,
    });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      skillsViewer: true,
      memoryViewer: true,
    });
  });

  it("preserves an existing skillsViewer value when both keys exist", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, {
      orgSkills: true,
      skillsViewer: false,
    });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      skillsViewer: false,
    });
  });

  it("is idempotent", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { orgSkills: true });

    await runRename(orgId, userId);
    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      skillsViewer: true,
    });
  });
});
