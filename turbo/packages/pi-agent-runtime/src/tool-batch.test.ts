import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { vi } from "vitest";

import { executePiToolBatch } from "./tool-batch";
import { PI_TOOL_DEFAULT_TIMEOUT_MS, PI_TOOL_MAX_TIMEOUT_MS } from "./tools";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function waitForAbort(controller: AbortController): Promise<void> {
  if (controller.signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function hasNonEmptyTextContent(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("content" in value) ||
    !Array.isArray(value.content)
  ) {
    return false;
  }
  return value.content.some((content: unknown) => {
    return (
      typeof content === "object" &&
      content !== null &&
      "type" in content &&
      content.type === "text" &&
      "text" in content &&
      typeof content.text === "string" &&
      content.text.trim() !== ""
    );
  });
}

function isDeadlineCallback(value: unknown): value is () => void {
  return typeof value === "function";
}

function fireScheduledDeadline(
  call: readonly unknown[] | undefined,
  expectedTimeoutMs: number,
): void {
  if (!call) {
    throw new Error("Expected a scheduled Pi tool deadline");
  }
  const [callback, timeoutMs] = call;
  if (!isDeadlineCallback(callback)) {
    throw new Error("Expected the Pi tool deadline callback");
  }
  callback();
  expect(timeoutMs).toBe(expectedTimeoutMs);
}

class HangingReadExecutionEnv extends NodeExecutionEnv {
  readonly started = new AbortController();
  readonly abortedPaths: string[] = [];
  readonly #hangingPathSuffix: string;

  constructor(
    options: ConstructorParameters<typeof NodeExecutionEnv>[0],
    hangingPathSuffix = "never-settles.txt",
  ) {
    super(options);
    this.#hangingPathSuffix = hangingPathSuffix;
  }

  override readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): ReturnType<NodeExecutionEnv["readBinaryFile"]> {
    if (!path.endsWith(this.#hangingPathSuffix)) {
      return super.readBinaryFile(path, abortSignal);
    }
    abortSignal?.addEventListener(
      "abort",
      () => {
        this.abortedPaths.push(path);
      },
      { once: true },
    );
    this.started.abort();
    return new Promise<never>(() => {});
  }
}

class HangingBashExecutionEnv extends NodeExecutionEnv {
  readonly started = new AbortController();
  readonly abortedCommands: string[] = [];
  readonly nativeTimeouts: Array<number | undefined> = [];

  override exec(
    command: string,
    options?: Parameters<NodeExecutionEnv["exec"]>[1],
  ): ReturnType<NodeExecutionEnv["exec"]> {
    this.nativeTimeouts.push(options?.timeout);
    options?.abortSignal?.addEventListener(
      "abort",
      () => {
        this.abortedCommands.push(command);
      },
      { once: true },
    );
    this.started.abort();
    return new Promise<never>(() => {});
  }
}

function assistant(
  id: string,
  toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>,
): AssistantMessage {
  return {
    role: "assistant",
    content: toolCalls.map((toolCall) => {
      return { type: "toolCall" as const, ...toolCall };
    }),
    api: "openai-completions",
    provider: "deepseek",
    model: id,
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

describe("Pi handoff tool batch", () => {
  it("executes the latest read through the Node ExecutionEnv", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-recovery-"));
    const file = join(root, "skill", "references", "answer.txt");
    await mkdir(join(root, "skill", "references"), { recursive: true });
    await writeFile(file, "sandbox snapshot bytes\n");
    const env = new NodeExecutionEnv({ cwd: root });
    const messages: Message[] = [
      assistant("handoff", [
        {
          id: "read-snapshot",
          name: "read",
          arguments: { path: file },
        },
      ]),
    ];
    const events: AgentEvent[] = [];

    try {
      const results = await executePiToolBatch(
        {
          messages,
          executionEnv: env,
          onEvent(event) {
            events.push(event);
          },
        },
        new AbortController().signal,
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        role: "toolResult",
        toolCallId: "read-snapshot",
        toolName: "read",
        content: [{ type: "text", text: "sandbox snapshot bytes\n" }],
        isError: false,
      });
      expect(
        events.filter((event) => {
          return event.type === "message_end";
        }),
      ).toHaveLength(1);
    } finally {
      await env.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an error ToolResult for an unavailable tool", async () => {
    const env = new NodeExecutionEnv({ cwd: tmpdir() });
    try {
      const results = await executePiToolBatch(
        {
          messages: [
            assistant("handoff", [
              { id: "unknown-1", name: "unknown", arguments: {} },
            ]),
          ],
          executionEnv: env,
          onEvent() {},
        },
        new AbortController().signal,
      );

      expect(results[0]).toMatchObject({
        toolCallId: "unknown-1",
        isError: true,
        content: [{ type: "text", text: "Tool unknown not found" }],
      });
    } finally {
      await env.cleanup();
    }
  });

  it("applies the runtime default to a tool without a timeout", async () => {
    const env = new HangingReadExecutionEnv({ cwd: tmpdir() });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const resultsPromise = executePiToolBatch(
        {
          messages: [
            assistant("handoff", [
              {
                id: "read-default-timeout",
                name: "read",
                arguments: { path: "never-settles.txt" },
              },
            ]),
          ],
          executionEnv: env,
          onEvent() {},
        },
        new AbortController().signal,
      );

      await waitForAbort(env.started);
      fireScheduledDeadline(
        timeoutSpy.mock.calls[0],
        PI_TOOL_DEFAULT_TIMEOUT_MS,
      );

      await expect(resultsPromise).resolves.toMatchObject([
        {
          toolCallId: "read-default-timeout",
          isError: true,
          details: {
            code: "tool_timeout",
            timeoutMs: PI_TOOL_DEFAULT_TIMEOUT_MS,
          },
        },
      ]);
      expect(env.abortedPaths).toHaveLength(1);
    } finally {
      timeoutSpy.mockRestore();
      await env.cleanup();
    }
  });

  it.each([
    {
      name: "shorter than the default",
      requestedSeconds: 60,
      expectedTimeoutMs: 60_000,
    },
    {
      name: "longer than the default",
      requestedSeconds: 20 * 60,
      expectedTimeoutMs: 20 * 60 * 1_000,
    },
    {
      name: "above the runtime maximum",
      requestedSeconds: 60 * 60,
      expectedTimeoutMs: PI_TOOL_MAX_TIMEOUT_MS,
    },
  ])(
    "applies an explicit Bash timeout $name",
    async ({ requestedSeconds, expectedTimeoutMs }) => {
      const env = new HangingBashExecutionEnv({ cwd: tmpdir() });
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const resultsPromise = executePiToolBatch(
          {
            messages: [
              assistant("handoff", [
                {
                  id: "bash-explicit-timeout",
                  name: "bash",
                  arguments: {
                    command: "never-finish",
                    timeout: requestedSeconds,
                  },
                },
              ]),
            ],
            executionEnv: env,
            onEvent() {},
          },
          new AbortController().signal,
        );

        await waitForAbort(env.started);
        fireScheduledDeadline(timeoutSpy.mock.calls[0], expectedTimeoutMs);

        await expect(resultsPromise).resolves.toMatchObject([
          {
            toolCallId: "bash-explicit-timeout",
            isError: true,
            details: {
              code: "tool_timeout",
              timeoutMs: expectedTimeoutMs,
            },
          },
        ]);
        expect(env.nativeTimeouts).toEqual([undefined]);
        expect(env.abortedCommands).toEqual(["never-finish"]);
      } finally {
        timeoutSpy.mockRestore();
        await env.cleanup();
      }
    },
  );

  it("propagates parent cancellation instead of returning a tool result", async () => {
    const env = new HangingReadExecutionEnv({ cwd: tmpdir() });
    const controller = new AbortController();
    try {
      const resultsPromise = executePiToolBatch(
        {
          messages: [
            assistant("handoff", [
              {
                id: "read-parent-cancel",
                name: "read",
                arguments: { path: "never-settles.txt" },
              },
            ]),
          ],
          executionEnv: env,
          onEvent() {},
        },
        controller.signal,
      );

      await waitForAbort(env.started);
      const reason = new Error("parent cancelled");
      reason.name = "AbortError";
      controller.abort(reason);

      await expect(resultsPromise).rejects.toBe(reason);
      expect(env.abortedPaths).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });

  it("propagates parent cancellation while emitting an immediate result", async () => {
    const env = new NodeExecutionEnv({ cwd: tmpdir() });
    const controller = new AbortController();
    const reason = new Error("parent cancelled during result emission");
    reason.name = "AbortError";
    try {
      const resultsPromise = executePiToolBatch(
        {
          messages: [
            assistant("handoff", [
              { id: "unknown-cancel", name: "unknown", arguments: {} },
            ]),
          ],
          executionEnv: env,
          onEvent(event) {
            if (event.type === "tool_execution_end") {
              controller.abort(reason);
            }
          },
        },
        controller.signal,
      );

      await expect(resultsPromise).rejects.toBe(reason);
    } finally {
      await env.cleanup();
    }
  });

  it("preserves parallel result order without cancelling a successful sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-parallel-timeout-"));
    const fastPath = join(root, "fast.txt");
    await writeFile(fastPath, "fast result\n");
    const env = new HangingReadExecutionEnv({ cwd: root }, "slow.txt");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const resultsPromise = executePiToolBatch(
        {
          messages: [
            assistant("handoff", [
              {
                id: "slow-first",
                name: "read",
                arguments: { path: "slow.txt" },
              },
              {
                id: "fast-second",
                name: "read",
                arguments: { path: fastPath },
              },
            ]),
          ],
          executionEnv: env,
          onEvent() {},
        },
        new AbortController().signal,
      );

      await waitForAbort(env.started);
      fireScheduledDeadline(
        timeoutSpy.mock.calls[0],
        PI_TOOL_DEFAULT_TIMEOUT_MS,
      );
      const results = await resultsPromise;

      expect(results).toMatchObject([
        {
          toolCallId: "slow-first",
          isError: true,
          details: {
            code: "tool_timeout",
            timeoutMs: PI_TOOL_DEFAULT_TIMEOUT_MS,
          },
        },
        {
          toolCallId: "fast-second",
          isError: false,
          content: [{ type: "text", text: "fast result\n" }],
        },
      ]);
      expect(env.abortedPaths).toHaveLength(1);
    } finally {
      timeoutSpy.mockRestore();
      await env.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates a Bash subprocess tree when its deadline expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bash-timeout-"));
    const pidFile = join(root, "pids.txt");
    const env = new NodeExecutionEnv({ cwd: root });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const ready = new AbortController();
    try {
      const resultsPromise = executePiToolBatch(
        {
          messages: [
            assistant("handoff", [
              {
                id: "bash-process-tree",
                name: "bash",
                arguments: {
                  command: `sleep 30 & child=$!; echo "$$ $child" | tee ${JSON.stringify(pidFile)}; wait`,
                  timeout: 1,
                },
              },
            ]),
          ],
          executionEnv: env,
          onEvent(event) {
            if (
              event.type === "tool_execution_update" &&
              hasNonEmptyTextContent(event.partialResult)
            ) {
              ready.abort();
            }
          },
        },
        new AbortController().signal,
      );

      await waitForAbort(ready);
      const pids = (await readFile(pidFile, "utf8"))
        .trim()
        .split(" ")
        .map(Number);
      expect(pids).toHaveLength(2);
      fireScheduledDeadline(timeoutSpy.mock.calls[0], 1_000);

      await expect(resultsPromise).resolves.toMatchObject([
        {
          toolCallId: "bash-process-tree",
          isError: true,
          details: { code: "tool_timeout", timeoutMs: 1_000 },
        },
      ]);
      await vi.waitFor(
        () => {
          for (const pid of pids) {
            expect(() => {
              process.kill(pid, 0);
            }).toThrow();
          }
        },
        { timeout: 2_000, interval: 10 },
      );
    } finally {
      timeoutSpy.mockRestore();
      await env.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
