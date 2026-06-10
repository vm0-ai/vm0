import { randomUUID } from "node:crypto";

import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";

type ClerkOrgRole = "org:admin" | "org:member";

type SetSession = (
  userId: string,
  orgId: string | null,
  orgRole?: ClerkOrgRole,
) => void;

export interface ZeroChatThreadRouteFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

interface CreateZeroChatThreadRouteOptions {
  readonly userId?: string;
  readonly orgId?: string;
  readonly title?: string;
  readonly clientThreadId?: string;
}

export function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

export async function createZeroChatThreadThroughApi(
  context: TestContext,
  setSession: SetSession,
  options: CreateZeroChatThreadRouteOptions = {},
): Promise<ZeroChatThreadRouteFixture> {
  const userId = options.userId ?? `user_${randomUUID().slice(0, 8)}`;
  const orgId = options.orgId ?? `org_${randomUUID().slice(0, 8)}`;

  setSession(userId, orgId, "org:admin");
  context.mocks.s3.send.mockResolvedValue({});

  const agentsClient = setupApp({ context })(zeroAgentsMainContract);
  const agent = await accept(
    agentsClient.create({
      headers: authHeaders(),
      body: { displayName: "Thread Test Agent" },
    }),
    [201],
  );

  const threadsClient = setupApp({ context })(chatThreadsContract);
  const thread = await accept(
    threadsClient.create({
      headers: authHeaders(),
      body: {
        agentId: agent.body.agentId,
        ...(options.title ? { title: options.title } : {}),
        ...(options.clientThreadId
          ? { clientThreadId: options.clientThreadId }
          : {}),
      },
    }),
    [201],
  );

  context.mocks.ably.publish.mockClear();

  return {
    userId,
    orgId,
    agentId: agent.body.agentId,
    threadId: thread.body.id,
  };
}

export async function deleteZeroChatThreadThroughApi(
  context: TestContext,
  setSession: SetSession,
  fixture: ZeroChatThreadRouteFixture,
): Promise<void> {
  setSession(fixture.userId, fixture.orgId, "org:admin");

  const threadClient = setupApp({ context })(chatThreadByIdContract);
  await accept(
    threadClient.delete({
      params: { id: fixture.threadId },
      headers: authHeaders(),
    }),
    [204, 404],
  );

  const agentClient = setupApp({ context })(zeroAgentsByIdContract);
  await accept(
    agentClient.delete({
      params: { id: fixture.agentId },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

export async function listZeroChatThreadsThroughApi(context: TestContext) {
  const client = setupApp({ context })(chatThreadsContract);
  const response = await accept(
    client.list({
      query: {},
      headers: authHeaders(),
    }),
    [200],
  );
  return response.body;
}
