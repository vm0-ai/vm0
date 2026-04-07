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

  // Check user_cache first
  const cachedUsers = await db
    .select({ userId: userCache.userId, email: userCache.email })
    .from(userCache)
    .where(inArray(userCache.userId, userIds));

  const nameMap = new Map(
    cachedUsers.map((u) => {
      // Use the local part of the email as display name
      return [u.userId, u.email.split("@")[0] ?? u.email];
    }),
  );

  // Fetch missing from Clerk
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

      // Upsert into user_cache
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
// Network data aggregation
// ---------------------------------------------------------------------------

interface OrgNetworkData {
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

function aggregateNetworkData(
  networkRows: AxiomNetworkRow[],
  runIdToAgent: Map<string, { orgId: string; agentName: string }>,
): Map<string, OrgNetworkData> {
  const orgNetworkMap = new Map<string, OrgNetworkData>();

  for (const row of networkRows) {
    const agentInfo = runIdToAgent.get(row.runId);
    if (!agentInfo) continue;

    const { orgId, agentName } = agentInfo;

    if (!orgNetworkMap.has(orgId)) {
      orgNetworkMap.set(orgId, {
        serviceMap: new Map(),
        permMap: new Map(),
      });
    }
    const orgData = orgNetworkMap.get(orgId)!;

    // Service aggregation
    if (row.host) {
      const svc = orgData.serviceMap.get(row.host) ?? {
        calls: 0,
        agentNames: new Set<string>(),
      };
      svc.calls++;
      svc.agentNames.add(agentName);
      orgData.serviceMap.set(row.host, svc);
    }

    // Permission aggregation
    if (row.firewall_permission) {
      const permKey = `${row.firewall_ref}:${row.firewall_permission}`;
      const perm = orgData.permMap.get(permKey) ?? {
        label: getPermissionLabel(row.firewall_ref, row.firewall_permission),
        allowed: 0,
        denied: 0,
        agentNames: new Set<string>(),
      };
      if (row.action === "ALLOW") {
        perm.allowed++;
      } else if (row.action === "DENY") {
        perm.denied++;
      }
      perm.agentNames.add(agentName);
      orgData.permMap.set(permKey, perm);
    }
  }

  return orgNetworkMap;
}

// ---------------------------------------------------------------------------
// Per-org insight assembly
// ---------------------------------------------------------------------------

function buildOrgInsight(
  orgId: string,
  orgAgentMap: Map<string, AgentInfo[]>,
  orgMemberMap: Map<string, Array<{ name: string; credits: number }>>,
  orgBalanceMap: Map<string, number>,
  orgNetworkMap: Map<string, OrgNetworkData>,
): Record<string, unknown> {
  const agents = orgAgentMap.get(orgId) ?? [];
  const creditsUsed = agents.reduce((sum, a) => {
    return sum + a.credits;
  }, 0);
  const teamUsage = (orgMemberMap.get(orgId) ?? []).sort((a, b) => {
    return b.credits - a.credits;
  });

  const networkData = orgNetworkMap.get(orgId);

  const services = networkData
    ? [...networkData.serviceMap.entries()]
        .map(([host, svc]) => {
          return {
            name: host,
            domain: host,
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
    creditsUsed,
    creditBalance: orgBalanceMap.get(orgId) ?? 0,
    teamUsage,
    topTask,
    services,
    permissions,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  initServices();

  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const now = new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const targetDate = yesterday.toISOString().split("T")[0]!;

  const db = globalThis.services.db;

  // ── Step 1: Agent runs + credits per org ──────────────────────────────

  const agentRows = await db
    .select({
      orgId: agentRuns.orgId,
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
        gte(agentRuns.createdAt, yesterday),
        lt(agentRuns.createdAt, today),
        isNotNull(agentRuns.completedAt),
      ),
    )
    .groupBy(
      agentRuns.orgId,
      zeroAgents.id,
      zeroAgents.displayName,
      zeroAgents.name,
    );

  const orgAgentMap = new Map<string, AgentInfo[]>();
  for (const row of agentRows) {
    const list = orgAgentMap.get(row.orgId) ?? [];
    list.push({
      agentId: row.agentId,
      agentName: row.agentName,
      runs: row.runCount,
      credits: Number(row.credits),
    });
    orgAgentMap.set(row.orgId, list);
  }

  // ── Step 2: runId → agent mapping for Axiom cross-reference ───────────

  const runAgentRows = await db
    .select({
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
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
      and(gte(agentRuns.createdAt, yesterday), lt(agentRuns.createdAt, today)),
    );

  const runIdToAgent = new Map<string, { orgId: string; agentName: string }>();
  for (const row of runAgentRows) {
    runIdToAgent.set(row.runId, {
      orgId: row.orgId,
      agentName: row.agentName,
    });
  }

  // ── Step 3: Member credits per org ────────────────────────────────────

  const memberRows = await db
    .select({
      orgId: creditUsage.orgId,
      userId: creditUsage.userId,
      credits:
        sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
    })
    .from(creditUsage)
    .where(
      and(
        eq(creditUsage.status, "processed"),
        gte(creditUsage.createdAt, yesterday),
        lt(creditUsage.createdAt, today),
      ),
    )
    .groupBy(creditUsage.orgId, creditUsage.userId);

  const allUserIds = [
    ...new Set(
      memberRows.map((r) => {
        return r.userId;
      }),
    ),
  ];
  const userNameMap = await resolveUserNames(allUserIds);

  const orgMemberMap = new Map<
    string,
    Array<{ name: string; credits: number }>
  >();
  for (const row of memberRows) {
    const list = orgMemberMap.get(row.orgId) ?? [];
    list.push({
      name: userNameMap.get(row.userId) ?? row.userId,
      credits: Number(row.credits),
    });
    orgMemberMap.set(row.orgId, list);
  }

  // ── Step 4: Credit balances ───────────────────────────────────────────

  const allOrgIds = [
    ...new Set([...orgAgentMap.keys(), ...orgMemberMap.keys()]),
  ];

  const balanceRows =
    allOrgIds.length > 0
      ? await db
          .select({ orgId: orgMetadata.orgId, credits: orgMetadata.credits })
          .from(orgMetadata)
          .where(inArray(orgMetadata.orgId, allOrgIds))
      : [];

  const orgBalanceMap = new Map(
    balanceRows.map((r) => {
      return [r.orgId, Number(r.credits)];
    }),
  );

  // ── Step 5: Axiom network logs ────────────────────────────────────────

  const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
  const startIso = yesterday.toISOString();
  const endIso = today.toISOString();

  const apl = `['${dataset}']
| where _time >= datetime("${startIso}") and _time < datetime("${endIso}")
| where isnotnull(firewall_ref) and firewall_ref != ""
| project runId, host, firewall_ref, firewall_permission, action
| limit 100000`;

  let networkRows: AxiomNetworkRow[] = [];
  try {
    networkRows = await queryAxiom<AxiomNetworkRow>(apl);
  } catch (error) {
    log.error("Failed to query Axiom for network logs", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Step 6: Aggregate network data + upsert per org ──────────────────

  const orgNetworkMap = aggregateNetworkData(networkRows, runIdToAgent);

  const activeOrgIds = new Set([
    ...orgAgentMap.keys(),
    ...orgMemberMap.keys(),
    ...orgNetworkMap.keys(),
  ]);

  let upserted = 0;

  for (const orgId of activeOrgIds) {
    const data = buildOrgInsight(
      orgId,
      orgAgentMap,
      orgMemberMap,
      orgBalanceMap,
      orgNetworkMap,
    );

    await db
      .insert(insightsDaily)
      .values({ orgId, date: targetDate, data })
      .onConflictDoUpdate({
        target: [insightsDaily.orgId, insightsDaily.date],
        set: { data, updatedAt: new Date() },
      });

    upserted++;
  }

  log.info(`Aggregated insights for ${targetDate}`, {
    orgs: upserted,
    networkRows: networkRows.length,
  });

  return NextResponse.json({
    date: targetDate,
    orgs: upserted,
    networkRows: networkRows.length,
  });
}
