import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the chat-message keyword search auth, capability
// and empty-result cases. Matching results (peer/cross-org isolation, null
// content, since/agent filters, context windows, hasMore, LIKE escaping) need
// seeded chat messages from a funded run (GAP-CHAT-MESSAGE-SEED) and stay in the
// kept legacy. See `api.bdd.md` (CHAIN-CHAT-SEARCH-REJECTIONS).
const context = testContext();

describe("chat message search rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less / capability-less callers and empties a fresh org", async () => {
    const api = createBddApi(context);
    const query = { keyword: "hello" };

    // Unauthenticated.
    await accept(api.chatSearch.search({ query, headers: {} }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.chatSearch.search({ query, headers: SESSION_AUTH }),
      [401],
    );

    // A sandbox token without chat-message:read is forbidden.
    const forbidden = await accept(
      api.chatSearch.search({
        query,
        headers: api.sandboxAuth("user_chat_search"),
      }),
      [403],
    );
    expect(forbidden.body.error.message).toContain("chat-message:read");

    // A fresh org has no messages, so the search is empty.
    api.actAsAdmin();
    const empty = await accept(
      api.chatSearch.search({
        query: { keyword: "nonexistent" },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(empty.body.results).toStrictEqual([]);
    expect(empty.body.hasMore).toBeFalsy();
  });
});
