import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookUsageContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { zeroRuns } from "../../../../../src/db/schema/zero-run";
import { creditUsage } from "../../../../../src/db/schema/credit-usage";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/shared/logger";

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

    // Verify run exists and belongs to user; fetch modelProvider from zeroRuns
    // (same pattern as events webhook — ensures consistency with credit_usage)
    const [run] = await globalThis.services.db
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        modelProvider: zeroRuns.modelProvider,
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

    // Insert proxy-reported usage into credit_usage (the billing source).
    // Rows are charged later by processOrgCredits().  Insertion errors
    // propagate so the handler returns 5xx and mitmproxy retries via
    // `_report_usage_with_retry`; swallowing them would silently lose
    // billing records.
    //
    // Model precedence: `run.selectedModel` (the user's run selection) wins
    // because it is guaranteed to match a row in credit_pricing; `u.model`
    // (proxy-observed) may carry a variant string that has no pricing entry
    // and would silently charge zero credits.
    const u = body.usage;
    await globalThis.services.db
      .insert(creditUsage)
      .values({
        runId: body.runId,
        orgId: run.orgId,
        userId,
        model: run.selectedModel ?? u.model ?? "unknown",
        modelProvider: run.modelProvider ?? "",
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
        webSearchRequests: u.web_search_requests ?? 0,
        messageId: u.message_id ?? null,
        // status defaults to "pending" via schema default
      })
      .onConflictDoNothing({
        target: [creditUsage.runId, creditUsage.messageId],
      });

    log.debug("Proxy usage recorded", {
      runId: body.runId,
      model: u.model,
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
