import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import { chatThreadsContract } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  createChatThread,
  listChatThreads,
} from "../../../src/lib/chat-thread";
import { verifyComposeOrgAccess } from "../../../src/lib/org/verify-compose-org-access";

const router = tsr.router(chatThreadsContract, {
  create: async ({ body, headers }, { request }) => {
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

    const hasOrgAccess = await verifyComposeOrgAccess(
      body.agentComposeId,
      userId,
      request.url,
    );
    if (!hasOrgAccess) {
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
        createdAt: thread.createdAt.toISOString(),
      },
    };
  },

  list: async ({ query, headers }, { request }) => {
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

    const hasOrgAccess = await verifyComposeOrgAccess(
      query.agentComposeId,
      userId,
      request.url,
    );
    if (!hasOrgAccess) {
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
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
      },
    };
  },
});

const handler = createHandler(chatThreadsContract, router);

export { handler as GET, handler as POST };
