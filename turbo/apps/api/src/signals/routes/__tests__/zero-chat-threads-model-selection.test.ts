import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatThreadModelSelectionContract } from "@vm0/api-contracts/contracts/chat-threads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../../services/zero-model-selection.service";
import {
  authHeaders,
  createZeroChatThreadThroughApi,
  deleteZeroChatThreadThroughApi,
  getZeroChatThreadThroughApi,
  type ZeroChatThreadRouteFixture,
} from "./helpers/zero-chat-thread-routes";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

describe("POST /api/zero/chat-threads/:id/model-selection", () => {
  const track = createFixtureTracker<ZeroChatThreadRouteFixture>((fixture) => {
    return deleteZeroChatThreadThroughApi(
      context,
      mocks.clerk.session,
      fixture,
    );
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadModelSelectionContract);

    const response = await accept(
      client.update({
        params: { id: randomUUID() },
        headers: {},
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown thread id", async () => {
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    const response = await accept(
      client.update({
        params: { id: randomUUID() },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for a thread owned by another user", async () => {
    const otherFixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session, {
        userId: `user_${randomUUID().slice(0, 8)}`,
      }),
    );
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    const response = await accept(
      client.update({
        params: { id: otherFixture.threadId },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    const ownerThread = await getZeroChatThreadThroughApi(
      context,
      otherFixture.threadId,
    );
    expect(ownerThread.modelProviderId).toBeNull();
    expect(ownerThread.selectedModel).toBeNull();
  });

  it("updates the thread selected model on success", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    await accept(
      client.update({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [204],
    );

    const thread = await getZeroChatThreadThroughApi(context, fixture.threadId);
    expect(thread.modelProviderId).toBeNull();
    expect(thread.selectedModel).toBe("claude-sonnet-4-6");
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("clears the thread model selection when modelSelection is null", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    await accept(
      client.update({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [204],
    );
    context.mocks.ably.publish.mockClear();

    await accept(
      client.update({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: { modelSelection: null },
      }),
      [204],
    );

    const thread = await getZeroChatThreadThroughApi(context, fixture.threadId);
    expect(thread.modelProviderId).toBeNull();
    expect(thread.selectedModel).toBeNull();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("returns 400 for an invalid model-first selection", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    const response = await accept(
      client.update({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "not-a-supported-model",
          },
        },
      }),
      [400],
    );

    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});
