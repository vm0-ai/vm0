import { NextResponse, after } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../src/lib/slack/verify";
import { handleAppMention } from "../../../../src/lib/slack/handlers/mention";
import { handleDirectMessage } from "../../../../src/lib/slack/handlers/direct-message";
import {
  handleAppHomeOpened,
  handleMessagesTabOpened,
} from "../../../../src/lib/slack/handlers/app-home-opened";
import { logger } from "../../../../src/lib/logger";

const log = logger("slack:events");

/**
 * Slack Events API Endpoint
 *
 * POST /api/slack/events
 *
 * Handles incoming events from Slack:
 * - URL verification challenge (for initial setup)
 * - app_mention events (when users @mention the bot)
 * - message events with channel_type "im" (direct messages to the bot)
 *
 * Important: Must respond within 3 seconds to avoid Slack retries.
 * Uses Next.js after() to process events in the background while keeping
 * the serverless function alive until completion.
 */

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
  event_ts: string;
  thread_ts?: string;
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
}

interface SlackAppHomeOpenedEvent {
  type: "app_home_opened";
  user: string;
  tab: "home" | "messages";
  channel: string;
}

interface SlackEventCallback {
  type: "event_callback";
  token: string;
  team_id: string;
  api_app_id: string;
  event:
    | SlackAppMentionEvent
    | SlackDirectMessageEvent
    | SlackAppHomeOpenedEvent;
  event_id: string;
  event_time: number;
  authorizations?: Array<{
    enterprise_id: string | null;
    team_id: string;
    user_id: string;
    is_bot: boolean;
    is_enterprise_install: boolean;
  }>;
}

type SlackEvent = SlackUrlVerificationEvent | SlackEventCallback;

export async function POST(request: Request) {
  const { SLACK_SIGNING_SECRET } = env();

  if (!SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  // Get raw body for signature verification
  const body = await request.text();

  // Verify Slack signature
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

  // Parse the event
  let payload: SlackEvent;
  try {
    payload = JSON.parse(body) as SlackEvent;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  // Handle URL verification challenge (for initial app setup)
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Handle event callbacks
  if (payload.type === "event_callback") {
    const event = payload.event;

    // Handle app_mention events
    if (event.type === "app_mention") {
      initServices();

      // Use after() to ensure the background task completes
      // This prevents Vercel from freezing the function and closing DB connections
      after(
        handleAppMention({
          workspaceId: payload.team_id,
          channelId: event.channel,
          userId: event.user,
          messageText: event.text,
          messageTs: event.ts,
          threadTs: event.thread_ts,
        }).catch((error) => {
          log.error("Error handling app_mention", { error });
        }),
      );
    }

    // Handle direct message events
    if (
      event.type === "message" &&
      event.channel_type === "im" &&
      !event.subtype &&
      !event.bot_id
    ) {
      initServices();

      after(
        handleDirectMessage({
          workspaceId: payload.team_id,
          channelId: event.channel,
          userId: event.user,
          messageText: event.text,
          messageTs: event.ts,
          threadTs: event.thread_ts,
        }).catch((error) => {
          log.error("Error handling direct_message", { error });
        }),
      );
    }

    // Handle app_home_opened events (Home tab)
    if (event.type === "app_home_opened" && event.tab === "home") {
      initServices();

      after(
        handleAppHomeOpened({
          workspaceId: payload.team_id,
          userId: event.user,
        }).catch((error) => {
          log.error("Error handling app_home_opened", { error });
        }),
      );
    }

    // Handle app_home_opened events (Messages tab)
    if (event.type === "app_home_opened" && event.tab === "messages") {
      initServices();

      after(
        handleMessagesTabOpened({
          workspaceId: payload.team_id,
          userId: event.user,
          channelId: event.channel,
        }).catch((error) => {
          log.error("Error handling messages_tab_opened", { error });
        }),
      );
    }

    // Return 200 OK immediately
    return new Response("OK", { status: 200 });
  }

  // Unknown event type
  return new Response("OK", { status: 200 });
}
