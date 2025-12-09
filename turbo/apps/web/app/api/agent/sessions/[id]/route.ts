import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { sessionsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { agentSessionService } from "../../../../../src/lib/agent-session";

const router = tsr.router(sessionsByIdContract, {
  getById: async ({ params }) => {
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

    // Get session with conversation data
    const session = await agentSessionService.getByIdWithConversation(
      params.id,
    );

    if (!session) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent session not found", code: "NOT_FOUND" },
        },
      };
    }

    // Verify ownership - return 404 for security (don't reveal session exists)
    if (session.userId !== userId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent session not found", code: "NOT_FOUND" },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        session: {
          id: session.id,
          userId: session.userId,
          agentComposeId: session.agentComposeId,
          conversationId: session.conversationId,
          artifactName: session.artifactName,
          templateVars: session.templateVars,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
          conversation: session.conversation
            ? {
                id: session.conversation.id,
                cliAgentType: session.conversation.cliAgentType,
                cliAgentSessionId: session.conversation.cliAgentSessionId,
                cliAgentSessionHistory:
                  session.conversation.cliAgentSessionHistory,
              }
            : null,
        },
      },
    };
  },

  delete: async ({ params }) => {
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

    // Get session to verify ownership
    const session = await agentSessionService.getById(params.id);

    if (!session) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent session not found", code: "NOT_FOUND" },
        },
      };
    }

    // Verify ownership - return 404 for security (don't reveal session exists)
    if (session.userId !== userId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent session not found", code: "NOT_FOUND" },
        },
      };
    }

    // Delete session
    await agentSessionService.delete(params.id);

    return {
      status: 200 as const,
      body: {
        deleted: true as const,
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
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
  }

  return undefined;
}

const handler = createNextHandler(sessionsByIdContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as GET, handler as DELETE };
