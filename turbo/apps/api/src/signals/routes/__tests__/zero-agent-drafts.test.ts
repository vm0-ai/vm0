import { randomUUID } from "node:crypto";

import { zeroAgentDraftContract } from "@vm0/api-contracts/contracts/zero-agents";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function draftsClient() {
  return setupApp({ context })(zeroAgentDraftContract);
}

describe("GET/PATCH /api/zero/agents/:id/draft", () => {
  it("returns an empty draft when none is saved", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      draftsClient().get({
        params: { id: fixture.composeId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      draftContent: null,
      draftAttachments: null,
    });
  });

  it("stores and clears the current user's agent draft", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const attachment = {
      id: randomUUID(),
      url: "https://cdn.example.com/draft-file.txt",
      filename: "draft-file.txt",
      contentType: "text/plain",
      size: 123,
    };

    await accept(
      draftsClient().patch({
        params: { id: fixture.composeId },
        headers: authHeaders(),
        body: {
          draftContent: "draft text",
          draftAttachments: [attachment],
        },
      }),
      [204],
    );

    const saved = await accept(
      draftsClient().get({
        params: { id: fixture.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(saved.body).toStrictEqual({
      draftContent: "draft text",
      draftAttachments: [attachment],
    });

    await accept(
      draftsClient().patch({
        params: { id: fixture.composeId },
        headers: authHeaders(),
        body: {
          draftContent: null,
          draftAttachments: null,
        },
      }),
      [204],
    );

    const cleared = await accept(
      draftsClient().get({
        params: { id: fixture.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(cleared.body).toStrictEqual({
      draftContent: null,
      draftAttachments: null,
    });
  });

  it("does not expose another user's draft on the same public agent", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      draftsClient().patch({
        params: { id: fixture.composeId },
        headers: authHeaders(),
        body: {
          draftContent: "owner draft",
          draftAttachments: null,
        },
      }),
      [204],
    );

    const peerUserId = `user_${randomUUID()}`;
    mocks.clerk.session(peerUserId, fixture.orgId, "org:member");

    const peerDraft = await accept(
      draftsClient().get({
        params: { id: fixture.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(peerDraft.body).toStrictEqual({
      draftContent: null,
      draftAttachments: null,
    });
  });
});
