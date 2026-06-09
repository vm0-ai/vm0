import { randomUUID } from "node:crypto";

import { createApp } from "../../../app-factory";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  chatThreadV1GetContract,
  chatThreadV1MessagesContract,
  chatThreadV1SendContract,
} from "@vm0/api-contracts/contracts/chat-threads-v1";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { clearAllDetached } from "../../utils";
import {
  signPatJwtForTests,
  signSandboxJwtForTests,
  verifyZeroToken,
} from "../../auth/tokens";
import {
  decryptSecretForTests,
  decryptSecretsMapForTests,
} from "./helpers/encrypt-secret";

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

interface RunnableAgentFixture {
  readonly composeId: string;
  readonly versionId: string;
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
  await writeDb.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });

  return { token, tokenId, userId, orgId };
}

async function seedExpiredPatFixture(): Promise<PatFixture> {
  const tokenId = randomUUID();
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const expiredSeconds = currentSecond() - 60;

  const token = signPatJwtForTests({
    scope: "cli",
    userId,
    orgId,
    tokenId,
    iat: expiredSeconds - 60,
    exp: expiredSeconds,
  });
  const writeDb = store.set(writeDb$);

  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId,
    name: "expired test token",
    expiresAt: new Date(now() - 60_000),
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
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
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

function vm0Template(expression: string): string {
  return `$${expression}`;
}

async function seedRunnableAgentFixture(
  pat: PatFixture,
): Promise<RunnableAgentFixture> {
  const composeId = randomUUID();
  const versionId = randomUUID();
  const name = `compose-${composeId.slice(0, 8)}`;
  const writeDb = store.set(writeDb$);
  const content = {
    version: "1.0",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: {
          ANTHROPIC_API_KEY: "test-key",
          ZERO_AGENT_ID: vm0Template("{{ vars.ZERO_AGENT_ID }}"),
          ZERO_TOKEN: vm0Template("{{ secrets.ZERO_TOKEN }}"),
        },
        experimental_runner: { group: "vm0/test" },
      },
    },
  };

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId: pat.userId,
    orgId: pat.orgId,
    name,
    headVersionId: versionId,
  });
  await writeDb.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content,
    createdBy: pat.userId,
  });
  // V1 send routes through createZeroRun$, which requires the agent compose
  // to also be registered as a Zero agent. Mirrors fixtures used by the
  // non-v1 chat tests.
  await writeDb.insert(zeroAgents).values({
    id: composeId,
    orgId: pat.orgId,
    owner: pat.userId,
    name,
    visibility: "public",
  });

  return { composeId, versionId };
}

async function seedRunnableThreadFixture(
  pat: PatFixture,
): Promise<ThreadFixture & RunnableAgentFixture> {
  const agent = await seedRunnableAgentFixture(pat);
  const threadId = randomUUID();
  const writeDb = store.set(writeDb$);
  await writeDb.insert(chatThreads).values({
    id: threadId,
    userId: pat.userId,
    agentComposeId: agent.composeId,
    title: "test thread",
  });
  return { threadId, composeId: agent.composeId, versionId: agent.versionId };
}

async function seedPriorThreadRun(args: {
  readonly pat: PatFixture;
  readonly threadId: string;
  readonly composeId: string;
  readonly versionId: string;
}): Promise<string> {
  const writeDb = store.set(writeDb$);
  const sessionId = randomUUID();
  const runId = randomUUID();
  await writeDb.insert(agentSessions).values({
    id: sessionId,
    userId: args.pat.userId,
    orgId: args.pat.orgId,
    agentComposeId: args.composeId,
  });
  await writeDb.insert(agentRuns).values({
    id: runId,
    userId: args.pat.userId,
    orgId: args.pat.orgId,
    agentComposeVersionId: args.versionId,
    sessionId,
    status: "completed",
    prompt: "previous prompt",
    result: { agentSessionId: sessionId },
  });
  await writeDb.insert(zeroRuns).values({
    id: runId,
    triggerSource: "web",
    chatThreadId: args.threadId,
  });
  return sessionId;
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
    await clearAllDetached();
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

  it("returns 401 for an opaque bearer token", async () => {
    const client = setupApp({ context })(chatThreadV1GetContract);
    await accept(
      client.get({
        params: { threadId: randomUUID() },
        headers: { authorization: "Bearer ak_unknown_opaque_secret" },
      }),
      [401],
    );
  });

  it("returns 401 when the PAT row has been revoked", async () => {
    const pat = await seedPatFixture();
    await deletePatFixture(pat);

    const client = setupApp({ context })(chatThreadV1GetContract);
    await accept(
      client.get({
        params: { threadId: randomUUID() },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [401],
    );
  });

  it("returns 401 when the PAT is expired", async () => {
    const pat = await seedExpiredPatFixture();
    pats.push(pat);

    const client = setupApp({ context })(chatThreadV1GetContract);
    await accept(
      client.get({
        params: { threadId: randomUUID() },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [401],
    );
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
    await clearAllDetached();
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

  it("returns 401 when no Authorization header is provided", async () => {
    const client = setupApp({ context })(chatThreadV1MessagesContract);
    await accept(
      client.list({
        params: { threadId: randomUUID() },
        query: {},
        headers: {},
      }),
      [401],
    );
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

    const client = setupApp({ context })(chatThreadV1MessagesContract);
    await accept(
      client.list({
        params: { threadId: randomUUID() },
        query: {},
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );
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

describe("POST /api/v1/chat-threads/messages", () => {
  const pats: PatFixture[] = [];
  const threads: ThreadFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    await clearAllDetached();
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

  it("returns 401 with web's 'API key required' phrasing when no Authorization header is provided", async () => {
    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: {},
        body: { prompt: "hello", threadId: randomUUID() },
      }),
      [401],
    );

    expect(response.body.error).toStrictEqual({
      message: "API key required",
      code: "UNAUTHORIZED",
    });
  });

  it("returns 401 for an opaque bearer token", async () => {
    const client = setupApp({ context })(chatThreadV1SendContract);
    await accept(
      client.send({
        headers: { authorization: "Bearer ak_unknown_opaque_secret" },
        body: { prompt: "hello", threadId: randomUUID() },
      }),
      [401],
    );
  });

  it("returns 401 when the PAT row has been revoked", async () => {
    const pat = await seedPatFixture();
    await deletePatFixture(pat);

    const client = setupApp({ context })(chatThreadV1SendContract);
    await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: { prompt: "hello", threadId: randomUUID() },
      }),
      [401],
    );
  });

  it("returns 401 when the PAT is expired", async () => {
    const pat = await seedExpiredPatFixture();
    pats.push(pat);

    const client = setupApp({ context })(chatThreadV1SendContract);
    await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: { prompt: "hello", threadId: randomUUID() },
      }),
      [401],
    );
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

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${sandboxToken}` },
        body: { prompt: "hello", threadId: randomUUID() },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("appends to a thread, creates a run, chat callback, user message, and runner job", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedRunnableThreadFixture(pat);
    threads.push(thread);

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: { prompt: "hello from v1", threadId: thread.threadId },
      }),
      [201],
    );
    await clearAllDetached();

    const writeDb = store.set(writeDb$);
    const [threadRow] = await writeDb
      .select({
        id: chatThreads.id,
        userId: chatThreads.userId,
        agentComposeId: chatThreads.agentComposeId,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, response.body.threadId))
      .limit(1);
    expect(threadRow).toStrictEqual({
      id: thread.threadId,
      userId: pat.userId,
      agentComposeId: thread.composeId,
    });

    const [message] = await writeDb
      .select({
        id: chatMessages.id,
        content: chatMessages.content,
        role: chatMessages.role,
        runId: chatMessages.runId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, response.body.messageId))
      .limit(1);
    if (!message?.runId) {
      throw new Error("Expected inserted chat message to reference a run");
    }
    expect(message).toMatchObject({
      id: response.body.messageId,
      content: "hello from v1",
      role: "user",
    });
    expect(response.body).toMatchObject({
      threadId: thread.threadId,
      runId: message.runId,
    });

    const [run] = await writeDb
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        triggerSource: zeroRuns.triggerSource,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.id, message.runId))
      .limit(1);
    expect(run).toMatchObject({
      prompt: "hello from v1",
      triggerSource: "web",
      chatThreadId: thread.threadId,
    });
    expect(run?.appendSystemPrompt).toContain("# Agent Tools");
    expect(run?.appendSystemPrompt).toContain("# Current User Info");
    expect(run?.appendSystemPrompt).toContain(
      "# Current Integration\nYou are currently running inside: Web\n\nYou are communicating with the user through the web chat UI.",
    );

    const [callback] = await writeDb
      .select({
        url: agentRunCallbacks.url,
        encryptedSecret: agentRunCallbacks.encryptedSecret,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, message.runId))
      .limit(1);
    if (!callback) {
      throw new Error("Expected chat callback to be registered");
    }
    expect(callback.url).toBe(
      "http://localhost:3000/api/internal/callbacks/chat",
    );
    expect(decryptSecretForTests(callback.encryptedSecret)).toHaveLength(64);
    expect(callback.payload).toStrictEqual({
      threadId: thread.threadId,
      agentId: thread.composeId,
    });

    const [job] = await writeDb
      .select({ runnerGroup: runnerJobQueue.runnerGroup })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, message.runId))
      .limit(1);
    expect(job).toStrictEqual({ runnerGroup: "vm0/test" });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${response.body.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadRunCreated:${response.body.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    expect(response.body.createdAt).toStrictEqual(expect.any(String));
  });

  it("injects a ZERO_TOKEN sandbox secret into the runner execution context", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedRunnableThreadFixture(pat);
    threads.push(thread);

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: { prompt: "needs zero token", threadId: thread.threadId },
      }),
      [201],
    );
    await clearAllDetached();

    const writeDb = store.set(writeDb$);
    const [message] = await writeDb
      .select({ runId: chatMessages.runId })
      .from(chatMessages)
      .where(eq(chatMessages.id, response.body.messageId))
      .limit(1);
    if (!message?.runId) {
      throw new Error("Expected user message to reference a run");
    }

    const [job] = await writeDb
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, message.runId))
      .limit(1);
    const encryptedSecrets =
      typeof job?.executionContext === "object" &&
      job.executionContext !== null &&
      "encryptedSecrets" in job.executionContext &&
      typeof (job.executionContext as { encryptedSecrets: unknown })
        .encryptedSecrets === "string"
        ? (job.executionContext as { encryptedSecrets: string })
            .encryptedSecrets
        : null;
    const secrets = decryptSecretsMapForTests(encryptedSecrets);
    expect(secrets?.ZERO_TOKEN).toMatch(/^vm0_sandbox_/);
    const zeroAuth = verifyZeroToken(secrets!.ZERO_TOKEN!);
    expect(zeroAuth?.userId).toBe(pat.userId);
    expect(zeroAuth?.orgId).toBe(pat.orgId);
  });

  it("does not require unconfigured connector environment refs before creating a chat run", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedRunnableThreadFixture(pat);
    threads.push(thread);
    const writeDb = store.set(writeDb$);
    // Reproduce the production regression: the thread's agent references
    // integration vars/secrets the caller has not provided. Before this route
    // was wired through createZeroRun$, strict env-ref validation rejected the
    // run with HTTP 400 "Missing required values: vars.*".
    await writeDb
      .update(agentComposeVersions)
      .set({
        content: {
          version: "1.0",
          agents: {
            main: {
              framework: "claude-code",
              environment: {
                ANTHROPIC_API_KEY: "test-key",
                ZERO_AGENT_ID: vm0Template("{{ vars.ZERO_AGENT_ID }}"),
                ZERO_TOKEN: vm0Template("{{ secrets.ZERO_TOKEN }}"),
                JIRA_EMAIL: vm0Template("{{ vars.JIRA_EMAIL }}"),
                GITLAB_HOST: vm0Template("{{ vars.GITLAB_HOST }}"),
                GH_TOKEN: vm0Template("{{ secrets.GH_TOKEN }}"),
                SLACK_TOKEN: vm0Template("{{ secrets.SLACK_TOKEN }}"),
              },
              experimental_runner: { group: "vm0/test" },
            },
          },
        },
      })
      .where(eq(agentComposeVersions.id, thread.versionId));

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: {
          prompt: "use the existing thread zero agent",
          threadId: thread.threadId,
        },
      }),
      [201],
    );

    expect(response.body.messageId).toStrictEqual(expect.any(String));
    expect(response.body.threadId).toStrictEqual(thread.threadId);
  });

  it("mounts custom skills configured on the agent", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedRunnableThreadFixture(pat);
    threads.push(thread);
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(zeroAgents)
      .set({ customSkills: ["pp"] })
      .where(eq(zeroAgents.id, thread.composeId));

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: { prompt: "use the pp skill", threadId: thread.threadId },
      }),
      [201],
    );
    await clearAllDetached();

    const [message] = await writeDb
      .select({ runId: chatMessages.runId })
      .from(chatMessages)
      .where(eq(chatMessages.id, response.body.messageId))
      .limit(1);
    if (!message?.runId) {
      throw new Error("Expected user message to reference a run");
    }

    const [run] = await writeDb
      .select({ additionalVolumes: agentRuns.additionalVolumes })
      .from(agentRuns)
      .where(eq(agentRuns.id, message.runId))
      .limit(1);
    const volumes = run?.additionalVolumes ?? [];
    expect(volumes).toContainEqual(
      expect.objectContaining({
        name: "custom-skill@pp",
        mountPath: "/home/user/.claude/skills/pp",
      }),
    );
  });

  it("queues the user message when the target thread already has an active run", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedRunnableThreadFixture(pat);
    threads.push(thread);
    const writeDb = store.set(writeDb$);
    const activeSessionId = randomUUID();
    const activeRunId = randomUUID();
    await writeDb.insert(agentSessions).values({
      id: activeSessionId,
      userId: pat.userId,
      orgId: pat.orgId,
      agentComposeId: thread.composeId,
    });
    await writeDb.insert(agentRuns).values({
      id: activeRunId,
      userId: pat.userId,
      orgId: pat.orgId,
      agentComposeVersionId: thread.versionId,
      sessionId: activeSessionId,
      status: "running",
      prompt: "active prompt",
    });
    await writeDb.insert(zeroRuns).values({
      id: activeRunId,
      triggerSource: "web",
      chatThreadId: thread.threadId,
    });

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: { prompt: "queued from v1", threadId: thread.threadId },
      }),
      [201],
    );

    expect(response.body).toMatchObject({
      threadId: thread.threadId,
      messageId: expect.any(String),
      runId: null,
      createdAt: expect.any(String),
    });

    const [message] = await writeDb
      .select({
        id: chatMessages.id,
        content: chatMessages.content,
        role: chatMessages.role,
        runId: chatMessages.runId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, response.body.messageId))
      .limit(1);
    expect(message).toStrictEqual({
      id: response.body.messageId,
      content: "queued from v1",
      role: "user",
      runId: null,
    });
  });

  it("continues an existing thread from the latest session", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const thread = await seedRunnableThreadFixture(pat);
    threads.push(thread);
    const priorSessionId = await seedPriorThreadRun({
      pat,
      threadId: thread.threadId,
      composeId: thread.composeId,
      versionId: thread.versionId,
    });

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: { prompt: "continue", threadId: thread.threadId },
      }),
      [201],
    );
    await clearAllDetached();

    expect(response.body.threadId).toBe(thread.threadId);

    const writeDb = store.set(writeDb$);
    const [message] = await writeDb
      .select({ runId: chatMessages.runId })
      .from(chatMessages)
      .where(eq(chatMessages.id, response.body.messageId))
      .limit(1);
    if (!message?.runId) {
      throw new Error("Expected continuation message to reference a run");
    }

    const [run] = await writeDb
      .select({
        sessionId: agentRuns.sessionId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.id, message.runId))
      .limit(1);
    expect(run).toStrictEqual({
      sessionId: priorSessionId,
      continuedFromSessionId: priorSessionId,
      chatThreadId: thread.threadId,
    });
  });

  it("returns 400 when threadId is omitted", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${pat.token}` },
        body: { prompt: "hello" } as never,
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("threadId");
  });

  it("returns 404 when appending to another user's thread", async () => {
    const owner = await seedPatFixture();
    pats.push(owner);
    const intruder = await seedPatFixture();
    pats.push(intruder);
    const thread = await seedRunnableThreadFixture(owner);
    threads.push(thread);

    const client = setupApp({ context })(chatThreadV1SendContract);
    const response = await accept(
      client.send({
        headers: { authorization: `Bearer ${intruder.token}` },
        body: { prompt: "nope", threadId: thread.threadId },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
