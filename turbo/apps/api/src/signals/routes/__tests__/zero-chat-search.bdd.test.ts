import { randomUUID } from "node:crypto";

import { chatSearchContract } from "@vm0/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../external/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteZeroChatThread$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";

// BDD migration of the legacy `zero-chat-search.test.ts`. The
// 12 legacy `it()`s collapse into 7 BDD `it()`s: (1) auth
// boundary chain (401 unauth → 401 no-org → 403 missing
// capability), (2) isolation chain (peer-user → cross-org),
// (3) empty + null content chain, (4) since + agentId filter
// chain, (5) context before/after, (6) hasMore, (7) LIKE
// wildcard escape. Direct-DB `signSandboxJwtForTests` token
// is the only precondition not reachable from any public API
// (Open Helper Gap).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function searchClient() {
  return setupApp({ context })(chatSearchContract);
}

const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

describe("BDD GET /api/zero/chat/search — auth boundary", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 no-org → 403 token lacks chat-message:read capability", async () => {
    // When + Then: 401.
    const unauth = await accept(
      searchClient().search({ query: { keyword: "hello" }, headers: {} }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a session with no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: 401.
    const noOrg = await accept(
      searchClient().search({
        query: { keyword: "hello" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");

    // Given: a sandbox JWT that lacks the chat-message:read
    // capability.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId,
      orgId,
      runId,
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: 403.
    const forbidden = await accept(
      searchClient().search({
        query: { keyword: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    expect(forbidden.body.error.message).toContain("chat-message:read");
  });
});

describe("BDD GET /api/zero/chat/search — isolation chain", () => {
  it("gwt-wt-wt: 200 peer-user isolation → 200 cross-org isolation", async () => {
    // Given: caller and peer both in the same org.
    const orgId = `org_${randomUUID()}`;
    const callerUserId = `user_caller_${randomUUID()}`;
    const peerUserId = `user_peer_${randomUUID()}`;

    const callerFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: callerUserId, orgId, title: "caller thread" },
        context.signal,
      ),
    );
    const peerFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: peerUserId, orgId, title: "peer thread" },
        context.signal,
      ),
    );

    await store.set(
      seedZeroChatMessage$,
      callerFixture,
      { role: "user", content: "caller says supercalifragilistic" },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      peerFixture,
      { role: "user", content: "peer says supercalifragilistic" },
      context.signal,
    );
    mocks.clerk.session(callerUserId, orgId);

    // When + Then: only the caller's message matches.
    const peerResponse = await accept(
      searchClient().search({
        query: { keyword: "supercalifragilistic" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(peerResponse.body.results).toHaveLength(1);
    expect(peerResponse.body.results[0]?.chatThreadId).toBe(
      callerFixture.threadId,
    );
    expect(peerResponse.body.results[0]?.matchedMessage.content).toBe(
      "caller says supercalifragilistic",
    );

    // Given: a different user with a thread in the caller's org
    // and a thread in a different org (same userId, different
    // orgs).
    const myUserId = `user_${randomUUID()}`;
    const myOrgId = `org_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;
    const inOrgFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: myUserId, orgId: myOrgId, title: "in-org thread" },
        context.signal,
      ),
    );
    const otherOrgFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: myUserId, orgId: otherOrgId, title: "out-of-org thread" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      inOrgFixture,
      { role: "user", content: "inside-org antelope sighting" },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      otherOrgFixture,
      { role: "user", content: "other-org antelope sighting" },
      context.signal,
    );
    mocks.clerk.session(myUserId, myOrgId);

    // When + Then: only the in-org message matches.
    const crossOrg = await accept(
      searchClient().search({
        query: { keyword: "antelope" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(crossOrg.body.results).toHaveLength(1);
    expect(crossOrg.body.results[0]?.chatThreadId).toBe(inOrgFixture.threadId);
    expect(crossOrg.body.results[0]?.matchedMessage.content).toBe(
      "inside-org antelope sighting",
    );
  });
});

describe("BDD GET /api/zero/chat/search — empty + null content chain", () => {
  it("gwt-wt-wt: 200 empty results (no matching messages) → 200 excludes messages with null content", async () => {
    // Given: a thread with no messages at all.
    const emptyFixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);

    // When + Then: empty results, hasMore=false.
    const empty = await accept(
      searchClient().search({
        query: { keyword: "nonexistent" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(empty.body.results).toStrictEqual([]);
    expect(empty.body.hasMore).toBeFalsy();

    // Given: a thread with a null-content message and a real
    // message.
    const nullFixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      nullFixture,
      { role: "assistant", content: null },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      nullFixture,
      { role: "user", content: "real meerkat content" },
      context.signal,
    );
    mocks.clerk.session(nullFixture.userId, nullFixture.orgId);

    // When + Then: only the non-null content message matches.
    const nullContent = await accept(
      searchClient().search({
        query: { keyword: "meerkat" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(nullContent.body.results).toHaveLength(1);
    expect(nullContent.body.results[0]?.matchedMessage.content).toBe(
      "real meerkat content",
    );
  });
});

describe("BDD GET /api/zero/chat/search — since + agentId filter chain", () => {
  it("gwt-wt-wt: 200 narrows results by --since filter → 200 narrows results by agentId filter", async () => {
    // Given: a thread with one ancient message and one recent
    // message.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const baseMs = now();
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "ancient quokka spotted",
        createdAt: new Date(baseMs - 30 * 24 * 60 * 60 * 1000),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "recent quokka spotted",
        createdAt: new Date(baseMs - 60 * 1000),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: only the recent message matches after the
    // since filter.
    const sinceResponse = await accept(
      searchClient().search({
        query: { keyword: "quokka", since: baseMs - 24 * 60 * 60 * 1000 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(sinceResponse.body.results).toHaveLength(1);
    expect(sinceResponse.body.results[0]?.matchedMessage.content).toBe(
      "recent quokka spotted",
    );

    // Given: two threads (two agents) each with a matching
    // message.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const fixtureA = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "a" },
        context.signal,
      ),
    );
    const fixtureB = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "b" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      fixtureA,
      { role: "user", content: "agent A mentions narwhal" },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixtureB,
      { role: "user", content: "agent B mentions narwhal" },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: agentId filter narrows to the requested
    // agent's thread.
    const agentResponse = await accept(
      searchClient().search({
        query: { keyword: "narwhal", agentId: fixtureA.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(agentResponse.body.results).toHaveLength(1);
    expect(agentResponse.body.results[0]?.chatThreadId).toBe(fixtureA.threadId);
    expect(agentResponse.body.results[0]?.matchedMessage.content).toBe(
      "agent A mentions narwhal",
    );
  });
});

describe("BDD GET /api/zero/chat/search — context before/after chain", () => {
  it("gwt-wt-wt: 200 contextBefore and contextAfter in chronological order", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const baseMs = now();
    const messageTimes: readonly {
      readonly role: "user" | "assistant";
      readonly content: string;
      readonly offset: number;
    }[] = [
      { role: "user", content: "msg 1", offset: 0 },
      { role: "assistant", content: "msg 2", offset: 1000 },
      { role: "user", content: "the okapi was here", offset: 2000 },
      { role: "assistant", content: "msg 4", offset: 3000 },
      { role: "user", content: "msg 5", offset: 4000 },
    ];
    for (const m of messageTimes) {
      await store.set(
        seedZeroChatMessage$,
        fixture,
        {
          role: m.role,
          content: m.content,
          createdAt: new Date(baseMs + m.offset),
        },
        context.signal,
      );
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: contextBefore has msg 1 + msg 2, matched is
    // the okapi message, contextAfter has msg 4 + msg 5.
    const response = await accept(
      searchClient().search({
        query: { keyword: "okapi", before: 2, after: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response.body.results).toHaveLength(1);
    const result = response.body.results[0]!;
    expect(result.matchedMessage.content).toBe("the okapi was here");
    expect(
      result.contextBefore.map((m) => {
        return m.content;
      }),
    ).toStrictEqual(["msg 1", "msg 2"]);
    expect(
      result.contextAfter.map((m) => {
        return m.content;
      }),
    ).toStrictEqual(["msg 4", "msg 5"]);
  });
});

describe("BDD GET /api/zero/chat/search — hasMore chain", () => {
  it("gwt-wt-wt: 200 hasMore=true when matches exceed limit", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const baseMs = now();
    for (let i = 0; i < 5; i += 1) {
      await store.set(
        seedZeroChatMessage$,
        fixture,
        {
          role: "user",
          content: `capybara sighting #${i}`,
          createdAt: new Date(baseMs + i * 1000),
        },
        context.signal,
      );
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: limit=2 returns 2 results with hasMore=true.
    const response = await accept(
      searchClient().search({
        query: { keyword: "capybara", limit: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response.body.results).toHaveLength(2);
    expect(response.body.hasMore).toBeTruthy();
  });
});

describe("BDD GET /api/zero/chat/search — LIKE wildcard escape chain", () => {
  it("gwt-wt-wt: 200 escapes LIKE wildcards in the keyword", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    // A literal "%" in content; the keyword "50%" should match
    // ONLY this. A second message would match if "%" were
    // treated as a wildcard.
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "discount is 50% today" },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "50 apples and bananas" },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: only the literal "%" message matches.
    const response = await accept(
      searchClient().search({
        query: { keyword: "50%" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.matchedMessage.content).toBe(
      "discount is 50% today",
    );
  });
});
