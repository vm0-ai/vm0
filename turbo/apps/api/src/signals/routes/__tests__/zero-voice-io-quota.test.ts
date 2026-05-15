import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteVoiceIoQuotaOrg$,
  seedVoiceIoQuotaOrg$,
  type VoiceIoQuotaFixture,
} from "./helpers/zero-voice-io-quota";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const AUDIO_INPUT_FREE_QUOTA = 10;

describe("GET /api/zero/voice-io/quota", () => {
  const track = createFixtureTracker<VoiceIoQuotaFixture>((fixture) => {
    return store.set(deleteVoiceIoQuotaOrg$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("defaults a missing org metadata row to the free quota", async () => {
    const fixture = await track(
      store.set(seedVoiceIoQuotaOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: true,
      count: 0,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("allows free tier users with no lifetime audio input usage", async () => {
    const fixture = await track(
      store.set(seedVoiceIoQuotaOrg$, { tier: "free" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: true,
      count: 0,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("allows free tier users with partial lifetime audio input usage", async () => {
    const fixture = await track(
      store.set(seedVoiceIoQuotaOrg$, { count: 2 }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: true,
      count: 2,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("allows free tier users one below the lifetime audio input quota", async () => {
    const fixture = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { count: AUDIO_INPUT_FREE_QUOTA - 1 },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: true,
      count: AUDIO_INPUT_FREE_QUOTA - 1,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("blocks free tier users at the lifetime audio input quota", async () => {
    const fixture = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { count: AUDIO_INPUT_FREE_QUOTA },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: false,
      count: AUDIO_INPUT_FREE_QUOTA,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("blocks free tier users above the lifetime audio input quota", async () => {
    const fixture = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { count: AUDIO_INPUT_FREE_QUOTA + 1 },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: false,
      count: AUDIO_INPUT_FREE_QUOTA + 1,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("does not apply the free quota to paid tiers", async () => {
    const fixture = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        {
          tier: "pro",
          count: 10,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

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

  it("does not apply the free quota to team tier orgs", async () => {
    const fixture = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        {
          tier: "team",
          count: AUDIO_INPUT_FREE_QUOTA,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

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
