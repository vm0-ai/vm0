import { computed, type Computed } from "ccstate";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { userCache } from "@vm0/db/schema/user-cache";
import { and, asc, desc, eq, or, type SQL } from "drizzle-orm";

import { db$, type Db, type ReadonlyDb } from "../external/db";
import { clerk$ } from "../external/clerk";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { now, nowDate } from "../../lib/time";

const USER_CACHE_TTL_MS = 15 * 60 * 1000;

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
  readonly instruction: string | null;
  readonly ownerUserId: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type WorkflowSummaryRow = Pick<
  WorkflowRow,
  | "id"
  | "agentId"
  | "name"
  | "visibility"
  | "ownerUserId"
  | "displayName"
  | "description"
  | "createdAt"
>;

/**
 * The host agent's identity fields needed to evaluate workflow management.
 */
export interface WorkflowAgentInfo {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly name: string;
  readonly displayName: string | null;
}

interface VisibleWorkflowAgentInfo extends WorkflowAgentInfo {
  readonly orgId: string;
}

interface WorkflowShadow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

interface WorkflowOwnerProfile {
  readonly displayName: string | null;
  readonly imageUrl: string | null;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly imageUrl?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly primaryEmailAddressId: string | null;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
}

interface CachedOwnerProfile {
  readonly email: string | null;
  readonly name: string | null;
  readonly imageUrl: string | null;
  readonly cachedAt: Date | null;
}

function primaryEmail(user: ClerkUserProfile): string | null {
  const primary = user.emailAddresses.find((entry) => {
    return entry.id === user.primaryEmailAddressId;
  });
  return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
}

function fullName(user: ClerkUserProfile): string | null {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
}

function ownerProfileFromCache(
  row: CachedOwnerProfile | null | undefined,
  currentTime: number,
): WorkflowOwnerProfile | null {
  if (
    !row ||
    !row.email ||
    !row.cachedAt ||
    currentTime - row.cachedAt.getTime() >= USER_CACHE_TTL_MS
  ) {
    return null;
  }
  return {
    displayName: row.name ?? row.email,
    imageUrl: row.imageUrl,
  };
}

/**
 * Whether the caller may edit/delete the workflow's content.
 * - private: owner only (agent admins cannot even see private workflows).
 * - public: whoever has write-permission on the host agent.
 */
function canManageWorkflow(
  workflow: WorkflowSummaryRow,
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

function canPublishWorkflow(
  workflow: WorkflowSummaryRow,
  agent: WorkflowAgentInfo,
  member: WorkflowMember,
): boolean {
  return (
    workflow.visibility === "private" &&
    workflow.ownerUserId === member.userId &&
    requireAgentPermission(agent.owner, member, "publish", {
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
 * member: public workflows on a visible agent, and the caller's own workflows.
 *
 * A public workflow only counts as "public" to the caller when its owning agent
 * is itself visible (public agent, or one the caller owns). A public workflow
 * parked under another user's private agent must stay hidden, so that resolving
 * it returns 404 rather than leaking the agent's existence via a 403.
 */
export function visibleWorkflowCondition(member: WorkflowMember): SQL {
  const agentVisibleToMember = or(
    eq(zeroAgents.visibility, "public"),
    eq(zeroAgents.owner, member.userId),
  );

  const publicWorkflowOnVisibleAgent = and(
    eq(zeroWorkflows.visibility, "public"),
    agentVisibleToMember,
  );

  return or(
    publicWorkflowOnVisibleAgent,
    eq(zeroWorkflows.ownerUserId, member.userId),
  ) as SQL;
}

export async function loadVisibleWorkflowById(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly workflowId: string;
  },
): Promise<{ workflow: WorkflowRow; agent: VisibleWorkflowAgentInfo } | null> {
  const [row] = await db
    .select({
      workflow: zeroWorkflows,
      agent: {
        id: zeroAgents.id,
        orgId: zeroAgents.orgId,
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
  readonly workflow: WorkflowSummaryRow;
  readonly agent: WorkflowAgentInfo;
  readonly member: WorkflowMember;
  readonly ownerProfile?: WorkflowOwnerProfile | null;
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
    ownerUserId: args.workflow.ownerUserId,
    ownerUserDisplayName: args.ownerProfile?.displayName ?? null,
    ownerUserImageUrl: args.ownerProfile?.imageUrl ?? null,
    createdAt: args.workflow.createdAt.toISOString(),
    canManage: canManageWorkflow(args.workflow, args.agent, args.member),
    canPublish: canPublishWorkflow(args.workflow, args.agent, args.member),
    shadowedBy: args.shadowedBy ?? null,
  };
}

function workflowRunPrioritySort(userId: string): SQL[] {
  return [
    desc(
      and(
        eq(zeroWorkflows.visibility, "private"),
        eq(zeroWorkflows.ownerUserId, userId),
      ) as SQL,
    ),
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
  rows: readonly { readonly workflow: WorkflowSummaryRow }[],
  member: WorkflowMember,
): Map<string, WorkflowShadow> {
  const groups = new Map<string, WorkflowSummaryRow[]>();
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

async function refreshOwnerProfiles(
  db: Db,
  client: ReturnType<typeof clerk$.read>,
  userIds: readonly string[],
): Promise<Map<string, WorkflowOwnerProfile>> {
  const profiles = new Map<string, WorkflowOwnerProfile>();
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) {
    return profiles;
  }
  const users = await client.users.getUserList({ userId: uniqueUserIds });
  const refreshedAt = nowDate();
  for (const user of users.data) {
    const email = primaryEmail(user);
    if (!email) {
      continue;
    }
    const name = fullName(user);
    const imageUrl = user.imageUrl ?? null;
    profiles.set(user.id, {
      displayName: name ?? email,
      imageUrl,
    });
    await db
      .insert(userCache)
      .values({
        userId: user.id,
        email,
        name,
        imageUrl,
        cachedAt: refreshedAt,
      })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: { email, name, imageUrl, cachedAt: refreshedAt },
      });
  }
  return profiles;
}

/**
 * Resolve a single workflow owner's display name and avatar, mirroring the list
 * path: prefer a fresh `userCache` row, refresh stale/missing entries from
 * Clerk, and fall back to a stale cache row when Clerk yields nothing. Returns
 * `null` only when no identity is known, letting callers fall back to the raw
 * owner user id.
 */
export async function loadWorkflowOwnerProfile(
  db: Db,
  client: ReturnType<typeof clerk$.read>,
  ownerUserId: string,
): Promise<WorkflowOwnerProfile | null> {
  const [cachedRow] = await db
    .select({
      name: userCache.name,
      email: userCache.email,
      imageUrl: userCache.imageUrl,
      cachedAt: userCache.cachedAt,
    })
    .from(userCache)
    .where(eq(userCache.userId, ownerUserId))
    .limit(1);

  const cached = ownerProfileFromCache(cachedRow, now());
  if (cached) {
    return cached;
  }

  const refreshed = await refreshOwnerProfiles(db, client, [ownerUserId]);
  const profile = refreshed.get(ownerUserId);
  if (profile) {
    return profile;
  }

  if (cachedRow?.name || cachedRow?.email || cachedRow?.imageUrl) {
    return {
      displayName: cachedRow.name ?? cachedRow.email ?? null,
      imageUrl: cachedRow.imageUrl ?? null,
    };
  }
  return null;
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
        workflow: {
          id: zeroWorkflows.id,
          agentId: zeroWorkflows.agentId,
          name: zeroWorkflows.name,
          visibility: zeroWorkflows.visibility,
          ownerUserId: zeroWorkflows.ownerUserId,
          displayName: zeroWorkflows.displayName,
          description: zeroWorkflows.description,
          createdAt: zeroWorkflows.createdAt,
        },
        agent: {
          id: zeroAgents.id,
          owner: zeroAgents.owner,
          visibility: zeroAgents.visibility,
          name: zeroAgents.name,
          displayName: zeroAgents.displayName,
        },
        ownerProfile: {
          name: userCache.name,
          email: userCache.email,
          imageUrl: userCache.imageUrl,
          cachedAt: userCache.cachedAt,
        },
      })
      .from(zeroWorkflows)
      .innerJoin(zeroAgents, eq(zeroWorkflows.agentId, zeroAgents.id))
      .leftJoin(userCache, eq(userCache.userId, zeroWorkflows.ownerUserId))
      .where(
        and(
          eq(zeroWorkflows.orgId, args.orgId),
          args.agentId ? eq(zeroWorkflows.agentId, args.agentId) : undefined,
          visibleWorkflowCondition(args.member),
        ),
      )
      .orderBy(asc(zeroWorkflows.name));

    const winners = shadowWinnerFromRows(rows, args.member);
    const currentTime = now();
    const ownerProfileByUserId = new Map<string, WorkflowOwnerProfile>();
    const ownerIdsToRefresh = new Set<string>();
    for (const row of rows) {
      const cached = ownerProfileFromCache(row.ownerProfile, currentTime);
      if (cached) {
        ownerProfileByUserId.set(row.workflow.ownerUserId, cached);
      } else {
        ownerIdsToRefresh.add(row.workflow.ownerUserId);
      }
    }

    const refreshedProfiles = await refreshOwnerProfiles(
      db as Db,
      get(clerk$),
      [...ownerIdsToRefresh],
    );
    for (const [userId, profile] of refreshedProfiles) {
      ownerProfileByUserId.set(userId, profile);
    }

    return rows.map((row) => {
      const key = `${row.workflow.agentId}:${row.workflow.name}`;
      const winner = winners.get(key);
      const ownerProfile = ownerProfileByUserId.get(row.workflow.ownerUserId);
      return workflowSummary({
        workflow: row.workflow,
        agent: row.agent,
        member: args.member,
        ownerProfile: {
          displayName:
            ownerProfile?.displayName ??
            row.ownerProfile?.name ??
            row.ownerProfile?.email ??
            null,
          imageUrl:
            ownerProfile?.imageUrl ?? row.ownerProfile?.imageUrl ?? null,
        },
        shadowedBy:
          winner && winner.id !== row.workflow.id ? winner : undefined,
      });
    });
  });
}

export interface RunWorkflowRef {
  readonly name: string;
  readonly workflowId: string;
}

export interface RunWorkflowSourceRow {
  readonly id: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly ownerUserId: string;
  readonly createdAt: Date;
}

export function workflowsForRunFromRows(
  rows: readonly RunWorkflowSourceRow[],
  userId: string,
): readonly RunWorkflowRef[] {
  const prioritizedRows = [...rows].sort((left, right) => {
    const leftPrivateOwner =
      left.visibility === "private" && left.ownerUserId === userId;
    const rightPrivateOwner =
      right.visibility === "private" && right.ownerUserId === userId;
    if (leftPrivateOwner !== rightPrivateOwner) {
      return leftPrivateOwner ? -1 : 1;
    }
    return (
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id)
    );
  });

  const bySlug = new Map<string, RunWorkflowRef>();
  for (const row of prioritizedRows) {
    if (!bySlug.has(row.name)) {
      bySlug.set(row.name, { name: row.name, workflowId: row.id });
    }
  }
  return [...bySlug.values()];
}
