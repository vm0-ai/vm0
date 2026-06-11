// Remnant legacy file, kept per api.bdd.md (runners.test.ts / storages.test.ts
// precedent): both cases require partial stored-connector rows that no public
// write path produces — manual-grant connect writes connector, secret, and
// companion variable atomically, and auth-method validity is checked at
// connect time — so the stored-connector 500 arms in
// agent-run-create.service.ts stay covered by these DB-seeded cases.
// Route-level run-create coverage lives in run-lifecycle.bdd.test.ts
// (RUN-01/02) and run-reads.bdd.test.ts (RUN-01 admission and resume arms).
import { randomUUID } from "node:crypto";

import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { connectors } from "@vm0/db/schema/connector";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { createStore, command } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { writeDb$ } from "../../external/db";
import { mockOptionalEnv } from "../../../lib/env";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import { encryptSecretForTests } from "./helpers/encrypt-secret";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const seedRunnableCompose$ = command(
  async (
    { set },
    args: { readonly fixture: UsageInsightFixture },
    signal: AbortSignal,
  ): Promise<{ readonly composeId: string }> => {
    const db = set(writeDb$);
    const name = `agent-${randomUUID().slice(0, 8)}`;
    const versionId = randomUUID();
    const content = {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
        },
      },
    };

    const [compose] = await db
      .insert(agentComposes)
      .values({
        userId: args.fixture.userId,
        orgId: args.fixture.orgId,
        name,
      })
      .returning({ id: agentComposes.id });
    signal.throwIfAborted();
    if (!compose) {
      throw new Error("compose insert returned no row");
    }

    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: compose.id,
      content,
      createdBy: args.fixture.userId,
    });
    signal.throwIfAborted();
    await db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, compose.id));
    signal.throwIfAborted();

    return { composeId: compose.id };
  },
);

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

async function fixture(): Promise<UsageInsightFixture> {
  const created = await track(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  mocks.clerk.session(created.userId, created.orgId);
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  return created;
}

describe("POST /api/agent/runs", () => {
  it("returns 500 when stored connector-owned state is incomplete", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    await db.insert(connectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      type: "zendesk",
      authMethod: "api-token",
    });
    await db.insert(secretsTable).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "ZENDESK_API_TOKEN",
      encryptedValue: encryptSecretForTests("connector-zendesk-token"),
      type: "connector",
    });
    await db.insert(variables).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "ZENDESK_SUBDOMAIN",
      value: "connector-subdomain",
      type: "connector",
    });
    const compose = await store.set(
      seedRunnableCompose$,
      { fixture: fx },
      context.signal,
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/agent/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentComposeId: compose.composeId,
        prompt: "Use stored zendesk",
      }),
    });

    expect(response.status).toBe(500);
  });

  it("returns 500 when a stored connector has an invalid auth method", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    await db.insert(connectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      type: "github",
      authMethod: "missing-method",
    });
    const compose = await store.set(
      seedRunnableCompose$,
      { fixture: fx },
      context.signal,
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/agent/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentComposeId: compose.composeId,
        prompt: "Use stored github",
      }),
    });

    expect(response.status).toBe(500);
  });
});
