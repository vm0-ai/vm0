import { randomUUID } from "node:crypto";

import { runsMainContract } from "@vm0/api-contracts/contracts/runs";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { connectors } from "@vm0/db/schema/connector";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { userCache } from "@vm0/db/schema/user-cache";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { variables } from "@vm0/db/schema/variable";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { createStore, command } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { decryptSecretsMap } from "../../services/crypto.utils";
import { now, nowDate } from "../../external/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  deleteOrgModelProviders$,
  seedOrgModelProvider$,
} from "./helpers/zero-model-providers";
import { encryptSecretForTests } from "./helpers/encrypt-secret";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface AgentConfig {
  readonly framework?: "claude-code" | "codex";
  readonly environment?: Record<string, string>;
  readonly volumes?: readonly string[];
  readonly experimental_runner?: { readonly group?: string };
  readonly experimental_profile?: string;
}

interface ComposeSeed {
  readonly fixture: UsageInsightFixture;
  readonly name?: string;
  readonly overrides?: AgentConfig;
  readonly artifacts?: readonly {
    readonly name: string;
    readonly version?: string;
    readonly mount_path?: string;
  }[];
  readonly volumes?: Record<
    string,
    {
      readonly name: string;
      readonly version: string;
      readonly optional?: boolean;
    }
  >;
}

type StorageType = "artifact" | "volume";

const seedRunnableCompose$ = command(
  async (
    { set },
    args: ComposeSeed,
    signal: AbortSignal,
  ): Promise<{ readonly composeId: string; readonly versionId: string }> => {
    const db = set(writeDb$);
    const name = args.name ?? `agent-${randomUUID().slice(0, 8)}`;
    const versionId = randomUUID();
    const content = {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
          ...args.overrides,
        },
      },
      ...(args.volumes ? { volumes: args.volumes } : {}),
      ...(args.artifacts ? { artifacts: args.artifacts } : {}),
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
    });
    signal.throwIfAborted();

    return { composeId: compose.id, versionId };
  },
);

const seedConversationForSession$ = command(
  async (
    { set },
    args: { readonly runId: string; readonly sessionId: string },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const [conversation] = await db
      .insert(conversations)
      .values({
        runId: args.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `session-${args.runId}`,
        cliAgentSessionHistory: "{}",
      })
      .returning({ id: conversations.id });
    signal.throwIfAborted();
    if (!conversation) {
      throw new Error("conversation insert returned no row");
    }
    await db
      .update(agentSessions)
      .set({ conversationId: conversation.id })
      .where(eq(agentSessions.id, args.sessionId));
    signal.throwIfAborted();
    return conversation.id;
  },
);

const seedHashConversationForSession$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly sessionId: string;
      readonly hash: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const [conversation] = await db
      .insert(conversations)
      .values({
        runId: args.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `session-${args.runId}`,
        cliAgentSessionHistoryHash: args.hash,
      })
      .returning({ id: conversations.id });
    signal.throwIfAborted();
    if (!conversation) {
      throw new Error("conversation insert returned no row");
    }
    await db
      .update(agentSessions)
      .set({ conversationId: conversation.id })
      .where(eq(agentSessions.id, args.sessionId));
    signal.throwIfAborted();
    return conversation.id;
  },
);

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

function runsClient() {
  return setupApp({ context })(runsMainContract);
}

function vm0Template(expression: string): string {
  return `$${expression}`;
}

function runContextSnapshot(
  runId: string,
): Record<string, unknown> | undefined {
  for (const [dataset, events] of context.mocks.axiom.ingest.mock.calls) {
    if (dataset !== "run-context") {
      continue;
    }
    const snapshots = events as readonly Record<string, unknown>[];
    const snapshot = snapshots.find((event) => {
      return event.runId === runId;
    });
    if (snapshot) {
      return snapshot;
    }
  }
  return undefined;
}

async function fixture(): Promise<UsageInsightFixture> {
  const created = await track(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  mocks.clerk.session(created.userId, created.orgId);
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  return created;
}

async function createCompose(
  args: ComposeSeed,
): Promise<{ readonly composeId: string; readonly versionId: string }> {
  return await store.set(seedRunnableCompose$, args, context.signal);
}

async function seedStorage(args: {
  readonly fixture: UsageInsightFixture;
  readonly type: StorageType;
  readonly name: string;
  readonly versionId?: string;
}): Promise<string> {
  const db = store.set(writeDb$);
  const storageId = randomUUID();
  const versionId = args.versionId ?? randomUUID().replaceAll("-", "");
  const userId =
    args.type === "volume" ? VOLUME_ORG_USER_ID : args.fixture.userId;
  await db.insert(storages).values({
    id: storageId,
    orgId: args.fixture.orgId,
    userId,
    name: args.name,
    type: args.type,
    s3Prefix: `${args.fixture.orgId}/${args.type}/${args.name}`,
    size: 100,
    fileCount: 1,
  });
  await db.insert(storageVersions).values({
    id: versionId,
    storageId,
    s3Key: `${args.fixture.orgId}/${args.type}/${args.name}/${versionId}`,
    size: 100,
    fileCount: 1,
    createdBy: args.fixture.userId,
  });
  await db
    .update(storages)
    .set({ headVersionId: versionId })
    .where(eq(storages.id, storageId));
  return versionId;
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
  });
}

describe("POST /api/agent/runs", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      runsClient().create({
        headers: {},
        body: { prompt: "test", agentComposeId: randomUUID() },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("validates the request body", async () => {
    await fixture();
    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: randomUUID() } as never,
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("prompt");
  });

  it("creates a pending run, session, and runner job", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Create a run",
          appendSystemPrompt: "Be concise.",
        },
      }),
      [201],
    );

    expect(response.body).toMatchObject({ status: "pending" });
    expect(response.body.sessionId).toBeDefined();
    expect(response.body.createdAt).toBeDefined();

    const db = store.set(writeDb$);
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    expect(run?.status).toBe("pending");
    expect(run?.sessionId).toBe(response.body.sessionId);
    expect(run?.appendSystemPrompt).toBe("Be concise.");
    expect(run?.lastHeartbeatAt).not.toBeNull();

    const [job] = await db
      .select()
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    expect(job?.runnerGroup).toBe("vm0/test");
    expect(job?.profile).toBe("vm0/default");
    expect(job).toBeDefined();
    const executionContext = job!.executionContext as {
      readonly storageManifest: {
        readonly artifacts: readonly { readonly vasStorageName: string }[];
      };
    };
    expect(
      executionContext.storageManifest.artifacts.map((artifact) => {
        return artifact.vasStorageName;
      }),
    ).toStrictEqual(["memory"]);
    expect(runContextSnapshot(response.body.runId)).toMatchObject({
      runId: response.body.runId,
      userId: fx.userId,
      prompt: "Create a run",
      appendSystemPrompt: "Be concise.",
      sessionId: null,
    });
  });

  it("passes evaluated feature switches to the runner job context", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    await db.insert(userFeatureSwitches).values({
      orgId: fx.orgId,
      userId: fx.userId,
      switches: {
        [FeatureSwitchKey.ComputerUse]: true,
        [FeatureSwitchKey.SandboxIoLimiters]: true,
      },
    });
    const compose = await createCompose({ fixture: fx });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Create a run",
        },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly featureFlags?: Record<string, boolean>;
    };

    expect(executionContext.featureFlags).toMatchObject({
      [FeatureSwitchKey.ComputerUse]: true,
      [FeatureSwitchKey.SandboxIoLimiters]: true,
    });
  });

  it("stores vars, secret names, additional volumes, and encrypted runner secrets", async () => {
    const fx = await fixture();
    const docsVersion = await seedStorage({
      fixture: fx,
      type: "volume",
      name: "docs",
    });
    const compose = await createCompose({
      fixture: fx,
      overrides: {
        environment: {
          ANTHROPIC_API_KEY: "test-key",
          MY_VAR: vm0Template("{{ vars.MY_VAR }}"),
          API_KEY: vm0Template("{{ secrets.API_KEY }}"),
        },
      },
    });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Use env",
          vars: { MY_VAR: "value" },
          secrets: { API_KEY: "secret-value" },
          additionalVolumes: [
            { name: "docs", version: docsVersion, mountPath: "/mnt/docs" },
          ],
        },
      }),
      [201],
    );

    expect(response.body).toMatchObject({ status: "pending" });

    const db = store.set(writeDb$);
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    expect(run?.vars).toStrictEqual({ MY_VAR: "value" });
    expect(run?.secretNames).toStrictEqual(["API_KEY"]);
    expect(run?.additionalVolumes).toStrictEqual([
      { name: "docs", version: docsVersion, mountPath: "/mnt/docs" },
    ]);

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
      readonly storageManifest: {
        readonly storages: readonly {
          readonly name: string;
          readonly mountPath: string;
          readonly vasVersionId: string;
        }[];
      };
    };
    expect(executionContext.environment).toMatchObject({
      MY_VAR: "value",
      API_KEY: "secret-value",
    });
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toStrictEqual({
      API_KEY: "secret-value",
    });
    expect(executionContext.storageManifest.storages).toMatchObject([
      { name: "docs", mountPath: "/mnt/docs", vasVersionId: docsVersion },
    ]);
    expect(runContextSnapshot(response.body.runId)).toMatchObject({
      secretNames: ["API_KEY"],
      environment: {
        MY_VAR: "value",
        API_KEY: "***",
      },
      volumes: [
        { name: "docs", mountPath: "/mnt/docs", vasVersionId: docsVersion },
      ],
    });
  });

  it("stores the user timezone in the runner context", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    await db.insert(orgMembersMetadata).values({
      orgId: fx.orgId,
      userId: fx.userId,
      timezone: "Asia/Tokyo",
    });
    const compose = await createCompose({ fixture: fx });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Use timezone",
        },
      }),
      [201],
    );

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    const executionContext = job?.executionContext as {
      readonly userTimezone?: string;
    };
    expect(executionContext.userTimezone).toBe("Asia/Tokyo");
  });

  it("uses explicit volume version overrides when building the storage manifest", async () => {
    const fx = await fixture();
    const overrideVersion = await seedStorage({
      fixture: fx,
      type: "volume",
      name: "docs",
      versionId: "2222222222222222",
    });
    const compose = await createCompose({
      fixture: fx,
      overrides: {
        volumes: ["docs:/mnt/docs"],
      },
      volumes: {
        docs: {
          name: "docs",
          version: "1111111111111111",
        },
      },
    });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Use volume",
          volumeVersions: { docs: overrideVersion },
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
      readonly storageManifest: {
        readonly storages: readonly {
          readonly name: string;
          readonly mountPath: string;
          readonly vasVersionId: string;
        }[];
      };
    };
    expect(executionContext.storageManifest.storages).toMatchObject([
      {
        name: "docs",
        mountPath: "/mnt/docs",
        vasVersionId: overrideVersion,
      },
    ]);
  });

  it("expands api-token connector firewall vars and masks connector env secrets with placeholders", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    await db.insert(variables).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "ZENDESK_SUBDOMAIN",
      value: "acme",
    });
    await db.insert(variables).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "ZENDESK_EMAIL",
      value: "agent@example.com",
    });
    await db.insert(secretsTable).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "ZENDESK_API_TOKEN",
      encryptedValue: encryptSecretForTests("zendesk-real-token"),
      type: "user",
    });
    const compose = await createCompose({
      fixture: fx,
      overrides: {
        environment: {
          ANTHROPIC_API_KEY: "test-key",
          ZENDESK_API_TOKEN: vm0Template("{{ secrets.ZENDESK_API_TOKEN }}"),
        },
      },
    });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Use zendesk",
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
      readonly firewalls: readonly {
        readonly name: string;
        readonly apis: readonly { readonly base: string }[];
      }[];
    };
    expect(executionContext.environment.ZENDESK_API_TOKEN).toBe(
      "zkTkn_CoffeeSafeLocalCoffeeSafeLocalCoffeeSa",
    );
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      ZENDESK_API_TOKEN: "zendesk-real-token",
    });
    const zendesk = executionContext.firewalls.find((firewall) => {
      return firewall.name === "zendesk";
    });
    expect(zendesk?.apis[0]?.base).toBe("https://acme.zendesk.com");
  });

  it("accepts OAuth connector-provided env secrets during compose validation", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    await db.insert(connectors).values({
      orgId: fx.orgId,
      userId: fx.userId,
      type: "github",
      authMethod: "oauth",
    });
    await db.insert(secretsTable).values({
      orgId: fx.orgId,
      userId: fx.userId,
      name: "GITHUB_ACCESS_TOKEN",
      encryptedValue: encryptSecretForTests("github-real-token"),
      type: "connector",
    });
    const compose = await createCompose({
      fixture: fx,
      overrides: {
        environment: {
          ANTHROPIC_API_KEY: "test-key",
          GITHUB_TOKEN: vm0Template("{{ secrets.GITHUB_TOKEN }}"),
        },
      },
    });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Use GitHub",
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
    expect(executionContext.environment.GITHUB_TOKEN).toBe(
      "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",
    );
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      GITHUB_TOKEN: "github-real-token",
    });
  });

  it("injects an org model provider when the compose omits a framework API key", async () => {
    const fx = await fixture();
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fx.orgId,
        type: "anthropic-api-key",
        isDefault: true,
        selectedModel: "claude-sonnet-4-6",
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    await trackModelProviders(Promise.resolve({ orgId: fx.orgId }));
    const compose = await createCompose({
      fixture: fx,
      overrides: { environment: {} },
    });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Use provider",
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
      readonly billableFirewalls: readonly string[];
      readonly modelUsageProvider: string | undefined;
    };
    expect(executionContext.environment).toMatchObject({
      ANTHROPIC_API_KEY: "test-secret-value",
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
    });
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      ANTHROPIC_API_KEY: "test-secret-value",
    });
    expect(executionContext.billableFirewalls).toStrictEqual([]);
    expect(executionContext.modelUsageProvider).toBeUndefined();
  });

  it("persists requested artifacts plus memory on the new session", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Seed artifacts",
          artifacts: [{ name: "artifact", mountPath: "/mnt/work" }],
        },
      }),
      [201],
    );

    const db = store.set(writeDb$);
    const [session] = await db
      .select({ artifacts: agentSessions.artifacts })
      .from(agentSessions)
      .where(eq(agentSessions.id, response.body.sessionId));
    expect(
      session?.artifacts
        .map((artifact) => {
          return artifact.name;
        })
        .sort(),
    ).toStrictEqual(["artifact", "memory"]);

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    expect(job).toBeDefined();
    const executionContext = job!.executionContext as {
      readonly storageManifest: {
        readonly artifacts: readonly {
          readonly mountPath: string;
          readonly vasStorageName: string;
          readonly archiveUrl: string;
          readonly manifestUrl?: string;
        }[];
      };
    };
    expect(
      executionContext.storageManifest.artifacts
        .map(
          (artifact): { readonly mountPath: string; readonly name: string } => {
            return {
              name: artifact.vasStorageName,
              mountPath: artifact.mountPath,
            };
          },
        )
        .sort((left, right) => {
          return left.name.localeCompare(right.name);
        }),
    ).toStrictEqual([
      { name: "artifact", mountPath: "/mnt/work" },
      {
        name: "memory",
        mountPath: "/home/user/.claude/projects/-home-user-workspace/memory",
      },
    ]);
    expect(
      executionContext.storageManifest.artifacts.every((artifact) => {
        return artifact.archiveUrl && artifact.manifestUrl;
      }),
    ).toBeTruthy();
  });

  it("includes compose artifacts and volumes in the runner storage manifest", async () => {
    const fx = await fixture();
    const volumeVersion = await seedStorage({
      fixture: fx,
      type: "volume",
      name: "knowledge-base",
    });
    const artifactVersion = await seedStorage({
      fixture: fx,
      type: "artifact",
      name: "compose-artifact",
    });
    const compose = await createCompose({
      fixture: fx,
      overrides: { volumes: ["kb:/mnt/kb"] },
      volumes: { kb: { name: "knowledge-base", version: "latest" } },
      artifacts: [{ name: "compose-artifact", mount_path: "/mnt/artifact" }],
    });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Use storage",
        },
      }),
      [201],
    );

    const db = store.set(writeDb$);
    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId));
    expect(job).toBeDefined();
    const executionContext = job!.executionContext as {
      readonly storageManifest: {
        readonly storages: readonly {
          readonly name: string;
          readonly mountPath: string;
          readonly vasVersionId: string;
        }[];
        readonly artifacts: readonly {
          readonly mountPath: string;
          readonly vasStorageName: string;
          readonly vasVersionId: string;
        }[];
      };
    };

    expect(executionContext.storageManifest.storages).toMatchObject([
      { name: "kb", mountPath: "/mnt/kb", vasVersionId: volumeVersion },
    ]);
    expect(
      executionContext.storageManifest.artifacts
        .map((artifact) => {
          return {
            mountPath: artifact.mountPath,
            name: artifact.vasStorageName,
            version: artifact.vasVersionId,
          };
        })
        .sort((left, right) => {
          return left.name.localeCompare(right.name);
        }),
    ).toStrictEqual([
      {
        mountPath: "/mnt/artifact",
        name: "compose-artifact",
        version: artifactVersion,
      },
      {
        mountPath: "/home/user/.claude/projects/-home-user-workspace/memory",
        name: "memory",
        version: expect.any(String),
      },
    ]);
  });

  it("returns 404 for cross-org compose access", async () => {
    const owner = await fixture();
    const compose = await createCompose({ fixture: owner });
    const other = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(other.userId, other.orgId);

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "Try cross org",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects a simultaneous checkpoint and session continue request", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "bad resume",
          checkpointId: randomUUID(),
          sessionId: randomUUID(),
        },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "both checkpointId and sessionId",
    );
  });

  it("returns 429 when the org concurrency limit is reached", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });

    await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "first" },
      }),
      [201],
    );

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "second" },
      }),
      [429],
    );

    expect(response.body.error.code).toBe("CONCURRENT_RUN_LIMIT");
  });

  it("treats CONCURRENT_RUN_LIMIT_CAP=0 as unlimited", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");

    await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "first" },
      }),
      [201],
    );
    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "second" },
      }),
      [201],
    );

    expect(response.body.status).toBe("pending");
  });

  it("does not count stale pending runs toward the concurrency limit", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    const db = store.set(writeDb$);
    const [session] = await db
      .insert(agentSessions)
      .values({
        userId: fx.userId,
        orgId: fx.orgId,
        agentComposeId: compose.composeId,
      })
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("session insert returned no row");
    }
    await db.insert(agentRuns).values({
      userId: fx.userId,
      orgId: fx.orgId,
      agentComposeVersionId: compose.versionId,
      sessionId: session.id,
      prompt: "stale",
      status: "pending",
      createdAt: new Date(now() - 16 * 60 * 1000),
    });

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "fresh" },
      }),
      [201],
    );

    expect(response.body.status).toBe("pending");
  });

  it("allows two concurrent pro-tier runs", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    const db = store.set(writeDb$);
    await db
      .insert(orgMetadata)
      .values({ orgId: fx.orgId, tier: "pro" })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { tier: "pro" },
      });

    await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "first" },
      }),
      [201],
    );
    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "second" },
      }),
      [201],
    );

    expect(response.body.status).toBe("pending");
  });

  it("accepts sandbox tokens with any capability for create", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });

    const response = await accept(
      runsClient().create({
        headers: {
          authorization: `Bearer ${sandboxToken({
            userId: fx.userId,
            orgId: fx.orgId,
          })}`,
        },
        body: { agentComposeId: compose.composeId, prompt: "sandbox create" },
      }),
      [201],
    );

    expect(response.body.status).toBe("pending");
  });

  it("enforces the production captureNetworkBodies gate", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    mockEnv("ENV", "production");

    const rejected = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "capture",
          captureNetworkBodies: true,
        },
      }),
      [403],
    );
    expect(rejected.body.error.message).toContain("internal accounts");

    const db = store.set(writeDb$);
    await db.insert(userCache).values({
      userId: fx.userId,
      email: "engineer@vm0.ai",
      name: "Engineer",
      cachedAt: nowDate(),
    });

    const accepted = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "capture internal",
          captureNetworkBodies: true,
        },
      }),
      [201],
    );
    expect(accepted.body.status).toBe("pending");
  });

  it("returns 201 failed and persists the run when dispatch fails after insert", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "no runner" },
      }),
      [201],
    );

    expect(response.body.status).toBe("failed");
    expect(response.body.error).toContain("RUNNER_DEFAULT_GROUP");

    const db = store.set(writeDb$);
    const [run] = await db
      .select({ status: agentRuns.status, error: agentRuns.error })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    expect(run).toMatchObject({
      status: "failed",
      error: expect.stringContaining("RUNNER_DEFAULT_GROUP"),
    });
  });

  it("continues an existing session and reuses its session id", async () => {
    const fx = await fixture();
    const compose = await createCompose({
      fixture: fx,
      overrides: {
        environment: {
          ANTHROPIC_API_KEY: "test-key",
          TEST_VAR: vm0Template("{{ vars.testVar }}"),
        },
      },
    });
    const first = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentComposeId: compose.composeId,
          prompt: "first",
          vars: { testVar: "from-first-run" },
        },
      }),
      [201],
    );
    const conversationId = await store.set(
      seedConversationForSession$,
      { runId: first.body.runId, sessionId: first.body.sessionId },
      context.signal,
    );
    const db = store.set(writeDb$);
    await db
      .update(agentRuns)
      .set({ status: "completed", completedAt: nowDate() })
      .where(eq(agentRuns.id, first.body.runId));

    const continued = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionId: first.body.sessionId, prompt: "continue" },
      }),
      [201],
    );

    expect(continued.body.sessionId).toBe(first.body.sessionId);
    const [run] = await db
      .select({
        continuedFromSessionId: agentRuns.continuedFromSessionId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, continued.body.runId));
    expect(run?.continuedFromSessionId).toBe(first.body.sessionId);

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, continued.body.runId));
    expect(job).toBeDefined();
    const executionContext = job!.executionContext as {
      readonly resumeSession: { readonly sessionId: string };
      readonly environment: Record<string, string>;
    };
    expect(executionContext.resumeSession.sessionId).toBe(
      `session-${first.body.runId}`,
    );
    expect(executionContext.environment.TEST_VAR).toBe("from-first-run");
    expect(runContextSnapshot(continued.body.runId)).toMatchObject({
      runId: continued.body.runId,
      userId: fx.userId,
      prompt: "continue",
      sessionId: `session-${first.body.runId}`,
    });
    expect(conversationId).toBeDefined();
  });

  it("continues a session whose history is stored only in R2 (hash-only conversation)", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    const first = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "first" },
      }),
      [201],
    );

    const hash = "a".repeat(64);
    const sessionHistoryContent =
      '{"type":"init"}\n{"type":"human","text":"hi"}\n';

    await store.set(
      seedHashConversationForSession$,
      {
        runId: first.body.runId,
        sessionId: first.body.sessionId,
        hash,
      },
      context.signal,
    );
    const db = store.set(writeDb$);
    await db
      .update(agentRuns)
      .set({ status: "completed", completedAt: nowDate() })
      .where(eq(agentRuns.id, first.body.runId));

    context.mocks.s3.send.mockImplementation((cmd: unknown) => {
      const input = (cmd as { readonly input?: { readonly Key?: string } })
        .input;
      if (input?.Key === `blobs/${hash}.blob`) {
        return Promise.resolve({
          Body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(sessionHistoryContent, "utf8");
            },
          },
        });
      }
      return Promise.resolve({});
    });

    const continued = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionId: first.body.sessionId, prompt: "continue" },
      }),
      [201],
    );

    expect(continued.body.sessionId).toBe(first.body.sessionId);

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, continued.body.runId));
    expect(job).toBeDefined();
    const executionContext = job!.executionContext as {
      readonly resumeSession: {
        readonly sessionId: string;
        readonly sessionHistory: string;
      };
    };
    expect(executionContext.resumeSession.sessionId).toBe(
      `session-${first.body.runId}`,
    );
    expect(executionContext.resumeSession.sessionHistory).toBe(
      sessionHistoryContent,
    );
    expect(runContextSnapshot(continued.body.runId)).toMatchObject({
      runId: continued.body.runId,
      userId: fx.userId,
      prompt: "continue",
      sessionId: `session-${first.body.runId}`,
    });
  });

  it("resumes from a checkpoint and stores resumedFromCheckpointId", async () => {
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    const first = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentComposeId: compose.composeId, prompt: "first" },
      }),
      [201],
    );
    const conversationId = await store.set(
      seedConversationForSession$,
      { runId: first.body.runId, sessionId: first.body.sessionId },
      context.signal,
    );
    const db = store.set(writeDb$);
    await db
      .update(agentRuns)
      .set({ status: "completed", completedAt: nowDate() })
      .where(eq(agentRuns.id, first.body.runId));
    const [checkpoint] = await db
      .insert(checkpoints)
      .values({
        runId: first.body.runId,
        conversationId,
        agentComposeSnapshot: { agentComposeVersionId: compose.versionId },
        artifactSnapshots: [{ name: "artifact", mountPath: "/mnt/work" }],
        volumeVersionsSnapshot: { versions: { docs: "v1" } },
      })
      .returning({ id: checkpoints.id });
    if (!checkpoint) {
      throw new Error("checkpoint insert returned no row");
    }

    const response = await accept(
      runsClient().create({
        headers: { authorization: "Bearer clerk-session" },
        body: { checkpointId: checkpoint.id, prompt: "resume" },
      }),
      [201],
    );

    const [run] = await db
      .select({
        resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId));
    expect(run?.resumedFromCheckpointId).toBe(checkpoint.id);
  });
});
