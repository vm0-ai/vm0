import { createHash, randomUUID } from "node:crypto";

import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  UNKNOWN_PERMISSION_GRANT,
  type ExecutionFirewallEntry,
  type FirewallApi,
} from "@vm0/connectors/firewall-types";
import { getConnectorFirewall } from "@vm0/connectors/firewalls";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { assistantMessageIdForRunEvent } from "../../services/assistant-message-id";
import { settle } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import {
  callbackDeliveryWithStatus,
  createWebhookCallbackApi,
} from "./helpers/api-bdd-webhooks";

/**
 * RUN-01..04 and CHAIN-RUN: successful run dispatch and lifecycle.
 *
 * The billing entitlement Given uses the public Stripe webhook contract
 * (invoice.paid for a mocked subscription) and verifies the grant through the
 * billing status API, so no DB fixtures are involved.
 */

const context = testContext();

// Sentinel provider id for model-first thread selections (the wire-protocol
// value the chat composer sends when picking a model instead of a provider).
const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

function modelProviderPlaceholder(
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

function connectorPlaceholder(
  type: Parameters<typeof getConnectorFirewall>[0],
  secretName: string,
): string {
  const placeholder = getConnectorFirewall(type)?.placeholders?.[secretName];
  if (!placeholder) {
    throw new Error(`Missing connector placeholder for ${secretName}`);
  }
  return placeholder;
}

function firewallEntryName(entry: ExecutionFirewallEntry): string {
  return entry.kind === "builtin" ? entry.name : entry.firewall.name;
}

function findFirewallEntry(
  entries: readonly ExecutionFirewallEntry[] | undefined,
  name: string,
): ExecutionFirewallEntry | undefined {
  return entries?.find((entry) => {
    return firewallEntryName(entry) === name;
  });
}

function inlineFirewallApis(
  entries: readonly ExecutionFirewallEntry[] | undefined,
  name: string,
): readonly FirewallApi[] {
  const entry = findFirewallEntry(entries, name);
  if (!entry || entry.kind !== "inline") {
    throw new Error(`Expected inline firewall entry: ${name}`);
  }
  return entry.firewall.apis;
}

async function waitForRunStatus(
  api: ReturnType<typeof createRunsAutomationsApi>,
  actor: ApiTestUser,
  runId: string,
  status: string,
) {
  await expect
    .poll(async () => {
      return (await api.readRun(actor, runId)).status;
    })
    .toBe(status);
  return await api.readRun(actor, runId);
}

async function waitForRunQueueLength(
  api: ReturnType<typeof createRunsAutomationsApi>,
  actor: ApiTestUser,
  length: number,
) {
  await expect
    .poll(async () => {
      return (await api.readRunQueue(actor)).body.queue.length;
    })
    .toBe(length);
  return await api.readRunQueue(actor);
}

async function waitForArrayLength<T>(
  items: readonly T[],
  length: number,
): Promise<void> {
  await expect
    .poll(() => {
      return items.length;
    })
    .toBe(length);
}

async function waitForCallbackDeliveryWithStatus(
  deliveries: readonly ReturnType<typeof callbackDeliveryWithStatus>[],
  status: "completed" | "failed" | "progress",
): Promise<ReturnType<typeof callbackDeliveryWithStatus>> {
  let delivery: ReturnType<typeof callbackDeliveryWithStatus> | undefined;
  await expect
    .poll(async () => {
      const result = await settle(
        Promise.resolve().then(() => {
          return callbackDeliveryWithStatus(deliveries, status);
        }),
      );
      delivery = result.ok ? result.value : undefined;
      return delivery !== undefined;
    })
    .toBe(true);
  if (!delivery) {
    throw new Error(`Expected a captured ${status} callback delivery`);
  }
  return delivery;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${base64UrlEncode(JSON.stringify(payload))}.bdd-signature`;
}

/**
 * Wire-shape `~/.codex/auth.json` paste payload for the personal
 * codex-oauth-token provider upsert (the server parses and never stores it).
 */
function codexAuthJson(): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: unsignedJwt({ exp: accessExp }),
      refresh_token: "rt_bdd_personal_high_entropy",
      account_id: "ws_acct_bdd",
      id_token: unsignedJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "ws_acct_bdd_id_token",
          chatgpt_plan_type: "plus",
          organization: { title: "BDD Personal" },
        },
        exp: accessExp,
      }),
    },
  });
}

async function entitledRunActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly granted: {
    readonly customerId: string;
    readonly subscriptionId: string;
  };
}> {
  const bdd = createBddApi(context);
  const api = createRunsAutomationsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  const granted = await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD lifecycle agent",
    description: "Exercises the full run lifecycle.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, granted };
}

const CHAT_CALLBACK_URL = "http://localhost:3000/api/internal/callbacks/chat";

function proxyChatCallbackToApp(): void {
  server.use(
    http.post(CHAT_CALLBACK_URL, async ({ request }) => {
      const app = createApp({ signal: context.signal });
      return await app.request("/api/internal/callbacks/chat", {
        method: "POST",
        headers: request.headers,
        body: await request.text(),
      });
    }),
  );
}

async function sendChatRunMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const chat = createChatFilesBddApi(context);
  const sent = await chat.requestSendMessage(
    actor,
    { ...body, modelProvider: "anthropic-api-key" },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

function assistantOutputEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    eventType: "assistant",
    sequenceNumber,
    eventData: { message: { content: [{ type: "text", text }] } },
  };
}

describe("CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks", () => {
  it("creates, dispatches, claims, reports, and completes a run through public APIs", async () => {
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const created = await api.createRun(actor, {
      agentId,
      prompt: "summarize the repository",
      modelProvider: "anthropic-api-key",
    });
    expect(created.status).toBe("pending");
    expect(created.sessionId).toMatch(/[0-9a-f-]{36}/);

    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.tier).toBe("pro");
    expect(queue.body.concurrency.active).toBe(1);

    await api.heartbeatRunner(runnerGroup);
    const poll = await api.pollRunner(runnerGroup);
    expect(poll.body.job?.runId).toBe(created.runId);
    expect(poll.body.job?.experimentalProfile).toBe("vm0/default");

    const claim = await api.claimRunnerJob(created.runId);
    expect(claim.sandboxToken).not.toBe("");
    expect(claim.prompt).toBe("summarize the repository");
    expect(claim.environment).toMatchObject({
      ANTHROPIC_API_KEY: expect.stringMatching(/.+/),
    });
    expect(claim.cliAgentType).toBe("claude-code");

    const running = await api.readRun(actor, created.runId);
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeDefined();

    const reclaimed = await api.requestClaimRunnerJob(
      true,
      created.runId,
      [404],
    );
    expectApiError(reclaimed.body);

    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };
    await webhooks.requestAgentHeartbeat(
      { runId: created.runId },
      sandboxHeaders,
      [200],
    );

    await webhooks.requestAgentTelemetry(
      {
        runId: created.runId,
        systemLog: "runner booted",
        metrics: [
          {
            ts: nowDate().toISOString(),
            cpu: 1,
            mem_used: 2,
            mem_total: 4,
            disk_used: 8,
            disk_total: 16,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    await webhooks.requestAgentEvents(
      {
        runId: created.runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      sandboxHeaders,
      [200],
    );

    const historyHash = createHash("sha256")
      .update(`bdd session history ${created.runId}`)
      .digest("hex");
    await webhooks.requestAgentCheckpoint(
      {
        runId: created.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${created.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      sandboxHeaders,
      [200],
    );

    await webhooks.requestAgentComplete(
      { runId: created.runId, exitCode: 0, lastEventSequence: 0 },
      sandboxHeaders,
      [200],
    );

    const completed = await api.readRun(actor, created.runId);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.result?.checkpointId).toBeDefined();

    const drained = await api.readRunQueue(actor);
    expect(drained.body.concurrency.active).toBe(0);

    const uncancellable = await api.requestCancelRun(
      actor,
      created.runId,
      [400],
    );
    expectApiError(uncancellable.body);
  });

  it("resumes the previous session when a run is created with the same sessionId", async () => {
    const api = createRunsAutomationsApi(context);
    const { actor, agentId } = await entitledRunActor();

    const first = await api.createRun(actor, {
      agentId,
      prompt: "start a session",
      modelProvider: "anthropic-api-key",
    });

    const resumed = await api.createRun(actor, {
      agentId,
      sessionId: first.sessionId,
      prompt: "continue the session",
      modelProvider: "anthropic-api-key",
    });
    expect(resumed.sessionId).toBe(first.sessionId);

    const outsider = createBddApi(context).user();
    const crossUser = await api.requestCreateRun(
      outsider,
      {
        agentId,
        sessionId: first.sessionId,
        prompt: "steal the session",
        modelProvider: "anthropic-api-key",
      },
      [402, 404],
    );
    expectApiError(crossUser.body);

    await api.requestCancelRun(actor, resumed.runId, [200]);
    await api.requestCancelRun(actor, first.runId, [200]);
    const cancelled = await api.readRun(actor, first.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("RUN-01: admission boundaries beyond request validation", () => {
  it("rejects runs for onboarded organizations that never gained an entitlement", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.configureRunnerGroup();

    await bdd.setupOnboarding(actor, { displayName: "BDD Suspended Agent" });
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD suspended-org agent",
      description: "Covers the pro-suspend admission branch.",
      visibility: "private",
    });

    const rejected = await api.requestCreateRun(
      actor,
      {
        agentId: agent.agentId,
        prompt: "should be rejected",
        modelProvider: "anthropic-api-key",
      },
      [402],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");

    // The suspension applies to vm0-managed runs as well.
    const vm0Rejected = await api.requestCreateRun(
      actor,
      {
        agentId: agent.agentId,
        prompt: "should be rejected",
        modelProvider: "vm0",
      },
      [402],
    );
    expectApiError(vm0Rejected.body);
    expect(vm0Rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("queues runs over the concurrency limit and promotes them after cancellation", async () => {
    const api = createRunsAutomationsApi(context);
    const { actor, agentId } = await entitledRunActor();

    const first = await api.createRun(actor, {
      agentId,
      prompt: "active run one",
      modelProvider: "anthropic-api-key",
    });
    expect(first.status).toBe("pending");
    const second = await api.createRun(actor, {
      agentId,
      prompt: "active run two",
      modelProvider: "anthropic-api-key",
    });
    expect(second.status).toBe("pending");

    const third = await api.createRun(actor, {
      agentId,
      prompt: "queued run three",
      modelProvider: "anthropic-api-key",
    });
    expect(third.status).toBe("queued");

    const queued = await api.readRunQueue(actor);
    expect(queued.body.concurrency.active).toBe(2);
    expect(queued.body.queue).toHaveLength(1);
    expect(queued.body.queue[0]?.runId).toBe(third.runId);

    await api.requestCancelRun(actor, first.runId, [200]);

    const promoted = await waitForRunStatus(api, actor, third.runId, "pending");
    expect(promoted.status).toBe("pending");
    const drained = await waitForRunQueueLength(api, actor, 0);
    expect(drained.body.queue).toHaveLength(0);

    await api.requestCancelRun(actor, second.runId, [200]);
    await api.requestCancelRun(actor, third.runId, [200]);
    const emptied = await api.readRunQueue(actor);
    expect(emptied.body.concurrency.active).toBe(0);
  });

  it("removes cancelled runs from the claimable queue", async () => {
    const api = createRunsAutomationsApi(context);
    const { actor, agentId } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "cancel before claim",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, run.runId, [200]);

    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");

    const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expectApiError(claim.body);

    const missing = await api.requestClaimRunnerJob(true, randomUUID(), [404]);
    expectApiError(missing.body);
  });
});

describe("RUN-01: zero run request validation and token boundaries", () => {
  it("rejects invalid zero run requests and run-scoped tokens without agent-run:write", async () => {
    const api = createRunsAutomationsApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const unauthenticated = await api.requestCreateRun(
      null,
      { agentId: randomUUID(), prompt: "hello" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missingAgent = await api.requestCreateRun(
      actor,
      { prompt: "hello" },
      [400],
    );
    expectApiError(missingAgent.body);
    expect(missingAgent.body.error.message).toBe("agentId is required");

    const policiesRejected = await api.requestCreateRunUnchecked(
      actor,
      {
        prompt: "hello",
        agentId: randomUUID(),
        permissionPolicies: { x: { policies: { "tweet.write": "allow" } } },
      },
      [400],
    );
    expectApiError(policiesRejected.body);
    expect(policiesRejected.body.error.code).toBe("BAD_REQUEST");
    expect(policiesRejected.body.error.message).toContain("permissionPolicies");

    for (const tools of [[""], ["   "], ["Bash,Read"], ["--help"], [" -x"]]) {
      const ambiguous = await api.requestCreateRun(
        actor,
        { prompt: "hello", agentId: randomUUID(), tools },
        [400],
      );
      expectApiError(ambiguous.body);
      expect(ambiguous.body.error.message).toContain("tools");
      expect(ambiguous.body.error.message).toContain("Claude tool name");
    }

    const missingSession = await api.requestCreateRun(
      actor,
      { prompt: "hello", sessionId: randomUUID() },
      [404],
    );
    expectApiError(missingSession.body);
    expect(missingSession.body.error.message).toBe("Session not found");

    // A claimed run exposes both run-scoped credentials: the agent-facing
    // zero token (in the compose environment) and the sandbox webhook token.
    // Neither carries agent-run:write, so nested run creation is forbidden.
    const run = await api.createRun(actor, {
      agentId,
      prompt: "issue run-scoped credentials",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    const zeroToken = claim.environment?.ZERO_TOKEN;
    if (!zeroToken) {
      throw new Error(
        "Expected claim.environment.ZERO_TOKEN to carry the run-scoped zero token",
      );
    }

    const zeroTokenRejected = await api.requestCreateRunAs(
      `Bearer ${zeroToken}`,
      { agentId, prompt: "nested run" },
      [403],
    );
    expectApiError(zeroTokenRejected.body);
    expect(zeroTokenRejected.body.error.message).toContain(
      "Missing required capability: agent-run:write",
    );

    const sandboxRejected = await api.requestCreateRunAs(
      `Bearer ${claim.sandboxToken}`,
      { agentId, prompt: "nested run" },
      [403],
    );
    expectApiError(sandboxRejected.body);
    expect(sandboxRejected.body.error.message).toContain(
      "Missing required capability: agent-run:write",
    );

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("limits private agents to their owner and infers the agent from a session", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const { actor, agentId } = await entitledRunActor();

    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const memberRejected = await api.requestCreateRun(
      member,
      { agentId, prompt: "run someone else's private agent" },
      [403],
    );
    expectApiError(memberRejected.body);
    expect(memberRejected.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );

    const first = await api.createRun(actor, {
      agentId,
      prompt: "open a session",
      modelProvider: "anthropic-api-key",
    });
    const inferred = await api.createRun(actor, {
      sessionId: first.sessionId,
      prompt: "continue without naming the agent",
      modelProvider: "anthropic-api-key",
    });
    expect(inferred.sessionId).toBe(first.sessionId);

    await api.requestCancelRun(actor, first.runId, [200]);
    await api.requestCancelRun(actor, inferred.runId, [200]);
    const drained = await api.readRunQueue(actor);
    expect(drained.body.concurrency.active).toBe(0);
  });
});

describe("RUN-02: model provider selection and vm0 admission", () => {
  it("gates vm0 runs on billing state and on unexpired credit grants", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);

    // An org that never went through onboarding has no billing state at all,
    // so vm0 runs are refused before provider resolution.
    const uninitialized = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.configureRunnerGroup();
    const bareAgent = await bdd.createAgent(uninitialized, {
      displayName: "BDD uninitialized-org agent",
      visibility: "private",
    });
    const noBilling = await api.requestCreateRun(
      uninitialized,
      { agentId: bareAgent.agentId, prompt: "vm0 run", modelProvider: "vm0" },
      [402],
    );
    expectApiError(noBilling.body);
    expect(noBilling.body.error.code).toBe("INSUFFICIENT_CREDITS");

    // The credit expiry is the subscription period end plus one month, so a
    // period that ended two months ago grants credits that are already
    // expired and never settled — vm0 admission fails whether or not a
    // managed key happens to resolve.
    const actor = bdd.user();
    await api.grantProEntitlement(actor, {
      periodEndUnix: Math.floor(now() / 1000) - 60 * 86_400,
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD expired-credits agent",
      visibility: "private",
    });
    const rejected = await api.requestCreateRun(
      actor,
      { agentId: agent.agentId, prompt: "vm0 run", modelProvider: "vm0" },
      [402],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("injects codex multi-auth provider credentials and proves them via firewall auth", async () => {
    const api = createRunsAutomationsApi(context);
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    await fw.seedOrgCodexProvider(actor, {
      accessToken: "chatgpt-access",
      refreshToken: "chatgpt-refresh",
      accountId: "workspace-id",
      idToken: "chatgpt-id-token",
      expiresIn: 3600,
    });

    const run = await api.createRun(actor, {
      agentId,
      prompt: "codex oauth provider",
      modelProvider: "codex-oauth-token",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    expect(claim.cliAgentType).toBe("codex");
    expect(claim.environment).toMatchObject({
      CHATGPT_ACCESS_TOKEN: modelProviderPlaceholder(
        "codex-oauth-token",
        "CHATGPT_ACCESS_TOKEN",
      ),
      CHATGPT_ACCOUNT_ID: modelProviderPlaceholder(
        "codex-oauth-token",
        "CHATGPT_ACCOUNT_ID",
      ),
      OPENAI_MODEL: "gpt-5.5",
    });
    expect(claim.environment).not.toHaveProperty("CHATGPT_REFRESH_TOKEN");
    expect(claim.environment).not.toHaveProperty("CHATGPT_ID_TOKEN");
    expect(claim.secretConnectorMap).toMatchObject({
      CHATGPT_ACCESS_TOKEN: "codex-oauth-token",
    });
    expect(claim.secretConnectorMap).not.toHaveProperty(
      "CHATGPT_REFRESH_TOKEN",
    );
    expect(
      claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toStrictEqual({
      sourceType: "model-provider",
      sourceUserId: "__org__",
      metadataKey: "codex-oauth-token",
    });
    expect(
      claim.firewalls?.map((firewall) => {
        return firewallEntryName(firewall);
      }),
    ).toContain("model-provider:codex-oauth-token");
    expect(claim.billableFirewalls).toStrictEqual([]);
    expect(claim.modelUsageProvider).toBe("gpt-5.5");

    // The encrypted secrets resolve to the seeded plaintext through the
    // firewall-auth webhook, which is the production read surface for them.
    if (!claim.encryptedSecrets) {
      throw new Error("Expected the codex claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
          "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected the codex firewall auth to resolve");
    }
    expect(resolved.body.headers).toStrictEqual({
      Authorization: "Bearer chatgpt-access",
      "ChatGPT-Account-ID": "workspace-id",
    });

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("uses the requested provider instead of the caller's personal default", async () => {
    const api = createRunsAutomationsApi(context);
    const misc = createMiscRoutesApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    await misc.upsertPersonalModelProvider(
      actor,
      { type: "claude-code-oauth-token", secret: "sk-ant-oat-bdd" },
      [200, 201],
    );

    const run = await api.createRun(actor, {
      agentId,
      prompt: "requested provider wins",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    expect(claim.cliAgentType).toBe("claude-code");
    expect(claim.environment?.ANTHROPIC_API_KEY).toBe(
      modelProviderPlaceholder("anthropic-api-key", "ANTHROPIC_API_KEY"),
    );
    expect(claim.environment?.ANTHROPIC_MODEL).toMatch(/.+/);
    expect(claim.environment).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claim.billableFirewalls).toStrictEqual([]);

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("runs thread-pinned member-scope providers and mounts codex custom skills", async () => {
    const api = createRunsAutomationsApi(context);
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const misc = createMiscRoutesApi(context);
    const { actor, runnerGroup } = await entitledRunActor();
    proxyChatCallbackToApp();

    const skillName = "bdd-codex-kit";
    await misc.createSkill(
      actor,
      skillName,
      "# BDD codex kit\nUse this skill for codex runs.",
      [201],
    );

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );

    // A member-scoped policy routes the gpt-5.4-mini model through the
    // personal provider; the org default stays on the anthropic provider.
    const orgProvider = await api.ensureOrgModelProvider(actor);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: orgProvider.providerId,
      },
      {
        // Member-scope routes resolve the provider per caller at run time,
        // so they must not pin a provider id.
        model: "gpt-5.4-mini",
        isDefault: false,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const agent = await bdd.createAgent(actor, {
      displayName: "BDD codex skills agent",
      visibility: "private",
      customSkills: [skillName],
    });
    const thread = await chat.createThread(actor, { agentId: agent.agentId });
    const sent = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId: thread.id,
        prompt: "run on the pinned member provider",
        modelSelection: {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: "gpt-5.4-mini",
        },
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the pinned chat send to create a run");
    }

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(sent.body.runId);
    expect(claim.cliAgentType).toBe("codex");
    expect(claim.environment?.OPENAI_MODEL).toBe("gpt-5.4-mini");
    expect(claim.environment?.CHATGPT_ACCESS_TOKEN).toBe(
      modelProviderPlaceholder("codex-oauth-token", "CHATGPT_ACCESS_TOKEN"),
    );
    expect(
      claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({
      sourceType: "model-provider",
      sourceUserId: actor.userId,
    });

    const mountPaths =
      claim.storageManifest?.storages.map((storage) => {
        return storage.mountPath;
      }) ?? [];
    expect(mountPaths).toContain(`/home/user/.codex/skills/${skillName}`);
    expect(
      mountPaths.some((mountPath) => {
        return mountPath.startsWith("/home/user/.claude/skills/");
      }),
    ).toBeFalsy();

    await api.requestCancelRun(actor, sent.body.runId, [200]);
    const cancelled = await api.readRun(actor, sent.body.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("RUN-02: stored connector injection into claimed runs", () => {
  it("injects oauth connector tokens with billable firewalls and resolvable secrets", async () => {
    const api = createRunsAutomationsApi(context);
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    await fw.seedTestConnector(actor, {
      connectorName: "x",
      authMethod: "oauth",
      accessToken: "x-bdd-access",
      refreshToken: "x-bdd-refresh",
    });
    const enabled = await api.enableAgentConnectors(actor, agentId, ["x"]);
    expect(enabled).toContain("x");

    const run = await api.createRun(actor, {
      agentId,
      prompt: "use the x connector",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    expect(claim.environment?.X_TOKEN).toBe(
      connectorPlaceholder("x", "X_TOKEN"),
    );
    expect(claim.environment).not.toHaveProperty("X_ACCESS_TOKEN");
    expect(claim.environment).not.toHaveProperty("X_REFRESH_TOKEN");
    expect(claim.secretConnectorMap).toMatchObject({ X_TOKEN: "x" });
    expect(claim.secretConnectorMap).not.toHaveProperty("X_REFRESH_TOKEN");
    expect(claim.secretConnectorMetadataMap ?? null).toBeNull();

    expect(
      claim.firewalls?.map((firewall) => {
        return firewallEntryName(firewall);
      }),
    ).toContain("x");
    expect(claim.billableFirewalls).toContain("x");
    expect(claim.networkPolicies?.x?.unknownPolicy).toBe("allow");

    // The stored access token is only readable through the firewall-auth
    // webhook with the claimed run's sandbox token.
    if (!claim.encryptedSecrets) {
      throw new Error("Expected the x claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: { Authorization: `Bearer \${{ secrets.X_TOKEN }}` },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected the x firewall auth to resolve");
    }
    expect(resolved.body.headers).toStrictEqual({
      Authorization: "Bearer x-bdd-access",
    });

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("injects manual-grant api-token connectors and their optional variables", async () => {
    const api = createRunsAutomationsApi(context);
    const connectors = createConnectorBddApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    await connectors.connectManualGrant(actor, "gitlab", "api-token", {
      GITLAB_TOKEN: "glpat-bdd",
    });
    await api.enableAgentConnectors(actor, agentId, ["gitlab"]);

    const withoutHost = await api.createRun(actor, {
      agentId,
      prompt: "use gitlab without the optional host",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const bareClaim = await api.claimRunnerJob(withoutHost.runId);
    expect(bareClaim.environment?.GITLAB_TOKEN).toBe(
      connectorPlaceholder("gitlab", "GITLAB_TOKEN"),
    );
    expect(bareClaim.environment).not.toHaveProperty("GITLAB_HOST");
    expect(bareClaim.secretConnectorMap).toMatchObject({
      GITLAB_TOKEN: "gitlab",
    });

    // Reconnecting with the optional variable threads it into the next run.
    await connectors.connectManualGrant(actor, "gitlab", "api-token", {
      GITLAB_TOKEN: "glpat-bdd",
      GITLAB_HOST: "gitlab.example.com",
    });
    const withHost = await api.createRun(actor, {
      agentId,
      prompt: "use gitlab with the optional host",
      modelProvider: "anthropic-api-key",
    });
    const hostClaim = await api.claimRunnerJob(withHost.runId);
    expect(hostClaim.environment?.GITLAB_TOKEN).toBe(
      connectorPlaceholder("gitlab", "GITLAB_TOKEN"),
    );
    expect(hostClaim.environment?.GITLAB_HOST).toBe("gitlab.example.com");

    await api.requestCancelRun(actor, withoutHost.runId, [200]);
    await api.requestCancelRun(actor, withHost.runId, [200]);
    const drained = await api.readRunQueue(actor);
    expect(drained.body.concurrency.active).toBe(0);
  });

  it("keeps refresh-owned connector secrets out of the sandbox environment", async () => {
    const api = createRunsAutomationsApi(context);
    const connectors = createConnectorBddApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    await connectors.connectManualGrant(actor, "lark", "api-token", {
      LARK_APP_ID: "lark-app-id",
      LARK_APP_SECRET: "lark-app-secret",
    });
    await api.enableAgentConnectors(actor, agentId, ["lark"]);

    const run = await api.createRun(actor, {
      agentId,
      prompt: "use lark before any cached access token exists",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    expect(claim.environment?.LARK_TOKEN).toBe(
      connectorPlaceholder("lark", "LARK_TOKEN"),
    );
    expect(claim.environment).not.toHaveProperty("LARK_APP_ID");
    expect(claim.environment).not.toHaveProperty("LARK_APP_SECRET");
    expect(claim.environment).not.toHaveProperty("LARK_ACCESS_TOKEN");
    expect(claim.secretConnectorMap).toMatchObject({ LARK_TOKEN: "lark" });

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("withholds platform secrets from the sandbox environment", async () => {
    const api = createRunsAutomationsApi(context);
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token-bdd");

    await fw.seedTestConnector(actor, {
      connectorName: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-bdd-access",
      refreshToken: "google-ads-bdd-refresh",
    });
    await api.enableAgentConnectors(actor, agentId, ["google-ads"]);

    const run = await api.createRun(actor, {
      agentId,
      prompt: "use google ads",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    expect(claim.environment).not.toHaveProperty("GOOGLE_ADS_DEVELOPER_TOKEN");
    expect(claim.secretConnectorMap).toMatchObject({
      GOOGLE_ADS_TOKEN: "google-ads",
    });
    expect(
      claim.firewalls?.map((firewall) => {
        return firewallEntryName(firewall);
      }),
    ).toContain("google-ads");

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("ignores plain user secrets named like connector tokens", async () => {
    const api = createRunsAutomationsApi(context);
    const authOrg = createAuthOrgAgentsBddApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    // axiom is enabled on the agent but never connected; a user secret with
    // the connector's token name must not impersonate the connector.
    await api.enableAgentConnectors(actor, agentId, ["axiom"]);
    await authOrg.setSecret(actor, {
      name: "AXIOM_TOKEN",
      value: "xaat-plain-user-secret",
    });

    const run = await api.createRun(actor, {
      agentId,
      prompt: "run without a connected axiom connector",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    expect(claim.environment).not.toHaveProperty("AXIOM_TOKEN");
    expect(
      claim.firewalls?.some((firewall) => {
        return firewallEntryName(firewall) === "axiom";
      }),
    ).toBeFalsy();

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("resolves compose secret references into direct run environments", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const authOrg = createAuthOrgAgentsBddApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);

    await authOrg.setSecret(actor, {
      name: "SHARED_TOKEN",
      value: "user-shared-secret",
    });
    const composeName = `bdd-secret-refs-${randomUUID().slice(0, 8)}`;
    const compose = await api.createCompose(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
          environment: {
            ANTHROPIC_API_KEY: "bdd-inline-key",
            EXTERNAL_TOKEN: `\${{ secrets.SHARED_TOKEN }}`,
          },
        },
      },
    });

    const run = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "resolve referenced secrets",
    });
    const claim = await api.claimRunnerJob(run.runId);
    expect(claim.environment?.EXTERNAL_TOKEN).toBe("user-shared-secret");
    expect(claim.secretValues).toContain("user-shared-secret");

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("RUN-02: custom connectors, grants, and network policies", () => {
  it("injects enabled custom connector firewalls with resolvable org secrets", async () => {
    const api = createRunsAutomationsApi(context);
    const connectors = createConnectorBddApi(context);
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const slug = `bdd-internal-${randomUUID().slice(0, 8)}`;
    const custom = await connectors.createCustomConnector(actor, {
      slug,
      displayName: "BDD Internal API",
      prefixes: ["https://*.internal.example.com/api/"],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
    });
    await connectors.setCustomConnectorSecret(
      actor,
      custom.id,
      "custom-secret-value",
    );
    await connectors.updateAgentCustomConnectors(actor, agentId, [custom.id]);

    const run = await api.createRun(actor, {
      agentId,
      prompt: "use the custom connector",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    const secretKey = `CUSTOM_${custom.id.replaceAll("-", "").toUpperCase()}`;
    const customApis = inlineFirewallApis(claim.firewalls, slug);
    expect(customApis[0]?.base).toBe(
      "https://{hostWildcard1}.internal.example.com/api/",
    );
    expect(customApis[0]?.auth?.headers?.Authorization).toBe(
      `Bearer \${{ secrets.${secretKey} }}`,
    );
    expect(claim.networkPolicies?.[slug]?.unknownPolicy).toBe("allow");

    if (!claim.encryptedSecrets) {
      throw new Error("Expected the custom claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer \${{ secrets.${secretKey} }}`,
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected the custom firewall auth to resolve");
    }
    expect(resolved.body.headers).toStrictEqual({
      Authorization: "Bearer custom-secret-value",
    });

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("keeps connector-owned vars out of custom connector base urls", async () => {
    const api = createRunsAutomationsApi(context);
    const authOrg = createAuthOrgAgentsBddApi(context);
    const connectors = createConnectorBddApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    await connectors.connectManualGrant(actor, "zendesk", "api-token", {
      ZENDESK_API_TOKEN: "zendesk-token-bdd",
      ZENDESK_EMAIL: "connector@example.com",
      ZENDESK_SUBDOMAIN: "connector-subdomain",
    });
    await api.enableAgentConnectors(actor, agentId, ["zendesk"]);
    await authOrg.setVariable(actor, {
      name: "ZENDESK_SUBDOMAIN",
      value: "user-subdomain",
    });

    // Custom connector prefixes are contract-validated as literal URLs, so
    // `${{ vars.* }}` templates are not API-constructible there; the var
    // boundary is asserted on the built-in zendesk firewall base instead.
    const slug = `bdd-vars-${randomUUID().slice(0, 8)}`;
    const custom = await connectors.createCustomConnector(actor, {
      slug,
      displayName: "BDD Vars Custom",
      prefixes: ["https://internal.example.com/api/"],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
    });
    await connectors.setCustomConnectorSecret(actor, custom.id, "custom-bdd");
    await connectors.updateAgentCustomConnectors(actor, agentId, [custom.id]);

    const run = await api.createRun(actor, {
      agentId,
      prompt: "expand custom and connector bases",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    const customApis = inlineFirewallApis(claim.firewalls, slug);
    expect(
      claim.firewalls?.map((firewall) => {
        return firewallEntryName(firewall);
      }),
    ).toContain("zendesk");
    expect(customApis[0]?.base).toBe("https://internal.example.com/api/");

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("applies, scopes, expires, and snapshots user permission grants", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const fw = createFirewallApi(context);
    const { actor, runnerGroup } = await entitledRunActor();

    // The grants agent is public so a same-org member can write their own
    // grants for it without being the owner.
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD grants agent",
    });
    const agentId = agent.agentId;
    await fw.seedTestConnector(actor, {
      connectorName: "slack",
      authMethod: "oauth",
      accessToken: "xoxb-bdd-grants",
    });
    await api.enableAgentConnectors(actor, agentId, ["slack"]);

    async function claimSlackPolicy(prompt: string): Promise<{
      readonly allow: readonly string[];
      readonly deny: readonly string[];
      readonly unknownPolicy?: string;
    }> {
      const run = await api.createRun(actor, {
        agentId,
        prompt,
        modelProvider: "anthropic-api-key",
      });
      const claim = await api.claimRunnerJob(run.runId);
      await api.requestCancelRun(actor, run.runId, [200]);
      const policy = claim.networkPolicies?.slack;
      if (!policy) {
        throw new Error("Expected a slack network policy on the claim");
      }
      return policy;
    }

    await api.heartbeatRunner(runnerGroup);
    const defaults = await claimSlackPolicy("no grants yet");
    expect(defaults.allow).toContain("channels:read");
    expect(defaults.allow).toContain("users:read");
    expect(defaults.deny).toContain("chat:write");
    expect(defaults.unknownPolicy).toBe("allow");

    // Grants across every expiry arm; the list API shows the stored expiry.
    await api.upsertUserPermissionGrant(actor, {
      agentId,
      connectorRef: "slack",
      permission: "chat:write",
      action: "allow",
      expiresIn: "1h",
    });
    await api.upsertUserPermissionGrant(actor, {
      agentId,
      connectorRef: "slack",
      permission: "files:read",
      action: "allow",
      expiresIn: "24h",
    });
    await api.upsertUserPermissionGrant(actor, {
      agentId,
      connectorRef: "slack",
      permission: "search:read",
      action: "allow",
      expiresIn: "7d",
    });
    await api.upsertUserPermissionGrant(actor, {
      agentId,
      connectorRef: "slack",
      permission: "groups:read",
      action: "allow",
    });
    const grants = await api.listUserPermissionGrants(actor, agentId);
    const expiryByPermission = new Map(
      grants.map((grant) => {
        return [grant.permission, grant.expiresAt];
      }),
    );
    expect(expiryByPermission.get("chat:write")).toStrictEqual(
      expect.any(String),
    );
    expect(expiryByPermission.get("files:read")).toStrictEqual(
      expect.any(String),
    );
    expect(expiryByPermission.get("search:read")).toStrictEqual(
      expect.any(String),
    );
    expect(expiryByPermission.get("groups:read")).toBeNull();

    // A same-org member's own grant never leaks into the owner's runs.
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    await api.upsertUserPermissionGrant(member, {
      agentId,
      connectorRef: "slack",
      permission: "files:write",
      action: "allow",
    });

    const granted = await claimSlackPolicy("granted permissions");
    expect(granted.allow).toContain("chat:write");
    expect(granted.allow).toContain("files:read");
    expect(granted.deny).not.toContain("chat:write");
    expect(granted.deny).toContain("files:write");

    // Two hours later the 1h grant is expired while the 24h grant holds.
    mockNow(now() + 2 * 3_600_000);
    const expired = await claimSlackPolicy("after the 1h grant expired");
    expect(expired.deny).toContain("chat:write");
    expect(expired.allow).toContain("files:read");

    // Unknown-permission grants flip only the unknown policy.
    await api.upsertUserPermissionGrant(actor, {
      agentId,
      connectorRef: "slack",
      permission: UNKNOWN_PERMISSION_GRANT,
      action: "deny",
    });
    const unknownDenied = await claimSlackPolicy("deny unknown permissions");
    expect(unknownDenied.unknownPolicy).toBe("deny");
    expect(unknownDenied.allow).toContain("channels:read");
    expect(unknownDenied.deny).toContain("chat:write");

    // The grant snapshot is baked into the queued run: flipping the grant
    // after creation does not change the already-created run's policy.
    await api.upsertUserPermissionGrant(actor, {
      agentId,
      connectorRef: "slack",
      permission: "chat:write",
      action: "allow",
    });
    const snapshotRun = await api.createRun(actor, {
      agentId,
      prompt: "snapshot the grant state",
      modelProvider: "anthropic-api-key",
    });
    await api.upsertUserPermissionGrant(actor, {
      agentId,
      connectorRef: "slack",
      permission: "chat:write",
      action: "deny",
    });
    const snapshotClaim = await api.claimRunnerJob(snapshotRun.runId);
    expect(snapshotClaim.networkPolicies?.slack?.allow).toContain("chat:write");
    expect(snapshotClaim.networkPolicies?.slack?.deny).not.toContain(
      "chat:write",
    );

    await api.requestCancelRun(actor, snapshotRun.runId, [200]);
    const drained = await api.readRunQueue(actor);
    expect(drained.body.concurrency.active).toBe(0);
  });
});

describe("RUN-01: zero runner context, queue promotion, and skills", () => {
  it("injects agent identity, tool hints, and user info into the runner context", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const runnerGroup = api.configureRunnerGroup();

    await bdd.setupOnboarding(actor, {
      displayName: "BDD Context Agent",
      timezone: "America/Los_Angeles",
    });
    // Reading the current user caches the Clerk name/email used by the
    // run context's user-info section.
    await bdd.readMe(actor);
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Research Bot",
      description: "Finds release details",
      sound: "direct",
      visibility: "private",
    });

    const run = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "summarize release",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);

    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(appendSystemPrompt).toContain("# Agent Identity");
    expect(appendSystemPrompt).toContain("Your name is Research Bot.");
    expect(appendSystemPrompt).toContain("Your role: Finds release details");
    expect(appendSystemPrompt).toContain(
      "Be brief and to the point. Skip pleasantries and filler",
    );
    expect(appendSystemPrompt).toContain("# Agent Tools");
    for (const toolHint of [
      "zero web download-file -h",
      "Localhost URLs, local dev server ports, and processes started inside the agent runtime are generally only reachable inside that runtime",
      "`agent-browser` for browser automation and inspection",
      "Local dev servers are useful for agent-side verification",
      "For static web artifacts, Zero provides `zero host <dir> --site <slug> [--spa]` to publish a directory containing `index.html` to a public URL that users can open; for HTML presentations, include `--artifact-kind presentation-html`",
      "For apps or services that require a long-running backend, database, worker, external service, or framework-specific runtime",
      "for HTML presentations, include `--artifact-kind presentation-html`; run `zero host --help`",
      "zero connector status <type>",
      "zero doctor check-connector --help",
      "zero generate -h",
      "zero doctor credit",
      "zero credit <credits>",
      "zero doctor permission-deny --help",
      "zero doctor permission-change --help",
      "--duration 1h|24h|7d|always",
      "zero skill --help",
      "zero developer-support --help",
      "zero maps --help",
    ]) {
      expect(appendSystemPrompt).toContain(toolHint);
    }
    for (const otherIntegrationHint of [
      "zero slack download-file -h",
      "zero github download-file -h",
      "zero telegram download-file -h",
      "zero phone download-file -h",
    ]) {
      expect(appendSystemPrompt).not.toContain(otherIntegrationHint);
    }
    expect(appendSystemPrompt).toContain("# Current User Info");
    expect(appendSystemPrompt).toContain("Name: BDD User");
    expect(appendSystemPrompt).toContain(`Email: ${actor.email}`);
    expect(appendSystemPrompt).toContain("Timezone: America/Los_Angeles");

    expect(claim.disallowedTools).toStrictEqual([
      "CronCreate",
      "CronList",
      "CronDelete",
      "ScheduleWakeup",
      "AskUserQuestion",
      "Skill(loop)",
      "Skill(loop *)",
    ]);
    expect(claim.environment?.ZERO_AGENT_ID).toBe(agent.agentId);
    const zeroToken = claim.environment?.ZERO_TOKEN;
    expect(zeroToken).toMatch(/^vm0_sandbox_/);
    if (!zeroToken) {
      throw new Error("Expected the claim to expose the zero token");
    }
    expect(claim.secretValues).toContain(zeroToken);

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it.each(["slack", "telegram", "email"] as const)(
    "does not add chat stream context to %s-triggered runs",
    async (triggerSource) => {
      const bdd = createBddApi(context);
      const api = createRunsAutomationsApi(context);
      const connectors = createConnectorBddApi(context);
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      api.acceptStorageDownloads();
      api.acceptTelemetryIngest();
      const runnerGroup = api.configureRunnerGroup();
      await api.grantProEntitlement(actor);
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.AssistantTextStreaming]: true,
      });

      const composeName = `bdd-${triggerSource}-stream-off`;
      const compose = await api.createCompose(actor, {
        version: "1",
        agents: {
          [composeName]: {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
          },
        },
      });

      const run = await api.createDirectRun(actor, {
        agentComposeId: compose.composeId,
        prompt: `${triggerSource} should not stream`,
        triggerSource,
      });
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.claimRunnerJob(run.runId);
      expect(claim).not.toHaveProperty("chatStreamChannel");
      expect(claim).not.toHaveProperty("chatStreamTopic");
      expect(claim).not.toHaveProperty("chatStreamToken");
      expect(context.mocks.ably.requestToken).not.toHaveBeenCalled();

      await api.requestCancelRun(actor, run.runId, [200]);
      const cancelled = await api.readRun(actor, run.runId);
      expect(cancelled.status).toBe("cancelled");
    },
  );

  it("promotes queued runs with feature flags and a fresh api start time", async () => {
    const api = createRunsAutomationsApi(context);
    const computerUse = createComputerUseBddApi(context);
    const connectors = createConnectorBddApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ComputerUse]: true,
      [FeatureSwitchKey.SandboxIoLimiters]: true,
    });

    const firstStartedAt = now();
    mockNow(firstStartedAt);
    const first = await api.createRun(actor, {
      agentId,
      prompt: "active run one",
      modelProvider: "anthropic-api-key",
    });
    const second = await api.createRun(actor, {
      agentId,
      prompt: "active run two",
      modelProvider: "anthropic-api-key",
    });
    const queued = await api.createRun(actor, {
      agentId,
      prompt: "queued run three",
      modelProvider: "anthropic-api-key",
    });
    expect(queued.status).toBe("queued");
    const queueState = await api.readRunQueue(actor);
    expect(queueState.body.queue[0]?.runId).toBe(queued.runId);

    // The promoted run's api start time is the promotion time, not the
    // original request time (both stay inside the pending-run TTL window).
    const promotedAt = firstStartedAt + 120_000;
    mockNow(promotedAt);
    await api.requestCancelRun(actor, first.runId, [200]);
    const promoted = await waitForRunStatus(
      api,
      actor,
      queued.runId,
      "pending",
    );
    expect(promoted.status).toBe("pending");

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(queued.runId);
    expect(claim.featureFlags).toMatchObject({
      [FeatureSwitchKey.ComputerUse]: true,
      [FeatureSwitchKey.SandboxIoLimiters]: true,
    });
    expect(claim.apiStartTime).toBe(promotedAt);

    // Even with the computer-use switch on, a run-scoped zero token issued
    // without a host binding cannot reach computer-use write routes.
    const zeroToken = claim.environment?.ZERO_TOKEN;
    if (!zeroToken) {
      throw new Error("Expected the promoted claim to expose the zero token");
    }
    const writeRejected =
      await computerUse.requestCreateComputerUseWriteCommand(
        { bearer: zeroToken },
        [403],
      );
    expectApiError(writeRejected.body);

    await api.requestCancelRun(actor, second.runId, [200]);
    await api.requestCancelRun(actor, queued.runId, [200]);
    const drained = await api.readRunQueue(actor);
    expect(drained.body.concurrency.active).toBe(0);
  });

  it("mounts custom skills for claude-code zero agents", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const misc = createMiscRoutesApi(context);
    const { actor, runnerGroup } = await entitledRunActor();

    const skillName = "bdd-claude-kit";
    await misc.createSkill(
      actor,
      skillName,
      "# BDD claude kit\nUse this skill in claude runs.",
      [201],
    );
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD claude skills agent",
      visibility: "private",
      customSkills: [skillName],
    });

    const run = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "use the custom skill",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    expect(claim.cliAgentType).toBe("claude-code");
    expect(
      claim.storageManifest?.storages.map((storage) => {
        return storage.mountPath;
      }),
    ).toContain(`/home/user/.claude/skills/${skillName}`);

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("RUN-03: cancellation of dispatched and terminal runs", () => {
  it("cancels a claimed running run and treats repeat cancellation as settled", async () => {
    const api = createRunsAutomationsApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "cancel while running",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    await api.claimRunnerJob(run.runId);

    const running = await api.readRun(actor, run.runId);
    expect(running.status).toBe("running");

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");

    const repeated = await api.requestCancelRun(actor, run.runId, [200]);
    expect(repeated.status).toBe(200);
  });
});

describe("RUN-03: user-runner protocol and runner authentication", () => {
  it("dispatches, scopes, and claims runs through user API keys", async () => {
    const api = createRunsAutomationsApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    const apiKey = await api.createApiKey(actor);
    const bearer = `Bearer ${apiKey.token}`;

    const first = await api.createRun(actor, {
      agentId,
      prompt: "user runner job one",
      modelProvider: "anthropic-api-key",
    });
    const polled = await api.requestPollRunnerAs(
      bearer,
      { group: runnerGroup, profiles: ["vm0/default"] },
      [200],
    );
    if (polled.status !== 200) {
      throw new Error("Expected the user runner poll to succeed");
    }
    expect(polled.body.job?.runId).toBe(first.runId);

    const claimed = await api.requestClaimRunnerJobAs(
      bearer,
      first.runId,
      [200],
      {
        telemetry: {
          jobDiscoveredToClaimRequestMs: 1234,
          localAdmissionToClaimRequestMs: 56,
          pollReason: "deferred",
        },
      },
    );
    if (claimed.status !== 200) {
      throw new Error("Expected the user runner claim to succeed");
    }
    expect(claimed.body.prompt).toBe("user runner job one");
    expect(claimed.body.sandboxToken).not.toBe("");
    expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
      "vm0-sandbox-op-log-dev",
      [
        expect.objectContaining({
          op_type: "job_discovered_to_claim_request",
          sandbox_type: "runner",
          run_id: first.runId,
          duration_ms: 1234,
          success: true,
          profile: "vm0/default",
          auth_type: "user",
          poll_reason: "deferred",
        }),
      ],
    );
    expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
      "vm0-sandbox-op-log-dev",
      [
        expect.objectContaining({
          op_type: "local_admission_to_claim_request",
          sandbox_type: "runner",
          run_id: first.runId,
          duration_ms: 56,
          success: true,
          profile: "vm0/default",
          auth_type: "user",
          poll_reason: "deferred",
        }),
      ],
    );
    const claimedRun = await api.readRun(actor, first.runId);
    expect(claimedRun.status).toBe("running");

    const second = await api.createRun(actor, {
      agentId,
      prompt: "user runner job two",
      modelProvider: "anthropic-api-key",
    });

    const outsider = createBddApi(context).user();
    const outsiderKey = await api.createApiKey(outsider);
    const outsiderBearer = `Bearer ${outsiderKey.token}`;
    const outsiderPoll = await api.requestPollRunnerAs(
      outsiderBearer,
      { group: runnerGroup, profiles: ["vm0/default"] },
      [200],
    );
    if (outsiderPoll.status !== 200) {
      throw new Error("Expected the outsider poll to succeed");
    }
    expect(outsiderPoll.body.job ?? null).toBeNull();
    const crossClaim = await api.requestClaimRunnerJobAs(
      outsiderBearer,
      second.runId,
      [403],
    );
    expectApiError(crossClaim.body);
    expect(crossClaim.body.error.message).toBe("Job does not belong to user");

    const tokenRequest = {
      keyName: "bdd-key",
      timestamp: 1_700_000_000_000,
      capability: `{"runner-group:${runnerGroup}":["subscribe"]}`,
      nonce: "bdd-nonce",
      mac: "bdd-mac",
    };
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
    const realtime = await api.requestRunnerRealtimeTokenAs(
      bearer,
      { group: runnerGroup },
      [200],
    );
    expect(realtime.body).toStrictEqual(tokenRequest);
    const deniedRealtime = await api.requestRunnerRealtimeTokenAs(
      bearer,
      { group: "wrong-org/default" },
      [403],
    );
    expectApiError(deniedRealtime.body);
    expect(deniedRealtime.body.error.message).toBe(
      "Only vm0/* runner groups are supported",
    );

    await api.requestCancelRun(actor, first.runId, [200]);
    await api.requestCancelRun(actor, second.runId, [200]);
    const settled = await api.readRunQueue(actor);
    expect(settled.body.concurrency.active).toBe(0);
  });

  it("rejects runner calls with malformed, revoked, or wrong runner credentials", async () => {
    const api = createRunsAutomationsApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const pollBody = { group: "vm0/bdd-auth", profiles: ["vm0/default"] };

    const rejectedAuthorizations = [
      "Basic vm0_official_credentials",
      "Bearer not-a-runner-token",
      "Bearer vm0_pat_not-a-valid-jwt",
      "Bearer vm0_official_too-short",
      `Bearer vm0_official_${"f".repeat(64)}`,
    ];
    for (const authorization of rejectedAuthorizations) {
      const poll = await api.requestPollRunnerAs(
        authorization,
        pollBody,
        [401],
      );
      expectApiError(poll.body);
      expect(poll.body.error.message).toBe("Authentication required");
    }

    const apiKey = await api.createApiKey(actor);
    const bearer = `Bearer ${apiKey.token}`;
    await api.requestPollRunnerAs(bearer, pollBody, [200]);

    await api.revokeApiKey(actor, apiKey.id);
    const revokedPoll = await api.requestPollRunnerAs(bearer, pollBody, [401]);
    expectApiError(revokedPoll.body);
    const revokedClaim = await api.requestClaimRunnerJobAs(
      bearer,
      randomUUID(),
      [401],
    );
    expectApiError(revokedClaim.body);
    expect(revokedClaim.body.error.message).toBe("Not authenticated");
    const revokedRealtime = await api.requestRunnerRealtimeTokenAs(
      bearer,
      { group: "vm0/bdd-auth" },
      [401],
    );
    expectApiError(revokedRealtime.body);
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });

  it("drops queued jobs whose runs reached a terminal state before the claim", async () => {
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "terminal before claim",
      modelProvider: "anthropic-api-key",
    });
    expect(run.status).toBe("pending");

    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
    };
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "sandbox crashed before claim",
        lastEventSequence: 0,
      },
      sandboxHeaders,
      [200],
    );
    const failed = await api.readRun(actor, run.runId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("sandbox crashed before claim");

    const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expectApiError(claim.body);
    expect(claim.body.error.message).toBe("Run not found");

    const reclaim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expectApiError(reclaim.body);
    expect(reclaim.body.error.message).toBe("Job not found in queue");
  });

  it("returns null claim secretValues for direct compose runs without stored secrets", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);

    // A plain compose carries inline environment values but no body, model
    // provider, or connector secrets, so no encrypted secrets map is stored
    // with the queued job.
    const composeName = `bdd-no-secrets-${randomUUID().slice(0, 8)}`;
    const compose = await api.createCompose(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });

    const run = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "claim without stored secrets",
    });
    expect(run.status).toBe("pending");

    const claim = await api.claimRunnerJob(run.runId);
    expect(claim.secretValues).toBeNull();
    expect(claim.prompt).toBe("claim without stored secrets");

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");

    // A compose pinned to a non-vm0 runner group fails dispatch at creation.
    const foreignName = `bdd-foreign-${randomUUID().slice(0, 8)}`;
    const foreignCompose = await api.createCompose(actor, {
      version: "1",
      agents: {
        [foreignName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
          experimental_runner: { group: "other/test" },
        },
      },
    });
    const failedRun = await api.createDirectRun(actor, {
      agentComposeId: foreignCompose.composeId,
      prompt: "dispatch to a foreign runner group",
    });
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toBe("Only vm0/* runner groups are supported");
  });
});

describe("HOOK-01/RUN-03: terminal run callbacks dispatch on cancellation", () => {
  it("delivers, fails, and retries chat run callbacks through cancellation side effects", async () => {
    const api = createRunsAutomationsApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, agentId } = await entitledRunActor();
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bdd-bypass");

    const rejectedDeliveries: {
      readonly body: string;
      readonly signature: string | null;
      readonly timestamp: string | null;
      readonly bypass: string | null;
    }[] = [];
    server.use(
      http.post(CHAT_CALLBACK_URL, async ({ request }) => {
        rejectedDeliveries.push({
          body: await request.text(),
          signature: request.headers.get("x-vm0-signature"),
          timestamp: request.headers.get("x-vm0-timestamp"),
          bypass: request.headers.get("x-vercel-protection-bypass"),
        });
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
    );

    const first = await sendChatRunMessage(actor, {
      agentId,
      prompt: "first cancellable chat run",
    });
    await api.requestCancelRun(actor, first.runId, [200]);

    const firstCancelled = await api.readRun(actor, first.runId);
    expect(firstCancelled.status).toBe("cancelled");
    await waitForArrayLength(rejectedDeliveries, 1);
    expect(rejectedDeliveries).toHaveLength(1);
    expect(rejectedDeliveries[0]).toMatchObject({
      signature: expect.stringMatching(/.+/),
      timestamp: expect.stringMatching(/^\d+$/),
      bypass: "bdd-bypass",
    });
    const rejectedBody: unknown = JSON.parse(
      rejectedDeliveries[0]?.body ?? "{}",
    );
    expect(rejectedBody).toMatchObject({
      callbackId: expect.stringMatching(/[0-9a-f-]{36}/),
      runId: first.runId,
      status: "failed",
      error: "Run cancelled",
      payload: { threadId: first.threadId, agentId },
    });

    let unreachableDispatches = 0;
    server.use(
      http.post(CHAT_CALLBACK_URL, () => {
        unreachableDispatches += 1;
        return HttpResponse.error();
      }),
    );

    const second = await sendChatRunMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "second cancellable chat run",
    });
    await api.requestCancelRun(actor, second.runId, [200]);

    const secondCancelled = await api.readRun(actor, second.runId);
    expect(secondCancelled.status).toBe("cancelled");
    await expect
      .poll(() => {
        return unreachableDispatches;
      })
      .toBe(1);
    expect(unreachableDispatches).toBe(1);

    proxyChatCallbackToApp();

    const third = await sendChatRunMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "third cancellable chat run",
    });
    await api.requestCancelRun(actor, third.runId, [200]);

    const thirdCancelled = await api.readRun(actor, third.runId);
    expect(thirdCancelled.status).toBe("cancelled");

    let cancelNote:
      | Awaited<ReturnType<typeof chat.listThreadMessages>>["messages"][number]
      | undefined;
    await expect
      .poll(async () => {
        const messages = await chat.listThreadMessages(actor, first.threadId);
        cancelNote = messages.messages.find((message) => {
          return message.role === "assistant" && message.runId === third.runId;
        });
        return cancelNote?.role;
      })
      .toBe("assistant");
    if (!cancelNote || cancelNote.role !== "assistant") {
      throw new Error(
        "Expected the delivered chat callback to append an assistant message",
      );
    }
    expect(cancelNote.runLifecycleEvent).toBe("cancelled");
    expect(cancelNote.content).toStrictEqual(expect.any(String));
  });
});

describe("HOOK-01: agent callback summaries through replayed deliveries", () => {
  const AGENT_CALLBACK_PATH = "/api/internal/callbacks/agent";
  const OPENROUTER_COMPLETIONS_URL =
    "https://openrouter.ai/api/v1/chat/completions";

  it("summarizes completed runs replayed through the agent callback route", async () => {
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    // The nested trigger-agent producer is not API-constructible (zero tokens
    // exclude agent-run:write), so this chain captures the real dispatcher
    // deliveries of a chat run and replays them into the agent path:
    // callbackRoute resolves the row by the body's callbackId, never by path,
    // so a legitimately signed delivery verifies on any callback route.
    const deliveries = webhooks.captureInternalCallbackDeliveries(
      "/api/internal/callbacks/chat",
    );
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const openRouterRequests: {
      readonly messages: readonly {
        readonly role: string;
        readonly content: string;
      }[];
    }[] = [];
    server.use(
      http.post(OPENROUTER_COMPLETIONS_URL, async ({ request }) => {
        openRouterRequests.push(
          (await request.json()) as (typeof openRouterRequests)[number],
        );
        return HttpResponse.json({
          choices: [{ message: { content: "Agent delegated the task." } }],
        });
      }),
    );

    const { runId } = await sendChatRunMessage(actor, {
      agentId,
      prompt: "Summarize the delegated research task.",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(runId);
    const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };

    // A sandbox heartbeat dispatches a progress delivery; replaying it hits
    // the agent route's non-completed early return without touching Axiom.
    await webhooks.requestAgentHeartbeat({ runId }, sandboxHeaders, [200]);
    const progressDelivery = await waitForCallbackDeliveryWithStatus(
      deliveries,
      "progress",
    );
    const queryCallsBeforeProgress =
      context.mocks.axiom.query.mock.calls.length;
    const progressReplay = await webhooks.replayInternalCallback(
      AGENT_CALLBACK_PATH,
      progressDelivery,
    );
    expect(progressReplay.status).toBe(200);
    await expect(progressReplay.json()).resolves.toStrictEqual({
      success: true,
    });
    expect(context.mocks.axiom.query.mock.calls).toHaveLength(
      queryCallsBeforeProgress,
    );

    const historyHash = createHash("sha256")
      .update(`bdd session history ${runId}`)
      .digest("hex");
    await webhooks.requestAgentCheckpoint(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-agent-cb-cli-${runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      { runId, exitCode: 0, lastEventSequence: 0 },
      sandboxHeaders,
      [200],
    );
    const completed = await api.readRun(actor, runId);
    expect(completed.status).toBe("completed");
    const completedDelivery = await waitForCallbackDeliveryWithStatus(
      deliveries,
      "completed",
    );

    // The agent route reads the run output back through the Axiom boundary.
    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = typeof args[0] === "string" ? args[0] : "";
      return Promise.resolve(
        apl.includes("agent-run-events")
          ? [
              {
                sequenceNumber: 0,
                eventType: "result",
                eventData: { result: "Delegated task finished cleanly." },
              },
            ]
          : [],
      );
    });

    // Without an OpenRouter key the summary generation is skipped silently.
    const noKeyReplay = await webhooks.replayInternalCallback(
      AGENT_CALLBACK_PATH,
      completedDelivery,
    );
    expect(noKeyReplay.status).toBe(200);
    await expect(noKeyReplay.json()).resolves.toStrictEqual({ success: true });
    expect(openRouterRequests).toHaveLength(0);

    // With a key the replay produces exactly one summarize completion call
    // carrying the agent trigger source and the run output.
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const summaryReplay = await webhooks.replayInternalCallback(
      AGENT_CALLBACK_PATH,
      completedDelivery,
    );
    expect(summaryReplay.status).toBe(200);
    await expect(summaryReplay.json()).resolves.toStrictEqual({
      success: true,
    });
    expect(openRouterRequests).toHaveLength(1);
    expect(openRouterRequests[0]?.messages[0]?.content).toContain(
      "Summarize the result of this agent agent run",
    );
    expect(openRouterRequests[0]?.messages[1]?.content).toContain(
      "Delegated task finished cleanly.",
    );

    const tamperedReplay = await webhooks.replayInternalCallback(
      AGENT_CALLBACK_PATH,
      completedDelivery,
      { signature: webhooks.tamperedSignature(completedDelivery) },
    );
    expect(tamperedReplay.status).toBe(401);

    context.mocks.axiom.query.mockReset();
    context.mocks.axiom.query.mockResolvedValue([]);
  });
});

describe("HOOK-02: event-consumer dispatch failures", () => {
  it("surfaces required event-consumer failures and recovers on retry", async () => {
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "report events",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };

    context.mocks.axiom.flush.mockResolvedValue(undefined);
    context.mocks.axiom.flush.mockRejectedValueOnce(new Error("axiom down"));
    const failed = await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      sandboxHeaders,
      [500],
    );
    expectApiError(failed.body);
    expect(failed.body.error.message).toContain(
      "Required event consumer dispatch failed",
    );

    const recovered = await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [{ type: "system", sequenceNumber: 1 }],
      },
      sandboxHeaders,
      [200],
    );
    expect(recovered.status).toBe(200);
  });
});

describe("HOOK-02/CHAT-02: assistant events reach optional chat consumers", () => {
  it("acknowledges late assistant events when completion cleanup already wrote the run sequence", async () => {
    const api = createRunsAutomationsApi(context);
    const chat = createChatFilesBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const chatCallbacks = createChatCallbacksApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    chatCallbacks.proxyChatCallbackToApp();

    const { runId, threadId } = await sendChatRunMessage(actor, {
      agentId,
      prompt: "bdd cleanup wins before late event",
    });

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(runId);
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };
    chatCallbacks.mockChatOutputEvents([
      assistantOutputEvent(0, "cleanup-first assistant text"),
    ]);

    const historyHash = createHash("sha256")
      .update(`bdd cleanup-first session history ${runId}`)
      .digest("hex");
    await webhooks.requestAgentCheckpoint(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cleanup-first-${runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      { runId, exitCode: 0, lastEventSequence: 0 },
      sandboxHeaders,
      [200],
    );

    await expect
      .poll(async () => {
        const page = await chat.listThreadMessages(actor, threadId);
        return page.messages.filter((message) => {
          return (
            message.role === "assistant" &&
            message.runId === runId &&
            message.content === "cleanup-first assistant text"
          );
        }).length;
      })
      .toBe(1);

    const late = await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_bdd_late_after_cleanup",
              content: [{ type: "text", text: "late streamed text" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    expect(late.status).toBe(200);

    const afterLate = await chat.listThreadMessages(actor, threadId);
    const assistantTexts = afterLate.messages.flatMap((message) => {
      return message.role === "assistant" &&
        message.runId === runId &&
        message.content
        ? [message.content]
        : [];
    });
    expect(assistantTexts).toContain("cleanup-first assistant text");
    expect(assistantTexts).not.toContain("late streamed text");
  }, 90_000);

  it("persists assistant events into the linked thread and swallows optional consumer failures", async () => {
    const api = createRunsAutomationsApi(context);
    const chat = createChatFilesBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    proxyChatCallbackToApp();

    const { runId, threadId } = await sendChatRunMessage(actor, {
      agentId,
      prompt: "bdd assistant events",
    });

    const pending = await api.readRun(actor, runId);
    expect(pending.status).toBe("pending");

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(runId);
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };

    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              id: "msg_bdd_1",
              content: [{ type: "text", text: "Hello from BDD events" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    const afterFirst = await chat.listThreadMessages(actor, threadId);
    const firstAssistant = afterFirst.messages.find((message) => {
      return message.role === "assistant" && message.runId === runId;
    });
    expect(firstAssistant?.id).toBe(
      assistantMessageIdForRunEvent(runId, "msg_bdd_1"),
    );
    expect(firstAssistant?.content).toBe("Hello from BDD events");

    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("chat assistant publish failed"),
    );
    const swallowed = await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 2,
            message: {
              id: "msg_bdd_2",
              content: [{ type: "text", text: "Survives optional failure" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    expect(swallowed.status).toBe(200);

    const afterSecond = await chat.listThreadMessages(actor, threadId);
    const persisted = afterSecond.messages.filter((message) => {
      return message.role === "assistant" && message.runId === runId;
    });
    expect(persisted).toHaveLength(2);
    expect(
      persisted.map((message) => {
        return message.content;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "Hello from BDD events",
        "Survives optional failure",
      ]),
    );

    // Codex item.completed batches persist only non-blank agent_message text.
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "item.completed",
            sequenceNumber: 3,
            item: {
              id: "item_bdd_3",
              type: "agent_message",
              text: "Codex follow-up note",
            },
          },
          {
            type: "item.completed",
            sequenceNumber: 4,
            item: {
              id: "cmd_bdd_4",
              type: "command_execution",
              command: "ls",
              exit_code: 0,
              output: "README.md",
            },
          },
          {
            type: "item.completed",
            sequenceNumber: 5,
            item: { id: "item_bdd_5", type: "agent_message", text: "   " },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    const afterCodex = await chat.listThreadMessages(actor, threadId);
    const codexPersisted = afterCodex.messages.filter((message) => {
      return message.role === "assistant" && message.runId === runId;
    });
    expect(codexPersisted).toHaveLength(3);
    expect(
      codexPersisted.map((message) => {
        return message.content;
      }),
    ).toContain("Codex follow-up note");

    // Assistant batches without visible text leave the thread unchanged.
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 6,
            message: {
              id: "msg_bdd_6",
              content: [
                { type: "tool_use", id: "tool_bdd_1", name: "bash", input: {} },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 7,
            message: {
              id: "msg_bdd_7",
              content: [{ type: "text", text: "" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    const afterSilent = await chat.listThreadMessages(actor, threadId);
    expect(
      afterSilent.messages.filter((message) => {
        return message.role === "assistant" && message.runId === runId;
      }),
    ).toHaveLength(3);

    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 8,
            message: {
              id: "msg_bdd_1",
              content: [{ type: "text", text: "Duplicate text" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    const afterDuplicate = await chat.listThreadMessages(actor, threadId);
    const duplicatedMessageId = assistantMessageIdForRunEvent(
      runId,
      "msg_bdd_1",
    );
    const matchingDuplicateRows = afterDuplicate.messages.filter((message) => {
      return message.role === "assistant" && message.id === duplicatedMessageId;
    });
    expect(matchingDuplicateRows).toHaveLength(1);
    expect(matchingDuplicateRows[0]?.content).toBe("Hello from BDD events");

    // Assistant text on a run without a chat thread changes no thread state.
    const threadsBefore = await chat.listThreads(actor);
    const detachedRun = await api.createRun(actor, {
      agentId,
      prompt: "report events without a thread",
      modelProvider: "anthropic-api-key",
    });
    const detachedClaim = await api.claimRunnerJob(detachedRun.runId);
    await webhooks.requestAgentEvents(
      {
        runId: detachedRun.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              id: "msg_bdd_detached",
              content: [{ type: "text", text: "No thread receives this" }],
            },
          },
        ],
      },
      { authorization: `Bearer ${detachedClaim.sandboxToken}` },
      [200],
    );
    const threadsAfter = await chat.listThreads(actor);
    expect(threadsAfter.threads).toHaveLength(threadsBefore.threads.length);

    await api.requestCancelRun(actor, detachedRun.runId, [200]);
    await api.requestCancelRun(actor, runId, [200]);
    const cancelled = await api.readRun(actor, runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("BILL-02: usage reads for an entitled organization with runs", () => {
  it("exposes usage runs, members, and processed usage events through public reads", async () => {
    const api = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "generate usage",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };

    await webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "github",
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await billing.processUsageEvents();

    const usageRuns = await billing.readUsageRuns(actor, [200]);
    if (usageRuns.status !== 200) {
      throw new Error("Expected usage runs read to succeed");
    }
    const listedRun = usageRuns.body.runs.find((entry) => {
      return entry.runId === run.runId;
    });
    expect(listedRun).toBeDefined();
    expect(listedRun?.prompt).toBe("generate usage");
    expect(usageRuns.body.pagination.total).toBeGreaterThanOrEqual(1);

    const members = await billing.readUsageMembers(actor);
    expect(members.body.period).not.toBeNull();

    const record = await billing.readUsageRecord(actor);
    expect(record.status).toBe(200);
  });

  it("aggregates usage members across organization users", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    const nonAdmin = bdd.user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });

    const forbidden = await billing.requestUsageMembers(nonAdmin, {}, [403]);
    expectApiError(forbidden.body);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");

    const invalidTimezone = await billing.requestUsageMembers(
      actor,
      { tz: "Not/A/Timezone" },
      [400],
    );
    expectApiError(invalidTimezone.body);
    expect(invalidTimezone.body.error.code).toBe("BAD_REQUEST");

    const beforeUsage = await billing.readUsageMembers(actor);
    expect(beforeUsage.body.period).not.toBeNull();
    expect(beforeUsage.body.members).toStrictEqual([]);

    const member = bdd.user({ orgId: actor.orgId });
    const memberAgent = await bdd.createAgent(member, {
      displayName: "BDD member usage agent",
      visibility: "private",
    });

    const actorRun = await api.createRun(actor, {
      agentId,
      prompt: "actor usage",
      modelProvider: "anthropic-api-key",
    });
    const memberRun = await api.createRun(member, {
      agentId: memberAgent.agentId,
      prompt: "member usage",
      modelProvider: "anthropic-api-key",
    });

    await api.heartbeatRunner(runnerGroup);
    const actorClaim = await api.claimRunnerJob(actorRun.runId);
    const memberClaim = await api.claimRunnerJob(memberRun.runId);

    await webhooks.requestAgentUsageEvent(
      {
        runId: actorRun.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "image",
            provider: "gpt-image-2",
            category: "output_image.low.standard",
            quantity: 1,
          },
        ],
      },
      { authorization: `Bearer ${actorClaim.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentUsageEvent(
      {
        runId: memberRun.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "image",
            provider: "gpt-image-2",
            category: "output_image.low.standard",
            quantity: 2,
          },
        ],
      },
      { authorization: `Bearer ${memberClaim.sandboxToken}` },
      [200],
    );
    await billing.processUsageEvents();

    const aggregated = await billing.readUsageMembers(actor, {
      range: "7d",
      tz: "UTC",
    });
    expect(aggregated.body.members).toHaveLength(2);
    expect(
      aggregated.body.members.map((entry) => {
        return entry.userId;
      }),
    ).toStrictEqual([member.userId, actor.userId]);
    expect(aggregated.body.members[0]).toMatchObject({
      userId: member.userId,
      email: expect.any(String),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      creditsCharged: 14,
    });
    expect(aggregated.body.members[1]).toMatchObject({
      userId: actor.userId,
      email: expect.any(String),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      creditsCharged: 7,
    });

    await api.requestCancelRun(actor, actorRun.runId, [200]);
    await api.requestCancelRun(member, memberRun.runId, [200]);
    const settled = await api.readRunQueue(actor);
    expect(settled.body.concurrency.active).toBe(0);
  });
});

describe("CHAIN-RUN: sandbox snapshot and telemetry reporting through run webhooks", () => {
  it("reports artifacts, volumes, model usage, and telemetry through sandbox webhooks", async () => {
    const api = createRunsAutomationsApi(context);
    const storages = createStoragesBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    // A committed volume version backs the versioned additional volume; the
    // scratch volume stays versionless and storage-less on purpose.
    const cacheVolume = `bdd-cache-${randomUUID().slice(0, 8)}`;
    const scratchVolume = `bdd-scratch-${randomUUID().slice(0, 8)}`;
    const cacheFile = {
      path: "cache.txt",
      hash: createHash("sha256")
        .update(`bdd cache ${cacheVolume}`)
        .digest("hex"),
      size: 9,
    };
    const cachePrepared = await storages.prepareStorage(actor, {
      storageName: cacheVolume,
      storageType: "volume",
      files: [cacheFile],
    });
    await storages.commitStorage(actor, {
      storageName: cacheVolume,
      storageType: "volume",
      versionId: cachePrepared.versionId,
      files: [cacheFile],
    });

    const created = await api.createRun(actor, {
      agentId,
      prompt: "report snapshots and telemetry",
      modelProvider: "anthropic-api-key",
      additionalVolumes: [
        {
          name: cacheVolume,
          version: cachePrepared.versionId,
          mountPath: "/cache",
        },
        { name: scratchVolume, mountPath: "/scratch" },
      ],
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(created.runId);
    const mountPaths =
      claim.storageManifest?.storages.map((storage) => {
        return storage.mountPath;
      }) ?? [];
    expect(mountPaths).toContain("/cache");
    const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };

    await webhooks.requestAgentTelemetry(
      {
        runId: created.runId,
        networkLogs: [
          {
            timestamp: nowDate().toISOString(),
            host: "api.example.test",
            port: 443,
            method: "GET",
            url: "https://api.example.test/v1/status",
            status: 200,
            latency_ms: 12,
            request_size: 100,
            response_size: 256,
          },
        ],
        sandboxOperations: [
          {
            ts: nowDate().toISOString(),
            action_type: "volume_mount",
            duration_ms: 8,
            success: false,
            error: "mount timed out",
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "sandbox-telemetry-network",
      [
        expect.objectContaining({
          runId: created.runId,
          host: "api.example.test",
          status: 200,
        }),
      ],
    );
    expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
      "vm0-sandbox-op-log-dev",
      [
        expect.objectContaining({
          op_type: "volume_mount",
          run_id: created.runId,
          success: false,
          error: "mount timed out",
          source: "sandbox",
        }),
      ],
    );

    const observed = await webhooks.requestAgentModelUsageObservation(
      {
        runId: created.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            model: "claude-sonnet-4-6",
            category: "tokens.input",
            quantity: 120,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    expect(observed.body).toStrictEqual({ success: true });

    const artifactSnapshots = [
      {
        name: "workspace",
        version: "a".repeat(64),
        mountPath: "/workspace",
      },
      {
        name: "site",
        version: "b".repeat(64),
        mountPath: "/site",
        missingRootPolicy: "preserveParentVersion" as const,
      },
    ];
    const historyHash = createHash("sha256")
      .update(`bdd snapshot history ${created.runId}`)
      .digest("hex");
    const checkpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: created.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-snapshot-cli-${created.runId}`,
        cliAgentSessionHistoryHash: historyHash,
        artifactSnapshots,
        volumeVersionsSnapshot: {
          versions: { [cacheVolume]: cachePrepared.versionId },
        },
      },
      sandboxHeaders,
      [200],
    );
    if (checkpoint.status !== 200) {
      throw new Error("Expected the snapshot checkpoint to succeed");
    }
    expect(checkpoint.body.artifacts).toStrictEqual(artifactSnapshots);
    expect(checkpoint.body.volumes).toStrictEqual({
      [cacheVolume]: cachePrepared.versionId,
    });

    await webhooks.requestAgentComplete(
      { runId: created.runId, exitCode: 0, lastEventSequence: 3 },
      sandboxHeaders,
      [200],
    );

    const completed = await api.readRun(actor, created.runId);
    expect(completed.status).toBe("completed");
    expect(completed.result?.artifact).toStrictEqual({
      workspace: "a".repeat(64),
      site: "b".repeat(64),
    });
    expect(completed.result?.volumes).toStrictEqual({
      [cacheVolume]: cachePrepared.versionId,
    });

    // A late duplicate report cannot flip the settled run.
    const duplicate = await webhooks.requestAgentComplete(
      {
        runId: created.runId,
        exitCode: 1,
        error: "late crash report",
        lastEventSequence: 9,
      },
      sandboxHeaders,
      [200],
    );
    if (duplicate.status !== 200) {
      throw new Error("Expected the duplicate completion to be accepted");
    }
    expect(duplicate.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    const settled = await api.readRun(actor, created.runId);
    expect(settled.status).toBe("completed");
    expect(settled.error ?? null).toBeNull();
  });
});

describe("RUN-03: sandbox completion reports against missing checkpoints and settled runs", () => {
  it("fails a clean exit whose run never reported a checkpoint", async () => {
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "complete without a checkpoint",
      modelProvider: "anthropic-api-key",
    });
    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
    };

    const missing = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
      sandboxHeaders,
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error.message).toBe("Checkpoint for run not found");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${run.runId}`,
      { status: "failed" },
    );
    const failed = await api.readRun(actor, run.runId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Checkpoint for run not found");
  });

  it("reports the settled status when a checkpoint-less completion races a cancellation", async () => {
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "cancel before the completion report",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, run.runId, [200]);

    const late = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
      { authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}` },
      [200],
    );
    if (late.status !== 200) {
      throw new Error("Expected the late completion to be acknowledged");
    }
    expect(late.body).toStrictEqual({ success: true, status: "failed" });
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("keeps a cancelled run settled when its checkpointed completion arrives late", async () => {
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "checkpoint, cancel, then complete",
      modelProvider: "anthropic-api-key",
    });
    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
    };
    const historyHash = createHash("sha256")
      .update(`bdd cancelled checkpoint ${run.runId}`)
      .digest("hex");
    await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cancelled-cli-${run.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      sandboxHeaders,
      [200],
    );
    await api.requestCancelRun(actor, run.runId, [200]);

    const late = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
      sandboxHeaders,
      [200],
    );
    if (late.status !== 200) {
      throw new Error(
        "Expected the checkpointed completion to be acknowledged",
      );
    }
    expect(late.body).toStrictEqual({ success: true, status: "failed" });
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("checkpoints direct compose runs without vars and canonicalizes usage by event model", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);

    // Direct compose runs created without vars leave the stored vars null,
    // and their zero-run rows carry no model provider or pinned model.
    const composeName = `bdd-null-vars-${randomUUID().slice(0, 8)}`;
    const compose = await api.createCompose(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });
    const run = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "checkpoint without vars",
    });
    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
    };

    // With no pinned model the event model drives canonicalization: the
    // unsupported event is skipped while the supported one is recorded.
    const observed = await webhooks.requestAgentModelUsageObservation(
      {
        runId: run.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            model: "claude-sonnet-4-6",
            category: "tokens.input",
            quantity: 50,
          },
          {
            idempotencyKey: randomUUID(),
            model: "custom-bdd-model",
            category: "tokens.output",
            quantity: 7,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    expect(observed.body).toStrictEqual({ success: true });

    const historyHash = createHash("sha256")
      .update(`bdd null vars checkpoint ${run.runId}`)
      .digest("hex");
    const checkpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-null-vars-cli-${run.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      sandboxHeaders,
      [200],
    );
    if (checkpoint.status !== 200) {
      throw new Error("Expected the null-vars checkpoint to succeed");
    }
    expect(checkpoint.body.artifacts).toBeUndefined();
    expect(checkpoint.body.volumes).toBeUndefined();

    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
      sandboxHeaders,
      [200],
    );
    const completed = await api.readRun(actor, run.runId);
    expect(completed.status).toBe("completed");
    expect(completed.result?.checkpointId).toBeDefined();
  });
});

describe("BILL-01: billing entitlement reconciliation cron", () => {
  function subscriptionEvent(args: {
    readonly subscriptionId: string;
    readonly customerId: string;
    readonly status: string;
    readonly periodEndUnix: number;
  }): unknown {
    return {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: args.subscriptionId,
          status: args.status,
          customer: args.customerId,
          cancel_at: args.periodEndUnix,
          cancel_at_period_end: false,
          schedule: null,
          trial_end: null,
          metadata: {},
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: args.periodEndUnix,
              },
            ],
          },
        },
      },
    };
  }

  async function failSubscription(args: {
    readonly subscriptionId: string;
    readonly customerId: string;
  }): Promise<void> {
    const webhooks = createWebhookCallbackApi(context);
    const event = subscriptionEvent({
      ...args,
      status: "past_due",
      periodEndUnix: Math.floor(now() / 1000) - 2 * 86_400,
    });
    webhooks.configureStripeWebhookSecret();
    webhooks.acceptNextStripeWebhookEvent(event);
    await webhooks.requestStripeWebhook(
      JSON.stringify(event),
      { "stripe-signature": "t=1,v1=bdd" },
      [200],
    );
  }

  it("recovers payment-failed subscriptions that became active again", async () => {
    const api = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const { actor, granted } = await entitledRunActor();
    await failSubscription(granted);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: "price_bdd_pro" },
            current_period_end: Math.floor(now() / 1000) + 30 * 86_400,
          },
        ],
      },
    });
    const unauthorizedReconcile = await api.reconcileBillingCron(false);
    expect(unauthorizedReconcile.status).toBe(401);
    await api.reconcileBillingCron(true);

    const status = await billing.readBillingStatus(actor);
    expect(status.tier).toBe("pro");

    await failSubscription(granted);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "incomplete",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: { data: [] },
    });
    await api.reconcileBillingCron(true);
    const skipped = await billing.readBillingStatus(actor);
    expect(skipped.tier).toBe("pro");
  });

  it("keeps recently paid-through subscriptions and downgrades stale ones", async () => {
    const api = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const { actor, granted } = await entitledRunActor();
    await failSubscription(granted);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "past_due",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: "price_bdd_pro" },
            current_period_end: Math.floor(now() / 1000) + 7 * 86_400,
          },
        ],
      },
    });
    await api.reconcileBillingCron(true);
    const synced = await billing.readBillingStatus(actor);
    expect(synced.tier).toBe("pro");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "past_due",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: "price_bdd_pro" },
            current_period_end: Math.floor(now() / 1000) - 2 * 86_400,
          },
        ],
      },
    });
    await failSubscription(granted);
    await api.reconcileBillingCron(true);

    const downgraded = await billing.readBillingStatus(actor);
    expect(downgraded.tier).not.toBe("pro");
  });

  it("clears cancelled subscriptions during reconciliation", async () => {
    const api = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const { actor, granted } = await entitledRunActor();
    await failSubscription(granted);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "canceled",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: { data: [] },
    });
    await api.reconcileBillingCron(true);

    const cleared = await billing.readBillingStatus(actor);
    expect(cleared.tier).not.toBe("pro");
  });
});
