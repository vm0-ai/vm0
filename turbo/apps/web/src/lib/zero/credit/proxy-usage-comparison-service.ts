import { eq, and, inArray, sum, lte, gte } from "drizzle-orm";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import { clientCreditUsage } from "@vm0/db/schema/client-credit-usage";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
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
 *
 * Only vm0-provider runs are compared.  For other providers the proxy does
 * not report usage (see `billableFirewalls` in `build-zero-context.ts`),
 * so `credit_usage` is legitimately empty and the comparison would
 * false-alarm on every run.
 */
export async function compareRecentRunsProxyUsage(): Promise<void> {
  const db = globalThis.services.db;
  const now = Date.now();
  const windowStart = new Date(now - 330_000); // 5m30s ago (oldest)
  const windowEnd = new Date(now - 30_000); // 30s ago (newest)

  const runs = await db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        gte(agentRuns.completedAt, windowStart),
        lte(agentRuns.completedAt, windowEnd),
        eq(zeroRuns.modelProvider, "vm0"),
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
    await compareProxyUsage(runIds, orgId);
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

  // Walk client-present runs.  Any asymmetry against proxy is an error:
  //   proxy missing + client non-zero → mitmproxy lost all reports for this run
  //   both present but proxy < client on any field → partial proxy data loss
  // Proxy-only runs are not checked: abnormal terminations (cancel, crash,
  // timeout) make API calls that proxy captures but never emit a result
  // event, so client_credit_usage is legitimately empty for those runs.
  const fields = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
  ] as const;

  for (const [runId, client] of clientByRun) {
    const proxy = proxyByRun.get(runId);

    if (!proxy) {
      const hasNonZero = fields.some((f) => {
        return (client[f] ?? 0) > 0;
      });
      if (hasNonZero) {
        log.error("Proxy usage missing for run with client data", {
          orgId,
          runId,
        });
      }
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
