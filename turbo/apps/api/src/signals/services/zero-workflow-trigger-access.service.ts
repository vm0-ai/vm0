import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { zeroWorkflowTriggers } from "@vm0/db/schema/zero-workflow";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import {
  loadVisibleWorkflowById,
  type WorkflowAgentInfo,
} from "./zero-workflow-data.service";

type WorkflowTriggerRow = typeof zeroWorkflowTriggers.$inferSelect;

function canReadAgent(agent: WorkflowAgentInfo, userId: string): boolean {
  return agent.visibility === "public" || agent.owner === userId;
}

async function loadWorkflowTriggerOwnerMember(
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

async function workflowTriggerOwnerCanReadTarget(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly agentId: string;
    readonly signal: AbortSignal;
  },
): Promise<boolean> {
  const member = await loadWorkflowTriggerOwnerMember(db, args);
  args.signal.throwIfAborted();
  if (!member) {
    return false;
  }

  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member,
    workflowId: args.workflowId,
  });
  args.signal.throwIfAborted();
  if (!visible || visible.workflow.agentId !== args.agentId) {
    return false;
  }

  return canReadAgent(visible.agent, args.userId);
}

export async function workflowTriggerCanFire(
  db: ReadonlyDb,
  args: {
    readonly trigger: WorkflowTriggerRow;
    readonly agentId: string;
    readonly signal: AbortSignal;
  },
): Promise<boolean> {
  if (!args.trigger.enabled) {
    return false;
  }

  return await workflowTriggerOwnerCanReadTarget(db, {
    orgId: args.trigger.orgId,
    userId: args.trigger.ownerUserId,
    workflowId: args.trigger.workflowId,
    agentId: args.agentId,
    signal: args.signal,
  });
}
