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

interface WorkflowShadow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

/**
 * Whether the caller may edit/delete the workflow's content.
 * - private: owner only (agent admins cannot even see private workflows).
 * - public: whoever has write-permission on the host agent.
 */
function canManageWorkflow(
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
 * member: public workflows on a visible agent, the caller's own workflows, and
 * — for agent write-permission holders — private workflows with a pending
 * publish request.
 *
 * A public workflow only counts as "public" to the caller when its owning agent
 * is itself visible (public agent, or one the caller owns). A public workflow
 * parked under another user's private agent must stay hidden, so that resolving
 * it returns 404 rather than leaking the agent's existence via a 403.
 */
function visibleWorkflowCondition(member: WorkflowMember): SQL {
  const agentVisibleToMember = or(
    eq(zeroAgents.visibility, "public"),
    eq(zeroAgents.owner, member.userId),
  );

  const publicWorkflowOnVisibleAgent = and(
    eq(zeroWorkflows.visibility, "public"),
    agentVisibleToMember,
  );

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
    publicWorkflowOnVisibleAgent,
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
  readonly shadowedBy?: WorkflowShadow | null;
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
    shadowedBy: args.shadowedBy ?? null,
  };
}

function workflowRunPrioritySort(userId: string): SQL[] {
  return [
    sql`(${zeroWorkflows.visibility} = 'private' AND ${zeroWorkflows.ownerUserId} = ${userId}) DESC`,
    asc(zeroWorkflows.createdAt),
  ];
}

function injectableWorkflowCondition(userId: string): SQL {
  return or(
    eq(zeroWorkflows.visibility, "public"),
    eq(zeroWorkflows.ownerUserId, userId),
  ) as SQL;
}

function shadowWinnerFromRows(
  rows: readonly { readonly workflow: WorkflowRow }[],
  member: WorkflowMember,
): Map<string, WorkflowShadow> {
  const groups = new Map<string, WorkflowRow[]>();
  for (const row of rows) {
    const key = `${row.workflow.agentId}:${row.workflow.name}`;
    groups.set(key, [...(groups.get(key) ?? []), row.workflow]);
  }

  const winners = new Map<string, WorkflowShadow>();
  for (const [key, workflows] of groups) {
    const winner = workflows
      .filter((workflow) => {
        return (
          workflow.visibility === "public" ||
          workflow.ownerUserId === member.userId
        );
      })
      .sort((a, b) => {
        const aPrivateOwner =
          a.visibility === "private" && a.ownerUserId === member.userId;
        const bPrivateOwner =
          b.visibility === "private" && b.ownerUserId === member.userId;
        if (aPrivateOwner !== bPrivateOwner) {
          return aPrivateOwner ? -1 : 1;
        }
        return a.createdAt.getTime() - b.createdAt.getTime();
      })[0];
    if (!winner) {
      continue;
    }
    winners.set(key, {
      id: winner.id,
      name: winner.name,
      displayName: winner.displayName,
    });
  }
  return winners;
}

export async function loadWorkflowShadowWinner(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly workflow: WorkflowRow;
  },
): Promise<WorkflowShadow | null> {
  const [winner] = await db
    .select({
      id: zeroWorkflows.id,
      name: zeroWorkflows.name,
      displayName: zeroWorkflows.displayName,
    })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.agentId, args.workflow.agentId),
        eq(zeroWorkflows.name, args.workflow.name),
        eq(zeroWorkflows.type, "workflow"),
        injectableWorkflowCondition(args.member.userId),
      ),
    )
    .orderBy(...workflowRunPrioritySort(args.member.userId))
    .limit(1);

  if (!winner || winner.id === args.workflow.id) {
    return null;
  }
  return winner;
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

    const winners = shadowWinnerFromRows(rows, args.member);

    return rows.map((row) => {
      const key = `${row.workflow.agentId}:${row.workflow.name}`;
      const winner = winners.get(key);
      return workflowSummary({
        workflow: row.workflow,
        agent: row.agent,
        member: args.member,
        shadowedBy:
          winner && winner.id !== row.workflow.id ? winner : undefined,
      });
    });
  });
}

interface RunWorkflowRef {
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
    .orderBy(...workflowRunPrioritySort(args.userId));

  const bySlug = new Map<string, RunWorkflowRef>();
  for (const row of rows) {
    if (!bySlug.has(row.name)) {
      bySlug.set(row.name, { name: row.name, workflowId: row.id });
    }
  }
  return [...bySlug.values()];
}
