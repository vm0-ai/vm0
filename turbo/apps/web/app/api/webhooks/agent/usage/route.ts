import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookUsageContract } from "@vm0/api-contracts/contracts/webhooks";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  buildModelUsageEventDrafts,
  getPositiveModelUsageTokenQuantities,
} from "../../../../../src/lib/zero/billing/model-usage-event-adapter";

const log = logger("webhooks:usage");

const router = tsr.router(webhookUsageContract, {
  send: async ({ body, headers }) => {
    initServices();

    // Authenticate with sandbox JWT and verify runId matches
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

    const { userId } = auth;

    // Verify run exists and belongs to user.
    const [run] = await globalThis.services.db
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
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

    const u = body.usage;
    const tokenQuantities = getPositiveModelUsageTokenQuantities(u);
    if (tokenQuantities.length === 0) {
      log.debug("Proxy usage contained no positive token quantities", {
        runId: body.runId,
        model: u.model,
      });
      return {
        status: 200 as const,
        body: {
          success: true,
        },
      };
    }

    if (!u.message_id) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "usage.message_id is required for billable token usage",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Insert proxy-reported model usage into usage_event. Rows are charged
    // later by processUsageEvents(). Insertion errors propagate so mitmproxy
    // retries rather than silently losing billable records.
    //
    // Model precedence stays equivalent to the legacy credit_usage writer:
    // `run.selectedModel` wins over proxy-observed `u.model`.
    const provider = run.selectedModel ?? u.model ?? "unknown";
    const events = buildModelUsageEventDrafts({
      runId: body.runId,
      messageId: u.message_id,
      provider,
      usage: u,
    });

    await globalThis.services.db
      .insert(usageEvent)
      .values(
        events.map((event) => {
          return {
            runId: body.runId,
            orgId: run.orgId,
            userId,
            ...event,
          };
        }),
      )
      .onConflictDoNothing({
        target: [usageEvent.idempotencyKey],
      });

    log.debug("Proxy usage recorded", {
      runId: body.runId,
      provider,
      eventCount: events.length,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
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
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
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

const handler = createHandler(webhookUsageContract, router, {
  routeName: "webhooks.agent.usage",
  errorHandler,
});

export { handler as POST };
