import { tmpdir } from "node:os";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPiExecutionTools,
  createPiReadTool,
  PI_TOOL_DEFAULT_TIMEOUT_MS,
  PI_TOOL_MAX_TIMEOUT_MS,
} from "./tools";

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

function fireDeadline(expectedTimeoutMs: number): void {
  const call = vi.mocked(globalThis.setTimeout).mock.calls.find((candidate) => {
    return candidate[1] === expectedTimeoutMs;
  });
  const callback = call?.[0];
  if (typeof callback !== "function") {
    throw new Error(`Expected a ${expectedTimeoutMs} ms Pi tool deadline`);
  }
  callback();
}

class HangingReadExecutionEnv extends NodeExecutionEnv {
  readonly started = new AbortController();
  readonly abortedPaths: string[] = [];

  override readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): ReturnType<NodeExecutionEnv["readBinaryFile"]> {
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pi sandbox tool deadlines", () => {
  it("applies the runtime default and aborts a hanging read", async () => {
    const env = new HangingReadExecutionEnv({ cwd: tmpdir() });
    vi.spyOn(globalThis, "setTimeout");
    try {
      const resultPromise = createPiReadTool(env).execute(
        "read-default-timeout",
        { path: "never-settles.txt" },
      );

      await waitForAbort(env.started);
      fireDeadline(PI_TOOL_DEFAULT_TIMEOUT_MS);

      await expect(resultPromise).resolves.toMatchObject({
        details: {
          code: "tool_timeout",
          timeoutMs: PI_TOOL_DEFAULT_TIMEOUT_MS,
        },
      });
      expect(env.abortedPaths).toEqual([
        expect.stringMatching(/never-settles\.txt$/),
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it.each([
    { requestedSeconds: 60, expectedTimeoutMs: 60_000 },
    { requestedSeconds: 20 * 60, expectedTimeoutMs: 20 * 60 * 1_000 },
    { requestedSeconds: 60 * 60, expectedTimeoutMs: PI_TOOL_MAX_TIMEOUT_MS },
  ])(
    "applies and bounds a $requestedSeconds second Bash timeout",
    async ({ requestedSeconds, expectedTimeoutMs }) => {
      const env = new HangingBashExecutionEnv({ cwd: tmpdir() });
      vi.spyOn(globalThis, "setTimeout");
      try {
        const bash = createPiExecutionTools(env).find((tool) => {
          return tool.name === "bash";
        });
        if (!bash) {
          throw new Error("Expected the Pi Bash tool");
        }
        const resultPromise = bash.execute("bash-explicit-timeout", {
          command: "never-finish",
          timeout: requestedSeconds,
        });

        await waitForAbort(env.started);
        fireDeadline(expectedTimeoutMs);

        await expect(resultPromise).resolves.toMatchObject({
          details: { code: "tool_timeout", timeoutMs: expectedTimeoutMs },
        });
        expect(env.nativeTimeouts).toEqual([undefined]);
        expect(env.abortedCommands).toEqual(["never-finish"]);
      } finally {
        await env.cleanup();
      }
    },
  );

  it("propagates parent cancellation instead of returning a timeout", async () => {
    const env = new HangingReadExecutionEnv({ cwd: tmpdir() });
    const controller = new AbortController();
    try {
      const resultPromise = createPiReadTool(env).execute(
        "read-parent-cancel",
        { path: "never-settles.txt" },
        controller.signal,
      );

      await waitForAbort(env.started);
      const reason = new Error("parent cancelled");
      reason.name = "AbortError";
      controller.abort(reason);

      await expect(resultPromise).rejects.toBe(reason);
      expect(env.abortedPaths).toEqual([
        expect.stringMatching(/never-settles\.txt$/),
      ]);
    } finally {
      await env.cleanup();
    }
  });
});
