import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsPhoneMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../../../../../../src/lib/zero/agentphone/client";
import {
  normalizeAgentPhoneHandle,
  resolveAgentPhoneAgentIdForUserLink,
  resolveAgentPhoneUserLinkForOwner,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneChannel,
} from "../../../../../../src/lib/zero/agentphone/shared";
import type {
  SendPhoneMessageBody,
  SendPhoneMessageResponse,
} from "@vm0/api-contracts/contracts/integrations";

type RouteErrorStatus = 400 | 401 | 403 | 404 | 502;

type RouteErrorResponse<TStatus extends RouteErrorStatus = RouteErrorStatus> = {
  status: TStatus;
  body: ReturnType<typeof errorBody>;
};

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function routeError<TStatus extends RouteErrorStatus>(
  status: TStatus,
  message: string,
  code: string,
): RouteErrorResponse<TStatus> {
  return { status, body: errorBody(message, code) };
}

function agentPhoneRouteError(
  error: unknown,
): RouteErrorResponse<400 | 502> | undefined {
  if (!isAgentPhoneApiError(error)) return undefined;
  return routeError(
    error.status >= 500 ? 502 : 400,
    `AgentPhone API error: ${error.body || `HTTP ${error.status}`}`,
    "AGENTPHONE_ERROR",
  );
}

async function sendPhoneTextMessage(params: {
  body: SendPhoneMessageBody;
  userId: string;
  orgId: string;
}): Promise<SendPhoneMessageResponse | RouteErrorResponse> {
  // The in-app phone API only addresses E.164 phone handles (SMS-class).
  const userChannel: AgentPhoneChannel = "sms";
  const phoneHandle = normalizeAgentPhoneHandle(
    params.body.toNumber,
    userChannel,
  );
  const userLink = await resolveAgentPhoneUserLinkForOwner({
    phoneHandle,
    channel: userChannel,
    vm0UserId: params.userId,
    orgId: params.orgId,
  });
  if (!userLink) {
    return routeError(404, "Connected phone handle not found", "NOT_FOUND");
  }

  const agentphoneAgentId = await resolveAgentPhoneAgentIdForUserLink({
    userLinkId: userLink.id,
    phoneHandle,
    channel: userChannel,
    agentphoneAgentId: params.body.agentphoneAgentId,
  });
  if (!agentphoneAgentId) {
    return routeError(404, "AgentPhone agent not found", "NOT_FOUND");
  }

  try {
    const sent = await sendAgentPhoneMessage({
      agentphoneAgentId,
      toNumber: phoneHandle,
      body: params.body.text,
    });

    await storeOutboundAgentPhoneMessage({
      agentphoneMessageId: sent.id,
      conversationId: null,
      agentphoneAgentId,
      userLinkId: userLink.id,
      phoneHandle,
      fromNumber: sent.fromNumber ?? "",
      toNumber: sent.toNumber ?? phoneHandle,
      body: params.body.text,
      channel: sent.channel,
      userChannel,
    });

    return {
      ok: true,
      messageId: sent.id,
      channel: sent.channel,
      toNumber: sent.toNumber ?? phoneHandle,
    };
  } catch (error) {
    const routeErr = agentPhoneRouteError(error);
    if (routeErr) return routeErr;
    throw error;
  }
}

const router = tsr.router(integrationsPhoneMessageContract, {
  sendMessage: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "phone:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    if (!authCtx.orgId) {
      return routeError(401, "Not authenticated", "UNAUTHORIZED");
    }

    const result = await sendPhoneTextMessage({
      body,
      userId: authCtx.userId,
      orgId: authCtx.orgId,
    });
    if ("status" in result) return result;

    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(integrationsPhoneMessageContract, router, {
  routeName: "zero.integrations.phone.message",
});

export { handler as POST };
