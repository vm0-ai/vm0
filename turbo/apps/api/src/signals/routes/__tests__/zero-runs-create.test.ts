// Remnant legacy file, kept per api.bdd.md "Open Helper Gaps" (runners.test.ts
// precedent): vm0-managed provider keys live in the global `vm0_api_keys`
// table, which has no public write API, so key selection/fallback/minimax
// routing and the post-resolution vm0 credit gate are only constructible via
// direct DB seeding. Production zero tokens never carry `agent-run:write`
// (AGENT_EXCLUDED_CAPABILITIES), so the nested trigger-agent callback family
// needs a test-signed token plus a DB-seeded parent run. The agent provider
// pin (`zeroAgents.modelProviderId`) has no public writer, and every chat or
// schedule pin resolves a provider *type* before dispatch, so the id-only
// framework lookup in resolveRequestedRunFramework is likewise only seedable.
// Route-level zero-run coverage lives in run-lifecycle.bdd.test.ts
// (RUN-01/RUN-02).
import { randomUUID } from "node:crypto";

import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { zeroRunsMainContract } from "@vm0/api-contracts/contracts/zero-runs";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { mockOptionalEnv } from "../../../lib/env";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteOrgModelProviders$,
  seedOrgModelProvider$,
} from "./helpers/zero-model-providers";
import { decryptSecretsMapForTests } from "./helpers/encrypt-secret";
import {
  deleteUsageInsightFixture$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ORG_SENTINEL_USER_ID = "__org__";

function modelProviderSecretPlaceholder(
  type: ModelProviderType,
  secretName: string,
): string {
  const placeholder =
    getModelProviderFirewall(type)?.placeholders?.[secretName];
  if (!placeholder) {
    throw new Error(`Missing model provider placeholder for ${secretName}`);
  }
  return placeholder;
}

interface ZeroAgentSeed {
  readonly fixture: UsageInsightFixture;
  readonly environment?: Record<string, string>;
  readonly modelProviderId?: string | null;
  readonly selectedModel?: string | null;
}

const seedRunnableZeroAgent$ = command(
  async (
    { set },
    args: ZeroAgentSeed,
    signal: AbortSignal,
  ): Promise<{ readonly agentId: string; readonly versionId: string }> => {
    const db = set(writeDb$);
    const name = `zero-agent-${randomUUID().slice(0, 8)}`;
    const versionId = randomUUID();
    const content = {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: args.environment ?? { ANTHROPIC_API_KEY: "test-key" },
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
    await db.insert(zeroAgents).values({
      id: compose.id,
      orgId: args.fixture.orgId,
      owner: args.fixture.userId,
      name,
      visibility: "public",
      displayName: null,
      description: null,
      sound: null,
      customSkills: [],
      modelProviderId: args.modelProviderId ?? null,
      selectedModel: args.selectedModel ?? null,
    });
    signal.throwIfAborted();

    return { agentId: compose.id, versionId };
  },
);

const seedSession$ = command(
  async (
    { set },
    args: {
      readonly fixture: UsageInsightFixture;
      readonly agentId: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const [session] = await db
      .insert(agentSessions)
      .values({
        userId: args.fixture.userId,
        orgId: args.fixture.orgId,
        agentComposeId: args.agentId,
      })
      .returning({ id: agentSessions.id });
    signal.throwIfAborted();
    if (!session) {
      throw new Error("session insert returned no row");
    }
    return session.id;
  },
);

function zeroRunsClient() {
  return setupApp({ context })(zeroRunsMainContract);
}

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});
const trackModelProviders = createFixtureTracker<{ readonly orgId: string }>(
  (modelProviderFixture) => {
    return store.set(
      deleteOrgModelProviders$,
      modelProviderFixture,
      context.signal,
    );
  },
);
const trackVm0ApiKey = createFixtureTracker<string>(async (label) => {
  const db = store.set(writeDb$);
  await db.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, label));
});

async function fixture(): Promise<UsageInsightFixture> {
  const created = await track(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  mocks.clerk.session(created.userId, created.orgId);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        organization: { id: created.orgId },
        role: "org:admin",
      },
    ],
  });
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/archive.tar.gz?sig=test",
  );
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  return created;
}

async function seedRunnableZeroAgent(
  args: ZeroAgentSeed,
): Promise<{ readonly agentId: string; readonly versionId: string }> {
  return await store.set(seedRunnableZeroAgent$, args, context.signal);
}

async function setOrgCredits(
  orgId: string,
  credits: number,
  tier: OrgTier = "free",
): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .insert(orgMetadata)
    .values({ orgId, credits, tier })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { credits, tier },
    });
}

async function setMemberCredits(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
    })
    .onConflictDoNothing();
}

async function seedDefaultModelProvider(args: {
  readonly orgId: string;
  readonly type: string;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(modelProviders).values({
    orgId: args.orgId,
    userId: ORG_SENTINEL_USER_ID,
    type: args.type,
    isDefault: true,
  });
}

async function seedVm0ApiKey(args: {
  readonly vendor: string;
  readonly model: string;
  readonly apiKey: string;
}): Promise<void> {
  const db = store.set(writeDb$);
  const label = await trackVm0ApiKey(Promise.resolve(`test-${randomUUID()}`));
  await db.insert(vm0ApiKeys).values({
    vendor: args.vendor,
    model: args.model,
    apiKey: args.apiKey,
    label,
  });
}

async function seedExpiredCredits(args: {
  readonly orgId: string;
  readonly remaining: number;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(creditExpiresRecord).values({
    orgId: args.orgId,
    source: "starter_grant",
    amount: args.remaining,
    remaining: args.remaining,
    expiresAt: new Date(now() - 60_000),
  });
}

function zeroTokenWithWrite(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["agent-run:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

describe("POST /api/zero/runs", () => {
  it("uses VM0 managed provider keys and marks model billing context", async () => {
    const fx = await fixture();
    await setOrgCredits(fx.orgId, 100);
    await setMemberCredits({ orgId: fx.orgId, userId: fx.userId });
    const db = store.set(writeDb$);
    const existingVendorKeys = await db
      .select({ model: vm0ApiKeys.model })
      .from(vm0ApiKeys)
      .where(eq(vm0ApiKeys.vendor, "anthropic"));
    const hasExistingExactKey = existingVendorKeys.some((row) => {
      return row.model === "claude-opus-4-6";
    });
    await seedVm0ApiKey({
      vendor: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "sk-vm0-fallback",
    });
    await seedVm0ApiKey({
      vendor: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "sk-vm0-managed",
    });
    await db.insert(modelProviders).values({
      orgId: fx.orgId,
      userId: ORG_SENTINEL_USER_ID,
      type: "vm0",
      isDefault: true,
      selectedModel: "claude-opus-4-6",
    });
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {},
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "vm0 managed provider", agentId: agent.agentId },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
      readonly billableFirewalls: readonly string[];
      readonly modelUsageProvider: string | undefined;
    };
    expect(executionContext.environment).toMatchObject({
      ANTHROPIC_API_KEY: modelProviderSecretPlaceholder(
        "anthropic-api-key",
        "ANTHROPIC_API_KEY",
      ),
      ANTHROPIC_MODEL: "claude-opus-4-6",
    });
    const decrypted = decryptSecretsMapForTests(
      executionContext.encryptedSecrets,
    );
    // Local dev databases may already have dev-seeded exact keys.
    if (!hasExistingExactKey) {
      expect(decrypted?.ANTHROPIC_API_KEY).toBe("sk-vm0-managed");
    }
    expect(decrypted?.ANTHROPIC_API_KEY).not.toBe("sk-vm0-fallback");
    expect(executionContext.billableFirewalls).toContain(
      "model-provider:anthropic-api-key",
    );
    expect(executionContext.modelUsageProvider).toBe("claude-opus-4-6");

    const [zeroRun] = await db
      .select({
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId));
    expect(zeroRun).toStrictEqual({
      modelProvider: "vm0",
      selectedModel: "claude-opus-4-6",
    });
  });

  it("falls back to the VM0 vendor key pool when no exact model key exists", async () => {
    const fx = await fixture();
    await setOrgCredits(fx.orgId, 100);
    await setMemberCredits({ orgId: fx.orgId, userId: fx.userId });
    const db = store.set(writeDb$);
    const existingVendorKeys = await db
      .select({ model: vm0ApiKeys.model })
      .from(vm0ApiKeys)
      .where(eq(vm0ApiKeys.vendor, "minimax"));
    await seedVm0ApiKey({
      vendor: "minimax",
      model: "MiniMax-M2.1",
      apiKey: "sk-vm0-fallback",
    });
    await db.insert(modelProviders).values({
      orgId: fx.orgId,
      userId: ORG_SENTINEL_USER_ID,
      type: "vm0",
      isDefault: true,
      selectedModel: "MiniMax-M3",
    });
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {},
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "vm0 fallback provider", agentId: agent.agentId },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
    };
    expect(executionContext.environment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: modelProviderSecretPlaceholder(
        "minimax-api-key",
        "MINIMAX_API_KEY",
      ),
      ANTHROPIC_MODEL: "MiniMax-M3",
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
    });
    const decrypted = decryptSecretsMapForTests(
      executionContext.encryptedSecrets,
    );
    // Local dev databases may already have dev-seeded vendor keys.
    if (existingVendorKeys.length === 0) {
      expect(decrypted?.MINIMAX_API_KEY).toBe("sk-vm0-fallback");
    }
    expect(decrypted?.MINIMAX_API_KEY).toBeDefined();
  });

  it("routes VM0 managed MiniMax M3 through the official MiniMax endpoint", async () => {
    const fx = await fixture();
    await setOrgCredits(fx.orgId, 100);
    await setMemberCredits({ orgId: fx.orgId, userId: fx.userId });
    const db = store.set(writeDb$);
    const existingVendorKeys = await db
      .select({ model: vm0ApiKeys.model })
      .from(vm0ApiKeys)
      .where(eq(vm0ApiKeys.vendor, "minimax"));
    const hasExistingExactKey = existingVendorKeys.some((row) => {
      return row.model === "MiniMax-M3";
    });
    await seedVm0ApiKey({
      vendor: "minimax",
      model: "MiniMax-M3",
      apiKey: "sk-vm0-minimax-m3",
    });
    await db.insert(modelProviders).values({
      orgId: fx.orgId,
      userId: ORG_SENTINEL_USER_ID,
      type: "vm0",
      isDefault: true,
      selectedModel: "MiniMax-M3",
    });
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {},
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "vm0 minimax m3 provider", agentId: agent.agentId },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
    };
    expect(executionContext.environment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: modelProviderSecretPlaceholder(
        "minimax-api-key",
        "MINIMAX_API_KEY",
      ),
      ANTHROPIC_MODEL: "MiniMax-M3",
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
    });
    const decrypted = decryptSecretsMapForTests(
      executionContext.encryptedSecrets,
    );
    if (!hasExistingExactKey) {
      expect(decrypted?.MINIMAX_API_KEY).toBe("sk-vm0-minimax-m3");
    }
    expect(decrypted?.MINIMAX_API_KEY).toBeDefined();

    const [zeroRun] = await db
      .select({
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId));
    expect(zeroRun).toStrictEqual({
      modelProvider: "vm0",
      selectedModel: "MiniMax-M3",
    });
  });

  it("rejects omitted modelProvider when the org default provider is VM0", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {},
    });
    await setOrgCredits(fx.orgId, 100);
    await setMemberCredits({ orgId: fx.orgId, userId: fx.userId });
    await seedExpiredCredits({ orgId: fx.orgId, remaining: 100 });
    await seedVm0ApiKey({
      vendor: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "sk-vm0-managed",
    });
    await seedDefaultModelProvider({ orgId: fx.orgId, type: "vm0" });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "default vm0 credits gate", agentId: agent.agentId },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("checks VM0 credits after resolving past an incompatible personal default provider", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {},
    });
    await setOrgCredits(fx.orgId, 0);
    await setMemberCredits({ orgId: fx.orgId, userId: fx.userId });
    await seedVm0ApiKey({
      vendor: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "sk-vm0-managed",
    });

    const db = store.set(writeDb$);
    await db.insert(modelProviders).values([
      {
        orgId: fx.orgId,
        userId: fx.userId,
        type: "openai-api-key",
        isDefault: true,
      },
      {
        orgId: fx.orgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "vm0",
        isDefault: true,
        selectedModel: "claude-opus-4-6",
      },
    ]);

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt: "vm0 fallback credit gate",
          agentId: agent.agentId,
        },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("uses zero agent model provider pins and selected model defaults", async () => {
    const fx = await fixture();
    await trackModelProviders(Promise.resolve({ orgId: fx.orgId }));
    const provider = await store.set(
      seedOrgModelProvider$,
      {
        orgId: fx.orgId,
        type: "anthropic-api-key",
        isDefault: true,
        selectedModel: "provider-default-model",
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {},
      modelProviderId: provider.id,
      selectedModel: "agent-selected-model",
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt: "use agent model default",
          agentId: agent.agentId,
        },
      }),
      [201],
    );

    const db = store.set(writeDb$);
    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly modelUsageProvider: string | undefined;
      readonly billableFirewalls: readonly string[];
    };
    expect(executionContext.environment.ANTHROPIC_MODEL).toBe(
      "agent-selected-model",
    );
    expect(executionContext.billableFirewalls).toStrictEqual([]);
    expect(executionContext.modelUsageProvider).toBeUndefined();

    const [zeroRun] = await db
      .select({
        modelProvider: zeroRuns.modelProvider,
        modelProviderId: zeroRuns.modelProviderId,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId));
    expect(zeroRun).toStrictEqual({
      modelProvider: "anthropic-api-key",
      modelProviderId: provider.id,
      selectedModel: "agent-selected-model",
    });
  });

  it("persists agent-trigger metadata and callback for nested zero runs", async () => {
    const fx = await fixture();
    const parentAgent = await seedRunnableZeroAgent({ fixture: fx });
    const childAgent = await seedRunnableZeroAgent({ fixture: fx });
    const parentSessionId = await store.set(
      seedSession$,
      { fixture: fx, agentId: parentAgent.agentId },
      context.signal,
    );
    const db = store.set(writeDb$);
    const [parentRun] = await db
      .insert(agentRuns)
      .values({
        userId: fx.userId,
        orgId: fx.orgId,
        agentComposeVersionId: parentAgent.versionId,
        sessionId: parentSessionId,
        status: "completed",
        prompt: "parent",
      })
      .returning({ id: agentRuns.id });
    if (!parentRun) {
      throw new Error("parent run insert returned no row");
    }

    const response = await accept(
      zeroRunsClient().create({
        headers: {
          authorization: `Bearer ${zeroTokenWithWrite({
            userId: fx.userId,
            orgId: fx.orgId,
            runId: parentRun.id,
          })}`,
        },
        body: { prompt: "child", agentId: childAgent.agentId },
      }),
      [201],
    );

    const [zeroRun] = await db
      .select()
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId));
    expect(zeroRun).toMatchObject({
      triggerSource: "agent",
      triggerAgentId: parentAgent.agentId,
    });

    const [callback] = await db
      .select({
        url: agentRunCallbacks.url,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, response.body.runId));
    expect(callback?.url).toBe(
      "http://localhost:3000/api/internal/callbacks/agent",
    );
    expect(callback?.payload).toStrictEqual({
      triggerAgentId: parentAgent.agentId,
    });
  });
});
