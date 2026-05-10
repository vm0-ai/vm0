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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/chat/search", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({ query: { keyword: "hello" }, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "hello" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when token lacks chat-message:read capability", async () => {
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

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("chat-message:read");
  });

  it("returns only the caller's own messages within the same org (peer-user isolation)", async () => {
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

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "supercalifragilistic" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.chatThreadId).toBe(callerFixture.threadId);
    expect(response.body.results[0]?.matchedMessage.content).toBe(
      "caller says supercalifragilistic",
    );
  });

  it("returns only messages from the caller's org (cross-org isolation)", async () => {
    const userId = `user_${randomUUID()}`;
    const myOrgId = `org_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;

    const inOrgFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId: myOrgId, title: "in-org thread" },
        context.signal,
      ),
    );
    const otherOrgFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId: otherOrgId, title: "out-of-org thread" },
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

    mocks.clerk.session(userId, myOrgId);

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "antelope" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.chatThreadId).toBe(inOrgFixture.threadId);
    expect(response.body.results[0]?.matchedMessage.content).toBe(
      "inside-org antelope sighting",
    );
  });

  it("returns empty results when caller has no matching messages", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "nonexistent" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toStrictEqual([]);
    expect(response.body.hasMore).toBeFalsy();
  });

  it("excludes messages with null content", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "assistant", content: null },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "real meerkat content" },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "meerkat" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.matchedMessage.content).toBe(
      "real meerkat content",
    );
  });

  it("excludes archived messages", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "live platypus observation" },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "archived platypus observation",
        archivedAt: new Date(now()),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "platypus" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.matchedMessage.content).toBe(
      "live platypus observation",
    );
  });

  it("narrows results by --since filter", async () => {
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

    const since = baseMs - 24 * 60 * 60 * 1000;
    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "quokka", since },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.matchedMessage.content).toBe(
      "recent quokka spotted",
    );
  });

  it("narrows results by agentId filter", async () => {
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

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "narwhal", agentId: fixtureA.composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.chatThreadId).toBe(fixtureA.threadId);
    expect(response.body.results[0]?.matchedMessage.content).toBe(
      "agent A mentions narwhal",
    );
  });

  it("returns contextBefore and contextAfter in chronological order", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const baseMs = now();
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "msg 1", createdAt: new Date(baseMs + 0) },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "msg 2",
        createdAt: new Date(baseMs + 1000),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "the okapi was here",
        createdAt: new Date(baseMs + 2000),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "msg 4",
        createdAt: new Date(baseMs + 3000),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "msg 5", createdAt: new Date(baseMs + 4000) },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "okapi", before: 2, after: 2 },
        headers: { authorization: "Bearer clerk-session" },
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

  it("sets hasMore=true when matches exceed limit", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const baseMs = now();
    for (let i = 0; i < 5; i++) {
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

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "capybara", limit: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(2);
    expect(response.body.hasMore).toBeTruthy();
  });

  it("escapes LIKE wildcards in the keyword", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    // A literal "%" in content; the keyword "50%" should match ONLY this.
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "discount is 50% today" },
      context.signal,
    );
    // A message that would match if "%" were treated as a wildcard instead.
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "50 apples and bananas" },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "50%" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.matchedMessage.content).toBe(
      "discount is 50% today",
    );
  });
});
