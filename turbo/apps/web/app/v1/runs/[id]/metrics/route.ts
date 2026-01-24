/**
 * Public API v1 - Run Metrics Endpoint
 *
 * GET /v1/runs/:id/metrics - Get CPU, memory, and disk metrics for a run
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../../src/lib/public-api/handler";
import { publicRunMetricsContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/axiom";

interface AxiomMetricEvent {
  _time: string;
  runId: string;
  userId: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

const router = tsr.router(publicRunMetricsContract, {
  getMetrics: async ({ params, headers }) => {
    initServices();

    const auth = await authenticatePublicApi(headers.authorization);
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Verify run exists and belongs to user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such run: '${params.id}'`,
          },
        },
      };
    }

    // Verify ownership
    if (run.userId !== auth.userId) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such run: '${params.id}'`,
          },
        },
      };
    }

    // Query all metrics from Axiom
    const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_METRICS);
    const apl = `['${dataset}']
| where runId == "${params.id}"
| order by _time asc`;

    const events = await queryAxiom<AxiomMetricEvent>(apl);

    // If Axiom is not configured or query failed, return empty
    if (events === null || events.length === 0) {
      return {
        status: 200 as const,
        body: {
          data: [],
          summary: {
            avg_cpu_percent: 0,
            max_memory_used_mb: 0,
            total_duration_ms: null,
          },
        },
      };
    }

    // Transform to API response format
    const data = events.map((e) => ({
      timestamp: e._time,
      cpu_percent: e.cpu,
      memory_used_mb: e.mem_used,
      memory_total_mb: e.mem_total,
      disk_used_mb: e.disk_used,
      disk_total_mb: e.disk_total,
    }));

    // Calculate summary statistics
    const cpuSum = events.reduce((sum, e) => sum + e.cpu, 0);
    const avgCpuPercent = events.length > 0 ? cpuSum / events.length : 0;
    const maxMemoryUsedMb = Math.max(...events.map((e) => e.mem_used));

    // Calculate duration from first to last metric
    let totalDurationMs: number | null = null;
    if (events.length >= 2) {
      const firstTime = new Date(events[0]!._time).getTime();
      const lastTime = new Date(events[events.length - 1]!._time).getTime();
      totalDurationMs = lastTime - firstTime;
    } else if (run.startedAt && run.completedAt) {
      // Fallback to run times if available
      totalDurationMs = run.completedAt.getTime() - run.startedAt.getTime();
    }

    return {
      status: 200 as const,
      body: {
        data,
        summary: {
          avg_cpu_percent: Math.round(avgCpuPercent * 100) / 100,
          max_memory_used_mb: Math.round(maxMemoryUsedMb * 100) / 100,
          total_duration_ms: totalDurationMs,
        },
      },
    };
  },
});

const handler = createPublicApiHandler(publicRunMetricsContract, router);

export { handler as GET };
