import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { chatThreadsContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import {
  createChatThread,
  listChatThreads,
} from "../../../../src/lib/chat-thread";
import { resolveCallerOrgId } from "../../../../src/lib/org/resolve-org";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";

const router = tsr.router(chatThreadsContract, {
  create: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const [compose] = await globalThis.services.db
      .select({ orgId: agentComposes.orgId })
      .from(agentComposes)
      .where(eq(agentComposes.id, body.agentComposeId))
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    const callerOrgId = await resolveCallerOrgId(authCtx, request);
    if (callerOrgId !== compose.orgId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    const thread = await createChatThread(
      userId,
      body.agentComposeId,
      body.title,
    );

    return {
      status: 201 as const,
      body: {
        id: thread.id,
        title: body.title ?? null,
        createdAt: thread.createdAt.toISOString(),
      },
    };
  },

  list: async ({ query, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const [compose] = await globalThis.services.db
      .select({ orgId: agentComposes.orgId })
      .from(agentComposes)
      .where(eq(agentComposes.id, query.agentComposeId))
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    const callerOrgId = await resolveCallerOrgId(authCtx, request);
    if (callerOrgId !== compose.orgId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    const threads = await listChatThreads(userId, query.agentComposeId);

    return {
      status: 200 as const,
      body: {
        threads: threads.map((t) => ({
          id: t.id,
          title: t.title,
          preview: t.preview,
          agentComposeId: query.agentComposeId,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
      },
    };
  },
});

const handler = createHandler(chatThreadsContract, router, {
  errorHandler: createSafeErrorHandler("zero-chat-threads"),
});

export { handler as GET, handler as POST };
