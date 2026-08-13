/** Canonical ChatEvent route adapter. */
import { command } from "ccstate";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";

import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { handleSendChatEvent$ } from "../services/zero-chat-events.command";

const sendEventBody$ = bodyResultOf(chatEventsContract.send);

const sendChatEventInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(sendEventBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return await set(handleSendChatEvent$, body.data, signal);
  },
);

export const zeroChatEventsRoutes: readonly RouteEntry[] = [
  {
    route: chatEventsContract.send,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:write",
      },
      sendChatEventInner$,
    ),
  },
];
