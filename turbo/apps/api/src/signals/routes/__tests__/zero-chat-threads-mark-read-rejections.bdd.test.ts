import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the chat-thread mark-read auth, not-found and
// no-messages cases. Advancing the read position past real messages (and the
// changed:true publish + idempotency variants) needs seeded chat messages
// (GAP-CHAT-MESSAGE-SEED), and the other-user 404 needs a seeded foreign thread;
// those stay in the kept legacy. See `api.bdd.md`
// (CHAIN-CHAT-MARK-READ-REJECTIONS).
const context = testContext();

const UNKNOWN_THREAD = "00000000-0000-4000-8000-000000000009";

describe("chat-thread mark-read rejections (API-first BDD)", () => {
  it("rejects unauthenticated callers and 404s an unknown thread", async () => {
    const api = createBddApi(context);

    const unauth = await accept(
      api.chatThreadMarkRead.markRead({
        params: { id: UNKNOWN_THREAD },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    api.actAsAdmin();
    const notFound = await accept(
      api.chatThreadMarkRead.markRead({
        params: { id: UNKNOWN_THREAD },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");
  });

  it("marking a freshly created thread with no messages is a no-op", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Given an onboarded agent and a brand-new chat thread on it.
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

    // When the caller marks the empty thread as read, nothing changes (ignore
    // the threadListChanged publish from thread creation above).
    context.mocks.ably.publish.mockClear();
    const marked = await accept(
      api.chatThreadMarkRead.markRead({
        params: { id: thread.body.id },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(marked.body).toStrictEqual({
      lastReadMessageId: null,
      changed: false,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
