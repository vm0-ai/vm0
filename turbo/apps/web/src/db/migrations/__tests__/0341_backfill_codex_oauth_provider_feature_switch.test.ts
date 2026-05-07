import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { initServices } from "../../../lib/init-services";

/**
 * Integration test for migration 0341 body.
 *
 * The migration has already run against the shared test DB, so the body is
 * re-executed against freshly-seeded rows. The UPDATE is scoped to the test's
 * own (orgId, userId) to avoid races with other migration tests writing to
 * the shared user_feature_switches table.
 */

const context = testContext();

async function runRename(orgId: string, userId: string): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the migration body verbatim, scoped
  await globalThis.services.db.execute(sql`
    UPDATE user_feature_switches
    SET switches = (switches - 'chatgptOauthProvider')
                || jsonb_build_object('codexOauthProvider', switches->'chatgptOauthProvider'),
        updated_at = NOW()
    WHERE switches ? 'chatgptOauthProvider'
      AND org_id = ${orgId}
      AND user_id = ${userId}
  `);
}

async function readSwitches(
  orgId: string,
  userId: string,
): Promise<Record<string, boolean> | undefined> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const [row] = await globalThis.services.db
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
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  await globalThis.services.db
    .insert(userFeatureSwitches)
    .values({ orgId, userId, switches });
}

describe("migration 0341 backfill codex oauth provider feature switch", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
  });

  it("renames chatgptOauthProvider key to codexOauthProvider preserving the value", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { chatgptOauthProvider: true });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      codexOauthProvider: true,
    });
  });

  it("preserves a `false` value across the rename", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { chatgptOauthProvider: false });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      codexOauthProvider: false,
    });
  });

  it("leaves coexisting unrelated keys untouched", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, {
      chatgptOauthProvider: true,
      otherSwitch: true,
    });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      codexOauthProvider: true,
      otherSwitch: true,
    });
  });

  it("is a no-op for rows that do not contain chatgptOauthProvider", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { otherSwitch: true });

    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({ otherSwitch: true });
  });

  it("is idempotent — re-running the rename after a successful pass is a no-op", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await seed(orgId, userId, { chatgptOauthProvider: true });

    await runRename(orgId, userId);
    await runRename(orgId, userId);

    expect(await readSwitches(orgId, userId)).toEqual({
      codexOauthProvider: true,
    });
  });
});
