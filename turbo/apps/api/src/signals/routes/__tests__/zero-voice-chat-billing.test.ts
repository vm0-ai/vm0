import { randomUUID } from "node:crypto";

import { zeroVoiceChatContract } from "@vm0/api-contracts/contracts/zero-voice-chat";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { voiceChatRealtimeSessions } from "@vm0/db/schema/voice-chat";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  addVoiceChatSession$,
  deleteVoiceChatFixture$,
  seedVoiceChatFixture$,
  seedVoiceChatRealtimePricing$,
  type VoiceChatFixture,
} from "./helpers/zero-voice-chat";

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);
const mocks = createZeroRouteMocks(context);

const track = createFixtureTracker<VoiceChatFixture>((fixture) => {
  return store.set(deleteVoiceChatFixture$, fixture, context.signal);
});

function client() {
  return setupApp({ context })(zeroVoiceChatContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function seedVoiceChatSession(options: {
  readonly realtimeBillingEnabled?: boolean;
  readonly credits?: number;
}): Promise<{
  readonly fixture: VoiceChatFixture;
  readonly sessionId: string;
}> {
  const fixture = await track(
    store.set(
      seedVoiceChatFixture$,
      {
        trinityEnabled: true,
        realtimeBillingEnabled: options.realtimeBillingEnabled,
        credits: options.credits,
      },
      context.signal,
    ),
  );
  const sessionId = await store.set(
    addVoiceChatSession$,
    fixture,
    { agentId: null },
    context.signal,
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return { fixture, sessionId };
}

async function usageRowsFor(fixture: VoiceChatFixture) {
  return await writeDb
    .select({
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      creditsCharged: usageEvent.creditsCharged,
      status: usageEvent.status,
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, fixture.orgId),
        eq(usageEvent.userId, fixture.userId),
      ),
    );
}

describe("POST /api/zero/voice-chat/:id/session-started", () => {
  it("returns a null audit id when realtime billing is disabled", async () => {
    const { sessionId } = await seedVoiceChatSession({});

    const response = await accept(
      client().sessionStarted({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {},
      }),
      [200],
    );
    expect(response.body.id).toBeNull();

    const rows = await writeDb
      .select({ id: voiceChatRealtimeSessions.id })
      .from(voiceChatRealtimeSessions)
      .where(eq(voiceChatRealtimeSessions.voiceChatSessionId, sessionId));
    expect(rows).toStrictEqual([]);
  });

  it("creates an active realtime session audit row when billing is enabled", async () => {
    const { fixture, sessionId } = await seedVoiceChatSession({
      realtimeBillingEnabled: true,
    });

    const response = await accept(
      client().sessionStarted({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {},
      }),
      [200],
    );
    expect(response.body.id).not.toBeNull();
    const realtimeSessionId = response.body.id;
    if (!realtimeSessionId) {
      throw new Error("expected session-started to create an audit row");
    }

    const [row] = await writeDb
      .select({
        id: voiceChatRealtimeSessions.id,
        orgId: voiceChatRealtimeSessions.orgId,
        userId: voiceChatRealtimeSessions.userId,
        provider: voiceChatRealtimeSessions.provider,
        model: voiceChatRealtimeSessions.model,
        transcriptionModel: voiceChatRealtimeSessions.transcriptionModel,
        status: voiceChatRealtimeSessions.status,
      })
      .from(voiceChatRealtimeSessions)
      .where(eq(voiceChatRealtimeSessions.id, realtimeSessionId));
    expect(row).toStrictEqual({
      id: realtimeSessionId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      provider: "openai",
      model: "gpt-realtime-2",
      transcriptionModel: "gpt-4o-mini-transcribe",
      status: "active",
    });
  });
});

describe("POST /api/zero/voice-chat/:id/usage", () => {
  it("no-ops when realtime billing is disabled", async () => {
    const { fixture, sessionId } = await seedVoiceChatSession({});

    const response = await accept(
      client().postUsageEvent({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {
          providerEventId: `event_${randomUUID()}`,
          eventType: "response.done",
          inputTextTokens: 100,
          outputAudioTokens: 100,
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ creditsExhausted: false });
    await expect(usageRowsFor(fixture)).resolves.toStrictEqual([]);
  });

  it("records idempotent realtime usage events and reports exhausted credits", async () => {
    const { fixture, sessionId } = await seedVoiceChatSession({
      realtimeBillingEnabled: true,
      credits: 2,
    });
    await store.set(seedVoiceChatRealtimePricing$, context.signal);
    const started = await accept(
      client().sessionStarted({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {},
      }),
      [200],
    );
    if (!started.body.id) {
      throw new Error("expected session-started to create an audit row");
    }

    const body = {
      providerEventId: `event_${randomUUID()}`,
      eventType: "response.done" as const,
      inputTextTokens: 100,
      outputAudioTokens: 100,
    };
    const first = await accept(
      client().postUsageEvent({
        headers: authHeaders(),
        params: { id: sessionId },
        body,
      }),
      [200],
    );
    expect(first.body.creditsExhausted).toBeTruthy();

    const second = await accept(
      client().postUsageEvent({
        headers: authHeaders(),
        params: { id: sessionId },
        body,
      }),
      [200],
    );
    expect(second.body.creditsExhausted).toBeTruthy();

    const rows = await usageRowsFor(fixture);
    expect(
      rows
        .map((row) => {
          return {
            provider: row.provider,
            category: row.category,
            quantity: row.quantity,
            creditsCharged: row.creditsCharged,
            status: row.status,
          };
        })
        .sort((left, right) => {
          return left.category.localeCompare(right.category);
        }),
    ).toStrictEqual([
      {
        provider: "gpt-realtime-2",
        category: "tokens.input.text",
        quantity: 100,
        creditsCharged: 1,
        status: "processed",
      },
      {
        provider: "gpt-realtime-2",
        category: "tokens.output.audio",
        quantity: 100,
        creditsCharged: 1,
        status: "processed",
      },
    ]);

    const [org] = await writeDb
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(org?.credits).toBe(0);

    const [audit] = await writeDb
      .select({ lastUsageAt: voiceChatRealtimeSessions.lastUsageAt })
      .from(voiceChatRealtimeSessions)
      .where(eq(voiceChatRealtimeSessions.id, started.body.id));
    expect(audit?.lastUsageAt).toBeInstanceOf(Date);
  });

  it("rejects transcription usage with output audio tokens", async () => {
    const { fixture, sessionId } = await seedVoiceChatSession({
      realtimeBillingEnabled: true,
      credits: 10,
    });
    await store.set(seedVoiceChatRealtimePricing$, context.signal);

    const response = await accept(
      client().postUsageEvent({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {
          providerEventId: `event_${randomUUID()}`,
          eventType: "transcription.completed",
          inputAudioTokens: 100,
          outputAudioTokens: 1,
        },
      }),
      [400],
    );
    expect(response.body.error.message).toBe(
      "transcription.completed cannot include outputAudioTokens",
    );
    await expect(usageRowsFor(fixture)).resolves.toStrictEqual([]);
  });
});

describe("POST /api/zero/voice-chat/:id/session-ended", () => {
  it("marks an active realtime session ended and remains idempotent", async () => {
    const { sessionId } = await seedVoiceChatSession({
      realtimeBillingEnabled: true,
    });
    const started = await accept(
      client().sessionStarted({
        headers: authHeaders(),
        params: { id: sessionId },
        body: {},
      }),
      [200],
    );
    if (!started.body.id) {
      throw new Error("expected session-started to create an audit row");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await accept(
        client().sessionEnded({
          headers: authHeaders(),
          params: { id: sessionId },
          body: { relaySessionId: started.body.id },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({ ok: true });
    }

    const [row] = await writeDb
      .select({
        status: voiceChatRealtimeSessions.status,
        endedAt: voiceChatRealtimeSessions.endedAt,
      })
      .from(voiceChatRealtimeSessions)
      .where(eq(voiceChatRealtimeSessions.id, started.body.id))
      .limit(1);
    expect(row?.status).toBe("ended");
    expect(row?.endedAt).toBeInstanceOf(Date);
  });
});
