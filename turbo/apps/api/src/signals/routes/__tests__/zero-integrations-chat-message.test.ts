import { randomUUID } from "node:crypto";

import { createStore, command } from "ccstate";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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

const deleteCreatedThreads$ = command(
  async (
    { set },
    threadIds: readonly string[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (threadIds.length === 0) {
      return;
    }
    const writeDb = set(writeDb$);
    await writeDb
      .delete(chatMessages)
      .where(inArray(chatMessages.chatThreadId, [...threadIds]));
    signal.throwIfAborted();
    await writeDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, [...threadIds]));
    signal.throwIfAborted();
  },
);

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? `run_${randomUUID()}`,
    capabilities: (args.capabilities ?? ["chat-message:write"]) as never,
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

async function messageRow(messageId: string): Promise<{
  readonly id: string;
  readonly chatThreadId: string;
  readonly role: string;
  readonly content: string | null;
  readonly runId: string | null;
} | null> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({
      id: chatMessages.id,
      chatThreadId: chatMessages.chatThreadId,
      role: chatMessages.role,
      content: chatMessages.content,
      runId: chatMessages.runId,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1);
  return row ?? null;
}

async function threadRow(threadId: string): Promise<{
  readonly id: string;
  readonly userId: string;
  readonly agentComposeId: string;
  readonly title: string | null;
} | null> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({
      id: chatThreads.id,
      userId: chatThreads.userId,
      agentComposeId: chatThreads.agentComposeId,
      title: chatThreads.title,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return row ?? null;
}

async function countMessagesForThread(threadId: string): Promise<number> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        eq(chatMessages.role, "assistant"),
      ),
    );
  return rows.length;
}

describe("POST /api/zero/integrations/chat/message", () => {
  const memberships: OrgMembershipFixture[] = [];
  const teamFixtures: TeamComposeFixture[] = [];
  const threadFixtures: ZeroChatThreadFixture[] = [];
  const createdThreadIds: string[] = [];

  afterEach(async () => {
    await store.set(deleteCreatedThreads$, createdThreadIds, context.signal);
    createdThreadIds.length = 0;
    while (threadFixtures.length > 0) {
      const fixture = threadFixtures.pop();
      if (fixture) {
        await store.set(deleteZeroChatThread$, fixture, context.signal);
      }
    }
    while (teamFixtures.length > 0) {
      const fixture = teamFixtures.pop();
      if (fixture) {
        await store.set(deleteTeamCompose$, fixture, context.signal);
      }
    }
    while (memberships.length > 0) {
      const fixture = memberships.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  async function seedAuthContext(): Promise<{
    readonly userId: string;
    readonly orgId: string;
    readonly token: string;
  }> {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    memberships.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "member" },
        context.signal,
      ),
    );
    return { userId, orgId, token: zeroToken({ userId, orgId }) };
  }

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
  });

  it("returns 401 when the token has no active organization membership", async () => {
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const client = setupApp({ context })(integrationsChatMessageContract);
    const response = await accept(
      client.sendMessage({
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: `user_${randomUUID()}`,
            orgId: `org_${randomUUID()}`,
          })}`,
        },
        body: { thread: randomUUID(), text: "hello" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when sandbox token lacks chat-message:write", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const token = sandboxToken({ userId, orgId });

    const client = setupApp({ context })(integrationsChatMessageContract);
    const response = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: { thread: randomUUID(), text: "hello" },
      }),
      [403],
    );

    expect(response.body.error.message).toContain("chat-message:write");
  });

  it("returns 400 when neither thread nor agent is provided", async () => {
    const auth = await seedAuthContext();
    const client = setupApp({ context })(integrationsChatMessageContract);
    const response = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${auth.token}` },
        body: { text: "hello" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when both thread and agent are provided", async () => {
    const auth = await seedAuthContext();
    const client = setupApp({ context })(integrationsChatMessageContract);
    const response = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${auth.token}` },
        body: { thread: randomUUID(), agent: randomUUID(), text: "hello" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 when an existing thread is not owned by the caller", async () => {
    const auth = await seedAuthContext();
    const foreign = await store.set(
      seedZeroChatThread$,
      { orgId: auth.orgId, userId: `other_${randomUUID()}` },
      context.signal,
    );
    threadFixtures.push(foreign);

    const client = setupApp({ context })(integrationsChatMessageContract);
    const response = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${auth.token}` },
        body: { thread: foreign.threadId, text: "hello" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the requested agent does not exist in the caller org", async () => {
    const auth = await seedAuthContext();
    const client = setupApp({ context })(integrationsChatMessageContract);
    const response = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${auth.token}` },
        body: { agent: randomUUID(), text: "hello" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("inserts an assistant message into an existing thread", async () => {
    const fixture = await store.set(seedZeroChatThread$, {}, context.signal);
    threadFixtures.push(fixture);
    memberships.push(
      await store.set(
        seedOrgMembership$,
        { orgId: fixture.orgId, userId: fixture.userId, role: "member" },
        context.signal,
      ),
    );

    const client = setupApp({ context })(integrationsChatMessageContract);
    const response = await accept(
      client.sendMessage({
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
          })}`,
        },
        body: { thread: fixture.threadId, text: "assistant reply" },
      }),
      [201],
    );

    expect(response.body.threadId).toBe(fixture.threadId);
    expect(response.body.createdAt).toBeDefined();
    await expect(messageRow(response.body.messageId)).resolves.toStrictEqual({
      id: response.body.messageId,
      chatThreadId: fixture.threadId,
      role: "assistant",
      content: "assistant reply",
      runId: null,
    });
    await expect(countMessagesForThread(fixture.threadId)).resolves.toBe(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${fixture.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("creates a thread for an agent and inserts the assistant message", async () => {
    const auth = await seedAuthContext();
    const team = await store.set(
      seedTeamCompose$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        composes: [{ displayName: "Agent" }],
      },
      context.signal,
    );
    teamFixtures.push(team);
    const composeId = team.composeIds[0]!;

    const client = setupApp({ context })(integrationsChatMessageContract);
    const response = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${auth.token}` },
        body: {
          agent: composeId,
          title: "Incident handoff",
          text: "Created from integration",
        },
      }),
      [201],
    );
    createdThreadIds.push(response.body.threadId);

    await expect(threadRow(response.body.threadId)).resolves.toStrictEqual({
      id: response.body.threadId,
      userId: auth.userId,
      agentComposeId: composeId,
      title: "Incident handoff",
    });
    await expect(messageRow(response.body.messageId)).resolves.toStrictEqual({
      id: response.body.messageId,
      chatThreadId: response.body.threadId,
      role: "assistant",
      content: "Created from integration",
      runId: null,
    });
  });
});
