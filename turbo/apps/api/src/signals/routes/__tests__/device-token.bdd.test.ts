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

// BDD migration of the legacy `device-token.test.ts`. The
// 5 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// device-token create chain (200 creates a 10-minute bb0
// device code with the expected response shape + DB row
// written), (2) device-token poll chain (202 returns
// pending before confirm → 200 returns approved
// credentials after confirm with DB rows for cliTokens +
// chatThreads + deviceCodes updated → 404 returns invalid
// for a wrong poll token → 410 returns expired after
// device code expires), (3) bb0 confirm chain (401
// requires a user session → 400 requires a default agent).

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

function createDeviceTokenHarness(): {
  readonly deviceCodesToDelete: string[];
  readonly agentsToDelete: AgentFixture[];
  readonly usersToDelete: string[];
} {
  return {
    deviceCodesToDelete: [],
    agentsToDelete: [],
    usersToDelete: [],
  };
}

async function cleanupHarness(
  harness: ReturnType<typeof createDeviceTokenHarness>,
): Promise<void> {
  while (harness.deviceCodesToDelete.length > 0) {
    const code = harness.deviceCodesToDelete.pop();
    if (code) {
      await deleteDeviceCode(code);
    }
  }
  while (harness.usersToDelete.length > 0) {
    const userId = harness.usersToDelete.pop();
    if (userId) {
      await deleteUserRows(userId);
    }
  }
  while (harness.agentsToDelete.length > 0) {
    const fixture = harness.agentsToDelete.pop();
    if (fixture) {
      await deleteAgentFixture(fixture);
    }
  }
}

async function createTrackedDeviceCode(
  harness: ReturnType<typeof createDeviceTokenHarness>,
): Promise<DeviceCodeFixture> {
  const fixture = await createDeviceCode();
  harness.deviceCodesToDelete.push(fixture.deviceCode);
  return fixture;
}

describe("BDD POST /api/device-token — create chain", () => {
  const harness = createDeviceTokenHarness();

  afterEach(async () => {
    await cleanupHarness(harness);
  });

  it("gwt-wt-wt: 200 creates a 10-minute bb0 device code with the expected response shape + DB row written", async () => {
    // Given: no auth required to create a device code.

    // When + Then: 200 — the response carries the
    // expected code shape + 10-minute expiry + 3s poll
    // interval.
    const client = setupApp({ context })(deviceTokenContract);
    const response = await accept(
      client.create({
        body: { device_type: "bb0" },
      }),
      [200],
    );
    harness.deviceCodesToDelete.push(response.body.device_code);

    expect(response.body.device_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(response.body.poll_token).toHaveLength(43);
    expect(response.body.expires_in).toBe(600);
    expect(response.body.interval).toBe(3);

    // Then: the DB row is written with purpose=bb0 +
    // status=pending + 3s poll interval + expiresAt is
    // ~10 minutes from now.
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

describe("BDD POST /api/device-token/poll — poll chain", () => {
  const harness = createDeviceTokenHarness();

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    await cleanupHarness(harness);
  });

  it("gwt-wt-wt: 202 returns pending before confirm → 200 returns approved credentials after confirm with DB rows for cliTokens + chatThreads + deviceCodes updated → 404 returns invalid for a wrong poll token → 410 returns expired after device code expires", async () => {
    // Given: a fresh device code.

    // When + Then: 202 — pending with a 3s interval.
    const fixture = await createTrackedDeviceCode(harness);
    const client = setupApp({ context })(deviceTokenContract);

    const pendingResponse = await accept(
      client.poll({
        body: {
          device_code: fixture.deviceCode,
          poll_token: fixture.pollToken,
        },
      }),
      [202],
    );
    expect(pendingResponse.body).toStrictEqual({
      status: "pending",
      interval: 3,
    });

    // Given: a session for a user with a default agent
    // + the same device code.
    const agent = await seedDefaultAgent();
    harness.agentsToDelete.push(agent);
    harness.usersToDelete.push(agent.userId);
    mockSession(agent.userId, agent.orgId);

    // When + Then: 200 — confirm returns approved + poll
    // returns the credentials + DB rows are written.
    const confirmClient = setupApp({ context })(bb0DeviceConfirmContract);
    const confirmResponse = await accept(
      confirmClient.confirm({
        headers: { authorization: "Bearer clerk-session" },
        body: { device_code: fixture.deviceCode },
      }),
      [200],
    );
    expect(confirmResponse.body).toStrictEqual({ status: "approved" });

    const pollResponse = await accept(
      client.poll({
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

    // Given: a fresh device code + a wrong poll token.

    // When + Then: 404 — invalid.
    const wrongFixture = await createTrackedDeviceCode(harness);
    const wrongResponse = await accept(
      client.poll({
        body: {
          device_code: wrongFixture.deviceCode,
          poll_token: "wrong_poll_token_12345678901234567890",
        },
      }),
      [404],
    );
    expect(wrongResponse.body).toStrictEqual({ status: "invalid" });

    // Given: a fresh device code whose `expiresAt` is
    // in the past.

    // When + Then: 410 — expired.
    const expiredFixture = await createTrackedDeviceCode(harness);
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(deviceCodes)
      .set({ expiresAt: new Date(now() - 1000) })
      .where(eq(deviceCodes.code, expiredFixture.deviceCode));

    const expiredResponse = await accept(
      client.poll({
        body: {
          device_code: expiredFixture.deviceCode,
          poll_token: expiredFixture.pollToken,
        },
      }),
      [410],
    );
    expect(expiredResponse.body).toStrictEqual({ status: "expired" });
  });
});

describe("BDD POST /api/zero/devices/bb0/confirm — confirm chain", () => {
  const harness = createDeviceTokenHarness();

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    await cleanupHarness(harness);
  });

  it("gwt-wt-wt: 401 requires a user session → 400 requires a default agent", async () => {
    // Given: no authenticated session.

    // When + Then: 401 — unauthorized.
    const fixture = await createTrackedDeviceCode(harness);
    const client = setupApp({ context })(bb0DeviceConfirmContract);

    const noAuthResponse = await accept(
      client.confirm({
        headers: {},
        body: { device_code: fixture.deviceCode },
      }),
      [401],
    );
    expect(noAuthResponse.body.error.code).toBe("UNAUTHORIZED");

    // Given: a session for a user with no default agent.

    // When + Then: 400 — "No default agent configured".
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mockSession(userId, orgId);

    const noAgentFixture = await createTrackedDeviceCode(harness);
    const noAgentResponse = await accept(
      client.confirm({
        headers: { authorization: "Bearer clerk-session" },
        body: { device_code: noAgentFixture.deviceCode },
      }),
      [400],
    );
    expect(noAgentResponse.body.error.message).toBe(
      "No default agent configured",
    );
  });
});
