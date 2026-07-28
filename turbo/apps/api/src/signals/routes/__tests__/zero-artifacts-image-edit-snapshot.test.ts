import { describe, expect, it } from "vitest";

import { artifactsContract } from "@vm0/api-contracts/contracts/chat-threads";

import { buildFileUrl } from "../../../lib/file-url";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

const IMAGE_FILE_ID = "image-edit-source";
const IMAGE_FILENAME = "source.png";
const EDITED_IMAGE_URL = "https://cdn.vm7.io/artifacts/test/image-edit.png";

function client() {
  return setupApp({ context })(artifactsContract);
}

async function seedVisibleImage(): Promise<{
  readonly artifactUrl: string;
  readonly orgId: string;
  readonly userId: string;
}> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Image artifact snapshot agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Image editing",
  });
  await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      attachFiles: [
        {
          contentType: "image/png",
          filename: IMAGE_FILENAME,
          id: IMAGE_FILE_ID,
          size: 128,
        },
      ],
      prompt: "edit this image",
      threadId: thread.id,
    },
    [201],
  );
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }

  return {
    artifactUrl: buildFileUrl(actor.userId, IMAGE_FILE_ID, IMAGE_FILENAME),
    orgId: actor.orgId,
    userId: actor.userId,
  };
}

describe("image artifact edit snapshots", () => {
  it("saves, reads, and overwrites a snapshot for a visible image artifact", async () => {
    const fixture = await seedVisibleImage();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const firstSnapshot = {
      version: 1 as const,
      items: [
        {
          url: fixture.artifactUrl,
          x: 120,
          y: 140,
          zIndex: 1,
        },
        {
          url: EDITED_IMAGE_URL,
          x: 860,
          y: 160,
          zIndex: 2,
        },
      ],
    };
    const first = await accept(
      client().upsertImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          snapshot: firstSnapshot,
          url: fixture.artifactUrl,
        },
      }),
      [200],
    );

    expect(first.body).toMatchObject({
      artifactUrl: fixture.artifactUrl,
      snapshot: firstSnapshot,
    });

    const loaded = await accept(
      client().getImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        query: { url: fixture.artifactUrl },
      }),
      [200],
    );
    expect(loaded.body.snapshot).toMatchObject({
      artifactUrl: fixture.artifactUrl,
      snapshot: firstSnapshot,
    });

    const emptySnapshot = { version: 1 as const, items: [] };
    const second = await accept(
      client().upsertImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          snapshot: emptySnapshot,
          url: fixture.artifactUrl,
        },
      }),
      [200],
    );

    expect(second.body.snapshot).toStrictEqual(emptySnapshot);
  });

  it("clears a saved snapshot", async () => {
    const fixture = await seedVisibleImage();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      client().upsertImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          snapshot: {
            version: 1,
            items: [
              { url: fixture.artifactUrl, x: 0, y: 0, zIndex: 1 },
              { url: EDITED_IMAGE_URL, x: 40, y: 60, zIndex: 2 },
            ],
          },
          url: fixture.artifactUrl,
        },
      }),
      [200],
    );

    await accept(
      client().deleteImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        query: { url: fixture.artifactUrl },
      }),
      [204],
    );

    const loaded = await accept(
      client().getImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        query: { url: fixture.artifactUrl },
      }),
      [200],
    );
    expect(loaded.body.snapshot).toBeNull();
  });

  it("persists a moved single-source snapshot", async () => {
    const fixture = await seedVisibleImage();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const snapshot = {
      version: 1 as const,
      items: [{ url: fixture.artifactUrl, x: 48, y: 64, zIndex: 1 }],
    };
    const saved = await accept(
      client().upsertImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          snapshot,
          url: fixture.artifactUrl,
        },
      }),
      [200],
    );
    expect(saved.body.snapshot).toStrictEqual(snapshot);

    const loaded = await accept(
      client().getImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        query: { url: fixture.artifactUrl },
      }),
      [200],
    );
    expect(loaded.body.snapshot?.snapshot).toStrictEqual(snapshot);
  });

  it("returns null for a visible image without a saved snapshot", async () => {
    const fixture = await seedVisibleImage();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().getImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        query: { url: fixture.artifactUrl },
      }),
      [200],
    );

    expect(response.body.snapshot).toBeNull();
  });

  it("does not expose snapshots across users", async () => {
    const fixture = await seedVisibleImage();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      client().upsertImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          snapshot: {
            version: 1,
            items: [
              { url: fixture.artifactUrl, x: 0, y: 0, zIndex: 1 },
              { url: EDITED_IMAGE_URL, x: 40, y: 60, zIndex: 2 },
            ],
          },
          url: fixture.artifactUrl,
        },
      }),
      [200],
    );

    mocks.clerk.session("user_other", fixture.orgId);
    const response = await accept(
      client().getImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        query: { url: fixture.artifactUrl },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message: "Artifact not found",
      },
    });
  });

  it("requires an organization context", async () => {
    const fixture = await seedVisibleImage();
    mocks.clerk.session(fixture.userId, null);

    const response = await accept(
      client().upsertImageEditSnapshot({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          snapshot: { version: 1, items: [] },
          url: fixture.artifactUrl,
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
