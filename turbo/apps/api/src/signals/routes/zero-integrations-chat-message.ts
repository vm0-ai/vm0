import { command } from "ccstate";
import { integrationsChatMessageContract } from "@vm0/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  createChatThread$,
  insertIntegrationChatMessage$,
  ownedChatThreadById,
} from "../services/zero-chat-thread.service";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import type { RouteEntry } from "../route";

const sendMessageBody$ = bodyResultOf(
  integrationsChatMessageContract.sendMessage,
);

const sendMessageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(sendMessageBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  let threadId: string;
  if (body.data.thread) {
    const thread = await get(
      ownedChatThreadById({
        threadId: body.data.thread,
        userId: auth.userId,
      }),
    );
    signal.throwIfAborted();
    if (!thread) {
      return notFound("Chat thread not found");
    }
    threadId = thread.id;
  } else {
    const agentId = body.data.agent;
    if (!agentId) {
      return badRequestMessage(
        "Exactly one of 'thread' or 'agent' must be provided",
      );
    }

    const exists = await get(
      zeroComposeExists({ orgId: auth.orgId, composeId: agentId }),
    );
    signal.throwIfAborted();
    if (!exists) {
      return notFound("Agent not found");
    }

    const thread = await set(
      createChatThread$,
      {
        userId: auth.userId,
        agentComposeId: agentId,
        title: body.data.title,
        clientThreadId: undefined,
      },
      signal,
    );
    signal.throwIfAborted();
    threadId = thread.id;
  }

  const message = await set(
    insertIntegrationChatMessage$,
    {
      chatThreadId: threadId,
      userId: auth.userId,
      content: body.data.text,
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 201 as const,
    body: {
      messageId: message.id,
      threadId,
      createdAt: message.createdAt.toISOString(),
    },
  };
});

export const zeroIntegrationsChatMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsChatMessageContract.sendMessage,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:write",
      },
      sendMessageInner$,
    ),
  },
];
