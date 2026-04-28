import { NextResponse } from "next/server";
import { sql, and, eq, gte, lt, inArray, isNotNull } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/shared/logger";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../src/lib/shared/axiom";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import { clerkClient } from "@clerk/nextjs/server";

const log = logger("cron:aggregate-insights");
const OTHER_USAGE_AGENT_NAME = "Other usage";
const NETWORK_RUN_ATTRIBUTION_BATCH_SIZE = 10_000;
const AGGREGATION_REPROCESS_OVERLAP_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentInfo {
  agentId: string | null;
  agentName: string;
  runs: number;
  credits: number;
}

interface AxiomNetworkRow {
  _time: string;
  runId: string;
  host: string;
  firewall_name: string;
  firewall_permission: string;
  action: string;
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/** Resolve per-user timezones from org_members_metadata. */
async function resolveUserTimezones(
  orgUserPairs: Array<{ orgId: string; userId: string }>,
): Promise<Map<string, string>> {
  if (orgUserPairs.length === 0) return new Map();

  const db = globalThis.services.db;
  const userIds = [
    ...new Set(
      orgUserPairs.map((p) => {
        return p.userId;
      }),
    ),
  ];

  const rows = await db
    .select({
      orgId: orgMembersMetadata.orgId,
      userId: orgMembersMetadata.userId,
      timezone: orgMembersMetadata.timezone,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        inArray(orgMembersMetadata.userId, userIds),
        isNotNull(orgMembersMetadata.timezone),
      ),
    );

  // key: `orgId:userId` → timezone
  const tzMap = new Map<string, string>();
  for (const row of rows) {
    if (row.timezone) {
      tzMap.set(`${row.orgId}:${row.userId}`, row.timezone);
    }
  }

  return tzMap;
}

function getLocalDayStartUtc(timezone: string, now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const localMidnight = new Date(`${parts}T00:00:00`);
  const utcStr = localMidnight.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = localMidnight.toLocaleString("en-US", { timeZone: timezone });
  const utcDate = new Date(utcStr);
  const tzDate = new Date(tzStr);
  const offsetMs = utcDate.getTime() - tzDate.getTime();
  return new Date(localMidnight.getTime() + offsetMs);
}

/** Get "today" window in a given timezone: from local midnight to now. */
function getLocalToday(
  timezone: string,
  now: Date,
): { targetDate: string; dayStart: Date; dayEnd: Date } {
  const dayStart = getLocalDayStartUtc(timezone, now);
  const dayEnd = now;
  const targetDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { targetDate, dayStart, dayEnd };
}

function normalizeDbDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

// ---------------------------------------------------------------------------
// Permission label resolution
// ---------------------------------------------------------------------------

const permissionLabelCache = new Map<string, string>();

function getPermissionLabel(
  firewallName: string,
  permissionName: string,
): string {
  const key = `${firewallName}:${permissionName}`;
  const cached = permissionLabelCache.get(key);
  if (cached) return cached;

  if (isFirewallConnectorType(firewallName)) {
    const config = getConnectorFirewall(firewallName);
    for (const api of config.apis) {
      if (!api.permissions) continue;
      for (const perm of api.permissions) {
        if (perm.name === permissionName) {
          const label = perm.description ?? key;
          permissionLabelCache.set(key, label);
          return label;
        }
      }
    }
  }

  permissionLabelCache.set(key, key);
  return key;
}

// ---------------------------------------------------------------------------
// User name resolution
// ---------------------------------------------------------------------------

async function resolveUserNames(
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();

  const db = globalThis.services.db;

  const cachedUsers = await db
    .select({
      userId: userCache.userId,
      email: userCache.email,
      name: userCache.name,
    })
    .from(userCache)
    .where(inArray(userCache.userId, userIds));

  const nameMap = new Map(
    cachedUsers.map((u) => {
      return [u.userId, u.name ?? u.email.split("@")[0] ?? u.email];
    }),
  );

  const missingIds = userIds.filter((id) => {
    return !nameMap.has(id);
  });
  if (missingIds.length > 0) {
    const client = await clerkClient();
    const clerkUsers = await client.users.getUserList({
      userId: missingIds,
      limit: missingIds.length,
    });

    const now = new Date();
    for (const user of clerkUsers.data) {
      const primaryEmail = user.emailAddresses.find((e) => {
        return e.id === user.primaryEmailAddressId;
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
    }
  }

  return nameMap;
}

// ---------------------------------------------------------------------------
// Network data aggregation (per-user)
// ---------------------------------------------------------------------------

interface UserNetworkData {
  serviceMap: Map<string, { calls: number; agentNames: Set<string> }>;
  permMap: Map<
    string,
    {
      label: string;
      connectorType: string;
      allowed: number;
      denied: number;
      agentNames: Set<string>;
    }
  >;
}

function aggregateNetworkDataPerUser(
  networkRows: AxiomNetworkRow[],
  runIdToInfo: Map<
    string,
    { orgId: string; userId: string; agentName: string }
  >,
): Map<string, UserNetworkData> {
  const userNetworkMap = new Map<string, UserNetworkData>();

  for (const row of networkRows) {
    if (!isFirewallConnectorType(row.firewall_name)) continue;

    const info = runIdToInfo.get(row.runId);
    if (!info) continue;

    const key = `${info.orgId}:${info.userId}`;

    if (!userNetworkMap.has(key)) {
      userNetworkMap.set(key, {
        serviceMap: new Map(),
        permMap: new Map(),
      });
    }
    const userData = userNetworkMap.get(key)!;

    const connectorKey = row.firewall_name;
    const svc = userData.serviceMap.get(connectorKey) ?? {
      calls: 0,
      agentNames: new Set<string>(),
    };
    svc.calls++;
    svc.agentNames.add(info.agentName);
    userData.serviceMap.set(connectorKey, svc);

    if (row.firewall_permission || row.action === "DENY") {
      const hasPerm = !!row.firewall_permission;
      const permKey = hasPerm
        ? `${row.firewall_name}:${row.firewall_permission}`
        : row.firewall_name;
      const label = hasPerm
        ? getPermissionLabel(row.firewall_name, row.firewall_permission)
        : row.firewall_name;
      const perm = userData.permMap.get(permKey) ?? {
        label,
        connectorType: row.firewall_name,
        allowed: 0,
        denied: 0,
        agentNames: new Set<string>(),
      };
      if (row.action === "ALLOW") {
        perm.allowed++;
      } else if (row.action === "DENY") {
        perm.denied++;
      }
      perm.agentNames.add(info.agentName);
      userData.permMap.set(permKey, perm);
    }
  }

  return userNetworkMap;
}

// ---------------------------------------------------------------------------
// Per-user insight assembly
// ---------------------------------------------------------------------------

interface InsightData {
  agents: {
    agentName: string;
    agentId: string | null;
    runs: number;
    credits: number;
  }[];
  creditsUsed: number;
  creditBalance: number;
  teamUsage: {
    userId: string;
    name: string;
    credits: number;
    agentNames: string[];
    agentCredits: Record<string, number>;
  }[];
  topTask: { name: string; count: number } | null;
  services: {
    domain: string;
    calls: number;
    agentNames: string[];
  }[];
  permissions: {
    label: string;
    connectorType: string;
    allowed: number;
    denied: number;
    agentNames: string[];
  }[];
  axiomDegraded?: boolean;
}

function buildUserInsight(
  networkData: UserNetworkData | undefined,
  agents: AgentInfo[],
  orgCreditsUsed: number,
  orgCreditBalance: number,
  orgTeamUsage: Array<{
    userId: string;
    name: string;
    credits: number;
    agentNames: string[];
    agentCredits: Record<string, number>;
  }>,
  axiomDegraded?: boolean,
): InsightData {
  const services = networkData
    ? [...networkData.serviceMap.entries()]
        .map(([connectorKey, svc]) => {
          return {
            domain: connectorKey,
            calls: svc.calls,
            agentNames: [...svc.agentNames],
          };
        })
        .sort((a, b) => {
          return b.calls - a.calls;
        })
    : [];

  const permissions = networkData
    ? [...networkData.permMap.values()]
        .map((p) => {
          return {
            label: p.label,
            connectorType: p.connectorType,
            allowed: p.allowed,
            denied: p.denied,
            agentNames: [...p.agentNames],
          };
        })
        .sort((a, b) => {
          return b.allowed + b.denied - (a.allowed + a.denied);
        })
    : [];

  const topPerm = permissions[0];
  const topTask = topPerm
    ? { name: topPerm.label, count: topPerm.allowed + topPerm.denied }
    : null;

  return {
    agents: agents.map((a) => {
      return {
        agentName: a.agentName,
        agentId: a.agentId,
        runs: a.runs,
        credits: a.credits,
      };
    }),
    creditsUsed: orgCreditsUsed,
    creditBalance: orgCreditBalance,
    teamUsage: orgTeamUsage,
    topTask,
    services,
    permissions,
    ...(axiomDegraded ? { axiomDegraded: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Credit aggregation
// ---------------------------------------------------------------------------

interface TeamUsageEntry {
  userId: string;
  name: string;
  credits: number;
  agentNames: string[];
  agentCredits: Record<string, number>;
}

interface OrgCreditsInfo {
  creditsUsed: number;
  teamUsage: TeamUsageEntry[];
}

interface LedgerCreditRow {
  orgId: string;
  userId: string;
  agentId: string | null;
  agentName: string;
  credits: number;
}

interface RunCountRow {
  orgId: string;
  userId: string;
  agentId: string;
  agentName: string;
  runs: number;
}

interface ActiveUserRow {
  orgId: string;
  userId: string;
  lastActivity: Date;
}

interface NetworkRunAgentRow {
  runId: string;
  orgId: string;
  userId: string;
  agentName: string;
}

function aggregateOrgCredits(
  memberRows: {
    orgId: string;
    userId: string;
    agentName: string;
    credits: number;
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
    if (!memberAgg.has(row.orgId)) {
      memberAgg.set(row.orgId, new Map());
    }
    const orgMembers = memberAgg.get(row.orgId)!;
    const existing = orgMembers.get(row.userId) ?? {
      credits: 0,
      agentNames: new Set<string>(),
      agentCredits: new Map<string, number>(),
    };
    const amt = Number(row.credits);
    existing.credits += amt;
    existing.agentNames.add(row.agentName);
    existing.agentCredits.set(
      row.agentName,
      (existing.agentCredits.get(row.agentName) ?? 0) + amt,
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

async function queryActiveUsers(lookbackStart: Date): Promise<ActiveUserRow[]> {
  const db = globalThis.services.db;
  const [completedRuns, legacyUsage, eventUsage] = await Promise.all([
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
        orgId: creditUsage.orgId,
        userId: creditUsage.userId,
        lastActivity: sql<Date>`MAX(${creditUsage.processedAt})`.as(
          "last_activity",
        ),
      })
      .from(creditUsage)
      .where(
        and(
          eq(creditUsage.status, "processed"),
          gte(creditUsage.processedAt, lookbackStart),
          isNotNull(creditUsage.processedAt),
        ),
      )
      .groupBy(creditUsage.orgId, creditUsage.userId),
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

  return mergeActiveUserRows([...completedRuns, ...legacyUsage, ...eventUsage]);
}

function mergeAgentRows(
  runRows: RunCountRow[],
  creditRows: LedgerCreditRow[],
  users: Array<{ orgId: string; userId: string }>,
): Map<string, AgentInfo[]> {
  const wantedUsers = new Set(
    users.map((user) => {
      return `${user.orgId}:${user.userId}`;
    }),
  );
  const byUser = new Map<string, Map<string, AgentInfo>>();

  const add = (
    orgId: string,
    userId: string,
    agentName: string,
    agentId: string | null,
    runs: number,
    credits: number,
  ) => {
    const userKey = `${orgId}:${userId}`;
    if (!wantedUsers.has(userKey)) return;

    const userAgents = byUser.get(userKey) ?? new Map<string, AgentInfo>();
    const agentKey = agentId ?? `unattributed:${agentName}`;
    const existing = userAgents.get(agentKey) ?? {
      agentId,
      agentName,
      runs: 0,
      credits: 0,
    };
    existing.agentId = existing.agentId ?? agentId;
    existing.runs += runs;
    existing.credits += credits;
    userAgents.set(agentKey, existing);
    byUser.set(userKey, userAgents);
  };

  for (const row of runRows) {
    add(row.orgId, row.userId, row.agentName, row.agentId, row.runs, 0);
  }
  for (const row of creditRows) {
    add(
      row.orgId,
      row.userId,
      row.agentName,
      row.agentId,
      0,
      Number(row.credits),
    );
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
  db: typeof globalThis.services.db,
  orgIds: string[],
  userIds: string[],
  dayStart: Date,
  dayEnd: Date,
): Promise<RunCountRow[]> {
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

async function queryLegacyCreditRows(
  db: typeof globalThis.services.db,
  orgIds: string[],
  dayStart: Date,
  dayEnd: Date,
): Promise<LedgerCreditRow[]> {
  const isRunless = sql`${creditUsage.runId} IS NULL`;
  const rows = await db
    .select({
      orgId: creditUsage.orgId,
      userId: creditUsage.userId,
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
        sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
    })
    .from(creditUsage)
    .leftJoin(agentRuns, eq(creditUsage.runId, agentRuns.id))
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .where(
      and(
        inArray(creditUsage.orgId, orgIds),
        eq(creditUsage.status, "processed"),
        gte(creditUsage.processedAt, dayStart),
        lt(creditUsage.processedAt, dayEnd),
        isNotNull(creditUsage.processedAt),
      ),
    )
    .groupBy(
      creditUsage.orgId,
      creditUsage.userId,
      isRunless,
      zeroAgents.id,
      zeroAgents.displayName,
      zeroAgents.name,
    );

  return rows.map((row) => {
    return { ...row, credits: Number(row.credits) };
  });
}

async function queryUsageEventCreditRows(
  db: typeof globalThis.services.db,
  orgIds: string[],
  dayStart: Date,
  dayEnd: Date,
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

  return rows.map((row) => {
    return { ...row, credits: Number(row.credits) };
  });
}

async function queryLedgerCreditRows(
  db: typeof globalThis.services.db,
  orgIds: string[],
  dayStart: Date,
  dayEnd: Date,
): Promise<LedgerCreditRow[]> {
  const [legacyRows, eventRows] = await Promise.all([
    queryLegacyCreditRows(db, orgIds, dayStart, dayEnd),
    queryUsageEventCreditRows(db, orgIds, dayStart, dayEnd),
  ]);
  return [...legacyRows, ...eventRows];
}

async function queryNetworkRunAgentRows(
  db: typeof globalThis.services.db,
  orgIds: string[],
  userIds: string[],
  runIds: string[],
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
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Window group processing
// ---------------------------------------------------------------------------

interface WindowGroup {
  dayStart: Date;
  dayEnd: Date;
  targetDate: string;
  users: Array<{ orgId: string; userId: string }>;
}

async function processWindowGroup(
  db: typeof globalThis.services.db,
  group: WindowGroup,
): Promise<{ upserted: number; networkRows: number }> {
  const { dayStart, dayEnd, targetDate, users } = group;
  const orgIds = [
    ...new Set(
      users.map((u) => {
        return u.orgId;
      }),
    ),
  ];
  const userIds = [
    ...new Set(
      users.map((u) => {
        return u.userId;
      }),
    ),
  ];

  // ── Completed runs and processed ledger credits ─────────────────────

  const [runRows, ledgerCreditRows] = await Promise.all([
    queryCompletedRunCounts(db, orgIds, userIds, dayStart, dayEnd),
    queryLedgerCreditRows(db, orgIds, dayStart, dayEnd),
  ]);
  const userAgentMap = mergeAgentRows(runRows, ledgerCreditRows, users);

  const allCreditUserIds = [
    ...new Set(
      ledgerCreditRows.map((r) => {
        return r.userId;
      }),
    ),
  ];
  const userNameMap = await resolveUserNames(allCreditUserIds);
  const orgCreditsMap = aggregateOrgCredits(ledgerCreditRows, userNameMap);

  // ── Credit balances ────────────────────────────────────────────────

  const balanceRows =
    orgIds.length > 0
      ? await db
          .select({ orgId: orgMetadata.orgId, credits: orgMetadata.credits })
          .from(orgMetadata)
          .where(inArray(orgMetadata.orgId, orgIds))
      : [];

  const orgBalanceMap = new Map(
    balanceRows.map((r) => {
      return [r.orgId, Number(r.credits)];
    }),
  );

  // ── Axiom network logs ─────────────────────────────────────────────

  const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
  const startIso = dayStart.toISOString();
  const endIso = dayEnd.toISOString();

  const apl = `['${dataset}']
| where _time >= datetime("${startIso}") and _time < datetime("${endIso}")
| where isnotnull(firewall_name) and firewall_name != ""
| project runId, host, firewall_name, firewall_permission, action
| limit 100000`;

  let networkRows: AxiomNetworkRow[] = [];
  let axiomDegraded = false;
  try {
    networkRows = await queryAxiom<AxiomNetworkRow>(apl);
  } catch (error) {
    axiomDegraded = true;
    log.error("Failed to query Axiom for network logs", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Network rows are already time-windowed by Axiom `_time`; use `runId` only
  // for attribution so old runs with current-day network activity still map.
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
      ? await queryNetworkRunAgentRows(db, orgIds, userIds, networkRunIds)
      : [];

  const runIdToInfo = new Map<
    string,
    { orgId: string; userId: string; agentName: string }
  >();
  for (const row of runAgentRows) {
    runIdToInfo.set(row.runId, {
      orgId: row.orgId,
      userId: row.userId,
      agentName: row.agentName,
    });
  }

  const userNetworkMap = aggregateNetworkDataPerUser(networkRows, runIdToInfo);

  // ── Upsert per user ────────────────────────────────────────────────

  let upserted = 0;
  for (const { orgId, userId } of users) {
    const key = `${orgId}:${userId}`;
    const agents = userAgentMap.get(key) ?? [];
    const orgCredits = orgCreditsMap.get(orgId);
    const networkData = userNetworkMap.get(key);

    const data = buildUserInsight(
      networkData,
      agents,
      orgCredits?.creditsUsed ?? 0,
      orgBalanceMap.get(orgId) ?? 0,
      orgCredits?.teamUsage ?? [],
      axiomDegraded,
    );

    // `updatedAt` is the aggregation watermark. Keep it at the window end so
    // rows landing after this snapshot are picked up by the next cron run.
    await db
      .insert(insightsDaily)
      .values({ orgId, userId, date: targetDate, data, updatedAt: dayEnd })
      .onConflictDoUpdate({
        target: [insightsDaily.orgId, insightsDaily.userId, insightsDaily.date],
        set: { data, updatedAt: dayEnd },
      });

    upserted++;
  }

  return { upserted, networkRows: networkRows.length };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const db = globalThis.services.db;
  const now = new Date();

  // ── Step 1: Find (org, user) pairs with new completed runs or ledger usage
  // 25h lookback covers "today" in all timezones (UTC-12 to UTC+14)

  const lookbackStart = new Date(now.getTime() - 25 * 3600_000);

  const activeUsers = await queryActiveUsers(lookbackStart);

  if (activeUsers.length === 0) {
    log.info("No users with new runs or ledger usage, skipping aggregation");
    return NextResponse.json({ users: 0, skipped: true });
  }

  // ── Step 1b: Filter out users whose latest activity predates aggregation

  const activeOrgIds = [
    ...new Set(
      activeUsers.map((u) => {
        return u.orgId;
      }),
    ),
  ];
  const activeUserIds = [
    ...new Set(
      activeUsers.map((u) => {
        return u.userId;
      }),
    ),
  ];

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

  const lastAggMap = new Map(
    lastAggRows.map((r) => {
      return [`${r.orgId}:${r.userId}`, normalizeDbDate(r.lastUpdated)];
    }),
  );

  const usersToAggregate = activeUsers.filter((u) => {
    const lastAgg = lastAggMap.get(`${u.orgId}:${u.userId}`);
    if (!lastAgg) return true;
    // Reprocess a small overlap around the previous watermark so rows committed
    // near the snapshot boundary are not skipped by the activity prefilter.
    const lastCovered = new Date(
      lastAgg.getTime() - AGGREGATION_REPROCESS_OVERLAP_MS,
    );
    return u.lastActivity >= lastCovered;
  });

  if (usersToAggregate.length === 0) {
    log.info("All active users are up to date");
    return NextResponse.json({ users: 0, skipped: true });
  }

  // ── Step 2: Resolve per-user timezones ─────────────────────────────────

  const userTzMap = await resolveUserTimezones(usersToAggregate);

  // Group users by their "today" time window
  const windowGroups = new Map<string, WindowGroup>();

  for (const { orgId, userId } of usersToAggregate) {
    const tz = userTzMap.get(`${orgId}:${userId}`) ?? "UTC";
    const { targetDate, dayStart, dayEnd } = getLocalToday(tz, now);
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

  // ── Step 3: Process each time window ───────────────────────────────────

  let upserted = 0;
  let totalNetworkRows = 0;

  for (const group of windowGroups.values()) {
    const result = await processWindowGroup(db, group);
    upserted += result.upserted;
    totalNetworkRows += result.networkRows;
  }

  log.info("Aggregated insights", {
    users: upserted,
    windows: windowGroups.size,
    networkRows: totalNetworkRows,
  });

  return NextResponse.json({
    users: upserted,
    windows: windowGroups.size,
    networkRows: totalNetworkRows,
  });
}
