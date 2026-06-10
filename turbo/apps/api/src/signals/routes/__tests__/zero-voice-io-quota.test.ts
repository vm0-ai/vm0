import { randomUUID } from "node:crypto";

import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { HttpResponse, http } from "msw";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  deleteVoiceIoQuotaOrg$,
  seedVoiceIoQuotaOrg$,
  type VoiceIoQuotaFixture,
} from "./helpers/zero-voice-io-quota";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { OPENAI_AUDIO_TRANSCRIPTIONS_URL } from "../../services/zero-voice-io-post.service";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const AUDIO_INPUT_FREE_QUOTA = 10;

interface FreeVoiceOrgFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

function webmWithDurationSeconds(durationSeconds: number): ArrayBuffer {
  // Minimal WebM metadata: EBML header -> Segment -> Info -> Duration.
  const buffer = new ArrayBuffer(22);
  const bytes = new Uint8Array(buffer);
  bytes.set([
    0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x8c, 0x15, 0x49,
    0xa9, 0x66, 0x87, 0x44, 0x89, 0x84, 0x00, 0x00, 0x00, 0x00,
  ]);
  new DataView(buffer).setFloat32(18, durationSeconds * 1000, false);
  return buffer;
}

function sttFile(): File {
  return new File([webmWithDurationSeconds(5)], "speech.webm", {
    type: "audio/webm",
  });
}

function sttForm(): FormData {
  const form = new FormData();
  form.append("file", sttFile());
  return form;
}

function mockClerkTestUser(fixture: FreeVoiceOrgFixture): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: fixture.userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        createdAt: 2,
        organization: { id: `org_ignored_${randomUUID()}` },
      },
      {
        createdAt: 1,
        organization: { id: fixture.orgId },
      },
    ],
  });
}

async function seedFreeStarterOrgThroughApi(): Promise<FreeVoiceOrgFixture> {
  mockEnv("ENV", "development");
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mockClerkTestUser(fixture);

  const response = await requestApp("/api/test/telegram-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: `bot_${randomUUID()}`,
      telegram_user_id: `telegram_${randomUUID()}`,
      email: `${randomUUID()}@example.test`,
      seed_link: false,
    }),
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly org_id: string;
    readonly vm0_user_id: string;
  };
  expect(body.org_id).toBe(fixture.orgId);
  expect(body.vm0_user_id).toBe(fixture.userId);

  return fixture;
}

function postStt(): Promise<Response> {
  return requestApp("/api/zero/voice-io/stt", {
    method: "POST",
    headers: authHeaders(),
    body: sttForm(),
  });
}

describe("GET /api/zero/voice-io/quota", () => {
  const track = createFixtureTracker<VoiceIoQuotaFixture>((fixture) => {
    return store.set(deleteVoiceIoQuotaOrg$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("defaults a missing org metadata row to a suspended quota", async () => {
    const fixture = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    };
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: false,
      count: 0,
      limit: 0,
    });
  });

  it("keeps legacy coverage for missing org metadata fixture setup", async () => {
    const fixture = await track(
      store.set(seedVoiceIoQuotaOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: false,
      count: 0,
      limit: 0,
    });
  });

  it("tracks free-tier lifetime audio input quota through the voice APIs", async () => {
    const fixture = await seedFreeStarterOrgThroughApi();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);
    const quota = () => {
      return accept(client.get({ headers: authHeaders() }), [200]);
    };

    await expect(quota()).resolves.toMatchObject({
      body: {
        allowed: true,
        count: 0,
        limit: AUDIO_INPUT_FREE_QUOTA,
      },
    });

    let transcriptionCalls = 0;
    server.use(
      http.post(OPENAI_AUDIO_TRANSCRIPTIONS_URL, () => {
        transcriptionCalls++;
        return HttpResponse.json({ text: "free transcript" });
      }),
    );

    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await postStt();
      expect(response.status).toBe(200);
    }

    await expect(quota()).resolves.toMatchObject({
      body: {
        allowed: true,
        count: 2,
        limit: AUDIO_INPUT_FREE_QUOTA,
      },
    });

    for (let attempt = 3; attempt < AUDIO_INPUT_FREE_QUOTA; attempt++) {
      const response = await postStt();
      expect(response.status).toBe(200);
    }

    await expect(quota()).resolves.toMatchObject({
      body: {
        allowed: true,
        count: AUDIO_INPUT_FREE_QUOTA - 1,
        limit: AUDIO_INPUT_FREE_QUOTA,
      },
    });

    const finalAllowedResponse = await postStt();
    expect(finalAllowedResponse.status).toBe(200);

    await expect(quota()).resolves.toMatchObject({
      body: {
        allowed: false,
        count: AUDIO_INPUT_FREE_QUOTA,
        limit: AUDIO_INPUT_FREE_QUOTA,
      },
    });

    const blockedResponse = await postStt();
    expect(blockedResponse.status).toBe(402);
    await expect(blockedResponse.json()).resolves.toStrictEqual({
      error: {
        message:
          "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
        code: "AUDIO_INPUT_QUOTA_EXCEEDED",
      },
      quota: { count: AUDIO_INPUT_FREE_QUOTA, limit: AUDIO_INPUT_FREE_QUOTA },
    });
    expect(transcriptionCalls).toBe(AUDIO_INPUT_FREE_QUOTA);

    await expect(quota()).resolves.toMatchObject({
      body: {
        allowed: false,
        count: AUDIO_INPUT_FREE_QUOTA,
        limit: AUDIO_INPUT_FREE_QUOTA,
      },
    });
  });

  it("keeps legacy coverage for free tier users with no lifetime audio input usage", async () => {
    const fixture = await track(
      store.set(seedVoiceIoQuotaOrg$, { tier: "free" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      allowed: true,
      count: 0,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("blocks free tier users above the lifetime audio input quota", async () => {
    const fixture = await track(
      store.set(
        seedVoiceIoQuotaOrg$,
        { tier: "free", count: AUDIO_INPUT_FREE_QUOTA + 1 },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceIoQuotaContract);

    const response = await accept(
      client.get({
        headers: authHeaders(),
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
        headers: authHeaders(),
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
        headers: authHeaders(),
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
