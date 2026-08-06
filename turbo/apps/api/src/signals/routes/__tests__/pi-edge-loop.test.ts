import { randomUUID } from "node:crypto";

import { PI_SKILLS_ROOT } from "@vm0/api-contracts/contracts/runners";
import { webhookPiTranscriptContract } from "@vm0/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { webhooksAgentPiTranscriptRoutes } from "../webhooks-agent-pi-transcript";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const workflows = createWorkflowsBddApi(context);

const MODEL = "deepseek-v4-flash";
const COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function completionStream(
  deltas: readonly Record<string, unknown>[],
  finishReason: "stop" | "tool_calls",
): HttpResponse<string> {
  const chunks = [
    ...deltas.map((delta) => {
      return {
        id: "chatcmpl-pi-edge",
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL,
        choices: [{ index: 0, delta, finish_reason: null }],
      };
    }),
    {
      id: "chatcmpl-pi-edge",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    },
  ];
  return HttpResponse.text(
    `${chunks
      .map((chunk) => {
        return `data: ${JSON.stringify(chunk)}\n\n`;
      })
      .join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function assistantTextStream(
  text: string,
  thinking: string,
): HttpResponse<string> {
  return completionStream(
    [{ role: "assistant", reasoning_content: thinking }, { content: text }],
    "stop",
  );
}

function assistantToolStream(args: {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly thinking: string;
  readonly text?: string;
}): HttpResponse<string> {
  return completionStream(
    [
      { role: "assistant", reasoning_content: args.thinking },
      {
        ...(args.text === undefined ? {} : { content: args.text }),
        tool_calls: [
          {
            index: 0,
            id: args.id,
            type: "function",
            function: {
              name: args.name,
              arguments: JSON.stringify(args.arguments),
            },
          },
        ],
      },
    ],
    "tool_calls",
  );
}

function systemPromptFromRequest(request: unknown): string | undefined {
  const messages = recordOf(request)?.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const systemMessage = recordOf(messages[0]);
  return systemMessage?.role === "system" &&
    typeof systemMessage.content === "string"
    ? systemMessage.content
    : undefined;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return Object.fromEntries(Object.entries(command.input));
  }
  return {};
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function bodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  return body instanceof Uint8Array ? Buffer.from(body) : Buffer.alloc(0);
}

function streamBody(buffer: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

function acceptPiStorageObjects(): void {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const key = typeof input.Key === "string" ? input.Key : "";
    const objectKey = `${bucket}/${key}`;
    switch (commandName(command)) {
      case "PutObjectCommand": {
        objects.set(objectKey, bodyBuffer(input.Body));
        return Promise.resolve({});
      }
      case "GetObjectCommand": {
        const body = objects.get(objectKey);
        return Promise.resolve(
          body
            ? { Body: streamBody(body), ContentLength: body.byteLength }
            : { Body: undefined },
        );
      }
      case "HeadObjectCommand": {
        const body = objects.get(objectKey);
        return body
          ? Promise.resolve({ ContentLength: body.byteLength })
          : Promise.reject(
              Object.assign(new Error(`Missing S3 object ${objectKey}`), {
                name: "NotFound",
                $metadata: { httpStatusCode: 404 },
              }),
            );
      }
      default: {
        return Promise.resolve({});
      }
    }
  });
}

interface PiEdgeFixture {
  readonly actor: ApiTestUser;
  readonly switchOwner: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly runnerGroup: string;
  readonly agentInstructions: string;
  readonly workflowSkillName: string;
}

async function piEdgeFixture(): Promise<PiEdgeFixture> {
  const orgId = `org_pi_edge_${randomUUID()}`;
  const actor = bdd.user({ orgId });
  const switchOwner = bdd.user({ orgId });
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  api.acceptStorageDownloads();
  acceptPiStorageObjects();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const provider = await api.createOrgModelProvider(actor, {
    type: "deepseek",
    secret: "pi-edge-deepseek-key",
  });
  await api.updateOrgModelPolicies(actor, [
    {
      model: MODEL,
      isDefault: true,
      defaultProviderType: "deepseek",
      credentialScope: "org",
      modelProviderId: provider.providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Pi edge integration agent",
    description: "Exercises the in-API Pi edge turn.",
    visibility: "private",
  });
  const agentInstructions =
    "# Pinned Pi instructions\nAlways preserve the run snapshot.";
  await bdd.updateAgentInstructions(actor, agent.agentId, agentInstructions);
  const workflowSkillName = `pi-snapshot-${randomUUID().slice(0, 8)}`;
  await workflows.createWorkflow(actor, {
    agentId: agent.agentId,
    name: workflowSkillName,
  });
  return {
    actor,
    switchOwner,
    agentId: agent.agentId,
    orgId,
    runnerGroup,
    agentInstructions,
    workflowSkillName,
  };
}

async function enablePiLoop(fixture: PiEdgeFixture): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: fixture.switchOwner.userId,
      orgId: fixture.orgId,
      orgRole: fixture.switchOwner.orgRole,
    },
    { [FeatureSwitchKey.PiLoop]: true },
  );
}

async function sendChatRun(
  fixture: PiEdgeFixture,
  prompt: string,
  threadId?: string,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: fixture.agentId,
      prompt,
      model: MODEL,
      clientEventId: randomUUID(),
      ...(threadId === undefined ? {} : { threadId }),
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function readTranscript(runId: string) {
  const response = await accept(
    setupApp({ context, routes: webhooksAgentPiTranscriptRoutes })(
      webhookPiTranscriptContract,
    ).read({
      headers: webhooks.sandboxWebhookHeaders({ runId }),
      query: { runId },
    }),
    [200],
  );
  return response.body;
}

async function outputMessages(actor: ApiTestUser, threadId: string) {
  const page = await chat.listThreadEvents(actor, threadId);
  return page.events.filter((event) => {
    return event.eventType === "output.message";
  });
}

describe("PiLoop edge turn", () => {
  it("uses the org gate, starts an existing thread without legacy backfill, and completes in the API", async () => {
    const fixture = await piEdgeFixture();
    const legacyPrompt = "legacy context must not enter the Pi transcript";
    const legacy = await sendChatRun(fixture, legacyPrompt);

    expect((await api.readRun(fixture.actor, legacy.runId)).status).toBe(
      "pending",
    );
    const legacyPoll = await api.pollRunner(fixture.runnerGroup);
    expect(legacyPoll.body.job?.runId).toBe(legacy.runId);
    await api.requestCancelRun(fixture.actor, legacy.runId, [200]);

    await enablePiLoop(fixture);
    const modelStarted = createDeferredPromise<void>(context.signal);
    const releaseModel = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseModel.settled()) {
        releaseModel.resolve();
      }
    });
    const completionRequests: unknown[] = [];
    let modelCall = 0;
    server.use(
      http.post(COMPLETIONS_URL, async ({ request }) => {
        completionRequests.push(await request.json());
        const currentCall = modelCall;
        modelCall += 1;
        if (currentCall === 0) {
          modelStarted.resolve();
          await releaseModel.promise;
          return assistantToolStream({
            id: "read_skill_1",
            name: "read",
            arguments: {
              path: `${PI_SKILLS_ROOT}/${fixture.workflowSkillName}/SKILL.md`,
            },
            thinking: "inspect the pinned skill",
          });
        }
        return currentCall === 1
          ? assistantTextStream("edge answer", "edge reasoning")
          : assistantTextStream("follow-up answer", "follow-up reasoning");
      }),
    );

    const edgePrompt = "answer only this new message";
    const publishedBefore = context.mocks.ably.publish.mock.calls.length;
    const edge = await sendChatRun(fixture, edgePrompt, legacy.threadId);
    await modelStarted.promise;

    const defaultPoll = await api.pollRunner(fixture.runnerGroup);
    expect(defaultPoll.body.job).toBeNull();
    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: ["vm0/pi-standby"],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job).toMatchObject({
      runId: edge.runId,
      experimentalProfile: "vm0/pi-standby",
    });
    const standbyContext = await api.claimRunnerJob(edge.runId);
    const skillSnapshot = standbyContext.runSkillSnapshot;
    if (skillSnapshot === undefined) {
      throw new Error("Expected Pi standby context to include Skill snapshot");
    }
    const piSystemPrompt = standbyContext.piSystemPrompt;
    if (piSystemPrompt === undefined) {
      throw new Error("Expected Pi standby context to include system prompt");
    }
    expect(skillSnapshot).toMatchObject({
      schemaVersion: 1,
      policyVersion: 1,
      root: PI_SKILLS_ROOT,
    });
    expect(skillSnapshot.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(skillSnapshot.entries.length).toBeGreaterThan(0);
    expect(standbyContext.piModelConfig).toStrictEqual({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(skillSnapshot.entries).toContainEqual(
      expect.objectContaining({
        logicalDir: `${PI_SKILLS_ROOT}/${fixture.workflowSkillName}`,
        skillFile: `${PI_SKILLS_ROOT}/${fixture.workflowSkillName}/SKILL.md`,
      }),
    );
    expect(piSystemPrompt).toContain(
      `<name>${fixture.workflowSkillName}</name>`,
    );
    expect(piSystemPrompt).toContain(
      `<location>${PI_SKILLS_ROOT}/${fixture.workflowSkillName}/SKILL.md</location>`,
    );
    expect(piSystemPrompt).toContain(fixture.agentInstructions);
    expect(piSystemPrompt).not.toContain("/home/user/.codex/skills/");
    expect(piSystemPrompt).not.toContain("/home/user/.claude/skills/");
    for (const entry of skillSnapshot.entries) {
      expect(entry.logicalDir.startsWith(`${PI_SKILLS_ROOT}/`)).toBeTruthy();
      expect(entry.skillFile).toBe(`${entry.logicalDir}/SKILL.md`);
      expect(standbyContext.storageManifest?.storageMounts).toContainEqual(
        expect.objectContaining({
          name: entry.storageName,
          storageId: entry.storageId,
          versionId: entry.versionId,
          mountPath: entry.logicalDir,
        }),
      );
    }

    releaseModel.resolve();
    await flushWaitUntilForTest();

    expect(completionRequests).toHaveLength(2);
    expect(completionRequests[0]).toMatchObject({
      model: MODEL,
      messages: [
        { role: "system", content: piSystemPrompt },
        {
          role: "user",
          content: [{ type: "text", text: edgePrompt }],
        },
      ],
      stream: true,
      tools: expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "read" }),
        }),
      ]),
    });
    expect(completionRequests[1]).toMatchObject({
      model: MODEL,
      messages: [
        { role: "system", content: piSystemPrompt },
        {
          role: "user",
          content: [{ type: "text", text: edgePrompt }],
        },
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({
              id: "read_skill_1",
              function: expect.objectContaining({ name: "read" }),
            }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "read_skill_1",
        }),
      ],
      stream: true,
    });
    expect(systemPromptFromRequest(completionRequests[1])).toBe(piSystemPrompt);
    expect(JSON.stringify(completionRequests)).not.toContain(legacyPrompt);

    const transcript = await readTranscript(edge.runId);
    expect(transcript).toMatchObject({
      version: 1,
      lastOrdinal: 4,
      messages: [
        {
          ordinal: 1,
          messageId: `${edge.runId}/1`,
          runId: edge.runId,
          runEventSequenceNumber: 1,
          role: "user",
          payload: {
            role: "user",
            content: [{ type: "text", text: edgePrompt }],
          },
        },
        {
          ordinal: 2,
          messageId: `${edge.runId}/2`,
          runId: edge.runId,
          runEventSequenceNumber: 2,
          role: "assistant",
          payload: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "inspect the pinned skill",
              },
              {
                type: "toolCall",
                id: "read_skill_1",
                name: "read",
                arguments: {
                  path: `${PI_SKILLS_ROOT}/${fixture.workflowSkillName}/SKILL.md`,
                },
              },
            ],
            stopReason: "toolUse",
          },
        },
        {
          ordinal: 3,
          messageId: `${edge.runId}/3`,
          runId: edge.runId,
          runEventSequenceNumber: 3,
          role: "toolResult",
          payload: {
            role: "toolResult",
            toolCallId: "read_skill_1",
            toolName: "read",
            content: [
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining(
                  `name: ${fixture.workflowSkillName}`,
                ),
              }),
            ],
            isError: false,
          },
        },
        {
          ordinal: 4,
          messageId: `${edge.runId}/4`,
          runId: edge.runId,
          runEventSequenceNumber: 4,
          role: "assistant",
          payload: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "edge reasoning" },
              { type: "text", text: "edge answer" },
            ],
            stopReason: "stop",
          },
        },
      ],
    });
    expect(JSON.stringify(transcript)).not.toContain(legacyPrompt);

    const projected = await outputMessages(fixture.actor, edge.threadId);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      runId: edge.runId,
      content: "edge answer",
    });
    expect((await api.readRun(fixture.actor, edge.runId)).status).toBe(
      "completed",
    );
    expect(
      context.mocks.ably.publish.mock.calls
        .slice(publishedBefore)
        .some(([topic]) => {
          return topic === `chatThreadMessageCreated:${edge.threadId}`;
        }),
    ).toBeTruthy();

    const followUpPrompt = "continue with the Pi-only history";
    const followUp = await sendChatRun(fixture, followUpPrompt, edge.threadId);
    await flushWaitUntilForTest();

    expect(completionRequests).toHaveLength(3);
    expect(completionRequests[2]).toMatchObject({
      model: MODEL,
      messages: [
        { role: "system", content: piSystemPrompt },
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({
          role: "assistant",
          tool_calls: [expect.objectContaining({ id: "read_skill_1" })],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "read_skill_1",
        }),
        expect.objectContaining({ role: "assistant", content: "edge answer" }),
        {
          role: "user",
          content: [{ type: "text", text: followUpPrompt }],
        },
      ],
      stream: true,
    });
    expect(JSON.stringify(completionRequests[2])).not.toContain(legacyPrompt);
    const continuedTranscript = await readTranscript(followUp.runId);
    expect(continuedTranscript).toMatchObject({
      version: 1,
      lastOrdinal: 6,
      messages: [
        expect.objectContaining({ ordinal: 1, runId: edge.runId }),
        expect.objectContaining({ ordinal: 2, runId: edge.runId }),
        expect.objectContaining({ ordinal: 3, runId: edge.runId }),
        expect.objectContaining({ ordinal: 4, runId: edge.runId }),
        expect.objectContaining({
          ordinal: 5,
          runId: followUp.runId,
          messageId: `${followUp.runId}/1`,
          role: "user",
        }),
        expect.objectContaining({
          ordinal: 6,
          runId: followUp.runId,
          messageId: `${followUp.runId}/2`,
          role: "assistant",
          payload: expect.objectContaining({
            content: [
              expect.objectContaining({
                type: "thinking",
                thinking: "follow-up reasoning",
              }),
              expect.objectContaining({
                type: "text",
                text: "follow-up answer",
              }),
            ],
          }),
        }),
      ],
    });
    expect((await api.readRun(fixture.actor, followUp.runId)).status).toBe(
      "completed",
    );
  });

  it("fails the run after preserving the user message when the model call fails", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    server.use(
      http.post(COMPLETIONS_URL, () => {
        return HttpResponse.json(
          { error: "provider unavailable" },
          { status: 503 },
        );
      }),
    );

    const prompt = "this model call will fail";
    const run = await sendChatRun(fixture, prompt);
    await flushWaitUntilForTest();

    expect((await api.readRun(fixture.actor, run.runId)).status).toBe("failed");
    const transcript = await readTranscript(run.runId);
    expect(transcript).toMatchObject({
      version: 1,
      lastOrdinal: 2,
      messages: [
        {
          ordinal: 1,
          messageId: `${run.runId}/1`,
          role: "user",
          payload: {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        },
        {
          ordinal: 2,
          messageId: `${run.runId}/2`,
          role: "assistant",
          payload: {
            role: "assistant",
            content: [],
            stopReason: "error",
          },
        },
      ],
    });
    await expect(
      outputMessages(fixture.actor, run.threadId),
    ).resolves.toHaveLength(0);
  });

  it("commits the complete sandbox tool batch, publishes handoff, and stops writing", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    const completionRequests: unknown[] = [];
    server.use(
      http.post(COMPLETIONS_URL, async ({ request }) => {
        completionRequests.push(await request.json());
        return assistantToolStream({
          id: "bash_handoff_1",
          name: "bash",
          arguments: { command: "pwd" },
          thinking: "the sandbox must execute this",
          text: "I will inspect the workspace.",
        });
      }),
    );

    const prompt = "inspect the sandbox workspace";
    const publishedBefore = context.mocks.ably.publish.mock.calls.length;
    const run = await sendChatRun(fixture, prompt);
    await flushWaitUntilForTest();

    expect(completionRequests).toHaveLength(1);
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "pending",
    );
    const transcript = await readTranscript(run.runId);
    expect(transcript).toMatchObject({
      version: 1,
      lastOrdinal: 2,
      messages: [
        {
          ordinal: 1,
          messageId: `${run.runId}/1`,
          role: "user",
        },
        {
          ordinal: 2,
          messageId: `${run.runId}/2`,
          role: "assistant",
          payload: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "the sandbox must execute this",
              },
              { type: "text", text: "I will inspect the workspace." },
              {
                type: "toolCall",
                id: "bash_handoff_1",
                name: "bash",
                arguments: { command: "pwd" },
              },
            ],
            stopReason: "toolUse",
          },
        },
      ],
    });
    expect(
      context.mocks.ably.publish.mock.calls
        .slice(publishedBefore)
        .some(([topic, payload]) => {
          return (
            topic === "pi-handoff" && recordOf(payload)?.runId === run.runId
          );
        }),
    ).toBeTruthy();

    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: ["vm0/pi-standby"],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job?.runId).toBe(run.runId);
    const standbyContext = await api.claimRunnerJob(run.runId);
    expect(standbyContext.piSystemPrompt).toBe(
      systemPromptFromRequest(completionRequests[0]),
    );
    expect(standbyContext.runSkillSnapshot?.digest).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });
});
