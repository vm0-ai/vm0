import { eq, and, inArray, sum, lte, gte } from "drizzle-orm";
import { creditUsage } from "../../../db/schema/credit-usage";
import { proxyCreditUsage } from "../../../db/schema/proxy-credit-usage";
import { agentRuns } from "../../../db/schema/agent-run";
import { logger } from "../../shared/logger";

const log = logger("service:proxy-usage-comparison");

/**
 * Compare proxy-observed usage against client-reported usage for recently
 * completed runs.  Designed to run as a standalone cron job, decoupled from
 * credit processing so proxy usage reports have time to arrive (mitmproxy
 * sends them asynchronously via a ThreadPoolExecutor).
 *
 * The 30-second floor gives mitmproxy time to deliver all reports.
 * The 5m30s ceiling matches the cron interval (5 min) plus the floor so
 * consecutive runs cover adjacent, non-overlapping windows.
 */
export async function compareRecentRunsProxyUsage(): Promise<void> {
  const db = globalThis.services.db;
  const now = Date.now();
  const windowStart = new Date(now - 330_000); // 5m30s ago (oldest)
  const windowEnd = new Date(now - 30_000); // 30s ago (newest)

  const runs = await db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(
      and(
        gte(agentRuns.completedAt, windowStart),
        lte(agentRuns.completedAt, windowEnd),
      ),
    )
    // Cap to keep the IN (...) clause in compareProxyUsage bounded.
    // This is a verification tool — missing a few runs under extreme
    // concurrency does not affect billing.
    .limit(500);

  // Group by org
  const byOrg = new Map<string, string[]>();
  for (const run of runs) {
    let arr = byOrg.get(run.orgId);
    if (!arr) {
      arr = [];
      byOrg.set(run.orgId, arr);
    }
    arr.push(run.id);
  }

  for (const [orgId, runIds] of byOrg) {
    try {
      await compareProxyUsage(runIds, orgId);
    } catch (err) {
      log.warn("Proxy usage comparison failed", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Compare client-reported credit_usage against proxy-observed proxy_credit_usage
 * for a set of runs.  Logs an error for each run where the token totals diverge.
 *
 * Comparison is by-run aggregate (sum of all records per runId) because the two
 * tables have different granularity (result-level vs API-call-level).
 */
async function compareProxyUsage(
  runIds: string[],
  orgId: string,
): Promise<void> {
  const db = globalThis.services.db;
  if (runIds.length === 0) return;

  // Client-reported totals (from credit_usage, already processed)
  const clientRows = await db
    .select({
      runId: creditUsage.runId,
      inputTokens: sum(creditUsage.inputTokens).mapWith(Number),
      outputTokens: sum(creditUsage.outputTokens).mapWith(Number),
      cacheReadInputTokens: sum(creditUsage.cacheReadInputTokens).mapWith(
        Number,
      ),
      cacheCreationInputTokens: sum(
        creditUsage.cacheCreationInputTokens,
      ).mapWith(Number),
      webSearchRequests: sum(creditUsage.webSearchRequests).mapWith(Number),
    })
    .from(creditUsage)
    .where(
      and(eq(creditUsage.orgId, orgId), inArray(creditUsage.runId, runIds)),
    )
    .groupBy(creditUsage.runId);

  // Proxy-observed totals (from proxy_credit_usage)
  const proxyRows = await db
    .select({
      runId: proxyCreditUsage.runId,
      inputTokens: sum(proxyCreditUsage.inputTokens).mapWith(Number),
      outputTokens: sum(proxyCreditUsage.outputTokens).mapWith(Number),
      cacheReadInputTokens: sum(proxyCreditUsage.cacheReadInputTokens).mapWith(
        Number,
      ),
      cacheCreationInputTokens: sum(
        proxyCreditUsage.cacheCreationInputTokens,
      ).mapWith(Number),
      webSearchRequests: sum(proxyCreditUsage.webSearchRequests).mapWith(
        Number,
      ),
    })
    .from(proxyCreditUsage)
    .where(
      and(
        eq(proxyCreditUsage.orgId, orgId),
        inArray(proxyCreditUsage.runId, runIds),
      ),
    )
    .groupBy(proxyCreditUsage.runId);

  const proxyByRun = new Map(
    proxyRows.map((r) => {
      return [r.runId, r];
    }),
  );

  for (const client of clientRows) {
    if (!client.runId) continue;
    const proxy = proxyByRun.get(client.runId);
    if (!proxy) {
      // No proxy data yet — might arrive later, not an error
      continue;
    }

    const fields = [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "webSearchRequests",
    ] as const;

    for (const field of fields) {
      const clientVal = client[field] ?? 0;
      const proxyVal = proxy[field] ?? 0;
      // Only flag undercounts. Proxy sees all API calls (main + subagents)
      // while client reports main thread only, so proxy >= client is normal.
      if (proxyVal < clientVal) {
        log.error("Proxy usage undercount", {
          orgId,
          runId: client.runId,
          field,
          clientValue: clientVal,
          proxyValue: proxyVal,
        });
      }
    }
  }
}
