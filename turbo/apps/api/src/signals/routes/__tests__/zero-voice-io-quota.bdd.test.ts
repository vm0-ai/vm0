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

// BDD migration of the legacy `zero-voice-io-quota.test.ts`.
// The 8 legacy `it()`s collapse into 2 BDD `it()`s: (1) 401
// unauth chain, (2) full quota matrix chain (missing metadata
// → suspended → free no usage → free partial → free at limit-1
// → free at limit → free over limit → pro tier not subject →
// team tier not subject).
//
// Service-Level Exception: `orgMetadata` and `userBehaviorCount`
// rows are seeded directly via `writeDb$` because there is no
// public route to create an org's metadata row or to record
// user behavior counts.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const AUDIO_INPUT_FREE_QUOTA = 10;

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroVoiceIoQuotaContract);
}

const track = createFixtureTracker<VoiceIoQuotaFixture>((fixture) => {
  return store.set(deleteVoiceIoQuotaOrg$, fixture, context.signal);
});

describe("BDD GET /api/zero/voice-io/quota — auth boundary", () => {
  it("rejects unauthenticated requests", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(client().get({ headers: {} }), [401]);
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("BDD GET /api/zero/voice-io/quota — full quota matrix chain", () => {
  it("gwt-wt-wt: missing org metadata → suspended → free no usage → free partial → free at limit-1 → free at limit → free over limit → pro tier not subject → team tier not subject", async () => {
    // Given: a fresh org with no metadata row + no usage
    // count. The route must default to a suspended quota.
    const missingFx = await track(
      store.set(seedVoiceIoQuotaOrg$, {}, context.signal),
    );
    mocks.clerk.session(missingFx.userId, missingFx.orgId);

    // When + Then: 200 with the suspended quota.
    const missing = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );
    expect(missing.body).toStrictEqual({
      allowed: false,
      count: 0,
      limit: 0,
    });

    // Given: a free-tier org with 0 lifetime audio input
    // usage.
    const freeEmptyFx = await track(
      store.set(seedVoiceIoQuotaOrg$, { tier: "free" }, context.signal),
    );
    mocks.clerk.session(freeEmptyFx.userId, freeEmptyFx.orgId);

    // When + Then: 200 — allowed, count=0, limit=10.
    const freeEmpty = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );
    expect(freeEmpty.body).toStrictEqual({
      allowed: true,
      count: 0,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });

    // Given: a free-tier org with 2 lifetime audio inputs.
    const freePartialFx = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { tier: "free", count: 2 },
        context.signal,
      ),
    );
    mocks.clerk.session(freePartialFx.userId, freePartialFx.orgId);

    // When + Then: 200 — allowed, count=2.
    const freePartial = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );
    expect(freePartial.body).toStrictEqual({
      allowed: true,
      count: 2,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });

    // Given: a free-tier org with one below the limit.
    const freeOneBelowFx = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { tier: "free", count: AUDIO_INPUT_FREE_QUOTA - 1 },
        context.signal,
      ),
    );
    mocks.clerk.session(freeOneBelowFx.userId, freeOneBelowFx.orgId);

    // When + Then: 200 — still allowed.
    const freeOneBelow = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );
    expect(freeOneBelow.body).toStrictEqual({
      allowed: true,
      count: AUDIO_INPUT_FREE_QUOTA - 1,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });

    // Given: a free-tier org at the limit.
    const freeAtLimitFx = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { tier: "free", count: AUDIO_INPUT_FREE_QUOTA },
        context.signal,
      ),
    );
    mocks.clerk.session(freeAtLimitFx.userId, freeAtLimitFx.orgId);

    // When + Then: 200 — blocked.
    const freeAtLimit = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );
    expect(freeAtLimit.body).toStrictEqual({
      allowed: false,
      count: AUDIO_INPUT_FREE_QUOTA,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });

    // Given: a free-tier org above the limit.
    const freeOverFx = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { tier: "free", count: AUDIO_INPUT_FREE_QUOTA + 1 },
        context.signal,
      ),
    );
    mocks.clerk.session(freeOverFx.userId, freeOverFx.orgId);

    // When + Then: 200 — blocked.
    const freeOver = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );
    expect(freeOver.body).toStrictEqual({
      allowed: false,
      count: AUDIO_INPUT_FREE_QUOTA + 1,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });

    // Given: a pro-tier org with 10 lifetime inputs. Pro
    // tier is not subject to the free quota.
    const proFx = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { tier: "pro", count: 10 },
        context.signal,
      ),
    );
    mocks.clerk.session(proFx.userId, proFx.orgId);

    // When + Then: 200 — allowed, limit=null, count=0.
    const pro = await accept(client().get({ headers: authHeaders() }), [200]);
    expect(pro.body).toStrictEqual({
      allowed: true,
      count: 0,
      limit: null,
    });

    // Given: a team-tier org at the free quota.
    const teamFx = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { tier: "team", count: AUDIO_INPUT_FREE_QUOTA },
        context.signal,
      ),
    );
    mocks.clerk.session(teamFx.userId, teamFx.orgId);

    // When + Then: 200 — allowed, limit=null, count=0.
    const team = await accept(client().get({ headers: authHeaders() }), [200]);
    expect(team.body).toStrictEqual({
      allowed: true,
      count: 0,
      limit: null,
    });
  });
});
