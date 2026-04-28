import { randomUUID } from "node:crypto";

import { createApp } from "../../../app-factory";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import {
  chatThreadV1GetContract,
  chatThreadV1MessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads-v1";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { signPatJwtForTests, signSandboxJwtForTests } from "../../auth/tokens";

interface PatFixture {
  readonly token: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly orgId: string;
}

interface ThreadFixture {
  readonly threadId: string;
  readonly composeId: string;
}

const store = createStore();
const context = testContext();

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function seedPatFixture(): Promise<PatFixture> {
  const tokenId = randomUUID();
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const nowSeconds = currentSecond();

  const token = signPatJwtForTests({
    scope: "cli",
    userId,
    orgId,
    tokenId,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
  const writeDb = store.set(writeDb$);

  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId,
    name: "test token",
    expiresAt: new Date(now() + 60_000),
  });
  await writeDb.insert(orgMembersCache).values({
    orgId,
    userId,
    role: "admin",
    cachedAt: new Date(now()),
  });

  return { token, tokenId, userId, orgId };
}

async function deletePatFixture(fixture: PatFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, fixture.orgId),
        eq(orgMembersCache.userId, fixture.userId),
      ),
    );
  await writeDb.delete(cliTokens).where(eq(cliTokens.id, fixture.tokenId));
}

async function seedThreadFixture(
  pat: PatFixture,
  options: { title?: string | null } = {},
): Promise<ThreadFixture> {
  const composeId = randomUUID();
  const threadId = randomUUID();
  const writeDb = store.set(writeDb$);

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId: pat.userId,
    orgId: pat.orgId,
    name: `compose-${composeId.slice(0, 8)}`,
  });
  await writeDb.insert(chatThreads).values({
    id: threadId,
    userId: pat.userId,
    agentComposeId: composeId,
    title: options.title ?? "test thread",
  });

  return { threadId, composeId };
}

async function deleteThreadFixture(fixture: ThreadFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  // chat_messages cascade on chat_threads delete
  await writeDb.delete(chatThreads).where(eq(chatThreads.id, fixture.threadId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
}

interface SeedMessageOptions {
  readonly role: "user" | "assistant";
  readonly content?: string | null;
  readonly createdAtMs?: number;
  readonly sequenceNumber?: number | null;
  readonly error?: string | null;
}

async function seedMessage(
  threadId: string,
  options: SeedMessageOptions,
): Promise<string> {
  const id = randomUUID();
  const writeDb = store.set(writeDb$);
  await writeDb.insert(chatMessages).values({
    id,
    chatThreadId: threadId,
    role: options.role,
    content: options.content ?? null,
    sequenceNumber: options.sequenceNumber ?? null,
    error: options.error ?? null,
    createdAt: new Date(options.createdAtMs ?? now()),
  });
  return id;
}

describe("GET /api/v1/chat-threads/:threadId", () => {
  const pats: PatFixture[] = [];
  const threads: ThreadFixture[] = [];

  beforeEach(() => {
    // Sandbox/Zero/PAT auth all fall through to Clerk session as last resort
    // (see resolvedAuthContext$). Stub the Clerk mock so it doesn't blow up
    // the route on the fall-through branch.
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (threads.length > 0) {
      const t = threads.pop();
      if (t) {
        await deleteThreadFixture(t);
      }
    }
    while (pats.length > 0) {
      const p = pats.pop();
      if (p) {
        await deletePatFixture(p);
      }
    }
  });

  it("returns 200 with thread metadata for the owning PAT", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedThreadFixture(pat, { title: "hello" });
    threads.push(thread);

    const client = setupApp({ context })(chatThreadV1GetContract);
    const response = await accept(
      client.get({
        params: { threadId: thread.threadId },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: thread.threadId,
      title: "hello",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("returns 404 when the thread is owned by a different user", async () => {
    const owner = await seedPatFixture();
    pats.push(owner);
    const intruder = await seedPatFixture();
    pats.push(intruder);
    const thread = await seedThreadFixture(owner);
    threads.push(thread);

    const client = setupApp({ context })(chatThreadV1GetContract);
    const response = await accept(
      client.get({
        params: { threadId: thread.threadId },
        headers: { authorization: `Bearer ${intruder.token}` },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the thread does not exist", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);

    const client = setupApp({ context })(chatThreadV1GetContract);
    const response = await accept(
      client.get({
        params: { threadId: randomUUID() },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for an invalid threadId path param BEFORE consulting auth", async () => {
    // Validation must run before authRoute so a malformed path returns 400
    // even without an Authorization header. The typed client throws on
    // undeclared statuses, so use the raw Hono app to assert.
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/v1/chat-threads/not-a-uuid", {
      method: "GET",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { message: string; code: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("threadId");
  });

  it("returns 401 with web's 'API key required' phrasing when no Authorization header is provided", async () => {
    // Mirrors web's `requireApiKeyAuth` 401 message so the response shadow
    // does not flag matching auth failures as divergent.
    const client = setupApp({ context })(chatThreadV1GetContract);
    const response = await accept(
      client.get({ params: { threadId: randomUUID() }, headers: {} }),
      [401],
    );

    expect(response.body.error).toStrictEqual({
      message: "API key required",
      code: "UNAUTHORIZED",
    });
  });

  it("returns 403 when authenticated with a sandbox token", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = randomUUID();
    const nowSeconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId,
      orgId,
      runId,
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    const client = setupApp({ context })(chatThreadV1GetContract);
    const response = await accept(
      client.get({
        params: { threadId: randomUUID() },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("GET /api/v1/chat-threads/:threadId/messages", () => {
  const pats: PatFixture[] = [];
  const threads: ThreadFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (threads.length > 0) {
      const t = threads.pop();
      if (t) {
        await deleteThreadFixture(t);
      }
    }
    while (pats.length > 0) {
      const p = pats.pop();
      if (p) {
        await deletePatFixture(p);
      }
    }
  });

  it("returns messages in chronological order", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedThreadFixture(pat);
    threads.push(thread);

    const t0 = now();
    const m1 = await seedMessage(thread.threadId, {
      role: "user",
      content: "first",
      createdAtMs: t0,
    });
    const m2 = await seedMessage(thread.threadId, {
      role: "assistant",
      content: "second",
      createdAtMs: t0 + 1000,
    });

    const client = setupApp({ context })(chatThreadV1MessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: thread.threadId },
        query: {},
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [200],
    );

    expect(
      response.body.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual([m1, m2]);
    expect(response.body.messages[0]?.content).toBe("first");
    expect(response.body.messages[1]?.role).toBe("assistant");
  });

  it("paginates forward with sinceId", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedThreadFixture(pat);
    threads.push(thread);

    const t0 = now();
    const m1 = await seedMessage(thread.threadId, {
      role: "user",
      content: "1",
      createdAtMs: t0,
    });
    const m2 = await seedMessage(thread.threadId, {
      role: "user",
      content: "2",
      createdAtMs: t0 + 1000,
    });
    const m3 = await seedMessage(thread.threadId, {
      role: "user",
      content: "3",
      createdAtMs: t0 + 2000,
    });

    const client = setupApp({ context })(chatThreadV1MessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: thread.threadId },
        query: { sinceId: m1 },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [200],
    );

    expect(
      response.body.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual([m2, m3]);
  });

  it("paginates backward with beforeId", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedThreadFixture(pat);
    threads.push(thread);

    const t0 = now();
    const m1 = await seedMessage(thread.threadId, {
      role: "user",
      content: "1",
      createdAtMs: t0,
    });
    const m2 = await seedMessage(thread.threadId, {
      role: "user",
      content: "2",
      createdAtMs: t0 + 1000,
    });
    const m3 = await seedMessage(thread.threadId, {
      role: "user",
      content: "3",
      createdAtMs: t0 + 2000,
    });

    const client = setupApp({ context })(chatThreadV1MessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: thread.threadId },
        query: { beforeId: m3 },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [200],
    );

    expect(
      response.body.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual([m1, m2]);
  });

  it("returns 404 when the thread is owned by a different user", async () => {
    const owner = await seedPatFixture();
    pats.push(owner);
    const intruder = await seedPatFixture();
    pats.push(intruder);
    const thread = await seedThreadFixture(owner);
    threads.push(thread);
    await seedMessage(thread.threadId, { role: "user", content: "a" });

    const client = setupApp({ context })(chatThreadV1MessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: thread.threadId },
        query: {},
        headers: { authorization: `Bearer ${intruder.token}` },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
