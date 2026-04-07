import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroAskUserAnswerContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { slackOrgPendingQuestions } from "../../../../../src/db/schema/slack-org-pending-question";
import { eq } from "drizzle-orm";

const router = tsr.router(zeroAskUserAnswerContract, {
  getAnswer: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "slack:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { runId } = authCtx;
    if (!runId) {
      return {
        status: 403 as const,
        body: {
          error: { message: "No run context available", code: "FORBIDDEN" },
        },
      };
    }

    // Look up pending question
    const [pending] = await globalThis.services.db
      .select()
      .from(slackOrgPendingQuestions)
      .where(eq(slackOrgPendingQuestions.id, query.pendingId))
      .limit(1);

    // Return 404 for not found or ownership mismatch (avoid information leakage)
    if (!pending || pending.runId !== runId) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: "Pending question not found",
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Check answer status
    if (pending.answeredAt && pending.answer !== null) {
      return {
        status: 200 as const,
        body: { status: "answered" as const, answer: pending.answer },
      };
    }

    if (pending.expiresAt < new Date()) {
      return {
        status: 200 as const,
        body: { status: "expired" as const },
      };
    }

    return {
      status: 200 as const,
      body: { status: "pending" as const },
    };
  },
});

const handler = createHandler(zeroAskUserAnswerContract, router, {
  errorHandler: createSafeErrorHandler("ask-user-answer"),
});

export { handler as GET };
