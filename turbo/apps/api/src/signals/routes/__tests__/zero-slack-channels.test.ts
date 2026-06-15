import { randomUUID } from "node:crypto";

import { zeroSlackChannelsContract } from "@vm0/api-contracts/contracts/zero-slack-channels";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import {
  type SlackInstallationFixture,
  deleteSlackInstallation$,
  seedSlackInstallation$,
} from "./helpers/zero-slack-channels";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const SLACK_LIST_URL = "https://slack.com/api/conversations.list";

describe("GET /api/zero/slack/channels", () => {
  const track = createFixtureTracker<SlackInstallationFixture>((fixture) => {
    return store.set(deleteSlackInstallation$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSlackChannelsContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroSlackChannelsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when no Slack installation exists for the org", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroSlackChannelsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this org",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns channels where the bot is a member", async () => {
    const fixture = await track(
      store.set(seedSlackInstallation$, {}, context.signal),
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    server.use(
      http.get(SLACK_LIST_URL, () => {
        return HttpResponse.json({
          ok: true,
          channels: [
            { id: "C001", name: "general", is_member: true },
            { id: "C002", name: "random", is_member: true },
            { id: "C003", name: "not-joined", is_member: false },
            { id: "C004", name: "alpha", is_member: true },
          ],
          response_metadata: { next_cursor: "" },
        });
      }),
    );

    const client = setupApp({ context })(zeroSlackChannelsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
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

  it("handles pagination across multiple pages", async () => {
    const fixture = await track(
      store.set(seedSlackInstallation$, {}, context.signal),
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

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
          channels: [{ id: "C002", name: "page-two", is_member: true }],
          response_metadata: { next_cursor: "" },
        });
      }),
    );

    const client = setupApp({ context })(zeroSlackChannelsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      channels: [
        { id: "C001", name: "page-one" },
        { id: "C002", name: "page-two" },
      ],
    });
    expect(callCount).toBe(2);
  });

  it("returns an empty array when no channels have bot membership", async () => {
    const fixture = await track(
      store.set(seedSlackInstallation$, {}, context.signal),
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    server.use(
      http.get(SLACK_LIST_URL, () => {
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C001", name: "no-bot", is_member: false }],
          response_metadata: { next_cursor: "" },
        });
      }),
    );

    const client = setupApp({ context })(zeroSlackChannelsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ channels: [] });
  });
});
