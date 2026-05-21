import { createHmac, randomUUID } from "node:crypto";

import { zeroIntegrationsWhatsAppContract } from "@vm0/api-contracts/contracts/zero-integrations-whatsapp";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { whatsappMessages } from "@vm0/db/schema/whatsapp-message";
import { whatsappUserLinks } from "@vm0/db/schema/whatsapp-user-link";
import { whatsappThreadSessions } from "@vm0/db/schema/whatsapp-thread-session";
import { whatsappUserAgentPreferences } from "@vm0/db/schema/whatsapp-user-agent-preference";
import { whatsappVerificationSendCooldowns } from "@vm0/db/schema/whatsapp-verification-send-cooldown";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { clearAllDetached } from "../../utils";
import { signWhatsAppConnectParams } from "../../services/zero-whatsapp.service";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

interface TwilioSendCall {
  readonly accountSid: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly body: string | null;
}

interface TwilioTypingCall {
  readonly messageId: string | null;
  readonly channel: string | null;
}

interface WhatsAppRunFixture {
  readonly userId: string;
  readonly orgId: string;
}

const WEBHOOK_URL = "http://api.test/api/integrations/twilio/webhook";
const TWILIO_AUTH_TOKEN = "twilio-test-token";
const CALLBACK_SECRET = "test-whatsapp-callback-secret";
const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);
const mocks = createZeroRouteMocks(context);

const trackPhone = createFixtureTracker(
  async (fixture: { readonly phoneHandle: string }) => {
    await writeDb
      .delete(whatsappMessages)
      .where(eq(whatsappMessages.phoneHandle, fixture.phoneHandle));
    await writeDb
      .delete(whatsappUserLinks)
      .where(eq(whatsappUserLinks.phoneHandle, fixture.phoneHandle));
  },
);

const trackVerificationSendCooldown = createFixtureTracker(
  async (fixture: { readonly scope: string; readonly scopeKey: string }) => {
    await writeDb
      .delete(whatsappVerificationSendCooldowns)
      .where(
        and(
          eq(whatsappVerificationSendCooldowns.scope, fixture.scope),
          eq(whatsappVerificationSendCooldowns.scopeKey, fixture.scopeKey),
        ),
      );
  },
);

const trackWhatsAppRunFixture = createFixtureTracker(
  async (fixture: WhatsAppRunFixture) => {
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
        .delete(runnerJobQueue)
        .where(inArray(runnerJobQueue.runId, runIds));
      await writeDb
        .delete(agentRunCallbacks)
        .where(inArray(agentRunCallbacks.runId, runIds));
      await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    }

    await writeDb
      .delete(whatsappThreadSessions)
      .where(
        inArray(
          whatsappThreadSessions.whatsappUserLinkId,
          writeDb
            .select({ id: whatsappUserLinks.id })
            .from(whatsappUserLinks)
            .where(eq(whatsappUserLinks.orgId, fixture.orgId)),
        ),
      );
    await writeDb
      .delete(agentSessions)
      .where(
        and(
          eq(agentSessions.orgId, fixture.orgId),
          eq(agentSessions.userId, fixture.userId),
        ),
      );
    await writeDb
      .delete(whatsappUserAgentPreferences)
      .where(eq(whatsappUserAgentPreferences.orgId, fixture.orgId));

    const composeRows = await writeDb
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    const composeIds = composeRows.map((row) => {
      return row.id;
    });
    if (composeIds.length > 0) {
      await writeDb
        .delete(zeroAgents)
        .where(inArray(zeroAgents.id, composeIds));
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
    await writeDb.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, fixture.orgId));
    await writeDb
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, fixture.orgId));
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
  },
);

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function uniquePhone(): string {
  const digits = randomUUID().replace(/\D/gu, "").padEnd(7, "0").slice(0, 7);
  return `+1555${digits}`;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function setupWhatsAppUser(): {
  readonly userId: string;
  readonly orgId: string;
} {
  const userId = uniqueId("user");
  const orgId = uniqueId("org");
  mocks.clerk.session(userId, orgId);
  mockEnv("APP_URL", "http://localhost:3002");
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  mockOptionalEnv("TWILIO_ACCOUNT_SID", "ACtest");
  mockOptionalEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
  mockOptionalEnv("TWILIO_WHATSAPP_FROM_NUMBER", "+19039853128");
  mockOptionalEnv("TWILIO_WHATSAPP_WEBHOOK_URL", WEBHOOK_URL);
  return { userId, orgId };
}

async function insertWhatsAppUserLink(params: {
  readonly phoneHandle: string;
  readonly vm0UserId: string;
  readonly orgId: string;
}): Promise<void> {
  await writeDb.insert(whatsappUserLinks).values(params);
  await trackPhone(Promise.resolve({ phoneHandle: params.phoneHandle }));
}

async function trackWhatsAppVerificationCooldowns(params: {
  readonly userId: string;
  readonly orgId: string;
  readonly phoneHandles: readonly string[];
}): Promise<void> {
  await trackVerificationSendCooldown(
    Promise.resolve({
      scope: "user_org",
      scopeKey: `${params.orgId}:${params.userId}`,
    }),
  );
  for (const phoneHandle of params.phoneHandles) {
    await trackVerificationSendCooldown(
      Promise.resolve({ scope: "phone", scopeKey: phoneHandle }),
    );
  }
}

async function findWhatsAppUserLink(phoneHandle: string) {
  const [row] = await writeDb
    .select()
    .from(whatsappUserLinks)
    .where(eq(whatsappUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  return row;
}

async function readWhatsAppMessage(messageSid: string) {
  const [row] = await writeDb
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.twilioMessageSid, messageSid))
    .limit(1);
  return row;
}

function twilioSendMessage() {
  const calls: TwilioSendCall[] = [];
  const handler = http.post(
    "https://api.twilio.com/2010-04-01/Accounts/:accountSid/Messages.json",
    async ({ params, request }) => {
      const text = await request.text();
      const body = new URLSearchParams(text);
      calls.push({
        accountSid: String(params.accountSid),
        from: body.get("From"),
        to: body.get("To"),
        body: body.get("Body"),
      });
      return HttpResponse.json({
        sid: uniqueId("SM"),
        status: "queued",
        from: body.get("From"),
        to: body.get("To"),
        body: body.get("Body"),
      });
    },
  );
  return { handler, calls };
}

function twilioTypingIndicator() {
  const calls: TwilioTypingCall[] = [];
  const handler = http.post(
    "https://messaging.twilio.com/v2/Indicators/Typing.json",
    async ({ request }) => {
      const text = await request.text();
      const body = new URLSearchParams(text);
      calls.push({
        messageId: body.get("messageId"),
        channel: body.get("channel"),
      });
      return HttpResponse.json({ success: true });
    },
  );
  return { handler, calls };
}

function twilioCallbackSink() {
  return http.post(
    "http://localhost:3000/api/internal/callbacks/twilio",
    () => {
      return HttpResponse.json({ ok: true });
    },
  );
}

async function seedWhatsAppAgent(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly name: string;
  readonly displayName: string;
}): Promise<string> {
  const composeId = randomUUID();
  const versionId = randomUUID();
  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId: args.userId,
    orgId: args.orgId,
    name: args.name,
    headVersionId: versionId,
  });
  await writeDb.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    createdBy: args.userId,
    content: {
      version: "1.0",
      agents: {
        [args.name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
        },
      },
    },
  });
  await writeDb.insert(zeroAgents).values({
    id: composeId,
    orgId: args.orgId,
    owner: args.userId,
    name: args.name,
    displayName: args.displayName,
    visibility: "public",
    customSkills: [],
  });
  return composeId;
}

async function seedWhatsAppRunFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly phoneHandle: string;
  readonly selectedComposeId?: string | null;
}): Promise<{
  readonly defaultComposeId: string;
  readonly preferredComposeId: string;
  readonly userLinkId: string;
}> {
  const defaultComposeId = await seedWhatsAppAgent({
    userId: args.userId,
    orgId: args.orgId,
    name: "whatsapp-default-agent",
    displayName: "WhatsApp Default Agent",
  });
  const preferredComposeId = await seedWhatsAppAgent({
    userId: args.userId,
    orgId: args.orgId,
    name: "whatsapp-preferred-agent",
    displayName: "WhatsApp Preferred Agent",
  });
  await writeDb.insert(orgMetadata).values({
    orgId: args.orgId,
    defaultAgentId: defaultComposeId,
    tier: "free",
    credits: 100_000,
  });
  await writeDb.insert(orgMembersMetadata).values({
    orgId: args.orgId,
    userId: args.userId,
    timezone: "UTC",
  });
  await writeDb.insert(vm0ApiKeys).values([
    {
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: `vm0-key-anthropic-${args.orgId}`,
      label: args.orgId,
    },
    {
      vendor: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: `vm0-key-deepseek-${args.orgId}`,
      label: args.orgId,
    },
  ]);
  await writeDb.insert(whatsappUserLinks).values({
    phoneHandle: args.phoneHandle,
    vm0UserId: args.userId,
    orgId: args.orgId,
  });
  const [link] = await writeDb
    .select({ id: whatsappUserLinks.id })
    .from(whatsappUserLinks)
    .where(eq(whatsappUserLinks.phoneHandle, args.phoneHandle))
    .limit(1);
  if (!link) {
    throw new Error("seedWhatsAppRunFixture did not create a user link");
  }

  if (args.selectedComposeId !== undefined) {
    await writeDb.insert(whatsappUserAgentPreferences).values({
      vm0UserId: args.userId,
      orgId: args.orgId,
      selectedComposeId: args.selectedComposeId,
    });
  }

  await trackPhone(Promise.resolve({ phoneHandle: args.phoneHandle }));
  await trackWhatsAppRunFixture(
    Promise.resolve({ userId: args.userId, orgId: args.orgId }),
  );

  return { defaultComposeId, preferredComposeId, userLinkId: link.id };
}

async function readRunAgentComposeId(prompt: string): Promise<string | null> {
  const [run] = await writeDb
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(eq(agentRuns.prompt, prompt))
    .limit(1);
  return run?.agentComposeId ?? null;
}

async function readSelectedModel(args: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<string | null> {
  const [row] = await writeDb
    .select({ selectedModel: orgMembersMetadata.selectedModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.userId, args.userId),
        eq(orgMembersMetadata.orgId, args.orgId),
      ),
    )
    .limit(1);
  return row?.selectedModel ?? null;
}

async function seedCallbackRun(args: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<{ readonly runId: string; readonly callbackId: string }> {
  const composeId = await seedWhatsAppAgent({
    userId: args.userId,
    orgId: args.orgId,
    name: "whatsapp-callback-agent",
    displayName: "WhatsApp Callback Agent",
  });
  const [session] = await writeDb
    .insert(agentSessions)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      agentComposeId: composeId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("seedCallbackRun did not create a session");
  }
  const [run] = await writeDb
    .insert(agentRuns)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      sessionId: session.id,
      status: "running",
      prompt: "whatsapp callback progress",
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("seedCallbackRun did not create a run");
  }
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId: run.id,
      url: "http://api.test/api/internal/callbacks/twilio",
      secret: CALLBACK_SECRET,
      payload: {},
    },
    context.signal,
  );
  await trackWhatsAppRunFixture(
    Promise.resolve({ userId: args.userId, orgId: args.orgId }),
  );
  return { runId: run.id, callbackId };
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

function signTwilioWebhook(form: URLSearchParams): string {
  const signed = [...form.entries()]
    .sort((left, right) => {
      if (left[0] !== right[0]) {
        return left[0] < right[0] ? -1 : 1;
      }
      if (left[1] === right[1]) {
        return 0;
      }
      return left[1] < right[1] ? -1 : 1;
    })
    .reduce((acc, [key, value]) => {
      return `${acc}${key}${value}`;
    }, WEBHOOK_URL);
  return createHmac("sha1", TWILIO_AUTH_TOKEN).update(signed).digest("base64");
}

function postTwilioWebhook(form: URLSearchParams): Promise<Response> {
  return Promise.resolve(
    createApp({ signal: context.signal }).request(
      "/api/integrations/twilio/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": signTwilioWebhook(form),
        },
        body: form.toString(),
      },
    ),
  );
}

describe("WhatsApp integration routes", () => {
  it("returns the current linked WhatsApp handle", async () => {
    const user = setupWhatsAppUser();
    const phone = uniquePhone();
    await insertWhatsAppUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const client = setupApp({ context })(zeroIntegrationsWhatsAppContract);

    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      linked: true,
      phoneHandle: phone,
      whatsAppNumber: "+19039853128",
      configured: true,
    });
  });

  it("sends a signed verification link and does not silently link the phone", async () => {
    const user = setupWhatsAppUser();
    await trackWhatsAppVerificationCooldowns({
      ...user,
      phoneHandles: ["+15555551212"],
    });
    const sendMessage = twilioSendMessage();
    server.use(sendMessage.handler);
    const client = setupApp({ context })(zeroIntegrationsWhatsAppContract);

    const response = await accept(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle: "+1 (555) 555-1212" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      phoneHandle: "+15555551212",
      verificationSent: true,
    });
    expect(sendMessage.calls).toHaveLength(1);
    expect(sendMessage.calls[0]).toStrictEqual(
      expect.objectContaining({
        accountSid: "ACtest",
        from: "whatsapp:+19039853128",
        to: "whatsapp:+15555551212",
      }),
    );
    expect(sendMessage.calls[0]?.body).toContain("/whatsapp/connect?");
    await expect(findWhatsAppUserLink("+15555551212")).resolves.toBeUndefined();
  });

  it("connects a signed WhatsApp link for the authenticated user", async () => {
    const user = setupWhatsAppUser();
    const sendMessage = twilioSendMessage();
    server.use(sendMessage.handler);
    const client = setupApp({ context })(zeroIntegrationsWhatsAppContract);
    const phoneHandle = uniquePhone();
    await trackPhone(Promise.resolve({ phoneHandle }));
    const timestamp = currentSecond();

    const response = await accept(
      client.connectWhatsApp({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          phoneHandle,
          timestamp,
          signature: signWhatsAppConnectParams({
            phoneHandle,
            timestamp,
            secret: "a".repeat(64),
          }),
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ phoneHandle });
    await expect(findWhatsAppUserLink(phoneHandle)).resolves.toMatchObject({
      phoneHandle,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    expect(sendMessage.calls.at(-1)).toStrictEqual(
      expect.objectContaining({
        to: `whatsapp:${phoneHandle}`,
      }),
    );
  });

  it("verifies Twilio signatures before accepting inbound WhatsApp messages", async () => {
    setupWhatsAppUser();
    const sendMessage = twilioSendMessage();
    server.use(sendMessage.handler);
    const form = new URLSearchParams({
      MessageSid: uniqueId("SM"),
      From: "whatsapp:+15555551212",
      To: "whatsapp:+19039853128",
      Body: "/connect",
      NumMedia: "0",
    });
    await trackPhone(Promise.resolve({ phoneHandle: "+15555551212" }));

    const rejected = await createApp({ signal: context.signal }).request(
      "/api/integrations/twilio/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "bad-signature",
        },
        body: form.toString(),
      },
    );
    expect(rejected.status).toBe(401);

    const accepted = await postTwilioWebhook(form);
    expect(accepted.status).toBe(200);
    await clearAllDetached();

    await expect(
      readWhatsAppMessage(form.get("MessageSid") ?? ""),
    ).resolves.toMatchObject({
      phoneHandle: "+15555551212",
      fromNumber: "+15555551212",
      toNumber: "+19039853128",
      direction: "inbound",
      body: "/connect",
    });
    expect(sendMessage.calls.at(-1)?.body).toContain("/whatsapp/connect?");
  });

  it("uses the selected WhatsApp agent preference when creating runs", async () => {
    const user = setupWhatsAppUser();
    const phoneHandle = uniquePhone();
    const fixture = await seedWhatsAppRunFixture({
      ...user,
      phoneHandle,
      selectedComposeId: null,
    });
    await writeDb
      .update(whatsappUserAgentPreferences)
      .set({ selectedComposeId: fixture.preferredComposeId })
      .where(
        and(
          eq(whatsappUserAgentPreferences.vm0UserId, user.userId),
          eq(whatsappUserAgentPreferences.orgId, user.orgId),
        ),
      );
    const typing = twilioTypingIndicator();
    server.use(typing.handler, twilioCallbackSink());
    const prompt = "run with preferred WhatsApp agent";
    const messageSid = uniqueId("SM");
    const form = new URLSearchParams({
      MessageSid: messageSid,
      From: `whatsapp:${phoneHandle}`,
      To: "whatsapp:+19039853128",
      Body: prompt,
      NumMedia: "0",
    });

    const response = await postTwilioWebhook(form);
    expect(response.status).toBe(200);
    await clearAllDetached();

    await expect(readRunAgentComposeId(prompt)).resolves.toBe(
      fixture.preferredComposeId,
    );
    expect(typing.calls).toContainEqual({
      messageId: messageSid,
      channel: "whatsapp",
    });
  });

  it("switches the user model from WhatsApp /model commands", async () => {
    const user = setupWhatsAppUser();
    const phoneHandle = uniquePhone();
    await seedWhatsAppRunFixture({ ...user, phoneHandle });
    const sendMessage = twilioSendMessage();
    server.use(sendMessage.handler);
    const form = new URLSearchParams({
      MessageSid: uniqueId("SM"),
      From: `whatsapp:${phoneHandle}`,
      To: "whatsapp:+19039853128",
      Body: "/model claude-sonnet-4-6",
      NumMedia: "0",
    });

    const response = await postTwilioWebhook(form);
    expect(response.status).toBe(200);
    await clearAllDetached();

    await expect(readSelectedModel(user)).resolves.toBe("claude-sonnet-4-6");
    expect(sendMessage.calls.at(-1)?.body).toContain("Switched to");
  });

  it("refreshes Twilio WhatsApp typing indicators for progress callbacks", async () => {
    const user = setupWhatsAppUser();
    const typing = twilioTypingIndicator();
    server.use(typing.handler);
    const { runId, callbackId } = await seedCallbackRun(user);
    const messageSid = uniqueId("SM");
    const body = JSON.stringify({
      callbackId,
      runId,
      status: "progress",
      payload: {
        messageSid,
        rootMessageId: "dm",
        phoneHandle: "+15555551212",
        fromNumber: "+15555551212",
        toNumber: "+19039853128",
        userLinkId: randomUUID(),
        agentId: randomUUID(),
        existingSessionId: null,
      },
    });

    const response = await createApp({ signal: context.signal }).request(
      "/api/internal/callbacks/twilio",
      {
        method: "POST",
        headers: callbackHeaders(body),
        body,
      },
    );

    expect(response.status).toBe(200);
    expect(typing.calls).toStrictEqual([
      { messageId: messageSid, channel: "whatsapp" },
    ]);
  });
});
