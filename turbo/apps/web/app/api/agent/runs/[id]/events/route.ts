import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { runEventsContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentRunEvents } from "../../../../../../src/db/schema/agent-run-event";
import { agentComposeVersions } from "../../../../../../src/db/schema/agent-compose";
import { eq, gt, and } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import type {
  RunStatus,
  RunResult,
  RunState,
} from "../../../../../../src/lib/run/types";

const router = tsr.router(runEventsContract, {
  getEvents: async ({ params, query }) => {
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

    const { since, limit } = query;

    // Verify run exists and belongs to user, join with compose version to get provider
    const [runWithCompose] = await globalThis.services.db
      .select({
        id: agentRuns.id,
        userId: agentRuns.userId,
        status: agentRuns.status,
        result: agentRuns.result,
        error: agentRuns.error,
        composeContent: agentComposeVersions.content,
      })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!runWithCompose || runWithCompose.userId !== userId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Extract provider from compose content
    const composeContent = runWithCompose.composeContent as {
      agent?: { provider?: string };
    } | null;
    const provider = composeContent?.agent?.provider ?? "claude-code";

    // Query events from database (only agent events, no vm0_* events)
    const events = await globalThis.services.db
      .select()
      .from(agentRunEvents)
      .where(
        and(
          eq(agentRunEvents.runId, params.id),
          gt(agentRunEvents.sequenceNumber, since),
        ),
      )
      .orderBy(agentRunEvents.sequenceNumber)
      .limit(limit);

    // Calculate nextSequence and hasMore
    const hasMore = events.length === limit;
    const nextSequence =
      events.length > 0 ? events[events.length - 1]!.sequenceNumber : since;

    // Build run state from run record
    const runState: RunState = {
      status: runWithCompose.status as RunStatus,
    };

    // Include result if completed
    if (runWithCompose.status === "completed" && runWithCompose.result) {
      runState.result = runWithCompose.result as RunResult;
    }

    // Include error if failed
    if (runWithCompose.status === "failed" && runWithCompose.error) {
      runState.error = runWithCompose.error;
    }

    return {
      status: 200 as const,
      body: {
        events: events.map((e) => ({
          sequenceNumber: e.sequenceNumber,
          eventType: e.eventType,
          eventData: e.eventData,
          createdAt: e.createdAt.toISOString(),
        })),
        hasMore,
        nextSequence,
        run: runState,
        provider,
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

const handler = createNextHandler(runEventsContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as GET };
