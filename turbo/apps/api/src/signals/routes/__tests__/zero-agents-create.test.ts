import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroScheduleRunContract,
  zeroSchedulesEnableContract,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  deleteOrgModelProviders$,
  type OrgModelProviderFixture,
} from "./helpers/zero-model-providers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteSkillsForFixture$,
  seedSkillsFixture$,
  type SkillsFixture,
} from "./helpers/zero-skills";

// The agent CRUD/validation/limit/permission cases have migrated to
// `agent-lifecycle.bdd.test.ts` (API-first BDD). This file retains the one
// remaining case that exercises the create→schedule→run path end-to-end, which
// covers run storage/dispatch source not yet reachable through the BDD harness
// (tracked as the SCHEDULE/RUN family migration in `api.bdd.md`).
const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ORG_SENTINEL_USER_ID = "__org__";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function schedulesClient() {
  return setupApp({ context })(zeroSchedulesMainContract);
}

function scheduleEnableClient() {
  return setupApp({ context })(zeroSchedulesEnableContract);
}

function scheduleRunClient() {
  return setupApp({ context })(zeroScheduleRunContract);
}

async function seedDefaultAnthropicProvider(
  orgId: string,
): Promise<OrgModelProviderFixture> {
  const db = store.set(writeDb$);
  const [secret] = await db
    .insert(secrets)
    .values({
      name: "ANTHROPIC_API_KEY",
      encryptedValue: encryptSecretForTests("test-secret-value"),
      type: "model-provider",
      userId: ORG_SENTINEL_USER_ID,
      orgId,
    })
    .returning({ id: secrets.id });

  if (!secret) {
    throw new Error("Expected model provider secret");
  }

  await db.insert(modelProviders).values({
    type: "anthropic-api-key",
    secretId: secret.id,
    isDefault: true,
    userId: ORG_SENTINEL_USER_ID,
    orgId,
  });

  return { orgId };
}

describe("POST /api/zero/agents", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });
  const trackModelProvider = createFixtureTracker<OrgModelProviderFixture>(
    (fixture) => {
      return store.set(deleteOrgModelProviders$, fixture, context.signal);
    },
  );

  it("executes a schedule for an agent created via POST /api/zero/agents", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    await trackModelProvider(seedDefaultAnthropicProvider(fixture.orgId));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Schedule Bug Agent" },
      }),
      [201],
    );

    const deployed = await accept(
      schedulesClient().deploy({
        headers: authHeaders(),
        body: {
          agentId: created.body.agentId,
          name: "zero-api-run",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Scheduled run",
        },
      }),
      [201],
    );

    const enabled = await accept(
      scheduleEnableClient().enable({
        params: { name: "zero-api-run" },
        headers: authHeaders(),
        body: { agentId: created.body.agentId },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();

    const run = await accept(
      scheduleRunClient().run({
        headers: authHeaders(),
        body: { scheduleId: deployed.body.schedule.id },
      }),
      [201],
    );
    expect(run.body.runId).toStrictEqual(expect.any(String));
  });
});
