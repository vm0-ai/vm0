import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../realtime";

const context = testContext();

describe("chat database realtime publications", () => {
  it("dual-publishes legacy and user-org invalidations during migration", async () => {
    const userId = "user-123";
    const orgId = "org-456";
    const threadId = "thread-789";

    await publishThreadListChangedSafely({ userId, orgId });
    await publishChatThreadMessageCreatedSafely({
      userId,
      orgId,
      threadId,
      syncThroughSeqId: 42,
    });
    await flushWaitUntilForTest();

    const publications = context.mocks.ably.publish.mock.calls.map(
      ([topic, payload], index) => {
        return {
          channel: context.mocks.ably.channelGet.mock.calls[index]?.[0],
          payload,
          topic,
        };
      },
    );
    expect(publications).toStrictEqual([
      {
        channel: `user:${userId}`,
        payload: null,
        topic: "threadListChanged",
      },
      {
        channel: `user-org:${userId}:${orgId}`,
        payload: null,
        topic: "threadListChanged",
      },
      {
        channel: `user:${userId}`,
        payload: { syncThroughSeqId: 42 },
        topic: `chatThreadMessageCreated:${threadId}`,
      },
      {
        channel: `user-org:${userId}:${orgId}`,
        payload: { syncThroughSeqId: 42 },
        topic: `chatThreadMessageCreated:${threadId}`,
      },
    ]);
  });
});
