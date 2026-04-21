import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsChatMessageContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import {
  getChatThread,
  createChatThread,
} from "../../../../../../src/lib/zero/chat-thread/chat-thread-service";
import { insertChatMessage } from "../../../../../../src/lib/zero/chat-thread/chat-message-service";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import { badRequest, notFound } from "../../../../../../src/lib/shared/errors";

const router = tsr.router(integrationsChatMessageContract, {
  sendMessage: async ({ body, headers }) => {
    initServices();

    const authResult = await requireAuth(headers.authorization, {
      requiredCapability: "chat-message:write",
    });
    if (isAuthError(authResult)) return authResult;

    const { userId, orgId } = authResult;

    let threadId: string;

    if (body.thread) {
      // Mode A: Send to existing thread (ownership check built into getChatThread)
      const thread = await getChatThread(body.thread, userId);
      threadId = thread.id;
    } else {
      // Mode B: Create new thread for the authenticated user
      if (!body.agent) {
        throw badRequest("Agent is required when creating a new thread");
      }

      // Verify agent exists and belongs to caller's org
      const [agent] = await globalThis.services.db
        .select({ id: agentComposes.id })
        .from(agentComposes)
        .where(
          and(
            eq(agentComposes.id, body.agent),
            orgId ? eq(agentComposes.orgId, orgId) : undefined,
          ),
        )
        .limit(1);

      if (!agent) {
        throw notFound("Agent not found");
      }

      const newThread = await createChatThread(userId, body.agent, body.title);
      threadId = newThread.id;
    }

    const message = await insertChatMessage({
      chatThreadId: threadId,
      userId,
      role: "assistant",
      content: body.text,
      runId: null,
    });

    return {
      status: 201 as const,
      body: {
        messageId: message.id,
        threadId,
        createdAt: message.createdAt.toISOString(),
      },
    };
  },
});

const handler = createHandler(integrationsChatMessageContract, router, {
  routeName: "zero.integrations.chat.message",
});

export { handler as POST };
