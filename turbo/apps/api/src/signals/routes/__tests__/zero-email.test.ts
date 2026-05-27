import { randomUUID } from "node:crypto";

import { Webhook } from "svix";
import { createStore, command } from "ccstate";
import { describe, expect, it, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { emailSuppressions } from "@vm0/db/schema/email-suppression";
import { emailThreadSessions } from "@vm0/db/schema/email-thread-session";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { userCache } from "@vm0/db/schema/user-cache";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { users } from "@vm0/db/schema/user";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray, or } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { clearAllDetached } from "../../utils";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { generateReplyToken } from "../../services/zero-email-common.service";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const resendMocks = context.mocks.resend;
const store = createStore();
const routeMocks = createZeroRouteMocks(context);

const CALLBACK_SECRET = "test-callback-secret";
const INBOUND_SECRET = "whsec_test";
const REPLY_PATH = "/api/zero/email/callbacks/reply";
const TRIGGER_PATH = "/api/zero/email/callbacks/trigger";
const INBOUND_PATH = "/api/zero/email/inbound";

interface EmailFixture {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly versionId: string;
}

const deleteEmailFixture$ = command(
  async (
    { set },
    fixture: EmailFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(emailOutbox)
      .where(
        or(
          eq(
            emailOutbox.fromAddress,
            `Zero <${fixture.orgSlug}@mail.example.com>`,
          ),
          eq(emailOutbox.fromAddress, "Zero <vm0@mail.example.com>"),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(emailSuppressions)
      .where(
        or(
          eq(emailSuppressions.emailAddress, fixture.userEmail),
          eq(
            emailSuppressions.emailAddress,
            `bounce-${fixture.orgSlug}@example.com`,
          ),
          eq(
            emailSuppressions.emailAddress,
            `complaint-${fixture.orgSlug}@example.com`,
          ),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(emailThreadSessions)
      .where(eq(emailThreadSessions.userId, fixture.userId));
    signal.throwIfAborted();

    const runRows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, fixture.orgId),
          eq(agentRuns.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    const runIds = runRows.map((row) => {
      return row.id;
    });
    if (runIds.length > 0) {
      await db
        .delete(agentRunCallbacks)
        .where(inArray(agentRunCallbacks.runId, runIds));
      signal.throwIfAborted();
      await db
        .delete(runnerJobQueue)
        .where(inArray(runnerJobQueue.runId, runIds));
      signal.throwIfAborted();
      await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      signal.throwIfAborted();
      await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }
    await db
      .delete(agentSessions)
      .where(
        and(
          eq(agentSessions.orgId, fixture.orgId),
          eq(agentSessions.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await db.delete(zeroAgents).where(eq(zeroAgents.id, fixture.agentId));
    signal.throwIfAborted();
    await db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.composeId, fixture.agentId));
    signal.throwIfAborted();
    await db.delete(agentComposes).where(eq(agentComposes.id, fixture.agentId));
    signal.throwIfAborted();
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await db.delete(orgCache).where(eq(orgCache.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, fixture.orgId),
          eq(orgMembersCache.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await db.delete(userCache).where(eq(userCache.userId, fixture.userId));
    signal.throwIfAborted();
    await db.delete(users).where(eq(users.id, fixture.userId));
  },
);

const seedEmailFixture$ = command(
  async ({ set }, _input: void, signal: AbortSignal): Promise<EmailFixture> => {
    const db = set(writeDb$);
    const id = randomUUID().slice(0, 8);
    const orgId = `org_${randomUUID()}`;
    const orgSlug = `email-${id}`;
    const userId = `user_${randomUUID()}`;
    const userEmail = `${orgSlug}@example.com`;
    const agentId = randomUUID();
    const versionId = randomUUID();
    const agentName = `agent-${id}`;

    await db.insert(orgCache).values({
      orgId,
      slug: orgSlug,
      name: "Email Test Org",
      createdBy: userId,
      cachedAt: nowDate(),
    });
    signal.throwIfAborted();
    await db.insert(userCache).values({
      userId,
      email: userEmail,
      name: "Email User",
      cachedAt: nowDate(),
    });
    signal.throwIfAborted();
    await db.insert(orgMembersCache).values({
      orgId,
      userId,
      role: "member",
      cachedAt: nowDate(),
    });
    signal.throwIfAborted();
    await db.insert(agentComposes).values({
      id: agentId,
      orgId,
      userId,
      name: agentName,
    });
    signal.throwIfAborted();
    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: agentId,
      createdBy: userId,
      content: {
        version: "1.0",
        agents: {
          main: {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "test-key" },
          },
        },
      },
    });
    signal.throwIfAborted();
    await db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, agentId));
    signal.throwIfAborted();
    await db.insert(zeroAgents).values({
      id: agentId,
      orgId,
      owner: userId,
      name: agentName,
      visibility: "public",
    });
    signal.throwIfAborted();
    await db.insert(orgMetadata).values({
      orgId,
      defaultAgentId: agentId,
      tier: "free",
      credits: 10_000,
    });
    signal.throwIfAborted();
    return { orgId, orgSlug, userId, userEmail, agentId, agentName, versionId };
  },
);

const track = createFixtureTracker<EmailFixture>((fixture) => {
  return store.set(deleteEmailFixture$, fixture, context.signal);
});

async function fixture(): Promise<EmailFixture> {
  const created = await track(
    store.set(seedEmailFixture$, undefined, context.signal),
  );
  routeMocks.clerk.session(created.userId, created.orgId);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: created.orgId }, role: "org:member" }],
  });
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  return created;
}

async function seedAgentSession(fx: EmailFixture): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(agentSessions)
    .values({
      orgId: fx.orgId,
      userId: fx.userId,
      agentComposeId: fx.agentId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Failed to seed agent session");
  }
  return session.id;
}

async function seedRun(args: {
  readonly fixture: EmailFixture;
  readonly status: "completed" | "failed" | "running";
  readonly result?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly prompt?: string;
}): Promise<{ readonly runId: string; readonly sessionId: string }> {
  const sessionId = await seedAgentSession(args.fixture);
  const db = store.set(writeDb$);
  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      agentComposeVersionId: args.fixture.versionId,
      sessionId,
      prompt: args.prompt ?? "email prompt",
      status: args.status,
      result: args.result ?? null,
      error: args.error ?? null,
      lastEventSequence: 3,
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("Failed to seed agent run");
  }
  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "email",
  });
  return { runId: run.id, sessionId };
}

async function seedThread(args: {
  readonly fixture: EmailFixture;
  readonly agentSessionId: string;
  readonly lastEmailMessageId?: string | null;
}): Promise<{ readonly id: string; readonly replyToken: string }> {
  const replyToken = generateReplyToken(args.agentSessionId);
  const db = store.set(writeDb$);
  const [thread] = await db
    .insert(emailThreadSessions)
    .values({
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      agentId: args.fixture.agentId,
      agentSessionId: args.agentSessionId,
      replyToToken: replyToken,
      lastEmailMessageId: args.lastEmailMessageId ?? null,
    })
    .returning({ id: emailThreadSessions.id });
  if (!thread) {
    throw new Error("Failed to seed email thread");
  }
  return { id: thread.id, replyToken };
}

interface CallbackPostOptions {
  readonly secret?: string;
  readonly timestamp?: number;
}

function signedCallbackHeaders(
  rawBody: string,
  options: CallbackPostOptions = {},
) {
  const timestamp = options.timestamp ?? Math.floor(now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(
      rawBody,
      options.secret ?? CALLBACK_SECRET,
      timestamp,
    ),
    "X-VM0-Timestamp": String(timestamp),
  };
}

async function postCallback(
  path: string,
  body: Record<string, unknown>,
  options?: CallbackPostOptions | string,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const headerOptions =
    typeof options === "string" ? { secret: options } : options;
  return await createApp({ signal: context.signal }).request(path, {
    method: "POST",
    headers: signedCallbackHeaders(rawBody, headerOptions),
    body: rawBody,
  });
}

function svixHeaders(rawBody: string): Record<string, string> {
  const id = `msg_${randomUUID()}`;
  const timestamp = nowDate();
  return {
    "Content-Type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(INBOUND_SECRET).sign(id, timestamp, rawBody),
  };
}

async function postInbound(event: WebhookEvent): Promise<Response> {
  const rawBody = JSON.stringify(event);
  return await createApp({ signal: context.signal }).request(INBOUND_PATH, {
    method: "POST",
    headers: svixHeaders(rawBody),
    body: rawBody,
  });
}

interface WebhookEvent {
  readonly type: string;
  readonly data?: {
    readonly email_id?: string;
    readonly to?: readonly string[];
    readonly from?: string;
    readonly subject?: string;
  };
}

function mockReceivedEmail(args: {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly replyTo?: readonly string[];
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Record<string, string>;
}): void {
  const headers =
    args.headers ??
    ({
      "Authentication-Results": "mx.example; dmarc=pass",
      "Message-ID": "<inbound@example.com>",
    } satisfies Record<string, string>);
  resendMocks.receivingGet.mockResolvedValue({
    data: {
      from: args.from,
      to: [...args.to],
      cc: [...(args.cc ?? [])],
      reply_to: [...(args.replyTo ?? [])],
      subject: args.subject ?? "Email subject",
      text: args.text ?? "Email body",
      html: args.html ?? "",
      headers,
    },
  });
}

function mockNoAttachments(): void {
  resendMocks.attachmentsList.mockResolvedValue({ data: { data: [] } });
}

interface MockEmailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly downloadUrl: string;
}

function mockEmailAttachments(
  attachments: readonly MockEmailAttachment[],
): void {
  resendMocks.attachmentsList.mockResolvedValue({
    data: {
      data: attachments.map((attachment) => {
        return {
          id: attachment.id,
          filename: attachment.filename,
          size: attachment.size,
          content_type: attachment.contentType,
          content_disposition: attachment.contentDisposition,
          download_url: attachment.downloadUrl,
        };
      }),
    },
  });
}

function mockAttachmentDownload(args: {
  readonly url: string;
  readonly body?: BodyInit | null;
  readonly status?: number;
  readonly contentType?: string;
}): void {
  server.use(
    http.get(args.url, () => {
      return new HttpResponse(args.body ?? Buffer.from("attachment bytes"), {
        status: args.status ?? 200,
        headers: { "content-type": args.contentType ?? "application/pdf" },
      });
    }),
  );
}

function mockRunOutput(text: string): void {
  context.mocks.axiom.query
    .mockResolvedValueOnce(
      Array.from({ length: 4 }, (_, sequenceNumber) => {
        return { sequenceNumber };
      }),
    )
    .mockResolvedValueOnce([
      { eventType: "result", eventData: { result: text } },
    ]);
}

interface SentEmail {
  readonly to?: string | readonly string[];
  readonly cc?: string | readonly string[];
  readonly subject?: string;
  readonly html?: string;
  readonly headers?: Record<string, string>;
  readonly replyTo?: string;
}

function lastSentEmail(): SentEmail {
  const call = resendMocks.send.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0] as SentEmail;
}

async function seedReplyCallback(args: {
  readonly fixture: EmailFixture;
  readonly status?: "completed" | "failed" | "running";
  readonly result?: Record<string, unknown> | null;
  readonly prompt?: string;
  readonly lastEmailMessageId?: string | null;
}): Promise<{
  readonly callbackId: string;
  readonly runId: string;
  readonly thread: { readonly id: string; readonly replyToken: string };
}> {
  const run = await seedRun({
    fixture: args.fixture,
    status: args.status ?? "completed",
    result: args.result,
    prompt: args.prompt,
  });
  const thread = await seedThread({
    fixture: args.fixture,
    agentSessionId: run.sessionId,
    lastEmailMessageId: args.lastEmailMessageId,
  });
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId: run.runId,
      url: `http://localhost${REPLY_PATH}`,
      payload: { emailThreadSessionId: thread.id },
    },
    context.signal,
  );
  return { callbackId, runId: run.runId, thread };
}

async function seedTriggerCallback(args: {
  readonly fixture: EmailFixture;
  readonly status?: "completed" | "failed" | "running";
  readonly result?: Record<string, unknown> | null;
  readonly prompt?: string;
}): Promise<{
  readonly callbackId: string;
  readonly runId: string;
  readonly replyToken: string;
}> {
  const run = await seedRun({
    fixture: args.fixture,
    status: args.status ?? "completed",
    result: args.result,
    prompt: args.prompt,
  });
  const replyToken = generateReplyToken(randomUUID());
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId: run.runId,
      url: `http://localhost${TRIGGER_PATH}`,
      payload: { agentId: args.fixture.agentId },
    },
    context.signal,
  );
  return { callbackId, runId: run.runId, replyToken };
}

beforeEach(() => {
  resendMocks.send.mockReset();
  resendMocks.get.mockReset();
  resendMocks.receivingGet.mockReset();
  resendMocks.attachmentsList.mockReset();
  resendMocks.send.mockResolvedValue({ data: { id: "resend-test-id" } });
  resendMocks.get.mockResolvedValue({
    data: { message_id: "<sent@example.com>" },
  });
  mockEnv("RESEND_API_KEY", "test-resend-key");
  mockEnv("RESEND_WEBHOOK_SECRET", INBOUND_SECRET);
  mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
});

describe("POST /api/zero/email/callbacks/reply", () => {
  it("rejects invalid callback signatures", async () => {
    const fx = await fixture();
    const run = await seedRun({ fixture: fx, status: "completed" });
    const thread = await seedThread({
      fixture: fx,
      agentSessionId: run.sessionId,
    });
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: run.runId,
        url: `http://localhost${REPLY_PATH}`,
        payload: { emailThreadSessionId: thread.id },
      },
      context.signal,
    );

    const response = await postCallback(
      REPLY_PATH,
      {
        callbackId,
        runId: run.runId,
        status: "completed",
        payload: {
          emailThreadSessionId: thread.id,
          inboundEmailId: "email_inbound",
        },
      },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("sends a reply email and updates thread state after completion", async () => {
    const fx = await fixture();
    const nextSessionId = await seedAgentSession(fx);
    const run = await seedRun({
      fixture: fx,
      status: "completed",
      result: { agentSessionId: nextSessionId },
      prompt: "summarize email",
    });
    const thread = await seedThread({
      fixture: fx,
      agentSessionId: run.sessionId,
      lastEmailMessageId: "<previous@example.com>",
    });
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: run.runId,
        url: `http://localhost${REPLY_PATH}`,
        payload: { emailThreadSessionId: thread.id },
      },
      context.signal,
    );
    mockRunOutput("final email answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId: run.runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_inbound",
        inboundMessageId: "<inbound@example.com>",
        inboundReferences: "<root@example.com>",
        replyRecipientTo: ["sender@example.com", "teammate@example.com"],
        replyRecipientCc: ["cc@example.com"],
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(resendMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: `Zero <${fx.orgSlug}@mail.example.com>`,
        to: ["sender@example.com", "teammate@example.com"],
        cc: ["cc@example.com"],
        replyTo: `reply+${thread.replyToken}@mail.example.com`,
        subject: `Re: VM0 - Scheduled run for "${fx.agentName}" completed`,
        headers: expect.objectContaining({
          "In-Reply-To": "<inbound@example.com>",
          References: "<root@example.com> <inbound@example.com>",
        }),
      }),
    );
    const email = lastSentEmail();
    expect(email.html).toContain("final email answer");
    expect(email.html).not.toContain(`/activities/${run.runId}`);

    const db = store.set(writeDb$);
    const [updatedThread] = await db
      .select()
      .from(emailThreadSessions)
      .where(eq(emailThreadSessions.id, thread.id));
    expect(updatedThread).toMatchObject({
      agentSessionId: nextSessionId,
      lastEmailMessageId: "<sent@example.com>",
    });
  });

  it("includes the audit log link when the AuditLink switch is enabled", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
    });
    const db = store.set(writeDb$);
    await db.insert(userFeatureSwitches).values({
      orgId: fx.orgId,
      userId: fx.userId,
      switches: { [FeatureSwitchKey.AuditLink]: true },
    });
    mockRunOutput("audited email answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_audit",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.html).toContain(`/activities/${runId}`);
  });

  it("falls back to the last sent email message id when inbound threading headers are missing", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
      lastEmailMessageId: "<bot-prev@example.com>",
    });
    mockRunOutput("fallback threading answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_fallback",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBe("<bot-prev@example.com>");
    expect(email.headers?.References).toBe("<bot-prev@example.com>");
  });

  it("uses the last sent message id in references when only the inbound message id is present", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
      lastEmailMessageId: "<bot-prev@example.com>",
    });
    mockRunOutput("partial threading answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_partial",
        inboundMessageId: "<inbound@example.com>",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBe("<inbound@example.com>");
    expect(email.headers?.References).toBe(
      "<bot-prev@example.com> <inbound@example.com>",
    );
  });

  it("omits threading headers when neither inbound nor session message ids exist", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
    });
    mockRunOutput("no threading answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_without_threading",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBeUndefined();
    expect(email.headers?.References).toBeUndefined();
  });

  it("falls back to the thread owner email and sends the failure message on failed runs", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
      status: "failed",
    });

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_failed",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe(
      `Re: VM0 - Scheduled run for "${fx.agentName}" completed`,
    );
    expect(email.html).toContain("Agent crashed");
  });
});

describe("POST /api/zero/email/callbacks/trigger", () => {
  it("skips before callback verification when Resend is not configured", async () => {
    mockEnv("RESEND_API_KEY", undefined);

    const response = await createApp({ signal: context.signal }).request(
      TRIGGER_PATH,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: randomUUID(), status: "completed" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
  });

  it("rejects invalid callback signatures", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
    });

    const response = await postCallback(
      TRIGGER_PATH,
      {
        callbackId,
        runId,
        status: "completed",
        payload: {
          senderEmail: fx.userEmail,
          agentId: fx.agentId,
          userId: fx.userId,
          inboundEmailId: "email_invalid_signature",
          replyToken,
        },
      },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("rejects expired callback timestamps", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
    });

    const response = await postCallback(
      TRIGGER_PATH,
      {
        callbackId,
        runId,
        status: "completed",
        payload: {
          senderEmail: fx.userEmail,
          agentId: fx.agentId,
          userId: fx.userId,
          inboundEmailId: "email_expired_signature",
          replyToken,
        },
      },
      { timestamp: Math.floor(now() / 1000) - 1000 },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Timestamp expired",
    });
  });

  it("sends a response email and creates the thread session", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const run = await seedRun({
      fixture: fx,
      status: "completed",
      result: { agentSessionId },
      prompt: "trigger prompt",
    });
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: run.runId,
        url: `http://localhost${TRIGGER_PATH}`,
        payload: { agentId: fx.agentId },
      },
      context.signal,
    );
    const replyToken = generateReplyToken(randomUUID());
    mockRunOutput("trigger response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId: run.runId,
      status: "completed",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_inbound",
        replyToken,
        inboundMessageId: "<inbound@example.com>",
        inboundReferences: "<root@example.com>",
        subject: "Need help",
        runtimeOrgId: fx.orgId,
        replyRecipientTo: ["sender@example.com"],
        replyRecipientCc: ["cc@example.com"],
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(resendMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: `Zero <${fx.orgSlug}@mail.example.com>`,
        to: ["sender@example.com"],
        cc: ["cc@example.com"],
        replyTo: `reply+${replyToken}@mail.example.com`,
        subject: "Re: Need help",
        headers: expect.objectContaining({
          "In-Reply-To": "<inbound@example.com>",
          References: "<root@example.com> <inbound@example.com>",
        }),
      }),
    );
    const email = lastSentEmail();
    expect(email.html).toContain("trigger response");
    expect(email.html).not.toContain(`/activities/${run.runId}`);

    const db = store.set(writeDb$);
    const [thread] = await db
      .select()
      .from(emailThreadSessions)
      .where(eq(emailThreadSessions.replyToToken, replyToken));
    expect(thread).toMatchObject({
      userId: fx.userId,
      agentId: fx.agentId,
      agentSessionId,
      lastEmailMessageId: "<sent@example.com>",
      orgId: fx.orgId,
    });
  });

  it("includes the audit log link when the AuditLink switch is enabled", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: { agentSessionId },
    });
    const db = store.set(writeDb$);
    await db.insert(userFeatureSwitches).values({
      orgId: fx.orgId,
      userId: fx.userId,
      switches: { [FeatureSwitchKey.AuditLink]: true },
    });
    mockRunOutput("audited trigger response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_trigger_audit",
        replyToken,
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.html).toContain(`/activities/${runId}`);
  });

  it("strips an existing Re prefix from the trigger subject", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: { agentSessionId },
    });
    mockRunOutput("subject normalized response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_subject_re",
        replyToken,
        subject: "Re: Original Topic",
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.subject).toBe("Re: Original Topic");
  });

  it("falls back to senderEmail when reply recipients are absent", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: { agentSessionId },
    });
    mockRunOutput("fallback recipient response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: "sender@example.com",
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_sender_fallback",
        replyToken,
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.to).toBe("sender@example.com");
    expect(email.cc).toBeUndefined();
  });

  it("sends the failure message for failed trigger runs", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      status: "failed",
    });

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: {
        senderEmail: "sender@example.com",
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_trigger_failed",
        replyToken,
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.to).toBe("sender@example.com");
    expect(email.html).toContain("Agent crashed");
  });

  it("no-ops progress callbacks without sending email", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      status: "running",
    });

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "progress",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_trigger_progress",
        replyToken,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it("omits reply continuity when the run result has no agent session id", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: null,
    });
    mockRunOutput("no continuity response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_no_continuity",
        replyToken,
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.replyTo).toBeUndefined();
    const db = store.set(writeDb$);
    const [thread] = await db
      .select()
      .from(emailThreadSessions)
      .where(eq(emailThreadSessions.replyToToken, replyToken));
    expect(thread).toBeUndefined();
  });
});

describe("POST /api/zero/email/inbound", () => {
  it("rejects missing Svix headers", async () => {
    const response = await createApp({ signal: context.signal }).request(
      INBOUND_PATH,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "email.received" }),
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing signature headers",
    });
  });

  it("records bounced and complained recipients", async () => {
    const fx = await fixture();
    const bounced = `bounce-${fx.orgSlug}@example.com`;
    const complained = fx.userEmail;

    const bounceResponse = await postInbound({
      type: "email.bounced",
      data: { email_id: "email_bounce", to: [bounced] },
    });
    const complaintResponse = await postInbound({
      type: "email.complained",
      data: { email_id: "email_complaint", to: [complained] },
    });

    expect(bounceResponse.status).toBe(200);
    expect(complaintResponse.status).toBe(200);
    const db = store.set(writeDb$);
    const suppressions = await db
      .select()
      .from(emailSuppressions)
      .where(inArray(emailSuppressions.emailAddress, [bounced, complained]));
    expect(
      suppressions.map((row) => {
        return { emailAddress: row.emailAddress, reason: row.reason };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        { emailAddress: bounced, reason: "bounced" },
        { emailAddress: complained, reason: "complained" },
      ]),
    );
    const [user] = await db.select().from(users).where(eq(users.id, fx.userId));
    expect(user?.emailUnsubscribed).toBeTruthy();
  });

  it("dispatches a Zero run for a new org-address email", async () => {
    const fx = await fixture();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Run a report",
      text: "Please run it",
    });
    mockNoAttachments();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Run a report",
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ received: true });
    await clearAllDetached();

    const db = store.set(writeDb$);
    const runs = await db
      .select({ id: agentRuns.id, prompt: agentRuns.prompt })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, fx.orgId), eq(agentRuns.userId, fx.userId)),
      );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toContain("Run a report");

    const [zeroRun] = await db
      .select()
      .from(zeroRuns)
      .where(eq(zeroRuns.id, runs[0]!.id));
    expect(zeroRun?.triggerSource).toBe("email");

    const [callback] = await db
      .select()
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, runs[0]!.id));
    expect(callback?.url).toBe(
      "http://localhost:3000/api/zero/email/callbacks/trigger",
    );
    expect(callback?.payload).toMatchObject({
      senderEmail: fx.userEmail,
      agentId: fx.agentId,
      userId: fx.userId,
      inboundEmailId: "email_trigger",
      runtimeOrgId: fx.orgId,
      replyRecipientTo: [fx.userEmail],
    });
  });

  it("dispatches a continuation run for a reply-address email", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`reply+${thread.replyToken}@mail.example.com`],
      subject: "Re: Continue",
      text: "Continue this thread",
    });
    mockNoAttachments();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_reply",
        from: fx.userEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: Continue",
      },
    });
    expect(response.status).toBe(200);
    await clearAllDetached();

    const db = store.set(writeDb$);
    const runs = await db
      .select({ id: agentRuns.id, sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, fx.orgId), eq(agentRuns.userId, fx.userId)),
      );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionId).toBe(agentSessionId);
    const [callback] = await db
      .select()
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, runs[0]!.id));
    expect(callback?.url).toBe(
      "http://localhost:3000/api/zero/email/callbacks/reply",
    );
    expect(callback?.payload).toMatchObject({
      emailThreadSessionId: thread.id,
      inboundEmailId: "email_reply",
      replyRecipientTo: [fx.userEmail],
    });
  });

  it("sends an error reply when the reply token is invalid", async () => {
    const fx = await fixture();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_invalid_reply",
        from: fx.userEmail,
        to: ["reply+bad-token@mail.example.com"],
        subject: "Re: Continue",
      },
    });
    expect(response.status).toBe(200);
    await clearAllDetached();

    const db = store.set(writeDb$);
    const [outbox] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.fromAddress, "Zero <vm0@mail.example.com>"));
    expect(outbox).toMatchObject({
      toAddresses: fx.userEmail,
      subject: "Re: Continue",
    });
    expect(outbox?.template).toMatchObject({
      template: "inbound-error",
      props: {
        errorMessage: expect.stringContaining(
          "conversation thread has expired",
        ),
      },
    });
  });

  it("rejects invalid Svix signatures", async () => {
    const rawBody = JSON.stringify({ type: "email.received" });
    const response = await createApp({ signal: context.signal }).request(
      INBOUND_PATH,
      {
        method: "POST",
        headers: {
          ...svixHeaders(rawBody),
          "svix-signature": "v1,bad-signature",
        },
        body: rawBody,
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("acknowledges non-received events without background work", async () => {
    const response = await postInbound({
      type: "email.sent",
      data: { email_id: "email_sent" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ received: true });
    await clearAllDetached();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it("sends an error reply when a continuation reply has empty content", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`reply+${thread.replyToken}@mail.example.com`],
      subject: "Re: Empty",
      text: "   ",
      html: "",
    });
    mockNoAttachments();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_empty_reply",
        from: fx.userEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: Empty",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    const db = store.set(writeDb$);
    const runs = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, fx.orgId), eq(agentRuns.userId, fx.userId)),
      );
    expect(runs).toHaveLength(0);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe("Re: Empty");
    expect(email.html).toContain("reply was empty");
  });

  it("sends an error reply when a reply sender is not the thread owner", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    const senderEmail = `other-${fx.orgSlug}@example.com`;
    const otherUserId = `user_${randomUUID()}`;
    const db = store.set(writeDb$);
    await db.insert(userCache).values({
      userId: otherUserId,
      email: senderEmail,
      name: "Other User",
      cachedAt: nowDate(),
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_wrong_owner",
        from: senderEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: Wrong owner",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(senderEmail);
    expect(email.html).toContain("Only the original sender can continue");
  });

  it("sends an error reply when reply sender authentication fails", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`reply+${thread.replyToken}@mail.example.com`],
      subject: "Re: Spoofed",
      text: "Reply body",
      headers: {
        "Authentication-Results": "mx.example; dkim=pass; spf=pass; dmarc=fail",
      },
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_reply_dmarc_fail",
        from: fx.userEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: Spoofed",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.html).toContain("DMARC verification failed");
  });

  it("sends an error reply when a trigger sender is not a workspace member", async () => {
    const fx = await fixture();
    const senderEmail = `nonmember-${fx.orgSlug}@example.com`;
    const senderUserId = `user_${randomUUID()}`;
    const db = store.set(writeDb$);
    await db.insert(userCache).values({
      userId: senderUserId,
      email: senderEmail,
      name: "Non Member",
      cachedAt: nowDate(),
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValueOnce(
      { data: [] },
    );

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_not_member",
        from: senderEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Forbidden",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(senderEmail);
    expect(email.subject).toBe("Re: Forbidden");
    expect(email.html).toContain("not a member");
  });

  it("sends an error reply when the workspace has no default agent", async () => {
    const fx = await fixture();
    const db = store.set(writeDb$);
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fx.orgId));

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_no_default_agent",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "No default",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.html).toContain("does not have a default agent");
  });

  it("rejects trigger emails that fail DMARC before creating a run", async () => {
    const fx = await fixture();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Spoofed",
      text: "spoofed body",
      headers: {
        "Authentication-Results": "mx.example; dkim=fail; spf=fail; dmarc=none",
      },
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger_dmarc_fail",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Spoofed",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    const db = store.set(writeDb$);
    const runs = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, fx.orgId), eq(agentRuns.userId, fx.userId)),
      );
    expect(runs).toHaveLength(0);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.html).toContain("DMARC verification failed");
  });

  it("extracts trigger prompt content from HTML when text is empty", async () => {
    const fx = await fixture();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Newsletter",
      text: "",
      html: "<p>Rich content from newsletter</p>",
    });
    mockNoAttachments();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_html_trigger",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Newsletter",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    const db = store.set(writeDb$);
    const [run] = await db
      .select({ prompt: agentRuns.prompt })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, fx.orgId), eq(agentRuns.userId, fx.userId)),
      );
    expect(run?.prompt).toContain("Newsletter\n\nRich content from newsletter");
  });

  it("adds mixed attachment results to trigger prompts", async () => {
    const fx = await fixture();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Files",
      text: "Several attachments",
    });
    mockEmailAttachments([
      {
        id: "att-good",
        filename: "report.pdf",
        size: 5000,
        contentType: "application/pdf",
        contentDisposition: "attachment",
        downloadUrl: "https://download.resend.test/report.pdf",
      },
      {
        id: "att-huge",
        filename: "video.mp4",
        size: 15 * 1024 * 1024,
        contentType: "video/mp4",
        contentDisposition: "attachment",
        downloadUrl: "https://download.resend.test/video.mp4",
      },
      {
        id: "att-broken",
        filename: "missing.docx",
        size: 3000,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentDisposition: "attachment",
        downloadUrl: "https://download.resend.test/missing.docx",
      },
    ]);
    mockAttachmentDownload({
      url: "https://download.resend.test/report.pdf",
      body: Buffer.from("pdf-content"),
    });
    mockAttachmentDownload({
      url: "https://download.resend.test/missing.docx",
      status: 404,
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger_attachments",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Files",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    const db = store.set(writeDb$);
    const [run] = await db
      .select({ prompt: agentRuns.prompt })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, fx.orgId), eq(agentRuns.userId, fx.userId)),
      );
    expect(run?.prompt).toContain("[attachment]: report.pdf");
    expect(run?.prompt).toContain("https://r2.example.com/upload?sig=test");
    expect(run?.prompt).toContain("video.mp4");
    expect(run?.prompt).toContain("skipped: exceeds size limit");
    expect(run?.prompt).toContain("missing.docx");
    expect(run?.prompt).toContain("skipped: download failed");
    expect(context.mocks.s3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "test-user-storages",
          Key: "email-attachments/email_trigger_attachments/att-good-report.pdf",
          Body: expect.any(Buffer),
          ContentType: "application/pdf",
        }),
      }),
    );
  });

  it("replaces inline image data URIs and processes inline attachments", async () => {
    const fx = await fixture();
    const inlineBase64 = "A".repeat(1000);
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Photo",
      text: "",
      html: `<p>Look at this</p><img src="data:image/jpeg;base64,${inlineBase64}" alt="photo.jpg">`,
    });
    mockEmailAttachments([
      {
        id: "inline-1",
        filename: "photo.jpg",
        size: 750,
        contentType: "image/jpeg",
        contentDisposition: "inline",
        downloadUrl: "https://download.resend.test/photo.jpg",
      },
    ]);
    mockAttachmentDownload({
      url: "https://download.resend.test/photo.jpg",
      body: Buffer.from("jpeg-content"),
      contentType: "image/jpeg",
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_inline_image",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Photo",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    const db = store.set(writeDb$);
    const [run] = await db
      .select({ prompt: agentRuns.prompt })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, fx.orgId), eq(agentRuns.userId, fx.userId)),
      );
    expect(run?.prompt).toContain("Look at this");
    expect(run?.prompt).toContain("[inline image: photo.jpg]");
    expect(run?.prompt).not.toContain("data:image/jpeg;base64");
    expect(run?.prompt).toContain("[attachment]: photo.jpg");
  });

  it("adds attachment results to reply continuation prompts", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`reply+${thread.replyToken}@mail.example.com`],
      subject: "Re: File",
      text: "Here is the file",
    });
    mockEmailAttachments([
      {
        id: "reply-att",
        filename: "data.csv",
        size: 200,
        contentType: "text/csv",
        contentDisposition: "attachment",
        downloadUrl: "https://download.resend.test/data.csv",
      },
    ]);
    mockAttachmentDownload({
      url: "https://download.resend.test/data.csv",
      body: Buffer.from("col1,col2\nval1,val2"),
      contentType: "text/csv",
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_reply_attachment",
        from: fx.userEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: File",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    const db = store.set(writeDb$);
    const [run] = await db
      .select({ prompt: agentRuns.prompt, sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, fx.orgId), eq(agentRuns.userId, fx.userId)),
      );
    expect(run?.sessionId).toBe(agentSessionId);
    expect(run?.prompt).toContain("Here is the file");
    expect(run?.prompt).toContain("[attachment]: data.csv");
    expect(run?.prompt).toContain("https://r2.example.com/upload?sig=test");
  });

  it("rejects old trigger address formats before fetching email contents", async () => {
    const fx = await fixture();

    for (const address of [
      `${fx.orgSlug}+${fx.agentName}@mail.example.com`,
      `${fx.orgSlug}/${fx.agentName}@mail.example.com`,
      "+invalid@mail.example.com",
    ]) {
      resendMocks.send.mockClear();
      resendMocks.receivingGet.mockClear();

      const response = await postInbound({
        type: "email.received",
        data: {
          email_id: `email_bad_address_${randomUUID()}`,
          from: fx.userEmail,
          to: [address],
          subject: "Bad Address",
        },
      });

      expect(response.status).toBe(200);
      await clearAllDetached();
      expect(resendMocks.receivingGet).not.toHaveBeenCalled();
      const email = lastSentEmail();
      expect(email.to).toBe(fx.userEmail);
      expect(email.subject).toBe("Re: Bad Address");
    }
  });

  it("sends an error reply when inbound processing throws unexpectedly", async () => {
    const fx = await fixture();
    resendMocks.receivingGet.mockRejectedValueOnce(
      new Error("Resend API unavailable"),
    );

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_unexpected_failure",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Crash",
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe("Re: Crash");
    expect(email.html).toContain("internal error occurred");
  });
});
