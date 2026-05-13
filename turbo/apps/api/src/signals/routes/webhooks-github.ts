import { createHmac, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { webhookGithubContract } from "@vm0/api-contracts/contracts/webhooks";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { now } from "../external/time";
import { safeAsync, safeJsonParse } from "../utils";
import {
  gitHubInstallationEventSchema,
  gitHubIssueCommentEventSchema,
  gitHubIssuesEventSchema,
  handleGithubInstallationEvent$,
  handleGithubIssueCommentEvent$,
  handleGithubIssuesEvent$,
} from "../services/webhooks-github.service";

const L = logger("WebhookGithubRoute");

interface GithubWebhookHeaders {
  readonly signature: string;
  readonly event: string;
  readonly deliveryId: string;
}

function jsonError(message: string, status: 400 | 401 | 503): Response {
  return Response.json({ error: message }, { status });
}

function githubWebhookHeaders(headers: Headers): GithubWebhookHeaders | null {
  const signature = headers.get("x-hub-signature-256");
  const event = headers.get("x-github-event");
  const deliveryId = headers.get("x-github-delivery");
  return signature && event && deliveryId
    ? { signature, event, deliveryId }
    : null;
}

async function verifyGitHubWebhookSignature(args: {
  readonly secret: string;
  readonly signature: string;
  readonly body: string;
}): Promise<boolean> {
  const expected = `sha256=${createHmac("sha256", args.secret)
    .update(args.body)
    .digest("hex")}`;

  const result = await safeAsync(() => {
    return Promise.resolve(
      timingSafeEqual(Buffer.from(args.signature), Buffer.from(expected)),
    );
  });
  return "ok" in result ? result.ok : false;
}

const postGithubWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const apiStartTime = now();
    const webhookSecret = optionalEnv("GITHUB_APP_WEBHOOK_SECRET");
    const appSlug = optionalEnv("GITHUB_APP_SLUG");

    if (!webhookSecret) {
      return jsonError("GitHub App integration is not configured", 503);
    }

    const request = get(request$);
    const headers = githubWebhookHeaders(request.raw.headers);
    if (!headers) {
      return jsonError("Missing GitHub webhook headers", 401);
    }

    const body = await request.text();
    signal.throwIfAborted();

    const signatureVerified = await verifyGitHubWebhookSignature({
      secret: webhookSecret,
      signature: headers.signature,
      body,
    });
    signal.throwIfAborted();

    if (!signatureVerified) {
      return jsonError("Invalid signature", 401);
    }

    const payload = safeJsonParse(body);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return jsonError("Invalid JSON payload", 400);
    }

    if (headers.event === "ping") {
      return Response.json({ message: "pong" });
    }

    if (headers.event === "issues") {
      const parsed = gitHubIssuesEventSchema.safeParse(payload);
      if (!parsed.success) {
        L.error("Invalid issues event payload", { error: parsed.error });
        return jsonError("Invalid payload structure", 400);
      }

      waitUntil(
        set(
          handleGithubIssuesEvent$,
          { payload: parsed.data, appSlug, apiStartTime },
          signal,
        ).catch((error: unknown) => {
          L.error("Error handling issues event", { error });
        }),
      );
      return new Response("OK", { status: 200 });
    }

    if (headers.event === "issue_comment") {
      const parsed = gitHubIssueCommentEventSchema.safeParse(payload);
      if (!parsed.success) {
        L.error("Invalid issue_comment event payload", {
          error: parsed.error,
        });
        return jsonError("Invalid payload structure", 400);
      }

      waitUntil(
        set(
          handleGithubIssueCommentEvent$,
          { payload: parsed.data, appSlug, apiStartTime },
          signal,
        ).catch((error: unknown) => {
          L.error("Error handling issue_comment event", { error });
        }),
      );
      return new Response("OK", { status: 200 });
    }

    if (headers.event === "installation") {
      const parsed = gitHubInstallationEventSchema.safeParse(payload);
      if (!parsed.success) {
        L.error("Invalid installation event payload", { error: parsed.error });
        return jsonError("Invalid payload structure", 400);
      }

      waitUntil(
        set(handleGithubInstallationEvent$, parsed.data, signal).catch(
          (error: unknown) => {
            L.error("Error handling installation event", { error });
          },
        ),
      );
      return new Response("OK", { status: 200 });
    }

    L.debug("Ignoring unhandled GitHub event", { event: headers.event });
    return new Response("OK", { status: 200 });
  },
);

export const webhooksGithubRoutes: readonly RouteEntry[] = [
  {
    route: webhookGithubContract.post,
    handler: postGithubWebhook$,
  },
];
