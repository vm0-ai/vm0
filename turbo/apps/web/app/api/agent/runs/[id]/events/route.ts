import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { runEventsContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentRunEvents } from "../../../../../../src/db/schema/agent-run-event";
import { eq, gt, and } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";

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

    // Query events from database
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
        status: run.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "timeout",
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
