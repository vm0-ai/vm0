import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { insertOrgMembersCacheEntry } from "../../../../../../src/__tests__/db-test-seeders/org-members-cache";
import {
  seedTestCompose,
  insertTestChatThread,
  insertTestChatMessage,
} from "../../../../../../src/__tests__/db-test-seeders/agents";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  generateZeroToken,
  generateSandboxToken,
} from "../../../../../../src/lib/auth/sandbox-token";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

const URL_BASE = "http://localhost:3000/api/zero/chat/search";

describe("GET /api/zero/chat/search", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when no auth is provided", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(`${URL_BASE}?keyword=hello`));

    expect(response.status).toBe(401);
  });

  it("returns 403 when token lacks chat-message:read capability", async () => {
    const user = await context.setupUser();
    const token = await generateSandboxToken(user.userId, "run-1");
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(`${URL_BASE}?keyword=hello`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.message).toContain("chat-message:read");
  });

  describe("authorization boundaries", () => {
    it("returns only the caller's own messages within the same org (peer user isolation)", async () => {
      const caller = await context.setupUser({ prefix: "caller" });
      const peer = await context.setupUser({ prefix: "peer" });

      // Peer lives in the same org as the caller.
      const { composeId: callerCompose } = await seedTestCompose({
        userId: caller.userId,
        orgId: caller.orgId,
        name: uniqueId("agent-caller"),
      });
      const { composeId: peerCompose } = await seedTestCompose({
        userId: peer.userId,
        orgId: caller.orgId,
        name: uniqueId("agent-peer"),
      });

      const callerThread = await insertTestChatThread(
        caller.userId,
        callerCompose,
        "caller thread",
      );
      const peerThread = await insertTestChatThread(
        peer.userId,
        peerCompose,
        "peer thread",
      );

      await insertTestChatMessage({
        chatThreadId: callerThread,
        role: "user",
        content: "caller says supercalifragilistic",
      });
      await insertTestChatMessage({
        chatThreadId: peerThread,
        role: "user",
        content: "peer says supercalifragilistic",
      });

      await insertOrgMembersCacheEntry({
        orgId: caller.orgId,
        userId: caller.userId,
      });
      const token = await generateZeroToken(
        caller.userId,
        "run-1",
        caller.orgId,
      );
      mockClerk({ userId: null });

      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=supercalifragilistic`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].chatThreadId).toBe(callerThread);
      expect(data.results[0].matchedMessage.content).toBe(
        "caller says supercalifragilistic",
      );
    });

    it("returns only messages from the caller's org (cross-org isolation)", async () => {
      const caller = await context.setupUser({ prefix: "caller" });
      const otherOrgId = uniqueId("other-org");

      const { composeId: callerCompose } = await seedTestCompose({
        userId: caller.userId,
        orgId: caller.orgId,
        name: uniqueId("agent-in"),
      });
      // Same user in a DIFFERENT org — must NOT appear.
      const { composeId: otherOrgCompose } = await seedTestCompose({
        userId: caller.userId,
        orgId: otherOrgId,
        name: uniqueId("agent-out"),
      });

      const callerThread = await insertTestChatThread(
        caller.userId,
        callerCompose,
        "in-org thread",
      );
      const otherOrgThread = await insertTestChatThread(
        caller.userId,
        otherOrgCompose,
        "out-of-org thread",
      );

      await insertTestChatMessage({
        chatThreadId: callerThread,
        role: "user",
        content: "inside-org antelope sighting",
      });
      await insertTestChatMessage({
        chatThreadId: otherOrgThread,
        role: "user",
        content: "other-org antelope sighting",
      });

      await insertOrgMembersCacheEntry({
        orgId: caller.orgId,
        userId: caller.userId,
      });
      const token = await generateZeroToken(
        caller.userId,
        "run-1",
        caller.orgId,
      );
      mockClerk({ userId: null });

      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=antelope`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].chatThreadId).toBe(callerThread);
      expect(data.results[0].matchedMessage.content).toBe(
        "inside-org antelope sighting",
      );
    });
  });

  describe("with authenticated caller", () => {
    async function setupAuthenticatedCaller() {
      const caller = await context.setupUser();
      const { composeId } = await seedTestCompose({
        userId: caller.userId,
        orgId: caller.orgId,
        name: uniqueId("agent"),
      });
      const threadId = await insertTestChatThread(
        caller.userId,
        composeId,
        "t",
      );
      await insertOrgMembersCacheEntry({
        orgId: caller.orgId,
        userId: caller.userId,
      });
      const token = await generateZeroToken(
        caller.userId,
        "run-1",
        caller.orgId,
      );
      mockClerk({ userId: null });
      return { caller, composeId, threadId, token };
    }

    it("returns empty results when caller has no matching messages", async () => {
      const { token } = await setupAuthenticatedCaller();

      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=nonexistent`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("excludes messages with null content", async () => {
      const { threadId, token } = await setupAuthenticatedCaller();

      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "assistant",
        content: null,
      });
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "real meerkat content",
      });

      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=meerkat`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].matchedMessage.content).toBe(
        "real meerkat content",
      );
    });

    it("excludes archived messages", async () => {
      const { threadId, token } = await setupAuthenticatedCaller();

      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "live platypus observation",
      });
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "archived platypus observation",
        archivedAt: new Date(),
      });

      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=platypus`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].matchedMessage.content).toBe(
        "live platypus observation",
      );
    });

    it("narrows results by --since filter", async () => {
      const { threadId, token } = await setupAuthenticatedCaller();

      const now = Date.now();
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "ancient quokka spotted",
        createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
      });
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "recent quokka spotted",
        createdAt: new Date(now - 60 * 1000),
      });

      const since = now - 24 * 60 * 60 * 1000;
      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=quokka&since=${since}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].matchedMessage.content).toBe(
        "recent quokka spotted",
      );
    });

    it("narrows results by --agent name filter", async () => {
      const caller = await context.setupUser();
      const nameA = uniqueId("agent-a");
      const nameB = uniqueId("agent-b");
      const { composeId: composeA } = await seedTestCompose({
        userId: caller.userId,
        orgId: caller.orgId,
        name: nameA,
      });
      const { composeId: composeB } = await seedTestCompose({
        userId: caller.userId,
        orgId: caller.orgId,
        name: nameB,
      });
      const threadA = await insertTestChatThread(caller.userId, composeA, "a");
      const threadB = await insertTestChatThread(caller.userId, composeB, "b");
      await insertTestChatMessage({
        chatThreadId: threadA,
        role: "user",
        content: "agent A mentions narwhal",
      });
      await insertTestChatMessage({
        chatThreadId: threadB,
        role: "user",
        content: "agent B mentions narwhal",
      });

      await insertOrgMembersCacheEntry({
        orgId: caller.orgId,
        userId: caller.userId,
      });
      const token = await generateZeroToken(
        caller.userId,
        "run-1",
        caller.orgId,
      );
      mockClerk({ userId: null });

      const response = await GET(
        createTestRequest(
          `${URL_BASE}?keyword=narwhal&agent=${encodeURIComponent(nameA)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].agentName).toBe(nameA);
      expect(data.results[0].matchedMessage.content).toBe(
        "agent A mentions narwhal",
      );
    });

    it("returns contextBefore and contextAfter in chronological order", async () => {
      const { threadId, token } = await setupAuthenticatedCaller();

      const base = Date.now();
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "msg 1",
        createdAt: new Date(base + 0),
      });
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "assistant",
        content: "msg 2",
        createdAt: new Date(base + 1000),
      });
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "the okapi was here",
        createdAt: new Date(base + 2000),
      });
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "assistant",
        content: "msg 4",
        createdAt: new Date(base + 3000),
      });
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "msg 5",
        createdAt: new Date(base + 4000),
      });

      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=okapi&before=2&after=2`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(1);
      const result = data.results[0];
      expect(result.matchedMessage.content).toBe("the okapi was here");
      expect(
        result.contextBefore.map((m: { content: string }) => {
          return m.content;
        }),
      ).toEqual(["msg 1", "msg 2"]);
      expect(
        result.contextAfter.map((m: { content: string }) => {
          return m.content;
        }),
      ).toEqual(["msg 4", "msg 5"]);
    });

    it("sets hasMore=true when matches exceed limit", async () => {
      const { threadId, token } = await setupAuthenticatedCaller();

      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        await insertTestChatMessage({
          chatThreadId: threadId,
          role: "user",
          content: `capybara sighting #${i}`,
          createdAt: new Date(base + i * 1000),
        });
      }

      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=capybara&limit=2`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(2);
      expect(data.hasMore).toBe(true);
    });

    it("escapes LIKE wildcards in the keyword", async () => {
      const { threadId, token } = await setupAuthenticatedCaller();

      // A literal "%" in content; the keyword "50%" should match ONLY this.
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "discount is 50% today",
      });
      // A message that would match if "%" were treated as a wildcard instead.
      await insertTestChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: "50 apples and bananas",
      });

      const response = await GET(
        createTestRequest(`${URL_BASE}?keyword=${encodeURIComponent("50%")}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].matchedMessage.content).toBe(
        "discount is 50% today",
      );
    });
  });
});
