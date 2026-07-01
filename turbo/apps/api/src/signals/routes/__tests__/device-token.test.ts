import { randomUUID } from "node:crypto";

import {
  bb0DeviceConfirmContract,
  deviceTokenContract,
} from "@vm0/api-contracts/contracts/device-token";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";

const context = testContext();
const bdd = createBddApi(context);

interface DeviceCodeFixture {
  readonly deviceCode: string;
  readonly pollToken: string;
}

afterEach(() => {
  clearMockNow();
});

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

    expect(response.body.device_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(response.body.poll_token).toHaveLength(43);
    expect(response.body.expires_in).toBe(600);
    expect(response.body.interval).toBe(3);

    const poll = await accept(
      client.poll({
        body: {
          device_code: response.body.device_code,
          poll_token: response.body.poll_token,
        },
      }),
      [202],
    );
    expect(poll.body).toStrictEqual({
      status: "pending",
      interval: response.body.interval,
    });
  });
});

describe("POST /api/device-token/poll", () => {
  it("returns pending before the user confirms the code", async () => {
    const fixture = await createDeviceCode();
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
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "bb0 device agent",
    });
    await bdd.setDefaultAgent(actor, agent.agentId);

    const fixture = await createDeviceCode();
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

    const replayResponse = await accept(
      pollClient.poll({
        body: {
          device_code: fixture.deviceCode,
          poll_token: fixture.pollToken,
        },
      }),
      [200],
    );
    expect(replayResponse.body).toStrictEqual(pollResponse.body);
  });

  it("returns invalid for a wrong poll token", async () => {
    const fixture = await createDeviceCode();
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
    const issuedAt = now();
    mockNow(issuedAt);
    const fixture = await createDeviceCode();
    mockNow(issuedAt + 601_000);

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
  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  it("requires a user session", async () => {
    const fixture = await createDeviceCode();
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

    const fixture = await createDeviceCode();
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
