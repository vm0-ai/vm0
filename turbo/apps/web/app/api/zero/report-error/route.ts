import {
  createHandler,
  createSilentErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroReportErrorContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { submitDiagnosticBundle } from "../../../../src/lib/zero/support/diagnostic-bundle-service";

const router = tsr.router(zeroReportErrorContract, {
  submit: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { userId } = authCtx;
    const { org } = await resolveOrg(authCtx);
    const orgId = org.orgId;

    const db = globalThis.services.db;
    const runId = body.runId;

    // Query run record and verify ownership
    const [run] = await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        error: agentRuns.error,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        runnerGroup: agentRuns.runnerGroup,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        orgId: agentRuns.orgId,
        result: agentRuns.result,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return {
        status: 400 as const,
        body: {
          error: { message: "Run not found", code: "RUN_NOT_FOUND" },
        },
      };
    }

    if (run.orgId !== orgId) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Run does not belong to this organization",
            code: "FORBIDDEN",
          },
        },
      };
    }

    if (run.status !== "failed") {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Only failed runs can be reported",
            code: "RUN_NOT_FAILED",
          },
        },
      };
    }

    const { reference } = await submitDiagnosticBundle({
      title: body.title,
      description: body.description,
      userId,
      orgId,
      runId,
      run,
      referencePrefix: "er",
      s3PathPrefix: "error-reports",
      emailSubjectPrefix: "[Error Report]",
    });

    return {
      status: 200 as const,
      body: { reference },
    };
  },
});

// Use the silent variant: this endpoint *is* the error sink. If it fails,
// forwarding that failure to Sentry would create a self-referential echo —
// server logs already carry full context at error level.
const handler = createHandler(zeroReportErrorContract, router, {
  routeName: "zero.report-error",
  errorHandler: createSilentErrorHandler("zero.report-error"),
});

export { handler as POST };
