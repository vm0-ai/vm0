import { randomUUID } from "node:crypto";

import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { generateZeroToken, verifyZeroToken } from "../../auth/tokens";
import {
  decryptSecretValue,
  decryptSecretsMap,
} from "../../services/crypto.utils";
import { writeDb$ } from "../../external/db";
import { nowDate } from "../../external/time";
import { clearAllDetached } from "../../utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { encryptSecretForTests } from "./helpers/encrypt-secret";

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

interface ChatMessageFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly versionId: string;
}

const track = createFixtureTracker<ChatMessageFixture>(deleteFixture);

function client() {
  return setupApp({ context })(chatMessagesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function proxyChatCallbackToApp(): void {
  server.use(
    http.post(
      "http://localhost:3000/api/internal/callbacks/chat",
      async ({ request }) => {
        const rawBody = await request.text();
        const app = createApp({ signal: context.signal });
        return await app.request("/api/internal/callbacks/chat", {
          method: "POST",
          headers: request.headers,
          body: rawBody,
        });
      },
    ),
  );
}

function encryptedSecretsFromExecutionContext(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "encryptedSecrets" in value
  ) {
    const encryptedSecrets = (value as { encryptedSecrets: unknown })
      .encryptedSecrets;
    return typeof encryptedSecrets === "string" ? encryptedSecrets : null;
  }
  return null;
}

function vm0Template(expression: string): string {
  return `$${expression}`;
}

async function seedFixture(): Promise<ChatMessageFixture> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const name = `agent-${agentId.slice(0, 8)}`;
  const writeDb = store.set(writeDb$);

  await writeDb.insert(agentComposes).values({
    id: agentId,
    userId,
    orgId,
    name,
    headVersionId: versionId,
  });
  await writeDb.insert(agentComposeVersions).values({
    id: versionId,
    composeId: agentId,
    createdBy: userId,
    content: {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: {
            ANTHROPIC_API_KEY: "test-key",
            ZERO_AGENT_ID: vm0Template("{{ vars.ZERO_AGENT_ID }}"),
            ZERO_TOKEN: vm0Template("{{ secrets.ZERO_TOKEN }}"),
          },
        },
      },
    },
  });
  await writeDb.insert(zeroAgents).values({
    id: agentId,
    orgId,
    owner: userId,
    name,
    visibility: "public",
  });
  await writeDb.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });

  mocks.clerk.session(userId, orgId);
  context.mocks.s3.send.mockResolvedValue({});
  mockEnv("VM0_API_URL", "http://localhost:3000");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");

  return { userId, orgId, agentId, versionId };
}

async function deleteFixture(fixture: ChatMessageFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  const threadRows = await writeDb
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.userId, fixture.userId));
  const threadIds = threadRows.map((row) => {
    return row.id;
  });
  const runRows = await writeDb
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, fixture.userId));
  const runIds = runRows.map((row) => {
    return row.id;
  });

  if (runIds.length > 0) {
    await writeDb
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
    await writeDb
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
  }
  if (threadIds.length > 0) {
    await writeDb
      .delete(chatMessages)
      .where(inArray(chatMessages.chatThreadId, threadIds));
  }
  if (runIds.length > 0) {
    await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  }
  await writeDb
    .delete(agentSessions)
    .where(eq(agentSessions.userId, fixture.userId));
  if (threadIds.length > 0) {
    await writeDb.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
  }
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await writeDb
    .delete(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, fixture.orgId));
  await writeDb
    .delete(modelProviders)
    .where(eq(modelProviders.orgId, fixture.orgId));
  await writeDb.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await writeDb.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, fixture.agentId));
  await writeDb.delete(zeroAgents).where(eq(zeroAgents.id, fixture.agentId));
  await writeDb
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, fixture.agentId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.agentId));
}

function send(body: Record<string, unknown>) {
  return accept(
    client().send({
      headers: authHeaders(),
      body: body as never,
    }),
    [201],
  );
}

async function firstUserMessage(threadId: string) {
  const [message] = await store
    .set(writeDb$)
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      runId: chatMessages.runId,
      revokesMessageId: chatMessages.revokesMessageId,
      interruptsRunId: chatMessages.interruptsRunId,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
    })
    .from(chatMessages)
    .where(eq(chatMessages.chatThreadId, threadId))
    .orderBy(chatMessages.createdAt)
    .limit(1);
  return message;
}

async function setRunStatus(
  runId: string,
  status: string,
  result?: unknown,
): Promise<void> {
  await store
    .set(writeDb$)
    .update(agentRuns)
    .set({ status, completedAt: nowDate(), ...(result ? { result } : {}) })
    .where(eq(agentRuns.id, runId));
}

async function runExecutionSecrets(runId: string) {
  const [job] = await store
    .set(writeDb$)
    .select({ executionContext: runnerJobQueue.executionContext })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  return decryptSecretsMap(
    encryptedSecretsFromExecutionContext(job?.executionContext),
  );
}

async function seedModelProvider(
  fixture: ChatMessageFixture,
  selectedModel: string,
  options: {
    readonly type?: string;
    readonly userId?: string;
    readonly isDefault?: boolean;
    readonly secretValue?: string;
  } = {},
): Promise<string> {
  const writeDb = store.set(writeDb$);
  const providerType = options.type ?? "anthropic-api-key";
  const providerUserId = options.userId ?? fixture.userId;
  const secretName =
    providerType === "deepseek-api-key"
      ? "DEEPSEEK_API_KEY"
      : "ANTHROPIC_API_KEY";
  const [secret] =
    providerType === "vm0"
      ? [undefined]
      : await writeDb
          .insert(secrets)
          .values({
            name: secretName,
            encryptedValue: encryptSecretForTests(
              options.secretValue ?? "test-provider-key",
            ),
            type: "model-provider",
            userId: providerUserId,
            orgId: fixture.orgId,
          })
          .returning({ id: secrets.id });
  const [provider] = await writeDb
    .insert(modelProviders)
    .values({
      type: providerType,
      secretId: secret?.id ?? null,
      isDefault: options.isDefault ?? true,
      selectedModel,
      userId: providerUserId,
      orgId: fixture.orgId,
    })
    .returning({ id: modelProviders.id });
  return provider!.id;
}

async function seedVm0ApiKey(
  fixture: ChatMessageFixture,
  model: string,
  options: {
    readonly vendor?: string;
    readonly apiModel?: string;
  } = {},
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(vm0ApiKeys)
    .values({
      vendor: options.vendor ?? "anthropic",
      model: options.apiModel ?? model,
      apiKey: `vm0-key-${model}`,
      label: fixture.agentId,
    });
}

async function removeComposeFrameworkApiKey(
  fixture: ChatMessageFixture,
): Promise<void> {
  await store
    .set(writeDb$)
    .update(agentComposeVersions)
    .set({
      content: {
        version: "1.0",
        agents: {
          zero: {
            framework: "claude-code",
            environment: {
              ZERO_AGENT_ID: vm0Template("{{ vars.ZERO_AGENT_ID }}"),
              ZERO_TOKEN: vm0Template("{{ secrets.ZERO_TOKEN }}"),
            },
          },
        },
      },
    })
    .where(eq(agentComposeVersions.id, fixture.versionId));
}

async function seedVm0Credits(
  fixture: ChatMessageFixture,
  credits: number,
  tier: OrgTier = "free",
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(orgMetadata)
    .values({
      orgId: fixture.orgId,
      credits,
      tier,
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { credits, tier, updatedAt: nowDate() },
    });
}

describe("POST /api/zero/chat/messages", () => {
  it("returns 401 without auth", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await accept(
      client().send({
        headers: {},
        body: { agentId: randomUUID(), prompt: "hello" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for a zero token without agent-run:write", async () => {
    const token = generateZeroToken(
      `user_${randomUUID()}`,
      randomUUID(),
      `org_${randomUUID()}`,
    );

    const response = await accept(
      client().send({
        headers: { authorization: `Bearer ${token}` },
        body: { agentId: randomUUID(), prompt: "hello" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("agent-run:write");
  });

  it("returns 404 when the agent is missing", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      client().send({
        headers: authHeaders(),
        body: { agentId: randomUUID(), prompt: "hello" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(fixture.agentId).toStrictEqual(expect.any(String));
  });

  it("returns 403 when a non-owner runs a private agent", async () => {
    const fixture = await track(seedFixture());
    await store
      .set(writeDb$)
      .update(zeroAgents)
      .set({ visibility: "private" })
      .where(eq(zeroAgents.id, fixture.agentId));
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    const response = await accept(
      client().send({
        headers: authHeaders(),
        body: { agentId: fixture.agentId, prompt: "hello" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("creates a thread, run, callback, ZERO_TOKEN secret, and user message", async () => {
    const fixture = await track(seedFixture());

    const response = await send({
      agentId: fixture.agentId,
      prompt: "hello from api chat",
    });
    await clearAllDetached();

    expect(response.body.runId).toStrictEqual(expect.any(String));
    expect(response.body.threadId).toStrictEqual(expect.any(String));

    const writeDb = store.set(writeDb$);
    const [run] = await writeDb
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        triggerSource: zeroRuns.triggerSource,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.id, response.body.runId!))
      .limit(1);
    expect(run).toStrictEqual({
      prompt: "hello from api chat",
      appendSystemPrompt: expect.stringContaining(
        "You are currently running inside: Web",
      ),
      triggerSource: "web",
      chatThreadId: response.body.threadId,
    });

    const message = await firstUserMessage(response.body.threadId);
    expect(message).toMatchObject({
      content: "hello from api chat",
      runId: response.body.runId,
      revokesMessageId: null,
      interruptsRunId: null,
    });

    const [callback] = await writeDb
      .select({
        url: agentRunCallbacks.url,
        encryptedSecret: agentRunCallbacks.encryptedSecret,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, response.body.runId!))
      .limit(1);
    expect(callback?.url).toBe(
      "http://localhost:3000/api/internal/callbacks/chat",
    );
    expect(decryptSecretValue(callback!.encryptedSecret)).toHaveLength(64);
    expect(callback?.payload).toStrictEqual({
      threadId: response.body.threadId,
      agentId: fixture.agentId,
    });

    const secrets = await runExecutionSecrets(response.body.runId!);
    expect(secrets?.ZERO_TOKEN).toMatch(/^vm0_sandbox_/);
    const zeroAuth = verifyZeroToken(secrets!.ZERO_TOKEN!);
    expect(zeroAuth?.capabilities).not.toContain("agent-run:write");
    expect(zeroAuth?.capabilities).not.toContain("host:read");
    expect(zeroAuth?.capabilities).not.toContain("host:write");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${response.body.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadRunCreated:${response.body.threadId}`,
      null,
    );
  });

  it("dispatches a terminal chat callback when run dispatch fails after insert", async () => {
    const fixture = await track(seedFixture());
    proxyChatCallbackToApp();
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);

    const response = await send({
      agentId: fixture.agentId,
      prompt: "fail before worker start",
    });
    await clearAllDetached();

    expect(response.body.status).toBe("failed");
    expect(response.body.runId).toStrictEqual(expect.any(String));

    const writeDb = store.set(writeDb$);
    const [run] = await writeDb
      .select({
        status: agentRuns.status,
        error: agentRuns.error,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId!))
      .limit(1);
    expect(run).toStrictEqual({
      status: "failed",
      error: expect.stringContaining("RUNNER_DEFAULT_GROUP"),
    });

    const [callback] = await writeDb
      .select({
        status: agentRunCallbacks.status,
        attempts: agentRunCallbacks.attempts,
        deliveredAt: agentRunCallbacks.deliveredAt,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, response.body.runId!))
      .limit(1);
    expect(callback).toStrictEqual({
      status: "delivered",
      attempts: 1,
      deliveredAt: expect.any(Date),
    });

    const messages = await writeDb
      .select({
        role: chatMessages.role,
        runId: chatMessages.runId,
        error: chatMessages.error,
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatThreadId, response.body.threadId));
    expect(messages).toContainEqual({
      role: "assistant",
      runId: response.body.runId,
      error: expect.any(String),
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${response.body.runId}`,
      { status: "failed" },
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadRunUpdated:${response.body.threadId}`,
      null,
    );
  });

  it("does not require unconfigured connector environment refs before creating a chat run", async () => {
    const fixture = await track(seedFixture());
    await store
      .set(writeDb$)
      .update(agentComposeVersions)
      .set({
        content: {
          version: "1.0",
          agents: {
            default: {
              framework: "claude-code",
              environment: {
                ANTHROPIC_API_KEY: "test-key",
                ZERO_AGENT_ID: vm0Template("{{ vars.ZERO_AGENT_ID }}"),
                ZERO_TOKEN: vm0Template("{{ secrets.ZERO_TOKEN }}"),
                JIRA_EMAIL: vm0Template("{{ vars.JIRA_EMAIL }}"),
                GITLAB_HOST: vm0Template("{{ vars.GITLAB_HOST }}"),
                GH_TOKEN: vm0Template("{{ secrets.GH_TOKEN }}"),
                SLACK_TOKEN: vm0Template("{{ secrets.SLACK_TOKEN }}"),
              },
            },
          },
        },
      })
      .where(eq(agentComposeVersions.id, fixture.versionId));

    const response = await send({
      agentId: fixture.agentId,
      prompt: "use the default zero agent",
    });
    await clearAllDetached();

    expect(response.body.status).toBe("pending");
    const [run] = await store
      .set(writeDb$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId!))
      .limit(1);
    expect(run?.id).toBe(response.body.runId);
  });

  it("preserves clientThreadId for new thread creation", async () => {
    const fixture = await track(seedFixture());
    const clientThreadId = randomUUID();

    const response = await send({
      agentId: fixture.agentId,
      prompt: "client thread",
      clientThreadId,
    });
    await clearAllDetached();

    expect(response.body.threadId).toBe(clientThreadId);
    const [thread] = await store
      .set(writeDb$)
      .select({
        id: chatThreads.id,
        agentComposeId: chatThreads.agentComposeId,
        userId: chatThreads.userId,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, clientThreadId))
      .limit(1);
    expect(thread).toStrictEqual({
      id: clientThreadId,
      agentComposeId: fixture.agentId,
      userId: fixture.userId,
    });
  });

  it("passes user feature switch overrides into generated ZERO_TOKEN capabilities", async () => {
    const fixture = await track(seedFixture());
    await store
      .set(writeDb$)
      .insert(userFeatureSwitches)
      .values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        switches: {
          [FeatureSwitchKey.ComputerUse]: true,
          [FeatureSwitchKey.HostedSites]: true,
          [FeatureSwitchKey.LocalAgentConnector]: true,
        },
        updatedAt: nowDate(),
      });

    const response = await send({
      agentId: fixture.agentId,
      prompt: "open remote browser",
    });
    await clearAllDetached();

    const secrets = await runExecutionSecrets(response.body.runId!);
    const zeroAuth = verifyZeroToken(secrets!.ZERO_TOKEN!);
    expect(zeroAuth?.capabilities).toContain("computer-use:write");
    expect(zeroAuth?.capabilities).toContain("host:read");
    expect(zeroAuth?.capabilities).toContain("host:write");
    expect(zeroAuth?.capabilities).toContain("local-agent:read");
    expect(zeroAuth?.capabilities).toContain("local-agent:write");
  });

  it("persists attachments on the user message and injects them into the run prompt", async () => {
    const fixture = await track(seedFixture());
    const fileId = randomUUID();

    const response = await send({
      agentId: fixture.agentId,
      prompt: "read this file",
      attachFiles: [
        {
          id: fileId,
          filename: "notes.txt",
          contentType: "text/plain",
          size: 42,
        },
      ],
    });
    await clearAllDetached();

    const [run] = await store
      .set(writeDb$)
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId!))
      .limit(1);
    expect(run?.prompt).toContain("[Web file] notes.txt (text/plain)");
    expect(run?.prompt).toContain(`[ID] ${fileId}`);
    expect(run?.appendSystemPrompt).toContain("zero web download-file -h");
    expect(run?.appendSystemPrompt).toContain("zero web upload-file -h");

    const message = await firstUserMessage(response.body.threadId);
    expect(message?.content).toBe("read this file");
    expect(message?.attachFiles).toStrictEqual([fileId]);
    expect(message?.attachFileMetadata).toStrictEqual([
      {
        id: fileId,
        filename: "notes.txt",
        contentType: "text/plain",
        size: 42,
        objectKey: `artifacts/${fixture.userId}/${fileId}/notes.txt`,
      },
    ]);
  });

  it("generates a chat thread title when the lightweight model is configured", async () => {
    const fixture = await track(seedFixture());
    mockOptionalEnv("OPENROUTER_API_KEY", "title-api-key");
    let upstreamAuthorization: string | null = null;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        ({ request }) => {
          upstreamAuthorization = request.headers.get("authorization");
          return HttpResponse.json({
            choices: [{ message: { content: "**Migration Plan**" } }],
          });
        },
      ),
    );

    const response = await send({
      agentId: fixture.agentId,
      prompt: "plan the API migration",
    });
    await clearAllDetached();

    expect(upstreamAuthorization).toBe("Bearer title-api-key");
    const [thread] = await store
      .set(writeDb$)
      .select({ title: chatThreads.title })
      .from(chatThreads)
      .where(eq(chatThreads.id, response.body.threadId))
      .limit(1);
    expect(thread?.title).toBe("Migration Plan");
  });

  it("queues an unassociated user message when the thread has an active run", async () => {
    const fixture = await track(seedFixture());
    const first = await send({ agentId: fixture.agentId, prompt: "first" });
    await clearAllDetached();

    const second = await send({
      agentId: fixture.agentId,
      prompt: "queued",
      threadId: first.body.threadId,
    });

    expect(second.body.runId).toBeNull();
    const [queued] = await store
      .set(writeDb$)
      .select({
        content: chatMessages.content,
        runId: chatMessages.runId,
        revokesMessageId: chatMessages.revokesMessageId,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, first.body.threadId),
          eq(chatMessages.content, "queued"),
        ),
      )
      .limit(1);
    expect(queued).toStrictEqual({
      content: "queued",
      runId: null,
      revokesMessageId: null,
    });
  });

  it("creates a follow-up run on an existing thread and continues the last session", async () => {
    const fixture = await track(seedFixture());
    const first = await send({ agentId: fixture.agentId, prompt: "first" });
    await clearAllDetached();

    const [firstRun] = await store
      .set(writeDb$)
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, first.body.runId!))
      .limit(1);
    await setRunStatus(first.body.runId!, "completed", {
      agentSessionId: firstRun!.sessionId,
    });

    const second = await send({
      agentId: fixture.agentId,
      prompt: "follow up",
      threadId: first.body.threadId,
    });
    await clearAllDetached();

    expect(second.body.runId).toStrictEqual(expect.any(String));
    expect(second.body.runId).not.toBe(first.body.runId);
    const [secondRun] = await store
      .set(writeDb$)
      .select({
        sessionId: agentRuns.sessionId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, second.body.runId!))
      .limit(1);
    expect(secondRun).toStrictEqual({
      sessionId: firstRun!.sessionId,
      continuedFromSessionId: firstRun!.sessionId,
    });
  });

  it("recalls only queued user messages", async () => {
    const fixture = await track(seedFixture());
    const first = await send({ agentId: fixture.agentId, prompt: "first" });
    await clearAllDetached();
    await send({
      agentId: fixture.agentId,
      prompt: "queued for recall",
      threadId: first.body.threadId,
    });

    const [queued] = await store
      .set(writeDb$)
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, first.body.threadId),
          eq(chatMessages.content, "queued for recall"),
          isNull(chatMessages.runId),
        ),
      )
      .limit(1);

    const recallId = randomUUID();
    const recall = await send({
      agentId: fixture.agentId,
      threadId: first.body.threadId,
      revokesMessageId: queued!.id,
      clientMessageId: recallId,
    });
    expect(recall.body.runId).toBeNull();

    const [recallMessage] = await store
      .set(writeDb$)
      .select({
        id: chatMessages.id,
        runId: chatMessages.runId,
        content: chatMessages.content,
        revokesMessageId: chatMessages.revokesMessageId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, recallId))
      .limit(1);
    expect(recallMessage).toStrictEqual({
      id: recallId,
      runId: null,
      content: null,
      revokesMessageId: queued!.id,
    });

    const associated = await firstUserMessage(first.body.threadId);
    const rejected = await accept(
      client().send({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          threadId: first.body.threadId,
          revokesMessageId: associated!.id,
          clientMessageId: randomUUID(),
        },
      }),
      [400],
    );
    expect(rejected.body.error.code).toBe("BAD_REQUEST");
    expect(rejected.body.error.message).toContain("queued user messages");
  });

  it("interrupts and cancels an active chat run", async () => {
    const fixture = await track(seedFixture());
    proxyChatCallbackToApp();
    const first = await send({ agentId: fixture.agentId, prompt: "first" });
    await clearAllDetached();

    const interruptId = randomUUID();
    const interrupt = await send({
      agentId: fixture.agentId,
      threadId: first.body.threadId,
      interruptsRunId: first.body.runId,
      clientMessageId: interruptId,
    });
    expect(interrupt.body.runId).toBeNull();

    const writeDb = store.set(writeDb$);
    const [run] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, first.body.runId!))
      .limit(1);
    expect(run?.status).toBe("cancelled");

    const [message] = await writeDb
      .select({
        id: chatMessages.id,
        content: chatMessages.content,
        runId: chatMessages.runId,
        interruptsRunId: chatMessages.interruptsRunId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, interruptId))
      .limit(1);
    expect(message).toStrictEqual({
      id: interruptId,
      content: null,
      runId: null,
      interruptsRunId: first.body.runId,
    });
  });

  it("injects recent web chat runs into a follow-up run prompt", async () => {
    const fixture = await track(seedFixture());
    const first = await send({
      agentId: fixture.agentId,
      prompt: "first web context",
    });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "completed");
    await store.set(writeDb$).insert(chatMessages).values({
      chatThreadId: first.body.threadId,
      role: "assistant",
      content: "first assistant context",
      runId: first.body.runId,
      sequenceNumber: 1,
    });

    const second = await send({
      agentId: fixture.agentId,
      prompt: "follow-up web context",
      threadId: first.body.threadId,
    });
    await clearAllDetached();

    const [run] = await store
      .set(writeDb$)
      .select({ appendSystemPrompt: agentRuns.appendSystemPrompt })
      .from(agentRuns)
      .where(eq(agentRuns.id, second.body.runId!))
      .limit(1);
    const prompt = run!.appendSystemPrompt!;
    expect(prompt).toContain("# Web Chat Run Context");
    expect(prompt).toContain(`RUN_ID: ${first.body.runId}`);
    expect(prompt).toContain(
      `LOG_COMMAND: zero logs ${first.body.runId} --all`,
    );
    expect(prompt).toContain("User: first web context");
    expect(prompt).toContain("Assistant: first assistant context");
    expect(prompt).toContain("RELATIVE_INDEX: 0");
    expect(prompt).not.toContain("follow-up web context");
  });

  it("injects incomplete cancelled rounds into the next run prompt", async () => {
    const fixture = await track(seedFixture());
    const first = await send({ agentId: fixture.agentId, prompt: "cancel me" });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "cancelled");

    const second = await send({
      agentId: fixture.agentId,
      prompt: "retry",
      threadId: first.body.threadId,
    });
    await clearAllDetached();

    const [run] = await store
      .set(writeDb$)
      .select({ appendSystemPrompt: agentRuns.appendSystemPrompt })
      .from(agentRuns)
      .where(eq(agentRuns.id, second.body.runId!))
      .limit(1);
    expect(run?.appendSystemPrompt).toContain("# Incomplete Rounds Context");
    expect(run?.appendSystemPrompt).not.toContain("# Web Chat Run Context");
    expect(run?.appendSystemPrompt).toContain("RUN_STATUS: cancelled");
    expect(run?.appendSystemPrompt).toContain("User: cancel me");
  });

  it("truncates old incomplete round content in chronological order", async () => {
    const fixture = await track(seedFixture());
    const first = await send({
      agentId: fixture.agentId,
      prompt: "first incomplete",
    });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "failed");

    const secondPrompt = `second ${"x".repeat(4100)}`;
    const second = await send({
      agentId: fixture.agentId,
      prompt: secondPrompt,
      threadId: first.body.threadId,
    });
    await clearAllDetached();
    await setRunStatus(second.body.runId!, "timeout");

    const third = await send({
      agentId: fixture.agentId,
      prompt: "retry after two failures",
      threadId: first.body.threadId,
    });
    await clearAllDetached();

    const [run] = await store
      .set(writeDb$)
      .select({ appendSystemPrompt: agentRuns.appendSystemPrompt })
      .from(agentRuns)
      .where(eq(agentRuns.id, third.body.runId!))
      .limit(1);
    const prompt = run!.appendSystemPrompt!;
    expect(prompt.indexOf("RUN_STATUS: failed")).toBeLessThan(
      prompt.indexOf("RUN_STATUS: timeout"),
    );
    expect(prompt).toContain("User: first incomplete");
    expect(prompt).toContain("...[truncated]");
    expect(prompt).not.toContain("retry after two failures");
  });

  it("forceNewSession rewrites the model pin while retaining web chat context", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await seedVm0Credits(fixture, 1000);
    await seedModelProvider(fixture, "claude-opus-4-7", {
      type: "vm0",
      userId: ORG_SENTINEL_USER_ID,
    });
    await seedVm0ApiKey(fixture, "claude-opus-4-7");
    await seedVm0ApiKey(fixture, "claude-sonnet-4-6");
    await writeDb.insert(orgModelPolicies).values([
      {
        orgId: fixture.orgId,
        model: "claude-opus-4-7",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        createdByUserId: fixture.userId,
        updatedByUserId: fixture.userId,
      },
      {
        orgId: fixture.orgId,
        model: "claude-sonnet-4-6",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
        createdByUserId: fixture.userId,
        updatedByUserId: fixture.userId,
      },
    ]);

    const first = await send({
      agentId: fixture.agentId,
      prompt: "first on opus",
    });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "completed");

    const second = await send({
      agentId: fixture.agentId,
      prompt: "now on sonnet",
      threadId: first.body.threadId,
      modelSelection: {
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "claude-sonnet-4-6",
      },
      forceNewSession: true,
    });
    await clearAllDetached();

    const [thread] = await writeDb
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, first.body.threadId))
      .limit(1);
    expect(thread?.selectedModel).toBe("claude-sonnet-4-6");

    const [run] = await writeDb
      .select({
        selectedModel: zeroRuns.selectedModel,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
      .where(eq(zeroRuns.id, second.body.runId!))
      .limit(1);
    expect(run?.selectedModel).toBe("claude-sonnet-4-6");
    expect(run?.appendSystemPrompt).toContain("# Web Chat Run Context");
    expect(run?.appendSystemPrompt).toContain(`RUN_ID: ${first.body.runId}`);
    expect(run?.appendSystemPrompt).toContain(
      `LOG_COMMAND: zero logs ${first.body.runId} --all`,
    );
    expect(run?.appendSystemPrompt).toContain("User: first on opus");
  });

  it("seeds default model-first policies before resolving explicit VM0 selection", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await removeComposeFrameworkApiKey(fixture);
    await seedVm0Credits(fixture, 1000);
    await seedVm0ApiKey(fixture, "claude-sonnet-4-6");

    const response = await send({
      agentId: fixture.agentId,
      prompt: "run with default seeded vm0 route",
      modelSelection: {
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "claude-sonnet-4-6",
      },
    });
    await clearAllDetached();

    const [policy] = await writeDb
      .select({
        defaultProviderType: orgModelPolicies.defaultProviderType,
        credentialScope: orgModelPolicies.credentialScope,
        modelProviderId: orgModelPolicies.modelProviderId,
      })
      .from(orgModelPolicies)
      .where(
        and(
          eq(orgModelPolicies.orgId, fixture.orgId),
          eq(orgModelPolicies.model, "claude-sonnet-4-6"),
        ),
      )
      .limit(1);
    expect(policy).toStrictEqual({
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
    });

    const [run] = await writeDb
      .select({
        modelProvider: zeroRuns.modelProvider,
        modelProviderId: zeroRuns.modelProviderId,
        modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId!))
      .limit(1);
    expect(run).toStrictEqual({
      modelProvider: "vm0",
      modelProviderId: null,
      modelProviderCredentialScope: "org",
      selectedModel: "claude-sonnet-4-6",
    });

    const [job] = await writeDb
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId!))
      .limit(1);
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
      readonly billableFirewalls: readonly string[];
      readonly modelUsageProvider: string | undefined;
    };
    const anthropicPlaceholder = modelProviderSecretPlaceholder(
      "anthropic-api-key",
      "ANTHROPIC_API_KEY",
    );
    expect(executionContext.environment).toMatchObject({
      ANTHROPIC_API_KEY: anthropicPlaceholder,
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
    });
    const decrypted = decryptSecretsMap(executionContext.encryptedSecrets);
    expect(decrypted?.ANTHROPIC_API_KEY).toStrictEqual(expect.any(String));
    expect(decrypted?.ANTHROPIC_API_KEY).not.toBe(anthropicPlaceholder);
    expect(executionContext.billableFirewalls).toContain(
      "model-provider:anthropic-api-key",
    );
    expect(executionContext.modelUsageProvider).toBe("claude-sonnet-4-6");
  });

  it("passes explicit provider selection into the runner job context", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await removeComposeFrameworkApiKey(fixture);
    await seedModelProvider(fixture, "claude-sonnet-4-6", {
      type: "anthropic-api-key",
      isDefault: true,
      secretValue: "default-anthropic-key",
    });
    const deepseekProviderId = await seedModelProvider(
      fixture,
      "deepseek-v4-flash",
      {
        type: "deepseek-api-key",
        isDefault: false,
        secretValue: "selected-deepseek-key",
      },
    );

    const response = await send({
      agentId: fixture.agentId,
      prompt: "run with selected deepseek provider",
      modelSelection: {
        modelProviderId: deepseekProviderId,
        selectedModel: "deepseek-v4-pro",
      },
    });
    await clearAllDetached();

    const [job] = await writeDb
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId!))
      .limit(1);
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
    };
    expect(executionContext.environment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: modelProviderSecretPlaceholder(
        "deepseek-api-key",
        "DEEPSEEK_API_KEY",
      ),
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    });
    expect(executionContext.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      DEEPSEEK_API_KEY: "selected-deepseek-key",
    });
  });

  it("mounts custom skills for deepseek web chat runs", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await removeComposeFrameworkApiKey(fixture);
    await writeDb
      .update(zeroAgents)
      .set({ customSkills: ["pp"] })
      .where(eq(zeroAgents.id, fixture.agentId));
    await seedModelProvider(fixture, "claude-sonnet-4-6", {
      type: "anthropic-api-key",
      isDefault: true,
      secretValue: "default-anthropic-key",
    });
    const deepseekProviderId = await seedModelProvider(
      fixture,
      "deepseek-v4-flash",
      {
        type: "deepseek-api-key",
        isDefault: false,
        secretValue: "selected-deepseek-key",
      },
    );

    const response = await send({
      agentId: fixture.agentId,
      prompt: "use the pp skill",
      modelSelection: {
        modelProviderId: deepseekProviderId,
        selectedModel: "deepseek-v4-pro",
      },
    });

    const [run] = await writeDb
      .select({ additionalVolumes: agentRuns.additionalVolumes })
      .from(agentRuns)
      .where(eq(agentRuns.id, response.body.runId!))
      .limit(1);
    const volumes = run?.additionalVolumes ?? [];
    expect(volumes).toContainEqual(
      expect.objectContaining({
        name: "custom-skill@pp",
        mountPath: "/home/user/.claude/skills/pp",
      }),
    );
    expect(
      volumes.some((volume) => {
        return volume.mountPath === "/home/user/.claude/skills/deep-dive";
      }),
    ).toBeTruthy();
  });

  it("honors org-scoped model-first route credentials during run creation", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await removeComposeFrameworkApiKey(fixture);
    await seedModelProvider(fixture, "deepseek-v4-flash", {
      type: "deepseek-api-key",
      userId: fixture.userId,
      isDefault: true,
      secretValue: "member-deepseek-key",
    });
    const orgProviderId = await seedModelProvider(
      fixture,
      "deepseek-v4-flash",
      {
        type: "deepseek-api-key",
        userId: ORG_SENTINEL_USER_ID,
        isDefault: true,
        secretValue: "org-deepseek-key",
      },
    );
    await writeDb.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "deepseek-v4-pro",
      isDefault: true,
      defaultProviderType: "deepseek-api-key",
      credentialScope: "org",
      modelProviderId: orgProviderId,
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });

    const response = await send({
      agentId: fixture.agentId,
      prompt: "run with org policy deepseek provider",
      modelSelection: {
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "deepseek-v4-pro",
      },
    });
    await clearAllDetached();

    const [job] = await writeDb
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId!))
      .limit(1);
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
    };
    expect(executionContext.environment.ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder("deepseek-api-key", "DEEPSEEK_API_KEY"),
    );
    expect(executionContext.environment.ANTHROPIC_MODEL).toBe(
      "deepseek-v4-pro",
    );
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      DEEPSEEK_API_KEY: "org-deepseek-key",
    });
  });

  it("re-resolves provider route for an existing model-first thread", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await removeComposeFrameworkApiKey(fixture);
    await seedVm0Credits(fixture, 1000);
    await seedModelProvider(fixture, "claude-sonnet-4-6", {
      type: "vm0",
      userId: ORG_SENTINEL_USER_ID,
      isDefault: false,
    });
    await seedVm0ApiKey(fixture, "claude-sonnet-4-6");
    await writeDb.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });

    const first = await send({
      agentId: fixture.agentId,
      prompt: "start on built-in",
      modelSelection: {
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "claude-sonnet-4-6",
      },
    });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "completed");

    const byokProviderId = await seedModelProvider(
      fixture,
      "claude-sonnet-4-6",
      {
        type: "anthropic-api-key",
        userId: ORG_SENTINEL_USER_ID,
        isDefault: false,
        secretValue: "org-anthropic-key",
      },
    );
    await writeDb
      .update(orgModelPolicies)
      .set({
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: byokProviderId,
        updatedByUserId: fixture.userId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgModelPolicies.orgId, fixture.orgId),
          eq(orgModelPolicies.model, "claude-sonnet-4-6"),
        ),
      );

    const second = await send({
      agentId: fixture.agentId,
      prompt: "continue same model after provider switch",
      threadId: first.body.threadId,
    });
    await clearAllDetached();

    const [thread] = await writeDb
      .select({
        modelProviderId: chatThreads.modelProviderId,
        modelProviderType: chatThreads.modelProviderType,
        modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
        selectedModel: chatThreads.selectedModel,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, first.body.threadId))
      .limit(1);
    expect(thread).toMatchObject({
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: "claude-sonnet-4-6",
    });

    const [run] = await writeDb
      .select({
        modelProvider: zeroRuns.modelProvider,
        modelProviderId: zeroRuns.modelProviderId,
        modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, second.body.runId!))
      .limit(1);
    expect(run).toStrictEqual({
      modelProvider: "anthropic-api-key",
      modelProviderId: byokProviderId,
      modelProviderCredentialScope: "org",
      selectedModel: "claude-sonnet-4-6",
    });

    const [job] = await writeDb
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, second.body.runId!))
      .limit(1);
    const executionContext = job?.executionContext as {
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
    };
    expect(executionContext.environment.ANTHROPIC_API_KEY).toBe(
      modelProviderSecretPlaceholder("anthropic-api-key", "ANTHROPIC_API_KEY"),
    );
    expect(executionContext.environment.ANTHROPIC_MODEL).toBe(
      "claude-sonnet-4-6",
    );
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      ANTHROPIC_API_KEY: "org-anthropic-key",
    });
  });

  it("runs VM0 GPT model-first routes with the Codex runtime framework", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await removeComposeFrameworkApiKey(fixture);
    await seedVm0Credits(fixture, 1000);
    await seedModelProvider(fixture, "gpt-5.5", {
      type: "vm0",
      userId: ORG_SENTINEL_USER_ID,
    });
    await seedVm0ApiKey(fixture, "gpt-5.5", { vendor: "openai" });
    await writeDb.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "gpt-5.5",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });

    const response = await send({
      agentId: fixture.agentId,
      prompt: "run with built-in gpt",
      modelSelection: {
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "gpt-5.5",
      },
    });
    await clearAllDetached();

    const [job] = await writeDb
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId!))
      .limit(1);
    const executionContext = job?.executionContext as {
      readonly cliAgentType: string;
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
    };
    expect(executionContext.cliAgentType).toBe("codex");
    expect(executionContext.environment).toMatchObject({
      OPENAI_API_KEY: modelProviderSecretPlaceholder(
        "openai-api-key",
        "OPENAI_API_KEY",
      ),
      OPENAI_MODEL: "gpt-5.5",
    });
    expect(executionContext.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      OPENAI_API_KEY: "vm0-key-gpt-5.5",
    });
  });

  it("stores no-credit user and assistant messages when VM0 model-first admission has no spendable credits", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await seedVm0Credits(fixture, 0);
    await writeDb.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });

    const response = await accept(
      client().send({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          prompt: "blocked by credits",
        },
      }),
      [201],
    );

    expect(response.body.runId).toBeNull();
    const [run] = await writeDb
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.userId, fixture.userId))
      .limit(1);
    expect(run).toBeUndefined();
    const messages = await writeDb
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        runId: chatMessages.runId,
        error: chatMessages.error,
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatThreadId, response.body.threadId))
      .orderBy(chatMessages.createdAt);
    expect(messages).toStrictEqual([
      {
        role: "user",
        content: "blocked by credits",
        runId: null,
        error: "insufficient_credits",
      },
      {
        role: "assistant",
        content: expect.stringContaining("Upgrade to Pro"),
        runId: null,
        error: "insufficient_credits",
      },
    ]);
  });

  it("stores upgrade guidance for pro-suspend workspaces with credits", async () => {
    const fixture = await track(seedFixture());
    await seedVm0Credits(fixture, 20_000, "pro-suspend");
    const providerId = await seedModelProvider(fixture, "claude-sonnet-4-6");

    const response = await accept(
      client().send({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          prompt: "blocked by suspended plan",
          modelSelection: {
            modelProviderId: providerId,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [201],
    );

    expect(response.body.runId).toBeNull();
    const [run] = await store
      .set(writeDb$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.userId, fixture.userId))
      .limit(1);
    expect(run).toBeUndefined();
    const messages = await store
      .set(writeDb$)
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        runId: chatMessages.runId,
        error: chatMessages.error,
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatThreadId, response.body.threadId))
      .orderBy(chatMessages.createdAt);
    expect(messages).toStrictEqual([
      {
        role: "user",
        content: "blocked by suspended plan",
        runId: null,
        error: "insufficient_credits",
      },
      {
        role: "assistant",
        content: expect.stringContaining("Upgrade to Pro"),
        runId: null,
        error: "insufficient_credits",
      },
    ]);
  });

  it("stores no-credit guidance when explicit VM0 modelSelection has no spendable credits", async () => {
    const fixture = await track(seedFixture());
    await seedVm0Credits(fixture, 0);
    const providerId = await seedModelProvider(fixture, "claude-sonnet-4-6", {
      type: "vm0",
    });

    const response = await accept(
      client().send({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          prompt: "blocked by provider selection credits",
          modelSelection: {
            modelProviderId: providerId,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [201],
    );

    expect(response.body.runId).toBeNull();
    const [run] = await store
      .set(writeDb$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.userId, fixture.userId))
      .limit(1);
    expect(run).toBeUndefined();
  });

  it("rejects modelSelection that belongs to another user in the same org", async () => {
    const fixture = await track(seedFixture());
    const providerId = await seedModelProvider(fixture, "claude-sonnet-4-6", {
      userId: `user_${randomUUID()}`,
    });

    const response = await accept(
      client().send({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          prompt: "do not use another user provider",
          modelSelection: {
            modelProviderId: providerId,
            selectedModel: "claude-sonnet-4-6",
          },
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("locks an existing thread to its first model selection", async () => {
    const fixture = await track(seedFixture());
    const providerId = await seedModelProvider(fixture, "claude-sonnet-4-6");

    const first = await send({
      agentId: fixture.agentId,
      prompt: "first model",
      modelSelection: {
        modelProviderId: providerId,
        selectedModel: "claude-sonnet-4-6",
      },
    });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "completed");

    const response = await accept(
      client().send({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          prompt: "switch model",
          threadId: first.body.threadId,
          modelSelection: {
            modelProviderId: providerId,
            selectedModel: "claude-opus-4-7",
          },
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain(
      "Cannot change model on an existing thread",
    );
  });

  it("normalizes legacy built-in first-run pins that still carry provider IDs", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await seedVm0Credits(fixture, 1000);
    await seedVm0ApiKey(fixture, "claude-opus-4-7");

    const first = await send({
      agentId: fixture.agentId,
      prompt: "first on built-in",
    });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "completed");

    await writeDb
      .update(zeroRuns)
      .set({
        modelProvider: "vm0",
        modelProviderId: randomUUID(),
        modelProviderCredentialScope: "org",
        selectedModel: "claude-opus-4-7",
      })
      .where(eq(zeroRuns.id, first.body.runId!));
    await writeDb
      .update(chatThreads)
      .set({
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: null,
      })
      .where(eq(chatThreads.id, first.body.threadId));

    const followUp = await send({
      agentId: fixture.agentId,
      prompt: "follow up on legacy thread",
      threadId: first.body.threadId,
    });
    await clearAllDetached();

    const [thread] = await writeDb
      .select({
        modelProviderId: chatThreads.modelProviderId,
        selectedModel: chatThreads.selectedModel,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, first.body.threadId))
      .limit(1);
    expect(thread).toStrictEqual({
      modelProviderId: null,
      selectedModel: "claude-opus-4-7",
    });
    expect(followUp.body.threadId).toBe(first.body.threadId);
  });

  it("re-resolves current policy when the first provider is deleted", async () => {
    const fixture = await track(seedFixture());
    const providerId = await seedModelProvider(fixture, "claude-sonnet-4-6");

    const first = await send({
      agentId: fixture.agentId,
      prompt: "first model",
      modelSelection: {
        modelProviderId: providerId,
        selectedModel: "claude-sonnet-4-6",
      },
    });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "completed");
    const replacementProviderId = await seedModelProvider(
      fixture,
      "claude-sonnet-4-6",
      {
        userId: ORG_SENTINEL_USER_ID,
        isDefault: false,
        secretValue: "replacement-provider-key",
      },
    );
    await store.set(writeDb$).insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: replacementProviderId,
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });
    await store
      .set(writeDb$)
      .delete(modelProviders)
      .where(eq(modelProviders.id, providerId));

    const response = await send({
      agentId: fixture.agentId,
      prompt: "follow up",
      threadId: first.body.threadId,
    });
    await clearAllDetached();

    const [run] = await store
      .set(writeDb$)
      .select({
        modelProviderId: zeroRuns.modelProviderId,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, response.body.runId!))
      .limit(1);
    expect(run).toStrictEqual({
      modelProviderId: replacementProviderId,
      selectedModel: "claude-sonnet-4-6",
    });
  });

  it("derives the runner framework from the compose content", async () => {
    const fixture = await track(seedFixture());
    await store
      .set(writeDb$)
      .update(agentComposeVersions)
      .set({
        content: {
          version: "1.0",
          agents: {
            codex: {
              framework: "codex",
              environment: {
                OPENAI_API_KEY: "test-key",
                ZERO_AGENT_ID: vm0Template("{{ vars.ZERO_AGENT_ID }}"),
                ZERO_TOKEN: vm0Template("{{ secrets.ZERO_TOKEN }}"),
              },
            },
          },
        },
      })
      .where(eq(agentComposeVersions.id, fixture.versionId));

    const response = await send({
      agentId: fixture.agentId,
      prompt: "run codex",
    });
    await clearAllDetached();

    const [job] = await store
      .set(writeDb$)
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId!))
      .limit(1);
    expect(job?.executionContext).toMatchObject({ cliAgentType: "codex" });
  });
});
