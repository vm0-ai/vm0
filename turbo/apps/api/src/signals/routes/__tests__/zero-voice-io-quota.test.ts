import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { zeroVoiceIoQuotaRoutes } from "../zero-voice-io-quota";
import {
  deleteVoiceIoQuotaOrg,
  seedVoiceIoQuotaOrg,
  type VoiceIoQuotaFixture,
} from "./helpers/zero-voice-io-quota";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/voice-io/quota", () => {
  const track = createFixtureTracker<VoiceIoQuotaFixture>((fixture) => {
    return deleteVoiceIoQuotaOrg(store, fixture);
  });

  it("defaults a missing org metadata row to the free quota", async () => {
    const fixture = await track(seedVoiceIoQuotaOrg(store));
    mocks.clerk.session(fixture.userId, fixture.orgId);

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
    mocks.clerk.session(fixture.userId, fixture.orgId);

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
    mocks.clerk.session(fixture.userId, fixture.orgId);

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
});
