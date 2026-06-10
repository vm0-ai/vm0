import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the chat-thread message list auth, not-found and
// empty-thread cases. A freshly created thread (created off a freshly onboarded
// default agent) has no messages, so the empty case is reachable end-to-end via
// the API. Populated message lists — ascending order, pagination cursors,
// generation templates, attachment CDN resolution — need a funded run that emits
// messages (GAP-CHAT-MESSAGE-SEED), and the other-user 404 needs a seeded
// foreign thread; those stay in the kept legacy. See `api.bdd.md`
// (CHAIN-CHAT-MESSAGES-REJECTIONS).
const context = testContext();

describe("chat-thread message list rejections (API-first BDD)", () => {
  it("rejects unauthenticated callers and 404s an unknown thread", async () => {
    const api = createBddApi(context);
    const threadId = "00000000-0000-4000-8000-000000000003";

    // Unauthenticated.
    await accept(
      api.chatThreadMessages.list({
        params: { threadId },
        query: {},
        headers: {},
      }),
      [401],
    );

    // A valid session with no such thread gets a 404.
    api.actAsAdmin();
    const notFound = await accept(
      api.chatThreadMessages.list({
        params: { threadId },
        query: {},
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");
  });

  it("returns an empty message list for a freshly created thread", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Given an onboarded default agent.
    const setup = await accept(
      api.onboardingSetup.setup({
        headers: SESSION_AUTH,
        body: { displayName: "Zero" },
      }),
      [200],
    );

    // When the caller opens a new chat thread on that agent.
    const thread = await accept(
      api.chatThreads.create({
        headers: SESSION_AUTH,
        body: { agentId: setup.body.agentId },
      }),
      [201],
    );

    // Then the thread starts with no messages.
    const messages = await accept(
      api.chatThreadMessages.list({
        params: { threadId: thread.body.id },
        query: {},
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(messages.body.messages).toStrictEqual([]);
  });
});
