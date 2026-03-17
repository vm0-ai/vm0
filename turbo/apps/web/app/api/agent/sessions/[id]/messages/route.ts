import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { sessionMessagesContract } from "@vm0/core";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { appendChatMessages } from "../../../../../../src/lib/agent-session";
import { isNotFound } from "../../../../../../src/lib/errors";
import { agentSessions } from "../../../../../../src/db/schema/agent-session";
import { resolveCallerOrgId } from "../../../../../../src/lib/org/resolve-org";

const router = tsr.router(sessionMessagesContract, {
  append: async ({ params, body, headers }, { request }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Verify session belongs to the caller's active organization (runtime org)
    const [session] = await globalThis.services.db
      .select({
        orgId: agentSessions.orgId,
        userId: agentSessions.userId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, params.id))
      .limit(1);

    if (!session || session.userId !== userId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Session not found", code: "NOT_FOUND" },
        },
      };
    }

    const callerOrgId = await resolveCallerOrgId(userId, request);
    if (callerOrgId !== session.orgId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Session not found", code: "NOT_FOUND" },
        },
      };
    }

    await appendChatMessages(params.id, userId, body.messages);

    return {
      status: 200 as const,
      body: { success: true as const },
    };
  },
});

interface PathParamsValidationError {
  pathParamsError: {
    issues: Array<{ path: string[]; message: string }>;
  } | null;
}

function isPathParamsError(err: unknown): err is PathParamsValidationError {
  return (
    err !== null &&
    typeof err === "object" &&
    "pathParamsError" in err &&
    (err.pathParamsError === null ||
      (typeof err.pathParamsError === "object" &&
        err.pathParamsError !== null &&
        "issues" in err.pathParamsError &&
        Array.isArray(err.pathParamsError.issues)))
  );
}

function errorHandler(err: unknown): TsRestResponse | void {
  if (isNotFound(err)) {
    return TsRestResponse.fromJson(
      { error: { message: "Session not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  if (isPathParamsError(err) && err.pathParamsError) {
    const issue = err.pathParamsError.issues[0];
    if (issue) {
      return TsRestResponse.fromJson(
        { error: { message: issue.message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
  }

  return undefined;
}

const handler = createHandler(sessionMessagesContract, router, {
  errorHandler,
});

export { handler as POST };
