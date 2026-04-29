import { randomUUID } from "node:crypto";

import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { zeroVoiceIoQuotaRoutes } from "../zero-voice-io-quota";
import {
  deleteVoiceIoQuotaOrg,
  seedVoiceIoQuotaOrg,
  type VoiceIoQuotaFixture,
} from "./helpers/zero-voice-io-quota";

const context = testContext();
const store = createStore();

function mockSession(userId: string, orgId: string | null): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId,
        orgRole: orgId ? "org:admin" : undefined,
      };
    },
  });
}

describe("GET /api/zero/voice-io/quota", () => {
  const fixtures: VoiceIoQuotaFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteVoiceIoQuotaOrg(store, fixture);
      }
    }
  });

  async function track(
    fixturePromise: Promise<VoiceIoQuotaFixture>,
  ): Promise<VoiceIoQuotaFixture> {
    const fixture = await fixturePromise;
    fixtures.push(fixture);
    return fixture;
  }

  it("defaults a missing org metadata row to the free quota", async () => {
    const fixture = await track(seedVoiceIoQuotaOrg(store));
    mockSession(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: zeroVoiceIoQuotaRoutes("api"),
    })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: true,
      count: 0,
      limit: 10,
    });
  });

  it("blocks free tier users at the lifetime audio input quota", async () => {
    const fixture = await track(seedVoiceIoQuotaOrg(store, { count: 10 }));
    mockSession(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: zeroVoiceIoQuotaRoutes("api"),
    })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: false,
      count: 10,
      limit: 10,
    });
  });

  it("does not apply the free quota to paid tiers", async () => {
    const fixture = await track(
      seedVoiceIoQuotaOrg(store, {
        tier: "pro",
        count: 10,
      }),
    );
    mockSession(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: zeroVoiceIoQuotaRoutes("api"),
    })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: true,
      count: 0,
      limit: null,
    });
  });

  it("requires authentication", async () => {
    const client = setupApp({
      context,
      routes: zeroVoiceIoQuotaRoutes("api"),
    })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requires organization context", async () => {
    mockSession(`user_${randomUUID()}`, null);
    const client = setupApp({
      context,
      routes: zeroVoiceIoQuotaRoutes("api"),
    })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
