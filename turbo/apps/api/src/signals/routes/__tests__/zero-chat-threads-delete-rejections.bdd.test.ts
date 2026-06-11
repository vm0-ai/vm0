import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for chat-thread delete auth, not-found and
// malformed-id rejections, plus a full create-then-delete lifecycle. Deleting a
// thread that has linked schedules / messages / artifacts (the cascade variants)
// needs that seeded state and stays in the kept legacy. See `api.bdd.md`
// (CHAIN-CHAT-THREAD-DELETE-REJECTIONS).
const context = testContext();

const UNKNOWN_THREAD = "00000000-0000-4000-8000-000000000006";

describe("chat-thread delete rejections (API-first BDD)", () => {
  it("rejects unauthenticated callers, malformed ids and unknown threads", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.chatThreadById.delete({
        params: { id: UNKNOWN_THREAD },
        headers: {},
      }),
      [401],
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Malformed id is rejected before any DB lookup.
    api.actAsAdmin();
    const badId = await accept(
      api.chatThreadById.delete({
        params: { id: "not-a-uuid" },
        headers: SESSION_AUTH,
      }),
      [400],
    );
    expect(badId.body.error.code).toBe("BAD_REQUEST");

    // A valid session deleting a thread that does not exist.
    const notFound = await accept(
      api.chatThreadById.delete({
        params: { id: UNKNOWN_THREAD },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("creates a thread, deletes it, and the thread is then gone", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Given an onboarded default agent and a chat thread on it.
    const setup = await accept(
      api.onboardingSetup.setup({
        headers: SESSION_AUTH,
        body: { displayName: "Zero" },
      }),
      [200],
    );
    const thread = await accept(
      api.chatThreads.create({
        headers: SESSION_AUTH,
        body: { agentId: setup.body.agentId },
      }),
      [201],
    );

    // When the caller deletes the thread.
    await accept(
      api.chatThreadById.delete({
        params: { id: thread.body.id },
        headers: SESSION_AUTH,
      }),
      [204],
    );

    // Then the thread can no longer be fetched.
    await accept(
      api.chatThreadById.get({
        params: { id: thread.body.id },
        headers: SESSION_AUTH,
      }),
      [404],
    );
  });
});
