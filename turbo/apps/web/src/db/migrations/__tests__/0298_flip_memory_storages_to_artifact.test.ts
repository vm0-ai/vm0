import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { initServices } from "../../../lib/init-services";
import { storages } from "../../schema/storage";

/**
 * Integration test for migration 0296 body.
 *
 * The migration has already run against the shared test DB, so the body is
 * re-executed against freshly-seeded rows. Mirrors 0284_starter_credit_expiry.test.ts.
 *
 * The two statements (collision pre-flight + UPDATE) are exercised separately:
 *
 * - The UPDATE is scoped to the test's own orgId. The production statement is
 *   unscoped, but other test files writing to this shared DB (e.g.
 *   memory-dual-read.test.ts) routinely leave `(org_id,user_id,name)` rows
 *   with both `type='memory'` and `type='artifact'`. An unscoped global
 *   UPDATE would violate `idx_storages_org_user_name_type` on those foreign
 *   rows; scoping to the test's orgId preserves the transformation semantics
 *   we care about without racing against other suites.
 * - The guard is read-only, so running it unscoped is safe and exercises the
 *   production SQL verbatim.
 */

const context = testContext();

async function insertStorage(row: {
  orgId: string;
  userId: string;
  name: string;
  type: "memory" | "artifact" | "volume";
}): Promise<string> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [storage] = await globalThis.services.db
    .insert(storages)
    .values({
      orgId: row.orgId,
      userId: row.userId,
      name: row.name,
      type: row.type,
      s3Prefix: `${row.orgId}/${row.type}/${row.name}`,
      size: 0,
      fileCount: 0,
    })
    .returning({ id: storages.id });
  return storage!.id;
}

async function runGuardCheck(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes verbatim guard statement
  await globalThis.services.db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM storages m
        WHERE type = 'memory'
          AND EXISTS (
            SELECT 1 FROM storages a
            WHERE a.type = 'artifact'
              AND a.org_id = m.org_id
              AND a.user_id = m.user_id
              AND a.name = m.name
          )
      ) THEN
        RAISE EXCEPTION 'storages has memory/artifact name collisions — resolve before flipping';
      END IF;
    END $$;
  `);
}

async function runUpdateScoped(orgId: string): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: scoped UPDATE (see file-level note)
  await globalThis.services.db.execute(sql`
    UPDATE storages SET type = 'artifact' WHERE type = 'memory' AND org_id = ${orgId}
  `);
}

async function readType(id: string): Promise<string | undefined> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const [row] = await globalThis.services.db
    .select({ type: storages.type })
    .from(storages)
    .where(eq(storages.id, id))
    .limit(1);
  return row?.type;
}

async function readS3Prefix(id: string): Promise<string | undefined> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const [row] = await globalThis.services.db
    .select({ s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(eq(storages.id, id))
    .limit(1);
  return row?.s3Prefix;
}

describe("migration 0296 flip memory storages to artifact", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
  });

  it("flips type='memory' rows to type='artifact'", async () => {
    const orgId = uniqueId("org");
    const memoryId = await insertStorage({
      orgId,
      userId: uniqueId("user"),
      name: uniqueId("mem"),
      type: "memory",
    });

    await runUpdateScoped(orgId);

    expect(await readType(memoryId)).toBe("artifact");
  });

  it("preserves s3_prefix across the flip (no S3 rewrite)", async () => {
    const orgId = uniqueId("org");
    const memoryId = await insertStorage({
      orgId,
      userId: uniqueId("user"),
      name: uniqueId("mem"),
      type: "memory",
    });
    const before = await readS3Prefix(memoryId);

    await runUpdateScoped(orgId);

    const after = await readS3Prefix(memoryId);
    expect(after).toBe(before);
    expect(after).toContain("/memory/");
  });

  it("leaves type='volume' and type='artifact' rows untouched", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    const volumeId = await insertStorage({
      orgId,
      userId: VOLUME_ORG_USER_ID,
      name: uniqueId("vol"),
      type: "volume",
    });
    const artifactId = await insertStorage({
      orgId,
      userId,
      name: uniqueId("art"),
      type: "artifact",
    });

    await runUpdateScoped(orgId);

    expect(await readType(volumeId)).toBe("volume");
    expect(await readType(artifactId)).toBe("artifact");
  });

  it("guard aborts when a memory/artifact collision exists", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    const name = uniqueId("dup");
    await insertStorage({ orgId, userId, name, type: "memory" });
    await insertStorage({ orgId, userId, name, type: "artifact" });

    await expect(runGuardCheck()).rejects.toThrow(
      /storages has memory\/artifact name collisions/,
    );
  });

  it("is idempotent — re-running UPDATE after the flip is a no-op", async () => {
    const orgId = uniqueId("org");
    const memoryId = await insertStorage({
      orgId,
      userId: uniqueId("user"),
      name: uniqueId("mem"),
      type: "memory",
    });

    await runUpdateScoped(orgId);
    await runUpdateScoped(orgId);

    expect(await readType(memoryId)).toBe("artifact");
  });
});
