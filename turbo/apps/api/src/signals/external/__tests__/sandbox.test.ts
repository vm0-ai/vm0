import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { getApiTestMocks, resetApiTestMocks } from "../../../__tests__/mocks";
import { mockOptionalEnv } from "../../../lib/env";
import {
  getVercelSandboxClient,
  getVercelSandboxCredentials,
} from "../vercel-sandbox";
import {
  clearMockSandboxCleanupTimeoutMs,
  clearMockSandboxClient,
  createBoundedTextCollector,
  emptyBoundedTextOutput,
  mockSandboxCleanupTimeoutMs,
  mockSandboxClient,
  readStreamToBoundedBuffer,
  redactSandboxMessage,
  sandboxCleanupOperation,
  sandboxError,
  type SandboxCommandResult,
  type SandboxHandle,
} from "../sandbox";

function sandboxHandle(): SandboxHandle {
  return { sandboxId: "sb_test" };
}

function commandResult(
  args: {
    readonly sandboxId?: string;
    readonly commandId?: string;
    readonly exitCode?: number | null;
    readonly stdout?: string;
    readonly stderr?: string;
  } = {},
): SandboxCommandResult {
  return {
    sandboxId: args.sandboxId ?? sandboxHandle().sandboxId,
    commandId: args.commandId ?? "cmd_test",
    detached: false,
    exitCode: args.exitCode ?? 0,
    stdout:
      args.stdout === undefined
        ? emptyBoundedTextOutput(1024)
        : {
            text: args.stdout,
            bytes: Buffer.byteLength(args.stdout),
            limitBytes: 1024,
            truncated: false,
          },
    stderr:
      args.stderr === undefined
        ? emptyBoundedTextOutput(1024)
        : {
            text: args.stderr,
            bytes: Buffer.byteLength(args.stderr),
            limitBytes: 1024,
            truncated: false,
          },
  };
}

afterEach(() => {
  clearMockSandboxClient();
  clearMockSandboxCleanupTimeoutMs();
  resetApiTestMocks();
});

describe("sandbox utilities", () => {
  it("captures bounded command output with truncation metadata", () => {
    const collector = createBoundedTextCollector(5);

    collector.writable.write("abc");
    collector.writable.write("def");

    expect(collector.output()).toStrictEqual({
      text: "abcde",
      bytes: 6,
      limitBytes: 5,
      truncated: true,
    });
  });

  it("reads bounded file streams and preserves empty files", async () => {
    const empty = await readStreamToBoundedBuffer(Readable.from([""]), 10);
    expect(empty.status).toBe("ok");
    expect(empty.bytes).toBe(0);
    expect(empty.data.toString()).toBe("");

    const truncated = await readStreamToBoundedBuffer(
      Readable.from(["abcdef"]),
      3,
    );
    expect(truncated).toMatchObject({
      status: "too_large",
      bytes: 6,
      limitBytes: 3,
      truncated: true,
    });
    expect(truncated.data.toString()).toBe("abc");
  });

  it("aborts bounded file reads without destroying streams with an error", async () => {
    const controller = new AbortController();
    const stream = new (class AbortableReadable extends Readable {
      destroyedWith: Error | null | undefined;

      override _read(): void {}

      override _destroy(
        error: Error | null,
        callback: (error?: Error | null) => void,
      ): void {
        this.destroyedWith = error;
        callback();
      }
    })();
    const error = new Error("request aborted");
    error.name = "AbortError";

    const read = readStreamToBoundedBuffer(stream, 10, controller.signal);
    controller.abort(error);

    await expect(read).rejects.toThrow("request aborted");
    expect(stream.destroyedWith).toBeNull();
  });

  it("redacts command, env, and network policy secrets", () => {
    expect(
      redactSandboxMessage(
        'failed Bearer token-value STRIPE_SECRET=sk_test {"authorization":"Bearer abc","x-api-key":"key-value"} password=plain',
      ),
    ).toBe(
      'failed Bearer [redacted] STRIPE_SECRET=[redacted] {"authorization":"[redacted]","x-api-key":"[redacted]"} password=[redacted]',
    );
  });

  it("returns structured cleanup failures and aborts timed out cleanup", async () => {
    let cleanupSignal: AbortSignal | undefined;

    const result = await sandboxCleanupOperation({
      timeoutMs: 0,
      operation(signal) {
        cleanupSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        phase: "stop",
        name: "AbortError",
        message: "Sandbox cleanup timed out",
      },
    });
    expect(cleanupSignal?.aborted).toBeTruthy();
  });

  it("does not start cleanup when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    const error = new Error("request aborted");
    error.name = "AbortError";
    controller.abort(error);
    let cleanupStarted = false;

    const result = await sandboxCleanupOperation({
      signal: controller.signal,
      operation() {
        cleanupStarted = true;
        return Promise.resolve();
      },
    });

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        phase: "stop",
        name: "AbortError",
        message: "request aborted",
      },
    });
    expect(cleanupStarted).toBeFalsy();
  });
});

describe("Vercel sandbox client test override", () => {
  it("uses access-token credentials outside Vercel when API project env var exists", () => {
    mockOptionalEnv("VERCEL_TEAM_ID", "team_test");
    mockOptionalEnv("VERCEL_PROJECT_ID_API", "project_test");
    mockOptionalEnv("VERCEL_TOKEN", "token_test");

    expect(getVercelSandboxCredentials()).toStrictEqual({
      teamId: "team_test",
      projectId: "project_test",
      token: "token_test",
    });
  });

  it("lets the SDK resolve OIDC credentials in Vercel runtimes", () => {
    mockOptionalEnv("VERCEL_ENV", "preview");
    mockOptionalEnv("VERCEL_TEAM_ID", "team_test");
    mockOptionalEnv("VERCEL_PROJECT_ID", "project_test");
    mockOptionalEnv("VERCEL_TOKEN", "token_test");

    expect(getVercelSandboxCredentials()).toBeUndefined();
  });

  it("lets the SDK resolve explicit OIDC credentials when present", () => {
    mockOptionalEnv("VERCEL_OIDC_TOKEN", "oidc_test");
    mockOptionalEnv("VERCEL_TEAM_ID", "team_test");
    mockOptionalEnv("VERCEL_PROJECT_ID", "project_test");
    mockOptionalEnv("VERCEL_TOKEN", "token_test");

    expect(getVercelSandboxCredentials()).toBeUndefined();
  });

  it("fails fast when local access-token credentials are incomplete", () => {
    mockOptionalEnv("VERCEL_TOKEN", "token_test");

    expect(() => {
      getVercelSandboxCredentials();
    }).toThrow(
      "Missing Vercel Sandbox access-token environment variables: VERCEL_TEAM_ID, VERCEL_PROJECT_ID_API",
    );
  });

  it("allows tests to override cleanup timeout", () => {
    expect(() => {
      mockSandboxCleanupTimeoutMs(1);
    }).not.toThrow();
  });

  it("can fake every operation without Vercel credentials", async () => {
    const handle = sandboxHandle();
    const calls = {
      create: [] as unknown[],
      get: [] as string[],
      run: [] as unknown[],
      read: [] as unknown[],
      network: [] as unknown[],
      extend: [] as unknown[],
      stop: [] as SandboxHandle[],
    };

    mockSandboxClient({
      create(options) {
        calls.create.push(options);
        return Promise.resolve(handle);
      },
      get(sandboxId) {
        calls.get.push(sandboxId);
        return Promise.resolve({ sandboxId });
      },
      runCommand(sandboxHandle, options) {
        calls.run.push({ sandboxHandle, options });
        return Promise.resolve(commandResult());
      },
      readFile(sandboxHandle, options) {
        calls.read.push({ sandboxHandle, options });
        return Promise.resolve({ status: "missing" });
      },
      updateNetworkPolicy(sandboxHandle, options) {
        calls.network.push({ sandboxHandle, options });
        return Promise.resolve();
      },
      extendTimeout(sandboxHandle, options) {
        calls.extend.push({ sandboxHandle, options });
        return Promise.resolve();
      },
      stop(sandboxHandle) {
        calls.stop.push(sandboxHandle);
        return Promise.resolve({ status: "stopped" });
      },
    });

    const client = getVercelSandboxClient();
    await expect(client.create({ runtime: "node24" })).resolves.toStrictEqual(
      handle,
    );
    await expect(client.get(handle.sandboxId)).resolves.toStrictEqual(handle);
    await expect(
      client.runCommand(handle, { cmd: "node", args: ["--version"] }),
    ).resolves.toMatchObject({ commandId: "cmd_test", exitCode: 0 });
    await expect(
      client.readFile(handle, { path: "/tmp/missing" }),
    ).resolves.toStrictEqual({ status: "missing" });
    await expect(
      client.updateNetworkPolicy(handle, { networkPolicy: "deny-all" }),
    ).resolves.toBeUndefined();
    await expect(
      client.extendTimeout(handle, { durationMs: 1000 }),
    ).resolves.toBeUndefined();
    await expect(client.stop(handle)).resolves.toStrictEqual({
      status: "stopped",
    });

    expect(calls).toMatchObject({
      create: [{ runtime: "node24" }],
      get: ["sb_test"],
      stop: [handle],
    });
  });

  it("streams Vercel command logs while waiting without the SDK wait stream", async () => {
    const mocks = getApiTestMocks();
    const calls: string[] = [];
    mocks.vercelSandbox.logs.mockImplementation(async function* () {
      calls.push("logs");
      await Promise.resolve();
      yield { stream: "stdout", data: "hello " };
      yield { stream: "stderr", data: "warning" };
      yield { stream: "stdout", data: "world" };
    });
    mocks.vercelSandbox.waitCommand.mockImplementation(async () => {
      calls.push("wait");
      await Promise.resolve();
      return {
        cmdId: "cmd_mock",
        exitCode: 3,
      };
    });

    const result = await getVercelSandboxClient().runCommand(sandboxHandle(), {
      cmd: "node",
      args: ["--version"],
      outputLimitBytes: 8,
    });

    expect(mocks.vercelSandbox.runCommand).toHaveBeenCalledWith({
      cmd: "node",
      args: ["--version"],
      cwd: undefined,
      env: undefined,
      detached: true,
      signal: undefined,
    });
    const waitSignal = (
      mocks.vercelSandbox.waitCommand.mock.calls[0]?.[1] as
        | { readonly signal?: AbortSignal }
        | undefined
    )?.signal;
    expect(waitSignal).toBeInstanceOf(AbortSignal);
    expect(mocks.vercelSandbox.waitCommand).toHaveBeenCalledWith("cmd_mock", {
      signal: waitSignal,
    });
    expect(mocks.vercelSandbox.logs).toHaveBeenCalledWith("cmd_mock", {
      signal: waitSignal,
    });
    expect(calls).toStrictEqual(["logs", "wait"]);
    expect(result).toStrictEqual({
      sandboxId: sandboxHandle().sandboxId,
      commandId: "cmd_mock",
      detached: false,
      exitCode: 3,
      stdout: {
        text: "hello wo",
        bytes: 11,
        limitBytes: 8,
        truncated: true,
      },
      stderr: {
        text: "warning",
        bytes: 7,
        limitBytes: 8,
        truncated: false,
      },
    });
  });

  it("can return sanitized fake cleanup failures", async () => {
    const handle = sandboxHandle();
    mockSandboxClient({
      create() {
        return Promise.resolve(handle);
      },
      get(sandboxId) {
        return Promise.resolve({ sandboxId });
      },
      runCommand() {
        return Promise.resolve(commandResult());
      },
      readFile() {
        return Promise.resolve({ status: "missing" });
      },
      updateNetworkPolicy() {
        return Promise.resolve();
      },
      extendTimeout() {
        return Promise.resolve();
      },
      stop() {
        return Promise.resolve({
          status: "failed",
          error: sandboxError(
            "stop",
            new Error("stop failed authorization=Bearer secret"),
          ),
        });
      },
    });

    await expect(getVercelSandboxClient().stop(handle)).resolves.toStrictEqual({
      status: "failed",
      error: {
        phase: "stop",
        name: "Error",
        message: "stop failed authorization=[redacted]",
      },
    });
  });
});
