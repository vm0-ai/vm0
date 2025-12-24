import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { runSystemLogContract } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../../../../src/lib/auth/get-user-id";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../../../src/lib/axiom";

interface AxiomSystemLogEvent {
  _time: string;
  runId: string;
  userId: string;
  log: string;
}

const router = tsr.router(runSystemLogContract, {
  getSystemLog: async ({ params, query }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Verify run exists and belongs to user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!run || run.userId !== userId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    const { since, limit } = query;

    // Build APL query for Axiom
    const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_SYSTEM);
    const sinceFilter = since
      ? `| where _time > datetime("${new Date(since).toISOString()}")`
      : "";
    const apl = `['${dataset}']
| where runId == "${params.id}"
${sinceFilter}
| order by _time asc
| limit ${limit + 1}`;

    // Query Axiom for system logs
    const events = await queryAxiom<AxiomSystemLogEvent>(apl);

    // If Axiom is not configured or query failed, return empty
    if (events === null) {
      return {
        status: 200 as const,
        body: {
          systemLog: "",
          hasMore: false,
        },
      };
    }

    // Check if there are more records
    const hasMore = events.length > limit;
    const records = hasMore ? events.slice(0, limit) : events;

    // Aggregate system logs from records
    const aggregatedSystemLog = records.map((r) => r.log).join("");

    return {
      status: 200 as const,
      body: {
        systemLog: aggregatedSystemLog,
        hasMore,
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    ("pathParamsError" in err || "queryError" in err)
  ) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
      queryError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createNextHandler(runSystemLogContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as GET };
