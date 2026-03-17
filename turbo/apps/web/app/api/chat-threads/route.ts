import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import { chatThreadsContract } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  createChatThread,
  listChatThreads,
} from "../../../src/lib/chat-thread";
import { resolveCallerOrgId } from "../../../src/lib/org/resolve-org";
import { agentComposes } from "../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";

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

    const callerOrgId = await resolveCallerOrgId(userId, request);
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

    const callerOrgId = await resolveCallerOrgId(userId, request);
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
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
      },
    };
  },
});

const handler = createHandler(chatThreadsContract, router);

export { handler as GET, handler as POST };
