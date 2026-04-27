import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookUsageEventContract } from "@vm0/api-contracts/contracts/webhooks";
import { initServices } from "../../../../../src/lib/init-services";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { isForeignKeyViolation } from "../../../../../src/lib/shared/pg-errors";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("webhooks:usage-event");

const router = tsr.router(webhookUsageEventContract, {
  send: async ({ body, headers }) => {
    initServices();

    const events = "events" in body ? body.events : [body];
    const auth = getSandboxAuthForRun(body.runId, headers.authorization);
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated or runId mismatch",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const { userId, orgId } = auth;

    // No up-front `SELECT agent_runs` here: the sandbox JWT (#10770)
    // already carries `orgId` and the runId is cross-checked in
    // `getSandboxAuthForRun`. The FK on `usage_event.runId` protects
    // the INSERT — if the run was never created (bad runId) or has
    // been deleted between sandbox boot and this webhook arriving
    // (aggregate-deletion paths, see #10763), PG raises SQLSTATE
    // 23503 and we surface it as 404 instead of 500, preserving the
    // "run not found" contract the handler had before this refactor.
    try {
      await globalThis.services.db
        .insert(usageEvent)
        .values(
          events.map((event) => {
            return {
              runId: body.runId,
              orgId,
              userId,
              kind: event.kind,
              provider: event.provider,
              category: event.category,
              quantity: event.quantity,
              idempotencyKey: event.idempotencyKey,
            };
          }),
        )
        .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        log.info("Run not found for usage event, dropping", {
          runId: body.runId,
          eventCount: events.length,
        });
        return {
          status: 404 as const,
          body: {
            error: {
              message: "Run not found",
              code: "NOT_FOUND",
            },
          },
        };
      }
      throw err;
    }

    log.debug("Usage events recorded", {
      runId: body.runId,
      eventCount: events.length,
    });

    return {
      status: 200 as const,
      body: {
        success: true,
      },
    };
  },
});

function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: {
        issues: Array<{ path: Array<string | number>; message: string }>;
      } | null;
    };
    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
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

const handler = createHandler(webhookUsageEventContract, router, {
  routeName: "webhooks.agent.usage-event",
  errorHandler,
});

export { handler as POST };
