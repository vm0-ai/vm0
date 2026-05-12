import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { integrationsChatMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
  readonly capabilities?: readonly ZeroCapability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? `run_${randomUUID()}`,
    capabilities: args.capabilities ?? ["chat-message:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function deleteThreadsForComposes(
  composeIds: readonly string[],
): Promise<void> {
  if (composeIds.length === 0) {
    return;
  }

  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(inArray(chatThreads.agentComposeId, [...composeIds]));
  const threadIds = rows.map((row) => {
    return row.id;
  });
  if (threadIds.length === 0) {
    return;
  }

  await writeDb
    .delete(chatMessages)
    .where(inArray(chatMessages.chatThreadId, threadIds));
  await writeDb.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
}

const trackThread = createFixtureTracker<ZeroChatThreadFixture>(
  async (fixture) => {
    await deleteThreadsForComposes([fixture.composeId]);
    await store.set(deleteZeroChatThread$, fixture, context.signal);
  },
);

const trackTeam = createFixtureTracker<TeamComposeFixture>(async (fixture) => {
  await deleteThreadsForComposes(fixture.composeIds);
  await store.set(deleteTeamCompose$, fixture, context.signal);
});

const trackMembership = createFixtureTracker<OrgMembershipFixture>(
  (fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

async function seedMembership(args: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  await trackMembership(
    store.set(
      seedOrgMembership$,
      { userId: args.userId, orgId: args.orgId, role: "admin" },
      context.signal,
    ),
  );
}

async function getMessageRow(messageId: string) {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({
      id: chatMessages.id,
      chatThreadId: chatMessages.chatThreadId,
      role: chatMessages.role,
      content: chatMessages.content,
      runId: chatMessages.runId,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId));
  return row;
}

async function getThreadRow(threadId: string) {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({
      id: chatThreads.id,
      userId: chatThreads.userId,
      agentComposeId: chatThreads.agentComposeId,
      title: chatThreads.title,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  return row;
}

async function countThreadsForCompose(composeId: string): Promise<number> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.agentComposeId, composeId));
  return rows.length;
}

describe("POST /api/zero/integrations/chat/message", () => {
  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({ context })(integrationsChatMessageContract);

    const response = await accept(
      client.sendMessage({
        headers: {},
        body: { thread: randomUUID(), text: "hello" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(integrationsChatMessageContract);

    const response = await accept(
      client.sendMessage({
        headers: { authorization: "Bearer clerk-session" },
        body: { agent: randomUUID(), text: "hello" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 403 when a sandbox token lacks chat-message:write", async () => {
    const token = sandboxToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const client = setupApp({ context })(integrationsChatMessageContract);

    const response = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: { thread: randomUUID(), text: "hello" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Missing required capability: chat-message:write",
      code: "FORBIDDEN",
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 400 when the body does not choose exactly one target", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const client = setupApp({ context })(integrationsChatMessageContract);

    const withoutTarget = await accept(
      client.sendMessage({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "hello" },
      }),
      [400],
    );
    expect(withoutTarget.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Exactly one of 'thread' or 'agent' must be provided",
    });

    const withBothTargets = await accept(
      client.sendMessage({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          thread: randomUUID(),
          agent: randomUUID(),
          text: "hello",
        },
      }),
      [400],
    );
    expect(withBothTargets.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Exactly one of 'thread' or 'agent' must be provided",
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for an inaccessible existing thread", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const client = setupApp({ context })(integrationsChatMessageContract);

    const response = await accept(
      client.sendMessage({
        headers: { authorization: "Bearer clerk-session" },
        body: { thread: fixture.threadId, text: "hello" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 when the target agent is not in the caller org", async () => {
    const otherFixture = await trackTeam(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Other agent" }] },
        context.signal,
      ),
    );
    const otherComposeId = otherFixture.composeIds[0]!;

    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(integrationsChatMessageContract);

    const response = await accept(
      client.sendMessage({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agent: otherComposeId,
          text: "hello",
        },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    await expect(countThreadsForCompose(otherComposeId)).resolves.toBe(0);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("inserts an assistant message into an existing thread", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await seedMembership({ userId: fixture.userId, orgId: fixture.orgId });
    const client = setupApp({ context })(integrationsChatMessageContract);

    const response = await accept(
      client.sendMessage({
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
          })}`,
        },
        body: { thread: fixture.threadId, text: "integration reply" },
      }),
      [201],
    );

    expect(response.body.threadId).toBe(fixture.threadId);
    const message = await getMessageRow(response.body.messageId);
    expect(message).toMatchObject({
      id: response.body.messageId,
      chatThreadId: fixture.threadId,
      role: "assistant",
      content: "integration reply",
      runId: null,
    });
    expect(message?.createdAt.toISOString()).toBe(response.body.createdAt);
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);
    expect(context.mocks.ably.publish).toHaveBeenNthCalledWith(
      1,
      `chatThreadMessageCreated:${fixture.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenNthCalledWith(
      2,
      "threadListChanged",
      null,
    );
  });

  it("creates a thread and inserts an assistant message for an agent target", async () => {
    const fixture = await trackTeam(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Agent" }] },
        context.signal,
      ),
    );
    const composeId = fixture.composeIds[0]!;
    await seedMembership({ userId: fixture.userId, orgId: fixture.orgId });
    const client = setupApp({ context })(integrationsChatMessageContract);

    const response = await accept(
      client.sendMessage({
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
          })}`,
        },
        body: {
          agent: composeId,
          title: "Integration inbox",
          text: "new thread reply",
        },
      }),
      [201],
    );

    await expect(getThreadRow(response.body.threadId)).resolves.toMatchObject({
      id: response.body.threadId,
      userId: fixture.userId,
      agentComposeId: composeId,
      title: "Integration inbox",
    });

    const message = await getMessageRow(response.body.messageId);
    expect(message).toMatchObject({
      id: response.body.messageId,
      chatThreadId: response.body.threadId,
      role: "assistant",
      content: "new thread reply",
      runId: null,
    });
    expect(message?.createdAt.toISOString()).toBe(response.body.createdAt);
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);
    expect(context.mocks.ably.publish).toHaveBeenNthCalledWith(
      1,
      `chatThreadMessageCreated:${response.body.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenNthCalledWith(
      2,
      "threadListChanged",
      null,
    );
  });
});
