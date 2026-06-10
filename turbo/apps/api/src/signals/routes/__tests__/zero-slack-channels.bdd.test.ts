import { randomUUID } from "node:crypto";

import { zeroSlackChannelsContract } from "@vm0/api-contracts/contracts/zero-slack-channels";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import {
  deleteSlackInstallation$,
  seedSlackInstallation$,
  type SlackInstallationFixture,
} from "./helpers/zero-slack-channels";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-slack-channels.test.ts`.
// The 6 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// boundary chain (401 unauth → 401 no-org → 404 no
// installation), (2) 200 success chain (member-only filter +
// alphabetical sort + pagination across 2 pages), (3) 200
// empty chain (no channels with bot membership).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const SLACK_LIST_URL = "https://slack.com/api/conversations.list";

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroSlackChannelsContract);
}

const track = createFixtureTracker<SlackInstallationFixture>((fixture) => {
  return store.set(deleteSlackInstallation$, fixture, context.signal);
});

describe("BDD GET /api/zero/slack/channels — auth boundary", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 404 no installation", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(c.list({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: an authenticated session with no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(c.list({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: an authenticated session with an org but no
    // Slack installation.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 404.
    const noInstallation = await accept(
      c.list({ headers: authHeaders() }),
      [404],
    );
    expect(noInstallation.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this org",
        code: "NOT_FOUND",
      },
    });
  });
});

describe("BDD GET /api/zero/slack/channels — 200 success chain", () => {
  it("gwt-wt-wt: 200 member-only filter + alphabetical sort → 200 pagination across 2 pages", async () => {
    // Given: a Slack installation + a stubbed Slack API
    // returning 4 channels (3 member, 1 not-joined) on a
    // single page.
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

    // When + Then: 200 with the 3 member channels sorted
    // alphabetically (alpha, general, random).
    const response = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual({
      channels: [
        { id: "C004", name: "alpha" },
        { id: "C001", name: "general" },
        { id: "C002", name: "random" },
      ],
    });

    // Given: a fresh installation + a paginated Slack API
    // that returns 1 channel + a cursor on page 1, then
    // 1 channel + an empty cursor on page 2.
    const fixture2 = await track(
      store.set(seedSlackInstallation$, {}, context.signal),
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture2.orgId);
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

    // When + Then: 200 with channels from both pages.
    const paginated = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(paginated.body).toStrictEqual({
      channels: [
        { id: "C001", name: "page-one" },
        { id: "C002", name: "page-two" },
      ],
    });
    expect(callCount).toBe(2);
  });
});

describe("BDD GET /api/zero/slack/channels — 200 empty", () => {
  it("gwt-wt-wt: 200 empty array when no channels have bot membership", async () => {
    // Given: a Slack installation + a stubbed Slack API
    // returning only non-member channels.
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

    // When + Then: 200 with an empty list.
    const empty = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(empty.body).toStrictEqual({ channels: [] });
  });
});
