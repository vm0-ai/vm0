import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command, computed, type Computed } from "ccstate";
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import { getDatasetName, queryAxiom } from "../external/axiom";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { getLocalToday, resolveUserTimezones } from "./local-day";
import { settle } from "../utils";

const L = logger("CronAggregateInsights");
const OTHER_USAGE_AGENT_NAME = "Other usage";
const NETWORK_RUN_ATTRIBUTION_BATCH_SIZE = 10_000;
const AGGREGATION_REPROCESS_OVERLAP_MS = 5 * 60_000;
const ORG_MEMBERSHIP_PAGE_SIZE = 100;

interface AgentInfo {
  readonly agentId: string | null;
  agentName: string;
  runs: number;
  credits: number;
}

interface AxiomNetworkRow {
  readonly _time: string;
  readonly runId: string;
  readonly host: string;
  readonly firewall_name: string;
  readonly firewall_permission: string;
  readonly action: string;
}

interface UserNetworkData {
  readonly serviceMap: Map<string, { calls: number; agentNames: Set<string> }>;
  readonly permMap: Map<
    string,
    {
      readonly label: string;
      readonly connectorType: string;
      allowed: number;
      denied: number;
      readonly agentNames: Set<string>;
    }
  >;
}

interface InsightData {
  readonly agents: {
    readonly agentName: string;
    readonly agentId: string | null;
    readonly runs: number;
    readonly credits: number;
  }[];
  readonly creditsUsed: number;
  readonly creditBalance: number;
  readonly teamUsage: {
    readonly userId: string;
    readonly name: string;
    readonly credits: number;
    readonly agentNames: string[];
    readonly agentCredits: Record<string, number>;
  }[];
  readonly topTask: { readonly name: string; readonly count: number } | null;
  readonly services: {
    readonly domain: string;
    readonly calls: number;
    readonly agentNames: string[];
  }[];
  readonly permissions: {
    readonly label: string;
    readonly connectorType: string;
    readonly allowed: number;
    readonly denied: number;
    readonly agentNames: string[];
  }[];
  readonly axiomDegraded?: boolean;
}

interface TeamUsageEntry {
  readonly userId: string;
  readonly name: string;
  readonly credits: number;
  readonly agentNames: string[];
  readonly agentCredits: Record<string, number>;
}

interface OrgCreditsInfo {
  readonly creditsUsed: number;
  readonly teamUsage: TeamUsageEntry[];
}

interface LedgerCreditRow {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string | null;
  readonly agentName: string;
  readonly credits: number;
}

interface RunCountRow {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly runs: number;
}

interface ActiveUserRow {
  readonly orgId: string;
  readonly userId: string;
  readonly lastActivity: Date;
}

interface OrgUserPair {
  readonly orgId: string;
  readonly userId: string;
}

interface NetworkRunAgentRow {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly agentName: string;
}

interface WindowGroup {
  readonly dayStart: Date;
  readonly dayEnd: Date;
  readonly targetDate: string;
  readonly users: OrgUserPair[];
}

interface WindowScope {
  readonly dayStart: Date;
  readonly dayEnd: Date;
  readonly users: OrgUserPair[];
  readonly orgIds: string[];
  readonly userIds: string[];
  readonly currentOrgMembers: CurrentOrgMemberScope;
}

interface ClerkUserListUser {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string | null;
  readonly firstName: string | null;
  readonly username: string | null;
}

interface ClerkOrganizationMembership {
  readonly publicUserData?: {
    readonly userId?: string | null;
  } | null;
}

interface ClerkLike {
  readonly users: {
    readonly getUserList: (args: {
      readonly userId: string[];
      readonly limit: number;
    }) => Promise<{ readonly data: readonly ClerkUserListUser[] }>;
  };
  readonly organizations: {
    readonly getOrganizationMembershipList: (args: {
      readonly organizationId: string;
      readonly limit: number;
      readonly offset: number;
    }) => Promise<{ readonly data: readonly ClerkOrganizationMembership[] }>;
  };
}

interface AggregateInsightsResult {
  readonly users: number;
  readonly skipped?: true;
  readonly windows?: number;
  readonly networkRows?: number;
}

interface AgentContribution {
  readonly orgId: string;
  readonly userId: string;
  readonly agentName: string;
  readonly agentId: string | null;
  readonly runs: number;
  readonly credits: number;
}

interface BuildUserInsightArgs {
  readonly networkData: UserNetworkData | undefined;
  readonly agents: AgentInfo[];
  readonly orgCreditsUsed: number;
  readonly orgCreditBalance: number;
  readonly orgTeamUsage: TeamUsageEntry[];
  readonly axiomDegraded: boolean;
}

interface WindowUsageData {
  readonly userAgentMap: Map<string, AgentInfo[]>;
  readonly orgCreditsMap: Map<string, OrgCreditsInfo>;
  readonly orgBalanceMap: Map<string, number>;
}

interface NetworkQueryResult {
  readonly userNetworkMap: Map<string, UserNetworkData>;
  readonly networkRows: number;
  readonly axiomDegraded: boolean;
}

interface CurrentOrgMemberScope {
  readonly orgsWithCurrentMembers: Set<string>;
  readonly memberKeys: Set<string>;
}

function normalizeDbDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function getPermissionLabel(
  firewallName: string,
  permissionName: string,
): string {
  const key = `${firewallName}:${permissionName}`;

  if (isFirewallConnectorType(firewallName)) {
    const config = getConnectorFirewall(firewallName);
    for (const api of config.apis) {
      if (!api.permissions) {
        continue;
      }
      for (const perm of api.permissions) {
        if (perm.name === permissionName) {
          return perm.description ?? key;
        }
      }
    }
  }

  return key;
}

async function resolveUserNames(
  db: Db,
  clerk: ClerkLike,
  userIds: string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const cachedUsers = await db
    .select({
      userId: userCache.userId,
      email: userCache.email,
      name: userCache.name,
    })
    .from(userCache)
    .where(inArray(userCache.userId, userIds));
  signal.throwIfAborted();

  const nameMap = new Map(
    cachedUsers.map((user) => {
      return [user.userId, user.name ?? user.email.split("@")[0] ?? user.email];
    }),
  );

  const missingIds = userIds.filter((id) => {
    return !nameMap.has(id);
  });
  if (missingIds.length === 0) {
    return nameMap;
  }

  const clerkUsers = await clerk.users.getUserList({
    userId: missingIds,
    limit: missingIds.length,
  });
  signal.throwIfAborted();

  const now = nowDate();
  for (const user of clerkUsers.data) {
    const primaryEmail = user.emailAddresses.find((email) => {
      return email.id === user.primaryEmailAddressId;
    });
    const email = primaryEmail?.emailAddress ?? "unknown";
    const name =
      user.firstName ?? user.username ?? email.split("@")[0] ?? "unknown";
    nameMap.set(user.id, name);

    await db
      .insert(userCache)
      .values({ userId: user.id, email, name, cachedAt: now })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: { email, name, cachedAt: now },
      });
    signal.throwIfAborted();
  }

  return nameMap;
}

function aggregateNetworkDataPerUser(
  networkRows: AxiomNetworkRow[],
  runIdToInfo: Map<
    string,
    {
      readonly orgId: string;
      readonly userId: string;
      readonly agentName: string;
    }
  >,
): Map<string, UserNetworkData> {
  const userNetworkMap = new Map<string, UserNetworkData>();

  for (const row of networkRows) {
    if (!isFirewallConnectorType(row.firewall_name)) {
      continue;
    }

    const info = runIdToInfo.get(row.runId);
    if (!info) {
      continue;
    }

    const key = `${info.orgId}:${info.userId}`;
    const userData = userNetworkMap.get(key) ?? {
      serviceMap: new Map<string, { calls: number; agentNames: Set<string> }>(),
      permMap: new Map<
        string,
        {
          label: string;
          connectorType: string;
          allowed: number;
          denied: number;
          agentNames: Set<string>;
        }
      >(),
    };
    userNetworkMap.set(key, userData);

    const service = userData.serviceMap.get(row.firewall_name) ?? {
      calls: 0,
      agentNames: new Set<string>(),
    };
    service.calls++;
    service.agentNames.add(info.agentName);
    userData.serviceMap.set(row.firewall_name, service);

    if (row.firewall_permission || row.action === "DENY") {
      const hasPermission = row.firewall_permission.length > 0;
      const permKey = hasPermission
        ? `${row.firewall_name}:${row.firewall_permission}`
        : row.firewall_name;
      const label = hasPermission
        ? getPermissionLabel(row.firewall_name, row.firewall_permission)
        : row.firewall_name;
      const permission = userData.permMap.get(permKey) ?? {
        label,
        connectorType: row.firewall_name,
        allowed: 0,
        denied: 0,
        agentNames: new Set<string>(),
      };
      if (row.action === "ALLOW") {
        permission.allowed++;
      } else if (row.action === "DENY") {
        permission.denied++;
      }
      permission.agentNames.add(info.agentName);
      userData.permMap.set(permKey, permission);
    }
  }

  return userNetworkMap;
}

function buildUserInsight(args: BuildUserInsightArgs): InsightData {
  const {
    networkData,
    agents,
    orgCreditsUsed,
    orgCreditBalance,
    orgTeamUsage,
    axiomDegraded,
  } = args;
  const services = networkData
    ? [...networkData.serviceMap.entries()]
        .map(([domain, service]) => {
          return {
            domain,
            calls: service.calls,
            agentNames: [...service.agentNames],
          };
        })
        .sort((a, b) => {
          return b.calls - a.calls;
        })
    : [];

  const permissions = networkData
    ? [...networkData.permMap.values()]
        .map((permission) => {
          return {
            label: permission.label,
            connectorType: permission.connectorType,
            allowed: permission.allowed,
            denied: permission.denied,
            agentNames: [...permission.agentNames],
          };
        })
        .sort((a, b) => {
          return b.allowed + b.denied - (a.allowed + a.denied);
        })
    : [];

  const topPermission = permissions[0];
  return {
    agents: agents.map((agent) => {
      return {
        agentName: agent.agentName,
        agentId: agent.agentId,
        runs: agent.runs,
        credits: agent.credits,
      };
    }),
    creditsUsed: orgCreditsUsed,
    creditBalance: orgCreditBalance,
    teamUsage: orgTeamUsage,
    topTask: topPermission
      ? {
          name: topPermission.label,
          count: topPermission.allowed + topPermission.denied,
        }
      : null,
    services,
    permissions,
    ...(axiomDegraded ? { axiomDegraded: true } : {}),
  };
}

function aggregateOrgCredits(
  memberRows: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentName: string;
    readonly credits: number;
  }[],
  userNameMap: Map<string, string>,
): Map<string, OrgCreditsInfo> {
  const memberAgg = new Map<
    string,
    Map<
      string,
      {
        credits: number;
        agentNames: Set<string>;
        agentCredits: Map<string, number>;
      }
    >
  >();

  for (const row of memberRows) {
    const orgMembers = memberAgg.get(row.orgId) ?? new Map();
    memberAgg.set(row.orgId, orgMembers);
    const existing = orgMembers.get(row.userId) ?? {
      credits: 0,
      agentNames: new Set<string>(),
      agentCredits: new Map<string, number>(),
    };
    const amount = Number(row.credits);
    existing.credits += amount;
    existing.agentNames.add(row.agentName);
    existing.agentCredits.set(
      row.agentName,
      (existing.agentCredits.get(row.agentName) ?? 0) + amount,
    );
    orgMembers.set(row.userId, existing);
  }

  const orgCreditsMap = new Map<string, OrgCreditsInfo>();
  for (const [orgId, members] of memberAgg) {
    let creditsUsed = 0;
    const teamUsage: TeamUsageEntry[] = [];
    for (const [userId, data] of members) {
      creditsUsed += data.credits;
      teamUsage.push({
        userId,
        name: userNameMap.get(userId) ?? userId,
        credits: data.credits,
        agentNames: [...data.agentNames],
        agentCredits: Object.fromEntries(data.agentCredits),
      });
    }
    teamUsage.sort((a, b) => {
      return b.credits - a.credits;
    });
    orgCreditsMap.set(orgId, { creditsUsed, teamUsage });
  }

  return orgCreditsMap;
}

function orgUserKey(args: OrgUserPair): string {
  return `${args.orgId}:${args.userId}`;
}

function isCurrentOrgMember(
  scope: CurrentOrgMemberScope,
  args: OrgUserPair,
): boolean {
  return (
    !scope.orgsWithCurrentMembers.has(args.orgId) ||
    scope.memberKeys.has(orgUserKey(args))
  );
}

async function queryCachedOrgIdsWithMembers(
  db: Db,
  orgIds: string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  if (orgIds.length === 0) {
    return new Set();
  }

  const rows = await db
    .select({
      orgId: orgMembersCache.orgId,
    })
    .from(orgMembersCache)
    .where(inArray(orgMembersCache.orgId, orgIds));
  signal.throwIfAborted();

  return new Set(
    rows.map((row) => {
      return row.orgId;
    }),
  );
}

async function queryClerkOrgMemberUserIds(
  clerk: ClerkLike,
  orgId: string,
  signal: AbortSignal,
): Promise<string[] | null> {
  const userIds: string[] = [];
  for (let offset = 0; ; offset += ORG_MEMBERSHIP_PAGE_SIZE) {
    const result = await settle(
      clerk.organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: ORG_MEMBERSHIP_PAGE_SIZE,
        offset,
      }),
    );
    signal.throwIfAborted();

    if (!result.ok) {
      L.warn("Failed to query Clerk organization memberships", {
        orgId,
        error:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
      });
      return null;
    }

    for (const membership of result.value.data) {
      const userId = membership.publicUserData?.userId;
      if (userId) {
        userIds.push(userId);
      }
    }

    if (result.value.data.length < ORG_MEMBERSHIP_PAGE_SIZE) {
      return userIds;
    }
  }
}

async function queryCurrentOrgMembers(
  db: Db,
  clerk: ClerkLike,
  orgIds: string[],
  signal: AbortSignal,
): Promise<CurrentOrgMemberScope> {
  const orgIdsWithCache = await queryCachedOrgIdsWithMembers(
    db,
    orgIds,
    signal,
  );
  const orgsWithCurrentMembers = new Set<string>();
  const memberKeys = new Set<string>();

  for (const orgId of orgIdsWithCache) {
    const memberUserIds = await queryClerkOrgMemberUserIds(
      clerk,
      orgId,
      signal,
    );
    if (!memberUserIds) {
      continue;
    }

    orgsWithCurrentMembers.add(orgId);
    for (const userId of memberUserIds) {
      memberKeys.add(orgUserKey({ orgId, userId }));
    }
  }

  return { orgsWithCurrentMembers, memberKeys };
}

function mergeActiveUserRows(rows: ActiveUserRow[]): ActiveUserRow[] {
  const byUser = new Map<string, ActiveUserRow>();
  for (const row of rows) {
    const normalizedRow = {
      ...row,
      lastActivity: normalizeDbDate(row.lastActivity),
    };
    const key = `${row.orgId}:${row.userId}`;
    const existing = byUser.get(key);
    if (!existing || normalizedRow.lastActivity > existing.lastActivity) {
      byUser.set(key, normalizedRow);
    }
  }
  return [...byUser.values()];
}

async function queryActiveUsers(
  db: Db,
  lookbackStart: Date,
  signal: AbortSignal,
): Promise<ActiveUserRow[]> {
  const [completedRuns, eventUsage] = await Promise.all([
    db
      .select({
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        lastActivity: sql<Date>`MAX(${agentRuns.completedAt})`.as(
          "last_activity",
        ),
      })
      .from(agentRuns)
      .where(
        and(
          gte(agentRuns.completedAt, lookbackStart),
          isNotNull(agentRuns.completedAt),
        ),
      )
      .groupBy(agentRuns.orgId, agentRuns.userId),
    db
      .select({
        orgId: usageEvent.orgId,
        userId: usageEvent.userId,
        lastActivity: sql<Date>`MAX(${usageEvent.processedAt})`.as(
          "last_activity",
        ),
      })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.status, "processed"),
          gte(usageEvent.processedAt, lookbackStart),
          isNotNull(usageEvent.processedAt),
        ),
      )
      .groupBy(usageEvent.orgId, usageEvent.userId),
  ]);
  signal.throwIfAborted();

  return mergeActiveUserRows([...completedRuns, ...eventUsage]);
}

function mergeAgentRows(
  runRows: RunCountRow[],
  creditRows: LedgerCreditRow[],
  users: OrgUserPair[],
): Map<string, AgentInfo[]> {
  const wantedUsers = new Set(
    users.map((user) => {
      return `${user.orgId}:${user.userId}`;
    }),
  );
  const byUser = new Map<string, Map<string, AgentInfo>>();

  const add = (contribution: AgentContribution) => {
    const { orgId, userId, agentName, agentId, runs, credits } = contribution;
    const userKey = `${orgId}:${userId}`;
    if (!wantedUsers.has(userKey)) {
      return;
    }

    const userAgents = byUser.get(userKey) ?? new Map<string, AgentInfo>();
    const agentKey = agentId ?? `unattributed:${agentName}`;
    const existing = userAgents.get(agentKey) ?? {
      agentId,
      agentName,
      runs: 0,
      credits: 0,
    };
    existing.agentName = agentName;
    existing.runs += runs;
    existing.credits += credits;
    userAgents.set(agentKey, existing);
    byUser.set(userKey, userAgents);
  };

  for (const row of runRows) {
    add({ ...row, credits: 0 });
  }
  for (const row of creditRows) {
    add({ ...row, runs: 0, credits: Number(row.credits) });
  }

  const result = new Map<string, AgentInfo[]>();
  for (const [userKey, agents] of byUser) {
    const list = [...agents.values()];
    list.sort((a, b) => {
      return (
        b.credits - a.credits ||
        b.runs - a.runs ||
        a.agentName.localeCompare(b.agentName)
      );
    });
    result.set(userKey, list);
  }
  return result;
}

async function queryCompletedRunCounts(
  db: Db,
  scope: WindowScope,
  signal: AbortSignal,
): Promise<RunCountRow[]> {
  const { orgIds, userIds, dayStart, dayEnd } = scope;
  const rows = await db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      agentId: zeroAgents.id,
      agentName:
        sql<string>`COALESCE(${zeroAgents.displayName}, ${zeroAgents.name})`.as(
          "agent_name",
        ),
      runs: sql<number>`COUNT(DISTINCT ${agentRuns.id})::int`.as("runs"),
    })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .innerJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .where(
      and(
        inArray(agentRuns.orgId, orgIds),
        inArray(agentRuns.userId, userIds),
        gte(agentRuns.completedAt, dayStart),
        lt(agentRuns.completedAt, dayEnd),
        isNotNull(agentRuns.completedAt),
      ),
    )
    .groupBy(
      agentRuns.orgId,
      agentRuns.userId,
      zeroAgents.id,
      zeroAgents.displayName,
      zeroAgents.name,
    );
  signal.throwIfAborted();

  return rows.map((row) => {
    return {
      orgId: row.orgId,
      userId: row.userId,
      agentId: row.agentId,
      agentName: row.agentName,
      runs: Number(row.runs),
    };
  });
}

async function queryUsageEventCreditRows(
  db: Db,
  orgIds: string[],
  dayStart: Date,
  dayEnd: Date,
  signal: AbortSignal,
): Promise<LedgerCreditRow[]> {
  const isRunless = sql`${usageEvent.runId} IS NULL`;
  const rows = await db
    .select({
      orgId: usageEvent.orgId,
      userId: usageEvent.userId,
      agentId: sql<
        string | null
      >`CASE WHEN ${isRunless} THEN NULL ELSE ${zeroAgents.id}::text END`.as(
        "agent_id",
      ),
      agentName:
        sql<string>`CASE WHEN ${isRunless} THEN ${OTHER_USAGE_AGENT_NAME} ELSE COALESCE(${zeroAgents.displayName}, ${zeroAgents.name}, 'Unknown agent') END`.as(
          "agent_name",
        ),
      credits:
        sql<number>`COALESCE(SUM(${usageEvent.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
    })
    .from(usageEvent)
    .leftJoin(agentRuns, eq(usageEvent.runId, agentRuns.id))
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .where(
      and(
        inArray(usageEvent.orgId, orgIds),
        eq(usageEvent.status, "processed"),
        gte(usageEvent.processedAt, dayStart),
        lt(usageEvent.processedAt, dayEnd),
        isNotNull(usageEvent.processedAt),
      ),
    )
    .groupBy(
      usageEvent.orgId,
      usageEvent.userId,
      isRunless,
      zeroAgents.id,
      zeroAgents.displayName,
      zeroAgents.name,
    );
  signal.throwIfAborted();

  return rows.map((row) => {
    return { ...row, credits: Number(row.credits) };
  });
}

async function queryNetworkRunAgentRows(
  db: Db,
  orgIds: string[],
  userIds: string[],
  runIds: string[],
  signal: AbortSignal,
): Promise<NetworkRunAgentRow[]> {
  const rows: NetworkRunAgentRow[] = [];
  for (let i = 0; i < runIds.length; i += NETWORK_RUN_ATTRIBUTION_BATCH_SIZE) {
    const batch = runIds.slice(i, i + NETWORK_RUN_ATTRIBUTION_BATCH_SIZE);
    rows.push(
      ...(await db
        .select({
          runId: agentRuns.id,
          orgId: agentRuns.orgId,
          userId: agentRuns.userId,
          agentName:
            sql<string>`COALESCE(${zeroAgents.displayName}, ${zeroAgents.name})`.as(
              "agent_name",
            ),
        })
        .from(agentRuns)
        .innerJoin(
          agentComposeVersions,
          eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
        )
        .innerJoin(
          zeroAgents,
          eq(agentComposeVersions.composeId, zeroAgents.id),
        )
        .where(
          and(
            inArray(agentRuns.orgId, orgIds),
            inArray(agentRuns.userId, userIds),
            inArray(agentRuns.id, batch),
          ),
        )),
    );
    signal.throwIfAborted();
  }
  return rows;
}

function windowScope(
  group: WindowGroup,
  currentOrgMembers: CurrentOrgMemberScope,
): WindowScope {
  const { dayStart, dayEnd, users } = group;
  return {
    dayStart,
    dayEnd,
    users,
    orgIds: [
      ...new Set(
        users.map((user) => {
          return user.orgId;
        }),
      ),
    ],
    userIds: [
      ...new Set(
        users.map((user) => {
          return user.userId;
        }),
      ),
    ],
    currentOrgMembers,
  };
}

async function loadWindowUsageData(
  db: Db,
  clerk: ClerkLike,
  scope: WindowScope,
  signal: AbortSignal,
): Promise<WindowUsageData> {
  const [runRows, ledgerCreditRows] = await Promise.all([
    queryCompletedRunCounts(db, scope, signal),
    queryUsageEventCreditRows(
      db,
      scope.orgIds,
      scope.dayStart,
      scope.dayEnd,
      signal,
    ),
  ]);
  signal.throwIfAborted();

  const currentMemberCreditRows = ledgerCreditRows.filter((row) => {
    return isCurrentOrgMember(scope.currentOrgMembers, row);
  });
  const userAgentMap = mergeAgentRows(
    runRows,
    currentMemberCreditRows,
    scope.users,
  );
  const allCreditUserIds = [
    ...new Set(
      currentMemberCreditRows.map((row) => {
        return row.userId;
      }),
    ),
  ];
  const userNameMap = await resolveUserNames(
    db,
    clerk,
    allCreditUserIds,
    signal,
  );
  const orgCreditsMap = aggregateOrgCredits(
    currentMemberCreditRows,
    userNameMap,
  );

  const balanceRows =
    scope.orgIds.length > 0
      ? await db
          .select({ orgId: orgMetadata.orgId, credits: orgMetadata.credits })
          .from(orgMetadata)
          .where(inArray(orgMetadata.orgId, scope.orgIds))
      : [];
  signal.throwIfAborted();

  return {
    userAgentMap,
    orgCreditsMap,
    orgBalanceMap: new Map(
      balanceRows.map((row) => {
        return [row.orgId, Number(row.credits)];
      }),
    ),
  };
}

function queryWindowNetworkData(
  db: Db,
  scope: WindowScope,
  signal: AbortSignal,
): Computed<Promise<NetworkQueryResult>> {
  return computed(async (get): Promise<NetworkQueryResult> => {
    const dataset = getDatasetName("sandbox-telemetry-network");
    const startIso = scope.dayStart.toISOString();
    const endIso = scope.dayEnd.toISOString();
    const apl = `['${dataset}']
| where _time >= datetime("${startIso}") and _time < datetime("${endIso}")
| where isnotnull(firewall_name) and firewall_name != ""
| project runId, host, firewall_name, firewall_permission, action
| limit 100000`;

    const axiomResult = await settle(
      (async (): Promise<AxiomNetworkRow[]> => {
        return [
          ...((await get(
            queryAxiom(apl),
          )) as unknown as readonly AxiomNetworkRow[]),
        ];
      })(),
    );
    const networkRows = axiomResult.ok ? axiomResult.value : [];
    const axiomDegraded = !axiomResult.ok;
    if (!axiomResult.ok) {
      L.error("Failed to query Axiom for network logs", {
        error:
          axiomResult.error instanceof Error
            ? axiomResult.error.message
            : String(axiomResult.error),
      });
    }
    signal.throwIfAborted();

    const networkRunIds = [
      ...new Set(
        networkRows
          .map((row) => {
            return row.runId;
          })
          .filter(Boolean),
      ),
    ];
    const runAgentRows =
      networkRunIds.length > 0
        ? await queryNetworkRunAgentRows(
            db,
            scope.orgIds,
            scope.userIds,
            networkRunIds,
            signal,
          )
        : [];

    const runIdToInfo = new Map<
      string,
      {
        readonly orgId: string;
        readonly userId: string;
        readonly agentName: string;
      }
    >();
    for (const row of runAgentRows) {
      runIdToInfo.set(row.runId, {
        orgId: row.orgId,
        userId: row.userId,
        agentName: row.agentName,
      });
    }

    return {
      userNetworkMap: aggregateNetworkDataPerUser(networkRows, runIdToInfo),
      networkRows: networkRows.length,
      axiomDegraded,
    };
  });
}

async function upsertWindowInsights(
  db: Db,
  group: WindowGroup,
  usageData: WindowUsageData,
  networkData: NetworkQueryResult,
  signal: AbortSignal,
): Promise<number> {
  let upserted = 0;
  for (const { orgId, userId } of group.users) {
    const key = `${orgId}:${userId}`;
    const data = buildUserInsight({
      networkData: networkData.userNetworkMap.get(key),
      agents: usageData.userAgentMap.get(key) ?? [],
      orgCreditsUsed: usageData.orgCreditsMap.get(orgId)?.creditsUsed ?? 0,
      orgCreditBalance: usageData.orgBalanceMap.get(orgId) ?? 0,
      orgTeamUsage: usageData.orgCreditsMap.get(orgId)?.teamUsage ?? [],
      axiomDegraded: networkData.axiomDegraded,
    });

    await db
      .insert(insightsDaily)
      .values({
        orgId,
        userId,
        date: group.targetDate,
        data,
        updatedAt: group.dayEnd,
      })
      .onConflictDoUpdate({
        target: [insightsDaily.orgId, insightsDaily.userId, insightsDaily.date],
        set: { data, updatedAt: group.dayEnd },
      });
    signal.throwIfAborted();
    upserted++;
  }
  return upserted;
}

function processWindowGroup(
  db: Db,
  clerk: ClerkLike,
  group: WindowGroup,
  currentOrgMembers: CurrentOrgMemberScope,
  signal: AbortSignal,
): Computed<
  Promise<{ readonly upserted: number; readonly networkRows: number }>
> {
  return computed(
    async (
      get,
    ): Promise<{ readonly upserted: number; readonly networkRows: number }> => {
      const scope = windowScope(group, currentOrgMembers);
      const usageData = await loadWindowUsageData(db, clerk, scope, signal);
      const networkData = await get(queryWindowNetworkData(db, scope, signal));
      const upserted = await upsertWindowInsights(
        db,
        group,
        usageData,
        networkData,
        signal,
      );
      return { upserted, networkRows: networkData.networkRows };
    },
  );
}

export const aggregateInsights$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<AggregateInsightsResult> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const now = nowDate();
    const lookbackStart = new Date(now.getTime() - 25 * 3_600_000);
    const activeUsers = await queryActiveUsers(db, lookbackStart, signal);

    if (activeUsers.length === 0) {
      L.debug("No users with new runs or ledger usage, skipping aggregation");
      return { users: 0, skipped: true };
    }

    const activeOrgIds = [
      ...new Set(
        activeUsers.map((user) => {
          return user.orgId;
        }),
      ),
    ];
    const activeUserIds = [
      ...new Set(
        activeUsers.map((user) => {
          return user.userId;
        }),
      ),
    ];
    const currentOrgMembers = await queryCurrentOrgMembers(
      db,
      clerk,
      activeOrgIds,
      signal,
    );

    const lastAggRows = await db
      .select({
        orgId: insightsDaily.orgId,
        userId: insightsDaily.userId,
        lastUpdated: sql<Date>`MAX(${insightsDaily.updatedAt})`.as(
          "last_updated",
        ),
      })
      .from(insightsDaily)
      .where(
        and(
          inArray(insightsDaily.orgId, activeOrgIds),
          inArray(insightsDaily.userId, activeUserIds),
        ),
      )
      .groupBy(insightsDaily.orgId, insightsDaily.userId);
    signal.throwIfAborted();

    const lastAggMap = new Map(
      lastAggRows.map((row) => {
        return [`${row.orgId}:${row.userId}`, normalizeDbDate(row.lastUpdated)];
      }),
    );

    const usersToAggregate = activeUsers.filter((user) => {
      const lastAgg = lastAggMap.get(`${user.orgId}:${user.userId}`);
      if (!lastAgg) {
        return true;
      }
      const lastCovered = new Date(
        lastAgg.getTime() - AGGREGATION_REPROCESS_OVERLAP_MS,
      );
      return user.lastActivity >= lastCovered;
    });

    if (usersToAggregate.length === 0) {
      L.debug("All active users are up to date");
      return { users: 0, skipped: true };
    }

    const userTimezoneMap = await resolveUserTimezones(
      db,
      usersToAggregate,
      signal,
    );
    const windowGroups = new Map<string, WindowGroup>();

    for (const { orgId, userId } of usersToAggregate) {
      const timezone = userTimezoneMap.get(`${orgId}:${userId}`) ?? "UTC";
      const { targetDate, dayStart, dayEnd } = getLocalToday(timezone, now);
      const windowKey = `${dayStart.toISOString()}|${dayEnd.toISOString()}`;
      const group = windowGroups.get(windowKey) ?? {
        dayStart,
        dayEnd,
        targetDate,
        users: [],
      };
      group.users.push({ orgId, userId });
      windowGroups.set(windowKey, group);
    }

    let upserted = 0;
    let totalNetworkRows = 0;
    for (const group of windowGroups.values()) {
      const result = await get(
        processWindowGroup(db, clerk, group, currentOrgMembers, signal),
      );
      signal.throwIfAborted();
      upserted += result.upserted;
      totalNetworkRows += result.networkRows;
    }

    L.debug("Aggregated insights", {
      users: upserted,
      windows: windowGroups.size,
      networkRows: totalNetworkRows,
    });

    return {
      users: upserted,
      windows: windowGroups.size,
      networkRows: totalNetworkRows,
    };
  },
);
