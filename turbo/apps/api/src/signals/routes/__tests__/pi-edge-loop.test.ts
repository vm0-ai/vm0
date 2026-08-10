import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { SupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import {
  DEFAULT_PROFILE,
  PI_MEMORY_ROOT,
  PI_SKILLS_ROOT,
} from "@vm0/api-contracts/contracts/runners";
import { webhookPiTranscriptContract } from "@vm0/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { parseGitHubTreeUrl, resolveSkillRef } from "@vm0/core/github-url";
import { getSkillStorageName } from "@vm0/core/storage-names";
import { GOAL_SKILL_NAME, SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { HttpResponse, http } from "msw";
import { v5 as uuidv5 } from "uuid";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { generateSandboxToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { readModelStatsObservations } from "./helpers/model-stats-state";
import { seedVm0ManagedModelKey } from "./helpers/runtime-state";
import { commitMemoryVersion } from "./helpers/zero-memory";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { webhooksAgentPiTranscriptRoutes } from "../webhooks-agent-pi-transcript";
import {
  createAgentComposeFixture,
  readAgentComposeByIdFixture,
} from "../../../test-fixtures/agent-composes";
import { readSystemStorageVersionNameByS3KeyFixture } from "../../../test-fixtures/storage";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const workflows = createWorkflowsBddApi(context);
const billing = createBillingMediaApi(context);
type AgentEventsBody = Parameters<typeof webhooks.requestAgentEvents>[0];
type AgentUsageEventBody = Parameters<
  typeof webhooks.requestAgentUsageEvent
>[0];

const MODEL = "deepseek-v4-flash";
const NON_PI_MODELS = [
  "kimi-k3",
  "kimi-k2.7-code",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
] as const satisfies readonly SupportedRunModel[];
const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";
const AGENT_DISPLAY_NAME = "Pi edge integration agent";
const STORAGE_ARCHIVE_SUFFIX = "/archive.tar.gz";
const PI_EDGE_USAGE_OBSERVATION_IDEMPOTENCY_NAMESPACE =
  "1b7c07b8-01bc-4ae2-ac5c-ef5ca9f72683";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function systemPromptFromRequest(request: unknown): string | undefined {
  const requestRecord = recordOf(request);
  const messages = requestRecord?.messages ?? requestRecord?.input;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const systemMessage = recordOf(messages[0]);
  return (systemMessage?.role === "system" ||
    systemMessage?.role === "developer") &&
    typeof systemMessage.content === "string"
    ? systemMessage.content
    : undefined;
}

function rawSseStream(body: string): Response {
  // MSW's HttpResponse.text body does not close for the Responses stream reader
  // in this environment; a raw Response with a ReadableStream does.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesSseStream(
  events: readonly Readonly<Record<string, unknown>>[],
): Response {
  return rawSseStream(
    events
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
  );
}

function deepseekReasoningItem(thinking: string): Record<string, unknown> {
  return {
    type: "reasoning",
    id: "rs_pi_deepseek",
    status: "completed",
    summary: [],
    content: [{ type: "reasoning_text", text: thinking }],
  };
}

function deepseekMessageItem(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "msg_pi_deepseek",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function deepseekResponseUsage(
  usage?: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> | null {
  return usage === undefined
    ? {
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      }
    : usage;
}

function deepseekTextSseStream(
  text: string,
  thinking: string,
  usage?: Readonly<Record<string, unknown>> | null,
): Response {
  const reasoningItem = deepseekReasoningItem(thinking);
  const messageItem = deepseekMessageItem(text);
  return responsesSseStream([
    {
      type: "response.created",
      response: {
        id: "resp_pi_deepseek",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...reasoningItem, status: "in_progress", content: [] },
    },
    {
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: thinking,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: reasoningItem,
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...messageItem, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 1,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: messageItem,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_pi_deepseek",
        status: "completed",
        output: [reasoningItem, messageItem],
        usage: deepseekResponseUsage(usage),
      },
    },
  ]);
}

function deepseekToolCallId(callId: string): string {
  return `${callId}|fc_${callId}`;
}

function deepseekToolSseStream(args: {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly thinking: string;
  readonly usage?: Readonly<Record<string, unknown>>;
}): Response {
  const reasoningItem = deepseekReasoningItem(args.thinking);
  const serializedArguments = JSON.stringify(args.arguments);
  const functionItem = {
    type: "function_call",
    id: `fc_${args.id}`,
    call_id: args.id,
    name: args.name,
    arguments: serializedArguments,
    status: "completed",
  };
  return responsesSseStream([
    {
      type: "response.created",
      response: {
        id: "resp_pi_deepseek",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...reasoningItem, status: "in_progress", content: [] },
    },
    {
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: args.thinking,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: reasoningItem,
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...functionItem, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: serializedArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 1,
      arguments: serializedArguments,
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: functionItem,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_pi_deepseek",
        status: "completed",
        output: [reasoningItem, functionItem],
        usage: deepseekResponseUsage(args.usage),
      },
    },
  ]);
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
  const systemSkillNameByStorageName = new Map(
    [...SEED_SKILLS, GOAL_SKILL_NAME].flatMap((skillRef) => {
      const parsed = parseGitHubTreeUrl(resolveSkillRef(skillRef));
      return parsed
        ? [[getSkillStorageName(parsed.fullPath), parsed.skillName] as const]
        : [];
    }),
  );
  const systemSkillStorageNames = [...systemSkillNameByStorageName.keys()];
  const resolveBody = async (
    objectKey: string,
    key: string,
  ): Promise<Buffer | undefined> => {
    const stored = objects.get(objectKey) ?? seededObjects.get(key);
    if (stored || !key.endsWith(STORAGE_ARCHIVE_SUFFIX)) {
      return stored;
    }
    const storageName = await readSystemStorageVersionNameByS3KeyFixture({
      s3Key: key.slice(0, -STORAGE_ARCHIVE_SUFFIX.length),
      storageNames: systemSkillStorageNames,
    });
    const skillName =
      storageName === undefined
        ? undefined
        : systemSkillNameByStorageName.get(storageName);
    if (skillName === undefined) {
      return undefined;
    }
    const archive = createTarGz([
      {
        path: "SKILL.md",
        content: `---\nname: ${skillName}\ndescription: Test fixture for the default ${skillName} Skill.\n---\n`,
      },
    ]);
    seededObjects.set(key, archive);
    return archive;
  };
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const key = typeof input.Key === "string" ? input.Key : "";
    const objectKey = `${bucket}/${key}`;
    switch (commandName(command)) {
      case "PutObjectCommand": {
        objects.set(objectKey, bodyBuffer(input.Body));
        return {};
      }
      case "GetObjectCommand": {
        const body = await resolveBody(objectKey, key);
        return body
          ? { Body: streamBody(body), ContentLength: body.byteLength }
          : { Body: undefined };
      }
      case "HeadObjectCommand": {
        const body = await resolveBody(objectKey, key);
        if (!body) {
          throw Object.assign(new Error(`Missing S3 object ${objectKey}`), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        return { ContentLength: body.byteLength };
      }
      default: {
        return {};
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
  readonly runnerProfile: string;
  readonly agentDisplayName: string;
  readonly agentInstructions: string;
  readonly workflowSkillName: string;
  readonly storageObjects: PiStorageObjects;
  readonly model: SupportedRunModel;
}

async function setFixtureAgentProfile(
  actor: ApiTestUser,
  agentId: string,
  profile: string,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected the Pi fixture actor to belong to an org");
  }
  const fixtureActor = { userId: actor.userId, orgId: actor.orgId };
  const composeResponse = await readAgentComposeByIdFixture({
    actor: fixtureActor,
    composeId: agentId,
  });
  if (composeResponse.status !== 200) {
    throw new Error("Expected the Pi fixture agent compose to be readable");
  }
  const content = composeResponse.body.content;
  if (!content) {
    throw new Error("Expected the Pi fixture agent to have compose content");
  }
  const entries = Object.entries(content.agents);
  if (entries.length !== 1) {
    throw new Error("Expected the Pi fixture compose to contain one agent");
  }
  const entry = entries[0];
  if (!entry) {
    throw new Error("Expected the Pi fixture compose agent");
  }
  const [agentName, agent] = entry;
  const updated = await createAgentComposeFixture({
    actor: fixtureActor,
    content: {
      ...content,
      agents: {
        [agentName]: { ...agent, experimental_profile: profile },
      },
    },
    signal: context.signal,
  });
  if (updated.status !== 200 || updated.body.composeId !== agentId) {
    throw new Error("Expected the Pi fixture compose update to preserve id");
  }
}

async function piEdgeFixture(
  options: {
    readonly provider?: "byok" | "vm0";
    readonly model?: SupportedRunModel;
    readonly runnerProfile?: string;
  } = {},
): Promise<PiEdgeFixture> {
  const providerType = options.provider ?? "byok";
  const model = options.model ?? MODEL;
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
  const provider =
    providerType === "byok"
      ? await api.createOrgModelProvider(actor, {
          type: "deepseek",
          secret: "pi-edge-deepseek-key",
        })
      : undefined;
  if (providerType === "vm0") {
    await seedVm0ManagedModelKey(context, model);
  }
  await api.updateOrgModelPolicies(actor, [
    {
      model,
      isDefault: true,
      defaultProviderType: providerType === "vm0" ? "vm0" : "deepseek",
      credentialScope: "org",
      modelProviderId: provider?.providerId ?? null,
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
  const runnerProfile = options.runnerProfile ?? DEFAULT_PROFILE;
  if (runnerProfile !== DEFAULT_PROFILE) {
    await setFixtureAgentProfile(actor, agent.agentId, runnerProfile);
  }
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
    runnerProfile,
    agentDisplayName: AGENT_DISPLAY_NAME,
    agentInstructions,
    workflowSkillName,
    storageObjects,
    model,
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
  model: SupportedRunModel = fixture.model,
  clientEventId = randomUUID(),
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: fixture.agentId,
      prompt,
      model,
      clientEventId,
      ...(threadId === undefined ? {} : { threadId }),
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function withModelPricing(
  model: string,
  rows: readonly Omit<UsagePricingRow, "kind" | "provider">[],
): Promise<void> {
  const categories = rows.map((row) => {
    return row.category;
  });
  const previousRows = await deleteUsagePricingRows({
    kind: "model",
    provider: model,
    categories,
  });
  onTestFinished(async () => {
    await deleteUsagePricingRows({
      kind: "model",
      provider: model,
      categories,
    });
    await seedUsagePricingRows(previousRows);
  });
  await seedUsagePricingRows(
    rows.map((row) => {
      return { ...row, kind: "model", provider: model };
    }),
  );
}

async function unitPriceModelTokens(model: string): Promise<void> {
  await withModelPricing(
    model,
    [
      "tokens.input",
      "tokens.output",
      "tokens.cache_read",
      "tokens.cache_creation",
    ].map((category) => {
      return { category, unitPrice: 1, unitSize: 1 };
    }),
  );
}

async function usageRecordRow(
  actor: ApiTestUser,
  runId: string,
  threadId: string,
) {
  const response = await billing.readUsageRecord(actor);
  return response.body.rows.find((row) => {
    return row.runId === runId || row.threadId === threadId;
  });
}

function piEdgeUsageObservationKey(
  runId: string,
  sequenceNumber: number,
): string {
  return uuidv5(
    `${runId}:${runId}/${String(sequenceNumber)}`,
    PI_EDGE_USAGE_OBSERVATION_IDEMPOTENCY_NAMESPACE,
  );
}

async function readTranscript(runId: string) {
  const response = await accept(
    setupApp({ context, routes: webhooksAgentPiTranscriptRoutes })(
      webhookPiTranscriptContract,
    ).read({
      headers: webhooks.sandboxWebhookHeaders({ runId }),
      query: { runId, afterOrdinal: 0 },
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

async function expectQueuedPiEdgePromotion(args: {
  readonly fixture: PiEdgeFixture;
  readonly model: SupportedRunModel;
  readonly completionsUrl: string;
  readonly completionResponse: () => Response;
}): Promise<{ readonly runId: string; readonly threadId: string }> {
  const occupyingRun = await sendChatRun(
    args.fixture,
    "occupy the only concurrency slot",
    undefined,
    args.model,
  );
  expect(
    (await api.readRun(args.fixture.actor, occupyingRun.runId)).status,
  ).toBe("pending");

  await enablePiLoop(args.fixture);
  const modelStarted = createDeferredPromise<void>(context.signal);
  const releaseModel = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!releaseModel.settled()) {
      releaseModel.resolve();
    }
  });
  server.use(
    http.post(args.completionsUrl, async () => {
      modelStarted.resolve();
      await releaseModel.promise;
      return args.completionResponse();
    }),
  );

  const queuedRun = await sendChatRun(
    args.fixture,
    "start Pi after the queue picks this run",
    undefined,
    args.model,
  );
  expect((await api.readRun(args.fixture.actor, queuedRun.runId)).status).toBe(
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
        args.fixture.actor.userId,
        occupyingRun.runId,
        args.fixture.orgId,
      )}`,
    },
    [200],
    promotionController.signal,
  );
  expect(completed.status).toBe(200);
  await modelStarted.promise;
  expect(promotionController.signal.aborted).toBeTruthy();

  expect((await api.readRun(args.fixture.actor, queuedRun.runId)).status).toBe(
    "pending",
  );
  const standbyPoll = await api.requestPollRunner(
    true,
    {
      group: args.fixture.runnerGroup,
      supportedProfiles: [args.fixture.runnerProfile],
    },
    [200],
  );
  if (standbyPoll.status !== 200) {
    throw new Error("Expected promoted Pi standby poll to return 200");
  }
  expect(standbyPoll.body.job).toMatchObject({
    runId: queuedRun.runId,
    experimentalProfile: args.fixture.runnerProfile,
    piExecutionMode: "standby",
  });

  releaseModel.resolve();
  await flushWaitUntilForTest();
  expect((await api.readRun(args.fixture.actor, queuedRun.runId)).status).toBe(
    "completed",
  );
  return queuedRun;
}

describe("PiLoop edge turn", () => {
  it.each(NON_PI_MODELS)(
    "keeps %s on the standard runner path when PiLoop is enabled",
    async (model) => {
      const fixture = await piEdgeFixture({ provider: "vm0", model });
      await enablePiLoop(fixture);

      const run = await sendChatRun(
        fixture,
        "use the standard runner for this model",
      );
      expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
        "pending",
      );

      const poll = await api.pollRunner(fixture.runnerGroup);
      expect(poll.body.job?.runId).toBe(run.runId);
      expect(poll.body.job).not.toHaveProperty("piExecutionMode");
    },
  );

  it("uses the org gate, mounts Pi memory, and hands off the first tool to the Sandbox", async () => {
    const fixture = await piEdgeFixture();
    const legacyPrompt = "legacy context must not enter the Pi transcript";
    const legacy = await sendChatRun(fixture, legacyPrompt);

    expect((await api.readRun(fixture.actor, legacy.runId)).status).toBe(
      "pending",
    );
    const legacyPoll = await api.pollRunner(fixture.runnerGroup);
    expect(legacyPoll.body.job?.runId).toBe(legacy.runId);
    expect(legacyPoll.body.job).not.toHaveProperty("piExecutionMode");
    await api.requestCancelRun(fixture.actor, legacy.runId, [200]);

    await enablePiLoop(fixture);
    const modelStarted = createDeferredPromise<void>(context.signal);
    const releaseModel = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseModel.settled()) {
        releaseModel.resolve();
      }
    });
    const responsesRequests: unknown[] = [];
    const axiomIngestBodies: unknown[] = [];
    let modelCall = 0;
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        async ({ request }) => {
          axiomIngestBodies.push(await request.json());
          return HttpResponse.json({
            ingested: 1,
            failed: 0,
            processedBytes: 0,
          });
        },
      ),
      http.post(DEEPSEEK_RESPONSES_URL, async ({ request }) => {
        responsesRequests.push(await request.json());
        const currentCall = modelCall;
        modelCall += 1;
        if (currentCall === 0) {
          modelStarted.resolve();
          await releaseModel.promise;
          return deepseekToolSseStream({
            id: "read_skill_1",
            name: "read",
            arguments: {
              path: `${PI_SKILLS_ROOT}/${fixture.workflowSkillName}/SKILL.md`,
            },
            thinking: "inspect the pinned skill",
          });
        }
        return deepseekTextSseStream("follow-up answer", "follow-up reasoning");
      }),
    );

    const edgePrompt = "answer only this new message";
    const publishedBefore = context.mocks.ably.publish.mock.calls.length;
    const edge = await sendChatRun(fixture, edgePrompt);
    await modelStarted.promise;

    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: [fixture.runnerProfile],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job).toMatchObject({
      runId: edge.runId,
      experimentalProfile: fixture.runnerProfile,
      piExecutionMode: "standby",
    });
    expect(
      context.mocks.ably.publish.mock.calls
        .slice(publishedBefore)
        .some(([topic, payload]) => {
          const job = recordOf(payload);
          return (
            topic === "job" &&
            job?.runId === edge.runId &&
            job.profile === fixture.runnerProfile &&
            job.piExecutionMode === "standby"
          );
        }),
    ).toBeTruthy();
    const standbyContext = await api.claimRunnerJob(edge.runId);
    expect(standbyContext.piExecutionMode).toBe("standby");
    const duplicateStandbyClaim = await api.requestClaimRunnerJob(
      true,
      edge.runId,
      [404],
    );
    if (duplicateStandbyClaim.status !== 404) {
      throw new Error("Expected the duplicate standby claim to return 404");
    }
    expect(duplicateStandbyClaim.body.error.message).toBe("Run not found");
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

    expect(responsesRequests).toHaveLength(1);
    expect(responsesRequests[0]).toMatchObject({
      model: MODEL,
      input: [
        { role: "developer", content: piSystemPrompt },
        {
          role: "user",
          content: [{ type: "input_text", text: edgePrompt }],
        },
      ],
      stream: true,
      store: false,
      tools: expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          name: "read",
        }),
      ]),
    });
    expect(systemPromptFromRequest(responsesRequests[0])).toBe(piSystemPrompt);
    expect(JSON.stringify(responsesRequests)).not.toContain(legacyPrompt);
    const handoffTelemetry = axiomIngestBodies
      .flatMap((body) => {
        return Array.isArray(body) ? body : [];
      })
      .map(recordOf)
      .find((event) => {
        const eventData = recordOf(event?.eventData);
        return (
          event?.runId === edge.runId &&
          event?.eventType === "pi.message.completed" &&
          eventData?.messageId === `${edge.runId}/2`
        );
      });
    const handoffEventData = recordOf(handoffTelemetry?.eventData);
    expect(handoffEventData).toMatchObject({
      source: "api",
      messageId: `${edge.runId}/2`,
      role: "assistant",
      handoff: { from: "api", to: "sandbox" },
    });
    expect(handoffEventData?.message).toBeUndefined();
    expect(JSON.stringify(axiomIngestBodies)).not.toContain(
      "inspect the pinned skill",
    );

    // The first-round read hands off to the Sandbox: it executes the read
    // against its own filesystem and resumes the turn.
    const sandboxHeaders = webhooks.sandboxWebhookHeaders({
      runId: edge.runId,
    });
    const resumeEvents: AgentEventsBody = {
      runId: edge.runId,
      events: [
        {
          type: "pi.message.completed",
          sequenceNumber: 3,
          messageId: `${edge.runId}/3`,
          message: {
            role: "toolResult",
            toolCallId: deepseekToolCallId("read_skill_1"),
            toolName: "read",
            content: [
              {
                type: "text",
                text: `---\nname: ${fixture.workflowSkillName}\ndescription: fixture.\n---\n`,
              },
            ],
            details: {},
            isError: false,
            timestamp: 2,
          },
        },
        {
          type: "pi.message.completed",
          sequenceNumber: 4,
          messageId: `${edge.runId}/4`,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "edge reasoning" },
              { type: "text", text: "edge answer" },
            ],
            api: "openai-responses",
            provider: "deepseek",
            model: MODEL,
            usage: {
              input: 8,
              output: 4,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 12,
              cost: {
                input: 8,
                output: 4,
                cacheRead: 0,
                cacheWrite: 0,
                total: 12,
              },
            },
            stopReason: "stop",
            timestamp: 3,
          },
        },
      ],
    };
    await webhooks.requestAgentEvents(resumeEvents, sandboxHeaders, [200]);
    await webhooks.requestAgentComplete(
      { runId: edge.runId, exitCode: 0, lastEventSequence: 4 },
      { authorization: `Bearer ${standbyContext.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const transcript = await readTranscript(edge.runId);
    expect(transcript).toMatchObject({
      lastOrdinal: 4,
      hasMore: false,
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
                id: deepseekToolCallId("read_skill_1"),
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
            toolCallId: deepseekToolCallId("read_skill_1"),
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
    const settledStandbyClaim = await api.requestClaimRunnerJob(
      true,
      edge.runId,
      [404],
    );
    if (settledStandbyClaim.status !== 404) {
      throw new Error("Expected the settled standby claim to return 404");
    }
    expect(settledStandbyClaim.body.error.message).toBe(
      "Job not found in queue",
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
            topic === "pi-handoff" && recordOf(payload)?.runId === edge.runId
          );
        }),
    ).toBeTruthy();

    const followUpPrompt = "continue with the Pi-only history";
    const followUp = await sendChatRun(fixture, followUpPrompt, edge.threadId);
    await flushWaitUntilForTest();

    expect(responsesRequests).toHaveLength(2);
    expect(responsesRequests[1]).toMatchObject({
      model: MODEL,
      input: [
        { role: "developer", content: piSystemPrompt },
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({
          type: "reasoning",
        }),
        expect.objectContaining({
          type: "function_call",
          name: "read",
        }),
        expect.objectContaining({ type: "function_call_output" }),
        expect.objectContaining({ type: "message", role: "assistant" }),
        {
          role: "user",
          content: [{ type: "input_text", text: followUpPrompt }],
        },
      ],
      stream: true,
      store: false,
    });
    expect(JSON.stringify(responsesRequests[1])).not.toContain(legacyPrompt);
    const continuedTranscript = await readTranscript(followUp.runId);
    expect(continuedTranscript).toMatchObject({
      lastOrdinal: 6,
      hasMore: false,
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

  it("injects the MEMORY.md prefix and hands the complete file to the Sandbox", async () => {
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

    const responsesRequests: unknown[] = [];
    let modelCall = 0;
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, async ({ request }) => {
        responsesRequests.push(await request.json());
        const currentCall = modelCall;
        modelCall += 1;
        return currentCall === 0
          ? deepseekToolSseStream({
              id: "read_memory_1",
              name: "read",
              arguments: { path: `${PI_MEMORY_ROOT}/MEMORY.md` },
              thinking: "read the complete durable memory",
            })
          : deepseekTextSseStream("memory read", "memory considered");
      }),
    );

    const run = await sendChatRun(fixture, "use my durable memory");
    await flushWaitUntilForTest();

    expect(responsesRequests).toHaveLength(1);
    const systemPrompt = systemPromptFromRequest(responsesRequests[0]);
    if (systemPrompt === undefined) {
      throw new Error("Expected the Pi request to contain a system prompt");
    }
    expect(systemPrompt).toContain(`\`${PI_MEMORY_ROOT}\``);
    expect(systemPrompt).toContain(`\`${PI_MEMORY_ROOT}/MEMORY.md\``);
    expect(systemPrompt).toContain("### MEMORY.md prefix");
    expect(systemPrompt).toContain(visibleMemory);
    expect(systemPrompt).not.toContain(hiddenMemory);

    // The read of the complete MEMORY.md hands off to the Sandbox, which
    // reads the full file (including the private tail) on its own filesystem.
    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: [fixture.runnerProfile],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job?.runId).toBe(run.runId);
    const standbyContext = await api.claimRunnerJob(run.runId);
    expect(standbyContext.piExecutionMode).toBe("standby");
    expect(standbyContext.storageManifest?.storageMounts).toContainEqual(
      expect.objectContaining({
        name: "memory",
        mountPath: PI_MEMORY_ROOT,
      }),
    );

    const sandboxHeaders = webhooks.sandboxWebhookHeaders({ runId: run.runId });
    const resumeEvents: AgentEventsBody = {
      runId: run.runId,
      events: [
        {
          type: "pi.message.completed",
          sequenceNumber: 3,
          messageId: `${run.runId}/3`,
          message: {
            role: "toolResult",
            toolCallId: deepseekToolCallId("read_memory_1"),
            toolName: "read",
            content: [{ type: "text", text: memoryContent }],
            isError: false,
            timestamp: 2,
          },
        },
        {
          type: "pi.message.completed",
          sequenceNumber: 4,
          messageId: `${run.runId}/4`,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "memory considered" },
              { type: "text", text: "memory read" },
            ],
            stopReason: "stop",
            timestamp: 3,
          },
        },
      ],
    };
    await webhooks.requestAgentEvents(resumeEvents, sandboxHeaders, [200]);
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, lastEventSequence: 4 },
      { authorization: `Bearer ${standbyContext.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const transcribed = await readTranscript(run.runId);
    expect(JSON.stringify(transcribed)).toContain(hiddenMemory);
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "completed",
    );
  });

  it("bills each vm0-managed edge response once using normalized canonical-model usage", async () => {
    await unitPriceModelTokens(MODEL);
    const fixture = await piEdgeFixture({ provider: "vm0", model: MODEL });
    await enablePiLoop(fixture);
    const creditsBefore = (await billing.readBillingStatus(fixture.actor))
      .credits;
    const responsesRequests: unknown[] = [];
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, async ({ request }) => {
        responsesRequests.push(await request.json());
        return deepseekToolSseStream({
          id: "read_billing_1",
          name: "read",
          arguments: {
            path: `${PI_SKILLS_ROOT}/${fixture.workflowSkillName}/SKILL.md`,
          },
          thinking: "read before answering",
          usage: {
            input_tokens: 100,
            output_tokens: 11,
            total_tokens: 111,
            input_tokens_details: {
              cached_tokens: 20,
              cache_write_tokens: 5,
            },
            output_tokens_details: { reasoning_tokens: 4 },
          },
        });
      }),
    );

    const clientEventId = randomUUID();
    const run = await sendChatRun(
      fixture,
      "bill the managed edge response",
      undefined,
      fixture.model,
      clientEventId,
    );
    await flushWaitUntilForTest();

    expect(responsesRequests).toHaveLength(1);
    expect(responsesRequests[0]).toMatchObject({
      model: MODEL,
      stream: true,
      store: false,
    });

    // The read hands off to the Sandbox, which resumes and completes the run.
    const standbyContext = await api.claimRunnerJob(run.runId);
    expect(standbyContext.piExecutionMode).toBe("standby");
    const sandboxHeaders = webhooks.sandboxWebhookHeaders({ runId: run.runId });
    const resumeEvents: AgentEventsBody = {
      runId: run.runId,
      events: [
        {
          type: "pi.message.completed",
          sequenceNumber: 3,
          messageId: `${run.runId}/3`,
          message: {
            role: "toolResult",
            toolCallId: deepseekToolCallId("read_billing_1"),
            toolName: "read",
            content: [{ type: "text", text: "skill bytes\n" }],
            isError: false,
            timestamp: 2,
          },
        },
        {
          type: "pi.message.completed",
          sequenceNumber: 4,
          messageId: `${run.runId}/4`,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "billed reasoning" },
              { type: "text", text: "billed edge answer" },
            ],
            stopReason: "stop",
            timestamp: 3,
          },
        },
      ],
    };
    await webhooks.requestAgentEvents(resumeEvents, sandboxHeaders, [200]);
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, lastEventSequence: 4 },
      { authorization: `Bearer ${standbyContext.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const runState = await api.readRun(fixture.actor, run.runId);
    expect(runState.error).toBeUndefined();
    expect(runState.status).toBe("completed");
    await expect(
      usageRecordRow(fixture.actor, run.runId, run.threadId),
    ).resolves.toMatchObject({
      threadId: run.threadId,
      tokens: 111,
      credits: 111,
    });
    expect((await billing.readBillingStatus(fixture.actor)).credits).toBe(
      creditsBefore - 111,
    );
    const observationKeys = [piEdgeUsageObservationKey(run.runId, 2)];
    const observations = await readModelStatsObservations(
      context,
      observationKeys,
    );
    expect(observations).toStrictEqual(
      observationKeys.map((idempotencyKey) => {
        return { idempotencyKey, aggregatedAt: null };
      }),
    );

    const replay = await sendChatRun(
      fixture,
      "bill the managed edge response",
      run.threadId,
      fixture.model,
      clientEventId,
    );
    await flushWaitUntilForTest();
    expect(replay).toStrictEqual(run);
    expect(responsesRequests).toHaveLength(1);
    await expect(
      usageRecordRow(fixture.actor, run.runId, run.threadId),
    ).resolves.toMatchObject({ credits: 111 });
  });

  it("keeps BYOK API-edge usage out of vm0 billing", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    const creditsBefore = (await billing.readBillingStatus(fixture.actor))
      .credits;
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, () => {
        return deepseekTextSseStream("BYOK answer", "BYOK reasoning", {
          input_tokens: 40,
          output_tokens: 9,
          total_tokens: 49,
          input_tokens_details: { cached_tokens: 7 },
        });
      }),
    );

    const run = await sendChatRun(fixture, "do not charge vm0 for BYOK");
    await flushWaitUntilForTest();

    const runState = await api.readRun(fixture.actor, run.runId);
    expect(runState.error).toBeUndefined();
    expect(runState.status).toBe("completed");
    await expect(
      usageRecordRow(fixture.actor, run.runId, run.threadId),
    ).resolves.toBeUndefined();
    expect((await billing.readBillingStatus(fixture.actor)).credits).toBe(
      creditsBefore,
    );
    const idempotencyKey = piEdgeUsageObservationKey(run.runId, 2);
    await expect(
      readModelStatsObservations(context, [idempotencyKey]),
    ).resolves.toStrictEqual([{ idempotencyKey, aggregatedAt: null }]);
  });

  it("settles successful managed usage when the run later fails in the Sandbox", async () => {
    await unitPriceModelTokens(MODEL);
    const fixture = await piEdgeFixture({ provider: "vm0" });
    await enablePiLoop(fixture);
    const creditsBefore = (await billing.readBillingStatus(fixture.actor))
      .credits;
    const responsesRequests: unknown[] = [];
    let modelCall = 0;
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, async ({ request }) => {
        responsesRequests.push(await request.json());
        modelCall += 1;
        return deepseekToolSseStream({
          id: "read_before_failure_1",
          name: "read",
          arguments: {
            path: `${PI_SKILLS_ROOT}/${fixture.workflowSkillName}/SKILL.md`,
          },
          thinking: "this successful call must still be billed",
          usage: {
            input_tokens: 20,
            output_tokens: 3,
            total_tokens: 23,
          },
        });
      }),
    );

    const run = await sendChatRun(
      fixture,
      "bill the successful call before failure",
    );
    await flushWaitUntilForTest();

    expect(modelCall).toBe(1);
    expect(responsesRequests).toHaveLength(1);

    // The read hands off to the Sandbox. Its failure settles the run directly;
    // the edge's successful managed response must still be billed.
    const standbyContext = await api.claimRunnerJob(run.runId);
    const failed = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "the Sandbox failed after the handoff",
        lastEventSequence: 2,
      },
      { authorization: `Bearer ${standbyContext.sandboxToken}` },
      [200],
    );
    expect(failed.body).toStrictEqual({ success: true, status: "failed" });
    await flushWaitUntilForTest();

    expect((await api.readRun(fixture.actor, run.runId)).status).toBe("failed");
    await expect(
      usageRecordRow(fixture.actor, run.runId, run.threadId),
    ).resolves.toMatchObject({
      tokens: 23,
      credits: 23,
    });
    expect((await billing.readBillingStatus(fixture.actor)).credits).toBe(
      creditsBefore - 23,
    );
  });

  it("fails closed without projecting a managed response that has no usage", async () => {
    await unitPriceModelTokens(MODEL);
    const fixture = await piEdgeFixture({ provider: "vm0" });
    await enablePiLoop(fixture);
    const creditsBefore = (await billing.readBillingStatus(fixture.actor))
      .credits;
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, () => {
        return deepseekTextSseStream(
          "this answer must not be projected",
          "usage is missing",
          null,
        );
      }),
    );

    const prompt = "reject a managed success without usage";
    const run = await sendChatRun(fixture, prompt);
    await flushWaitUntilForTest();

    const standbyContext = await api.claimRunnerJob(run.runId);
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "Pi standby timed out waiting for a persisted tool call",
        lastEventSequence: 1,
      },
      { authorization: `Bearer ${standbyContext.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    expect((await api.readRun(fixture.actor, run.runId)).status).toBe("failed");
    await expect(readTranscript(run.runId)).resolves.toMatchObject({
      lastOrdinal: 1,
      hasMore: false,
      messages: [
        {
          ordinal: 1,
          role: "user",
          payload: {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        },
      ],
    });
    await expect(
      outputMessages(fixture.actor, run.threadId),
    ).resolves.toHaveLength(0);
    await expect(
      usageRecordRow(fixture.actor, run.runId, run.threadId),
    ).resolves.toBeUndefined();
    expect((await billing.readBillingStatus(fixture.actor)).credits).toBe(
      creditsBefore,
    );
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
      http.post(DEEPSEEK_RESPONSES_URL, async () => {
        modelStarted.resolve();
        await releaseModel.promise;
        return deepseekTextSseStream(
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

  it("starts and bills a concurrency-queued managed DeepSeek Pi run when promoted", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    await unitPriceModelTokens(MODEL);
    const fixture = await piEdgeFixture({ provider: "vm0" });
    const queuedRun = await expectQueuedPiEdgePromotion({
      fixture,
      model: fixture.model,
      completionsUrl: DEEPSEEK_RESPONSES_URL,
      completionResponse: () => {
        return deepseekTextSseStream(
          "promoted edge answer",
          "promoted edge reasoning",
          {
            input_tokens: 16,
            output_tokens: 3,
            total_tokens: 19,
            input_tokens_details: { cached_tokens: 2 },
          },
        );
      },
    });
    await expect(
      usageRecordRow(fixture.actor, queuedRun.runId, queuedRun.threadId),
    ).resolves.toMatchObject({
      tokens: 19,
      credits: 19,
    });
  });

  it("fails the run after preserving the user message when the model call fails", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, () => {
        return HttpResponse.json(
          { error: "provider unavailable" },
          { status: 503 },
        );
      }),
    );

    const prompt = "this model call will fail";
    const run = await sendChatRun(fixture, prompt);
    await flushWaitUntilForTest();

    const standbyContext = await api.claimRunnerJob(run.runId);
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "Pi standby timed out waiting for a persisted tool call",
        lastEventSequence: 2,
      },
      { authorization: `Bearer ${standbyContext.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    expect((await api.readRun(fixture.actor, run.runId)).status).toBe("failed");
    const transcript = await readTranscript(run.runId);
    expect(transcript).toMatchObject({
      lastOrdinal: 2,
      hasMore: false,
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

  it("bills edge and runner usage once across a sandbox handoff", async () => {
    await unitPriceModelTokens(MODEL);
    const fixture = await piEdgeFixture({ provider: "vm0" });
    await enablePiLoop(fixture);
    const creditsBefore = (await billing.readBillingStatus(fixture.actor))
      .credits;
    const responsesRequests: unknown[] = [];
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, async ({ request }) => {
        responsesRequests.push(await request.json());
        return deepseekToolSseStream({
          id: "bash_handoff_1",
          name: "bash",
          arguments: { command: "pwd" },
          thinking: "the sandbox must execute this",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 2 },
          },
        });
      }),
    );

    const prompt = "inspect the sandbox workspace";
    const publishedBefore = context.mocks.ably.publish.mock.calls.length;
    const run = await sendChatRun(fixture, prompt);
    await flushWaitUntilForTest();

    expect(responsesRequests).toHaveLength(1);
    expect((await api.readRun(fixture.actor, run.runId)).status).toBe(
      "pending",
    );
    const transcript = await readTranscript(run.runId);
    expect(transcript).toMatchObject({
      lastOrdinal: 2,
      hasMore: false,
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
              {
                type: "toolCall",
                id: deepseekToolCallId("bash_handoff_1"),
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
        supportedProfiles: [fixture.runnerProfile],
      },
      [200],
    );
    if (standbyPoll.status !== 200) {
      throw new Error("Expected Pi standby poll to return 200");
    }
    expect(standbyPoll.body.job?.runId).toBe(run.runId);
    const standbyContext = await api.claimRunnerJob(run.runId);
    expect(standbyContext.piSystemPrompt).toBe(
      systemPromptFromRequest(responsesRequests[0]),
    );
    expect(standbyContext.runSkillSnapshot?.digest).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );

    const sandboxHeaders = webhooks.sandboxWebhookHeaders({
      runId: run.runId,
    });
    const continuation: AgentEventsBody = {
      runId: run.runId,
      events: [
        {
          type: "pi.message.completed",
          sequenceNumber: 3,
          messageId: `${run.runId}/3`,
          message: {
            role: "toolResult",
            toolCallId: deepseekToolCallId("bash_handoff_1"),
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
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Sandbox resumed the handed-off tool call.",
              },
            ],
            stopReason: "stop",
            usage: {
              input: 9999,
              output: 9999,
              cacheRead: 9999,
              cacheWrite: 9999,
              totalTokens: 39_996,
              cost: {
                input: 9999,
                output: 9999,
                cacheRead: 9999,
                cacheWrite: 9999,
                total: 39_996,
              },
            },
            timestamp: 3,
          },
        },
      ],
    };
    await webhooks.requestAgentEvents(continuation, sandboxHeaders, [200]);

    const runnerUsage: AgentUsageEventBody = {
      runId: run.runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "model",
          provider: MODEL,
          category: "tokens.output",
          quantity: 5,
        },
      ],
    };
    const usageHeaders = {
      authorization: `Bearer ${standbyContext.sandboxToken}`,
    };
    await webhooks.requestAgentUsageEvent(runnerUsage, usageHeaders, [200]);
    await webhooks.requestAgentUsageEvent(runnerUsage, usageHeaders, [200]);
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
      lastOrdinal: 4,
      hasMore: false,
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
    await expect(
      usageRecordRow(fixture.actor, run.runId, run.threadId),
    ).resolves.toMatchObject({
      tokens: 20,
      credits: 20,
    });
    expect((await billing.readBillingStatus(fixture.actor)).credits).toBe(
      creditsBefore - 20,
    );
  });
});
