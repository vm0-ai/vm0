import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { sessionMessagesContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { appendChatMessages } from "../../../../../../src/lib/agent-session";
import { isNotFound } from "../../../../../../src/lib/errors";

const router = tsr.router(sessionMessagesContract, {
  append: async ({ params, body, headers }) => {
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
