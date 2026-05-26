import { randomUUID } from "node:crypto";

import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { zeroRunsMainContract } from "@vm0/api-contracts/contracts/zero-runs";
import type {
  FirewallPolicyValue,
  RawPermissionPolicies,
} from "@vm0/connectors/firewall-types";
import { getConnectorFirewall } from "@vm0/connectors/firewalls";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { connectors } from "@vm0/db/schema/connector";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets } from "@vm0/db/schema/secret";
import { userCache } from "@vm0/db/schema/user-cache";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  generateZeroToken,
  signSandboxJwtForTests,
  verifyZeroToken,
} from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { mockNow } from "../../../lib/time";
import { decryptSecretsMap } from "../../services/crypto.utils";
import { drainOrgQueue$ } from "../../services/zero-run-queue.service";
import { mockOptionalEnv } from "../../../lib/env";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteOrgModelProviders$,
  seedOrgModelProvider$,
} from "./helpers/zero-model-providers";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
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
  readonly owner?: string;
  readonly visibility?: "public" | "private";
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly sound?: string | null;
  readonly customSkills?: readonly string[];
  readonly framework?: "claude-code" | "codex";
  readonly environment?: Record<string, string>;
  readonly permissionPolicies?: RawPermissionPolicies;
  readonly unknownPermissionPolicies?: Record<string, FirewallPolicyValue>;
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
    const framework = args.framework ?? "claude-code";
    const defaultEnvironment =
      framework === "codex"
        ? { OPENAI_API_KEY: "test-key" }
        : { ANTHROPIC_API_KEY: "test-key" };
    const content = {
      version: "1.0",
      agents: {
        [name]: {
          framework,
          environment: args.environment ?? defaultEnvironment,
        },
      },
    };

    const [compose] = await db
      .insert(agentComposes)
      .values({
        userId: args.owner ?? args.fixture.userId,
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
      createdBy: args.owner ?? args.fixture.userId,
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
      owner: args.owner ?? args.fixture.userId,
      name,
      visibility: args.visibility ?? "public",
      displayName: args.displayName ?? null,
      description: args.description ?? null,
      sound: args.sound ?? null,
      permissionPolicies: args.permissionPolicies,
      unknownPermissionPolicies: args.unknownPermissionPolicies,
      customSkills: args.customSkills ? [...args.customSkills] : [],
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

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
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
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      zeroRunsClient().create({
        headers: {},
        body: { prompt: "hello", agentId: randomUUID() },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects sandbox-scoped credentials without agent-run:write", async () => {
    const fx = await fixture();
    const token = generateZeroToken(fx.userId, randomUUID(), fx.orgId);

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: { prompt: "hello", agentId: randomUUID() },
      }),
      [403],
    );

    expect(response.body.error.message).toContain(
      "Missing required capability: agent-run:write",
    );
  });

  it("returns 400 when neither agentId nor sessionId is provided", async () => {
    await fixture();

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "hello" },
      }),
      [400],
    );

    expect(response.body.error.message).toBe("agentId is required");
  });

  it("returns 404 when session inference cannot find a session", async () => {
    await fixture();

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "hello", sessionId: randomUUID() },
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Session not found");
  });

  it("creates a zero run and injects zero-specific runner context", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      displayName: "Research Bot",
      description: "Finds release details",
      sound: "direct",
    });
    const db = store.set(writeDb$);
    await db.insert(userCache).values({
      userId: fx.userId,
      email: "tester@example.com",
      name: "Test User",
    });
    await db.insert(orgMembersMetadata).values({
      orgId: fx.orgId,
      userId: fx.userId,
      timezone: "America/Los_Angeles",
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "summarize release", agentId: agent.agentId },
      }),
      [201],
    );

    expect(response.body.status).toBe("pending");

    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    expect(run?.prompt).toBe("summarize release");
    expect(run?.vars).toStrictEqual({ ZERO_AGENT_ID: agent.agentId });
    expect(run?.appendSystemPrompt).toContain("# Agent Identity");
    expect(run?.appendSystemPrompt).toContain("Your name is Research Bot.");
    expect(run?.appendSystemPrompt).toContain("# Agent Tools");
    for (const toolHint of [
      "zero web download-file -h",
      "Localhost URLs, local dev server ports, and processes started inside the agent runtime are generally only reachable inside that runtime",
      "Local dev servers are useful for agent-side verification",
      "For static web artifacts, Zero provides `zero host <dir> --site <slug> [--spa]`",
      "For apps or services that require a long-running backend, database, worker, external service, or framework-specific runtime",
      "zero host --help",
      "zero connector status <type>",
      "zero doctor check-connector --help",
      "zero doctor generate -h",
      "zero doctor credit",
      "zero credit <credits>",
      "zero doctor permission-deny --help",
      "zero doctor permission-change --help",
      "zero skill --help",
      "zero chat message send --help",
      "zero developer-support --help",
    ]) {
      expect(run?.appendSystemPrompt).toContain(toolHint);
    }
    for (const otherIntegrationHint of [
      "zero slack download-file -h",
      "zero github download-file -h",
      "zero telegram download-file -h",
      "zero phone download-file -h",
    ]) {
      expect(run?.appendSystemPrompt).not.toContain(otherIntegrationHint);
    }
    expect(run?.appendSystemPrompt).toContain("# Current User Info");
    expect(run?.appendSystemPrompt).toContain("Name: Test User");
    expect(run?.appendSystemPrompt).toContain("Timezone: America/Los_Angeles");

    const [zeroRun] = await db
      .select()
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId));
    expect(zeroRun?.triggerSource).toBe("web");
    expect(zeroRun?.triggerAgentId).toBeNull();

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly disallowedTools: readonly string[];
      readonly encryptedSecrets: string | null;
      readonly environment: Record<string, string>;
    };
    expect(executionContext.disallowedTools).toStrictEqual([
      "CronCreate",
      "CronList",
      "CronDelete",
      "ScheduleWakeup",
      "AskUserQuestion",
    ]);
    expect(executionContext.environment.ZERO_AGENT_ID).toBe(agent.agentId);

    const secrets = decryptSecretsMap(executionContext.encryptedSecrets);
    expect(secrets?.ZERO_TOKEN).toBeDefined();
    const auth = verifyZeroToken(secrets!.ZERO_TOKEN!);
    expect(auth).toMatchObject({
      userId: fx.userId,
      runId: response.body.runId,
      orgId: fx.orgId,
    });
    expect(auth?.capabilities).not.toContain("agent-run:write");
  });

  it("queues zero runs at the org concurrency limit and dispatches them when drained", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    const firstStartedAt = now();
    const queuedRequestedAt = firstStartedAt + 1000;
    const queuedPromotedAt = queuedRequestedAt + 120_000;
    await db.insert(userFeatureSwitches).values({
      orgId: fx.orgId,
      userId: fx.userId,
      switches: {
        [FeatureSwitchKey.ComputerUse]: true,
        [FeatureSwitchKey.SandboxIoLimiters]: true,
      },
    });
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      framework: "codex",
    });
    mockNow(firstStartedAt);
    const first = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "first active run", agentId: agent.agentId },
      }),
      [201],
    );

    const [firstRunnerJob] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, first.body.runId));
    const firstExecutionContext = firstRunnerJob?.executionContext as {
      readonly apiStartTime?: number;
    };
    expect(firstExecutionContext.apiStartTime).toBe(firstStartedAt);

    mockNow(queuedRequestedAt);
    const queued = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "queued zero run", agentId: agent.agentId },
      }),
      [201],
    );

    expect(queued.body.status).toBe("queued");
    const [queuedRun] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, queued.body.runId));
    expect(queuedRun?.status).toBe("queued");

    const [zeroRun] = await db
      .select({ triggerSource: zeroRuns.triggerSource })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, queued.body.runId));
    expect(zeroRun?.triggerSource).toBe("web");

    const [queueEntry] = await db
      .select({ encryptedParams: agentRunQueue.encryptedParams })
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, queued.body.runId));
    expect(queueEntry?.encryptedParams).toBeTruthy();

    const runnerJobsBeforeDrain = await db
      .select()
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, queued.body.runId));
    expect(runnerJobsBeforeDrain).toHaveLength(0);

    mockNow(queuedPromotedAt);
    await db
      .update(agentRuns)
      .set({ status: "completed", completedAt: new Date(now()) })
      .where(eq(agentRuns.id, first.body.runId));

    const drained = await store.set(
      drainOrgQueue$,
      { orgId: fx.orgId },
      context.signal,
    );
    expect(drained).toBe(1);

    const [promotedRun] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, queued.body.runId));
    expect(promotedRun?.status).toBe("pending");

    const queueRows = await db
      .select()
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, queued.body.runId));
    expect(queueRows).toHaveLength(0);

    const [runnerJob] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, queued.body.runId));
    const executionContext = runnerJob?.executionContext as {
      readonly environment?: Record<string, string>;
      readonly encryptedSecrets?: string | null;
      readonly featureFlags?: Record<string, boolean>;
      readonly apiStartTime?: number;
    };
    expect(executionContext.apiStartTime).toBe(queuedPromotedAt);
    expect(executionContext.environment?.ZERO_AGENT_ID).toBe(agent.agentId);
    expect(executionContext.featureFlags).toMatchObject({
      [FeatureSwitchKey.ComputerUse]: true,
      [FeatureSwitchKey.SandboxIoLimiters]: true,
    });
    const zeroToken = decryptSecretsMap(
      executionContext.encryptedSecrets ?? null,
    )?.ZERO_TOKEN;
    expect(zeroToken).toBeDefined();
    if (!zeroToken) {
      throw new Error("expected ZERO_TOKEN");
    }
    expect(verifyZeroToken(zeroToken)?.capabilities).toContain(
      "computer-use:write",
    );
  });

  it("rejects explicit VM0 runs when org credits are unavailable", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({ fixture: fx });
    await setOrgCredits(fx.orgId, 0);
    await setMemberCredits({ orgId: fx.orgId, userId: fx.userId });
    const prompt = "vm0 credits gate";

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt, agentId: agent.agentId, modelProvider: "vm0" },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    const db = store.set(writeDb$);
    const rows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.prompt, prompt));
    expect(rows).toHaveLength(0);
  });

  it("allows non-VM0 runs when org credits are unavailable", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({ fixture: fx });
    await setOrgCredits(fx.orgId, 0);
    await setMemberCredits({ orgId: fx.orgId, userId: fx.userId });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt: "anthropic credits bypass",
          agentId: agent.agentId,
          modelProvider: "anthropic",
        },
      }),
      [201],
    );

    expect(response.body.status).toBe("pending");
  });

  it("rejects pro-suspend runs even when using non-VM0 providers", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({ fixture: fx });
    await setOrgCredits(fx.orgId, 20_000, "pro-suspend");
    await setMemberCredits({ orgId: fx.orgId, userId: fx.userId });
    const prompt = "suspended anthropic run";

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt,
          agentId: agent.agentId,
          modelProvider: "anthropic",
        },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    const db = store.set(writeDb$);
    const rows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.prompt, prompt));
    expect(rows).toHaveLength(0);
  });

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
      model: "claude-haiku-4-5",
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
    const decrypted = decryptSecretsMap(executionContext.encryptedSecrets);
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
      selectedModel: "MiniMax-M2.7",
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
      ANTHROPIC_MODEL: "MiniMax-M2.7",
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
    });
    const decrypted = decryptSecretsMap(executionContext.encryptedSecrets);
    // Local dev databases may already have dev-seeded vendor keys.
    if (existingVendorKeys.length === 0) {
      expect(decrypted?.MINIMAX_API_KEY).toBe("sk-vm0-fallback");
    }
    expect(decrypted?.MINIMAX_API_KEY).toBeDefined();
  });

  it("injects multi-auth Codex OAuth model provider secrets and refresh metadata", async () => {
    const fx = await fixture();
    await trackModelProviders(Promise.resolve({ orgId: fx.orgId }));
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fx.orgId,
        type: "codex-oauth-token",
        isDefault: true,
        authMethod: "auth_json",
        selectedModel: "gpt-5.4",
      },
      context.signal,
    );
    const db = store.set(writeDb$);
    await db.insert(secrets).values([
      {
        orgId: fx.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ACCESS_TOKEN",
        encryptedValue: encryptSecretForTests("chatgpt-access"),
        type: "model-provider",
      },
      {
        orgId: fx.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_REFRESH_TOKEN",
        encryptedValue: encryptSecretForTests("chatgpt-refresh"),
        type: "model-provider",
      },
      {
        orgId: fx.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ACCOUNT_ID",
        encryptedValue: encryptSecretForTests("workspace-id"),
        type: "model-provider",
      },
      {
        orgId: fx.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ID_TOKEN",
        encryptedValue: encryptSecretForTests("chatgpt-id-token"),
        type: "model-provider",
      },
    ]);
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      framework: "codex",
      environment: {},
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "codex oauth provider", agentId: agent.agentId },
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
      readonly secretConnectorMap: Record<string, string> | null;
      readonly secretConnectorMetadataMap: Record<
        string,
        {
          readonly sourceType: string;
          readonly sourceUserId?: string;
          readonly metadataKey?: string;
        }
      > | null;
      readonly firewalls: readonly { readonly name: string }[];
      readonly billableFirewalls: readonly string[];
      readonly modelUsageProvider: string | undefined;
    };
    expect(executionContext.environment).toMatchObject({
      CHATGPT_ACCESS_TOKEN: modelProviderSecretPlaceholder(
        "codex-oauth-token",
        "CHATGPT_ACCESS_TOKEN",
      ),
      CHATGPT_ACCOUNT_ID: modelProviderSecretPlaceholder(
        "codex-oauth-token",
        "CHATGPT_ACCOUNT_ID",
      ),
      OPENAI_MODEL: "gpt-5.4",
    });
    const decrypted = decryptSecretsMap(executionContext.encryptedSecrets);
    expect(decrypted).toMatchObject({
      CHATGPT_ACCESS_TOKEN: "chatgpt-access",
      CHATGPT_ACCOUNT_ID: "workspace-id",
    });
    expect(decrypted).not.toHaveProperty("CHATGPT_REFRESH_TOKEN");
    expect(decrypted).not.toHaveProperty("CHATGPT_ID_TOKEN");
    expect(executionContext.secretConnectorMap).toMatchObject({
      CHATGPT_ACCESS_TOKEN: "codex-oauth-token",
    });
    expect(
      executionContext.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toStrictEqual({
      sourceType: "model-provider",
      sourceUserId: ORG_SENTINEL_USER_ID,
      metadataKey: "codex-oauth-token",
    });
    expect(
      executionContext.firewalls.map((firewall) => {
        return firewall.name;
      }),
    ).toContain("model-provider:codex-oauth-token");
    expect(executionContext.billableFirewalls).toStrictEqual([]);
    expect(executionContext.modelUsageProvider).toBeUndefined();

    const [zeroRun] = await db
      .select({
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId));
    expect(zeroRun).toStrictEqual({
      modelProvider: "codex-oauth-token",
      selectedModel: "gpt-5.4",
    });
  });

  it("uses the requested model provider when the agent omits a framework API key", async () => {
    const fx = await fixture();
    await trackModelProviders(Promise.resolve({ orgId: fx.orgId }));
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fx.orgId,
        type: "claude-code-oauth-token",
        isDefault: true,
        selectedModel: "claude-opus-4-6",
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fx.orgId,
        type: "anthropic-api-key",
        selectedModel: "claude-sonnet-4-6",
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {},
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt: "use requested provider",
          agentId: agent.agentId,
          modelProvider: "anthropic-api-key",
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
      readonly encryptedSecrets: string | null;
      readonly modelUsageProvider: string | undefined;
      readonly billableFirewalls: readonly string[];
    };
    expect(executionContext.environment).toMatchObject({
      ANTHROPIC_API_KEY: modelProviderSecretPlaceholder(
        "anthropic-api-key",
        "ANTHROPIC_API_KEY",
      ),
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
    });
    expect(
      executionContext.environment.CLAUDE_CODE_OAUTH_TOKEN,
    ).toBeUndefined();
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      ANTHROPIC_API_KEY: "test-secret-value",
    });
    expect(executionContext.billableFirewalls).toStrictEqual([]);
    expect(executionContext.modelUsageProvider).toBeUndefined();

    const [zeroRun] = await db
      .select({
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId));
    expect(zeroRun).toStrictEqual({
      modelProvider: "anthropic-api-key",
      selectedModel: "claude-sonnet-4-6",
    });
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

  it("merges referenced org and user secrets into the runner environment", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {
        ANTHROPIC_API_KEY: "test-key",
        EXTERNAL_TOKEN: ["${{", " secrets.SHARED_TOKEN }}"].join(""),
      },
    });
    const db = store.set(writeDb$);
    await db.insert(secrets).values([
      {
        orgId: fx.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "SHARED_TOKEN",
        encryptedValue: encryptSecretForTests("org-secret"),
        type: "user",
      },
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "SHARED_TOKEN",
        encryptedValue: encryptSecretForTests("user-secret"),
        type: "user",
      },
    ]);

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt: "use db secret",
          agentId: agent.agentId,
        },
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
    expect(executionContext.environment.EXTERNAL_TOKEN).toBe("user-secret");
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      SHARED_TOKEN: "user-secret",
    });
  });

  it("does not forward unapproved API-token connector secrets", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {
        ANTHROPIC_API_KEY: "test-key",
        AXIOM_TOKEN: ["${{", " secrets.AXIOM_TOKEN }}"].join(""),
      },
    });
    const db = store.set(writeDb$);
    await db.insert(secrets).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "AXIOM_TOKEN",
      encryptedValue: encryptSecretForTests("xaat-unapproved"),
      type: "user",
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt: "do not leak connector token",
          agentId: agent.agentId,
        },
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
    expect(executionContext.environment.AXIOM_TOKEN).toBe(
      ["${{", " secrets.AXIOM_TOKEN }}"].join(""),
    );
    expect(
      decryptSecretsMap(executionContext.encryptedSecrets)?.AXIOM_TOKEN,
    ).toBeUndefined();
  });

  it("masks approved API-token connector env secrets with placeholders", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {
        ANTHROPIC_API_KEY: "test-key",
        AXIOM_TOKEN: ["${{", " secrets.AXIOM_TOKEN }}"].join(""),
      },
    });
    const db = store.set(writeDb$);
    await db.insert(userConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      connectorType: "axiom",
    });
    await db.insert(secrets).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "AXIOM_TOKEN",
      encryptedValue: encryptSecretForTests("xaat-approved"),
      type: "user",
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt: "use approved connector token",
          agentId: agent.agentId,
        },
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
    expect(executionContext.environment.AXIOM_TOKEN).toBe(
      "xaat-c0ffee5a-fe10-ca1c-0ffe-e5afe10ca1c0",
    );
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      AXIOM_TOKEN: "xaat-approved",
    });
  });

  it("injects authorized OAuth connector secrets and refresh metadata", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      permissionPolicies: {
        x: {
          "tweet.read": "allow",
        },
      },
    });
    await db.insert(userConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      connectorType: "x",
    });
    await db.insert(connectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      type: "x",
      authMethod: "oauth",
    });
    await db.insert(secrets).values([
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "X_ACCESS_TOKEN",
        encryptedValue: encryptSecretForTests("x-access"),
        type: "connector",
      },
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "X_REFRESH_TOKEN",
        encryptedValue: encryptSecretForTests("x-refresh"),
        type: "connector",
      },
    ]);

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "oauth connector", agentId: agent.agentId },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly encryptedSecrets: string | null;
      readonly secretConnectorMap: Record<string, string> | null;
      readonly firewalls: readonly { readonly name: string }[];
      readonly billableFirewalls: readonly string[];
    };
    const decrypted = decryptSecretsMap(executionContext.encryptedSecrets);
    expect(decrypted).toMatchObject({ X_TOKEN: "x-access" });
    expect(decrypted).not.toHaveProperty("X_REFRESH_TOKEN");
    expect(executionContext.secretConnectorMap).toMatchObject({
      X_ACCESS_TOKEN: "x",
      X_TOKEN: "x",
    });
    expect(
      executionContext.firewalls.map((firewall) => {
        return firewall.name;
      }),
    ).toContain("x");
    expect(executionContext.billableFirewalls).toContain("x");
  });

  it("ignores orphaned connector secrets for removed connector types", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      permissionPolicies: {
        x: {
          "tweet.read": "allow",
        },
      },
    });
    await db.insert(userConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      connectorType: "x",
    });
    await db.insert(connectors).values([
      {
        orgId: fx.orgId,
        userId: fx.userId,
        type: "x",
        authMethod: "oauth",
      },
      {
        orgId: fx.orgId,
        userId: fx.userId,
        type: "__removed_connector__",
        authMethod: "api",
      },
    ]);
    await db.insert(secrets).values([
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "X_ACCESS_TOKEN",
        encryptedValue: encryptSecretForTests("x-access"),
        type: "connector",
      },
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
        encryptedValue: "invalid-orphaned-secret-ciphertext",
        type: "connector",
      },
    ]);

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          prompt: "ignore orphaned connector secret",
          agentId: agent.agentId,
        },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly encryptedSecrets: string | null;
    };
    const decrypted = decryptSecretsMap(executionContext.encryptedSecrets);
    expect(decrypted).toMatchObject({ X_TOKEN: "x-access" });
    expect(decrypted).not.toHaveProperty("COMPUTER_CONNECTOR_BRIDGE_TOKEN");
  });

  it("injects authorized Base44 OAuth token through the runtime firewall", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    const agent = await seedRunnableZeroAgent({ fixture: fx });
    await db.insert(userConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      connectorType: "base44",
    });
    await db.insert(connectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      type: "base44",
      authMethod: "oauth",
    });
    await db.insert(secrets).values([
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "BASE44_ACCESS_TOKEN",
        encryptedValue: encryptSecretForTests("base44-access"),
        type: "connector",
      },
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "BASE44_REFRESH_TOKEN",
        encryptedValue: encryptSecretForTests("base44-refresh"),
        type: "connector",
      },
    ]);

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "base44 connector", agentId: agent.agentId },
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
      readonly secretConnectorMap: Record<string, string> | null;
      readonly firewalls: readonly {
        readonly name: string;
        readonly apis: readonly {
          readonly base: string;
          readonly auth?: { readonly headers?: Record<string, string> };
        }[];
      }[];
    };
    expect(executionContext.environment.BASE44_TOKEN).toBe(
      "base44_placeholder_token",
    );
    expect(executionContext.environment).not.toHaveProperty(
      "BASE44_ACCESS_TOKEN",
    );
    expect(executionContext.environment).not.toHaveProperty("LARK_TOKEN");
    expect(executionContext.environment).not.toHaveProperty("LARK_APP_ID");
    const decrypted = decryptSecretsMap(executionContext.encryptedSecrets);
    expect(decrypted).toMatchObject({ BASE44_TOKEN: "base44-access" });
    expect(decrypted).not.toHaveProperty("BASE44_REFRESH_TOKEN");
    expect(executionContext.secretConnectorMap).toMatchObject({
      BASE44_ACCESS_TOKEN: "base44",
      BASE44_TOKEN: "base44",
    });
    const firewall = executionContext.firewalls.find((candidate) => {
      return candidate.name === "base44";
    });
    expect(firewall?.apis[0]?.base).toBe("https://app.base44.com/mcp");
    expect(firewall?.apis[0]?.auth?.headers?.Authorization).toBe(
      ["Bearer $", "{{ secrets.BASE44_TOKEN }}"].join(""),
    );
  });

  it("injects authorized Slock OAuth secrets through the runtime firewall", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    const agent = await seedRunnableZeroAgent({ fixture: fx });
    await db.insert(userConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      connectorType: "slock",
    });
    await db.insert(connectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      type: "slock",
      authMethod: "oauth",
    });
    await db.insert(secrets).values([
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "SLOCK_ACCESS_TOKEN",
        encryptedValue: encryptSecretForTests("slock-access"),
        type: "connector",
      },
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "SLOCK_REFRESH_TOKEN",
        encryptedValue: encryptSecretForTests("slock-refresh"),
        type: "connector",
      },
      {
        orgId: fx.orgId,
        userId: fx.userId,
        name: "SLOCK_SERVER_ID",
        encryptedValue: encryptSecretForTests("slock-server-id"),
        type: "connector",
      },
    ]);

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "slock connector", agentId: agent.agentId },
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
      readonly secretConnectorMap: Record<string, string> | null;
      readonly firewalls: readonly {
        readonly name: string;
        readonly apis: readonly {
          readonly base: string;
          readonly auth?: { readonly headers?: Record<string, string> };
        }[];
      }[];
    };

    const slockFirewall = getConnectorFirewall("slock");
    expect(executionContext.environment.SLOCK_TOKEN).toBe(
      slockFirewall.placeholders?.SLOCK_TOKEN,
    );
    expect(executionContext.environment.SLOCK_SERVER_ID).toBe(
      slockFirewall.placeholders?.SLOCK_SERVER_ID,
    );
    const decrypted = decryptSecretsMap(executionContext.encryptedSecrets);
    expect(decrypted).toMatchObject({
      SLOCK_TOKEN: "slock-access",
      SLOCK_SERVER_ID: "slock-server-id",
    });
    expect(decrypted).not.toHaveProperty("SLOCK_ACCESS_TOKEN");
    expect(decrypted).not.toHaveProperty("SLOCK_REFRESH_TOKEN");
    expect(executionContext.secretConnectorMap).toStrictEqual({
      SLOCK_ACCESS_TOKEN: "slock",
      SLOCK_TOKEN: "slock",
    });
    const firewall = executionContext.firewalls.find((candidate) => {
      return candidate.name === "slock";
    });
    expect(firewall?.apis[0]?.base).toBe("https://api.slock.ai");
    expect(firewall?.apis[0]?.auth?.headers).toStrictEqual({
      Authorization: ["Bearer $", "{{ secrets.SLOCK_TOKEN }}"].join(""),
      "X-Server-Id": ["$", "{{ secrets.SLOCK_SERVER_ID }}"].join(""),
    });
  });

  it("adds the Google Ads developer token for authorized OAuth connector runs", async () => {
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token");
    const fx = await fixture();
    const db = store.set(writeDb$);
    const agent = await seedRunnableZeroAgent({ fixture: fx });
    await db.insert(userConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      connectorType: "google-ads",
    });
    await db.insert(connectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      type: "google-ads",
      authMethod: "oauth",
    });
    await db.insert(secrets).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "GOOGLE_ADS_ACCESS_TOKEN",
      encryptedValue: encryptSecretForTests("google-ads-access"),
      type: "connector",
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "google ads connector", agentId: agent.agentId },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly encryptedSecrets: string | null;
      readonly secretConnectorMap: Record<string, string> | null;
      readonly firewalls: readonly { readonly name: string }[];
    };
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      GOOGLE_ADS_TOKEN: "google-ads-access",
      GOOGLE_ADS_DEVELOPER_TOKEN: "developer-token",
    });
    expect(executionContext.secretConnectorMap).toMatchObject({
      GOOGLE_ADS_ACCESS_TOKEN: "google-ads",
      GOOGLE_ADS_TOKEN: "google-ads",
    });
    expect(
      executionContext.firewalls.map((firewall) => {
        return firewall.name;
      }),
    ).toContain("google-ads");
  });

  it("injects authorized custom connector firewalls and secrets", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    const agent = await seedRunnableZeroAgent({ fixture: fx });
    const customConnectorId = randomUUID();
    const secretKey = `CUSTOM_${customConnectorId.replaceAll("-", "").toUpperCase()}`;
    await db.insert(orgCustomConnectors).values({
      id: customConnectorId,
      orgId: fx.orgId,
      slug: "internal-api",
      displayName: "Internal API",
      prefixes: ["https://*.internal.example.com/api/"],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
      createdBy: fx.userId,
    });
    await db.insert(orgCustomConnectorSecrets).values({
      connectorId: customConnectorId,
      orgId: fx.orgId,
      userId: fx.userId,
      encryptedValue: encryptSecretForTests("custom-secret"),
    });
    await db.insert(userCustomConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      customConnectorId,
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "custom connector", agentId: agent.agentId },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly encryptedSecrets: string | null;
      readonly firewalls: readonly {
        readonly name: string;
        readonly apis: readonly {
          readonly base: string;
          readonly auth?: { readonly headers?: Record<string, string> };
        }[];
      }[];
      readonly networkPolicies: Record<
        string,
        { readonly unknownPolicy: string }
      >;
    };
    const firewall = executionContext.firewalls.find((candidate) => {
      return candidate.name === "internal-api";
    });
    expect(firewall?.apis[0]?.base).toBe(
      "https://{hostWildcard1}.internal.example.com/api/",
    );
    expect(firewall?.apis[0]?.auth?.headers?.Authorization).toBe(
      `Bearer \${{ secrets.${secretKey} }}`,
    );
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      [secretKey]: "custom-secret",
    });
    expect(
      executionContext.networkPolicies["internal-api"]?.unknownPolicy,
    ).toBe("allow");
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

  it("mounts seed skills without unrelated connector skills", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({ fixture: fx });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "use skills", agentId: agent.agentId },
      }),
      [201],
    );

    const db = store.set(writeDb$);
    const [run] = await db
      .select({ additionalVolumes: agentRuns.additionalVolumes })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    const volumes = run?.additionalVolumes ?? [];
    expect(
      volumes.some((volume) => {
        return volume.mountPath === "/home/user/.claude/skills/deep-dive";
      }),
    ).toBeTruthy();
    expect(
      volumes.some((volume) => {
        return volume.mountPath === "/home/user/.claude/skills/slack";
      }),
    ).toBeFalsy();
    expect(
      volumes.every((volume) => {
        return volume.system === true;
      }),
    ).toBeTruthy();
  });

  it("mounts authorized connector skills and custom skills", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      customSkills: ["research-kit"],
    });
    const db = store.set(writeDb$);
    await db.insert(userConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      connectorType: "slack",
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "use connector", agentId: agent.agentId },
      }),
      [201],
    );

    const [run] = await db
      .select({ additionalVolumes: agentRuns.additionalVolumes })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    const volumes = run?.additionalVolumes ?? [];
    const slackIndex = volumes.findIndex((volume) => {
      return volume.mountPath === "/home/user/.claude/skills/slack";
    });
    const customIndex = volumes.findIndex((volume) => {
      return volume.mountPath === "/home/user/.claude/skills/research-kit";
    });
    expect(slackIndex).toBeGreaterThanOrEqual(0);
    expect(customIndex).toBeGreaterThan(slackIndex);
    expect(volumes[slackIndex]?.system).toBeTruthy();
    expect(volumes[customIndex]).toMatchObject({
      name: "custom-skill@research-kit",
    });
    expect(volumes[customIndex]?.system).toBeUndefined();
  });

  it("mounts skills using the model provider framework, not the compose framework", async () => {
    const fx = await fixture();
    await trackModelProviders(Promise.resolve({ orgId: fx.orgId }));
    // openai-api-key resolves to the codex framework.
    const provider = await store.set(
      seedOrgModelProvider$,
      {
        orgId: fx.orgId,
        type: "openai-api-key",
        isDefault: true,
        selectedModel: "gpt-5.5",
        secretName: "OPENAI_API_KEY",
      },
      context.signal,
    );
    // The compose declares the default claude-code framework, but the agent
    // is pinned to a codex-framework model provider. Skill volume mount paths
    // must follow the model provider's framework, not the compose's.
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      environment: {},
      modelProviderId: provider.id,
      customSkills: ["research-kit"],
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "use skills", agentId: agent.agentId },
      }),
      [201],
    );

    const db = store.set(writeDb$);
    const [run] = await db
      .select({ additionalVolumes: agentRuns.additionalVolumes })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    const volumes = run?.additionalVolumes ?? [];
    expect(
      volumes.some((volume) => {
        return volume.mountPath === "/home/user/.codex/skills/research-kit";
      }),
    ).toBeTruthy();
    expect(
      volumes.some((volume) => {
        return volume.mountPath === "/home/user/.codex/skills/deep-dive";
      }),
    ).toBeTruthy();
    expect(
      volumes.some((volume) => {
        return volume.mountPath.startsWith("/home/user/.claude/skills/");
      }),
    ).toBeFalsy();
  });

  it("builds runner firewalls from stored zero agent permission policies", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      permissionPolicies: {
        x: {
          "tweet.write": "deny",
          "tweet.read": "allow",
        },
      },
    });
    const db = store.set(writeDb$);
    await db.insert(userConnectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentId: agent.agentId,
      connectorType: "x",
    });
    await db.insert(connectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      type: "x",
      authMethod: "oauth",
    });
    await db.insert(secrets).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "X_ACCESS_TOKEN",
      encryptedValue: encryptSecretForTests("x-policy-token"),
      type: "connector",
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "use x policy", agentId: agent.agentId },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly firewalls?: readonly { readonly name: string }[];
      readonly networkPolicies?: Record<
        string,
        {
          readonly allow: readonly string[];
          readonly deny: readonly string[];
          readonly ask: readonly string[];
          readonly unknownPolicy: string;
        }
      >;
    };

    expect(
      executionContext.firewalls?.map((firewall) => {
        return firewall.name;
      }),
    ).toContain("x");
    const xPolicy = executionContext.networkPolicies?.x;
    if (!xPolicy) {
      throw new Error("Expected x network policy");
    }
    expect(xPolicy.allow).toContain("tweet.read");
    expect(xPolicy.deny).toContain("tweet.write");
    expect(xPolicy.unknownPolicy).toBe("allow");
  });

  it("uses the Codex skills mount path for codex zero agents", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      framework: "codex",
      customSkills: ["codex-helper"],
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "use codex skills", agentId: agent.agentId },
      }),
      [201],
    );

    const db = store.set(writeDb$);
    const [run] = await db
      .select({ additionalVolumes: agentRuns.additionalVolumes })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    const volumes = run?.additionalVolumes ?? [];
    expect(
      volumes.some((volume) => {
        return volume.mountPath === "/home/user/.codex/skills/deep-dive";
      }),
    ).toBeTruthy();
    expect(
      volumes.some((volume) => {
        return volume.mountPath === "/home/user/.codex/skills/codex-helper";
      }),
    ).toBeTruthy();
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

  it("infers the zero agent from sessionId", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({ fixture: fx });
    const sessionId = await store.set(
      seedSession$,
      { fixture: fx, agentId: agent.agentId },
      context.signal,
    );

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "continue", sessionId },
      }),
      [201],
    );

    const db = store.set(writeDb$);
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    expect(run?.sessionId).toBe(sessionId);
    expect(run?.continuedFromSessionId).toBe(sessionId);
    expect(run?.vars).toStrictEqual({ ZERO_AGENT_ID: agent.agentId });
  });

  it("prevents non-owners from running private zero agents", async () => {
    const fx = await fixture();
    const agent = await seedRunnableZeroAgent({
      fixture: fx,
      owner: `other_${randomUUID()}`,
      visibility: "private",
    });

    const response = await accept(
      zeroRunsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { prompt: "hello", agentId: agent.agentId },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  });

  it("keeps plain sandbox tokens out of the route", async () => {
    const fx = await fixture();

    const response = await accept(
      zeroRunsClient().create({
        headers: {
          authorization: `Bearer ${sandboxToken({
            userId: fx.userId,
            orgId: fx.orgId,
          })}`,
        },
        body: { prompt: "hello", agentId: randomUUID() },
      }),
      [403],
    );

    expect(response.body.error.message).toContain(
      "Missing required capability: agent-run:write",
    );
  });
});
