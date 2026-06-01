import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { reportErrorBodySchema } from "@vm0/api-contracts/contracts/zero-report-error";
import { agentRuns } from "@vm0/db/schema/agent-run";
import type { z } from "zod";

import { db$ } from "../external/db";
import { submitDiagnosticBundle } from "./diagnostic-bundle.service";

type ReportErrorBody = z.infer<typeof reportErrorBodySchema>;

interface SubmitZeroReportErrorArgs extends ReportErrorBody {
  readonly userId: string;
  readonly orgId: string;
}

type SubmitZeroReportErrorResult =
  | { readonly kind: "ok"; readonly reference: string }
  | { readonly kind: "run_not_found" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "run_not_failed" };

export const submitZeroReportError$ = command(
  async (
    { get },
    args: SubmitZeroReportErrorArgs,
    signal: AbortSignal,
  ): Promise<SubmitZeroReportErrorResult> => {
    const db = get(db$);
    const [run] = await db
      .select({
        id: agentRuns.id,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        status: agentRuns.status,
        error: agentRuns.error,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        lastEventSequence: agentRuns.lastEventSequence,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        runnerGroup: agentRuns.runnerGroup,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        result: agentRuns.result,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();

    if (!run) {
      return { kind: "run_not_found" };
    }

    if (run.orgId !== args.orgId) {
      return { kind: "forbidden" };
    }

    if (run.status !== "failed") {
      return { kind: "run_not_failed" };
    }

    const { reference } = await get(
      submitDiagnosticBundle({
        title: args.title,
        description: args.description,
        userId: args.userId,
        orgId: args.orgId,
        runId: args.runId,
        run,
        referencePrefix: "er",
        s3PathPrefix: "error-reports",
        emailSubjectPrefix: "[Error Report]",
      }),
    );
    signal.throwIfAborted();

    return { kind: "ok", reference };
  },
);
