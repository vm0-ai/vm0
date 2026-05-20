import { createHmac, randomUUID } from "node:crypto";

import {
  integrationsPhoneDownloadFileContract,
  integrationsPhoneMessageContract,
  integrationsPhoneUploadCompleteContract,
  integrationsPhoneUploadInitContract,
} from "@vm0/api-contracts/contracts/integrations";
import { zeroIntegrationsAgentPhoneContract } from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentphoneMessages } from "@vm0/db/schema/agentphone-message";
import { agentphoneThreadSessions } from "@vm0/db/schema/agentphone-thread-session";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { clearAllDetached } from "../../utils";
import { signAgentPhoneConnectParams } from "../../services/zero-agentphone.service";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

interface AgentPhoneSendMessageBody {
  readonly agent_id: string;
  readonly to_number: string;
  readonly body: string;
  readonly media_url?: string;
}

interface RunFixture {
  readonly runId: string;
  readonly sessionId: string;
  readonly composeId: string;
  readonly versionId?: string;
  readonly orgId: string;
  readonly userId: string;
}

const AGENTPHONE_WEBHOOK_SECRET = ["agentphone", "webhook", "secret"].join("-");
const CALLBACK_SECRET = ["test", "callback", "secret"].join("-");

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);
const mocks = createZeroRouteMocks(context);

const trackOrgMembership = createFixtureTracker(
  async (fixture: OrgMembershipFixture) => {
    await store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

const trackPhoneHandle = createFixtureTracker(
  async (fixture: { readonly phoneHandle: string }) => {
    await writeDb
      .delete(agentphoneMessages)
      .where(eq(agentphoneMessages.phoneHandle, fixture.phoneHandle));
    await writeDb
      .delete(agentphoneUserLinks)
      .where(eq(agentphoneUserLinks.phoneHandle, fixture.phoneHandle));
  },
);

const trackStorageOwner = createFixtureTracker(
  async (fixture: { readonly orgId: string; readonly userId: string }) => {
    const rows = await writeDb
      .select({ id: storages.id })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, fixture.orgId),
          eq(storages.userId, fixture.userId),
        ),
      );
    const storageIds = rows.map((row) => {
      return row.id;
    });
    if (storageIds.length === 0) {
      return;
    }
    await writeDb
      .update(storages)
      .set({ headVersionId: null })
      .where(inArray(storages.id, storageIds));
    await writeDb
      .delete(storageVersions)
      .where(inArray(storageVersions.storageId, storageIds));
    await writeDb.delete(storages).where(inArray(storages.id, storageIds));
  },
);

const trackRun = createFixtureTracker(async (fixture: RunFixture) => {
  const runRows = await writeDb
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, fixture.orgId),
        eq(agentRuns.userId, fixture.userId),
      ),
    );
  const runIds = runRows.map((row) => {
    return row.id;
  });
  if (runIds.length > 0) {
    await writeDb
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
    await writeDb
      .delete(runUploadedFiles)
      .where(inArray(runUploadedFiles.runId, runIds));
    await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  }
  await writeDb
    .delete(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, fixture.orgId),
        eq(agentSessions.userId, fixture.userId),
      ),
    );
  const composeRows = await writeDb
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, fixture.orgId),
        eq(agentComposes.userId, fixture.userId),
      ),
    );
  const composeIds = composeRows.map((row) => {
    return row.id;
  });
  if (composeIds.length > 0) {
    await writeDb.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
    await writeDb
      .delete(agentComposeVersions)
      .where(inArray(agentComposeVersions.composeId, composeIds));
    await writeDb
      .delete(agentComposes)
      .where(inArray(agentComposes.id, composeIds));
  }
  await writeDb
    .delete(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, fixture.orgId));
  await writeDb
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, fixture.orgId));
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
});

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function uniquePhone(): string {
  const digits = randomUUID().replace(/\D/gu, "").padEnd(7, "0").slice(0, 7);
  return `+1555${digits}`;
}

function configureAgentPhoneEnv(): void {
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "test-user-artifacts");
  mockOptionalEnv("AGENTPHONE_API_BASE_URL", "https://api.agentphone.to");
  mockOptionalEnv("AGENTPHONE_API_KEY", "agentphone-test-key");
  mockOptionalEnv("AGENTPHONE_PHONE_NUMBER", "+19039853128");
  mockOptionalEnv("AGENTPHONE_WEBHOOK_SECRET", AGENTPHONE_WEBHOOK_SECRET);
}

function agentPhoneSendMessage() {
  const calls: AgentPhoneSendMessageBody[] = [];
  server.use(
    http.post("https://api.agentphone.to/v1/messages", async ({ request }) => {
      const body = (await request.json()) as AgentPhoneSendMessageBody;
      calls.push(body);
      return HttpResponse.json({
        id: uniqueId("apmsg"),
        status: "sent",
        channel: "sms",
        from_number: "+19039853128",
        to_number: body.to_number,
        media_urls: body.media_url ? [body.media_url] : [],
      });
    }),
  );
  return calls;
}

async function seedOrgMembership(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  await trackOrgMembership(store.set(seedOrgMembership$, args, context.signal));
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
  readonly capabilities: readonly ("phone:read" | "phone:write")[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? randomUUID(),
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function seedAgentPhoneLink(args: {
  readonly phoneHandle: string;
  readonly userId: string;
  readonly orgId: string;
}): Promise<string> {
  const [row] = await writeDb
    .insert(agentphoneUserLinks)
    .values({
      phoneHandle: args.phoneHandle,
      vm0UserId: args.userId,
      orgId: args.orgId,
    })
    .returning({ id: agentphoneUserLinks.id });
  await trackPhoneHandle(Promise.resolve({ phoneHandle: args.phoneHandle }));
  if (!row) {
    throw new Error("seedAgentPhoneLink insert returned no row");
  }
  return row.id;
}

async function seedAgentPhoneMessage(args: {
  readonly messageId: string;
  readonly phoneHandle: string;
  readonly userLinkId: string;
  readonly agentphoneAgentId: string;
  readonly mediaUrl?: string | null;
  readonly direction?: "inbound" | "outbound";
}): Promise<void> {
  await writeDb.insert(agentphoneMessages).values({
    agentphoneMessageId: args.messageId,
    conversationId: null,
    agentphoneAgentId: args.agentphoneAgentId,
    agentphoneUserLinkId: args.userLinkId,
    phoneHandle: args.phoneHandle,
    fromNumber:
      args.direction === "outbound" ? "+19039853128" : args.phoneHandle,
    toNumber: args.direction === "outbound" ? args.phoneHandle : "+19039853128",
    direction: args.direction ?? "inbound",
    channel: "sms",
    body: "hello",
    mediaUrl: args.mediaUrl ?? null,
    isBot: args.direction === "outbound",
  });
}

async function readAgentPhoneLink(phoneHandle: string) {
  const [row] = await writeDb
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  return row;
}

async function readAgentPhoneMessage(messageId: string) {
  const [row] = await writeDb
    .select()
    .from(agentphoneMessages)
    .where(eq(agentphoneMessages.agentphoneMessageId, messageId))
    .limit(1);
  return row;
}

function signAgentPhoneWebhook(rawBody: string, timestamp: string): string {
  return `sha256=${createHmac("sha256", AGENTPHONE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")}`;
}

async function seedRun(args: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<RunFixture> {
  const composeId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId: args.userId,
    orgId: args.orgId,
    name: "agentphone-test-agent",
  });
  await writeDb.insert(agentSessions).values({
    id: sessionId,
    userId: args.userId,
    orgId: args.orgId,
    agentComposeId: composeId,
  });
  await writeDb.insert(agentRuns).values({
    id: runId,
    userId: args.userId,
    orgId: args.orgId,
    sessionId,
    status: "failed",
    prompt: "test prompt",
  });
  return trackRun(
    Promise.resolve({
      runId,
      sessionId,
      composeId,
      orgId: args.orgId,
      userId: args.userId,
    }),
  );
}

async function seedAgentPhoneModelReuseFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly phoneHandle: string;
  readonly selectedModel: string;
  readonly previousModelProvider: string;
}): Promise<{
  readonly composeId: string;
  readonly previousSessionId: string;
  readonly userLinkId: string;
}> {
  const composeId = randomUUID();
  const versionId = randomUUID();
  const previousSessionId = randomUUID();
  const previousRunId = randomUUID();
  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId: args.userId,
    orgId: args.orgId,
    name: "agentphone-model-agent",
  });
  await writeDb.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    createdBy: args.userId,
    content: {
      version: "1.0",
      agents: {
        "agentphone-model-agent": {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
        },
      },
    },
  });
  await writeDb
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  await writeDb.insert(zeroAgents).values({
    id: composeId,
    orgId: args.orgId,
    owner: args.userId,
    name: "agentphone-model-agent",
    displayName: "AgentPhone Model Agent",
    visibility: "public",
    customSkills: [],
  });
  await writeDb.insert(orgMetadata).values({
    orgId: args.orgId,
    defaultAgentId: composeId,
    credits: 100_000,
  });
  await writeDb.insert(orgMembersMetadata).values({
    orgId: args.orgId,
    userId: args.userId,
    timezone: "UTC",
    selectedModel: args.selectedModel,
  });
  await writeDb.insert(vm0ApiKeys).values({
    vendor: "anthropic",
    model: args.selectedModel,
    apiKey: `vm0-key-${args.selectedModel}`,
  });
  await writeDb.insert(orgModelPolicies).values({
    orgId: args.orgId,
    model: args.selectedModel,
    isDefault: true,
    defaultProviderType: "vm0",
    credentialScope: "org",
    createdByUserId: args.userId,
    updatedByUserId: args.userId,
  });

  const userLinkId = await seedAgentPhoneLink({
    phoneHandle: args.phoneHandle,
    userId: args.userId,
    orgId: args.orgId,
  });
  await writeDb.insert(agentSessions).values({
    id: previousSessionId,
    userId: args.userId,
    orgId: args.orgId,
    agentComposeId: composeId,
  });
  await writeDb.insert(agentRuns).values({
    id: previousRunId,
    userId: args.userId,
    orgId: args.orgId,
    sessionId: previousSessionId,
    status: "completed",
    prompt: "previous AgentPhone session",
  });
  await writeDb.insert(zeroRuns).values({
    id: previousRunId,
    triggerSource: "agentphone",
    modelProvider: args.previousModelProvider,
    selectedModel: args.selectedModel,
  });
  await writeDb.insert(agentphoneThreadSessions).values({
    agentphoneUserLinkId: userLinkId,
    rootMessageId: "dm",
    agentSessionId: previousSessionId,
    lastProcessedMessageId: "ap-previous-message",
  });
  await trackRun(
    Promise.resolve({
      runId: previousRunId,
      sessionId: previousSessionId,
      composeId,
      versionId,
      orgId: args.orgId,
      userId: args.userId,
    }),
  );

  return { composeId, previousSessionId, userLinkId };
}

function callbackHeaders(rawBody: string) {
  const timestamp = currentSecond();
  return {
    "Content-Type": "application/json",
    "X-VM0-Timestamp": String(timestamp),
    "X-VM0-Signature": computeHmacSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    ),
  };
}

describe("AgentPhone migrated API routes", () => {
  it("post /api/agentphone/connect links the authenticated user", async () => {
    configureAgentPhoneEnv();
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const phoneHandle = uniquePhone();
    mocks.clerk.session(userId, orgId);
    await trackStorageOwner(Promise.resolve({ orgId, userId }));
    const sendCalls = agentPhoneSendMessage();
    const timestamp = currentSecond();
    const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);

    const response = await accept(
      client.connectAgentPhone({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          phoneHandle,
          agentphoneAgentId: "agt-agentphone",
          timestamp,
          signature: signAgentPhoneConnectParams({
            phoneHandle,
            agentphoneAgentId: "agt-agentphone",
            timestamp,
            channel: "sms",
            secret: "a".repeat(64),
          }),
          channel: "sms",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ phoneHandle });
    await expect(readAgentPhoneLink(phoneHandle)).resolves.toMatchObject({
      vm0UserId: userId,
      orgId,
    });
    expect(sendCalls[0]).toStrictEqual(
      expect.objectContaining({
        agent_id: "agt-agentphone",
        to_number: phoneHandle,
      }),
    );
  });

  it("post /api/agentphone/webhook verifies signatures and handles unlinked inbound messages", async () => {
    configureAgentPhoneEnv();
    const phoneHandle = uniquePhone();
    await trackPhoneHandle(Promise.resolve({ phoneHandle }));
    const sendCalls = agentPhoneSendMessage();
    const app = createApp({ signal: context.signal });
    const body = {
      event: "agent.message",
      channel: "sms",
      data: {
        id: "ap-inbound-1",
        agentId: "agt-agentphone",
        from: phoneHandle,
        to: "+19039853128",
        body: "hello",
      },
    };
    const rawBody = JSON.stringify(body);
    const timestamp = String(currentSecond());

    const rejected = await app.request("/api/agentphone/webhook", {
      method: "POST",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": "sha256=bad",
      },
      body: rawBody,
    });
    expect(rejected.status).toBe(401);

    const accepted = await app.request("/api/agentphone/webhook", {
      method: "POST",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signAgentPhoneWebhook(rawBody, timestamp),
        "x-webhook-id": "webhook-1",
      },
      body: rawBody,
    });
    expect(accepted.status).toBe(200);
    await clearAllDetached();

    await expect(readAgentPhoneMessage("ap-inbound-1")).resolves.toMatchObject({
      phoneHandle,
      agentphoneUserLinkId: null,
      direction: "inbound",
    });
    expect(sendCalls[0]?.body).toContain("/agentphone/connect?");
  });

  it("starts a new AgentPhone session when the selected model provider changed", async () => {
    configureAgentPhoneEnv();
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const phoneHandle = uniquePhone();
    const { previousSessionId } = await seedAgentPhoneModelReuseFixture({
      userId,
      orgId,
      phoneHandle,
      selectedModel: "claude-sonnet-4-6",
      previousModelProvider: "openrouter-api-key",
    });
    const sendCalls = agentPhoneSendMessage();
    const app = createApp({ signal: context.signal });
    const prompt = "provider changed AgentPhone session";
    const body = {
      event: "agent.message",
      channel: "sms",
      data: {
        id: "ap-provider-change",
        agentId: "agt-agentphone",
        from: phoneHandle,
        to: "+19039853128",
        body: prompt,
      },
    };
    const rawBody = JSON.stringify(body);
    const timestamp = String(currentSecond());

    const response = await app.request("/api/agentphone/webhook", {
      method: "POST",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signAgentPhoneWebhook(rawBody, timestamp),
        "x-webhook-id": "webhook-provider-change",
      },
      body: rawBody,
    });
    expect(response.status).toBe(200);
    await clearAllDetached();

    expect(sendCalls).toStrictEqual([]);
    const [run] = await writeDb
      .select({
        sessionId: agentRuns.sessionId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.prompt, prompt))
      .limit(1);
    expect(run).toMatchObject({
      continuedFromSessionId: null,
      modelProvider: "vm0",
      selectedModel: "claude-sonnet-4-6",
    });
    expect(run?.sessionId).not.toBe(previousSessionId);
  });

  it("starts a new AgentPhone session when the default model provider changed", async () => {
    configureAgentPhoneEnv();
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const phoneHandle = uniquePhone();
    const { previousSessionId } = await seedAgentPhoneModelReuseFixture({
      userId,
      orgId,
      phoneHandle,
      selectedModel: "claude-sonnet-4-6",
      previousModelProvider: "openrouter-api-key",
    });
    await writeDb
      .update(orgMembersMetadata)
      .set({ selectedModel: null })
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      );
    const sendCalls = agentPhoneSendMessage();
    const app = createApp({ signal: context.signal });
    const prompt = "default provider changed AgentPhone session";
    const body = {
      event: "agent.message",
      channel: "sms",
      data: {
        id: "ap-default-provider-change",
        agentId: "agt-agentphone",
        from: phoneHandle,
        to: "+19039853128",
        body: prompt,
      },
    };
    const rawBody = JSON.stringify(body);
    const timestamp = String(currentSecond());

    const response = await app.request("/api/agentphone/webhook", {
      method: "POST",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signAgentPhoneWebhook(rawBody, timestamp),
        "x-webhook-id": "webhook-default-provider-change",
      },
      body: rawBody,
    });
    expect(response.status).toBe(200);
    await clearAllDetached();

    expect(sendCalls).toStrictEqual([]);
    const [run] = await writeDb
      .select({
        sessionId: agentRuns.sessionId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.prompt, prompt))
      .limit(1);
    expect(run).toMatchObject({
      continuedFromSessionId: null,
      modelProvider: "vm0",
      selectedModel: "claude-sonnet-4-6",
    });
    expect(run?.sessionId).not.toBe(previousSessionId);
  });

  it.each([
    {
      scenario: "formats generic failed run output like Web",
      error: "AgentPhone route failure",
      expectedBody: "Oops, something went wrong. Please try again later.",
    },
    {
      scenario: "preserves actionable failed run output like Web",
      error: "Cannot continue session from checkpoint",
      expectedBody: "Cannot continue session from checkpoint",
    },
  ])("post /api/internal/callbacks/agentphone $scenario", async (example) => {
    configureAgentPhoneEnv();
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const phoneHandle = uniquePhone();
    const userLinkId = await seedAgentPhoneLink({ phoneHandle, userId, orgId });
    const run = await seedRun({ userId, orgId });
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: run.runId,
        url: "http://api.test/api/internal/callbacks/agentphone",
        payload: {},
      },
      context.signal,
    );
    const sendCalls = agentPhoneSendMessage();
    const app = createApp({ signal: context.signal });
    const rawBody = JSON.stringify({
      callbackId,
      runId: run.runId,
      status: "failed",
      error: example.error,
      payload: {
        messageId: "ap-inbound-callback",
        conversationId: null,
        channel: "sms",
        phoneHandle,
        fromNumber: phoneHandle,
        toNumber: "+19039853128",
        userLinkId,
        agentId: run.composeId,
        agentphoneAgentId: "agt-agentphone",
        existingSessionId: null,
      },
    });

    const response = await app.request("/api/internal/callbacks/agentphone", {
      method: "POST",
      headers: callbackHeaders(rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(sendCalls[0]).toStrictEqual(
      expect.objectContaining({
        agent_id: "agt-agentphone",
        to_number: phoneHandle,
        body: example.expectedBody,
      }),
    );
  });

  it("post /api/zero/integrations/phone/message sends and records a linked phone message", async () => {
    configureAgentPhoneEnv();
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const phoneHandle = uniquePhone();
    await seedOrgMembership({ orgId, userId });
    await seedAgentPhoneLink({ phoneHandle, userId, orgId });
    const sendCalls = agentPhoneSendMessage();
    const client = setupApp({ context })(integrationsPhoneMessageContract);

    const response = await accept(
      client.sendMessage({
        headers: {
          authorization: `Bearer ${zeroToken({
            userId,
            orgId,
            capabilities: ["phone:write"],
          })}`,
        },
        body: {
          toNumber: phoneHandle,
          text: "hello from zero",
          agentphoneAgentId: "agt-agentphone",
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      ok: true,
      channel: "sms",
      toNumber: phoneHandle,
    });
    expect(sendCalls[0]).toStrictEqual(
      expect.objectContaining({ body: "hello from zero" }),
    );
    await expect(
      readAgentPhoneMessage(response.body.messageId),
    ).resolves.toMatchObject({
      direction: "outbound",
      phoneHandle,
      body: "hello from zero",
    });
  });

  it("post /api/zero/integrations/phone/upload-file/init returns an upload URL", async () => {
    configureAgentPhoneEnv();
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    await seedOrgMembership({ orgId, userId });
    const client = setupApp({ context })(integrationsPhoneUploadInitContract);

    const response = await accept(
      client.init({
        headers: {
          authorization: `Bearer ${zeroToken({
            userId,
            orgId,
            capabilities: ["phone:write"],
          })}`,
        },
        body: {
          filename: "screen shot.png",
          contentType: "image/png",
          length: 123,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      uploadUrl: "https://r2.example.com/upload?sig=test",
      filename: "screen_shot.png",
      contentType: "image/png",
      size: 123,
    });
    expect(response.body.fileUrl).toContain("https://cdn.vm7.io/artifacts/");
  });

  it("post /api/zero/integrations/phone/upload-file/complete sends uploaded media", async () => {
    configureAgentPhoneEnv();
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const phoneHandle = uniquePhone();
    const uploadId = randomUUID();
    await seedOrgMembership({ orgId, userId });
    const run = await seedRun({ userId, orgId });
    await seedAgentPhoneLink({ phoneHandle, userId, orgId });
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${userId}/${uploadId}/photo.png`,
        size: 456,
      },
    ]);
    const sendCalls = agentPhoneSendMessage();
    const client = setupApp({ context })(
      integrationsPhoneUploadCompleteContract,
    );

    const response = await accept(
      client.complete({
        headers: {
          authorization: `Bearer ${zeroToken({
            userId,
            orgId,
            runId: run.runId,
            capabilities: ["phone:write"],
          })}`,
        },
        body: {
          uploadId,
          toNumber: phoneHandle,
          agentphoneAgentId: "agt-agentphone",
          caption: "see attached",
          contentType: "image/png",
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      filename: "photo.png",
      mimetype: "image/png",
      size: 456,
      toNumber: phoneHandle,
    });
    expect(sendCalls[0]).toStrictEqual(
      expect.objectContaining({
        body: "see attached",
        media_url: response.body.url,
      }),
    );
    await expect(
      readAgentPhoneMessage(response.body.messageId),
    ).resolves.toMatchObject({
      direction: "outbound",
      mediaUrl: response.body.url,
    });
  });

  it("get /api/zero/integrations/phone/download-file streams owned AgentPhone media", async () => {
    configureAgentPhoneEnv();
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const phoneHandle = uniquePhone();
    const fileId = "ap-media-1";
    await seedOrgMembership({ orgId, userId });
    const userLinkId = await seedAgentPhoneLink({ phoneHandle, userId, orgId });
    await seedAgentPhoneMessage({
      messageId: fileId,
      phoneHandle,
      userLinkId,
      agentphoneAgentId: "agt-agentphone",
      mediaUrl: "https://media.agentphone.test/photo%20one.png",
    });
    server.use(
      http.get("https://media.agentphone.test/photo%20one.png", () => {
        return new HttpResponse("png-bytes", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "9",
          },
        });
      }),
    );
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      `/api/zero/integrations/phone/download-file?file_id=${fileId}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${zeroToken({
            userId,
            orgId,
            capabilities: ["phone:read"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("photo%20one.png");
    await expect(response.text()).resolves.toBe("png-bytes");
  });

  it("get /api/zero/integrations/phone/download-file requires phone read auth", async () => {
    const client = setupApp({ context })(integrationsPhoneDownloadFileContract);

    const response = await accept(
      client.download({
        headers: {},
        query: { file_id: "missing" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });
});
