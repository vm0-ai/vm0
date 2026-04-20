import { NextResponse, after } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  verifyGitHubWebhookSignature,
  getGitHubWebhookHeaders,
} from "../../../../src/lib/zero/github/verify-webhook";
import {
  handleIssuesEvent,
  handleIssueCommentEvent,
  gitHubIssuesEventSchema,
  gitHubIssueCommentEventSchema,
} from "../../../../src/lib/zero/github/handlers/issue-event";
import {
  handleInstallationCreatedEvent,
  gitHubInstallationEventSchema,
} from "../../../../src/lib/zero/github/handlers/installation-event";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("webhook:github");

/**
 * GitHub Webhook Endpoint
 *
 * POST /api/webhooks/github
 *
 * Handles incoming events from the GitHub App:
 * - issues (opened, labeled) — trigger agent on new/labeled issues
 * - issue_comment (created) — trigger agent on new comments
 *
 * Important: Must respond within GitHub's 10-second timeout.
 * Uses Next.js after() to process events in the background.
 */
export async function POST(request: Request) {
  const apiStartTime = Date.now();
  const { GITHUB_APP_WEBHOOK_SECRET, GITHUB_APP_SLUG } = env();

  if (!GITHUB_APP_WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "GitHub App integration is not configured" },
      { status: 503 },
    );
  }

  // Extract and validate headers
  const headers = getGitHubWebhookHeaders(request.headers);
  if (!headers) {
    return NextResponse.json(
      { error: "Missing GitHub webhook headers" },
      { status: 401 },
    );
  }

  // Get raw body for signature verification
  const body = await request.text();

  // Verify webhook signature
  const isValid = verifyGitHubWebhookSignature(
    GITHUB_APP_WEBHOOK_SECRET,
    headers.signature,
    body,
  );

  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse the payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  // Handle ping event (sent when webhook is first configured)
  if (headers.event === "ping") {
    return NextResponse.json({ message: "pong" });
  }

  // Route to event-specific handlers
  if (headers.event === "issues") {
    const parsed = gitHubIssuesEventSchema.safeParse(payload);
    if (!parsed.success) {
      log.error("Invalid issues event payload", { error: parsed.error });
      return NextResponse.json(
        { error: "Invalid payload structure" },
        { status: 400 },
      );
    }

    initServices();

    after(() => {
      return handleIssuesEvent(
        parsed.data,
        GITHUB_APP_SLUG,
        apiStartTime,
      ).catch((error) => {
        log.error("Error handling issues event", { error });
      });
    });

    return new Response("OK", { status: 200 });
  }

  if (headers.event === "issue_comment") {
    const parsed = gitHubIssueCommentEventSchema.safeParse(payload);
    if (!parsed.success) {
      log.error("Invalid issue_comment event payload", {
        error: parsed.error,
      });
      return NextResponse.json(
        { error: "Invalid payload structure" },
        { status: 400 },
      );
    }

    initServices();

    after(() => {
      return handleIssueCommentEvent(
        parsed.data,
        GITHUB_APP_SLUG,
        apiStartTime,
      ).catch((error) => {
        log.error("Error handling issue_comment event", { error });
      });
    });

    return new Response("OK", { status: 200 });
  }

  if (headers.event === "installation") {
    const parsed = gitHubInstallationEventSchema.safeParse(payload);
    if (!parsed.success) {
      log.error("Invalid installation event payload", { error: parsed.error });
      return NextResponse.json(
        { error: "Invalid payload structure" },
        { status: 400 },
      );
    }

    initServices();

    after(() => {
      return handleInstallationCreatedEvent(parsed.data).catch((error) => {
        log.error("Error handling installation event", { error });
      });
    });

    return new Response("OK", { status: 200 });
  }

  // Unknown event type — acknowledge but don't process
  log.debug("Ignoring unhandled GitHub event", { event: headers.event });
  return new Response("OK", { status: 200 });
}
