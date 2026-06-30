import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  testEmailStateContract,
  type TestEmailStateActionBody,
} from "@vm0/api-contracts/contracts/test-email-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
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
import { users } from "@vm0/db/schema/user";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import type { RouteEntry } from "../route-entry";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { generateReplyToken } from "../services/zero-email-common.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testEmailStateContract.action);
const CALLBACK_SECRET = "test-callback-secret";
const REPLY_PATH = "/api/zero/email/callbacks/reply";
const TRIGGER_PATH = "/api/zero/email/callbacks/trigger";
const OUTBOX_TEST_FROM = "Zero <bdd-outbox@mail.example.com>";
const OUTBOX_TEST_CREATED_AT_OFFSET_MS = 10 * 60 * 1000;

interface EmailFixture {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly versionId: string;
}

type RunStatus = "completed" | "failed" | "running";
type CallbackStatus = "pending" | "delivered" | "failed";

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

function actionBadRequest(error: string) {
  return { status: 400 as const, body: { error } };
}

function readRecord(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return readString(body, key) ?? undefined;
}

function readNullableString(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  return body[key] === null ? null : readOptionalString(body, key);
}

function readStringArray(
  body: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

function readNullableRecord(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null | undefined {
  if (body[key] === null) {
    return null;
  }
  return readRecord(body, key) ?? undefined;
}

function readOptionalNumber(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseMaybeDate(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function parseNullableDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function readRunStatus(body: Record<string, unknown>): RunStatus {
  const status = readOptionalString(body, "status");
  return status === "failed" || status === "running" ? status : "completed";
}

function readCallbackStatus(body: Record<string, unknown>): CallbackStatus {
  const status = readOptionalString(body, "callback_status");
  return status === "delivered" || status === "failed" ? status : "pending";
}

function readFixture(body: Record<string, unknown>): EmailFixture | null {
  const fixture = readRecord(body, "fixture") ?? body;
  const orgId = readString(fixture, "orgId");
  const orgSlug = readString(fixture, "orgSlug");
  const userId = readString(fixture, "userId");
  const userEmail = readString(fixture, "userEmail");
  const agentId = readString(fixture, "agentId");
  const agentName = readString(fixture, "agentName");
  const versionId = readString(fixture, "versionId");
  if (
    !orgId ||
    !orgSlug ||
    !userId ||
    !userEmail ||
    !agentId ||
    !agentName ||
    !versionId
  ) {
    return null;
  }
  return { orgId, orgSlug, userId, userEmail, agentId, agentName, versionId };
}

async function insertAgentSession(
  db: Db,
  fixture: EmailFixture,
  signal: AbortSignal,
): Promise<string> {
  const [session] = await db
    .insert(agentSessions)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      agentComposeId: fixture.agentId,
    })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  if (!session) {
    throw new Error("Failed to seed agent session");
  }
  return session.id;
}

async function insertRun(
  db: Db,
  args: {
    readonly fixture: EmailFixture;
    readonly status: RunStatus;
    readonly result?: Record<string, unknown> | null;
    readonly error?: string | null;
    readonly prompt?: string;
    readonly sessionId?: string;
  },
  signal: AbortSignal,
): Promise<{ readonly runId: string; readonly sessionId: string }> {
  const sessionId =
    args.sessionId ?? (await insertAgentSession(db, args.fixture, signal));
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
  signal.throwIfAborted();
  if (!run) {
    throw new Error("Failed to seed agent run");
  }
  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "email",
  });
  signal.throwIfAborted();
  return { runId: run.id, sessionId };
}

async function insertThread(
  db: Db,
  args: {
    readonly fixture: EmailFixture;
    readonly agentSessionId: string;
    readonly lastEmailMessageId?: string | null;
  },
  signal: AbortSignal,
): Promise<{ readonly id: string; readonly replyToken: string }> {
  const replyToken = generateReplyToken(args.agentSessionId);
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
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("Failed to seed email thread");
  }
  return { id: thread.id, replyToken };
}

async function insertCallback(
  db: Db,
  args: {
    readonly runId: string;
    readonly url: string;
    readonly payload: Record<string, unknown>;
    readonly secret?: string;
    readonly status?: CallbackStatus;
  },
  signal: AbortSignal,
): Promise<string> {
  const encryptedSecret = await encryptPersistentSecretValue(
    args.secret ?? CALLBACK_SECRET,
    {},
  );
  signal.throwIfAborted();
  const [callback] = await db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      url: args.url,
      internalKind: null,
      encryptedSecret,
      payload: args.payload,
      status: args.status ?? "pending",
    })
    .returning({ id: agentRunCallbacks.id });
  signal.throwIfAborted();
  if (!callback) {
    throw new Error("Failed to seed agent run callback");
  }
  return callback.id;
}

async function seedFixtureForAction(db: Db, signal: AbortSignal) {
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

  return actionOk({
    fixture: {
      orgId,
      orgSlug,
      userId,
      userEmail,
      agentId,
      agentName,
      versionId,
    },
  });
}

async function deleteFixtureForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  if (!fixture) {
    return actionBadRequest("fixture is required");
  }

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
  await db
    .delete(userCache)
    .where(
      or(
        eq(userCache.userId, fixture.userId),
        inArray(userCache.email, [
          fixture.userEmail,
          `other-${fixture.orgSlug}@example.com`,
          `nonmember-${fixture.orgSlug}@example.com`,
        ]),
      ),
    );
  signal.throwIfAborted();
  await db.delete(users).where(eq(users.id, fixture.userId));
  signal.throwIfAborted();
  return actionOk();
}

async function seedAgentSessionForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  if (!fixture) {
    return actionBadRequest("fixture is required");
  }
  const agentSessionId = await insertAgentSession(db, fixture, signal);
  return actionOk({ agentSessionId });
}

async function seedRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  if (!fixture) {
    return actionBadRequest("fixture is required");
  }
  const result = readNullableRecord(body, "result");
  const run = await insertRun(
    db,
    {
      fixture,
      status: readRunStatus(body),
      result: result === undefined ? null : result,
      error: readNullableString(body, "error") ?? null,
      prompt: readOptionalString(body, "prompt"),
      sessionId: readOptionalString(body, "session_id"),
    },
    signal,
  );
  return actionOk({ runId: run.runId, sessionId: run.sessionId });
}

async function seedThreadForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  const agentSessionId = readString(body, "agent_session_id");
  if (!fixture || !agentSessionId) {
    return actionBadRequest("fixture and agent_session_id are required");
  }
  const thread = await insertThread(
    db,
    {
      fixture,
      agentSessionId,
      lastEmailMessageId: readNullableString(body, "last_email_message_id"),
    },
    signal,
  );
  return actionOk({ thread });
}

async function seedReplyCallbackForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  if (!fixture) {
    return actionBadRequest("fixture is required");
  }
  const result = readNullableRecord(body, "result");
  const run = await insertRun(
    db,
    {
      fixture,
      status: readRunStatus(body),
      result: result === undefined ? null : result,
      error: readNullableString(body, "error") ?? null,
      prompt: readOptionalString(body, "prompt"),
    },
    signal,
  );
  const thread = await insertThread(
    db,
    {
      fixture,
      agentSessionId: run.sessionId,
      lastEmailMessageId: readNullableString(body, "last_email_message_id"),
    },
    signal,
  );
  const callbackId = await insertCallback(
    db,
    {
      runId: run.runId,
      url: `http://localhost${REPLY_PATH}`,
      payload: { emailThreadSessionId: thread.id },
      secret: readOptionalString(body, "secret"),
      status: readCallbackStatus(body),
    },
    signal,
  );
  return actionOk({ callbackId, runId: run.runId, thread });
}

async function seedTriggerCallbackForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  if (!fixture) {
    return actionBadRequest("fixture is required");
  }
  const result = readNullableRecord(body, "result");
  const run = await insertRun(
    db,
    {
      fixture,
      status: readRunStatus(body),
      result: result === undefined ? null : result,
      error: readNullableString(body, "error") ?? null,
      prompt: readOptionalString(body, "prompt"),
    },
    signal,
  );
  const replyToken = generateReplyToken(randomUUID());
  const callbackId = await insertCallback(
    db,
    {
      runId: run.runId,
      url: `http://localhost${TRIGGER_PATH}`,
      payload: { agentId: fixture.agentId },
      secret: readOptionalString(body, "secret"),
      status: readCallbackStatus(body),
    },
    signal,
  );
  return actionOk({ callbackId, runId: run.runId, replyToken });
}

async function seedUserCacheForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const userId = readString(body, "user_id");
  const email = readString(body, "email");
  if (!userId || !email) {
    return actionBadRequest("user_id and email are required");
  }
  await db
    .insert(userCache)
    .values({
      userId,
      email,
      name: readNullableString(body, "name") ?? null,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: {
        email,
        name: readNullableString(body, "name") ?? null,
        cachedAt: nowDate(),
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function deleteOrgMetadataForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  const orgId = readOptionalString(body, "org_id") ?? fixture?.orgId;
  if (!orgId) {
    return actionBadRequest("org_id or fixture is required");
  }
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
  return actionOk();
}

async function seedOutboxForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const subject = readString(body, "subject");
  const to = readString(body, "to");
  if (!subject || !to) {
    return actionBadRequest("subject and to are required");
  }
  await db.insert(emailOutbox).values({
    fromAddress: OUTBOX_TEST_FROM,
    toAddresses: to,
    subject: `Re: ${subject}`,
    template: {
      template: "inbound-error",
      props: { errorMessage: "BDD outbox test email" },
    },
    status: readOptionalString(body, "status") ?? "pending",
    attempts: readOptionalNumber(body, "attempts") ?? 0,
    createdAt:
      parseMaybeDate(readOptionalString(body, "created_at")) ??
      new Date(now() - OUTBOX_TEST_CREATED_AT_OFFSET_MS),
    nextRetryAt: parseNullableDate(readNullableString(body, "next_retry_at")),
  });
  signal.throwIfAborted();
  return actionOk();
}

async function deleteOutboxBySubjectForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const subject = readString(body, "subject");
  if (!subject) {
    return actionBadRequest("subject is required");
  }
  await db.delete(emailOutbox).where(eq(emailOutbox.subject, `Re: ${subject}`));
  signal.throwIfAborted();
  return actionOk();
}

async function touchOutboxForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const subject = readString(body, "subject");
  const createdAt = parseMaybeDate(readOptionalString(body, "created_at"));
  if (!subject) {
    return actionBadRequest("subject is required");
  }
  const updated = await db
    .update(emailOutbox)
    .set({ createdAt: createdAt ?? nowDate() })
    .where(eq(emailOutbox.subject, `Re: ${subject}`))
    .returning({ id: emailOutbox.id });
  signal.throwIfAborted();
  if (updated.length === 0) {
    return actionBadRequest(`outbox row not found for ${subject}`);
  }
  return actionOk();
}

async function getOutboxBySubjectForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const subject = readString(body, "subject");
  if (!subject) {
    return actionBadRequest("subject is required");
  }
  const [row] = await db
    .select({
      status: emailOutbox.status,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
    })
    .from(emailOutbox)
    .where(eq(emailOutbox.subject, `Re: ${subject}`))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    outbox_row: row
      ? {
          status: row.status,
          attempts: row.attempts,
          last_error: row.lastError,
        }
      : null,
  });
}

async function seedSuppressionForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const email = readString(body, "email");
  if (!email) {
    return actionBadRequest("email is required");
  }
  await db
    .delete(emailSuppressions)
    .where(eq(emailSuppressions.emailAddress, email));
  signal.throwIfAborted();
  await db.insert(emailSuppressions).values({
    emailAddress: email,
    reason: readOptionalString(body, "reason") ?? "bounced",
    resendEmailId:
      readOptionalString(body, "resend_email_id") ?? `em_${randomUUID()}`,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function deleteSuppressionForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const email = readString(body, "email");
  if (!email) {
    return actionBadRequest("email is required");
  }
  await db
    .delete(emailSuppressions)
    .where(eq(emailSuppressions.emailAddress, email));
  signal.throwIfAborted();
  return actionOk();
}

async function getThreadForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const id = readOptionalString(body, "id");
  const replyToken = readOptionalString(body, "reply_token");
  if (!id && !replyToken) {
    return actionBadRequest("id or reply_token is required");
  }
  const [thread] = await db
    .select()
    .from(emailThreadSessions)
    .where(
      id
        ? eq(emailThreadSessions.id, id)
        : eq(emailThreadSessions.replyToToken, replyToken!),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    thread: thread
      ? {
          id: thread.id,
          userId: thread.userId,
          agentId: thread.agentId,
          agentSessionId: thread.agentSessionId,
          orgId: thread.orgId,
          lastEmailMessageId: thread.lastEmailMessageId,
          replyToken: thread.replyToToken,
        }
      : null,
  });
}

async function getRunStateForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  if (!fixture) {
    return actionBadRequest("fixture is required");
  }
  const rows = await db
    .select({
      id: agentRuns.id,
      sessionId: agentRuns.sessionId,
      prompt: agentRuns.prompt,
      status: agentRuns.status,
      result: agentRuns.result,
      error: agentRuns.error,
      triggerSource: zeroRuns.triggerSource,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(agentRuns.orgId, fixture.orgId),
        eq(agentRuns.userId, fixture.userId),
      ),
    )
    .orderBy(asc(agentRuns.createdAt));
  signal.throwIfAborted();
  const runIds = rows.map((row) => {
    return row.id;
  });
  const callbacks =
    runIds.length > 0
      ? await db
          .select({
            id: agentRunCallbacks.id,
            runId: agentRunCallbacks.runId,
            url: agentRunCallbacks.url,
            internalKind: agentRunCallbacks.internalKind,
            payload: agentRunCallbacks.payload,
            status: agentRunCallbacks.status,
          })
          .from(agentRunCallbacks)
          .where(inArray(agentRunCallbacks.runId, runIds))
          .orderBy(asc(agentRunCallbacks.createdAt))
      : [];
  signal.throwIfAborted();
  const callbacksByRun = new Map<string, typeof callbacks>();
  for (const callback of callbacks) {
    callbacksByRun.set(callback.runId, [
      ...(callbacksByRun.get(callback.runId) ?? []),
      callback,
    ]);
  }
  return actionOk({
    runs: rows.map((row) => {
      return {
        id: row.id,
        sessionId: row.sessionId,
        prompt: row.prompt,
        status: row.status,
        result: row.result,
        error: row.error,
        triggerSource: row.triggerSource,
        callbacks: callbacksByRun.get(row.id) ?? [],
      };
    }),
  });
}

async function getSuppressionsForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const emails = readStringArray(body, "emails");
  if (emails.length === 0) {
    return actionBadRequest("emails are required");
  }
  const rows = await db
    .select({
      emailAddress: emailSuppressions.emailAddress,
      reason: emailSuppressions.reason,
    })
    .from(emailSuppressions)
    .where(inArray(emailSuppressions.emailAddress, emails));
  signal.throwIfAborted();
  return actionOk({ suppressions: rows });
}

async function getUserForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fixture = readFixture(body);
  const userId = readOptionalString(body, "user_id") ?? fixture?.userId;
  if (!userId) {
    return actionBadRequest("user_id or fixture is required");
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  signal.throwIfAborted();
  return actionOk({
    user: user
      ? { id: user.id, emailUnsubscribed: user.emailUnsubscribed }
      : null,
  });
}

async function getOutboxForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const fromAddress = readString(body, "from_address");
  if (!fromAddress) {
    return actionBadRequest("from_address is required");
  }
  const rows = await db
    .select({
      fromAddress: emailOutbox.fromAddress,
      toAddresses: emailOutbox.toAddresses,
      ccAddresses: emailOutbox.ccAddresses,
      subject: emailOutbox.subject,
      template: emailOutbox.template,
      replyTo: emailOutbox.replyTo,
      headers: emailOutbox.headers,
    })
    .from(emailOutbox)
    .where(eq(emailOutbox.fromAddress, fromAddress))
    .orderBy(desc(emailOutbox.createdAt));
  signal.throwIfAborted();
  return actionOk({ outbox: rows });
}

type EmailStateActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

async function seedFixtureStateAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  void body;
  return await seedFixtureForAction(db, signal);
}

const emailStateActionHandlers = {
  "seed-fixture": seedFixtureStateAction,
  "delete-fixture": deleteFixtureForAction,
  "seed-agent-session": seedAgentSessionForAction,
  "seed-run": seedRunForAction,
  "seed-thread": seedThreadForAction,
  "seed-reply-callback": seedReplyCallbackForAction,
  "seed-trigger-callback": seedTriggerCallbackForAction,
  "seed-user-cache": seedUserCacheForAction,
  "seed-outbox": seedOutboxForAction,
  "delete-outbox-by-subject": deleteOutboxBySubjectForAction,
  "touch-outbox": touchOutboxForAction,
  "get-outbox-by-subject": getOutboxBySubjectForAction,
  "seed-suppression": seedSuppressionForAction,
  "delete-suppression": deleteSuppressionForAction,
  "delete-org-metadata": deleteOrgMetadataForAction,
  "get-thread": getThreadForAction,
  "get-run-state": getRunStateForAction,
  "get-suppressions": getSuppressionsForAction,
  "get-user": getUserForAction,
  "get-outbox": getOutboxForAction,
} satisfies Record<TestEmailStateActionBody["action"], EmailStateActionHandler>;

async function mutateTestEmailStateAction(
  db: Db,
  body: Record<string, unknown>,
  action: TestEmailStateActionBody["action"],
  signal: AbortSignal,
) {
  return await emailStateActionHandlers[action](db, body, signal);
}

const mutateTestEmailState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data as Record<string, unknown>;
    return await mutateTestEmailStateAction(
      set(writeDb$),
      body,
      bodyResult.data.action,
      signal,
    );
  },
);

export const testEmailStateRoutes: readonly RouteEntry[] = [
  {
    route: testEmailStateContract.action,
    handler: mutateTestEmailState$,
  },
];
