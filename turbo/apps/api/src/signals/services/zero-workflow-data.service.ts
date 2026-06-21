import { computed, type Computed } from "ccstate";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { requireAgentPermission } from "../../lib/require-agent-permission";

export interface WorkflowMember {
  readonly userId: string;
  readonly role: string;
}

export interface WorkflowRow {
  readonly id: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly requestToPublish: boolean;
  readonly type: "workflow" | "goal";
  readonly instruction: string | null;
  readonly ownerUserId: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly createdAt: Date;
}

/**
 * The host agent's identity fields needed to evaluate workflow permissions.
 */
export interface WorkflowAgentInfo {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly name: string;
  readonly displayName: string | null;
}

/**
 * Whether the caller may edit/delete the workflow's content.
 * - private: owner only (agent admins cannot even see private workflows).
 * - public: whoever has write-permission on the host agent.
 */
export function canManageWorkflow(
  workflow: WorkflowRow,
  agent: WorkflowAgentInfo,
  member: WorkflowMember,
): boolean {
  if (workflow.visibility === "private") {
    return workflow.ownerUserId === member.userId;
  }
  return (
    requireAgentPermission(agent.owner, member, "manage", {
      visibility: agent.visibility,
    }) === null
  );
}

/**
 * Whether the caller has write-permission on the host agent — the gate for
 * reviewing publish requests and demoting public workflows.
 */
export function canReviewAgentWorkflows(
  agent: WorkflowAgentInfo,
  member: WorkflowMember,
): boolean {
  return (
    requireAgentPermission(agent.owner, member, "review", {
      visibility: agent.visibility,
    }) === null
  );
}

export function requireWorkflowPermission(
  workflow: WorkflowRow,
  agent: WorkflowAgentInfo,
  member: WorkflowMember,
  action: string,
) {
  if (canManageWorkflow(workflow, agent, member)) {
    return null;
  }
  const ownerLabel =
    workflow.visibility === "private"
      ? "the private workflow owner"
      : "an agent owner or org admin";
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

/**
 * SQL visibility predicate over a (workflow JOIN agent) row for the given
 * member: public workflows, the caller's own workflows, and — for agent
 * write-permission holders — private workflows with a pending publish request.
 */
function visibleWorkflowCondition(member: WorkflowMember): SQL {
  const reviewerSeesPending =
    member.role === "admin"
      ? // org admin: pending requests under public agents they can write
        and(
          eq(zeroWorkflows.requestToPublish, true),
          eq(zeroAgents.visibility, "public"),
        )
      : // non-admin: pending requests under agents they own
        and(
          eq(zeroWorkflows.requestToPublish, true),
          eq(zeroAgents.owner, member.userId),
        );

  return or(
    eq(zeroWorkflows.visibility, "public"),
    eq(zeroWorkflows.ownerUserId, member.userId),
    reviewerSeesPending,
  ) as SQL;
}

export async function loadVisibleWorkflowById(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly workflowId: string;
  },
): Promise<{ workflow: WorkflowRow; agent: WorkflowAgentInfo } | null> {
  const [row] = await db
    .select({
      workflow: zeroWorkflows,
      agent: {
        id: zeroAgents.id,
        owner: zeroAgents.owner,
        visibility: zeroAgents.visibility,
        name: zeroAgents.name,
        displayName: zeroAgents.displayName,
      },
    })
    .from(zeroWorkflows)
    .innerJoin(zeroAgents, eq(zeroWorkflows.agentId, zeroAgents.id))
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.id, args.workflowId),
        eq(zeroWorkflows.type, "workflow"),
        visibleWorkflowCondition(args.member),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }
  return { workflow: row.workflow, agent: row.agent };
}

export function workflowSummary(args: {
  readonly workflow: WorkflowRow;
  readonly agent: WorkflowAgentInfo;
  readonly member: WorkflowMember;
}): ZeroWorkflowSummary {
  return {
    id: args.workflow.id,
    agentId: args.workflow.agentId,
    agentName: args.agent.name,
    agentDisplayName: args.agent.displayName,
    name: args.workflow.name,
    displayName: args.workflow.displayName,
    description: args.workflow.description,
    visibility: args.workflow.visibility,
    requestToPublish: args.workflow.requestToPublish,
    ownerUserId: args.workflow.ownerUserId,
    canManage: canManageWorkflow(args.workflow, args.agent, args.member),
  };
}

export function zeroWorkflowList(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly agentId?: string;
}): Computed<Promise<readonly ZeroWorkflowSummary[]>> {
  return computed(async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    const db = get(db$);
    const rows = await db
      .select({
        workflow: zeroWorkflows,
        agent: {
          id: zeroAgents.id,
          owner: zeroAgents.owner,
          visibility: zeroAgents.visibility,
          name: zeroAgents.name,
          displayName: zeroAgents.displayName,
        },
      })
      .from(zeroWorkflows)
      .innerJoin(zeroAgents, eq(zeroWorkflows.agentId, zeroAgents.id))
      .where(
        and(
          eq(zeroWorkflows.orgId, args.orgId),
          // Goals are managed via the `zero goal` CLI and never appear here.
          eq(zeroWorkflows.type, "workflow"),
          args.agentId ? eq(zeroWorkflows.agentId, args.agentId) : undefined,
          visibleWorkflowCondition(args.member),
        ),
      )
      .orderBy(asc(zeroWorkflows.name));

    return rows.map((row) =>
      workflowSummary({
        workflow: row.workflow,
        agent: row.agent,
        member: args.member,
      }),
    );
  });
}

export interface RunWorkflowRef {
  readonly name: string;
  readonly workflowId: string;
}

/**
 * Workflows injectable into a run on `agentId` by `userId`: the agent's public
 * workflows plus the caller's own private ones. On a slug collision the fixed
 * priority wins — the caller's own private beats public, then earliest
 * `created_at` — and only that single workflow is injected.
 */
export async function loadWorkflowsForRun(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<readonly RunWorkflowRef[]> {
  const rows = await db
    .select({
      id: zeroWorkflows.id,
      name: zeroWorkflows.name,
      visibility: zeroWorkflows.visibility,
      ownerUserId: zeroWorkflows.ownerUserId,
      createdAt: zeroWorkflows.createdAt,
    })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.agentId, args.agentId),
        eq(zeroWorkflows.type, "workflow"),
        or(
          eq(zeroWorkflows.visibility, "public"),
          eq(zeroWorkflows.ownerUserId, args.userId),
        ),
      ),
    )
    // Priority within a slug: caller's own private first, then earliest created.
    .orderBy(
      sql`(${zeroWorkflows.visibility} = 'private' AND ${zeroWorkflows.ownerUserId} = ${args.userId}) DESC`,
      asc(zeroWorkflows.createdAt),
    );

  const bySlug = new Map<string, RunWorkflowRef>();
  for (const row of rows) {
    if (!bySlug.has(row.name)) {
      bySlug.set(row.name, { name: row.name, workflowId: row.id });
    }
  }
  return [...bySlug.values()];
}
