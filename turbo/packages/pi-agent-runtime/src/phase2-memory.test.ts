import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { renderPiMemoryPhase2Prompt } from "./phase2-memory-prompt";
import { PI_MEMORY_PHASE2_TOOL_NAMES } from "./phase2-memory-tools";
import {
  runPiMemoryPhase2Consolidation,
  runPiMemoryPhase2ConsolidationForTest,
  type PiMemoryPhase2EngineTestHooks,
  type PiMemoryPhase2SessionSnapshot,
} from "./phase2-memory";
import {
  PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
  PiMemoryPhase2EngineError,
  type PiMemoryPhase2BaseFile,
  type PiMemoryPhase2ConsolidationArgs,
  type PiMemoryPhase2LifecycleEvent,
  type PiMemoryPhase2SelectedSnapshot,
  type PiMemoryPhase2UsageEvent,
} from "./phase2-memory-types";

const servers: Server[] = [];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(error) {
      rejectPromise?.(error);
    },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }),
  );
});

function baseFile(path: string, content: string): PiMemoryPhase2BaseFile {
  const bytes = Buffer.from(content);
  return {
    type: "file",
    path,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    bytes,
  };
}

function selected(
  overrides: Partial<PiMemoryPhase2SelectedSnapshot> = {},
): PiMemoryPhase2SelectedSnapshot {
  return {
    piSessionId: "pi-session-secret-input",
    sourceRunId: "source-run-secret-input",
    sourceHistoryHash: createHash("sha256").update("history").digest("hex"),
    sourceCompletedAt: new Date("2026-09-03T03:04:05.000Z"),
    rawMemory: "RAW_STAGE1_SECRET_31243",
    rolloutSummary: "ROLLOUT_SUMMARY_SECRET_31243",
    rolloutSlug: "ROLLOUT_SLUG_SECRET_31243",
    ...overrides,
  };
}

function args(
  baseUrl: string,
  overrides: Partial<PiMemoryPhase2ConsolidationArgs> = {},
): PiMemoryPhase2ConsolidationArgs {
  return {
    orgId: "org-phase2",
    userId: "user-phase2",
    memoryStorageId: "storage-phase2",
    claimedRevision: 9,
    leaseToken: "LEASE_TOKEN_SECRET_31243",
    baseFiles: [
      baseFile("MEMORY.md", "# Task Group: prior\n"),
      baseFile("memory_summary.md", "v1\n## User Profile\n- prior\n"),
      baseFile(".git/config", "BASE_GIT_SECRET_31243"),
      baseFile("legacy.md", "BASE_LEGACY_SECRET_31243"),
      baseFile("raw_memories.md", "BASE_CODEX_RAW_SECRET_31243"),
      baseFile("rollout_summaries/codex.md", "BASE_CODEX_EVIDENCE_31243"),
    ],
    selected: [selected()],
    model: {
      provider: "openai",
      baseUrl,
      apiKey: "PROVIDER_KEY_SECRET_31243",
      model: "MODEL_ALIAS_SECRET_31243",
      catalogModel: "gpt-5.6-terra",
      api: "openai-responses",
      thinkingLevel: "max",
      requestHeaders: { "x-phase2-secret": "HEADER_SECRET_31243" },
    },
    heartbeat: async () => {
      return true;
    },
    ...overrides,
  };
}

interface ProviderRequest {
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

type ProviderStep =
  | {
      readonly type: "tool";
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "http-error" }
  | { readonly type: "hang"; readonly onRequest?: () => void };

function writeSse(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
  );
}

function usage() {
  return {
    input_tokens: 11,
    output_tokens: 7,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 18,
  };
}

function toolSse(
  response: ServerResponse,
  index: number,
  step: ProviderStep,
): void {
  if (step.type !== "tool") {
    throw new Error("Expected tool provider step");
  }
  const responseId = `resp_phase2_tool_${index.toString()}`;
  const itemId = `fc_phase2_${index.toString()}`;
  const callId = `call_phase2_${index.toString()}`;
  const functionArguments = JSON.stringify(step.arguments);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name: step.name,
    arguments: functionArguments,
    status: "completed",
  };
  writeSse(response, [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: itemId,
      delta: functionArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: itemId,
      arguments: functionArguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: usage(),
      },
    },
  ]);
}

function textSse(response: ServerResponse, index: number, text: string): void {
  const responseId = `resp_phase2_final_${index.toString()}`;
  const messageId = `msg_phase2_${index.toString()}`;
  const item = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeSse(response, [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: usage(),
      },
    },
  ]);
}

async function startProvider(steps: readonly ProviderStep[]): Promise<{
  readonly baseUrl: string;
  readonly requests: ProviderRequest[];
}> {
  const requests: ProviderRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const index = requests.length;
      requests.push({
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >,
      });
      const step = steps[index];
      if (!step) {
        response.writeHead(500).end();
        return;
      }
      switch (step.type) {
        case "tool": {
          toolSse(response, index, step);
          return;
        }
        case "text": {
          textSse(response, index, step.text);
          return;
        }
        case "http-error": {
          response.writeHead(500).end("provider failure secret");
          return;
        }
        case "hang": {
          step.onRequest?.();
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": waiting\n\n");
          return;
        }
      }
    })().catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Phase 2 provider test server has no TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

function metadataWithoutContents<
  T extends { readonly files: readonly { readonly path: string }[] },
>(value: T): unknown {
  return {
    ...value,
    files: value.files.map((file) => {
      return { path: file.path };
    }),
  };
}

function expectBoundedFailure(
  promise: Promise<unknown>,
  errorClass: PiMemoryPhase2EngineError["errorClass"],
): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`Expected ${errorClass} failure`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PiMemoryPhase2EngineError);
      expect(error).toMatchObject({ errorClass });
      expect(error).not.toHaveProperty("files");
      expect(JSON.stringify(error)).not.toContain("SECRET_");
    },
  );
}

describe("Pi memory Phase 2 consolidation engine", () => {
  it("returns an exact no-op without a heartbeat or provider call", async () => {
    let heartbeatCount = 0;
    let cleanupRoot: string | undefined;
    const lifecycle: PiMemoryPhase2LifecycleEvent[] = [];
    const input = args("http://127.0.0.1:1/v1", {
      selected: [],
      heartbeat: async () => {
        heartbeatCount += 1;
        return true;
      },
      onLifecycle(event) {
        lifecycle.push(event);
      },
    });
    const result = await runPiMemoryPhase2ConsolidationForTest(
      input,
      {
        async beforeCleanup(root) {
          cleanupRoot = root;
          await expect(stat(root)).resolves.toBeDefined();
        },
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("no_diff");
    expect(result.responseId).toBeNull();
    expect(result.usage).toStrictEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(heartbeatCount).toBe(0);
    expect(
      result.files.map((file) => {
        return file.path;
      }),
    ).toStrictEqual(
      input.baseFiles
        .map((file) => {
          return file.path;
        })
        .slice()
        .sort(),
    );
    expect(
      lifecycle.map((event) => {
        return event.stage;
      }),
    ).toStrictEqual(["staged", "no_diff"]);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses one restricted official AgentSession and returns exact prepared usage", async () => {
    expect(PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS).toBe(90_000);
    const provider = await startProvider([
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/MEMORY.md",
          content: "# Task Group: updated by maintenance\n",
        },
      },
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/memory_summary.md",
          content: "v1\n## User Profile\n- updated by maintenance\n",
        },
      },
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/skills/reusable/SKILL.md",
          content:
            "---\nname: reusable\ndescription: reusable procedure\n---\n\n# Reusable\n",
        },
      },
      { type: "text", text: "MODEL_TEXT_SECRET_31243 completed" },
    ]);
    const lifecycle: PiMemoryPhase2LifecycleEvent[] = [];
    const usages: PiMemoryPhase2UsageEvent[] = [];
    const sessions: PiMemoryPhase2SessionSnapshot[] = [];
    let heartbeatCount = 0;
    let cleanupRoot: string | undefined;
    const input = args(provider.baseUrl, {
      heartbeat: async () => {
        heartbeatCount += 1;
        return true;
      },
      onLifecycle(event) {
        lifecycle.push(event);
      },
      onUsage(event) {
        usages.push(event);
      },
    });
    const hooks: PiMemoryPhase2EngineTestHooks = {
      onSessionCreated(snapshot) {
        sessions.push(snapshot);
      },
      async beforeCleanup(root) {
        cleanupRoot = root;
      },
    };
    const result = await runPiMemoryPhase2ConsolidationForTest(
      input,
      hooks,
      new AbortController().signal,
    );

    expect(result.status).toBe("prepared");
    expect(result.responseId).toBe("resp_phase2_final_3");
    expect(result.usage).toStrictEqual({
      input: 36,
      output: 28,
      cacheRead: 8,
      cacheWrite: 0,
      reasoning: 8,
    });
    expect(heartbeatCount).toBe(1);
    expect(sessions).toStrictEqual([
      {
        toolNames: PI_MEMORY_PHASE2_TOOL_NAMES,
        thinkingLevel: "medium",
        sessionFile: undefined,
        extensions: 0,
        skills: 0,
        prompts: 0,
        themes: 0,
        agentsFiles: 0,
        appendSystemPrompts: 0,
        systemPromptDigest: createHash("sha256")
          .update(
            `${renderPiMemoryPhase2Prompt()}\nCurrent working directory: /phase2-memory`,
          )
          .digest("hex"),
      },
    ]);
    expect(provider.requests).toHaveLength(4);
    for (const request of provider.requests) {
      expect(request.url).toBe("/v1/responses");
      expect(request.body).toMatchObject({
        model: "MODEL_ALIAS_SECRET_31243",
        reasoning: { effort: "medium" },
      });
      expect(
        (request.body.tools as Array<{ readonly name: string }>).map((tool) => {
          return tool.name;
        }),
      ).toStrictEqual(PI_MEMORY_PHASE2_TOOL_NAMES);
      expect(JSON.stringify(request.body)).not.toContain('"bash"');
      expect(JSON.stringify(request.body)).not.toContain('"memories_');
    }
    const firstRequest = provider.requests[0];
    if (!firstRequest) {
      throw new Error("Missing first Phase 2 provider request");
    }
    expect(firstRequest.headers["x-phase2-secret"]).toBe("HEADER_SECRET_31243");
    expect(
      (firstRequest.body.input as Array<Record<string, unknown>>)[0],
    ).toStrictEqual({
      role: "developer",
      content: `${renderPiMemoryPhase2Prompt()}\nCurrent working directory: /phase2-memory`,
    });
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      responseId: result.responseId,
      usage: result.usage,
    });
    expect(
      lifecycle.map((event) => {
        return event.stage;
      }),
    ).toStrictEqual([
      "staged",
      "heartbeat",
      "model_started",
      "model_completed",
      "validated",
    ]);

    const files = new Map(
      result.files.map((file) => {
        return [
          file.path,
          Buffer.from(file.contentBase64, "base64").toString(),
        ];
      }),
    );
    expect(files.get(".git/config")).toBe("BASE_GIT_SECRET_31243");
    expect(files.get("legacy.md")).toBe("BASE_LEGACY_SECRET_31243");
    expect(files.get("raw_memories.md")).toBe("BASE_CODEX_RAW_SECRET_31243");
    expect(files.get("rollout_summaries/codex.md")).toBe(
      "BASE_CODEX_EVIDENCE_31243",
    );
    expect(
      [...files.keys()].some((path) => {
        return path.startsWith("rollout_summaries/pi/");
      }),
    ).toBe(true);
    expect([...files.keys()]).not.toContain("raw-memories.md");
    expect([...files.keys()]).not.toContain("workspace-diff.md");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.files)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.files)).toBe(true);

    const contentSafePayloads = JSON.stringify({
      lifecycle,
      usages,
      result: metadataWithoutContents(result),
    });
    for (const secret of [
      "RAW_STAGE1_SECRET_31243",
      "ROLLOUT_SUMMARY_SECRET_31243",
      "ROLLOUT_SLUG_SECRET_31243",
      "BASE_GIT_SECRET_31243",
      "BASE_LEGACY_SECRET_31243",
      "BASE_CODEX_RAW_SECRET_31243",
      "PROVIDER_KEY_SECRET_31243",
      "HEADER_SECRET_31243",
      "MODEL_TEXT_SECRET_31243",
      cleanupRoot,
    ]) {
      expect(contentSafePayloads).not.toContain(secret);
    }
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("snapshots mutable inputs before the first await", async () => {
    const provider = await startProvider([{ type: "text", text: "complete" }]);
    const bytes = Buffer.from("# Task Group: original\n");
    const candidate = selected();
    const headers: Record<string, string> = { "x-snapshot": "original" };
    const input = args(provider.baseUrl, {
      baseFiles: [
        {
          type: "file",
          path: "MEMORY.md",
          hash: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          bytes,
        },
        baseFile("memory_summary.md", "v1\n## User Profile\n"),
      ],
      selected: [candidate],
      model: {
        provider: "openai",
        baseUrl: provider.baseUrl,
        apiKey: "original-key",
        model: "gpt-5.6-terra",
        api: "openai-responses",
        requestHeaders: headers,
      },
    });
    const promise = runPiMemoryPhase2Consolidation(
      input,
      new AbortController().signal,
    );
    bytes.fill(120);
    headers["x-snapshot"] = "mutated";
    (candidate as { rawMemory: string }).rawMemory = "mutated raw";
    (candidate as { rolloutSummary: string }).rolloutSummary =
      "mutated summary";

    const result = await promise;
    expect(result.status).toBe("prepared");
    const files = new Map(
      result.files.map((file) => {
        return [
          file.path,
          Buffer.from(file.contentBase64, "base64").toString(),
        ];
      }),
    );
    expect(files.get("MEMORY.md")).toBe("# Task Group: original\n");
    expect(
      [...files]
        .filter(([path]) => {
          return path.startsWith("rollout_summaries/pi/");
        })
        .map(([, content]) => {
          return content;
        })
        .join("\n"),
    ).toContain("ROLLOUT_SUMMARY_SECRET_31243");
    expect(provider.requests[0]?.headers["x-snapshot"]).toBe("original");
  });

  it("treats stale Pi evidence deletion with an empty selection as model work", async () => {
    const provider = await startProvider([
      { type: "text", text: "stale evidence removed" },
    ]);
    const input = args(provider.baseUrl, {
      selected: [],
      baseFiles: [
        baseFile("MEMORY.md", "# Task Group: prior\n"),
        baseFile("memory_summary.md", "v1\n## User Profile\n- prior\n"),
        baseFile("rollout_summaries/pi/stale.md", "stale"),
        baseFile("rollout_summaries/codex.md", "preserved"),
      ],
    });
    const result = await runPiMemoryPhase2Consolidation(
      input,
      new AbortController().signal,
    );
    expect(provider.requests).toHaveLength(1);
    expect(result.status).toBe("prepared");
    expect(
      result.files.map((file) => {
        return file.path;
      }),
    ).not.toContain("rollout_summaries/pi/stale.md");
    expect(
      result.files.map((file) => {
        return file.path;
      }),
    ).toContain("rollout_summaries/codex.md");
  });

  it("returns bounded failures with no partial result and always cleans staging", async () => {
    const cases: ReadonlyArray<{
      readonly steps: readonly ProviderStep[];
      readonly errorClass: PiMemoryPhase2EngineError["errorClass"];
      readonly input?: Partial<PiMemoryPhase2ConsolidationArgs>;
    }> = [
      {
        steps: [{ type: "http-error" }],
        errorClass: "model_failed",
        input: { baseFiles: [] },
      },
      {
        steps: [{ type: "text", text: "" }],
        errorClass: "session_failed",
        input: { baseFiles: [] },
      },
      {
        steps: [{ type: "text", text: "finished without required files" }],
        errorClass: "agent_output_invalid",
        input: { baseFiles: [] },
      },
      {
        steps: [
          {
            type: "tool",
            name: "phase2_write",
            arguments: {
              path: "memory/.git/config",
              content: "FORBIDDEN_TOOL_WRITE_SECRET_31243",
            },
          },
          { type: "text", text: "stopped after rejected tool" },
        ],
        errorClass: "agent_output_invalid",
        input: { baseFiles: [] },
      },
    ];
    for (const testCase of cases) {
      const provider = await startProvider(testCase.steps);
      let cleanupRoot: string | undefined;
      await expectBoundedFailure(
        runPiMemoryPhase2ConsolidationForTest(
          args(provider.baseUrl, testCase.input),
          {
            async beforeCleanup(root) {
              cleanupRoot = root;
            },
          },
          new AbortController().signal,
        ),
        testCase.errorClass,
      );
      await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("confirms the heartbeat before model use and aborts on periodic lease loss", async () => {
    const provider = await startProvider([{ type: "hang" }]);
    let heartbeatCount = 0;
    let cleanupRoot: string | undefined;
    const lifecycle: PiMemoryPhase2LifecycleEvent[] = [];
    await expectBoundedFailure(
      runPiMemoryPhase2ConsolidationForTest(
        args(provider.baseUrl, {
          baseFiles: [],
          heartbeat: async () => {
            heartbeatCount += 1;
            return heartbeatCount < 2;
          },
          onLifecycle(event) {
            lifecycle.push(event);
          },
        }),
        {
          async waitForHeartbeat(signal, cadenceMs) {
            expect(cadenceMs).toBe(
              PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
            );
            signal.throwIfAborted();
          },
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
        new AbortController().signal,
      ),
      "lease_lost",
    );
    expect(heartbeatCount).toBe(2);
    expect(
      lifecycle.map((event) => {
        return event.stage;
      }),
    ).toStrictEqual(["staged", "heartbeat", "model_started", "failed"]);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each<{
    readonly description: string;
    readonly errorClass: PiMemoryPhase2EngineError["errorClass"];
    readonly settle: (heartbeat: Deferred<boolean>) => void;
  }>([
    {
      description: "returns false",
      errorClass: "lease_lost",
      settle(heartbeat) {
        heartbeat.resolve(false);
      },
    },
    {
      description: "rejects",
      errorClass: "heartbeat_failed",
      settle(heartbeat) {
        heartbeat.reject(new Error("HEARTBEAT_SECRET_31252"));
      },
    },
  ])(
    "rejects an in-flight heartbeat that $description after model completion wins",
    async ({ errorClass, settle }) => {
      const provider = await startProvider([
        { type: "text", text: "model completed before heartbeat" },
      ]);
      const heartbeatResult = deferred<boolean>();
      const heartbeatStarted = deferred<void>();
      const modelCompletionSelected = deferred<void>();
      const lifecycle: PiMemoryPhase2LifecycleEvent[] = [];
      const usages: PiMemoryPhase2UsageEvent[] = [];
      let heartbeatCount = 0;
      let disposedSessions = 0;
      let cleanupRoot: string | undefined;
      const promise = runPiMemoryPhase2ConsolidationForTest(
        args(provider.baseUrl, {
          heartbeat: async () => {
            heartbeatCount += 1;
            if (heartbeatCount === 1) {
              return true;
            }
            heartbeatStarted.resolve();
            return await heartbeatResult.promise;
          },
          onLifecycle(event) {
            lifecycle.push(event);
          },
          onUsage(event) {
            usages.push(event);
          },
        }),
        {
          async waitForHeartbeat(signal, cadenceMs) {
            expect(cadenceMs).toBe(
              PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
            );
            signal.throwIfAborted();
          },
          async afterModelCompletionSelected() {
            await heartbeatStarted.promise;
            modelCompletionSelected.resolve();
          },
          onSessionDisposed() {
            disposedSessions += 1;
          },
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
        new AbortController().signal,
      );

      await modelCompletionSelected.promise;
      settle(heartbeatResult);
      await expectBoundedFailure(promise, errorClass);

      expect(heartbeatCount).toBe(2);
      expect(provider.requests).toHaveLength(1);
      expect(usages).toStrictEqual([]);
      expect(disposedSessions).toBe(1);
      expect(
        lifecycle.some((event) => {
          return event.stage === "validated" || event.outcome !== undefined;
        }),
      ).toBe(false);
      await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("allows one success after an in-flight heartbeat settles true", async () => {
    const provider = await startProvider([
      { type: "text", text: "model completed before heartbeat" },
    ]);
    const heartbeatResult = deferred<boolean>();
    const heartbeatStarted = deferred<void>();
    const modelCompletionSelected = deferred<void>();
    const usages: PiMemoryPhase2UsageEvent[] = [];
    let heartbeatCount = 0;
    let disposedSessions = 0;
    const promise = runPiMemoryPhase2ConsolidationForTest(
      args(provider.baseUrl, {
        heartbeat: async () => {
          heartbeatCount += 1;
          if (heartbeatCount === 1) {
            return true;
          }
          heartbeatStarted.resolve();
          return await heartbeatResult.promise;
        },
        onUsage(event) {
          usages.push(event);
        },
      }),
      {
        async waitForHeartbeat(signal, cadenceMs) {
          expect(cadenceMs).toBe(
            PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
          );
          signal.throwIfAborted();
        },
        async afterModelCompletionSelected() {
          await heartbeatStarted.promise;
          modelCompletionSelected.resolve();
        },
        onSessionDisposed() {
          disposedSessions += 1;
        },
      },
      new AbortController().signal,
    );

    await modelCompletionSelected.promise;
    heartbeatResult.resolve(true);
    const result = await promise;

    expect(result.status).toBe("prepared");
    expect(heartbeatCount).toBe(2);
    expect(provider.requests).toHaveLength(1);
    expect(usages).toHaveLength(1);
    expect(disposedSessions).toBe(1);
  });

  it("awaits terminal usage before a later output-validation failure", async () => {
    const provider = await startProvider([
      { type: "text", text: "finished without required files" },
    ]);
    const usages: PiMemoryPhase2UsageEvent[] = [];
    await expectBoundedFailure(
      runPiMemoryPhase2Consolidation(
        args(provider.baseUrl, {
          baseFiles: [],
          async onUsage(event) {
            await Promise.resolve();
            usages.push(event);
          },
        }),
        new AbortController().signal,
      ),
      "agent_output_invalid",
    );

    expect(usages).toHaveLength(1);
    expect(usages[0]?.responseId).toBe("resp_phase2_final_0");
  });

  it("classifies an asynchronous usage persistence failure as observer failure", async () => {
    const provider = await startProvider([
      { type: "text", text: "finished before usage observer" },
    ]);
    await expectBoundedFailure(
      runPiMemoryPhase2Consolidation(
        args(provider.baseUrl, {
          async onUsage() {
            await Promise.resolve();
            throw new Error("USAGE_PERSISTENCE_SECRET_31291");
          },
        }),
        new AbortController().signal,
      ),
      "observer_failed",
    );
  });

  it("observes abort from the staged observer before selecting no-diff", async () => {
    const controller = new AbortController();
    const lifecycle: PiMemoryPhase2LifecycleEvent[] = [];
    const usages: PiMemoryPhase2UsageEvent[] = [];
    let heartbeatCount = 0;
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2ConsolidationForTest(
        args("http://127.0.0.1:1/v1", {
          selected: [],
          heartbeat: async () => {
            heartbeatCount += 1;
            return true;
          },
          onLifecycle(event) {
            lifecycle.push(event);
            if (event.stage === "staged") {
              controller.abort(new Error("STAGED_ABORT_SECRET_31252"));
            }
          },
          onUsage(event) {
            usages.push(event);
          },
        }),
        {
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
        controller.signal,
      ),
      "aborted",
    );

    expect(heartbeatCount).toBe(0);
    expect(usages).toStrictEqual([]);
    expect(
      lifecycle.map((event) => {
        return event.stage;
      }),
    ).toStrictEqual(["staged", "failed"]);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("observes post-model abort before output validation can succeed", async () => {
    const controller = new AbortController();
    const provider = await startProvider([
      { type: "text", text: "completed before validation abort" },
    ]);
    const lifecycle: PiMemoryPhase2LifecycleEvent[] = [];
    const usages: PiMemoryPhase2UsageEvent[] = [];
    let disposedSessions = 0;
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2ConsolidationForTest(
        args(provider.baseUrl, {
          onLifecycle(event) {
            lifecycle.push(event);
          },
          onUsage(event) {
            usages.push(event);
          },
        }),
        {
          async beforeOutputValidation() {
            controller.abort(new Error("VALIDATION_ABORT_SECRET_31252"));
          },
          onSessionDisposed() {
            disposedSessions += 1;
          },
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
        controller.signal,
      ),
      "aborted",
    );

    expect(provider.requests).toHaveLength(1);
    expect(usages).toHaveLength(1);
    expect(disposedSessions).toBe(1);
    expect(
      lifecycle.map((event) => {
        return event.stage;
      }),
    ).toStrictEqual([
      "staged",
      "heartbeat",
      "model_started",
      "model_completed",
      "failed",
    ]);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("aborts an active session immediately and discards late completion", async () => {
    const controller = new AbortController();
    const provider = await startProvider([
      {
        type: "hang",
        onRequest() {
          controller.abort(new Error("CALLER_ABORT_SECRET_31243"));
        },
      },
    ]);
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2ConsolidationForTest(
        args(provider.baseUrl, { baseFiles: [] }),
        {
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
        controller.signal,
      ),
      "aborted",
    );
    expect(provider.requests).toHaveLength(1);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lets cleanup failure override an otherwise valid result", async () => {
    const input = args("http://127.0.0.1:1/v1", { selected: [] });
    await expectBoundedFailure(
      runPiMemoryPhase2ConsolidationForTest(
        input,
        {
          async beforeCleanup() {
            throw new Error("CLEANUP_HOOK_SECRET_31243");
          },
        },
        new AbortController().signal,
      ),
      "cleanup_failed",
    );
  });
});
