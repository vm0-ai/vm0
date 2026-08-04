import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroWorkflowAutomations } from "@vm0/db/schema/zero-workflow";
import { eq, sql } from "drizzle-orm";

import { db } from "../../../lib/db";
import {
  autonomyBudgetSchemaAvailable,
  insertRolloutCompatibleThreadGoal,
  insertRolloutCompatibleWorkflowAutomation,
  insertRolloutCompatibleZeroRun,
  rolloutCompatibleAutonomyBudgetColumn,
  rolloutCompatibleThreadGoalColumns,
  rolloutCompatibleWorkflowAutomationColumns,
} from "../autonomy-budget-schema.service";

describe("autonomy budget rollout compatibility", () => {
  it("keeps legacy entity reads and writes legal before the migration", async () => {
    const rollback = new Error("rollback autonomy budget rollout fixture");

    await expect(
      db().transaction(async (tx) => {
        await tx.execute(sql`
          CREATE TEMP TABLE zero_runs
          (LIKE public.zero_runs INCLUDING DEFAULTS)
          ON COMMIT DROP
        `);
        await tx.execute(sql`
          CREATE TEMP TABLE thread_goals
          (LIKE public.thread_goals INCLUDING DEFAULTS)
          ON COMMIT DROP
        `);
        await tx.execute(sql`
          CREATE TEMP TABLE zero_workflow_automations
          (LIKE public.zero_workflow_automations INCLUDING DEFAULTS)
          ON COMMIT DROP
        `);
        await tx.execute(sql`SET LOCAL search_path TO pg_temp, public`);

        await expect(autonomyBudgetSchemaAvailable(tx)).resolves.toBeTruthy();
        const migratedRunId = randomUUID();
        await insertRolloutCompatibleZeroRun(
          tx,
          { id: migratedRunId, triggerSource: "web", autonomyBudget: 7 },
          true,
        );
        const [migratedRun] = await tx
          .select({
            id: zeroRuns.id,
            autonomyBudget: rolloutCompatibleAutonomyBudgetColumn(
              false,
              zeroRuns.autonomyBudget,
            ),
          })
          .from(zeroRuns)
          .where(eq(zeroRuns.id, migratedRunId))
          .limit(1);
        expect(migratedRun).toStrictEqual({
          id: migratedRunId,
          autonomyBudget: 7,
        });

        const migratedGoal = await insertRolloutCompatibleThreadGoal(
          tx,
          {
            orgId: "org_migrated",
            ownerUserId: "user_migrated",
            agentId: randomUUID(),
            chatThreadId: randomUUID(),
            status: "active",
            objective: "Read the saved migrated goal budget",
            objectiveBrief: "Read the saved migrated goal budget",
            autonomyBudget: 7,
          },
          true,
        );
        if (!migratedGoal) {
          throw new Error("Expected the migrated goal insert to return a row");
        }
        const [migratedGoalRead] = await tx
          .select(rolloutCompatibleThreadGoalColumns(false))
          .from(threadGoals)
          .where(eq(threadGoals.id, migratedGoal.id))
          .limit(1);
        expect(migratedGoalRead?.autonomyBudget).toBe(7);

        const migratedAutomation =
          await insertRolloutCompatibleWorkflowAutomation(
            tx,
            {
              orgId: "org_migrated",
              workflowId: randomUUID(),
              ownerUserId: "user_migrated",
              kind: "schedule",
              scheduleType: "loop",
              intervalSeconds: 3600,
              timezone: "UTC",
              autonomyBudget: 7,
            },
            true,
          );
        if (!migratedAutomation) {
          throw new Error(
            "Expected the migrated automation insert to return a row",
          );
        }
        const [migratedAutomationRead] = await tx
          .select(rolloutCompatibleWorkflowAutomationColumns(false))
          .from(zeroWorkflowAutomations)
          .where(eq(zeroWorkflowAutomations.id, migratedAutomation.id))
          .limit(1);
        expect(migratedAutomationRead?.autonomyBudget).toBe(7);

        await tx.execute(
          sql`ALTER TABLE pg_temp.zero_runs DROP COLUMN autonomy_budget`,
        );
        await tx.execute(
          sql`ALTER TABLE pg_temp.thread_goals DROP COLUMN autonomy_budget`,
        );
        await tx.execute(sql`
          ALTER TABLE pg_temp.zero_workflow_automations
          DROP COLUMN autonomy_budget
        `);

        await expect(autonomyBudgetSchemaAvailable(tx)).resolves.toBeFalsy();

        const runId = randomUUID();
        await insertRolloutCompatibleZeroRun(
          tx,
          { id: runId, triggerSource: "web", autonomyBudget: 7 },
          false,
        );
        const [run] = await tx
          .select({
            id: zeroRuns.id,
            autonomyBudget: rolloutCompatibleAutonomyBudgetColumn(
              false,
              zeroRuns.autonomyBudget,
            ),
          })
          .from(zeroRuns)
          .where(eq(zeroRuns.id, runId))
          .limit(1);
        expect(run).toStrictEqual({ id: runId, autonomyBudget: 10 });

        const goal = await insertRolloutCompatibleThreadGoal(
          tx,
          {
            orgId: "org_rollout",
            ownerUserId: "user_rollout",
            agentId: randomUUID(),
            chatThreadId: randomUUID(),
            status: "active",
            objective: "Keep legacy goal writes legal",
            objectiveBrief: "Keep legacy goal writes legal",
            autonomyBudget: 7,
          },
          false,
        );
        expect(goal?.autonomyBudget).toBe(10);

        const automation = await insertRolloutCompatibleWorkflowAutomation(
          tx,
          {
            orgId: "org_rollout",
            workflowId: randomUUID(),
            ownerUserId: "user_rollout",
            kind: "schedule",
            scheduleType: "loop",
            intervalSeconds: 3600,
            timezone: "UTC",
            autonomyBudget: 7,
          },
          false,
        );
        expect(automation?.autonomyBudget).toBe(10);

        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
