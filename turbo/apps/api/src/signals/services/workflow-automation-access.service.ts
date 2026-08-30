import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import {
  loadVisibleWorkflowById,
  type WorkflowAgentInfo,
} from "./workflow-data.service";

type WorkflowAutomationRow = typeof workflowAutomations.$inferSelect;

function canReadAgent(agent: WorkflowAgentInfo, userId: string): boolean {
  return agent.visibility === "public" || agent.owner === userId;
}

async function loadWorkflowAutomationOwnerMember(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
) {
  const [member] = await db
    .select({ role: orgMembersCache.role })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, args.orgId),
        eq(orgMembersCache.userId, args.userId),
      ),
    )
    .limit(1);
  return member ? { userId: args.userId, role: member.role } : null;
}

async function workflowAutomationOwnerCanReadTarget(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly agentId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const member = await loadWorkflowAutomationOwnerMember(db, args);
  signal.throwIfAborted();
  if (!member) {
    return false;
  }

  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member,
    workflowId: args.workflowId,
  });
  signal.throwIfAborted();
  if (!visible || visible.workflow.agentId !== args.agentId) {
    return false;
  }

  return canReadAgent(visible.agent, args.userId);
}

export async function workflowAutomationCanFire(
  db: ReadonlyDb,
  args: {
    readonly automation: WorkflowAutomationRow;
    readonly agentId: string;
    readonly allowClaimedOnceScheduleAutomation?: boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const claimedOnceSchedule =
    args.allowClaimedOnceScheduleAutomation === true &&
    args.automation.kind === "schedule" &&
    args.automation.scheduleType === "once" &&
    args.automation.nextRunAt === null &&
    args.automation.lastRunAt !== null;

  if (!args.automation.enabled && !claimedOnceSchedule) {
    return false;
  }
  if (
    args.automation.officialBlueprintKey !== null &&
    args.automation.officialReconciliationStatus !== "current"
  ) {
    return false;
  }

  return await workflowAutomationOwnerCanReadTarget(
    db,
    {
      orgId: args.automation.orgId,
      userId: args.automation.ownerUserId,
      workflowId: args.automation.workflowId,
      agentId: args.agentId,
    },
    signal,
  );
}
