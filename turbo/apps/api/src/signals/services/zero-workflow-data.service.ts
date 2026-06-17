import { computed, type Computed } from "ccstate";
import type {
  ZeroWorkflowAgentSummary,
  ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  zeroWorkflowAgents,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { and, asc, eq, or } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { visibleJoinedZeroAgentCondition } from "./zero-agent-data.service";

export interface WorkflowMember {
  readonly userId: string;
  readonly role: string;
}

export interface WorkflowRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly ownerUserId: string;
  readonly displayName: string | null;
  readonly description: string | null;
}

function visibleWorkflowCondition(userId: string) {
  return or(
    eq(zeroWorkflows.visibility, "public"),
    eq(zeroWorkflows.ownerUserId, userId),
  );
}

function canManageWorkflow(
  workflow: WorkflowRow,
  member: WorkflowMember,
): boolean {
  if (workflow.visibility === "private") {
    return workflow.ownerUserId === member.userId;
  }

  return member.role === "admin";
}

export function requireWorkflowPermission(
  workflow: WorkflowRow,
  member: WorkflowMember,
  action: string,
) {
  if (canManageWorkflow(workflow, member)) {
    return null;
  }

  const ownerLabel =
    workflow.visibility === "private"
      ? "the private workflow owner"
      : "org admins";

  return {
    status: 403 as const,
    body: {
      error: {
        message: `Only ${ownerLabel} can ${action}`,
        code: "FORBIDDEN" as const,
      },
    },
  };
}

export async function loadVisibleWorkflow(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
  },
): Promise<WorkflowRow | null> {
  const [workflow] = await db
    .select()
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.name, args.name),
        visibleWorkflowCondition(args.userId),
      ),
    )
    .limit(1);

  return workflow ?? null;
}

export async function loadWorkflowByName(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly name: string;
  },
): Promise<WorkflowRow | null> {
  const [workflow] = await db
    .select()
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.name, args.name),
      ),
    )
    .limit(1);

  return workflow ?? null;
}

async function workflowAttachedAgents(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<readonly ZeroWorkflowAgentSummary[]> {
  const rows = await db
    .select({
      agentId: zeroAgents.id,
      ownerId: zeroAgents.owner,
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      avatarUrl: zeroAgents.avatarUrl,
      visibility: zeroAgents.visibility,
    })
    .from(zeroWorkflowAgents)
    .innerJoin(zeroAgents, eq(zeroWorkflowAgents.agentId, zeroAgents.id))
    .where(
      and(
        eq(zeroWorkflowAgents.orgId, args.orgId),
        eq(zeroWorkflowAgents.workflowId, args.workflowId),
        visibleJoinedZeroAgentCondition(args.userId),
      ),
    )
    .orderBy(asc(zeroAgents.name));

  return rows;
}

export async function workflowSummary(
  db: ReadonlyDb,
  args: {
    readonly workflow: WorkflowRow;
    readonly member: WorkflowMember;
  },
): Promise<ZeroWorkflowSummary> {
  const attachedAgents = await workflowAttachedAgents(db, {
    orgId: args.workflow.orgId,
    userId: args.member.userId,
    workflowId: args.workflow.id,
  });

  return {
    name: args.workflow.name,
    displayName: args.workflow.displayName,
    description: args.workflow.description,
    visibility: args.workflow.visibility,
    ownerUserId: args.workflow.ownerUserId,
    attachedAgentCount: attachedAgents.length,
    attachedAgents: [...attachedAgents],
    canManage: canManageWorkflow(args.workflow, args.member),
  };
}

export function zeroWorkflowList(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
}): Computed<Promise<readonly ZeroWorkflowSummary[]>> {
  return computed(async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    const db = get(db$);
    const rows = await db
      .select()
      .from(zeroWorkflows)
      .where(
        and(
          eq(zeroWorkflows.orgId, args.orgId),
          visibleWorkflowCondition(args.member.userId),
        ),
      )
      .orderBy(asc(zeroWorkflows.name));

    return Promise.all(
      rows.map((workflow) => {
        return workflowSummary(db, { workflow, member: args.member });
      }),
    );
  });
}

export async function loadWorkflowNamesForRun(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<readonly string[]> {
  const rows = await db
    .select({ name: zeroWorkflows.name })
    .from(zeroWorkflowAgents)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowAgents.workflowId, zeroWorkflows.id),
    )
    .where(
      and(
        eq(zeroWorkflowAgents.orgId, args.orgId),
        eq(zeroWorkflowAgents.agentId, args.agentId),
        visibleWorkflowCondition(args.userId),
      ),
    )
    .orderBy(asc(zeroWorkflows.name));

  return rows.map((row) => {
    return row.name;
  });
}
