import { NextResponse } from "next/server";
import { sql, and, eq, gte, lt, inArray, isNotNull } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/shared/logger";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { agentComposeVersions } from "../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { creditUsage } from "../../../../src/db/schema/credit-usage";
import { orgMetadata } from "../../../../src/db/schema/org-metadata";
import { orgMembersMetadata } from "../../../../src/db/schema/org-members-metadata";
import { userCache } from "../../../../src/db/schema/user-cache";
import { insightsDaily } from "../../../../src/db/schema/insights-daily";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../src/lib/shared/axiom";
import { getConnectorFirewall, isFirewallConnectorType } from "@vm0/core";
import { clerkClient } from "@clerk/nextjs/server";

const log = logger("cron:aggregate-insights");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentInfo {
  agentId: string;
  agentName: string;
  runs: number;
  credits: number;
}

interface AxiomNetworkRow {
  _time: string;
  runId: string;
  host: string;
  firewall_ref: string;
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

// ---------------------------------------------------------------------------
// Permission label resolution
// ---------------------------------------------------------------------------

const permissionLabelCache = new Map<string, string>();

function getPermissionLabel(
  firewallRef: string,
  permissionName: string,
): string {
  const key = `${firewallRef}:${permissionName}`;
  const cached = permissionLabelCache.get(key);
  if (cached) return cached;

  if (isFirewallConnectorType(firewallRef)) {
    const config = getConnectorFirewall(firewallRef);
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
    .select({ userId: userCache.userId, email: userCache.email })
    .from(userCache)
    .where(inArray(userCache.userId, userIds));

  const nameMap = new Map(
    cachedUsers.map((u) => {
      return [u.userId, u.email.split("@")[0] ?? u.email];
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
        .values({ userId: user.id, email, cachedAt: now })
        .onConflictDoUpdate({
          target: userCache.userId,
          set: { email, cachedAt: now },
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
    if (!isFirewallConnectorType(row.firewall_ref)) continue;

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

    const connectorKey = row.firewall_ref;
    const svc = userData.serviceMap.get(connectorKey) ?? {
      calls: 0,
      agentNames: new Set<string>(),
    };
    svc.calls++;
    svc.agentNames.add(info.agentName);
    userData.serviceMap.set(connectorKey, svc);

    if (row.firewall_permission) {
      const isUnrestricted = row.firewall_permission === "unrestricted";
      const permKey = isUnrestricted
        ? row.firewall_ref
        : `${row.firewall_ref}:${row.firewall_permission}`;
      const label = isUnrestricted
        ? row.firewall_ref
        : getPermissionLabel(row.firewall_ref, row.firewall_permission);
      const perm = userData.permMap.get(permKey) ?? {
        label,
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
    agentId: string;
    runs: number;
    credits: number;
  }[];
  creditsUsed: number;
  creditBalance: number;
  teamUsage: {
    name: string;
    credits: number;
    agentNames: string[];
    agentCredits: Record<string, number>;
  }[];
  topTask: { name: string; count: number } | null;
  services: {
    name: string;
    domain: string;
    calls: number;
    agentNames: string[];
  }[];
  permissions: {
    label: string;
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
          const config = isFirewallConnectorType(connectorKey)
            ? getConnectorFirewall(connectorKey)
            : null;
          return {
            name: config?.name ?? connectorKey,
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
  name: string;
  credits: number;
  agentNames: string[];
  agentCredits: Record<string, number>;
}

interface OrgCreditsInfo {
  creditsUsed: number;
  teamUsage: TeamUsageEntry[];
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

  // ── Agent runs per user ────────────────────────────────────────────

  const agentRows = await db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      agentId: zeroAgents.id,
      agentName:
        sql<string>`COALESCE(${zeroAgents.displayName}, ${zeroAgents.name})`.as(
          "agent_name",
        ),
      runCount: sql<number>`COUNT(DISTINCT ${agentRuns.id})::int`.as(
        "run_count",
      ),
      credits:
        sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
    })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .innerJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .leftJoin(
      creditUsage,
      and(
        eq(creditUsage.runId, agentRuns.id),
        eq(creditUsage.status, "processed"),
      ),
    )
    .where(
      and(
        inArray(agentRuns.orgId, orgIds),
        inArray(agentRuns.userId, userIds),
        gte(agentRuns.createdAt, dayStart),
        lt(agentRuns.createdAt, dayEnd),
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

  // key: `orgId:userId`
  const userAgentMap = new Map<string, AgentInfo[]>();
  for (const row of agentRows) {
    const key = `${row.orgId}:${row.userId}`;
    const list = userAgentMap.get(key) ?? [];
    list.push({
      agentId: row.agentId,
      agentName: row.agentName,
      runs: row.runCount,
      credits: Number(row.credits),
    });
    userAgentMap.set(key, list);
  }

  // ── runId → user mapping for Axiom cross-reference ─────────────────

  const runAgentRows = await db
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
    .innerJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .where(
      and(
        inArray(agentRuns.orgId, orgIds),
        inArray(agentRuns.userId, userIds),
        gte(agentRuns.createdAt, dayStart),
        lt(agentRuns.createdAt, dayEnd),
      ),
    );

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

  // ── Org-wide credits with agent breakdown ────────────────────────────

  const memberRows = await db
    .select({
      orgId: creditUsage.orgId,
      userId: creditUsage.userId,
      agentName:
        sql<string>`COALESCE(${zeroAgents.displayName}, ${zeroAgents.name})`.as(
          "agent_name",
        ),
      credits:
        sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
    })
    .from(creditUsage)
    .innerJoin(agentRuns, eq(creditUsage.runId, agentRuns.id))
    .innerJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .innerJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .where(
      and(
        inArray(creditUsage.orgId, orgIds),
        eq(creditUsage.status, "processed"),
        gte(creditUsage.createdAt, dayStart),
        lt(creditUsage.createdAt, dayEnd),
      ),
    )
    .groupBy(
      creditUsage.orgId,
      creditUsage.userId,
      zeroAgents.displayName,
      zeroAgents.name,
    );

  const allCreditUserIds = [
    ...new Set(
      memberRows.map((r) => {
        return r.userId;
      }),
    ),
  ];
  const userNameMap = await resolveUserNames(allCreditUserIds);
  const orgCreditsMap = aggregateOrgCredits(memberRows, userNameMap);

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
| where isnotnull(firewall_ref) and firewall_ref != ""
| project runId, host, firewall_ref, firewall_permission, action
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

    await db
      .insert(insightsDaily)
      .values({ orgId, userId, date: targetDate, data })
      .onConflictDoUpdate({
        target: [insightsDaily.orgId, insightsDaily.userId, insightsDaily.date],
        set: { data, updatedAt: new Date() },
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

  // ── Step 1: Find (org, user) pairs with new completed runs ─────────────
  // 25h lookback covers "today" in all timezones (UTC-12 to UTC+14)

  const lookbackStart = new Date(now.getTime() - 25 * 3600_000);

  const activeUsers = await db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      lastCompleted: sql<Date>`MAX(${agentRuns.completedAt})`.as(
        "last_completed",
      ),
    })
    .from(agentRuns)
    .where(
      and(
        gte(agentRuns.completedAt, lookbackStart),
        isNotNull(agentRuns.completedAt),
      ),
    )
    .groupBy(agentRuns.orgId, agentRuns.userId);

  if (activeUsers.length === 0) {
    log.info("No users with new runs, skipping aggregation");
    return NextResponse.json({ users: 0, skipped: true });
  }

  // ── Step 1b: Filter out users whose last run is older than last aggregation

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
      return [`${r.orgId}:${r.userId}`, r.lastUpdated];
    }),
  );

  const usersToAggregate = activeUsers.filter((u) => {
    const lastAgg = lastAggMap.get(`${u.orgId}:${u.userId}`);
    if (!lastAgg) return true;
    return u.lastCompleted > lastAgg;
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
