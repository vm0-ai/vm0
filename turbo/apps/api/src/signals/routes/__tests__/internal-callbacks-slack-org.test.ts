import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  deleteOrgModelProviders$,
  seedOrgModelProvider$,
} from "./helpers/zero-model-providers";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/zero-integrations-slack";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

const PATH = "/api/internal/callbacks/slack/org";
const TEST_CALLBACK_SECRET = "test-callback-secret";

interface SlackOrgCallbackPayload {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly connectionId: string;
  readonly agentId: string;
  readonly existingSessionId?: string;
}

interface SlackOrgCallbackFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly slackWorkspaceId: string;
  readonly slackUserId: string;
  readonly connectionId: string;
  readonly runId: string;
  readonly callbackId: string;
  readonly payload: SlackOrgCallbackPayload;
}

interface SlackPostMessageCall {
  readonly channel: string;
  readonly thread_ts?: string;
  readonly text: string;
  readonly blocks?: unknown[];
}

async function seedSlackConnection(args: {
  readonly slackWorkspaceId: string;
  readonly vm0UserId: string;
  readonly slackUserId?: string;
}): Promise<{ readonly connectionId: string; readonly slackUserId: string }> {
  const db = store.set(writeDb$);
  const slackUserId =
    args.slackUserId ??
    `U${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
  const [row] = await db
    .insert(slackOrgConnections)
    .values({
      slackUserId,
      slackWorkspaceId: args.slackWorkspaceId,
      vm0UserId: args.vm0UserId,
    })
    .returning({ id: slackOrgConnections.id });
  if (!row) {
    throw new Error("seedSlackConnection: insert returned no row");
  }
  return { connectionId: row.id, slackUserId };
}

async function seedFixture(): Promise<SlackOrgCallbackFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId: base.orgId,
      userId: base.userId,
      name: `slack-callback-${randomUUID().slice(0, 8)}`,
      displayName: "Slack Agent",
    },
    context.signal,
  );
  const slackFixture = await store.set(
    seedSlackOrgInstallation$,
    { orgId: base.orgId },
    context.signal,
  );
  const { connectionId, slackUserId } = await seedSlackConnection({
    slackWorkspaceId: slackFixture.slackWorkspaceId,
    vm0UserId: base.userId,
  });
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId,
      triggerSource: "slack",
      prompt: "Handle Slack thread",
      lastEventSequence: 0,
    },
    context.signal,
  );
  const payload: SlackOrgCallbackPayload = {
    workspaceId: slackFixture.slackWorkspaceId,
    channelId: `C${randomUUID().replaceAll("-", "").slice(0, 9)}`,
    threadTs: "1715000000.000100",
    messageTs: "1715000000.000100",
    connectionId,
    agentId: composeId,
  };
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId,
      url: `http://localhost${PATH}`,
      payload: payload as unknown as Record<string, unknown>,
    },
    context.signal,
  );

  return {
    ...base,
    composeId,
    slackWorkspaceId: slackFixture.slackWorkspaceId,
    slackUserId,
    connectionId,
    runId,
    callbackId,
    payload,
  };
}

async function deleteFixture(fixture: SlackOrgCallbackFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await db
    .delete(modelProviders)
    .where(eq(modelProviders.orgId, fixture.orgId));
  const slackFixture: SlackIntegrationFixture = {
    orgId: fixture.orgId,
    slackWorkspaceId: fixture.slackWorkspaceId,
  };
  await store.set(deleteSlackIntegrationFixture$, slackFixture, context.signal);
  await store.set(deleteOrgModelProviders$, fixture, context.signal);
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

function signedHeaders(rawBody: string, secret = TEST_CALLBACK_SECRET) {
  const timestamp = Math.floor(now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(rawBody, secret, timestamp),
    "X-VM0-Timestamp": String(timestamp),
  };
}

async function postSignedCallback(
  body: Record<string, unknown>,
  secret?: string,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const app = createApp({ signal: context.signal });
  return await app.request(PATH, {
    method: "POST",
    headers: signedHeaders(rawBody, secret),
    body: rawBody,
  });
}

function completedOutput(text = "SLACK_CALLBACK_OUTPUT"): void {
  context.mocks.axiom.query.mockResolvedValueOnce([
    {
      eventType: "result",
      eventData: { result: text },
    },
  ]);
}

function completedAgentMessageOutput(text: string): void {
  context.mocks.axiom.query.mockResolvedValueOnce([
    {
      eventType: "item.completed",
      eventData: {
        item: {
          type: "agent_message",
          text,
        },
      },
    },
  ]);
}

async function enableAuditLink(
  fixture: SlackOrgCallbackFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.AuditLink]: true },
  });
}

async function setOrgDefaultAgent(
  fixture: SlackOrgCallbackFixture,
  defaultAgentId: string | null,
): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .insert(orgMetadata)
    .values({ orgId: fixture.orgId, defaultAgentId })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { defaultAgentId },
    });
}

async function setRunSelectedModel(
  runId: string,
  selectedModel: string,
): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .update(zeroRuns)
    .set({ selectedModel })
    .where(eq(zeroRuns.id, runId));
}

async function seedAdditionalMentioner(
  fixture: SlackOrgCallbackFixture,
): Promise<string> {
  const { connectionId, slackUserId } = await seedSlackConnection({
    slackWorkspaceId: fixture.slackWorkspaceId,
    vm0UserId: `user_${randomUUID()}`,
  });
  const db = store.set(writeDb$);
  await db.insert(slackOrgThreadSessions).values({
    connectionId,
    slackChannelId: fixture.payload.channelId,
    slackThreadTs: fixture.payload.threadTs,
    agentSessionId: null,
  });
  return slackUserId;
}

async function findThreadSession(
  fixture: SlackOrgCallbackFixture,
): Promise<{ readonly agentSessionId: string | null } | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ agentSessionId: slackOrgThreadSessions.agentSessionId })
    .from(slackOrgThreadSessions)
    .where(
      and(
        eq(slackOrgThreadSessions.connectionId, fixture.connectionId),
        eq(slackOrgThreadSessions.slackChannelId, fixture.payload.channelId),
        eq(slackOrgThreadSessions.slackThreadTs, fixture.payload.threadTs),
      ),
    )
    .limit(1);
  return row ?? null;
}

function firstPostMessageCall(): SlackPostMessageCall {
  return context.mocks.slack.chat.postMessage.mock
    .calls[0]![0] as SlackPostMessageCall;
}

describe("POST /api/internal/callbacks/slack/org", () => {
  const track = createFixtureTracker<SlackOrgCallbackFixture>((fixture) => {
    return deleteFixture(fixture);
  });

  beforeEach(() => {
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "1715000000.000200",
      channel: "C-callback",
    });
    context.mocks.slack.assistant.threads.setStatus.mockResolvedValue({
      ok: true,
    });
  });

  it("rejects requests with invalid signatures", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback(
      {
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "completed",
        payload: fixture.payload,
      },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid payloads after callback verification", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { workspaceId: fixture.slackWorkspaceId },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });
  });

  it("sets thinking status for progress callbacks", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "progress",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenCalledWith({
      channel_id: fixture.payload.channelId,
      thread_ts: fixture.payload.threadTs,
      status: "is thinking...",
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it("returns success for progress callbacks when installation is missing", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "progress",
      payload: { ...fixture.payload, workspaceId: "T_missing" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).not.toHaveBeenCalled();
  });

  it("posts completion output, saves the thread session, and clears status", async () => {
    const fixture = await track(seedFixture());
    completedOutput();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const call = firstPostMessageCall();
    expect(call).toMatchObject({
      channel: fixture.payload.channelId,
      thread_ts: fixture.payload.threadTs,
      text: "SLACK_CALLBACK_OUTPUT",
    });
    expect(JSON.stringify(call.blocks)).toContain("SLACK_CALLBACK_OUTPUT");

    const [run] = await store
      .set(writeDb$)
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, fixture.runId))
      .limit(1);
    const session = await findThreadSession(fixture);
    expect(session?.agentSessionId).toBe(run?.sessionId);

    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenLastCalledWith({
      channel_id: fixture.payload.channelId,
      thread_ts: fixture.payload.threadTs,
      status: "",
    });
  });

  it("posts Codex agent messages instead of fallback text and omits audit when disabled", async () => {
    const fixture = await track(seedFixture());
    completedAgentMessageOutput("final codex answer");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    const call = firstPostMessageCall();
    expect(call.text).toBe("final codex answer");
    expect(call.text).not.toBe("Task completed successfully.");
    const blocks = JSON.stringify(call.blocks);
    expect(blocks).toContain("final codex answer");
    expect(blocks).not.toContain("Audit");
  });

  it("renders audit, responded-by, reply-to, and selected-model footer text", async () => {
    const fixture = await track(seedFixture());
    await enableAuditLink(fixture);
    await setOrgDefaultAgent(fixture, null);
    await setRunSelectedModel(fixture.runId, "claude-opus-4-7");
    await seedAdditionalMentioner(fixture);
    completedOutput("footer output");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    const blocks = JSON.stringify(firstPostMessageCall().blocks);
    expect(blocks).toContain("Audit");
    expect(blocks).toContain(`/activities/${fixture.runId}`);
    expect(blocks).toContain("Responded by Slack Agent");
    expect(blocks).toContain(`Reply to <@${fixture.slackUserId}>`);
    expect(blocks).toContain("Claude Opus 4.7");
  });

  it("uses the org default claude-code provider model when the run has no selected model", async () => {
    const fixture = await track(seedFixture());
    await setOrgDefaultAgent(fixture, fixture.composeId);
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fixture.orgId,
        type: "anthropic-api-key",
        isDefault: true,
        selectedModel: "claude-sonnet-4-6",
      },
      context.signal,
    );
    completedOutput("model fallback output");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    const blocks = JSON.stringify(firstPostMessageCall().blocks);
    expect(blocks).toContain("Claude Sonnet 4.6");
    expect(blocks).not.toContain("Responded by");
  });

  it("formats generic failed-run errors without saving a thread session", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "Something broke",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    expect(firstPostMessageCall().text).toBe(
      "Oops, something went wrong. Please try again later.",
    );
    await expect(findThreadSession(fixture)).resolves.toBeNull();
  });

  it("preserves actionable failed-run errors", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "Cannot continue session from checkpoint",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    expect(firstPostMessageCall().text).toBe(
      "Cannot continue session from checkpoint",
    );
  });

  it("returns 404 when installation is not found for terminal callbacks", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { ...fixture.payload, workspaceId: "T_missing" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Slack installation not found",
    });
  });

  it("maps Slack API platform errors to callback errors", async () => {
    const fixture = await track(seedFixture());
    completedOutput();
    context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Slack API error: channel_not_found",
    });
  });
});
