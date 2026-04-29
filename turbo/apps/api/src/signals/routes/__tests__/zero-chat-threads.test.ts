import { createStore } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { zeroChatThreadRoutes } from "../zero-chat-threads";
import {
  deleteZeroChatThread,
  seedZeroChatMessage,
  seedZeroChatThread,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/chat-threads/:id", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return deleteZeroChatThread(store, fixture);
  });

  it("returns thread detail with S3-backed attachment metadata", async () => {
    const fixture = await track(
      seedZeroChatThread(store, { title: "Uploads" }),
    );
    await seedZeroChatMessage(store, fixture, {
      role: "user",
      content: "see attached file",
      attachFiles: ["file_123"],
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mocks.s3.listObjects([
      {
        bucket: "test-user-storages",
        key: `uploads/${fixture.userId}/file_123/report.pdf`,
        size: 42,
      },
    ]);

    const client = setupApp({
      context,
      routes: zeroChatThreadRoutes("api"),
    })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: fixture.threadId,
      title: "Uploads",
      agentId: fixture.composeId,
      latestSessionId: null,
      activeRunIds: [],
      activeRuns: [],
      draftContent: null,
      draftAttachments: null,
      modelProviderId: null,
      selectedModel: null,
      chatMessages: [
        {
          role: "user",
          content: "see attached file",
          attachFiles: [
            {
              id: "file_123",
              filename: "report.pdf",
              contentType: "application/pdf",
              size: 42,
              url: `http://localhost:3000/f/${encodeURIComponent(
                fixture.userId,
              )}/file_123/report.pdf`,
            },
          ],
        },
      ],
    });
  });
});

describe("GET /api/zero/chat-threads/:threadId/messages", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return deleteZeroChatThread(store, fixture);
  });

  it("returns paged messages with S3-backed attachment metadata", async () => {
    const fixture = await track(seedZeroChatThread(store));
    await seedZeroChatMessage(store, fixture, {
      role: "assistant",
      content: "uploaded",
      attachFiles: ["image_file"],
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mocks.s3.listObjects([
      {
        bucket: "test-user-storages",
        key: `uploads/${fixture.userId}/image_file/screenshot.png`,
        size: 128,
      },
    ]);

    const client = setupApp({
      context,
      routes: zeroChatThreadRoutes("api"),
    })(chatThreadMessagesContract);

    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: { limit: 50 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      messages: [
        {
          id: expect.any(String),
          role: "assistant",
          content: "uploaded",
          attachFiles: [
            {
              id: "image_file",
              filename: "screenshot.png",
              contentType: "image/png",
              size: 128,
              url: `http://localhost:3000/f/${encodeURIComponent(
                fixture.userId,
              )}/image_file/screenshot.png`,
            },
          ],
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      hasHistoryBefore: false,
    });
  });
});
