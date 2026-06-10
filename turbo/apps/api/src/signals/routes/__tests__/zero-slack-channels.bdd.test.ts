import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  testSlackStateContract,
  type TestSlackStatePostResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";
import { zeroSlackChannelsContract } from "@vm0/api-contracts/contracts/zero-slack-channels";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const SLACK_LIST_URL = "https://slack.com/api/conversations.list";

interface SeededSlackInstallation {
  readonly teamId: string;
  readonly response: TestSlackStatePostResponse;
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function channelsClient() {
  return setupApp({ context })(zeroSlackChannelsContract);
}

function stateClient() {
  return setupApp({ context })(testSlackStateContract);
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function mockTestUserMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      { createdAt: 20, organization: { id: `org_later_${suffix()}` } },
      { createdAt: 10, organization: { id: orgId } },
    ],
  });
}

async function cleanupSeededSlackState(
  seeded: SeededSlackInstallation,
): Promise<void> {
  mockEnv("ENV", "development");
  await accept(
    stateClient().delete({ query: { team_id: seeded.teamId } }),
    [200],
  );
}

const trackSeededState = createFixtureTracker<SeededSlackInstallation>(
  cleanupSeededSlackState,
);

async function seedSlackInstallation(): Promise<TestSlackStatePostResponse> {
  mockEnv("ENV", "development");
  const userId = `user_slack_channels_${suffix()}`;
  const orgId = `org_slack_channels_${suffix()}`;
  const teamId = `T_CHANNELS_${suffix().toUpperCase()}`;
  mockTestUserMembership(userId, orgId);

  const response = await accept(
    stateClient().post({
      body: {
        team_id: teamId,
        slack_user_id: `U_CHANNELS_${suffix().toUpperCase()}`,
        workspace_name: "Channels Workspace",
        bot_user_id: "U_CHANNELS_BOT",
      },
    }),
    [200],
  );

  await trackSeededState(Promise.resolve({ teamId, response: response.body }));
  return response.body;
}

function mockSlackChannels(response: {
  readonly channels: readonly {
    readonly id: string;
    readonly name: string;
    readonly is_member: boolean;
  }[];
  readonly nextCursor?: string;
}): void {
  server.use(
    http.get(SLACK_LIST_URL, () => {
      return HttpResponse.json({
        ok: true,
        channels: response.channels,
        response_metadata: { next_cursor: response.nextCursor ?? "" },
      });
    }),
  );
}

describe("GET /api/zero/slack/channels BDD", () => {
  it("requires authentication, an active organization, and Slack installation state", async () => {
    const unauthenticated = await accept(
      channelsClient().list({ headers: {} }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    mocks.clerk.session(`user_${suffix()}`, null);
    const missingOrg = await accept(
      channelsClient().list({ headers: authHeaders() }),
      [401],
    );

    expect(missingOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    mocks.clerk.session(`user_${suffix()}`, `org_${suffix()}`);
    const missingInstallation = await accept(
      channelsClient().list({ headers: authHeaders() }),
      [404],
    );

    expect(missingInstallation.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this org",
        code: "NOT_FOUND",
      },
    });
  });

  it("lists Slack channels where the bot is a member in name order", async () => {
    const installation = await seedSlackInstallation();
    mocks.clerk.session(
      installation.vm0_user_id,
      installation.org_id,
      "org:member",
    );
    mockSlackChannels({
      channels: [
        { id: "C001", name: "general", is_member: true },
        { id: "C002", name: "random", is_member: true },
        { id: "C003", name: "not-joined", is_member: false },
        { id: "C004", name: "alpha", is_member: true },
      ],
    });

    const response = await accept(
      channelsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      channels: [
        { id: "C004", name: "alpha" },
        { id: "C001", name: "general" },
        { id: "C002", name: "random" },
      ],
    });
  });

  it("follows Slack pagination and returns an empty list when the bot has no channel memberships", async () => {
    const installation = await seedSlackInstallation();
    mocks.clerk.session(
      installation.vm0_user_id,
      installation.org_id,
      "org:member",
    );

    let callCount = 0;
    server.use(
      http.get(SLACK_LIST_URL, ({ request }) => {
        callCount++;
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (!cursor) {
          return HttpResponse.json({
            ok: true,
            channels: [{ id: "C001", name: "page-one", is_member: true }],
            response_metadata: { next_cursor: "cursor_page2" },
          });
        }
        return HttpResponse.json({
          ok: true,
          channels: [
            { id: "C002", name: "page-two", is_member: true },
            { id: "C003", name: "not-joined", is_member: false },
          ],
          response_metadata: { next_cursor: "" },
        });
      }),
    );

    const paginated = await accept(
      channelsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(paginated.body).toStrictEqual({
      channels: [
        { id: "C001", name: "page-one" },
        { id: "C002", name: "page-two" },
      ],
    });
    expect(callCount).toBe(2);

    mockSlackChannels({
      channels: [{ id: "C004", name: "no-bot", is_member: false }],
    });
    const empty = await accept(
      channelsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(empty.body).toStrictEqual({ channels: [] });
  });
});
