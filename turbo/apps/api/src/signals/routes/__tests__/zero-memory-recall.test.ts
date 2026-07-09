import { randomUUID } from "node:crypto";

import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  deleteRelationshipRowsForFixture$,
  seedGraphExpansionMemories$,
  seedRelationshipRows$,
  seedRuntimeInjectionMemoryRows$,
  seedSemanticRecallMemory$,
  type RelationshipFixture,
} from "./helpers/zero-relationships";
import { mockOptionalEnv } from "../../../lib/env";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function memoryClient() {
  return setupApp({ context })(zeroMemoryContract);
}

afterEach(() => {
  mockOptionalEnv("ZERO_MEMORY_EMBEDDING_PROVIDER", undefined);
});

interface RelationshipFixtureOptions {
  readonly relationshipMemoryEnabled?: boolean;
  readonly runtimeInjectionEnabled?: boolean;
}

function normalizeRelationshipFixtureOptions(
  options: boolean | RelationshipFixtureOptions,
): Required<RelationshipFixtureOptions> {
  if (typeof options === "boolean") {
    return {
      relationshipMemoryEnabled: options,
      runtimeInjectionEnabled: false,
    };
  }
  return {
    relationshipMemoryEnabled: options.relationshipMemoryEnabled ?? true,
    runtimeInjectionEnabled: options.runtimeInjectionEnabled ?? false,
  };
}

async function seedRelationshipFixture(
  options: boolean | RelationshipFixtureOptions = true,
): Promise<RelationshipFixture> {
  const normalized = normalizeRelationshipFixtureOptions(options);
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    {
      [FeatureSwitchKey.RelationshipMemory]:
        normalized.relationshipMemoryEnabled,
      [FeatureSwitchKey.RelationshipMemoryRuntimeInjection]:
        normalized.runtimeInjectionEnabled,
    },
  );
  mocks.clerk.session(userId, orgId);
  return { orgId, userId };
}

async function deleteRelationshipFixture(
  fixture: RelationshipFixture,
): Promise<void> {
  await store.set(deleteRelationshipRowsForFixture$, fixture, context.signal);
  await deleteFeatureSwitchesForUser(context, fixture);
}

describe("GET /api/zero/memory/recall", () => {
  const track = createFixtureTracker(deleteRelationshipFixture);

  it("rejects recall when relationship memory is disabled", async () => {
    await track(seedRelationshipFixture(false));

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: "relationship" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Relationship memory is not enabled for this organization.",
    );
  });

  it("recalls matching structured relationship memory", async () => {
    const fixture = await track(seedRelationshipFixture());
    await store.set(
      seedRelationshipRows$,
      { fixture, count: 3 },
      context.signal,
    );

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: "relationship 1", limit: 5 },
      }),
      [200],
    );

    expect(response.body.query).toBe("relationship 1");
    expect(response.body.memories).toHaveLength(1);
    expect(response.body.memories[0]).toMatchObject({
      kind: "open_loop",
      text: "Follow up with relationship 1",
      confidence: 90,
      relationship: {
        entity: {
          displayName: "Relationship 001",
          type: "person",
        },
        relationshipType: "Customer contact",
      },
      sources: [],
    });
  });

  it("recalls semantic memory without lexical overlap", async () => {
    const fixture = await track(seedRelationshipFixture());
    const query = "cash management sweep fund";
    await store.set(
      seedSemanticRecallMemory$,
      { fixture, query },
      context.signal,
    );
    mockOptionalEnv("ZERO_MEMORY_EMBEDDING_PROVIDER", "test");

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: query, limit: 5 },
      }),
      [200],
    );

    expect(response.body.memories).toHaveLength(1);
    expect(response.body.memories[0]).toMatchObject({
      kind: "preference",
      text: "The user prefers JPM IJTXX Treasury allocation.",
      relationship: {
        entity: {
          displayName: "Portfolio Settings",
          type: "organization",
        },
      },
    });
  });

  it("expands semantic recall through related graph memories", async () => {
    const fixture = await track(seedRelationshipFixture());
    const query = "platform refactor nickname";
    await store.set(
      seedGraphExpansionMemories$,
      { fixture, query },
      context.signal,
    );
    mockOptionalEnv("ZERO_MEMORY_EMBEDDING_PROVIDER", "test");

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: query, limit: 2 },
      }),
      [200],
    );

    expect(
      response.body.memories.map((memory) => {
        return memory.text;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "The infrastructure rewrite uses Lucent as its internal migration name.",
        "Ask Lancy for the Lucent migration rollout owner.",
      ]),
    );
  });

  it("returns prompt-ready memory context", async () => {
    const fixture = await track(seedRelationshipFixture());
    await store.set(
      seedRelationshipRows$,
      { fixture, count: 1 },
      context.signal,
    );

    const response = await accept(
      memoryClient().context({
        headers: authHeaders(),
        query: { limit: 5 },
      }),
      [200],
    );

    expect(response.body.query).toBeNull();
    expect(response.body.context).toContain("Structured memory:");
    expect(response.body.context).toContain("Open loops:");
    expect(response.body.context).toContain(
      "Follow up with relationship 1 (Relationship 001)",
    );
    expect(response.body.memories).toHaveLength(1);
  });

  it("rejects injection preview when runtime injection is disabled", async () => {
    await track(
      seedRelationshipFixture({
        relationshipMemoryEnabled: true,
        runtimeInjectionEnabled: false,
      }),
    );

    const response = await accept(
      memoryClient().injectionPreview({
        headers: authHeaders(),
        body: { prompt: "Prepare the security review" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Relationship memory runtime injection is not enabled for this organization.",
    );
  });

  it("previews runtime memory system prompt injection", async () => {
    const fixture = await track(
      seedRelationshipFixture({
        relationshipMemoryEnabled: true,
        runtimeInjectionEnabled: true,
      }),
    );
    await store.set(seedRuntimeInjectionMemoryRows$, fixture, context.signal);

    const response = await accept(
      memoryClient().injectionPreview({
        headers: authHeaders(),
        body: { prompt: "Prepare the security review" },
      }),
      [200],
    );

    expect(response.body.prompt).toBe("Prepare the security review");
    expect(response.body.appendSystemPrompt).toContain("# Zero Memory Context");
    expect(response.body.appendSystemPrompt).toContain("Stable profile:");
    expect(response.body.appendSystemPrompt).toContain("Current context:");
    expect(response.body.appendSystemPrompt).toContain(
      "The user prefers concise launch summaries.",
    );
    expect(response.body.appendSystemPrompt).toContain(
      "validating runtime memory injection",
    );
    expect(response.body.profile.static).toHaveLength(1);
    expect(response.body.profile.dynamic).toHaveLength(2);
    expect(response.body.stats.injectedCount).toBeGreaterThan(0);
  });
});
