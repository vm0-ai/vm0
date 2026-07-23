import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { integrationsFeishuMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  FeishuApiError,
  replyWithFeishuMessage,
  sendFeishuMessage,
  type FeishuOutboundMessage,
} from "../external/feishu-client";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

function apiError(
  status: 400 | 404 | 502,
  code: "BAD_REQUEST" | "FEISHU_ERROR" | "NOT_FOUND",
  message: string,
) {
  return {
    status,
    body: { error: { code, message } },
  } as const;
}

const sendMessage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsFeishuMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;
  const db = set(writeDb$);
  const installations = await db
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.orgId, auth.orgId),
        isNotNull(feishuOrgInstallations.setupCompletedAt),
        ...(body.installationId
          ? [eq(feishuOrgInstallations.id, body.installationId)]
          : []),
      ),
    )
    .limit(2);
  signal.throwIfAborted();
  const installation = installations[0];
  if (!installation) {
    return apiError(
      404,
      "NOT_FOUND",
      body.installationId
        ? "Feishu installation not found"
        : "No Feishu installation found for this organization",
    );
  }
  if (!body.installationId && installations.length > 1) {
    return apiError(
      400,
      "BAD_REQUEST",
      "Multiple Feishu installations are available. Specify installationId.",
    );
  }

  let userOpenId = body.user;
  if (userOpenId === "me") {
    const [connection] = await db
      .select({ openId: feishuOrgConnections.feishuOpenId })
      .from(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.installationId, installation.id),
          eq(feishuOrgConnections.vm0UserId, auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      return apiError(
        404,
        "NOT_FOUND",
        "No Feishu connection found for the current user",
      );
    }
    userOpenId = connection.openId;
  }

  const message: FeishuOutboundMessage = body.card
    ? { msgType: "interactive", content: body.card }
    : { msgType: "text", content: { text: body.text } };
  const receiveId = userOpenId ?? body.chat;
  let delivery: ReturnType<typeof sendFeishuMessage>;
  if (body.replyToMessageId) {
    delivery = replyWithFeishuMessage({
      db,
      installationId: installation.id,
      messageId: body.replyToMessageId,
      message,
      replyInThread: body.replyInThread,
      signal,
    });
  } else if (receiveId) {
    delivery = sendFeishuMessage({
      db,
      installationId: installation.id,
      receiveIdType: userOpenId ? "open_id" : "chat_id",
      receiveId,
      message,
      signal,
    });
  } else {
    return apiError(400, "BAD_REQUEST", "A Feishu message target is required");
  }
  const sent = await settle(delivery, signal);
  if (!sent.ok) {
    if (sent.error instanceof FeishuApiError) {
      return apiError(
        sent.error.routeStatus,
        "FEISHU_ERROR",
        `Feishu API error: ${sent.error.message}`,
      );
    }
    throw sent.error;
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      messageId: sent.value.messageId,
      chatId: sent.value.chatId,
    },
  };
});

export const zeroIntegrationsFeishuMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsFeishuMessageContract.sendMessage,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "feishu:write",
      },
      sendMessage$,
    ),
  },
];
