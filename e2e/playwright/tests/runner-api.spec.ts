import { randomUUID } from "node:crypto";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type {
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
  Page,
} from "@playwright/test";
import { expect, test } from "../fixtures";
import { signInWithClerkTestingHelper } from "../lib/auth";
import { authHeadersForToken } from "../lib/onboarding";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl } from "../playwright.config";

const apiUrl = requiredEnvironmentVariable("VM0_API_BACKEND_URL");
const appUrl = deriveAppUrl(apiUrl);
const simulatorUrl = requiredEnvironmentVariable("E2E_PROVIDER_SIMULATOR_URL");
const simulatorControlUrl = requiredEnvironmentVariable(
  "E2E_PROVIDER_SIMULATOR_CONTROL_URL",
);
const simulatorControlToken = requiredEnvironmentVariable(
  "E2E_PROVIDER_SIMULATOR_CONTROL_TOKEN",
);
const anthropicApiKey = requiredEnvironmentVariable("ANTHROPIC_API_KEY");
const openaiApiKey = requiredEnvironmentVariable("OPENAI_API_KEY");
const CLAUDE_MODEL = "claude-sonnet-4-6";
const CODEX_MODEL = "gpt-5.6-luna";
const CODEX_ALTERNATE_MODEL = "gpt-5.5";
const RUN_POLL_TIMEOUT_MS = 150_000;
const EVENT_POLL_TIMEOUT_MS = 45_000;
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

type AccountName = "runner" | "codex" | "claude";

type UserMessagePart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "file";
      readonly fileId: string;
      readonly filenameSnapshot: string;
      readonly contentType: string;
    };

interface AccountSession {
  readonly name: AccountName;
  readonly email: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly api: UserApi;
}

interface ChatRun {
  readonly account: AccountSession;
  readonly agentId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly clientEventId: string;
}

interface RunSnapshot {
  readonly status: string;
  readonly agentSessionId: string | undefined;
}

interface SimulatorEvent {
  readonly id: string;
  readonly kind: string;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface TrackedResource {
  readonly api: UserApi;
  readonly id: string;
}

class UserApi {
  private pinnedSessionToken: string | undefined;

  public constructor(public readonly page: Page) {}

  public async pinSessionToken(): Promise<void> {
    this.pinnedSessionToken = await this.currentSessionToken();
  }

  public async get(
    path: string,
    expectedStatuses: readonly number[] = [200],
  ): Promise<unknown> {
    return await this.request("GET", path, undefined, expectedStatuses, true);
  }

  public async getWithoutAuth(
    path: string,
    expectedStatuses: readonly number[] = [200],
  ): Promise<unknown> {
    return await this.request("GET", path, undefined, expectedStatuses, false);
  }

  public async post(
    path: string,
    data: unknown,
    expectedStatuses: readonly number[] = [200],
  ): Promise<unknown> {
    return await this.request("POST", path, data, expectedStatuses, true);
  }

  public async put(
    path: string,
    data: unknown,
    expectedStatuses: readonly number[] = [200],
  ): Promise<unknown> {
    return await this.request("PUT", path, data, expectedStatuses, true);
  }

  public async patch(
    path: string,
    data: unknown,
    expectedStatuses: readonly number[] = [200],
  ): Promise<unknown> {
    return await this.request("PATCH", path, data, expectedStatuses, true);
  }

  public async delete(
    path: string,
    expectedStatuses: readonly number[] = [204],
  ): Promise<unknown> {
    return await this.request(
      "DELETE",
      path,
      undefined,
      expectedStatuses,
      true,
    );
  }

  public async uploadText(
    filename: string,
    content: string,
  ): Promise<{
    readonly id: string;
    readonly filename: string;
    readonly contentType: string;
  }> {
    const contentType = "text/plain";
    const body = Buffer.from(content);
    const prepared = requireRecord(
      await this.post(
        "/api/zero/uploads/prepare",
        { filename, contentType, size: body.byteLength },
        [200],
      ),
      "upload prepare response",
    );
    const id = requireString(prepared, "id", "upload prepare response");
    const uploadUrl = requireString(
      prepared,
      "uploadUrl",
      "upload prepare response",
    );
    const uploadHeaders = requireStringRecord(
      prepared.uploadHeaders,
      "upload prepare response.uploadHeaders",
    );
    const uploadResponse = await this.page.request.put(uploadUrl, {
      data: body,
      headers: uploadHeaders,
    });
    await expectResponseStatus(uploadResponse, [200, 204], "upload file body");

    const completed = requireRecord(
      await this.post("/api/zero/uploads/complete", { id, contentType }, [200]),
      "upload complete response",
    );
    return {
      id: requireString(completed, "id", "upload complete response"),
      filename: requireString(
        completed,
        "filename",
        "upload complete response",
      ),
      contentType: requireString(
        completed,
        "contentType",
        "upload complete response",
      ),
    };
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    data: unknown,
    expectedStatuses: readonly number[],
    authenticated: boolean,
  ): Promise<unknown> {
    const headers = authenticated
      ? authHeadersForToken(await this.currentSessionToken())
      : undefined;
    const response = await this.page.request.fetch(
      new URL(path, apiUrl).toString(),
      {
        method,
        ...(headers ? { headers } : {}),
        ...(data === undefined ? {} : { data }),
        maxRedirects: 0,
      },
    );
    await expectResponseStatus(response, expectedStatuses, `${method} ${path}`);
    const text = await response.text();
    if (text.length === 0) {
      return null;
    }
    const body: unknown = JSON.parse(text);
    return body;
  }

  private async currentSessionToken(): Promise<string> {
    if (this.pinnedSessionToken) {
      return this.pinnedSessionToken;
    }
    await this.page.waitForFunction(
      () => Boolean(window.Clerk?.session),
      undefined,
      { timeout: 30_000 },
    );
    const token = await this.page.evaluate(async () => {
      return (
        (await window.Clerk?.session?.getToken({ skipCache: true })) ?? null
      );
    });
    if (!token) {
      throw new Error("Clerk session token unavailable for runner API E2E");
    }
    return token;
  }
}

class SimulatorControl {
  public constructor(private readonly request: APIRequestContext) {}

  public async reset(): Promise<void> {
    await this.fetch("POST", "/__control/reset", undefined, [200]);
  }

  public async events(): Promise<readonly SimulatorEvent[]> {
    const response = requireRecord(
      await this.fetch("GET", "/__control/events", undefined, [200]),
      "simulator events response",
    );
    return requireArray(
      response.events,
      "simulator events response.events",
    ).map((event, index) => parseSimulatorEvent(event, index));
  }

  public async waitForEvent(
    predicate: (event: SimulatorEvent) => boolean,
    description: string,
  ): Promise<SimulatorEvent> {
    const deadline = Date.now() + EVENT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const event = (await this.events()).find(predicate);
      if (event) {
        return event;
      }
      await pollInterval();
    }
    throw new Error(`Simulator did not observe ${description}`);
  }

  public async releaseGate(gate: string): Promise<void> {
    await this.fetch(
      "POST",
      `/__control/release?gate=${encodeURIComponent(gate)}`,
      undefined,
      [200],
    );
  }

  public async deliverWebhook(args: {
    readonly url: string;
    readonly rawBody: string;
    readonly secret: string;
    readonly timestamp?: number;
  }): Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly timestamp: number;
  }> {
    // Preview API deployments sit behind Vercel deployment protection, so the
    // simulated external delivery must carry the automation bypass header.
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const response = requireRecord(
      await this.fetch(
        "POST",
        "/__control/deliver-webhook",
        {
          ...args,
          ...(bypassSecret
            ? { headers: { "x-vercel-protection-bypass": bypassSecret } }
            : {}),
        },
        [200],
      ),
      "simulator webhook delivery response",
    );
    const rawResponseBody = requireString(
      response,
      "body",
      "simulator webhook delivery response",
    );
    const parsedBody: unknown = JSON.parse(rawResponseBody);
    return {
      status: requireNumber(
        response,
        "status",
        "simulator webhook delivery response",
      ),
      body: parsedBody,
      timestamp: requireNumber(
        response,
        "timestamp",
        "simulator webhook delivery response",
      ),
    };
  }

  private async fetch(
    method: "GET" | "POST",
    path: string,
    data: unknown,
    expectedStatuses: readonly number[],
  ): Promise<unknown> {
    const response = await this.request.fetch(
      new URL(path, simulatorControlUrl).toString(),
      {
        method,
        headers: { "x-control-token": simulatorControlToken },
        ...(data === undefined ? {} : { data }),
      },
    );
    await expectResponseStatus(
      response,
      expectedStatuses,
      `simulator ${method} ${path}`,
    );
    const text = await response.text();
    return text.length === 0 ? null : (JSON.parse(text) as unknown);
  }
}

let sessions: Readonly<Record<AccountName, AccountSession>> | undefined;
let simulator: SimulatorControl | undefined;
let agentIds: Readonly<Record<AccountName, string>> | undefined;
let claudeProviderId: string | undefined;
let codexProviderId: string | undefined;
let instructionMarker: string | undefined;
const trackedThreads: TrackedResource[] = [];
const trackedWorkflows: TrackedResource[] = [];
const trackedConnectors: TrackedResource[] = [];
const trackedAgents: TrackedResource[] = [];

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(360_000);
  const orgId = requiredEnvironmentVariable("E2E_CLERK_ORG_ID");
  const runner = await openAccount(
    browser,
    "runner",
    requiredEnvironmentVariable("E2E_RUNNER_EMAIL"),
    orgId,
  );
  await ensurePaidWorkspace(runner);
  await runner.api.post("/api/zero/onboarding/complete", {}, [200]);

  const codex = await openAccount(
    browser,
    "codex",
    requiredEnvironmentVariable("E2E_RUNNER_CODEX_EMAIL"),
    orgId,
  );
  const claude = await openAccount(
    browser,
    "claude",
    requiredEnvironmentVariable("E2E_RUNNER_CLAUDE_EMAIL"),
    orgId,
  );
  sessions = { runner, codex, claude };
  simulator = new SimulatorControl(runner.page.request);
  await simulator.reset();

  const createdAgentIds = {
    runner: await createAgent(runner, "Runner API E2E"),
    codex: await createAgent(codex, "Runner Real Codex E2E"),
    claude: await createAgent(claude, "Runner Real Claude E2E"),
  };
  agentIds = createdAgentIds;

  const claudeProvider = requireRecord(
    await runner.api.post(
      "/api/zero/model-providers",
      {
        type: "anthropic-api-key",
        secret: anthropicApiKey,
      },
      [200, 201],
    ),
    "Anthropic model provider response",
  );
  claudeProviderId = requireString(
    requireRecord(claudeProvider.provider, "Anthropic model provider"),
    "id",
    "Anthropic model provider",
  );
  expect(JSON.stringify(claudeProvider)).not.toContain(anthropicApiKey);

  const codexProvider = requireRecord(
    await runner.api.post(
      "/api/zero/model-providers",
      {
        type: "openai-api-key",
        secret: openaiApiKey,
      },
      [200, 201],
    ),
    "OpenAI model provider response",
  );
  codexProviderId = requireString(
    requireRecord(codexProvider.provider, "OpenAI model provider"),
    "id",
    "OpenAI model provider",
  );
  expect(JSON.stringify(codexProvider)).not.toContain(openaiApiKey);

  await setByokModelPolicies();
  await runner.api.put(
    "/api/zero/user-model-preference",
    { selectedModel: CLAUDE_MODEL },
    [200],
  );
  await claude.api.put(
    "/api/zero/user-model-preference",
    { selectedModel: CLAUDE_MODEL },
    [200],
  );
  await codex.api.put(
    "/api/zero/user-model-preference",
    { selectedModel: CODEX_MODEL },
    [200],
  );

  instructionMarker = `RUNNER_AGENT_INSTRUCTIONS_${Date.now()}`;
  await claude.api.put(
    `/api/zero/agents/${createdAgentIds.claude}/instructions`,
    { content: instructionMarker },
    [200],
  );
});

test.afterAll(async () => {
  const currentSessions = sessions;
  if (!currentSessions) {
    return;
  }

  await Promise.all(
    Object.values(currentSessions).map(async (session) => {
      await session.api.pinSessionToken();
    }),
  );

  for (const resource of [...trackedThreads].reverse()) {
    await resource.api.delete(
      `/api/zero/chat-threads/${resource.id}`,
      [204, 404],
    );
  }
  for (const resource of [...trackedWorkflows].reverse()) {
    await resource.api.delete(`/api/zero/workflows/${resource.id}`, [204, 404]);
  }
  for (const resource of [...trackedConnectors].reverse()) {
    await resource.api.delete(
      `/api/zero/custom-connectors/${resource.id}`,
      [204, 404],
    );
  }
  for (const resource of [...trackedAgents].reverse()) {
    await resource.api.delete(`/api/zero/agents/${resource.id}`, [204, 404]);
  }
  await currentSessions.runner.api.delete(
    "/api/zero/model-providers/openai-api-key",
    [204, 404],
  );
  await currentSessions.runner.api.delete(
    "/api/zero/model-providers/anthropic-api-key",
    [204, 404],
  );
  await Promise.all(
    Object.values(currentSessions).map(async (session) => {
      await session.context.close();
    }),
  );
});

test("[MODEL-01] selects Claude and Codex BYOK models and publishes structured events", async () => {
  const currentSessions = requireSessions();
  const currentAgents = requireAgentIds();

  const claudeMarker = `CLAUDE_BYOK_OK_${Date.now()}`;
  const claudeRun = await sendChatRun({
    account: currentSessions.claude,
    agentId: currentAgents.claude,
    model: CLAUDE_MODEL,
    parts: [
      {
        type: "text",
        text: `Reply with exactly ${claudeMarker}`,
      },
    ],
  });
  await waitForTerminalRun(claudeRun, "completed");
  const claudeOutput = await waitForThreadOutput(claudeRun, claudeMarker);
  expect(claudeOutput).not.toContain(anthropicApiKey);
  const claudeContext = await readRunContext(claudeRun);
  expect(claudeContext.secretNames).toContain("ZERO_TOKEN");
  expect(claudeContext.secretNames).not.toContain("ANTHROPIC_API_KEY");
  expect(JSON.stringify(claudeContext)).not.toContain(anthropicApiKey);
  const claudeEvents = await waitForAgentEvents(
    claudeRun,
    (value) => JSON.stringify(value).includes('"type":"result"'),
    "Claude structured result event",
  );
  expect(JSON.stringify(claudeEvents)).toContain('"type":"system"');

  const codexMarker = `CODEX_LUNA_OK_${Date.now()}`;
  const codexRun = await sendChatRun({
    account: currentSessions.codex,
    agentId: currentAgents.codex,
    model: CODEX_MODEL,
    parts: [{ type: "text", text: exactReplyPrompt(codexMarker) }],
  });
  await waitForTerminalRun(codexRun, "completed");
  await waitForThreadOutput(codexRun, codexMarker);
  const codexEvents = await waitForAgentEvents(
    codexRun,
    (value) => JSON.stringify(value).includes('"turn.completed"'),
    "Codex structured completion event",
  );
  const serializedCodexEvents = JSON.stringify(codexEvents);
  expect(serializedCodexEvents).toContain('"thread.started"');
  expect(serializedCodexEvents).toContain('"turn.started"');

  await currentSessions.codex.api.put(
    "/api/zero/user-model-preference",
    { selectedModel: CODEX_ALTERNATE_MODEL },
    [200],
  );
  const alternateMarker = `CODEX_GPT55_OK_${Date.now()}`;
  const alternateRun = await sendChatRun({
    account: currentSessions.codex,
    agentId: currentAgents.codex,
    model: CODEX_ALTERNATE_MODEL,
    parts: [{ type: "text", text: exactReplyPrompt(alternateMarker) }],
  });
  await waitForTerminalRun(alternateRun, "completed");
  await waitForThreadOutput(alternateRun, alternateMarker);
  const alternateContext = await readRunContext(alternateRun);
  const alternateEnvironment = requireStringRecord(
    alternateContext.environment,
    "alternate Codex run context.environment",
  );
  expect(alternateEnvironment.OPENAI_MODEL).toBe(CODEX_ALTERNATE_MODEL);
  await currentSessions.codex.api.put(
    "/api/zero/user-model-preference",
    { selectedModel: CODEX_MODEL },
    [200],
  );
});

test("[FILES-01] mounts multiple and empty upload attachments across continuation", async () => {
  const currentSessions = requireSessions();
  const account = currentSessions.runner;
  const contentMarker = `ATTACHMENT_CONTENT_${Date.now()}`;
  const contentFile = await account.api.uploadText(
    `runner-content-${randomUUID()}.txt`,
    `${contentMarker}\n`,
  );
  const emptyFile = await account.api.uploadText(
    `runner-empty-${randomUUID()}.txt`,
    "",
  );
  const outputMarker = `ATTACHMENTS_OK_${Date.now()}`;
  const first = await sendChatRun({
    account,
    agentId: requireAgentIds().runner,
    model: CLAUDE_MODEL,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          [
            `zero web download-file '${contentFile.id}' -o /tmp/content.txt`,
            `zero web download-file '${emptyFile.id}' -o /tmp/empty.txt`,
            `grep -F '${contentMarker}' /tmp/content.txt`,
            "test ! -s /tmp/empty.txt",
            `printf '${outputMarker}\\n'`,
          ].join(" && "),
        ),
      },
      {
        type: "file",
        fileId: contentFile.id,
        filenameSnapshot: contentFile.filename,
        contentType: contentFile.contentType,
      },
      {
        type: "file",
        fileId: emptyFile.id,
        filenameSnapshot: emptyFile.filename,
        contentType: emptyFile.contentType,
      },
    ],
  });
  await waitForTerminalRun(first, "completed");
  const firstOutput = await waitForThreadOutput(first, outputMarker);
  expect(firstOutput).toContain(contentMarker);
  const firstContext = await readRunContext(first);
  expect(firstContext.runId).toBe(first.runId);
  expect(Array.isArray(firstContext.volumes)).toBe(true);

  const continuationMarker = `ATTACHMENT_CONTINUED_${Date.now()}`;
  const continuation = await sendChatRun({
    account,
    agentId: first.agentId,
    threadId: first.threadId,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          `grep -F '${contentMarker}' /tmp/content.txt && printf '${continuationMarker}\\n'`,
        ),
      },
    ],
  });
  await waitForTerminalRun(continuation, "completed");
  await waitForThreadOutput(continuation, continuationMarker);
  const artifacts = requireRecord(
    await account.api.get(
      `/api/zero/chat-threads/${first.threadId}/artifacts`,
      [200],
    ),
    "chat thread artifacts response",
  );
  expect(Array.isArray(artifacts.runs)).toBe(true);
});

test("[FILES-02] updates, mounts, continues, and forks workflow supplementary files", async () => {
  const currentSessions = requireSessions();
  const account = currentSessions.runner;
  const sourceAgentId = requireAgentIds().runner;
  const workflowSlug = `runner-files-${randomUUID().slice(0, 8)}`;
  const created = requireRecord(
    await account.api.post(
      "/api/zero/workflows",
      {
        agentId: sourceAgentId,
        name: workflowSlug,
        instruction: "Use the supplementary files as durable workflow input.",
        files: [
          { path: "version.txt", content: "workflow-version-one" },
          { path: "empty.txt", content: "" },
          { path: "nested/second.txt", content: "second-file" },
        ],
      },
      [201],
    ),
    "create workflow response",
  );
  const workflowId = requireString(created, "id", "create workflow response");
  trackedWorkflows.push({ api: account.api, id: workflowId });
  const detail = requireRecord(
    await account.api.get(`/api/zero/workflows/${workflowId}`, [200]),
    "workflow detail response",
  );
  expect(detail.fileContents).toEqual(
    expect.arrayContaining([
      { path: "version.txt", content: "workflow-version-one" },
      { path: "empty.txt", content: "" },
      { path: "nested/second.txt", content: "second-file" },
    ]),
  );

  const mountPath = `$HOME/.claude/skills/${workflowSlug}`;
  const firstMarker = `WORKFLOW_V1_OK_${Date.now()}`;
  const first = await sendChatRun({
    account,
    agentId: sourceAgentId,
    model: CLAUDE_MODEL,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          [
            `grep -F 'workflow-version-one' \"${mountPath}/version.txt\"`,
            `test ! -s \"${mountPath}/empty.txt\"`,
            `grep -F 'second-file' \"${mountPath}/nested/second.txt\"`,
            `printf '${firstMarker}\\n'`,
          ].join(" && "),
        ),
      },
    ],
  });
  await waitForTerminalRun(first, "completed");
  await waitForThreadOutput(first, firstMarker);
  const firstContext = await readRunContext(first);
  expect(JSON.stringify(firstContext.volumes)).toContain(
    `/home/user/.claude/skills/${workflowSlug}`,
  );

  const updated = requireRecord(
    await account.api.patch(
      `/api/zero/workflows/${workflowId}`,
      {
        instruction: "Use the updated supplementary files.",
        files: [
          { path: "version.txt", content: "workflow-version-two" },
          { path: "empty.txt", content: "" },
          { path: "nested/second.txt", content: "second-file-updated" },
          { path: "third.txt", content: "third-file" },
        ],
      },
      [200],
    ),
    "update workflow response",
  );
  expect(updated.fileContents).toEqual(
    expect.arrayContaining([
      { path: "version.txt", content: "workflow-version-two" },
      { path: "third.txt", content: "third-file" },
    ]),
  );

  const secondMarker = `WORKFLOW_V2_OK_${Date.now()}`;
  const second = await sendChatRun({
    account,
    agentId: sourceAgentId,
    threadId: first.threadId,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          [
            `grep -F 'workflow-version-two' \"${mountPath}/version.txt\"`,
            `grep -F 'third-file' \"${mountPath}/third.txt\"`,
            `printf '${secondMarker}\\n'`,
          ].join(" && "),
        ),
      },
    ],
  });
  await waitForTerminalRun(second, "completed");
  await waitForThreadOutput(second, secondMarker);

  const forkAgentId = await createAgent(account, "Runner Workflow Fork E2E");
  const copied = requireRecord(
    await account.api.post(
      `/api/zero/workflows/${workflowId}/copy`,
      { toAgentId: forkAgentId },
      [201],
    ),
    "copy workflow response",
  );
  const copiedWorkflowId = requireString(
    copied,
    "id",
    "copy workflow response",
  );
  trackedWorkflows.push({ api: account.api, id: copiedWorkflowId });
  const copiedDetail = requireRecord(
    await account.api.get(`/api/zero/workflows/${copiedWorkflowId}`, [200]),
    "copied workflow detail response",
  );
  expect(JSON.stringify(copiedDetail.fileContents)).toContain(
    "workflow-version-two",
  );
  const forkMarker = `WORKFLOW_FORK_OK_${Date.now()}`;
  const forkRun = await sendChatRun({
    account,
    agentId: forkAgentId,
    model: CLAUDE_MODEL,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          `grep -F 'workflow-version-two' \"${mountPath}/version.txt\" && printf '${forkMarker}\\n'`,
        ),
      },
    ],
  });
  const forkSnapshot = await waitForTerminalRun(forkRun, "completed");
  await waitForThreadOutput(forkRun, forkMarker);
  const sourceSnapshot = await readRunSnapshot(second);
  expect(forkSnapshot.agentSessionId).not.toBe(sourceSnapshot.agentSessionId);
});

test("[AGENT-01] applies public agent instructions to the Claude sandbox", async () => {
  const currentSessions = requireSessions();
  const currentInstructionMarker = requireTestValue(
    instructionMarker,
    "instructionMarker",
  );
  const currentAgentId = requireAgentIds().claude;
  const instructions = requireRecord(
    await currentSessions.claude.api.get(
      `/api/zero/agents/${currentAgentId}/instructions`,
      [200],
    ),
    "agent instructions response",
  );
  expect(instructions.content).toBe(currentInstructionMarker);
  const outputMarker = `AGENT_INSTRUCTIONS_OK_${Date.now()}`;
  const run = await sendChatRun({
    account: currentSessions.claude,
    agentId: currentAgentId,
    model: CLAUDE_MODEL,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          `grep -F '${currentInstructionMarker}' \"$HOME/.claude/CLAUDE.md\" && printf '${outputMarker}\\n'`,
        ),
      },
    ],
  });
  await waitForTerminalRun(run, "completed");
  await waitForThreadOutput(run, outputMarker);
  const context = await readRunContext(run);
  expect(context.cliAgentType).toBe("claude-code");
});

test("[PREF-01][CONNECTOR-01] refreshes connector values and secrets with redaction", async () => {
  const currentSessions = requireSessions();
  const account = currentSessions.claude;
  const currentAgentId = requireAgentIds().claude;
  const control = requireSimulator();
  await control.reset();
  const firstSecret = `connector-first-${randomUUID()}`;
  const secondSecret = `connector-second-${randomUUID()}`;
  const connector = await createManualConnector(account, {
    displayName: `Runner Dynamic Connector ${Date.now()}`,
    prefixTemplates: [`${simulatorUrl}/tenant/{{variables.workspace}}/`],
    fields: [
      {
        key: "token",
        label: "API token",
        kind: "secret",
        required: true,
      },
      {
        key: "workspace",
        label: "Workspace",
        kind: "variable",
        required: true,
      },
    ],
    headerInjections: [
      { name: "x-runner-secret", valueTemplate: "{{secrets.token}}" },
    ],
    queryInjections: [{ name: "api_key", valueTemplate: "{{secrets.token}}" }],
  });
  await account.api.put(
    `/api/zero/custom-connectors/${connector.id}/values`,
    {
      values: [
        { key: "token", kind: "secret", value: firstSecret },
        { key: "workspace", kind: "variable", value: "alpha" },
      ],
    },
    [200],
  );
  const connected = requireRecord(
    await account.api.get(`/api/zero/custom-connectors/${connector.id}`, [200]),
    "connected custom connector response",
  );
  expect(connected.connected).toBe(true);
  expect(JSON.stringify(connected)).not.toContain(firstSecret);
  await account.api.put(
    `/api/zero/agents/${currentAgentId}/custom-connectors`,
    { enabledIds: [connector.id] },
    [200],
  );
  await account.api.post(
    "/api/zero/user-preferences",
    { timezone: "Asia/Tokyo" },
    [200],
  );

  const gate = `secret-refresh-${randomUUID()}`;
  const outputMarker = `CONNECTOR_REFRESH_OK_${Date.now()}`;
  const run = await sendChatRun({
    account,
    agentId: currentAgentId,
    model: CLAUDE_MODEL,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          [
            `curl -fsS '${simulatorUrl}/tenant/alpha/gate?gate=${gate}' >/tmp/gate.json`,
            `curl -fsS '${simulatorUrl}/tenant/beta/echo' >/tmp/echo.json`,
            `printf 'TZ=%s\\n${outputMarker}\\n' \"$TZ\"`,
          ].join(" && "),
        ),
      },
    ],
  });
  const firstRequest = await control.waitForEvent(
    (event) => event.path === "/tenant/alpha/gate",
    "the first dynamic connector request",
  );
  expect(firstRequest.headers["x-runner-secret"]).toBe(firstSecret);
  expect(firstRequest.query.api_key).toBe(firstSecret);

  await account.api.put(
    `/api/zero/custom-connectors/${connector.id}/values`,
    {
      values: [
        { key: "token", kind: "secret", value: secondSecret },
        { key: "workspace", kind: "variable", value: "beta" },
      ],
    },
    [200],
  );
  await control.releaseGate(gate);
  await waitForTerminalRun(run, "completed");
  const output = await waitForThreadOutput(run, outputMarker);
  expect(output).toContain("TZ=Asia/Tokyo");
  expect(output).not.toContain(firstSecret);
  expect(output).not.toContain(secondSecret);
  const secondRequest = await control.waitForEvent(
    (event) => event.path === "/tenant/beta/echo",
    "the refreshed dynamic connector request",
  );
  expect(secondRequest.headers["x-runner-secret"]).toBe(secondSecret);
  expect(secondRequest.query.api_key).toBe(secondSecret);
  const context = await readRunContext(run);
  const environment = requireStringRecord(
    context.environment,
    "connector run context.environment",
  );
  expect(environment.TZ).toBe("Asia/Tokyo");
  expect(JSON.stringify(context)).not.toContain(firstSecret);
  expect(JSON.stringify(context)).not.toContain(secondSecret);

  const legacySecret = `legacy-${randomUUID()}`;
  const legacy = requireRecord(
    await requireSessions().runner.api.post(
      "/api/zero/custom-connectors",
      {
        displayName: `Runner Legacy Secret ${Date.now()}`,
        prefixes: [`${simulatorUrl}/legacy/`],
        headerName: "authorization",
        headerTemplate: "Bearer {{secret}}",
      },
      [201],
    ),
    "create legacy custom connector response",
  );
  const legacyId = requireString(
    legacy,
    "id",
    "create legacy custom connector response",
  );
  trackedConnectors.push({ api: requireSessions().runner.api, id: legacyId });
  await requireSessions().runner.api.put(
    `/api/zero/custom-connectors/${legacyId}/secret`,
    { value: legacySecret },
    [204],
  );
  const updatedLegacy = requireRecord(
    await requireSessions().runner.api.put(
      `/api/zero/custom-connectors/${legacyId}`,
      {
        displayName: "Runner Legacy Secret Updated",
        prefixTemplates: [`${simulatorUrl}/legacy/`],
        fields: [],
        headerInjections: [
          { name: "authorization", valueTemplate: "Bearer {{secret}}" },
        ],
        queryInjections: [],
        authMode: "manual",
      },
      [200],
    ),
    "update legacy custom connector response",
  );
  expect(updatedLegacy.displayName).toBe("Runner Legacy Secret Updated");
  expect(JSON.stringify(updatedLegacy)).not.toContain(legacySecret);
  await requireSessions().runner.api.delete(
    `/api/zero/custom-connectors/${legacyId}`,
    [204],
  );
});

test("[CONNECTOR-02] refreshes manual permission grants and reports attribution", async () => {
  const account = requireSessions().claude;
  const currentAgentId = requireAgentIds().claude;
  const control = requireSimulator();
  await control.reset();
  const connectorSecret = `permission-${randomUUID()}`;
  const connector = await createManualConnector(account, {
    displayName: `Runner Permission Connector ${Date.now()}`,
    prefixTemplates: [`${simulatorUrl}/slack/`],
    fields: [
      {
        key: "token",
        label: "API token",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      { name: "authorization", valueTemplate: "Bearer {{secrets.token}}" },
    ],
    queryInjections: [],
    permissionBundleRef: "builtin:slack@1",
  });
  await account.api.put(
    `/api/zero/custom-connectors/${connector.id}/values`,
    {
      values: [{ key: "token", kind: "secret", value: connectorSecret }],
    },
    [200],
  );
  const bundle = requireRecord(
    await account.api.get(
      `/api/zero/custom-connectors/${connector.id}/permissions`,
      [200],
    ),
    "custom connector permission bundle",
  );
  expect(JSON.stringify(bundle.permissions)).toContain("chat:write");
  await account.api.put(
    `/api/zero/agents/${currentAgentId}/custom-connectors`,
    {
      grants: [
        { customConnectorId: connector.id, permissionNames: ["chat:write"] },
      ],
    },
    [200],
  );
  await applyPermissionGrant(account, currentAgentId, connector.slug, "allow");

  const gate = `permission-refresh-${randomUUID()}`;
  const outputMarker = `PERMISSION_REFRESH_OK_${Date.now()}`;
  const run = await sendChatRun({
    account,
    agentId: currentAgentId,
    model: CLAUDE_MODEL,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          [
            `first_status=$(curl -sS -o /tmp/first.json -w '%{http_code}' -X POST '${simulatorUrl}/slack/api/chat.postMessage?gate=${gate}')`,
            `second_status=$(curl -sS -o /tmp/second.json -w '%{http_code}' -X POST '${simulatorUrl}/slack/api/chat.postMessage')`,
            `printf 'FIRST=%s SECOND=%s\\n${outputMarker}\\n' \"$first_status\" \"$second_status\"`,
          ].join(" && "),
        ),
      },
    ],
  });
  const firstRequest = await control.waitForEvent(
    (event) =>
      event.path === "/slack/api/chat.postMessage" && event.query.gate === gate,
    "the permission-gated connector request",
  );
  expect(firstRequest.headers.authorization).toBe(`Bearer ${connectorSecret}`);
  await applyPermissionGrant(account, currentAgentId, connector.slug, "deny");
  await control.releaseGate(gate);
  await waitForTerminalRun(run, "completed");
  const output = await waitForThreadOutput(run, outputMarker);
  expect(output).toContain("FIRST=200");
  expect(output).not.toContain(connectorSecret);
  const externalWrites = (await control.events()).filter((event) => {
    return event.path === "/slack/api/chat.postMessage";
  });
  expect(externalWrites).toHaveLength(1);

  const networkLogs = await waitForApiPayload(
    account,
    `/api/zero/runs/${run.runId}/network?limit=500&order=asc`,
    (value) => {
      const serialized = JSON.stringify(value);
      return (
        serialized.includes('"action":"DENY"') &&
        serialized.includes(connector.id.replaceAll("-", ""))
      );
    },
    "custom connector permission network log",
  );
  const serializedLogs = JSON.stringify(networkLogs);
  expect(serializedLogs).toContain('"action":"ALLOW"');
  expect(serializedLogs).toContain('"action":"DENY"');
  expect(serializedLogs).toContain('"firewall_billable":false');
  expect(serializedLogs).not.toContain(connectorSecret);
});

test("[CONNECTOR-03] completes OAuth callback and refreshes a rejected token", async () => {
  const account = requireSessions().claude;
  const currentAgentId = requireAgentIds().claude;
  const control = requireSimulator();
  await control.reset();
  const oauthClientSecret = `oauth-client-${randomUUID()}`;
  const connector = requireRecord(
    await requireSessions().runner.api.post(
      "/api/zero/custom-connectors",
      {
        displayName: `Runner OAuth Connector ${Date.now()}`,
        prefixTemplates: [`${simulatorUrl}/oauth/`],
        fields: [],
        headerInjections: [
          {
            name: "authorization",
            valueTemplate: "Bearer {{oauth.access_token}}",
          },
        ],
        queryInjections: [],
        authMode: "oauth",
        oauthConfig: {
          providerAdapter: "standard",
          clientId: "runner-api-client",
          clientSecret: oauthClientSecret,
          authorizationUrl: `${simulatorUrl}/oauth/authorize`,
          tokenUrl: `${simulatorUrl}/oauth/token`,
          tokenEndpointAuthMethod: "client_secret_post",
          pkceMethod: "none",
          scopes: ["read"],
          authorizationParams: {},
        },
      },
      [201],
    ),
    "create OAuth custom connector response",
  );
  const connectorId = requireString(
    connector,
    "id",
    "create OAuth custom connector response",
  );
  trackedConnectors.push({
    api: requireSessions().runner.api,
    id: connectorId,
  });
  expect(JSON.stringify(connector)).not.toContain(oauthClientSecret);
  const started = requireRecord(
    await account.api.post(
      `/api/zero/custom-connectors/${connectorId}/oauth2/start`,
      { agentId: currentAgentId },
      [200],
    ),
    "start custom connector OAuth response",
  );
  const authorizationUrl = requireString(
    started,
    "authorizationUrl",
    "start custom connector OAuth response",
  );
  const authorizationResponse = await account.page.request.get(
    authorizationUrl,
    { maxRedirects: 0 },
  );
  await expectResponseStatus(
    authorizationResponse,
    [302],
    "external OAuth authorization",
  );
  const redirectLocation = authorizationResponse.headers().location;
  if (!redirectLocation) {
    throw new Error("External OAuth authorization did not return a callback");
  }
  const externalCallback = new URL(redirectLocation);
  const code = requiredSearchParameter(externalCallback, "code");
  const state = requiredSearchParameter(externalCallback, "state");
  const callback = requireRecord(
    await account.api.getWithoutAuth(
      `/api/zero/custom-connectors/oauth2/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&responseMode=json`,
      [200],
    ),
    "custom connector OAuth callback response",
  );
  expect(callback.status).toBe("success");
  const connected = requireRecord(
    await account.api.get(`/api/zero/custom-connectors/${connectorId}`, [200]),
    "connected OAuth connector response",
  );
  expect(connected.connected).toBe(true);
  expect(JSON.stringify(connected)).not.toContain("oauth-initial-access-token");
  expect(JSON.stringify(connected)).not.toContain("oauth-refresh-token");

  const outputMarker = `OAUTH_REFRESH_OK_${Date.now()}`;
  const run = await sendChatRun({
    account,
    agentId: currentAgentId,
    model: CLAUDE_MODEL,
    parts: [
      {
        type: "text",
        text: shellCommandPrompt(
          `curl -fsS '${simulatorUrl}/oauth/resource' >/tmp/oauth.json && grep -F 'refreshed' /tmp/oauth.json && printf '${outputMarker}\\n'`,
        ),
      },
    ],
  });
  await waitForTerminalRun(run, "completed");
  await waitForThreadOutput(run, outputMarker);
  const oauthEvents = await control.events();
  const tokenRequests = oauthEvents.filter(
    (event) => event.path === "/oauth/token",
  );
  expect(
    tokenRequests.some((event) => event.body.includes("authorization_code")),
  ).toBe(true);
  expect(
    tokenRequests.some((event) => event.body.includes("refresh_token")),
  ).toBe(true);
  const resourceAuthorizations = oauthEvents
    .filter((event) => event.path === "/oauth/resource")
    .map((event) => event.headers.authorization);
  expect(resourceAuthorizations).toEqual(
    expect.arrayContaining([
      "Bearer oauth-initial-access-token",
      "Bearer oauth-refreshed-access-token",
    ]),
  );
});

test("[CODEX-01] exercises public device auth and typed paste validation", async () => {
  const account = requireSessions().codex;
  const started = requireRecord(
    await account.api.post(
      "/api/zero/model-providers/codex/device-auth/sessions",
      { scope: "personal" },
      [200],
    ),
    "Codex device auth start response",
  );
  expect(started.type).toBe("codex");
  expect(started.status).toBe("pending");
  expect(
    requireString(started, "browserUrl", "Codex device auth start response"),
  ).toMatch(/^https:\/\/auth\.openai\.com\//);
  const sessionToken = requireString(
    started,
    "sessionToken",
    "Codex device auth start response",
  );
  const cancelled = requireRecord(
    await account.api.post(
      "/api/zero/model-providers/codex/device-auth/sessions/cancel",
      { sessionToken },
      [200],
    ),
    "Codex device auth cancel response",
  );
  expect(cancelled.status).toBe("cancelled");

  const malformed = requireRecord(
    await pasteCodexAuthJson(account, "{not-json", [400]),
    "malformed Codex paste response",
  );
  expect(errorCode(malformed)).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
  const missingRefresh = requireRecord(
    await pasteCodexAuthJson(
      account,
      JSON.stringify({
        tokens: {
          access_token: unsignedJwt({ exp: futureEpochSeconds() }),
          account_id: "runner-missing-refresh",
          id_token: codexIdToken("plus"),
        },
      }),
      [400],
    ),
    "missing refresh token Codex paste response",
  );
  expect(errorCode(missingRefresh)).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
  const freePlan = requireRecord(
    await pasteCodexAuthJson(account, codexAuthJson("free"), [400]),
    "free plan Codex paste response",
  );
  expect(errorCode(freePlan)).toBe("CODEX_FREE_PLAN_REJECTED");
});

test("[CODEX-02] creates a paste provider, runs chat, and keeps tokens isolated", async () => {
  const currentSessions = requireSessions();
  const account = currentSessions.codex;
  const accessToken = unsignedJwt({
    exp: futureEpochSeconds(),
    marker: `access-${randomUUID()}`,
  });
  const refreshToken = `refresh-${randomUUID()}-${randomUUID()}`;
  const idToken = codexIdToken("plus");
  const rawAuthJson = JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: "untrusted-plain-account-id",
      id_token: idToken,
    },
  });
  const pasted = requireRecord(
    await pasteCodexAuthJson(account, rawAuthJson, [200, 201]),
    "valid Codex paste response",
  );
  const provider = requireRecord(pasted.provider, "valid Codex paste provider");
  expect(provider.type).toBe("codex-oauth-token");
  expect(provider.needsReconnect).toBe(false);
  expect(JSON.stringify(pasted)).not.toContain(accessToken);
  expect(JSON.stringify(pasted)).not.toContain(refreshToken);
  expect(JSON.stringify(pasted)).not.toContain(idToken);

  await setCodexSubscriptionModelPolicies();
  await account.api.put(
    "/api/zero/user-model-preference",
    { selectedModel: CODEX_MODEL },
    [200],
  );
  const outputMarker = `CODEX_PASTE_RUN_OK_${Date.now()}`;
  const run = await sendChatRun({
    account,
    agentId: requireAgentIds().codex,
    model: CODEX_MODEL,
    parts: [{ type: "text", text: exactReplyPrompt(outputMarker) }],
  });
  await waitForTerminalRun(run, "completed");
  const output = await waitForThreadOutput(run, outputMarker);
  const context = await readRunContext(run);
  const serializedPublicSurfaces = `${output}\n${JSON.stringify(context)}`;
  expect(context.secretNames).toEqual(
    expect.arrayContaining([
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_REFRESH_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_ID_TOKEN",
    ]),
  );
  expect(serializedPublicSurfaces).not.toContain(accessToken);
  expect(serializedPublicSurfaces).not.toContain(refreshToken);
  expect(serializedPublicSurfaces).not.toContain(idToken);
});

test("[INGRESS-01] dispatches a signed external webhook through a real workflow run", async () => {
  const account = requireSessions().codex;
  const workflowName = `ingress-${randomUUID().slice(0, 8)}`;
  const workflow = requireRecord(
    await account.api.post(
      "/api/zero/workflows",
      {
        agentId: requireAgentIds().codex,
        name: workflowName,
        instruction: "Acknowledge the external webhook event.",
        files: [{ path: "ingress.txt", content: "real-webhook-dispatch" }],
      },
      [201],
    ),
    "create ingress workflow response",
  );
  const workflowId = requireString(
    workflow,
    "id",
    "create ingress workflow response",
  );
  trackedWorkflows.push({ api: account.api, id: workflowId });
  const chatThread = requireRecord(
    await account.api.post(
      `/api/zero/workflows/${workflowId}/chat-thread`,
      undefined,
      [200],
    ),
    "workflow chat thread response",
  );
  const threadId = requireString(
    chatThread,
    "chatThreadId",
    "workflow chat thread response",
  );
  trackedThreads.push({ api: account.api, id: threadId });
  const automation = requireRecord(
    await account.api.post(
      `/api/zero/workflows/${workflowId}/automations`,
      { kind: "event", eventType: "webhook-received" },
      [201],
    ),
    "create workflow webhook automation response",
  );
  const automationId = requireString(
    automation,
    "id",
    "create workflow webhook automation response",
  );
  const webhookCredentials =
    typeof automation.webhookUrl === "string" &&
    typeof automation.webhookSecret === "string"
      ? automation
      : requireRecord(
          await account.api.post(
            `/api/zero/workflow-automations/${automationId}/webhook-secret`,
            undefined,
            [200],
          ),
          "reveal workflow webhook response",
        );
  const webhookUrl = requireString(
    webhookCredentials,
    "webhookUrl",
    "workflow webhook credentials",
  );
  const webhookSecret = requireString(
    webhookCredentials,
    "webhookSecret",
    "workflow webhook credentials",
  );
  const rawBody = JSON.stringify({
    event: "runner-api-e2e",
    message: `ingress-${randomUUID()}`,
  });
  const firstDelivery = await requireSimulator().deliverWebhook({
    url: webhookUrl,
    rawBody,
    secret: webhookSecret,
  });
  expect(firstDelivery.status).toBe(200);
  const firstBody = requireRecord(firstDelivery.body, "first webhook response");
  expect(firstBody.success).toBe(true);
  expect(firstBody.duplicate).toBe(false);
  const runId = requireString(firstBody, "runId", "first webhook response");
  const run: ChatRun = {
    account,
    agentId: requireAgentIds().codex,
    runId,
    threadId,
    clientEventId: randomUUID(),
  };
  await waitForTerminalRun(run, "completed");
  await waitForThreadEvents(run, (event) => {
    return event.eventType === "run.completed" && event.runId === runId;
  });

  const duplicate = await requireSimulator().deliverWebhook({
    url: webhookUrl,
    rawBody,
    secret: webhookSecret,
    timestamp: firstDelivery.timestamp,
  });
  expect(duplicate.status).toBe(200);
  expect(duplicate.body).toEqual({ success: true, duplicate: true });
  const deliveries = (await requireSimulator().events()).filter(
    (event) => event.kind === "webhook-delivery",
  );
  expect(deliveries).toHaveLength(2);
});

test("[RUNNER-01] cancels a running job through the public run API", async () => {
  const account = requireSessions().runner;
  const run = await sendChatRun({
    account,
    agentId: requireAgentIds().runner,
    model: CLAUDE_MODEL,
    parts: [{ type: "text", text: shellCommandPrompt("sleep 300") }],
  });
  await waitForRunStatus(run, ["running"]);
  const cancelled = requireRecord(
    await account.api.post(
      `/api/zero/runs/${run.runId}/cancel`,
      undefined,
      [200],
    ),
    "cancel run response",
  );
  expect(cancelled.status).toBe("cancelled");
  await waitForTerminalRun(run, "cancelled");
  await waitForThreadEvents(run, (event) => {
    return event.eventType === "run.cancelled" && event.runId === run.runId;
  });
});

async function openAccount(
  browser: Browser,
  name: AccountName,
  email: string,
  orgId: string,
): Promise<AccountSession> {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const context = await browser.newContext({
    extraHTTPHeaders: bypassSecret
      ? { "x-vercel-protection-bypass": bypassSecret }
      : undefined,
  });
  await setupClerkTestingToken({ context });
  const page = await context.newPage();
  await signInWithClerkTestingHelper(page, email, appUrl, {
    activeOrganizationId: orgId,
  });
  await page.goto(new URL("/_/skeleton", appUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    (activeOrganizationId) => {
      return (
        Boolean(window.Clerk?.session) &&
        window.Clerk?.organization?.id === activeOrganizationId
      );
    },
    orgId,
    { timeout: 30_000 },
  );
  return { name, email, context, page, api: new UserApi(page) };
}

async function ensurePaidWorkspace(account: AccountSession): Promise<void> {
  const initial = requireRecord(
    await account.api.get("/api/zero/billing/status", [200]),
    "initial billing status",
  );
  if (
    initial.supportByok === true &&
    initial.workflowWebhookAutomationAllowed === true
  ) {
    return;
  }

  const successUrl = new URL("/onboarding", appUrl);
  successUrl.searchParams.set("billing", "team");
  successUrl.searchParams.set("billing_session_id", "{CHECKOUT_SESSION_ID}");
  const stripeSuccessUrl = successUrl
    .toString()
    .replace(
      "billing_session_id=%7BCHECKOUT_SESSION_ID%7D",
      "billing_session_id={CHECKOUT_SESSION_ID}",
    );
  const cancelUrl = new URL("/onboarding", appUrl);
  cancelUrl.searchParams.set("billing", "canceled");
  const checkout = requireRecord(
    await account.api.post(
      "/api/zero/billing/checkout",
      {
        tier: "team",
        successUrl: stripeSuccessUrl,
        cancelUrl: cancelUrl.toString(),
      },
      [200],
    ),
    "team checkout response",
  );
  await account.page.goto(
    requireString(checkout, "url", "team checkout response"),
    { waitUntil: "domcontentloaded" },
  );
  await fillStripeCheckout(account.page);
  const appOrigin = new URL(appUrl).origin;
  await account.page.waitForURL((url) => url.origin === appOrigin, {
    timeout: 180_000,
    waitUntil: "domcontentloaded",
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = requireRecord(
      await account.api.get("/api/zero/billing/status", [200]),
      "paid billing status",
    );
    if (
      status.supportByok === true &&
      status.workflowWebhookAutomationAllowed === true
    ) {
      return;
    }
    await pollInterval();
  }
  throw new Error("Workspace did not receive BYOK and webhook entitlements");
}

async function createAgent(
  account: AccountSession,
  displayName: string,
): Promise<string> {
  const created = requireRecord(
    await account.api.post(
      "/api/zero/agents",
      {
        displayName: `${displayName} ${Date.now()}`,
        description: "Public API runner E2E agent",
        visibility: "private",
      },
      [201],
    ),
    "create agent response",
  );
  const id = requireString(created, "agentId", "create agent response");
  trackedAgents.push({ api: account.api, id });
  return id;
}

async function setByokModelPolicies(): Promise<void> {
  const runner = requireSessions().runner;
  const currentClaudeProviderId = requireTestValue(
    claudeProviderId,
    "claudeProviderId",
  );
  const currentCodexProviderId = requireTestValue(
    codexProviderId,
    "codexProviderId",
  );
  await runner.api.put(
    "/api/zero/model-policies",
    {
      policies: [
        {
          model: CLAUDE_MODEL,
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: currentClaudeProviderId,
        },
        {
          model: CODEX_MODEL,
          isDefault: false,
          defaultProviderType: "openai-api-key",
          credentialScope: "org",
          modelProviderId: currentCodexProviderId,
        },
        {
          model: CODEX_ALTERNATE_MODEL,
          isDefault: false,
          defaultProviderType: "openai-api-key",
          credentialScope: "org",
          modelProviderId: currentCodexProviderId,
        },
      ],
    },
    [200],
  );
}

async function setCodexSubscriptionModelPolicies(): Promise<void> {
  const runner = requireSessions().runner;
  const currentClaudeProviderId = requireTestValue(
    claudeProviderId,
    "claudeProviderId",
  );
  await runner.api.put(
    "/api/zero/model-policies",
    {
      policies: [
        {
          model: CLAUDE_MODEL,
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: currentClaudeProviderId,
        },
        {
          model: CODEX_MODEL,
          isDefault: false,
          defaultProviderType: "codex-oauth-token",
          credentialScope: "member",
          modelProviderId: null,
        },
      ],
    },
    [200],
  );
}

async function sendChatRun(args: {
  readonly account: AccountSession;
  readonly agentId: string;
  readonly parts: readonly UserMessagePart[];
  readonly model?: string;
  readonly threadId?: string;
}): Promise<ChatRun> {
  const prompt = args.parts
    .filter((part): part is Extract<UserMessagePart, { type: "text" }> => {
      return part.type === "text";
    })
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!prompt) {
    throw new Error("Runner API E2E chat send requires text content");
  }
  const clientEventId = randomUUID();
  const body = {
    agentId: args.agentId,
    prompt,
    userMessage: { version: 1, parts: args.parts },
    hasTextContent: true,
    clientEventId,
    ...(args.threadId
      ? { threadId: args.threadId }
      : {
          clientThreadId: randomUUID(),
          model: requireTestValue(args.model, "model"),
        }),
  };
  const response = requireRecord(
    await args.account.api.post("/api/zero/chat/events", body, [201]),
    "send chat event response",
  );
  const runId = requireString(response, "runId", "send chat event response");
  const threadId = requireString(
    response,
    "threadId",
    "send chat event response",
  );
  if (!trackedThreads.some((resource) => resource.id === threadId)) {
    trackedThreads.push({ api: args.account.api, id: threadId });
  }
  return {
    account: args.account,
    agentId: args.agentId,
    runId,
    threadId,
    clientEventId,
  };
}

async function waitForTerminalRun(
  run: ChatRun,
  expectedStatus: "completed" | "cancelled",
): Promise<RunSnapshot> {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const snapshot = await readRunSnapshot(run);
    lastStatus = snapshot.status;
    if (snapshot.status === expectedStatus) {
      return snapshot;
    }
    if (TERMINAL_RUN_STATUSES.has(snapshot.status)) {
      throw new Error(
        `Run ${run.runId} reached ${snapshot.status}; expected ${expectedStatus}`,
      );
    }
    await pollInterval();
  }
  throw new Error(
    `Run ${run.runId} did not reach ${expectedStatus}; last status was ${lastStatus}`,
  );
}

async function waitForRunStatus(
  run: ChatRun,
  expectedStatuses: readonly string[],
): Promise<RunSnapshot> {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const snapshot = await readRunSnapshot(run);
    lastStatus = snapshot.status;
    if (expectedStatuses.includes(snapshot.status)) {
      return snapshot;
    }
    if (TERMINAL_RUN_STATUSES.has(snapshot.status)) {
      throw new Error(
        `Run ${run.runId} reached ${snapshot.status} before ${expectedStatuses.join(" or ")}`,
      );
    }
    await pollInterval();
  }
  throw new Error(
    `Run ${run.runId} did not reach ${expectedStatuses.join(" or ")}; last status was ${lastStatus}`,
  );
}

async function readRunSnapshot(run: ChatRun): Promise<RunSnapshot> {
  const response = requireRecord(
    await run.account.api.get(`/api/zero/runs/${run.runId}`, [200]),
    "get run response",
  );
  const result = isRecord(response.result) ? response.result : undefined;
  return {
    status: requireString(response, "status", "get run response"),
    agentSessionId:
      result && typeof result.agentSessionId === "string"
        ? result.agentSessionId
        : undefined,
  };
}

async function readRunContext(
  run: ChatRun,
): Promise<Readonly<Record<string, unknown>>> {
  return requireRecord(
    await run.account.api.get(`/api/zero/runs/${run.runId}/context`, [200]),
    "run context response",
  );
}

async function waitForThreadOutput(
  run: ChatRun,
  marker: string,
): Promise<string> {
  const events = await waitForThreadEvents(run, (event) => {
    return event.eventType === "output.message" &&
      typeof event.content === "string"
      ? event.content.includes(marker)
      : false;
  });
  const output = events
    .filter((event) => event.eventType === "output.message")
    .flatMap((event) => {
      return typeof event.content === "string" ? [event.content] : [];
    })
    .join("\n");
  expect(output).toContain(marker);
  return output;
}

async function waitForThreadEvents(
  run: ChatRun,
  predicate: (event: Readonly<Record<string, unknown>>) => boolean,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const deadline = Date.now() + EVENT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = requireRecord(
      await run.account.api.get(
        `/api/zero/chat-threads/${run.threadId}/events?limit=50`,
        [200],
      ),
      "chat thread events response",
    );
    const events = requireArray(
      response.events,
      "chat thread events response.events",
    ).filter(isRecord);
    if (events.some(predicate)) {
      return events;
    }
    const failed = events.find((event) => {
      return (
        event.runId === run.runId &&
        (event.eventType === "run.failed" ||
          event.eventType === "run.cancelled")
      );
    });
    if (failed) {
      throw new Error(
        `Run ${run.runId} produced ${String(failed.eventType)} before the expected chat event`,
      );
    }
    await pollInterval();
  }
  throw new Error(
    `Chat events for run ${run.runId} did not satisfy the expected condition`,
  );
}

async function waitForAgentEvents(
  run: ChatRun,
  predicate: (value: unknown) => boolean,
  description: string,
): Promise<unknown> {
  return await waitForApiPayload(
    run.account,
    `/api/zero/runs/${run.runId}/telemetry/agent?limit=100&order=asc`,
    predicate,
    description,
  );
}

async function waitForApiPayload(
  account: AccountSession,
  path: string,
  predicate: (value: unknown) => boolean,
  description: string,
): Promise<unknown> {
  const deadline = Date.now() + EVENT_POLL_TIMEOUT_MS;
  let lastValue: unknown;
  while (Date.now() < deadline) {
    lastValue = await account.api.get(path, [200]);
    if (predicate(lastValue)) {
      return lastValue;
    }
    await pollInterval();
  }
  throw new Error(
    `${description} was not available; last response was ${JSON.stringify(lastValue)}`,
  );
}

async function createManualConnector(
  account: AccountSession,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly id: string; readonly slug: string }> {
  const connector = requireRecord(
    await requireSessions().runner.api.post(
      "/api/zero/custom-connectors",
      body,
      [201],
    ),
    "create custom connector response",
  );
  const id = requireString(connector, "id", "create custom connector response");
  const slug = requireString(
    connector,
    "slug",
    "create custom connector response",
  );
  trackedConnectors.push({ api: requireSessions().runner.api, id });
  const memberView = requireRecord(
    await account.api.get(`/api/zero/custom-connectors/${id}`, [200]),
    "member custom connector response",
  );
  expect(memberView.id).toBe(id);
  return { id, slug };
}

async function applyPermissionGrant(
  account: AccountSession,
  agentId: string,
  connectorSlug: string,
  action: "allow" | "deny",
): Promise<void> {
  const grants = await account.api.put(
    "/api/zero/user-permission-grants/apply",
    {
      agentId,
      connectorSlug,
      mode: "replace",
      grants: [
        {
          permission: "chat:write",
          action,
          ...(action === "allow" ? { expiresIn: "always" } : {}),
        },
      ],
    },
    [200],
  );
  expect(JSON.stringify(grants)).toContain(`"action":"${action}"`);
}

async function pasteCodexAuthJson(
  account: AccountSession,
  authJson: string,
  expectedStatuses: readonly number[],
): Promise<unknown> {
  return await account.api.post(
    "/api/zero/me/model-providers",
    {
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: { CODEX_AUTH_JSON: authJson },
      selectedModel: CODEX_MODEL,
    },
    expectedStatuses,
  );
}

function codexAuthJson(planType: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: unsignedJwt({ exp: futureEpochSeconds() }),
      refresh_token: `refresh-${randomUUID()}-${randomUUID()}`,
      account_id: "plain-account-id",
      id_token: codexIdToken(planType),
    },
  });
}

function codexIdToken(planType: string): string {
  return unsignedJwt({
    exp: futureEpochSeconds(),
    email: "runner-real-codex@vm0-e2e.ai",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "runner-codex-account",
      chatgpt_plan_type: planType,
      organization: { title: "Runner Codex E2E" },
    },
  });
}

function unsignedJwt(payload: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function futureEpochSeconds(): number {
  return Math.floor(Date.now() / 1_000) + 7_200;
}

function errorCode(value: Readonly<Record<string, unknown>>): unknown {
  const error = requireRecord(value.error, "API error response.error");
  return error.code;
}

function parseSimulatorEvent(value: unknown, index: number): SimulatorEvent {
  const event = requireRecord(value, `simulator event ${index}`);
  return {
    id: requireString(event, "id", `simulator event ${index}`),
    kind: requireString(event, "kind", `simulator event ${index}`),
    method: requireString(event, "method", `simulator event ${index}`),
    path: requireString(event, "path", `simulator event ${index}`),
    query: requireStringRecord(event.query, `simulator event ${index}.query`),
    headers: requireStringRecord(
      event.headers,
      `simulator event ${index}.headers`,
    ),
    body: requireString(event, "body", `simulator event ${index}`),
  };
}

async function expectResponseStatus(
  response: APIResponse,
  expectedStatuses: readonly number[],
  operation: string,
): Promise<void> {
  if (expectedStatuses.includes(response.status())) {
    return;
  }
  throw new Error(
    `${operation} failed with ${response.status()}: ${await response.text()}`,
  );
}

function requireSessions(): Readonly<Record<AccountName, AccountSession>> {
  return requireTestValue(sessions, "sessions");
}

function requireSimulator(): SimulatorControl {
  return requireTestValue(simulator, "simulator");
}

function requireAgentIds(): Readonly<Record<AccountName, string>> {
  return requireTestValue(agentIds, "agentIds");
}

function requireTestValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} was not initialized`);
  }
  return value;
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function requiredSearchParameter(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`OAuth callback is missing ${name}`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  description: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} must be an array`);
  }
  return value;
}

function requireString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  description: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`${description}.${key} must be a string`);
  }
  return field;
}

function requireNumber(
  value: Readonly<Record<string, unknown>>,
  key: string,
  description: string,
): number {
  const field = value[key];
  if (typeof field !== "number") {
    throw new Error(`${description}.${key} must be a number`);
  }
  return field;
}

function requireStringRecord(
  value: unknown,
  description: string,
): Readonly<Record<string, string>> {
  const record = requireRecord(value, description);
  if (!Object.values(record).every((field) => typeof field === "string")) {
    throw new Error(`${description} must contain only string values`);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, field]) => [key, String(field)]),
  );
}

function exactReplyPrompt(marker: string): string {
  return `Reply with exactly ${marker}`;
}

function shellCommandPrompt(command: string): string {
  return [
    "Use Bash to run the following command exactly.",
    "Return the complete stdout after it finishes.",
    "```sh",
    command,
    "```",
  ].join("\n");
}

async function pollInterval(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
}
