import { eq, and, inArray, sum, lte, gte } from "drizzle-orm";
import { creditUsage } from "../../../db/schema/credit-usage";
import { clientCreditUsage } from "../../../db/schema/client-credit-usage";
import { agentRuns } from "../../../db/schema/agent-run";
import { logger } from "../../shared/logger";

const log = logger("service:proxy-usage-comparison");

/**
 * Compare proxy-observed usage (now in `credit_usage`) against
 * client-reported usage (in `client_credit_usage`) for recently
 * completed runs.  Designed to run as a standalone cron job, decoupled
 * from credit processing so proxy usage reports have time to arrive
 * (mitmproxy sends them asynchronously via a ThreadPoolExecutor).
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
 * Compare proxy-sourced credit_usage against client-reported
 * client_credit_usage for a set of runs.  Aggregates by runId because
 * the two tables have different granularity (API-call-level vs
 * result-event-level).
 *
 * Proxy sees all API calls (main + subagents) while client sees only
 * main-thread result events, so proxy >= client is the expected
 * invariant.  Any run where proxy < client suggests mitmproxy dropped
 * reports and is logged as an error.
 */
async function compareProxyUsage(
  runIds: string[],
  orgId: string,
): Promise<void> {
  const db = globalThis.services.db;
  if (runIds.length === 0) return;

  // Proxy-observed totals (from credit_usage, the billing source)
  const proxyRows = await db
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

  // Client-reported totals (from client_credit_usage audit table)
  const clientRows = await db
    .select({
      runId: clientCreditUsage.runId,
      inputTokens: sum(clientCreditUsage.inputTokens).mapWith(Number),
      outputTokens: sum(clientCreditUsage.outputTokens).mapWith(Number),
      cacheReadInputTokens: sum(clientCreditUsage.cacheReadInputTokens).mapWith(
        Number,
      ),
      cacheCreationInputTokens: sum(
        clientCreditUsage.cacheCreationInputTokens,
      ).mapWith(Number),
      webSearchRequests: sum(clientCreditUsage.webSearchRequests).mapWith(
        Number,
      ),
    })
    .from(clientCreditUsage)
    .where(
      and(
        eq(clientCreditUsage.orgId, orgId),
        inArray(clientCreditUsage.runId, runIds),
      ),
    )
    .groupBy(clientCreditUsage.runId);

  const proxyByRun = new Map(
    proxyRows
      .filter((r): r is typeof r & { runId: string } => {
        return r.runId !== null;
      })
      .map((r) => {
        return [r.runId, r];
      }),
  );
  const clientByRun = new Map(
    clientRows
      .filter((r): r is typeof r & { runId: string } => {
        return r.runId !== null;
      })
      .map((r) => {
        return [r.runId, r];
      }),
  );

  // Walk the union of runIds.  Any asymmetry is an error:
  //   proxy missing entirely → mitmproxy lost all reports for this run
  //   client missing entirely → events webhook never delivered result events
  //   both present but proxy < client on any field → partial proxy data loss
  const allRunIds = new Set<string>([
    ...proxyByRun.keys(),
    ...clientByRun.keys(),
  ]);

  const fields = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
  ] as const;

  for (const runId of allRunIds) {
    const proxy = proxyByRun.get(runId);
    const client = clientByRun.get(runId);

    if (!proxy) {
      log.error("Proxy usage missing for run with client data", {
        orgId,
        runId,
      });
      continue;
    }
    if (!client) {
      log.error("Client usage missing for run with proxy data", {
        orgId,
        runId,
      });
      continue;
    }

    for (const field of fields) {
      const proxyVal = proxy[field] ?? 0;
      const clientVal = client[field] ?? 0;
      if (proxyVal < clientVal) {
        log.error("Proxy usage undercount", {
          orgId,
          runId,
          field,
          proxyValue: proxyVal,
          clientValue: clientVal,
        });
      }
    }
  }
}
