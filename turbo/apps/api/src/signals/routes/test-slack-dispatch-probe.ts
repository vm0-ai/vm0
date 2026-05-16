import { command } from "ccstate";
import {
  testSlackDispatchProbeContract,
  type TestSlackDispatchProbeBody,
} from "@vm0/api-contracts/contracts/test-slack-dispatch-probe";

import { request$ } from "../context/hono";
import { now } from "../external/time";
import type { RouteEntry } from "../route";
import { dispatchZeroSlackProbe$ } from "../services/zero-slack-webhooks.service";
import { settle } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const REQUIRED_FIELDS_ERROR =
  "team_id, channel_id, user_id, message_text, message_ts required";

interface SerializedProbeError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseProbeBody(value: unknown): TestSlackDispatchProbeBody | null {
  if (!isRecord(value)) {
    return null;
  }

  const teamId = readString(value, "team_id");
  const channelId = readString(value, "channel_id");
  const userId = readString(value, "user_id");
  const messageText = readString(value, "message_text");
  const messageTs = readString(value, "message_ts");
  if (!teamId || !channelId || !userId || !messageText || !messageTs) {
    return null;
  }

  const channelType = readString(value, "channel_type");
  return {
    team_id: teamId,
    channel_id: channelId,
    user_id: userId,
    message_text: messageText,
    message_ts: messageTs,
    ...(channelType === "im" || channelType === "channel"
      ? { channel_type: channelType }
      : {}),
  };
}

function readOptionalErrorString(
  error: Error,
  key: string,
): string | undefined {
  const value = (error as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function serializeProbeError(error: unknown): SerializedProbeError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: readOptionalErrorString(error, "code"),
      stack: error.stack?.split("\n").slice(0, 10).join("\n"),
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

const postSlackDispatchProbe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const settled = await settle(request.json());
    signal.throwIfAborted();
    const rawBody: unknown = settled.ok ? settled.value : null;

    const body = parseProbeBody(rawBody);
    if (!body) {
      return {
        status: 400 as const,
        body: { error: REQUIRED_FIELDS_ERROR },
      };
    }

    const dispatchResult = await settle(
      set(
        dispatchZeroSlackProbe$,
        {
          workspaceId: body.team_id,
          channelId: body.channel_id,
          channelType: body.channel_type === "im" ? "dm" : "channel",
          slackUserId: body.user_id,
          messageText: body.message_text,
          messageTs: body.message_ts,
          apiStartTime: now(),
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!dispatchResult.ok) {
      return {
        status: 200 as const,
        body: {
          ok: false as const,
          error: serializeProbeError(dispatchResult.error),
        },
      };
    }

    return {
      status: 200 as const,
      body: { ok: true as const },
    };
  },
);

export const testSlackDispatchProbeRoutes: readonly RouteEntry[] = [
  {
    route: testSlackDispatchProbeContract.post,
    handler: postSlackDispatchProbe$,
  },
];
