import { randomUUID } from "node:crypto";

import {
  bb0DeviceConfirmContract,
  deviceTokenContract,
} from "@vm0/api-contracts/contracts/device-token";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";

const store = createStore();
const context = testContext();

interface AgentFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
}

interface DeviceCodeFixture {
  readonly deviceCode: string;
  readonly pollToken: string;
}

function mockSession(userId: string, orgId: string): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId,
        orgRole: "org:admin",
      };
    },
  });
}

async function seedDefaultAgent(): Promise<AgentFixture> {
  const writeDb = store.set(writeDb$);
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const composeId = randomUUID();

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name: `agent-${composeId.slice(0, 8)}`,
  });
  await writeDb.insert(orgMetadata).values({
    orgId,
    defaultAgentId: composeId,
  });

  return { userId, orgId, composeId };
}

async function deleteAgentFixture(fixture: AgentFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
}

async function deleteDeviceCode(code: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(deviceCodes).where(eq(deviceCodes.code, code));
}

async function deleteUserRows(userId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(chatThreads).where(eq(chatThreads.userId, userId));
  await writeDb.delete(cliTokens).where(eq(cliTokens.userId, userId));
}

async function createDeviceCode(): Promise<DeviceCodeFixture> {
  const client = setupApp({ context })(deviceTokenContract);
  const response = await accept(
    client.create({
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

describe("POST /api/device-token", () => {
  const deviceCodesToDelete: string[] = [];

  afterEach(async () => {
    while (deviceCodesToDelete.length > 0) {
      const code = deviceCodesToDelete.pop();
      if (code) {
        await deleteDeviceCode(code);
      }
    }
  });

  it("creates a ten minute bb0 device code and device-only poll token", async () => {
    const client = setupApp({ context })(deviceTokenContract);
    const response = await accept(
      client.create({
        body: {
          device_type: "bb0",
        },
      }),
      [200],
    );
    deviceCodesToDelete.push(response.body.device_code);

    expect(response.body.device_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(response.body.poll_token).toHaveLength(43);
    expect(response.body.expires_in).toBe(600);
    expect(response.body.interval).toBe(3);

    const db = store.set(writeDb$);
    const [row] = await db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.code, response.body.device_code))
      .limit(1);

    expect(row).toMatchObject({
      purpose: "bb0",
      status: "pending",
      pollIntervalSeconds: 3,
    });
    expect(row?.pollTokenHash).toHaveLength(64);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(now() + 595_000);
  });
});

describe("POST /api/device-token/poll", () => {
  const deviceCodesToDelete: string[] = [];
  const agentsToDelete: AgentFixture[] = [];
  const usersToDelete: string[] = [];

  afterEach(async () => {
    while (deviceCodesToDelete.length > 0) {
      const code = deviceCodesToDelete.pop();
      if (code) {
        await deleteDeviceCode(code);
      }
    }
    while (usersToDelete.length > 0) {
      const userId = usersToDelete.pop();
      if (userId) {
        await deleteUserRows(userId);
      }
    }
    while (agentsToDelete.length > 0) {
      const fixture = agentsToDelete.pop();
      if (fixture) {
        await deleteAgentFixture(fixture);
      }
    }
  });

  async function createTrackedDeviceCode(): Promise<DeviceCodeFixture> {
    const fixture = await createDeviceCode();
    deviceCodesToDelete.push(fixture.deviceCode);
    return fixture;
  }

  it("returns pending before the user confirms the code", async () => {
    const fixture = await createTrackedDeviceCode();
    const client = setupApp({ context })(deviceTokenContract);

    const response = await accept(
      client.poll({
        body: {
          device_code: fixture.deviceCode,
          poll_token: fixture.pollToken,
        },
      }),
      [202],
    );

    expect(response.body).toStrictEqual({
      status: "pending",
      interval: 3,
    });
  });

  it("returns approved credentials after the user confirms the code", async () => {
    const agent = await seedDefaultAgent();
    agentsToDelete.push(agent);
    usersToDelete.push(agent.userId);
    mockSession(agent.userId, agent.orgId);

    const fixture = await createTrackedDeviceCode();
    const confirmClient = setupApp({ context })(bb0DeviceConfirmContract);
    const pollClient = setupApp({ context })(deviceTokenContract);

    const confirmResponse = await accept(
      confirmClient.confirm({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          device_code: fixture.deviceCode,
        },
      }),
      [200],
    );
    expect(confirmResponse.body).toStrictEqual({ status: "approved" });

    const pollResponse = await accept(
      pollClient.poll({
        body: {
          device_code: fixture.deviceCode,
          poll_token: fixture.pollToken,
        },
      }),
      [200],
    );

    expect(pollResponse.body.status).toBe("approved");
    expect(pollResponse.body.api_token).toMatch(/^vm0_pat_/);
    expect(pollResponse.body.thread_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const db = store.set(writeDb$);
    const [token] = await db
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.token, pollResponse.body.api_token))
      .limit(1);
    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, pollResponse.body.thread_id))
      .limit(1);
    const [deviceCode] = await db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.code, fixture.deviceCode))
      .limit(1);

    expect(token).toMatchObject({
      userId: agent.userId,
      name: "bb0 device",
    });
    expect(thread).toMatchObject({
      userId: agent.userId,
      agentComposeId: agent.composeId,
      title: "bb0",
    });
    expect(deviceCode).toMatchObject({
      status: "consumed",
      userId: agent.userId,
      orgId: agent.orgId,
      chatThreadId: pollResponse.body.thread_id,
    });
    expect(deviceCode?.consumedAt).toBeInstanceOf(Date);
  });

  it("returns invalid for a wrong poll token", async () => {
    const fixture = await createTrackedDeviceCode();
    const client = setupApp({ context })(deviceTokenContract);

    const response = await accept(
      client.poll({
        body: {
          device_code: fixture.deviceCode,
          poll_token: "wrong_poll_token_12345678901234567890",
        },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({ status: "invalid" });
  });

  it("returns expired after the device code expires", async () => {
    const fixture = await createTrackedDeviceCode();
    const db = store.set(writeDb$);
    await db
      .update(deviceCodes)
      .set({ expiresAt: new Date(now() - 1000) })
      .where(eq(deviceCodes.code, fixture.deviceCode));

    const client = setupApp({ context })(deviceTokenContract);
    const response = await accept(
      client.poll({
        body: {
          device_code: fixture.deviceCode,
          poll_token: fixture.pollToken,
        },
      }),
      [410],
    );

    expect(response.body).toStrictEqual({ status: "expired" });
  });
});

describe("POST /api/zero/devices/bb0/confirm", () => {
  const deviceCodesToDelete: string[] = [];
  const agentsToDelete: AgentFixture[] = [];
  const usersToDelete: string[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (deviceCodesToDelete.length > 0) {
      const code = deviceCodesToDelete.pop();
      if (code) {
        await deleteDeviceCode(code);
      }
    }
    while (usersToDelete.length > 0) {
      const userId = usersToDelete.pop();
      if (userId) {
        await deleteUserRows(userId);
      }
    }
    while (agentsToDelete.length > 0) {
      const fixture = agentsToDelete.pop();
      if (fixture) {
        await deleteAgentFixture(fixture);
      }
    }
  });

  async function createTrackedDeviceCode(): Promise<DeviceCodeFixture> {
    const fixture = await createDeviceCode();
    deviceCodesToDelete.push(fixture.deviceCode);
    return fixture;
  }

  it("requires a user session", async () => {
    const fixture = await createTrackedDeviceCode();
    const client = setupApp({ context })(bb0DeviceConfirmContract);

    const response = await accept(
      client.confirm({
        headers: {},
        body: {
          device_code: fixture.deviceCode,
        },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requires a default agent", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mockSession(userId, orgId);

    const fixture = await createTrackedDeviceCode();
    const client = setupApp({ context })(bb0DeviceConfirmContract);

    const response = await accept(
      client.confirm({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          device_code: fixture.deviceCode,
        },
      }),
      [400],
    );

    expect(response.body.error.message).toBe("No default agent configured");
  });
});
