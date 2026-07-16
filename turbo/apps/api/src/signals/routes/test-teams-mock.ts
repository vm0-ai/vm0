import { command } from "ccstate";
import { testTeamsMockContract } from "@vm0/api-contracts/contracts/test-teams-mock";
import { e2eTeamsMockCallLog } from "@vm0/db/schema/e2e-teams-mock-call-log";

import { now } from "../../lib/time";
import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { bestEffort, safeJsonParse } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readTenantId(bodyJson: unknown): string | null {
  if (!isRecord(bodyJson)) {
    return null;
  }
  const channelData = bodyJson.channelData;
  if (!isRecord(channelData)) {
    return null;
  }
  const tenant = channelData.tenant;
  if (!isRecord(tenant)) {
    return null;
  }
  return typeof tenant.id === "string" ? tenant.id : null;
}

function parseJsonValue(rawBody: string): unknown | null {
  if (rawBody.length === 0) {
    return null;
  }
  const parsed = safeJsonParse(rawBody);
  return parsed === undefined ? null : parsed;
}

function decodePathParam(value: string): string {
  return decodeURIComponent(value);
}

async function logTeamsMockCall(args: {
  readonly db: Db;
  readonly method: string;
  readonly rawBody: string;
  readonly bodyJson: unknown;
  readonly tenantId?: string | null;
  readonly conversationId?: string | null;
  readonly activityId?: string | null;
}): Promise<void> {
  await bestEffort(
    args.db.insert(e2eTeamsMockCallLog).values({
      method: args.method,
      tenantId: args.tenantId ?? readTenantId(args.bodyJson),
      conversationId: args.conversationId ?? null,
      activityId: args.activityId ?? null,
      body: args.rawBody,
      bodyJson: args.bodyJson,
    }),
  );
}

const token$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const rawBody = await request.raw.clone().text();
  signal.throwIfAborted();
  await logTeamsMockCall({
    db: set(writeDb$),
    method: "token",
    rawBody,
    bodyJson: null,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      access_token: "e2e-teams-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    },
  };
});

const createConversation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const rawBody = await request.raw.clone().text();
    signal.throwIfAborted();
    const bodyJson = parseJsonValue(rawBody);
    await logTeamsMockCall({
      db: set(writeDb$),
      method: "createConversation",
      rawBody,
      bodyJson,
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { id: "19:e2e-personal-conversation@thread.v2" },
    };
  },
);

const sendActivity$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const { conversationId } = get(
    pathParamsOf(testTeamsMockContract.sendActivity),
  );
  const rawBody = await request.raw.clone().text();
  signal.throwIfAborted();
  const bodyJson = parseJsonValue(rawBody);
  await logTeamsMockCall({
    db: set(writeDb$),
    method: "sendActivity",
    rawBody,
    bodyJson,
    conversationId: decodePathParam(conversationId),
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { id: `activity-${Math.floor(now() % 1_000_000_000)}` },
  };
});

const replyActivity$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const { conversationId, activityId } = get(
    pathParamsOf(testTeamsMockContract.replyActivity),
  );
  const rawBody = await request.raw.clone().text();
  signal.throwIfAborted();
  const bodyJson = parseJsonValue(rawBody);
  await logTeamsMockCall({
    db: set(writeDb$),
    method: "replyActivity",
    rawBody,
    bodyJson,
    conversationId: decodePathParam(conversationId),
    activityId: decodePathParam(activityId),
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { id: `reply-${Math.floor(now() % 1_000_000_000)}` },
  };
});

function reactionHandler(
  method: "putReaction" | "deleteReaction",
  route:
    | typeof testTeamsMockContract.putReaction
    | typeof testTeamsMockContract.deleteReaction,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const { conversationId, activityId } = get(pathParamsOf(route));
    await logTeamsMockCall({
      db: set(writeDb$),
      method,
      rawBody: "",
      bodyJson: null,
      conversationId: decodePathParam(conversationId),
      activityId: decodePathParam(activityId),
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { ok: true as const },
    };
  });
}

const graphMessages$ = command(({ get }): Response => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }
  return jsonResponse({ value: [] });
});

const graphMessage$ = command(({ get }): Response => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }
  const { messageId } = get(pathParamsOf(testTeamsMockContract.graphMessage));
  return jsonResponse({
    id: messageId,
    createdDateTime: "2026-07-13T00:00:00.000Z",
    messageType: "message",
    from: {
      user: {
        id: "aad-e2e-user",
        displayName: "E2E User",
        userPrincipalName: "e2e@example.test",
      },
    },
    body: { contentType: "text", content: "E2E Teams context" },
  });
});

const graphUser$ = command(({ get }): Response => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }
  const { userId } = get(pathParamsOf(testTeamsMockContract.graphUser));
  return jsonResponse({
    id: userId,
    displayName: "E2E User",
    userPrincipalName: "e2e@example.test",
    mail: "e2e@example.test",
  });
});

export const testTeamsMockRoutes: readonly RouteEntry[] = [
  {
    route: testTeamsMockContract.token,
    handler: token$,
  },
  {
    route: testTeamsMockContract.createConversation,
    handler: createConversation$,
  },
  {
    route: testTeamsMockContract.sendActivity,
    handler: sendActivity$,
  },
  {
    route: testTeamsMockContract.replyActivity,
    handler: replyActivity$,
  },
  {
    route: testTeamsMockContract.putReaction,
    handler: reactionHandler("putReaction", testTeamsMockContract.putReaction),
  },
  {
    route: testTeamsMockContract.deleteReaction,
    handler: reactionHandler(
      "deleteReaction",
      testTeamsMockContract.deleteReaction,
    ),
  },
  {
    route: testTeamsMockContract.graphMessages,
    handler: graphMessages$,
  },
  {
    route: testTeamsMockContract.graphMessage,
    handler: graphMessage$,
  },
  {
    route: testTeamsMockContract.graphReplies,
    handler: graphMessages$,
  },
  {
    route: testTeamsMockContract.graphUser,
    handler: graphUser$,
  },
];
