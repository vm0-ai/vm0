import { NextResponse, after } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../../src/lib/zero/slack/verify";
import { handleOrgMention } from "../../../../../src/lib/zero/slack-org/handlers/mention";
import { handleOrgDirectMessage } from "../../../../../src/lib/zero/slack-org/handlers/direct-message";
import {
  handleOrgAppHomeOpened,
  handleOrgMessagesTabOpened,
} from "../../../../../src/lib/zero/slack-org/handlers/app-home";
import { cleanupWorkspaceInstallation } from "../../../../../src/lib/zero/slack-org/connect-service";
import type { SlackFile } from "../../../../../src/lib/zero/slack/context";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("slack-org:events");

interface SlackUrlVerificationEvent {
  type: "url_verification";
  challenge: string;
  token: string;
}

interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  ts: string;
  channel: string;
  channel_type?: string;
  event_ts: string;
  thread_ts?: string;
  files?: SlackFile[];
}

interface SlackDirectMessageEvent {
  type: "message";
  channel_type: "im";
  user: string;
  text: string;
  ts: string;
  channel: string;
  event_ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFile[];
}

interface SlackAppHomeOpenedEvent {
  type: "app_home_opened";
  user: string;
  tab: "home" | "messages";
  channel: string;
}

interface SlackAppUninstalledEvent {
  type: "app_uninstalled";
}

interface SlackTokensRevokedEvent {
  type: "tokens_revoked";
  tokens: {
    oauth?: string[];
    bot?: string[];
  };
}

interface SlackEventCallback {
  type: "event_callback";
  token: string;
  team_id: string;
  api_app_id: string;
  event:
    | SlackAppMentionEvent
    | SlackDirectMessageEvent
    | SlackAppHomeOpenedEvent
    | SlackAppUninstalledEvent
    | SlackTokensRevokedEvent;
  event_time: number;
}

type SlackEvent = SlackUrlVerificationEvent | SlackEventCallback;

function handleEventCallback(payload: SlackEventCallback) {
  const event = payload.event;

  if (event.type === "app_mention") {
    initServices();
    after(() => {
      return handleOrgMention({
        workspaceId: payload.team_id,
        channelId: event.channel,
        channelType: event.channel_type,
        userId: event.user,
        messageText: event.text,
        messageTs: event.ts,
        threadTs: event.thread_ts,
        files: event.files,
      }).catch((error) => {
        log.error("Error handling org app_mention", { error });
      });
    });
  }

  if (
    event.type === "message" &&
    event.channel_type === "im" &&
    (!event.subtype || event.subtype === "file_share") &&
    !event.bot_id
  ) {
    initServices();
    after(() => {
      return handleOrgDirectMessage({
        workspaceId: payload.team_id,
        channelId: event.channel,
        userId: event.user,
        messageText: event.text,
        files: event.files,
        messageTs: event.ts,
        threadTs: event.thread_ts,
      }).catch((error) => {
        log.error("Error handling org direct_message", { error });
      });
    });
  }

  if (event.type === "app_home_opened" && event.tab === "home") {
    initServices();
    after(() => {
      return handleOrgAppHomeOpened({
        workspaceId: payload.team_id,
        userId: event.user,
      }).catch((error) => {
        log.error("Error handling org app_home_opened", { error });
      });
    });
  }

  if (event.type === "app_home_opened" && event.tab === "messages") {
    initServices();
    after(() => {
      return handleOrgMessagesTabOpened({
        workspaceId: payload.team_id,
        userId: event.user,
        channelId: event.channel,
      }).catch((error) => {
        log.error("Error handling org messages_tab_opened", { error });
      });
    });
  }

  if (event.type === "app_uninstalled") {
    initServices();
    after(() => {
      return cleanupWorkspaceInstallation(payload.team_id).catch((error) => {
        log.error("Error handling app_uninstalled", { error });
      });
    });
  }

  if (
    event.type === "tokens_revoked" &&
    event.tokens.bot &&
    event.tokens.bot.length > 0
  ) {
    initServices();
    after(() => {
      return cleanupWorkspaceInstallation(payload.team_id).catch((error) => {
        log.error("Error handling tokens_revoked", { error });
      });
    });
  }
}

/**
 * POST /api/zero/slack/events
 *
 * Org-aware Slack Events API endpoint.
 * Must respond within 3 seconds to avoid Slack retries.
 */
export async function POST(request: Request) {
  const { SLACK_SIGNING_SECRET } = env();

  if (!SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  const body = await request.text();
  const headers = getSlackSignatureHeaders(request.headers);
  if (!headers) {
    return NextResponse.json(
      { error: "Missing Slack signature headers" },
      { status: 401 },
    );
  }

  const isValid = verifySlackSignature(
    SLACK_SIGNING_SECRET,
    headers.signature,
    headers.timestamp,
    body,
  );

  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: SlackEvent;
  try {
    payload = JSON.parse(body) as SlackEvent;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    // Slack retries delivery when it doesn't receive a response within 3 seconds.
    // Ignore retry requests to prevent duplicate agent runs.
    if (request.headers.get("x-slack-retry-num")) {
      return new Response("OK", { status: 200 });
    }
    handleEventCallback(payload);
    return new Response("OK", { status: 200 });
  }

  return new Response("OK", { status: 200 });
}
