import { command } from "ccstate";
import { integrationsChatMessageContract } from "@vm0/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  createChatThread$,
  insertIntegrationChatMessage$,
  integrationChatThreadByOwner,
} from "../services/zero-chat-thread.service";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import type { RouteEntry } from "../route";

const sendMessageBody$ = bodyResultOf(
  integrationsChatMessageContract.sendMessage,
);

const sendMessageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(sendMessageBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  let threadId: string;
  if (body.thread !== undefined) {
    const thread = await get(
      integrationChatThreadByOwner({
        threadId: body.thread,
        userId: auth.userId,
      }),
    );
    signal.throwIfAborted();
    if (!thread) {
      return notFound("Chat thread not found");
    }
    threadId = thread.id;
  } else {
    if (body.agent === undefined) {
      return badRequestMessage("Agent is required when creating a new thread");
    }

    const exists = await get(
      zeroComposeExists({ orgId: auth.orgId, composeId: body.agent }),
    );
    signal.throwIfAborted();
    if (!exists) {
      return notFound("Agent not found");
    }

    const thread = await set(
      createChatThread$,
      {
        userId: auth.userId,
        agentComposeId: body.agent,
        title: body.title,
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
      content: body.text,
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

const chatMessageWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-message:write",
} as const;

export const zeroIntegrationsChatMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsChatMessageContract.sendMessage,
    handler: authRoute(chatMessageWriteAuth, sendMessageInner$),
  },
];
