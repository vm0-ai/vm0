import { createHmac, randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import type { RouteEntry } from "../../route-entry";
import { feishuOauthRoutes } from "../feishu-oauth";
import { slackCommandsRoutes } from "../slack-commands";
import { slackEventsRoutes } from "../slack-events";
import { slackInteractiveRoutes } from "../slack-interactive";
import { slackOauthRoutes } from "../slack-oauth";
import { teamsOauthRoutes } from "../teams-oauth";

const context = testContext();
const REQUEST_ORIGIN = "http://api.test";
const APP_ORIGIN = "https://app.vm0.test";
const WEB_ORIGIN = "https://www.vm0.test";
// Generated rather than written as a literal so this file does not add another
// hardcoded HMAC key, which the diff-aware Semgrep scan rejects outright.
const SLACK_SIGNING_SECRET = randomBytes(32).toString("hex");
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

interface ResponseSnapshot {
  readonly status: number;
  readonly location: string | null;
  readonly body: string;
}

// Every request below is replayed on the branded paths that serve it today and
// on the neutral path from #28278, so the assertion is that all three produce
// the same response rather than merely that the neutral path is routed.
//
// Every endpoint using this helper declares its neutral path and gains both
// branded forms from `MIGRATED_BRANDED_PATHS` — the Teams OAuth callback in
// #28545. Which mechanism produces which registration is deliberately not
// asserted; what a caller can reach is the same either way, and that is the
// property this file exists to pin. A dropped row on either side shows up here
// as one of the three forms answering differently.
//
// The Slack blocks below are narrowed to the path that serves them, because the
// consoles and producers that held their branded forms have moved. #28600 put
// the Slack OAuth callback and the three inbound webhooks on neutral paths with
// rows for both branded forms; #30668 retired those four rows once the Slack app
// console was repointed at `/api/webhooks/slack/*` and `routes/slack-oauth.ts`
// began emitting the neutral `redirect_uri`. The Feishu OAuth callback was
// narrowed the same way by #28709.
function namespacePaths(
  brandedSuffix: string,
  finalPath: string,
): readonly string[] {
  return [`/api/okou${brandedSuffix}`, `/api/zero${brandedSuffix}`, finalPath];
}

async function snapshot(response: Response): Promise<ResponseSnapshot> {
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.text(),
  };
}

async function snapshotEachPath(
  paths: readonly string[],
  send: (path: string) => Promise<Response>,
): Promise<readonly ResponseSnapshot[]> {
  const snapshots: ResponseSnapshot[] = [];
  for (const path of paths) {
    snapshots.push(await snapshot(await send(path)));
  }
  return snapshots;
}

function repeated(
  expected: ResponseSnapshot,
  paths: readonly string[],
): readonly ResponseSnapshot[] {
  return paths.map(() => {
    return expected;
  });
}

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

function getRequest(routes: readonly RouteEntry[]) {
  return async (path: string): Promise<Response> => {
    const app = createAppWithRoutes({ signal: context.signal, routes });
    return await app.request(`${REQUEST_ORIGIN}${path}`, { method: "GET" });
  };
}

function signedSlackHeaders(body: string): Record<string, string> {
  const timestamp = String(Math.floor(now() / 1000));
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", SLACK_SIGNING_SECRET)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`,
  };
}

function slackIngressRequest(args: {
  readonly routes: readonly RouteEntry[];
  readonly body: string;
  readonly contentType: string;
  readonly signed: boolean;
}) {
  return async (path: string): Promise<Response> => {
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: args.routes,
    });
    return await app.request(`${REQUEST_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": args.contentType,
        ...(args.signed ? signedSlackHeaders(args.body) : {}),
      },
      body: args.body,
    });
  };
}

describe("provider console paths", () => {
  beforeEach(() => {
    mockEnv("APP_URL", APP_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);
    mockEnv("SLACK_OAUTH_CLIENT_ID", "slack-client-id");
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-client-secret");
    mockOptionalEnv("SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET);
    mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "microsoft-client-id");
    mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "microsoft-client-secret");
  });

  describe("GET /api/integrations/slack/oauth/callback", () => {
    const paths = ["/api/integrations/slack/oauth/callback"];

    it("rejects a callback without an authorization code identically", async () => {
      const snapshots = await snapshotEachPath(
        paths,
        getRequest(slackOauthRoutes),
      );

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 400,
            location: null,
            body: jsonBody({ error: "Missing authorization code" }),
          },
          paths,
        ),
      );
    });

    it("builds the same failure redirect for a denied authorization", async () => {
      const send = getRequest(slackOauthRoutes);
      const snapshots = await snapshotEachPath(paths, (path) => {
        return send(`${path}?error=access_denied`);
      });

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 307,
            location: `${APP_ORIGIN}/slack/failed?error=access_denied`,
            body: "",
          },
          paths,
        ),
      );
    });
  });

  // Kept here after #28545 moved the contract onto the final path: what this
  // block asserts is that all three forms answer identically, which is the
  // property the move has to preserve.
  describe("GET /api/integrations/teams/oauth/callback", () => {
    const paths = namespacePaths(
      "/teams/oauth/callback",
      "/api/integrations/teams/oauth/callback",
    );

    it("rejects a callback without an authorization code identically", async () => {
      const snapshots = await snapshotEachPath(
        paths,
        getRequest(teamsOauthRoutes),
      );

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 400,
            location: null,
            body: jsonBody({ error: "Missing authorization code" }),
          },
          paths,
        ),
      );
    });

    it("builds the same failure redirect for a denied authorization", async () => {
      const send = getRequest(teamsOauthRoutes);
      const snapshots = await snapshotEachPath(paths, (path) => {
        return send(`${path}?error=access_denied`);
      });

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 307,
            location: `${APP_ORIGIN}/settings/teams?error=access_denied`,
            body: "",
          },
          paths,
        ),
      );
    });
  });

  // The one endpoint in this file that no longer has branded forms. #28544
  // moved the contract to the neutral path and gave it a
  // `MIGRATED_BRANDED_PATHS` row; #28709 removed that row, because the only
  // thing holding the branded form was an already-loaded platform tab
  // forwarding a code, a window that closed well before the retained request
  // log begins. The case stays because the callback is still reached from a
  // Feishu console flow, narrowed to the path that serves it.
  describe("GET /api/integrations/feishu/oauth/callback", () => {
    it("rejects a callback without connect state", async () => {
      const snapshots = await snapshotEachPath(
        ["/api/integrations/feishu/oauth/callback"],
        getRequest(feishuOauthRoutes),
      );

      expect(snapshots).toStrictEqual([
        {
          status: 400,
          location: null,
          body: jsonBody({ error: "Invalid or expired connect state" }),
        },
      ]);
    });
  });

  describe("POST /api/webhooks/slack/events", () => {
    const paths = ["/api/webhooks/slack/events"];
    const body = jsonBody({
      type: "url_verification",
      challenge: "provider-console-challenge",
    });

    it("verifies the Slack signature and answers URL verification", async () => {
      const snapshots = await snapshotEachPath(
        paths,
        slackIngressRequest({
          routes: slackEventsRoutes,
          body,
          contentType: "application/json",
          signed: true,
        }),
      );

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 200,
            location: null,
            body: jsonBody({ challenge: "provider-console-challenge" }),
          },
          paths,
        ),
      );
    });

    it("rejects an unsigned request identically", async () => {
      const snapshots = await snapshotEachPath(
        paths,
        slackIngressRequest({
          routes: slackEventsRoutes,
          body,
          contentType: "application/json",
          signed: false,
        }),
      );

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 401,
            location: null,
            body: jsonBody({ error: "Missing Slack signature headers" }),
          },
          paths,
        ),
      );
    });
  });

  describe("POST /api/webhooks/slack/commands", () => {
    const paths = ["/api/webhooks/slack/commands"];
    const body = "command=%2Fzero&text=help";

    it("verifies the Slack signature before parsing the command", async () => {
      const snapshots = await snapshotEachPath(
        paths,
        slackIngressRequest({
          routes: slackCommandsRoutes,
          body,
          contentType: FORM_CONTENT_TYPE,
          signed: true,
        }),
      );

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 400,
            location: null,
            body: jsonBody({ error: "Missing required Slack command fields" }),
          },
          paths,
        ),
      );
    });

    it("rejects an unsigned request identically", async () => {
      const snapshots = await snapshotEachPath(
        paths,
        slackIngressRequest({
          routes: slackCommandsRoutes,
          body,
          contentType: FORM_CONTENT_TYPE,
          signed: false,
        }),
      );

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 401,
            location: null,
            body: jsonBody({ error: "Missing Slack signature headers" }),
          },
          paths,
        ),
      );
    });
  });

  describe("POST /api/webhooks/slack/interactive", () => {
    const paths = ["/api/webhooks/slack/interactive"];
    const body = "not_a_payload=1";

    it("verifies the Slack signature before parsing the payload", async () => {
      const snapshots = await snapshotEachPath(
        paths,
        slackIngressRequest({
          routes: slackInteractiveRoutes,
          body,
          contentType: FORM_CONTENT_TYPE,
          signed: true,
        }),
      );

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 400,
            location: null,
            body: jsonBody({ error: "Missing payload" }),
          },
          paths,
        ),
      );
    });

    it("rejects an unsigned request identically", async () => {
      const snapshots = await snapshotEachPath(
        paths,
        slackIngressRequest({
          routes: slackInteractiveRoutes,
          body,
          contentType: FORM_CONTENT_TYPE,
          signed: false,
        }),
      );

      expect(snapshots).toStrictEqual(
        repeated(
          {
            status: 401,
            location: null,
            body: jsonBody({ error: "Missing Slack signature headers" }),
          },
          paths,
        ),
      );
    });
  });
});
