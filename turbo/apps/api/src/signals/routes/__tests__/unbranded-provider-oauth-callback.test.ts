import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import type { RouteEntry } from "../../route-entry";
import { feishuOauthRoutes } from "../feishu-oauth";
import { slackOauthRoutes } from "../slack-oauth";
import { teamsOauthRoutes } from "../teams-oauth";

const context = testContext();

interface ProviderCallback {
  readonly provider: string;
  readonly suffix: string;
  readonly routes: readonly RouteEntry[];
  /**
   * Error the branded callback already returns for a callback carrying no
   * `code`. Feishu rejects the absent state first, Slack and Teams the code.
   */
  readonly missingCodeError: string;
}

const PROVIDER_CALLBACKS: readonly ProviderCallback[] = [
  {
    provider: "Slack",
    suffix: "/slack/oauth/callback",
    routes: slackOauthRoutes,
    missingCodeError: "Missing authorization code",
  },
  {
    provider: "Microsoft Teams",
    suffix: "/teams/oauth/callback",
    routes: teamsOauthRoutes,
    missingCodeError: "Missing authorization code",
  },
  {
    provider: "Feishu",
    suffix: "/feishu/oauth/callback",
    routes: feishuOauthRoutes,
    missingCodeError: "Invalid or expired connect state",
  },
];

function namespacedPaths(suffix: string): readonly string[] {
  return [`/api/zero${suffix}`, `/api/okou${suffix}`, `/api${suffix}`];
}

async function callbackResponse(
  target: ProviderCallback,
  path: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: target.routes,
  });
  const response = await app.request(`http://api.test${path}`);
  return { status: response.status, body: await response.json() };
}

describe("unbranded provider OAuth callbacks", () => {
  beforeEach(() => {
    mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
    mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "test-microsoft-client-id");
    mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "test-microsoft-client-secret");
  });

  for (const target of PROVIDER_CALLBACKS) {
    it(`answers a ${target.provider} callback without a code identically on every namespace`, async () => {
      for (const path of namespacedPaths(target.suffix)) {
        const response = await callbackResponse(target, path);

        expect(response.status).toBe(400);
        expect(response.body).toStrictEqual({
          error: target.missingCodeError,
        });
      }
    });
  }
});
