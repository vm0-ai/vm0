import { randomUUID } from "node:crypto";

import { zeroScheduleMigrateChatContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { delay } from "signal-timers";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  type SchedulesFixture,
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
} from "./helpers/zero-schedules";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolveDeferred: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  if (!resolveDeferred) {
    throw new Error("Failed to create deferred promise");
  }
  return { promise, resolve: resolveDeferred };
}

async function enableChatMode(fixture: SchedulesFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.ScheduledChat]: true },
  });
}

describe("POST /api/zero/schedules/:name/migrate-to-chat", () => {
  const track = createFixtureTracker<SchedulesFixture>((fixture) => {
    return store.set(deleteSchedulesScenario$, fixture, context.signal);
  });

  const client = () => {
    return setupApp({ context })(zeroScheduleMigrateChatContract);
  };

  const seedLegacy = async (name: string): Promise<SchedulesFixture> => {
    return await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            { name, cronExpression: "0 9 * * *", prompt: "Legacy task" },
          ],
        },
        context.signal,
      ),
    );
  };

  it("creates and links a chat thread for a legacy schedule", async () => {
    const fixture = await seedLegacy("legacy-one");
    await enableChatMode(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().migrateToChat({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "legacy-one" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );

    expect(response.body.chatThreadId).not.toBeNull();

    const db = store.set(writeDb$);
    const [thread] = await db
      .select({ id: chatThreads.id, userId: chatThreads.userId })
      .from(chatThreads)
      .where(eq(chatThreads.id, response.body.chatThreadId ?? ""))
      .limit(1);
    expect(thread).toBeDefined();
    expect(thread?.userId).toBe(fixture.userId);
  });

  it("is idempotent: an already-linked schedule keeps its thread", async () => {
    const fixture = await seedLegacy("legacy-idem");
    await enableChatMode(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const first = await accept(
      client().migrateToChat({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "legacy-idem" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );
    const second = await accept(
      client().migrateToChat({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "legacy-idem" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );

    expect(first.body.chatThreadId).not.toBeNull();
    expect(second.body.chatThreadId).toBe(first.body.chatThreadId);
  });

  it("keeps concurrent migrations linked to one chat thread", async () => {
    const fixture = await seedLegacy("legacy-race");
    await enableChatMode(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const scheduleId = fixture.scheduleIds[0];
    if (!scheduleId) {
      throw new Error("Expected seeded schedule");
    }

    const db = store.set(writeDb$);
    const lockReady = deferred();
    const releaseLock = deferred();
    const lock = db.transaction(async (tx) => {
      await tx
        .select({ id: zeroAgentSchedules.id })
        .from(zeroAgentSchedules)
        .where(eq(zeroAgentSchedules.id, scheduleId))
        .for("update");
      lockReady.resolve();
      await releaseLock.promise;
    });
    await lockReady.promise;

    const migrate = () => {
      return accept(
        client().migrateToChat({
          headers: { authorization: "Bearer clerk-session" },
          params: { name: "legacy-race" },
          body: { agentId: fixture.composeId },
        }),
        [200],
      );
    };

    const requests = Promise.all([migrate(), migrate()]);
    await delay(100, { signal: context.signal });
    releaseLock.resolve();
    await lock;

    const [first, second] = await requests;
    expect(first.body.chatThreadId).not.toBeNull();
    expect(second.body.chatThreadId).toBe(first.body.chatThreadId);

    const threads = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.agentComposeId, fixture.composeId));
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(first.body.chatThreadId);
  });

  it("returns 400 when chat mode is not enabled", async () => {
    const fixture = await seedLegacy("legacy-no-switch");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().migrateToChat({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "legacy-no-switch" },
        body: { agentId: fixture.composeId },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 for a non-existent schedule", async () => {
    const fixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    await enableChatMode(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().migrateToChat({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "missing" },
        body: { agentId: fixture.composeId },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 for an unauthenticated request", async () => {
    const response = await accept(
      client().migrateToChat({
        headers: {},
        params: { name: "any" },
        body: { agentId: randomUUID() },
      }),
      [401],
    );
    expect(response.status).toBe(401);
  });
});
