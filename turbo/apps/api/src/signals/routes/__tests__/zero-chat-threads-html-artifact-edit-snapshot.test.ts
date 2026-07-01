import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const trackThread = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function client() {
  return setupApp({ context })(chatThreadArtifactsContract);
}

describe("HTML artifact edit snapshots", () => {
  it("saves, reads, overwrites, and deletes a stable snapshot for a thread artifact", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, { title: "Launch" }, context.signal),
    );
    const artifactUrl = "https://launch.sites.vm7.io";
    const firstHtml = "<!doctype html><html><body>first</body></html>";
    const secondHtml = "<!doctype html><html><body>second</body></html>";
    context.mocks.s3.send.mockResolvedValue({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const first = await accept(
      client().upsertHtmlEditSnapshot({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          html: firstHtml,
          url: artifactUrl,
        },
      }),
      [200],
    );

    expect(first.body).toMatchObject({
      artifactUrl,
    });
    expect(first.body.snapshotUrl).toMatch(
      new RegExp(
        String.raw`^https://cdn\.vm7\.io/artifacts/html-edit-drafts/[0-9a-f-]{36}\.html\?v=`,
      ),
    );

    const firstPut = commandInput(context.mocks.s3.send.mock.calls[0]?.[0]);
    expect(firstPut).toMatchObject({
      Body: firstHtml,
      Bucket: "test-user-artifacts",
      ContentType: "text/html",
    });
    expect(firstPut.Key).toMatch(
      /^artifacts\/html-edit-drafts\/[0-9a-f-]{36}\.html$/,
    );

    const loaded = await accept(
      client().getHtmlEditSnapshot({
        params: { threadId: fixture.threadId },
        query: { url: artifactUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(loaded.body.snapshot).toMatchObject({
      artifactUrl,
      snapshotUrl: first.body.snapshotUrl,
    });

    await accept(
      client().upsertHtmlEditSnapshot({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          html: secondHtml,
          url: artifactUrl,
        },
      }),
      [200],
    );
    const secondPut = commandInput(context.mocks.s3.send.mock.calls[1]?.[0]);
    expect(secondPut).toMatchObject({
      Body: secondHtml,
      Bucket: "test-user-artifacts",
      ContentType: "text/html",
      Key: firstPut.Key,
    });

    await accept(
      client().deleteHtmlEditSnapshot({
        params: { threadId: fixture.threadId },
        query: { url: artifactUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    const deleteCall = context.mocks.s3.send.mock.calls.find(([command]) => {
      return "Delete" in commandInput(command);
    });
    expect(commandInput(deleteCall?.[0])).toMatchObject({
      Bucket: "test-user-artifacts",
      Delete: {
        Objects: [{ Key: firstPut.Key }],
      },
    });

    const afterDelete = await accept(
      client().getHtmlEditSnapshot({
        params: { threadId: fixture.threadId },
        query: { url: artifactUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(afterDelete.body.snapshot).toBeNull();
  });

  it("does not expose snapshots across users", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, { title: "Launch" }, context.signal),
    );
    context.mocks.s3.send.mockResolvedValue({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      client().upsertHtmlEditSnapshot({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          html: "<!doctype html><html><body>deck</body></html>",
          url: "https://deck.sites.vm7.io",
        },
      }),
      [200],
    );

    mocks.clerk.session("user_other", fixture.orgId);
    const response = await accept(
      client().getHtmlEditSnapshot({
        params: { threadId: fixture.threadId },
        query: { url: "https://deck.sites.vm7.io" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  });

  it("requires an organization context", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, { title: "Launch" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const response = await accept(
      client().upsertHtmlEditSnapshot({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          html: "<!doctype html><html><body>draft</body></html>",
          url: "https://draft.sites.vm7.io",
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      },
    });
  });
});
