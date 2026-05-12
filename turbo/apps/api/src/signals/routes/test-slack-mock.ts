import { command } from "ccstate";
import {
  SLACK_E2E_FIXTURES,
  SLACK_E2E_SCOPES,
  testSlackMockContract,
} from "@vm0/api-contracts/contracts/test-slack-mock";
import { e2eSlackMockCallLog } from "@vm0/db/schema/e2e-slack-mock-call-log";

import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { now } from "../../lib/time";
import type { RouteEntry } from "../route";
import { safeAsync, safeJsonParse } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

interface ParsedSlackMockBody {
  readonly rawBody: string;
  readonly bodyJson: Record<string, unknown> | null;
  readonly teamId: string | null;
  readonly channelId: string | null;
  readonly userId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function parsedJsonBody(rawBody: string): Record<string, unknown> | null {
  const parsed = safeJsonParse(rawBody);
  return isRecord(parsed) ? parsed : null;
}

function parsedFormBody(rawBody: string): Record<string, unknown> {
  const params = new URLSearchParams(rawBody);
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of params) {
    parsed[key] = value;
  }
  return parsed;
}

async function readSlackMockBody(
  request: Request,
  contentType: string,
): Promise<ParsedSlackMockBody> {
  const rawBody = await request.text();
  const bodyJson = contentType.includes("application/json")
    ? parsedJsonBody(rawBody)
    : parsedFormBody(rawBody);

  return {
    rawBody,
    bodyJson,
    teamId: bodyJson ? stringField(bodyJson, "team_id") : null,
    channelId: bodyJson
      ? (stringField(bodyJson, "channel_id") ??
        stringField(bodyJson, "channel"))
      : null,
    userId: bodyJson ? stringField(bodyJson, "user") : null,
  };
}

async function logSlackMockCall(
  db: Db,
  method: string,
  request: Request,
  contentType: string,
): Promise<void> {
  const parsed = await readSlackMockBody(request, contentType);
  await safeAsync(async () => {
    await db.insert(e2eSlackMockCallLog).values({
      method,
      teamId: parsed.teamId,
      channelId: parsed.channelId,
      body: parsed.rawBody,
      bodyJson: parsed.bodyJson,
    });
  });
}

function staticSlackMockHandler<T extends Record<string, unknown>>(
  bodyFactory: () => T,
) {
  return command(({ get }) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    return {
      status: 200 as const,
      body: bodyFactory(),
    };
  });
}

const ok$ = staticSlackMockHandler(() => {
  return { ok: true };
});

const authTest$ = staticSlackMockHandler(() => {
  return {
    ok: true,
    url: "https://e2e-mock.invalid/",
    team: SLACK_E2E_FIXTURES.teamName,
    user: "e2e-bot",
    team_id: SLACK_E2E_FIXTURES.teamId,
    user_id: SLACK_E2E_FIXTURES.botUserId,
    bot_id: SLACK_E2E_FIXTURES.botId,
  };
});

const oauthV2Access$ = staticSlackMockHandler(() => {
  return {
    ok: true,
    access_token: SLACK_E2E_FIXTURES.botToken,
    token_type: "bot",
    scope: SLACK_E2E_SCOPES.join(","),
    bot_user_id: SLACK_E2E_FIXTURES.botUserId,
    app_id: SLACK_E2E_FIXTURES.appId,
    team: {
      id: SLACK_E2E_FIXTURES.teamId,
      name: SLACK_E2E_FIXTURES.teamName,
    },
    enterprise: null,
    authed_user: {
      id: SLACK_E2E_FIXTURES.userUserId,
      scope: "",
      access_token: "",
      token_type: "user",
    },
  };
});

const conversationsOpen$ = staticSlackMockHandler(() => {
  return {
    ok: true,
    channel: { id: "D_E2E_MOCK" },
  };
});

const conversationMessages$ = staticSlackMockHandler(() => {
  return { ok: true, messages: [], has_more: false };
});

const chatPostMessage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  await logSlackMockCall(
    set(writeDb$),
    "chat.postMessage",
    request.raw,
    request.header("content-type") ?? "",
  );
  signal.throwIfAborted();

  const ts = `${Math.floor(now() / 1000)}.000100`;
  return {
    status: 200 as const,
    body: {
      ok: true,
      channel: SLACK_E2E_FIXTURES.channelId,
      ts,
      message: { ts, text: "mocked" },
    },
  };
});

const chatPostEphemeral$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    await logSlackMockCall(
      set(writeDb$),
      "chat.postEphemeral",
      request.raw,
      request.header("content-type") ?? "",
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true,
        message_ts: `${Math.floor(now() / 1000)}.000200`,
      },
    };
  },
);

const usersInfo$ = command(async ({ get }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const parsed = await readSlackMockBody(
    request.raw,
    request.header("content-type") ?? "",
  );
  signal.throwIfAborted();

  const userId = parsed.userId ?? SLACK_E2E_FIXTURES.userUserId;
  return {
    status: 200 as const,
    body: {
      ok: true,
      user: {
        id: userId,
        name: "e2e-user",
        real_name: "E2E User",
        tz: "UTC",
        tz_label: "Coordinated Universal Time",
        profile: {
          display_name: "e2e-user",
          real_name: "E2E User",
          email: "e2e@example.com",
        },
      },
    },
  };
});

export const testSlackMockRoutes: readonly RouteEntry[] = [
  {
    route: testSlackMockContract.assistantThreadsSetStatus,
    handler: ok$,
  },
  {
    route: testSlackMockContract.authTest,
    handler: authTest$,
  },
  {
    route: testSlackMockContract.chatPostEphemeral,
    handler: chatPostEphemeral$,
  },
  {
    route: testSlackMockContract.chatPostMessage,
    handler: chatPostMessage$,
  },
  {
    route: testSlackMockContract.conversationsHistory,
    handler: conversationMessages$,
  },
  {
    route: testSlackMockContract.conversationsOpen,
    handler: conversationsOpen$,
  },
  {
    route: testSlackMockContract.conversationsReplies,
    handler: conversationMessages$,
  },
  {
    route: testSlackMockContract.oauthV2Access,
    handler: oauthV2Access$,
  },
  {
    route: testSlackMockContract.usersInfo,
    handler: usersInfo$,
  },
  {
    route: testSlackMockContract.viewsPublish,
    handler: ok$,
  },
];
