// INT-03 deep AgentPhone flows: linking through the webhook connect prompt,
// real run dispatch through runner poll/claim, and completion replies through
// the internal-callback MSW proxy. All state is constructed through public
// APIs; the only mocked surfaces are the AgentPhone provider, Stripe, Clerk,
// S3, and Axiom boundaries.

import { createHash } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { settle } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  AGENTPHONE_BDD_AGENT_ID,
  AGENTPHONE_BDD_PHONE_NUMBER,
  createAgentPhoneBddApi,
  uniqueConversationId,
  uniquePhoneHandle,
  type AgentPhoneProviderSend,
  type AgentPhoneSendCapture,
} from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();

function orgOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

interface LinkedAgentPhoneActor {
  readonly actor: ApiTestUser;
  readonly phone: string;
  readonly runnerGroup: string;
  readonly sends: AgentPhoneSendCapture;
  readonly storage: {
    addArtifactObject(object: {
      readonly userId: string;
      readonly uploadId: string;
      readonly filename: string;
      readonly size: number;
    }): void;
  };
}

async function entitledLinkedActor(): Promise<LinkedAgentPhoneActor> {
  const bdd = createBddApi(context);
  const runs = createRunsAutomationsApi(context);
  const integrations = createBddIntegrationApi(context);
  const ap = createAgentPhoneBddApi(context);

  const actor = bdd.user();
  const storage = ap.acceptAgentPhoneObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  const runnerGroup = runs.configureRunnerGroup();
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  const sends = ap.captureAgentPhoneSends();
  ap.proxyAgentPhoneCallbackToApp();

  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const phone = uniquePhoneHandle();
  await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
  return { actor, phone, runnerGroup, sends, storage };
}

async function claimDispatchedRun(runnerGroup: string): Promise<{
  readonly runId: string;
  readonly sandboxToken: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly zeroToken: string | undefined;
}> {
  const runs = createRunsAutomationsApi(context);
  await runs.heartbeatRunner(runnerGroup);
  let runId: string | undefined;
  await expect
    .poll(async () => {
      const poll = await runs.pollRunner(runnerGroup);
      runId = poll.body.job?.runId;
      return runId ?? null;
    })
    .not.toBeNull();
  if (!runId) {
    throw new Error("Expected an AgentPhone run to be dispatched");
  }
  const claim = await runs.claimRunnerJob(runId);
  return {
    runId,
    sandboxToken: claim.sandboxToken,
    prompt: claim.prompt,
    appendSystemPrompt: claim.appendSystemPrompt ?? "",
    zeroToken: claim.environment?.ZERO_TOKEN,
  };
}

async function pollDispatchedJob(runnerGroup: string): Promise<{
  readonly runId: string;
  readonly appendSystemPrompt: string;
}> {
  const runs = createRunsAutomationsApi(context);
  await runs.heartbeatRunner(runnerGroup);
  let job:
    | Awaited<ReturnType<typeof runs.pollRunner>>["body"]["job"]
    | undefined;
  await expect
    .poll(async () => {
      const poll = await runs.pollRunner(runnerGroup);
      job = poll.body.job;
      return job?.runId ?? null;
    })
    .not.toBeNull();
  if (!job) {
    throw new Error("Expected an AgentPhone run to be dispatched");
  }
  return { runId: job.runId, appendSystemPrompt: job.appendSystemPrompt ?? "" };
}

async function completeSandboxRun(
  sandboxToken: string,
  runId: string,
  exitCode: number,
  error?: string,
): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  const sandboxHeaders = { authorization: `Bearer ${sandboxToken}` };
  if (exitCode === 0) {
    // Successful completion requires a checkpoint, like a real sandbox.
    await webhooks.requestAgentCheckpoint(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-agentphone-cli-${runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`bdd agentphone history ${runId}`)
          .digest("hex"),
      },
      sandboxHeaders,
      [200],
    );
  }
  await webhooks.requestAgentComplete(
    { runId, exitCode, ...(error === undefined ? {} : { error }) },
    sandboxHeaders,
    [200],
  );
}

function lastSend(sends: AgentPhoneSendCapture): AgentPhoneProviderSend {
  const send = sends.messages.at(-1);
  if (!send) {
    throw new Error("Expected a captured AgentPhone provider send");
  }
  return send;
}

async function waitForTyping(
  sends: AgentPhoneSendCapture,
  expected: readonly string[],
): Promise<void> {
  await expect
    .poll(() => {
      return sends.typing;
    })
    .toStrictEqual(expected);
}

async function waitForSendCount(
  sends: AgentPhoneSendCapture,
  count: number,
): Promise<void> {
  await expect
    .poll(() => {
      return sends.messages.length;
    })
    .toBeGreaterThanOrEqual(count);
}

async function waitForSendMatching(
  sends: AgentPhoneSendCapture,
  startIndex: number,
  predicate: (send: AgentPhoneProviderSend) => boolean,
): Promise<AgentPhoneProviderSend> {
  let matched: AgentPhoneProviderSend | undefined;
  await expect
    .poll(() => {
      matched = sends.messages.slice(startIndex).find(predicate);
      return matched !== undefined;
    })
    .toBe(true);
  if (!matched) {
    throw new Error("Expected a matching AgentPhone provider send");
  }
  return matched;
}

async function waitForRunSessionId(
  actor: ApiTestUser,
  runId: string,
  expected: string,
): Promise<void> {
  const ap = createAgentPhoneBddApi(context);
  await expect
    .poll(async () => {
      return await ap.readRunSessionId(actor, runId);
    })
    .toBe(expected);
}

async function waitForRunSessionIdPresent(
  actor: ApiTestUser,
  runId: string,
): Promise<string> {
  const ap = createAgentPhoneBddApi(context);
  let sessionId: string | undefined;
  await expect
    .poll(async () => {
      const result = await settle(ap.readRunSessionId(actor, runId));
      sessionId = result.ok ? result.value : undefined;
      return sessionId ?? null;
    })
    .not.toBeNull();
  if (!sessionId) {
    throw new Error(`Expected run ${runId} to expose a session id`);
  }
  return sessionId;
}

const MARKDOWN_RUN_OUTPUT = [
  "# Inbox summary",
  "",
  "```",
  "code line",
  "```",
  "",
  "**Bold** _italic_ `code` ~~strike~~",
  "",
  "See [docs](https://vm0.ai/docs) and ![chart](https://vm0.ai/chart.png)",
  "",
  "- first",
  "* second",
  "> quoted",
].join("\n");

const EXPECTED_PLAIN_RUN_OUTPUT = [
  "Inbox summary",
  "",
  "code line",
  "",
  "Bold italic code strike",
  "",
  "See docs",
  "https://vm0.ai/docs and chart",
  "https://vm0.ai/chart.png",
  "",
  "- first",
  "- second",
  "quoted",
].join("\n");

describe("INT-03: AgentPhone linked-run lifecycle through public APIs", () => {
  it("dispatches linked iMessage DMs, refreshes typing, replies with plain-text completions, and controls sessions", async () => {
    const webhooks = createWebhookCallbackApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    const conversationId = uniqueConversationId();

    // Linked DM creates a run and sends a typing indicator.
    const messageId1 = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "summarize my inbox",
      conversationId,
      isGroup: false,
    });
    await waitForTyping(sends, [conversationId]);

    const run1 = await claimDispatchedRun(runnerGroup);
    expect(run1.prompt).toBe("summarize my inbox");
    expect(run1.appendSystemPrompt).toContain(
      "# Current Integration\nYou are currently running inside: AgentPhone",
    );
    expect(run1.appendSystemPrompt).toContain(
      `Shared AgentPhone number: ${AGENTPHONE_BDD_PHONE_NUMBER}`,
    );
    expect(run1.appendSystemPrompt).toContain(`User phone handle: ${phone}`);
    expect(run1.appendSystemPrompt).toContain(
      `AgentPhone Agent ID: ${AGENTPHONE_BDD_AGENT_ID}`,
    );
    expect(run1.appendSystemPrompt).toContain("Channel: imessage");
    expect(run1.appendSystemPrompt).toContain("Conversation type: dm");
    expect(run1.appendSystemPrompt).toContain(
      `Conversation ID: ${conversationId}`,
    );
    expect(run1.appendSystemPrompt).toContain(`Message ID: ${messageId1}`);

    // A signed typing event-consumer POST refreshes the iMessage indicator
    // while the run's AgentPhone callback is still pending.
    const typingBody = {
      runId: run1.runId,
      events: [{ type: "assistant", sequenceNumber: 1 }],
      context: { userId: actor.userId, orgId: orgOf(actor) },
    };
    const typingScheduled = await ap.requestAgentPhoneTypingEventConsumer(
      typingBody,
      webhooks.signedEventConsumerHeaders(typingBody),
      [200],
    );
    expect(typingScheduled.body).toStrictEqual({ scheduled: true });
    await waitForTyping(sends, [conversationId, conversationId]);

    // Sandbox progress refreshes the typing indicator through the callback.
    await webhooks.requestAgentHeartbeat(
      { runId: run1.runId },
      { authorization: `Bearer ${run1.sandboxToken}` },
      [200],
    );
    await waitForTyping(sends, [
      conversationId,
      conversationId,
      conversationId,
    ]);

    // Completion converts markdown output to iMessage plain text, without
    // an audit link or a non-default-agent footer.
    const beforeCompletion = sends.messages.length;
    ap.mockCompletionRunOutput(MARKDOWN_RUN_OUTPUT);
    await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
    await waitForSendCount(sends, beforeCompletion + 1);
    ap.restoreCompletionRunOutput();
    const completionReply = lastSend(sends);
    expect(completionReply.toNumber).toBe(phone);
    expect(completionReply.conversationId).toBeUndefined();
    expect(completionReply.body).toBe(EXPECTED_PLAIN_RUN_OUTPUT);
    expect(completionReply.body).not.toContain("Audit:");
    expect(completionReply.body).not.toContain("Responded by");
    // Session persistence happens in background callback processing, so
    // wait for the session id to be saved before reading it.
    const session1 = await waitForRunSessionIdPresent(actor, run1.runId);

    // The follow-up DM reuses the saved session and carries stored context.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "follow up",
      conversationId,
      isGroup: false,
    });
    const run2 = await claimDispatchedRun(runnerGroup);
    expect(run2.appendSystemPrompt).toContain("# AgentPhone Message Context");
    expect(run2.appendSystemPrompt).toContain("RELATIVE_INDEX");
    expect(run2.appendSystemPrompt).toContain(`MSG_ID: ${messageId1}`);
    expect(run2.appendSystemPrompt).toContain("SENDER: {id: BOT}");

    const beforeRun2Completion = sends.messages.length;
    await completeSandboxRun(run2.sandboxToken, run2.runId, 0);
    await waitForSendCount(sends, beforeRun2Completion + 1);
    expect(lastSend(sends).body).toBe("Task completed successfully.");
    await waitForRunSessionId(actor, run2.runId, session1);

    // /new_session over iMessage replies without the SMS reliability warning.
    const beforeNewSession = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "/new_session",
      conversationId,
      isGroup: false,
    });
    await waitForSendCount(sends, beforeNewSession + 1);
    expect(lastSend(sends).body).toBe("New session started.");

    // The next DM starts a fresh session.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "fresh start",
      conversationId,
      isGroup: false,
    });
    const run3 = await claimDispatchedRun(runnerGroup);
    await completeSandboxRun(run3.sandboxToken, run3.runId, 0);
    const session3 = await waitForRunSessionIdPresent(actor, run3.runId);
    expect(session3).not.toBe(session1);

    // A failed run replies with the Web-style generic failure text.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "now fail",
      conversationId,
      isGroup: false,
    });
    const run4 = await claimDispatchedRun(runnerGroup);
    const beforeRun4Completion = sends.messages.length;
    await completeSandboxRun(
      run4.sandboxToken,
      run4.runId,
      1,
      "AgentPhone bdd route failure",
    );
    await waitForSendCount(sends, beforeRun4Completion + 1);
    expect(lastSend(sends).body).toBe(
      "Oops, something went wrong. Please try again later.",
    );
  });

  it("renders media prompts, provider recent history, and restarts sessions when the model route changes", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();

    // A media DM walks both percent-decode branches of the filename.
    const mediaMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "mms",
      from: phone,
      body: "what is in this photo",
      mediaUrl: "https://media.agentphone.test/photo%20one%2Bfinal%2zraw.png",
    });
    const run1 = await claimDispatchedRun(runnerGroup);
    expect(run1.prompt).toBe(
      [
        "what is in this photo",
        `[AgentPhone file] photo one+final%2zraw.png (image/png)\n   [ID] ${mediaMessageId}`,
      ].join("\n\n"),
    );
    const beforeRun1Completion = sends.messages.length;
    await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
    await waitForSendCount(sends, beforeRun1Completion + 1);
    const mediaSession = await waitForRunSessionIdPresent(actor, run1.runId);

    // Provider-sent recent history wins over stored context: full entries
    // keep channel and timestamp lines, media-only entries become file
    // placeholders, junk entries are dropped.
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "compare with history",
      recentHistory: [
        {
          messageId: "rh-full",
          content: "prior context from provider",
          direction: "inbound",
          channel: "sms",
          from: phone,
          at: "2026-06-01T08:00:00.000Z",
        },
        { media_url: "https://media.agentphone.test/history-photo.png" },
        { direction: "inbound" },
      ],
    });
    const run2 = await claimDispatchedRun(runnerGroup);
    expect(run2.appendSystemPrompt).toContain("# AgentPhone Message Context");
    expect(run2.appendSystemPrompt).toContain("MSG_ID: rh-full");
    expect(run2.appendSystemPrompt).toContain("prior context from provider");
    expect(run2.appendSystemPrompt).toContain("CHANNEL: sms");
    expect(run2.appendSystemPrompt).toContain("AT: 2026-06-01T08:00:00.000Z");
    expect(run2.appendSystemPrompt).toContain(
      "[AgentPhone file] https://media.agentphone.test/history-photo.png",
    );
    expect(
      run2.appendSystemPrompt.match(/- RELATIVE_INDEX:/gu) ?? [],
    ).toHaveLength(2);

    // Session continuity: the second DM reuses the session saved by the
    // first completion.
    const beforeRun2Completion = sends.messages.length;
    await completeSandboxRun(run2.sandboxToken, run2.runId, 0);
    await waitForSendCount(sends, beforeRun2Completion + 1);
    await waitForRunSessionId(actor, run2.runId, mediaSession);

    // Re-pointing the default model policy at an incompatible provider
    // forces the next DM onto a fresh session.
    await ap.switchDefaultModelRouteToOpenRouter(actor);
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "after provider switch",
    });
    const run3 = await claimDispatchedRun(runnerGroup);
    await completeSandboxRun(run3.sandboxToken, run3.runId, 0);
    await expect(ap.readRunSessionId(actor, run3.runId)).resolves.not.toBe(
      mediaSession,
    );
  });

  it("answers the slash-command surface over SMS with link state and model selection", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const phone = uniquePhoneHandle();
    await ap.linkViaWebhookConnectPrompt(actor, phone, sends);

    const SMS_RISK_WARNING =
      "Note: SMS and MMS replies may not be delivered reliably.";

    async function commandReply(body: string): Promise<string> {
      const before = sends.messages.length;
      await ap.postAgentPhoneInboundMessage({
        channel: "sms",
        from: phone,
        body,
      });
      await waitForSendCount(sends, before + 1);
      const reply = lastSend(sends).body ?? "";
      return reply;
    }

    const help = await commandReply("/help");
    expect(help).toContain("/connect - Connect this phone number to VM0");
    expect(help).toContain("/model - Choose your model");
    expect(help).toContain(SMS_RISK_WARNING);

    const alreadyConnected = await commandReply("/connect");
    expect(alreadyConnected).toContain("You are already connected");
    expect(alreadyConnected).toContain(SMS_RISK_WARNING);

    const modelOptions = await commandReply("/model");
    expect(modelOptions).toContain("Available models");
    expect(modelOptions).toContain("Current: workspace default");
    expect(modelOptions).toContain("/model claude-sonnet-4-6");
    expect(modelOptions).toContain("(workspace default)");

    const switched = await commandReply("/model claude-sonnet-4-6");
    expect(switched).toContain("Switched to ");

    const optionsAfterSwitch = await commandReply("/model");
    expect(optionsAfterSwitch).toContain("Current: Claude Sonnet 4.6");
    expect(optionsAfterSwitch).toContain("(current, workspace default)");

    const unknownModel = await commandReply("/model not-a-model");
    expect(unknownModel).toContain('Error: Unknown model "not-a-model".');

    const disconnected = await commandReply("/disconnect");
    expect(disconnected).toContain(
      "This phone number has been disconnected from VM0.",
    );
    const unlinkedStatus = await integrations.getAgentPhoneLinkStatus(actor);
    expect(unlinkedStatus.linked).toBeFalsy();

    const disconnectAgain = await commandReply("/disconnect");
    expect(disconnectAgain).toContain(
      "Error: This phone number is not connected.",
    );

    const newSessionUnlinked = await commandReply("/new_session");
    expect(newSessionUnlinked).toContain("/agentphone/connect?");
    expect(newSessionUnlinked).toContain(SMS_RISK_WARNING);

    const modelUnlinked = await commandReply("/model");
    expect(modelUnlinked).toContain("/agentphone/connect?");

    const plainPromptUnlinked = await commandReply("hello again");
    expect(plainPromptUnlinked).toContain("Hi, I'm Zero, your AI coworker");
    expect(plainPromptUnlinked).toContain("/agentphone/connect?");
    expect(plainPromptUnlinked).not.toContain(SMS_RISK_WARNING);
  });

  it("handles the iMessage group lifecycle: mentions, stored context, ambient silence, and account-command guards", async () => {
    const runs = createRunsAutomationsApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    const conversationId = uniqueConversationId();

    // A mentioned group message strips the mention and carries provider
    // history into the group run context.
    const groupMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Zero summarize this thread",
      conversationId,
      isGroup: true,
      recentHistory: [
        {
          messageId: "rh-group-prior",
          content: "Earlier group context",
          direction: "inbound",
          channel: "imessage",
          from: "+15559990000",
          at: "2026-05-18T00:00:00.000Z",
        },
      ],
    });
    const run1 = await claimDispatchedRun(runnerGroup);
    expect(run1.prompt).toBe("summarize this thread");
    expect(run1.appendSystemPrompt).toContain("Conversation type: group");
    expect(run1.appendSystemPrompt).toContain("Earlier group context");

    // The completion replies into the conversation, not to a number.
    const beforeGroupCompletion = sends.messages.length;
    await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
    await waitForSendCount(sends, beforeGroupCompletion + 1);
    const groupReply = lastSend(sends);
    expect(groupReply.conversationId).toBe(conversationId);
    expect(groupReply.replyToMessageId).toBe(groupMessageId);
    expect(groupReply.toNumber).toBeUndefined();
    expect(groupReply.body).toBe("Task completed successfully.");

    // A second mention without provider history renders the stored group
    // context with sender handles and the bot reply.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Zero what changed since then",
      conversationId,
      isGroup: true,
    });
    const job2 = await pollDispatchedJob(runnerGroup);
    expect(job2.appendSystemPrompt).toContain("# AgentPhone Message Context");
    expect(job2.appendSystemPrompt).toContain(`SENDER: {id: ${phone}}`);
    expect(job2.appendSystemPrompt).toContain("SENDER: {id: BOT}");
    const beforeJob2Cancel = sends.messages.length;
    await runs.requestCancelRun(actor, job2.runId, [200]);
    await waitForSendCount(sends, beforeJob2Cancel + 1);

    // Ambient group chatter is stored but never dispatched as a run.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "ambient chatter without a mention",
      conversationId,
      isGroup: true,
    });
    await runs.heartbeatRunner(runnerGroup);
    const idle = await runs.pollRunner(runnerGroup);
    expect(idle.body.job).toBeNull();

    // Conversation-only participants cannot run account commands.
    const intruder = uniquePhoneHandle();
    const beforeBlockedCommand = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: intruder,
      body: "/disconnect @Zero",
      conversationId,
      isGroup: true,
    });
    await waitForSendCount(sends, beforeBlockedCommand + 1);
    const blockedReply = lastSend(sends);
    expect(blockedReply.conversationId).toBe(conversationId);
    expect(blockedReply.body).toContain("Only the linked sender");
    expect(blockedReply.body).not.toContain("/agentphone/connect?");
    const stillLinked = await integrations.getAgentPhoneLinkStatus(actor);
    expect(stillLinked).toMatchObject({ linked: true, phoneHandle: phone });

    // Unlinked senders in a fresh group conversation are pointed to a DM,
    // never to a signed connect link.
    const stranger = uniquePhoneHandle();
    const strangerConversationId = uniqueConversationId();
    const beforeStrangerPrompt = sends.messages.length;
    const strangerMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: stranger,
      body: "@Zero hello",
      conversationId: strangerConversationId,
      isGroup: true,
    });
    const dmPrompt = await waitForSendMatching(
      sends,
      beforeStrangerPrompt,
      (send) => {
        return (
          send.conversationId === strangerConversationId &&
          (send.body?.includes("message Zero directly") ?? false)
        );
      },
    );
    expect(dmPrompt.conversationId).toBe(strangerConversationId);
    expect(dmPrompt.replyToMessageId).toBe(strangerMessageId);
    expect(dmPrompt.toNumber).toBeUndefined();
    expect(dmPrompt.body).toContain("message Zero directly");
    expect(dmPrompt.body).not.toContain("/agentphone/connect?");

    // /connect from an unlinked sender in the linked conversation hits the
    // same account-command guard.
    const beforeStrangerCommand = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: stranger,
      body: "/connect @Zero",
      conversationId,
      isGroup: true,
    });
    await waitForSendMatching(sends, beforeStrangerCommand, (send) => {
      return (
        send.conversationId === conversationId &&
        (send.body?.includes("Only the linked sender") ?? false)
      );
    });
  });

  it("skips completion delivery for runs whose phone link was disconnected mid-flight", async () => {
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    const dmConversationId = uniqueConversationId();
    const groupConversationId = uniqueConversationId();

    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "dm before unlink",
      conversationId: dmConversationId,
      isGroup: false,
    });
    const dmRun = await claimDispatchedRun(runnerGroup);

    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Zero group before unlink",
      conversationId: groupConversationId,
      isGroup: true,
    });
    const groupRun = await claimDispatchedRun(runnerGroup);

    await integrations.requestUnlinkAgentPhone(actor, [204]);
    const sendsBeforeCompletion = sends.messages.length;

    // DM stale variant: the handle no longer resolves to the payload link.
    await completeSandboxRun(dmRun.sandboxToken, dmRun.runId, 0);
    expect(sends.messages).toHaveLength(sendsBeforeCompletion);

    // Group stale variant: the link row itself is gone.
    await completeSandboxRun(groupRun.sandboxToken, groupRun.runId, 0);
    expect(sends.messages).toHaveLength(sendsBeforeCompletion);
  });

  it("uploads and streams phone media with a real run-scoped zero token", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends, storage } =
      await entitledLinkedActor();

    const agent = await bdd.createAgent(actor, {
      displayName: "BDD agentphone upload agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "deliver a phone attachment",
      modelProvider: "anthropic-api-key",
    });
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);
    const zeroToken = claim.environment?.ZERO_TOKEN;
    if (!zeroToken) {
      throw new Error("Expected the claimed run to expose ZERO_TOKEN");
    }

    const init = await ap.requestPhoneUploadInitWithToken(
      zeroToken,
      { filename: "screen shot.png", contentType: "image/png", length: 123 },
      [200],
    );
    expect(init.body).toMatchObject({
      filename: "screen_shot.png",
      contentType: "image/png",
      size: 123,
    });
    expect(init.body.uploadUrl).toMatch(/^https?:\/\//u);
    expect(init.body.fileUrl).toContain("/artifacts/");

    storage.addArtifactObject({
      userId: actor.userId,
      uploadId: init.body.uploadId,
      filename: "screen_shot.png",
      size: 456,
    });
    const completed = await ap.requestPhoneUploadCompleteWithToken(
      zeroToken,
      {
        uploadId: init.body.uploadId,
        toNumber: phone,
        agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
        caption: "see attached",
        contentType: "image/png",
      },
      [200],
    );
    expect(completed.body).toMatchObject({
      filename: "screen_shot.png",
      mimetype: "image/png",
      size: 456,
      toNumber: phone,
    });
    const mediaSend = lastSend(sends);
    expect(mediaSend.body).toBe("see attached");
    expect(mediaSend.mediaUrl).toBe(completed.body.url);
    expect(mediaSend.toNumber).toBe(phone);

    // The recorded outbound message is readable back as owned media.
    server.use(
      http.get(completed.body.url, () => {
        return new HttpResponse("png-bytes", {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "9" },
        });
      }),
    );
    const downloaded = await ap.downloadPhoneFileRaw(
      zeroToken,
      completed.body.messageId,
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("image/png");
    expect(downloaded.headers.get("x-file-name")).toBe("screen_shot.png");
    expect(downloaded.text).toBe("png-bytes");

    const unauthorized = await integrations.requestPhoneDownloadFile(
      null,
      completed.body.messageId,
      [401],
    );
    expectApiError(unauthorized.body);

    await completeSandboxRun(claim.sandboxToken, run.runId, 0);
  });

  it("guards startLink against foreign-owner handles and provider network failures", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);

    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    const ownedPhone = uniquePhoneHandle();
    await ap.linkViaWebhookConnectPrompt(owner, ownedPhone, sends);

    const rival = bdd.user();
    const conflicted = await integrations.requestStartAgentPhoneLink(
      rival,
      { phoneHandle: ownedPhone },
      [409],
    );
    expectApiError(conflicted.body);
    expect(conflicted.body.error.code).toBe("CONFLICT");

    server.use(
      http.post("https://api.agentphone.test/v1/messages", () => {
        return HttpResponse.error();
      }),
    );
    const unavailable = await integrations.requestStartAgentPhoneLink(
      rival,
      { phoneHandle: uniquePhoneHandle() },
      [503],
    );
    expectApiError(unavailable.body);
    expect(unavailable.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });
});
