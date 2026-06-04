import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { memoryChangeItems } from "@vm0/db/schema/memory-change-item";
import { memoryChangeSummaries } from "@vm0/db/schema/memory-change-summary";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0428_clear_dirty_memory_change_summaries.sql",
    import.meta.url,
  ),
  "utf8",
);

class RollbackMigrationTestTransaction extends Error {}

async function runInRollbackTransaction(
  callback: Parameters<typeof db.transaction>[0],
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await callback(tx);
      throw new RollbackMigrationTestTransaction();
    });
  } catch (error) {
    if (error instanceof RollbackMigrationTestTransaction) {
      return;
    }
    throw error;
  }
}

describe("migration 0428 clear dirty memory change summaries", () => {
  it("deletes every summary and cascades to its change items", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const userId = uniqueId("user");

      const [summary] = await tx
        .insert(memoryChangeSummaries)
        .values({
          orgId,
          userId,
          date: "2999-01-02",
          toVersionId: uniqueId("ver"),
          summary: "dirty full-history dump",
        })
        .returning({ id: memoryChangeSummaries.id });

      await tx.insert(memoryChangeItems).values({
        summaryId: summary?.id ?? "",
        filePath: "facts/a.md",
        diff: {
          format: "line",
          beforeExists: false,
          afterExists: true,
          truncated: false,
          stats: { added: 0, removed: 0 },
          hunks: [],
        },
      });

      await tx.execute(sql.raw(migrationSql));

      const summaries = await tx.execute<{ count: number }>(
        sql`SELECT COUNT(*)::int AS count FROM memory_change_summaries`,
      );
      const items = await tx.execute<{ count: number }>(
        sql`SELECT COUNT(*)::int AS count FROM memory_change_items`,
      );

      // The delete wipes the table; the FK cascade removes the orphaned item.
      expect(summaries.rows[0]?.count).toBe(0);
      expect(items.rows[0]?.count).toBe(0);
    });
  });
});
