import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  DEFAULT_PROFILE,
  PI_MEMORY_ROOT,
  PI_SKILLS_ROOT,
  PI_STANDBY_PROFILE,
  PI_STANDBY_TTL_RELEASE_EXIT_CODE,
} from "@vm0/api-contracts/contracts/runners";
import type { SupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import { webhookPiTranscriptContract } from "@vm0/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { generateSandboxToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { commitMemoryVersion } from "./helpers/zero-memory";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { webhooksAgentPiTranscriptRoutes } from "../webhooks-agent-pi-transcript";

const context = testContext();
const bdd = createBddApi(context);
const misc = createMiscRoutesApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const workflows = createWorkflowsBddApi(context);

const MODEL = "deepseek-v4-flash";
const COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const CODEX_MODEL = "gpt-5.5";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const AGENT_DISPLAY_NAME = "Pi edge integration agent";

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

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function codexJwt(accountId: string, expiresInSeconds = 3600): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      exp: Math.floor(now() / 1000) + expiresInSeconds,
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: "pro",
      },
    }),
  );
  return `${header}.${payload}.fake-signature`;
}

function codexAuthJson(accessToken: string): string {
  const accountId = "ws_acct_from_id_token_pi_edge";
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: "rt_pi_edge_synthetic_high_entropy",
      account_id: "ws_acct_pi_edge_plain",
      id_token: codexJwt(accountId),
    },
  });
}

function codexTextSsePayload(text: string): string {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_pi_codex",
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_pi_codex",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_pi_codex",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_pi_codex",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_pi_codex",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
        },
      },
    },
  ];
  return events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function codexTextSseStream(text: string): Response {
  // MSW's HttpResponse.text body does not close for the Codex stream reader in
  // this environment; a raw Response with a ReadableStream does (same shape as
  // the pi-agent-runtime unit coverage).
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(codexTextSsePayload(text)));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
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

const TAR_BLOCK_SIZE = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function createTarEntry(filename: string, content: Buffer): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(filename, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(octal(content.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.write("        ", 148);
  header.write("0", 156);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

  const padding = content.length % TAR_BLOCK_SIZE;
  const data =
    padding === 0
      ? content
      : Buffer.concat([content, Buffer.alloc(TAR_BLOCK_SIZE - padding)]);
  return Buffer.concat([header, data]);
}

function createTarGz(
  files: readonly { readonly path: string; readonly content: string }[],
): Buffer {
  return gzipSync(
    Buffer.concat([
      ...files.map((file) => {
        return createTarEntry(file.path, Buffer.from(file.content, "utf8"));
      }),
      Buffer.alloc(TAR_BLOCK_SIZE * 2),
    ]),
  );
}

interface PiStorageObjects {
  put(key: string, body: Buffer): void;
}

function acceptPiStorageObjects(): PiStorageObjects {
  const objects = new Map<string, Buffer>();
  const seededObjects = new Map<string, Buffer>();
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
        const body = objects.get(objectKey) ?? seededObjects.get(key);
        return Promise.resolve(
          body
            ? { Body: streamBody(body), ContentLength: body.byteLength }
            : { Body: undefined },
        );
      }
      case "HeadObjectCommand": {
        const body = objects.get(objectKey) ?? seededObjects.get(key);
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
  return {
    put(key: string, body: Buffer): void {
      seededObjects.set(key, body);
    },
  };
}

interface PiEdgeFixture {
  readonly actor: ApiTestUser;
  readonly switchOwner: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly runnerGroup: string;
  readonly agentDisplayName: string;
  readonly agentInstructions: string;
  readonly workflowSkillName: string;
  readonly storageObjects: PiStorageObjects;
}

async function piEdgeFixture(): Promise<PiEdgeFixture> {
  const orgId = `org_pi_edge_${randomUUID()}`;
  const actor = bdd.user({ orgId });
  const switchOwner = bdd.user({ orgId });
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  api.acceptStorageDownloads();
  const storageObjects = acceptPiStorageObjects();
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
    displayName: AGENT_DISPLAY_NAME,
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
    agentDisplayName: AGENT_DISPLAY_NAME,
    agentInstructions,
    workflowSkillName,
    storageObjects,
  };
}

async function codexPiEdgeFixture(args?: {
  readonly accessToken?: string;
}): Promise<PiEdgeFixture> {
  const orgId = `org_pi_codex_${randomUUID()}`;
  const actor = bdd.user({ orgId });
  const switchOwner = bdd.user({ orgId });
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  api.acceptStorageDownloads();
  const storageObjects = acceptPiStorageObjects();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  server.use(
    http.get(CODEX_WHAM_USAGE_URL, () => {
      return HttpResponse.json({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18_000,
            reset_at: 1_893_441_600,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            reset_at: 1_893_456_000,
          },
        },
      });
    }),
  );
  await misc.upsertPersonalModelProvider(
    actor,
    {
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: {
        CODEX_AUTH_JSON: codexAuthJson(
          args?.accessToken ?? codexJwt("ws_acct_pi_edge_access"),
        ),
      },
    },
    [200, 201],
  );
  await api.updateOrgModelPolicies(actor, [
    {
      model: CODEX_MODEL,
      isDefault: true,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: AGENT_DISPLAY_NAME,
    description: "Exercises the in-API Pi edge turn with a Codex subscription.",
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
    agentDisplayName: AGENT_DISPLAY_NAME,
    agentInstructions,
    workflowSkillName,
    storageObjects,
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

async function disablePiLoop(fixture: PiEdgeFixture): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: fixture.switchOwner.userId,
      orgId: fixture.orgId,
      orgRole: fixture.switchOwner.orgRole,
    },
    { [FeatureSwitchKey.PiLoop]: false },
  );
}

async function sendChatRun(
  fixture: PiEdgeFixture,
  prompt: string,
  threadId?: string,
  model: SupportedRunModel = MODEL,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: fixture.agentId,
      prompt,
      model,
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
  it("uses the org gate, migrates legacy memory into Pi, and completes in the API", async () => {
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
        supportedProfiles: [PI_STANDBY_PROFILE],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job).toMatchObject({
      runId: edge.runId,
      experimentalProfile: PI_STANDBY_PROFILE,
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
    expect(piSystemPrompt).toContain(
      `As ${fixture.agentDisplayName}, you are an excellent communicator`,
    );
    expect(piSystemPrompt).toContain(fixture.agentInstructions);
    expect(piSystemPrompt).toContain(PI_MEMORY_ROOT);
    expect(piSystemPrompt).toContain(`${PI_MEMORY_ROOT}/MEMORY.md`);
    expect(piSystemPrompt).not.toContain("/home/user/.codex/skills/");
    expect(piSystemPrompt).not.toContain("/home/user/.claude/skills/");
    expect(standbyContext.storageManifest?.storageMounts).toContainEqual(
      expect.objectContaining({
        name: "memory",
        mountPath: PI_MEMORY_ROOT,
        missingRootPolicy: "preserveParentVersion",
      }),
    );
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
    expect(
      context.mocks.ably.publish.mock.calls
        .slice(publishedBefore)
        .some(([topic, payload]) => {
          return (
            topic === "pi-standby-release" &&
            recordOf(payload)?.runId === edge.runId
          );
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

    await disablePiLoop(fixture);
    const fallback = await sendChatRun(
      fixture,
      "continue after disabling PiLoop",
      edge.threadId,
    );
    expect((await api.readRun(fixture.actor, fallback.runId)).status).toBe(
      "pending",
    );
    const fallbackPoll = await api.pollRunner(fixture.runnerGroup);
    expect(fallbackPoll.body.job?.runId).toBe(fallback.runId);
    const fallbackContext = await api.claimRunnerJob(fallback.runId);
    expect(fallbackContext.storageManifest?.storageMounts).toContainEqual(
      expect.objectContaining({
        name: "memory",
        mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
        missingRootPolicy: "preserveParentVersion",
      }),
    );
    expect(fallbackContext.storageManifest?.storageMounts).not.toContainEqual(
      expect.objectContaining({
        name: "memory",
        mountPath: PI_MEMORY_ROOT,
      }),
    );
    await api.requestCancelRun(fixture.actor, fallback.runId, [200]);
  });

  it("migrates a Pi-first session memory path back to Codex", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    const modelStarted = createDeferredPromise<void>(context.signal);
    const releaseModel = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseModel.settled()) {
        releaseModel.resolve();
      }
    });
    server.use(
      http.post(COMPLETIONS_URL, async () => {
        modelStarted.resolve();
        await releaseModel.promise;
        return assistantTextStream("Pi-first answer", "Pi-first reasoning");
      }),
    );

    const piFirst = await sendChatRun(fixture, "start this session in PiLoop");
    await modelStarted.promise;
    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: [PI_STANDBY_PROFILE],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job?.runId).toBe(piFirst.runId);
    const piContext = await api.claimRunnerJob(piFirst.runId);
    expect(piContext.storageManifest?.storageMounts).toContainEqual(
      expect.objectContaining({
        name: "memory",
        mountPath: PI_MEMORY_ROOT,
        missingRootPolicy: "preserveParentVersion",
      }),
    );

    releaseModel.resolve();
    await flushWaitUntilForTest();
    expect((await api.readRun(fixture.actor, piFirst.runId)).status).toBe(
      "completed",
    );

    await disablePiLoop(fixture);
    const fallback = await sendChatRun(
      fixture,
      "continue the Pi-first session after disabling PiLoop",
      piFirst.threadId,
    );
    expect((await api.readRun(fixture.actor, fallback.runId)).status).toBe(
      "pending",
    );
    const fallbackPoll = await api.pollRunner(fixture.runnerGroup);
    expect(fallbackPoll.body.job?.runId).toBe(fallback.runId);
    const fallbackContext = await api.claimRunnerJob(fallback.runId);
    expect(fallbackContext.storageManifest?.storageMounts).toContainEqual(
      expect.objectContaining({
        name: "memory",
        mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
        missingRootPolicy: "preserveParentVersion",
      }),
    );
    expect(fallbackContext.storageManifest?.storageMounts).not.toContainEqual(
      expect.objectContaining({
        name: "memory",
        mountPath: PI_MEMORY_ROOT,
      }),
    );
    await api.requestCancelRun(fixture.actor, fallback.runId, [200]);
  });

  it("injects the MEMORY.md prefix and keeps the complete file readable on the edge", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    const visibleMemory = "- Preferred editor: Helix";
    const hiddenMemory = "- Private tail fact: blue herons migrate at dusk";
    const memoryContent = [
      "# Durable memory",
      visibleMemory,
      ...Array.from({ length: 120 }, (_, index) => {
        return `- Context ${String(index).padStart(3, "0")}: ${"x".repeat(80)}`;
      }),
      hiddenMemory,
    ].join("\n");
    expect(Buffer.byteLength(memoryContent, "utf8")).toBeGreaterThan(8 * 1024);
    const memoryFiles = [{ path: "MEMORY.md", content: memoryContent }];
    const memory = await commitMemoryVersion(
      context,
      fixture.actor,
      memoryFiles,
    );
    fixture.storageObjects.put(
      `${memory.s3Key}/archive.tar.gz`,
      createTarGz(memoryFiles),
    );

    const completionRequests: unknown[] = [];
    let modelCall = 0;
    server.use(
      http.post(COMPLETIONS_URL, async ({ request }) => {
        completionRequests.push(await request.json());
        const currentCall = modelCall;
        modelCall += 1;
        return currentCall === 0
          ? assistantToolStream({
              id: "read_memory_1",
              name: "read",
              arguments: { path: `${PI_MEMORY_ROOT}/MEMORY.md` },
              thinking: "read the complete durable memory",
            })
          : assistantTextStream("memory read", "memory considered");
      }),
    );

    const run = await sendChatRun(fixture, "use my durable memory");
    await flushWaitUntilForTest();

    expect(completionRequests).toHaveLength(2);
    const systemPrompt = systemPromptFromRequest(completionRequests[0]);
    if (systemPrompt === undefined) {
      throw new Error("Expected the Pi request to contain a system prompt");
    }
    expect(systemPrompt).toContain(`\`${PI_MEMORY_ROOT}\``);
    expect(systemPrompt).toContain(`\`${PI_MEMORY_ROOT}/MEMORY.md\``);
    expect(systemPrompt).toContain("### MEMORY.md prefix");
    expect(systemPrompt).toContain(visibleMemory);
    expect(systemPrompt).not.toContain(hiddenMemory);
    expect(JSON.stringify(completionRequests[1])).toContain(hiddenMemory);
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "completed",
    );
  });

  it("refreshes an expired Codex subscription before the Pi edge turn", async () => {
    const fixture = await codexPiEdgeFixture({
      accessToken: codexJwt("ws_acct_pi_edge_expired", -60),
    });
    await enablePiLoop(fixture);
    const refreshedAccessToken = codexJwt("ws_acct_pi_edge_refreshed");
    const refreshBodies: unknown[] = [];
    let codexAuthorization: string | null = null;
    let codexAccountId: string | null = null;
    const modelStarted = createDeferredPromise<void>(context.signal);
    const releaseModel = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseModel.settled()) {
        releaseModel.resolve();
      }
    });
    server.use(
      http.post(CODEX_OAUTH_TOKEN_URL, async ({ request }) => {
        refreshBodies.push(await request.json());
        return HttpResponse.json({
          access_token: refreshedAccessToken,
          refresh_token: "rt_pi_edge_rotated_high_entropy",
          expires_in: 3600,
        });
      }),
      http.post(CODEX_RESPONSES_URL, async ({ request }) => {
        codexAuthorization = request.headers.get("authorization");
        codexAccountId = request.headers.get("chatgpt-account-id");
        modelStarted.resolve();
        await releaseModel.promise;
        return codexTextSseStream("codex edge answer");
      }),
    );

    const prompt = "answer with the Codex subscription";
    const run = await sendChatRun(fixture, prompt, undefined, CODEX_MODEL);
    await modelStarted.promise;

    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: [PI_STANDBY_PROFILE],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job).toMatchObject({
      runId: run.runId,
      experimentalProfile: PI_STANDBY_PROFILE,
    });
    const standbyContext = await api.claimRunnerJob(run.runId);
    expect(standbyContext.piModelConfig).toStrictEqual({
      provider: "codex",
      baseUrl: "https://chatgpt.com/backend-api",
      model: CODEX_MODEL,
      apiKeyEnv: "CHATGPT_ACCESS_TOKEN",
    });

    releaseModel.resolve();
    await flushWaitUntilForTest();

    expect(refreshBodies).toStrictEqual([
      {
        client_id: expect.any(String),
        grant_type: "refresh_token",
        refresh_token: "rt_pi_edge_synthetic_high_entropy",
      },
    ]);
    expect(codexAuthorization).toBe(`Bearer ${refreshedAccessToken}`);
    expect(codexAccountId).toBe("ws_acct_pi_edge_refreshed");

    const transcript = await readTranscript(run.runId);
    expect(transcript).toMatchObject({
      version: 1,
      lastOrdinal: 2,
      messages: [
        {
          ordinal: 1,
          messageId: `${run.runId}/1`,
          runId: run.runId,
          runEventSequenceNumber: 1,
          role: "user",
          payload: {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        },
        {
          ordinal: 2,
          messageId: `${run.runId}/2`,
          runId: run.runId,
          runEventSequenceNumber: 2,
          role: "assistant",
          payload: {
            role: "assistant",
            content: [{ type: "text", text: "codex edge answer" }],
            stopReason: "stop",
          },
        },
      ],
    });
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "completed",
    );
  });

  it("uses the Sandbox lane when an expired Codex subscription cannot refresh", async () => {
    const fixture = await codexPiEdgeFixture({
      accessToken: codexJwt("ws_acct_pi_edge_expired", -60),
    });
    await enablePiLoop(fixture);
    const refreshBodies: unknown[] = [];
    let codexRequests = 0;
    server.use(
      http.post(CODEX_OAUTH_TOKEN_URL, async ({ request }) => {
        refreshBodies.push(await request.json());
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "expired refresh token",
            },
          },
          { status: 401 },
        );
      }),
      http.post(CODEX_RESPONSES_URL, () => {
        codexRequests += 1;
        return codexTextSseStream("unexpected edge answer");
      }),
    );

    const run = await sendChatRun(
      fixture,
      "fall back after Codex reconnect is required",
      undefined,
      CODEX_MODEL,
    );
    const defaultPoll = await api.pollRunner(fixture.runnerGroup);

    expect(defaultPoll.body.job?.runId).toBe(run.runId);
    expect(codexRequests).toBe(0);
    expect(refreshBodies).toStrictEqual([
      {
        client_id: expect.any(String),
        grant_type: "refresh_token",
        refresh_token: "rt_pi_edge_synthetic_high_entropy",
      },
    ]);
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "pending",
    );
    const providers = await misc.listPersonalModelProviders(
      fixture.actor,
      [200],
    );
    if (providers.status !== 200) {
      throw new Error("Expected personal model providers to load");
    }
    expect(
      providers.body.modelProviders.find((provider) => {
        return provider.type === "codex-oauth-token";
      }),
    ).toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
  });

  it("continues direct Pi activation when the request aborts after commit", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    const modelStarted = createDeferredPromise<void>(context.signal);
    const releaseModel = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseModel.settled()) {
        releaseModel.resolve();
      }
    });
    server.use(
      http.post(COMPLETIONS_URL, async () => {
        modelStarted.resolve();
        await releaseModel.promise;
        return assistantTextStream(
          "committed edge answer",
          "committed edge reasoning",
        );
      }),
    );

    const controller = new AbortController();
    context.mocks.axiom.ingest.mockImplementation((dataset: unknown) => {
      if (
        typeof dataset === "string" &&
        dataset.includes("run-context") &&
        !controller.signal.aborted
      ) {
        const error = new Error("abort after direct run commit");
        error.name = "AbortError";
        controller.abort(error);
      }
      return true;
    });

    const clientThreadId = randomUUID();
    const clientEventId = randomUUID();
    const request = {
      agentId: fixture.agentId,
      prompt: "finish Pi activation after the request aborts",
      model: MODEL,
      clientThreadId,
      clientEventId,
    } as const;
    await expect(
      chat.requestSendEvent(fixture.actor, request, [201], controller.signal),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBeTruthy();
    await modelStarted.promise;

    const retried = await chat.requestSendEvent(fixture.actor, request, [201]);
    if (retried.status !== 201 || retried.body.runId === null) {
      throw new Error("Expected the committed chat run to be recoverable");
    }
    releaseModel.resolve();
    await flushWaitUntilForTest();
    expect((await api.readRun(fixture.actor, retried.body.runId)).status).toBe(
      "completed",
    );
  });

  it("starts the Pi edge turn when a concurrency-queued run is promoted", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const fixture = await piEdgeFixture();
    const occupyingRun = await sendChatRun(
      fixture,
      "occupy the only concurrency slot",
    );
    expect((await api.readRun(fixture.actor, occupyingRun.runId)).status).toBe(
      "pending",
    );

    await enablePiLoop(fixture);
    const modelStarted = createDeferredPromise<void>(context.signal);
    const releaseModel = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseModel.settled()) {
        releaseModel.resolve();
      }
    });
    server.use(
      http.post(COMPLETIONS_URL, async () => {
        modelStarted.resolve();
        await releaseModel.promise;
        return assistantTextStream(
          "promoted edge answer",
          "promoted edge reasoning",
        );
      }),
    );

    const queuedRun = await sendChatRun(
      fixture,
      "start Pi after the queue picks this run",
    );
    expect((await api.readRun(fixture.actor, queuedRun.runId)).status).toBe(
      "queued",
    );
    expect(modelStarted.settled()).toBeFalsy();

    const promotionController = new AbortController();
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "queue:changed" && !promotionController.signal.aborted) {
        const error = new Error("abort after queued run promotion commit");
        error.name = "AbortError";
        promotionController.abort(error);
      }
      return Promise.resolve(undefined);
    });
    const completed = await webhooks.requestAgentComplete(
      {
        runId: occupyingRun.runId,
        exitCode: 1,
        error: "release the concurrency slot for promotion",
      },
      {
        authorization: `Bearer ${generateSandboxToken(
          fixture.actor.userId,
          occupyingRun.runId,
          fixture.orgId,
        )}`,
      },
      [200],
      promotionController.signal,
    );
    expect(completed.status).toBe(200);
    await modelStarted.promise;
    expect(promotionController.signal.aborted).toBeTruthy();

    expect((await api.readRun(fixture.actor, queuedRun.runId)).status).toBe(
      "pending",
    );
    const defaultPoll = await api.pollRunner(fixture.runnerGroup);
    expect(defaultPoll.body.job).toBeNull();
    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: [PI_STANDBY_PROFILE],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected promoted Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job).toMatchObject({
      runId: queuedRun.runId,
      experimentalProfile: PI_STANDBY_PROFILE,
    });

    releaseModel.resolve();
    await flushWaitUntilForTest();
    expect((await api.readRun(fixture.actor, queuedRun.runId)).status).toBe(
      "completed",
    );
  });

  it("requeues an expired standby onto the cold-start lane without settling the run", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    const modelStarted = createDeferredPromise<void>(context.signal);
    const releaseModel = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseModel.settled()) {
        releaseModel.resolve();
      }
    });
    server.use(
      http.post(COMPLETIONS_URL, async () => {
        modelStarted.resolve();
        await releaseModel.promise;
        return assistantToolStream({
          id: "bash_ttl_fallback_1",
          name: "bash",
          arguments: { command: "pwd" },
          thinking: "Sandbox work is required after the standby TTL.",
        });
      }),
    );

    const run = await sendChatRun(fixture, "wait past the standby TTL");
    await modelStarted.promise;
    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: [PI_STANDBY_PROFILE],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job?.runId).toBe(run.runId);
    const standbyContext = await api.claimRunnerJob(run.runId);

    const released = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: PI_STANDBY_TTL_RELEASE_EXIT_CODE,
      },
      { authorization: `Bearer ${standbyContext.sandboxToken}` },
      [200],
    );
    expect(released.body).toStrictEqual({ success: true, status: "released" });
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "running",
    );

    const prematureColdPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: [DEFAULT_PROFILE],
      },
      [200],
    );
    if (prematureColdPoll.status !== 200) {
      throw new Error("Expected premature Pi cold-start poll to return 200");
    }
    expect(prematureColdPoll.body.job).toBeNull();

    releaseModel.resolve();
    await flushWaitUntilForTest();
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "pending",
    );

    const coldPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: [DEFAULT_PROFILE],
      },
      [200],
    );
    if (coldPoll.status !== 200) {
      throw new Error("Expected Pi cold-start poll to return 200");
    }
    expect(coldPoll.body.job).toMatchObject({
      runId: run.runId,
      experimentalProfile: DEFAULT_PROFILE,
    });
    const coldContext = await api.claimRunnerJob(run.runId);
    expect(coldContext.piSystemPrompt).toBe(standbyContext.piSystemPrompt);
    expect(coldContext.runSkillSnapshot).toStrictEqual(
      standbyContext.runSkillSnapshot,
    );
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "running",
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
        supportedProfiles: [PI_STANDBY_PROFILE],
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

    const sandboxHeaders = webhooks.sandboxWebhookHeaders({
      runId: run.runId,
    });
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "pi.message.completed",
            sequenceNumber: 3,
            messageId: `${run.runId}/3`,
            expectedVersion: 1,
            expectedLastOrdinal: 2,
            message: {
              role: "toolResult",
              toolCallId: "bash_handoff_1",
              toolName: "bash",
              content: [{ type: "text", text: "/home/user/workspace\n" }],
              details: {},
              isError: false,
              timestamp: 2,
            },
          },
          {
            type: "pi.message.completed",
            sequenceNumber: 4,
            messageId: `${run.runId}/4`,
            expectedVersion: 1,
            expectedLastOrdinal: 3,
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Sandbox resumed the handed-off tool call.",
                },
              ],
              stopReason: "stop",
              timestamp: 3,
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, lastEventSequence: 4 },
      { authorization: `Bearer ${standbyContext.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "completed",
    );
    const completedTranscript = await readTranscript(run.runId);
    expect(completedTranscript).toMatchObject({
      version: 1,
      lastOrdinal: 4,
      messages: [
        expect.objectContaining({ messageId: `${run.runId}/1` }),
        expect.objectContaining({ messageId: `${run.runId}/2` }),
        expect.objectContaining({
          messageId: `${run.runId}/3`,
          role: "toolResult",
        }),
        expect.objectContaining({
          messageId: `${run.runId}/4`,
          role: "assistant",
          payload: expect.objectContaining({
            stopReason: "stop",
          }),
        }),
      ],
    });
  });
});
