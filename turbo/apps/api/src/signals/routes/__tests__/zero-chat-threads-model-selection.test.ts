import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { chatThreadModelSelectionContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../../services/zero-model-selection.service";
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

describe("POST /api/zero/chat-threads/:id/model-selection", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
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
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    const response = await accept(
      client.update({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
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
      store.set(
        seedZeroChatThread$,
        { userId: `user_${randomUUID().slice(0, 8)}` },
        context.signal,
      ),
    );
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    const response = await accept(
      client.update({
        params: { id: otherFixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
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

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, otherFixture.threadId));
    expect(row?.selectedModel).toBeNull();
  });

  it("updates the thread selected model on success", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    await accept(
      client.update({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [204],
    );

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        modelProviderId: chatThreads.modelProviderId,
        selectedModel: chatThreads.selectedModel,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));

    expect(row).toMatchObject({
      modelProviderId: null,
      selectedModel: "claude-sonnet-4-6",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("clears the thread model selection when modelSelection is null", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const writeDb = store.set(writeDb$);
    await writeDb
      .update(chatThreads)
      .set({ selectedModel: "claude-sonnet-4-6" })
      .where(eq(chatThreads.id, fixture.threadId));

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    await accept(
      client.update({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { modelSelection: null },
      }),
      [204],
    );

    const [row] = await writeDb
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    expect(row?.selectedModel).toBeNull();
  });

  it("returns 400 for an invalid model-first selection", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadModelSelectionContract);

    const response = await accept(
      client.update({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
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
