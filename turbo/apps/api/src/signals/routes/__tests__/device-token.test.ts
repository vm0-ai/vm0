import { randomUUID } from "node:crypto";

import {
  bb0DeviceBindContract,
  deviceTokenContract,
} from "@vm0/api-contracts/contracts/device-token";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

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

  it("creates a five minute bb0 device code tied to a BLE session nonce", async () => {
    const client = setupApp({ context })(deviceTokenContract);
    const response = await accept(
      client.create({
        body: {
          device_type: "bb0",
          ble_session_nonce: "nonce_1234567890abcdef",
        },
      }),
      [200],
    );
    deviceCodesToDelete.push(response.body.device_code);

    expect(response.body.device_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(response.body.expires_in).toBe(300);

    const db = store.set(writeDb$);
    const [row] = await db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.code, response.body.device_code))
      .limit(1);

    expect(row).toMatchObject({
      purpose: "bb0",
      status: "pending",
      bleSessionNonce: "nonce_1234567890abcdef",
    });
    expect(row?.expiresAt.getTime()).toBeGreaterThan(now() + 295_000);
  });
});

describe("POST /api/zero/devices/bb0/bind", () => {
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

  async function createCode(bleSessionNonce: string): Promise<string> {
    const client = setupApp({ context })(deviceTokenContract);
    const response = await accept(
      client.create({
        body: {
          device_type: "bb0",
          ble_session_nonce: bleSessionNonce,
        },
      }),
      [200],
    );
    deviceCodesToDelete.push(response.body.device_code);
    return response.body.device_code;
  }

  it("requires a user session", async () => {
    const code = await createCode("nonce_1234567890abcdef");
    const client = setupApp({ context })(bb0DeviceBindContract);

    const response = await accept(
      client.bind({
        headers: {},
        body: {
          device_code: code,
          ble_session_nonce: "nonce_1234567890abcdef",
        },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("consumes the code, creates a PAT, and creates a chat thread", async () => {
    const agent = await seedDefaultAgent();
    agentsToDelete.push(agent);
    usersToDelete.push(agent.userId);
    mockSession(agent.userId, agent.orgId);

    const code = await createCode("nonce_1234567890abcdef");
    const client = setupApp({ context })(bb0DeviceBindContract);

    const response = await accept(
      client.bind({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          device_code: code,
          ble_session_nonce: "nonce_1234567890abcdef",
        },
      }),
      [200],
    );

    expect(response.body.api_token).toMatch(/^vm0_pat_/);
    expect(response.body.thread_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const db = store.set(writeDb$);
    const [token] = await db
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.token, response.body.api_token))
      .limit(1);
    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, response.body.thread_id))
      .limit(1);
    const [remainingCode] = await db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.code, code))
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
    expect(remainingCode).toBeUndefined();
  });

  it("rejects a BLE nonce mismatch without consuming the code", async () => {
    const agent = await seedDefaultAgent();
    agentsToDelete.push(agent);
    usersToDelete.push(agent.userId);
    mockSession(agent.userId, agent.orgId);

    const code = await createCode("nonce_1234567890abcdef");
    const client = setupApp({ context })(bb0DeviceBindContract);

    const response = await accept(
      client.bind({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          device_code: code,
          ble_session_nonce: "nonce_mismatch_123456",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");

    const db = store.set(writeDb$);
    const [remainingCode] = await db
      .select()
      .from(deviceCodes)
      .where(and(eq(deviceCodes.code, code), eq(deviceCodes.purpose, "bb0")))
      .limit(1);
    expect(remainingCode).toBeDefined();
  });
});
