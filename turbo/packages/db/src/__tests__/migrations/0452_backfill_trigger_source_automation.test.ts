import { readFileSync } from "node:fs";

import { inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0452_backfill_trigger_source_automation.sql",
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

describe("migration 0452 backfill trigger_source automation", () => {
  it("rewrites schedule rows to automation, leaves other sources untouched, and is idempotent", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const userId = uniqueId("user");

      const [compose] = await tx
        .insert(agentComposes)
        .values({
          orgId,
          userId,
          name: uniqueId("compose"),
        })
        .returning({ id: agentComposes.id });

      const [session] = await tx
        .insert(agentSessions)
        .values({
          orgId,
          userId,
          agentComposeId: compose!.id,
        })
        .returning({ id: agentSessions.id });

      const triggerSources = ["schedule", "manual", "automation"] as const;
      const runIdBySource = new Map<string, string>();

      for (const triggerSource of triggerSources) {
        const [run] = await tx
          .insert(agentRuns)
          .values({
            orgId,
            userId,
            sessionId: session!.id,
            status: "completed",
            prompt: `run triggered via ${triggerSource}`,
          })
          .returning({ id: agentRuns.id });

        await tx.insert(zeroRuns).values({
          id: run!.id,
          triggerSource,
        });

        runIdBySource.set(triggerSource, run!.id);
      }

      const firstRun = await tx.execute(sql.raw(migrationSql));

      const rows = await tx
        .select({
          id: zeroRuns.id,
          triggerSource: zeroRuns.triggerSource,
        })
        .from(zeroRuns)
        .where(inArray(zeroRuns.id, [...runIdBySource.values()]));

      const sourceByRunId = new Map(
        rows.map((row) => {
          return [row.id, row.triggerSource];
        }),
      );

      // The dev database may hold real legacy "schedule" rows (the very rows
      // this migration targets), so assert at-least-ours rather than exactly 1.
      expect(firstRun.rowCount).toBeGreaterThanOrEqual(1);
      expect(sourceByRunId.get(runIdBySource.get("schedule")!)).toBe(
        "automation",
      );
      expect(sourceByRunId.get(runIdBySource.get("manual")!)).toBe("manual");
      expect(sourceByRunId.get(runIdBySource.get("automation")!)).toBe(
        "automation",
      );

      const secondRun = await tx.execute(sql.raw(migrationSql));
      expect(secondRun.rowCount).toBe(0);
    });
  });
});
