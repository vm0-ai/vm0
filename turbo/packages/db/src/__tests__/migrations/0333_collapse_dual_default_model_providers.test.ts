import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { db, uniqueId } from "../test-db";

/**
 * Integration test for migration 0333 body.
 *
 * The shared test DB has all migrations applied, so the partial unique index
 * `idx_model_providers_one_default_per_user` (added in 0334) is already in
 * place when this test runs. Seeding two `is_default=true` rows for the same
 * `(org_id, user_id)` would violate that index and fail before the cleanup
 * statement could run, so the test drops the index, seeds the dual-default
 * state, runs the cleanup, asserts, and restores the index in `finally`.
 */

const DROP_INDEX_SQL = sql`DROP INDEX IF EXISTS idx_model_providers_one_default_per_user`;
const RECREATE_INDEX_SQL = sql`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_model_providers_one_default_per_user
    ON model_providers (org_id, user_id) WHERE is_default = true
`;

async function runCollapse(): Promise<void> {
  await db.execute(sql`
    UPDATE model_providers
    SET is_default = false, updated_at = NOW()
    WHERE is_default = true
      AND id NOT IN (
        SELECT DISTINCT ON (org_id, user_id) id
        FROM model_providers
        WHERE is_default = true
        ORDER BY org_id, user_id, created_at ASC
      )
  `);
}

describe("migration 0333 collapse dual-default model providers", () => {
  it("keeps the earliest-created default and clears the rest per (org_id, user_id)", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.execute(DROP_INDEX_SQL);
    try {
      const [first] = await db
        .insert(modelProviders)
        .values({
          orgId,
          userId,
          type: "vm0",
          isDefault: true,
          createdAt: new Date(2025, 0, 1),
        })
        .returning({ id: modelProviders.id });
      const [second] = await db
        .insert(modelProviders)
        .values({
          orgId,
          userId,
          type: "openai-api-key",
          isDefault: true,
          createdAt: new Date(2025, 0, 2),
        })
        .returning({ id: modelProviders.id });

      await runCollapse();
      const rows = await db
        .select({
          id: modelProviders.id,
          isDefault: modelProviders.isDefault,
        })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, orgId),
            eq(modelProviders.userId, userId),
          ),
        );

      const firstRow = rows.find((r) => {
        return r.id === first!.id;
      });
      const secondRow = rows.find((r) => {
        return r.id === second!.id;
      });

      expect(firstRow?.isDefault).toBe(true);
      expect(secondRow?.isDefault).toBe(false);
    } finally {
      await db.execute(RECREATE_INDEX_SQL);
    }
  });

  it("does not touch single-default rows for unrelated (org_id, user_id)", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    const [only] = await db
      .insert(modelProviders)
      .values({
        orgId,
        userId,
        type: "vm0",
        isDefault: true,
      })
      .returning({ id: modelProviders.id });

    await runCollapse();
    const [row] = await db
      .select({ isDefault: modelProviders.isDefault })
      .from(modelProviders)
      .where(eq(modelProviders.id, only!.id))
      .limit(1);

    expect(row?.isDefault).toBe(true);
  });
});
