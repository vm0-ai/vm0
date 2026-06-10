import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeysByIdContract,
  apiKeysContract,
} from "@vm0/api-contracts/contracts/api-keys";
import {
  bb0DeviceConfirmContract,
  deviceTokenContract,
} from "@vm0/api-contracts/contracts/device-token";
import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";
import { orgDefaultAgentContract } from "@vm0/api-contracts/contracts/orgs";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const DEVICE_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREATED_AT = Date.parse("2026-06-10T12:00:00.000Z");

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

interface CreatedAgent extends Actor {
  readonly agentId: string;
}

interface CreatedThread extends Actor {
  readonly threadId: string;
}

interface CreatedApiKey extends Actor {
  readonly keyId: string;
}

interface DeviceCodeFixture {
  readonly deviceCode: string;
  readonly pollToken: string;
}

function authHeaders(token = "clerk-session") {
  return { authorization: `Bearer ${token}` };
}

function deviceClient() {
  return setupApp({ context })(deviceTokenContract);
}

function confirmClient() {
  return setupApp({ context })(bb0DeviceConfirmContract);
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function defaultAgentClient() {
  return setupApp({ context })(orgDefaultAgentContract);
}

function chatThreadByIdClient() {
  return setupApp({ context })(chatThreadByIdContract);
}

function apiKeysClient() {
  return setupApp({ context })(apiKeysContract);
}

function apiKeyByIdClient() {
  return setupApp({ context })(apiKeysByIdContract);
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    userId: `user_${prefix}_${suffix}`,
    orgId: `org_${prefix}_${suffix}`,
  };
}

function setSession(actorRef: Actor): void {
  mocks.clerk.session(actorRef.userId, actorRef.orgId, "org:admin");
}

function tokenPrefix(token: string): string {
  return `${token.slice(0, 12)}\u2026`;
}

async function createDeviceCode(): Promise<DeviceCodeFixture> {
  const response = await accept(
    deviceClient().create({
      body: {
        device_type: "bb0",
      },
    }),
    [200],
  );

  return {
    deviceCode: response.body.device_code,
    pollToken: response.body.poll_token,
  };
}

async function setDefaultAgent(agent: CreatedAgent): Promise<void> {
  setSession(agent);
  const response = await accept(
    defaultAgentClient().setDefaultAgent({
      headers: authHeaders(),
      query: {},
      body: { agentId: agent.agentId },
    }),
    [200],
  );

  expect(response.body).toStrictEqual({ agentId: agent.agentId });
}

async function deleteThread(thread: CreatedThread): Promise<void> {
  setSession(thread);
  await accept(
    chatThreadByIdClient().delete({
      headers: authHeaders(),
      params: { id: thread.threadId },
    }),
    [204, 404],
  );
}

async function deleteApiKey(apiKey: CreatedApiKey): Promise<void> {
  setSession(apiKey);
  await accept(
    apiKeyByIdClient().delete({
      headers: authHeaders(),
      params: { id: apiKey.keyId },
    }),
    [204, 404],
  );
}

async function deleteAgent(agent: CreatedAgent): Promise<void> {
  setSession(agent);
  mocks.s3.listObjects([]);
  await accept(
    agentByIdClient().delete({
      headers: authHeaders(),
      params: { id: agent.agentId },
    }),
    [204, 404, 409],
  );
}

function createDeviceTokenCleanupTracker(): {
  readonly trackAgent: (agent: CreatedAgent) => CreatedAgent;
  readonly trackThread: (thread: CreatedThread) => CreatedThread;
  readonly trackApiKey: (apiKey: CreatedApiKey) => CreatedApiKey;
} {
  const trackedAgents: CreatedAgent[] = [];
  const trackedThreads: CreatedThread[] = [];
  const trackedApiKeys: CreatedApiKey[] = [];

  afterEach(async () => {
    while (trackedThreads.length > 0) {
      const thread = trackedThreads.pop();
      if (thread) {
        await deleteThread(thread);
      }
    }

    while (trackedApiKeys.length > 0) {
      const apiKey = trackedApiKeys.pop();
      if (apiKey) {
        await deleteApiKey(apiKey);
      }
    }

    while (trackedAgents.length > 0) {
      const agent = trackedAgents.pop();
      if (agent) {
        await deleteAgent(agent);
      }
    }

    clearMockNow();
  });

  return {
    trackAgent: (agent: CreatedAgent): CreatedAgent => {
      trackedAgents.push(agent);
      return agent;
    },
    trackThread: (thread: CreatedThread): CreatedThread => {
      trackedThreads.push(thread);
      return thread;
    },
    trackApiKey: (apiKey: CreatedApiKey): CreatedApiKey => {
      trackedApiKeys.push(apiKey);
      return apiKey;
    },
  };
}

const { trackAgent, trackThread, trackApiKey } =
  createDeviceTokenCleanupTracker();

async function createAgent(args: {
  readonly owner: Actor;
  readonly displayName: string;
}): Promise<CreatedAgent> {
  setSession(args.owner);
  context.mocks.s3.send.mockResolvedValue({});

  const response = await accept(
    agentsClient().create({
      headers: authHeaders(),
      body: { displayName: args.displayName },
    }),
    [201],
  );

  return trackAgent({ ...args.owner, agentId: response.body.agentId });
}

async function pollDeviceCode(fixture: DeviceCodeFixture) {
  return await deviceClient().poll({
    body: {
      device_code: fixture.deviceCode,
      poll_token: fixture.pollToken,
    },
  });
}

describe("/api/device-token BDD", () => {
  it("creates a bb0 device code and returns pending while it waits for confirmation", async () => {
    mockNow(CREATED_AT);

    const created = await accept(
      deviceClient().create({
        body: {
          device_type: "bb0",
        },
      }),
      [200],
    );

    expect(created.body.device_code).toMatch(DEVICE_CODE_PATTERN);
    expect(created.body.poll_token).toHaveLength(43);
    expect(created.body.expires_in).toBe(600);
    expect(created.body.interval).toBe(3);

    const pending = await accept(
      deviceClient().poll({
        body: {
          device_code: created.body.device_code,
          poll_token: created.body.poll_token,
        },
      }),
      [202],
    );

    expect(pending.body).toStrictEqual({
      status: "pending",
      interval: 3,
    });
  });

  it("confirms through the user session and exposes credentials and the created thread through APIs", async () => {
    const owner = actor("bb0");
    mockNow(CREATED_AT);
    const agent = await createAgent({
      owner,
      displayName: "BB0 Default Agent",
    });
    await setDefaultAgent(agent);
    const fixture = await createDeviceCode();

    setSession(owner);
    const confirmed = await accept(
      confirmClient().confirm({
        headers: authHeaders(),
        body: {
          device_code: fixture.deviceCode,
        },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({ status: "approved" });

    const firstPoll = await accept(pollDeviceCode(fixture), [200]);

    expect(firstPoll.body.status).toBe("approved");
    expect(firstPoll.body.api_token).toMatch(/^vm0_pat_/);
    expect(firstPoll.body.thread_id).toMatch(UUID_PATTERN);

    trackThread({
      ...owner,
      threadId: firstPoll.body.thread_id,
    });

    const secondPoll = await accept(pollDeviceCode(fixture), [200]);

    expect(secondPoll.body).toStrictEqual(firstPoll.body);

    setSession(owner);
    const thread = await accept(
      chatThreadByIdClient().get({
        headers: authHeaders(),
        params: { id: firstPoll.body.thread_id },
      }),
      [200],
    );

    expect(thread.body).toMatchObject({
      id: firstPoll.body.thread_id,
      title: "bb0",
      agentId: agent.agentId,
    });

    setSession(owner);
    const keys = await accept(
      apiKeysClient().list({ headers: authHeaders() }),
      [200],
    );
    const deviceKey = keys.body.apiKeys.find((apiKey) => {
      return apiKey.tokenPrefix === tokenPrefix(firstPoll.body.api_token);
    });

    if (!deviceKey) {
      throw new Error("bb0 device API key was not visible through the API");
    }

    trackApiKey({ ...owner, keyId: deviceKey.id });
    expect(deviceKey).toMatchObject({
      name: "bb0 device",
      tokenPrefix: tokenPrefix(firstPoll.body.api_token),
    });
  });

  it("requires a user session and a configured default agent before confirmation", async () => {
    const unauthenticatedCode = await createDeviceCode();

    const unauthenticated = await accept(
      confirmClient().confirm({
        headers: {},
        body: {
          device_code: unauthenticatedCode.deviceCode,
        },
      }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const owner = actor("missing_default");
    setSession(owner);
    const missingDefaultCode = await createDeviceCode();

    const missingDefault = await accept(
      confirmClient().confirm({
        headers: authHeaders(),
        body: {
          device_code: missingDefaultCode.deviceCode,
        },
      }),
      [400],
    );

    expect(missingDefault.body.error.message).toBe(
      "No default agent configured",
    );
  });

  it("returns invalid for the wrong poll token and expired after the ttl elapses", async () => {
    mockNow(CREATED_AT);
    const invalidTokenCode = await createDeviceCode();

    const invalid = await accept(
      deviceClient().poll({
        body: {
          device_code: invalidTokenCode.deviceCode,
          poll_token: "wrong_poll_token_12345678901234567890",
        },
      }),
      [404],
    );

    expect(invalid.body).toStrictEqual({ status: "invalid" });

    const expiringCode = await createDeviceCode();
    mockNow(CREATED_AT + 601_000);

    const expired = await accept(pollDeviceCode(expiringCode), [410]);

    expect(expired.body).toStrictEqual({ status: "expired" });
  });
});
