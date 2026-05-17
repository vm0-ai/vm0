import { mockEnv, mockOptionalEnv, clearMockedEnv } from "../../../lib/env";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  clearMockSandboxClient,
  emptyBoundedTextOutput,
  mockSandboxClient,
  sandboxError,
  type BoundedTextOutput,
  type CreateSandboxOptions,
  type RunSandboxCommandOptions,
  type SandboxCleanupResult,
  type SandboxCommandResult,
  type SandboxHandle,
  type StopSandboxOptions,
} from "../../external/sandbox";
import { vercelSandboxSmokeContract } from "../vercel-sandbox-smoke";

const context = testContext();

function client() {
  return setupApp({ context })(vercelSandboxSmokeContract);
}

function textOutput(text: string): BoundedTextOutput {
  return {
    text,
    bytes: Buffer.byteLength(text),
    limitBytes: 4 * 1024,
    truncated: false,
  };
}

function commandResult(args: {
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}): SandboxCommandResult {
  return {
    sandboxId: "sandbox_smoke_test",
    commandId: "cmd_smoke_test",
    detached: false,
    exitCode: args.exitCode,
    stdout:
      args.stdout === undefined
        ? emptyBoundedTextOutput(4 * 1024)
        : textOutput(args.stdout),
    stderr:
      args.stderr === undefined
        ? emptyBoundedTextOutput(4 * 1024)
        : textOutput(args.stderr),
  };
}

type CommandResultInput =
  | SandboxCommandResult
  | Promise<SandboxCommandResult>
  | (() => SandboxCommandResult | Promise<SandboxCommandResult>);

function resolveCommandResult(input: CommandResultInput) {
  return typeof input === "function" ? input() : input;
}

function mockSandbox(
  args: {
    readonly createError?: unknown;
    readonly runError?: unknown;
    readonly stopError?: unknown;
    readonly runResults?: readonly CommandResultInput[];
    readonly stop?: (
      handle: SandboxHandle,
      options?: StopSandboxOptions,
    ) => Promise<SandboxCleanupResult>;
  } = {},
) {
  let createdSandboxCount = 0;
  const runResults = [...(args.runResults ?? [])];
  const calls = {
    create: [] as CreateSandboxOptions[],
    run: [] as {
      readonly handle: SandboxHandle;
      readonly options: RunSandboxCommandOptions;
    }[],
    stop: [] as {
      readonly handle: SandboxHandle;
      readonly options: StopSandboxOptions | undefined;
    }[],
  };

  mockSandboxClient({
    create(options = {}) {
      calls.create.push(options);
      if (args.createError !== undefined) {
        throw args.createError;
      }

      createdSandboxCount += 1;
      return Promise.resolve({
        sandboxId: `sandbox_smoke_test_${String(createdSandboxCount)}`,
      });
    },
    get(sandboxId) {
      return Promise.resolve({ sandboxId });
    },
    runCommand(commandHandle, options) {
      calls.run.push({ handle: commandHandle, options });
      if (args.runError !== undefined) {
        throw args.runError;
      }
      const runResult = runResults.shift();
      if (runResult) {
        return Promise.resolve(resolveCommandResult(runResult));
      }
      const script = options.args?.join(" ") ?? "";
      return Promise.resolve(
        script.includes("stripe")
          ? commandResult({
              exitCode: 0,
              stdout: "stripe version 1.40.9\n",
            })
          : commandResult({ exitCode: 0, stdout: "v24.0.0\n" }),
      );
    },
    readFile() {
      throw new Error("readFile is not used by the smoke route");
    },
    updateNetworkPolicy() {
      throw new Error("updateNetworkPolicy is not used by the smoke route");
    },
    extendTimeout() {
      throw new Error("extendTimeout is not used by the smoke route");
    },
    stop(commandHandle, options) {
      calls.stop.push({ handle: commandHandle, options });
      if (args.stop) {
        return args.stop(commandHandle, options);
      }
      if (args.stopError !== undefined) {
        return Promise.resolve({
          status: "failed",
          error: sandboxError("stop", args.stopError),
        });
      }
      return Promise.resolve({
        status: "stopped",
      });
    },
  });

  return calls;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

describe("POST /api/internal/vercel-sandbox/smoke", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
  });

  afterEach(() => {
    clearMockedEnv();
    clearMockSandboxClient();
  });

  it("requires the cron secret", async () => {
    const calls = mockSandbox();

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer wrong" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
    expect(calls.create).toHaveLength(0);
    expect(calls.stop).toHaveLength(0);
  });

  it("runs base and CLI auth toolchain smoke checks", async () => {
    const calls = mockSandbox();

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

    expect(response.body.checks).toStrictEqual([
      {
        name: "node",
        sandbox: { id: "sandbox_smoke_test_1", runtime: "node24" },
        command: {
          cmd: "node",
          args: ["--version"],
          exitCode: 0,
          stdout: "v24.0.0\n",
          stderr: "",
        },
        cleanup: { status: "stopped" },
      },
      {
        name: "cli-auth-stripe",
        sandbox: { id: "sandbox_smoke_test_2", runtime: "node24" },
        command: {
          cmd: "stripe",
          args: ["--version"],
          exitCode: 0,
          stdout: "stripe version 1.40.9\n",
          stderr: "",
        },
        cleanup: { status: "stopped" },
      },
    ]);
    expect(calls.create).toHaveLength(2);
    expect(calls.create[0]).toMatchObject({
      runtime: "node24",
      timeoutMs: 60_000,
    });
    expect(calls.create[1]).toMatchObject({
      runtime: "node24",
      timeoutMs: 60_000,
    });
    expect(calls.run).toHaveLength(2);
    expect(calls.run[0]?.options).toMatchObject({
      cmd: "node",
      args: ["--version"],
      outputLimitBytes: 4 * 1024,
    });
    expect(calls.run[1]?.options.args?.[1]).toContain(
      "stripe-linux-checksums.txt",
    );
    expect(calls.run[1]?.options.args?.[1]).toContain(
      '/vercel/sandbox/cli-auth/toolchain/bin/stripe" --version',
    );
    expect(calls.stop).toHaveLength(2);
  });

  it("uses the configured CLI auth snapshot for the toolchain smoke check", async () => {
    mockOptionalEnv("VERCEL_CLI_AUTH_SNAPSHOT_ID", "snap_cli_auth");
    const calls = mockSandbox();

    await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

    expect(calls.create[1]).toMatchObject({
      source: {
        type: "snapshot",
        snapshotId: "snap_cli_auth",
      },
      timeoutMs: 60_000,
    });
    expect(calls.create[1]?.runtime).toBeUndefined();
    expect(calls.run[1]?.options.args?.[1]).not.toContain(
      "stripe-linux-checksums.txt",
    );
    expect(calls.run[1]?.options.args?.[1]).toContain(
      '/vercel/sandbox/cli-auth/toolchain/bin/stripe" --version',
    );
  });

  it("returns a failure when sandbox creation fails", async () => {
    const calls = mockSandbox({
      createError: new Error("create failed token=secret"),
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "node Vercel Sandbox smoke check failed during sandbox creation",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "create",
        check: "node",
        cause: {
          name: "Error",
          message: "create failed token=[redacted]",
        },
      },
      checks: [],
    });
    expect(calls.stop).toHaveLength(0);
  });

  it("stops the sandbox when command execution fails", async () => {
    const calls = mockSandbox({
      runError: new Error("run failed"),
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "node Vercel Sandbox smoke check failed during command execution",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "run",
        check: "node",
        cause: {
          name: "Error",
          message: "run failed",
        },
      },
      checks: [],
      sandbox: {
        id: "sandbox_smoke_test_1",
        runtime: "node24",
      },
      cleanup: { status: "stopped" },
    });
    expect(calls.run).toHaveLength(1);
    expect(calls.stop).toHaveLength(1);
  });

  it("preserves the command failure when cleanup also fails", async () => {
    const calls = mockSandbox({
      runError: new Error("run failed"),
      stopError: new Error("stop failed"),
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body.error).toStrictEqual({
      message:
        "node Vercel Sandbox smoke check failed during command execution",
      code: "VERCEL_SANDBOX_SMOKE_FAILED",
      phase: "run",
      check: "node",
      cause: {
        name: "Error",
        message: "run failed",
      },
    });
    expect(response.body.cleanup).toStrictEqual({
      status: "failed",
      error: {
        name: "Error",
        message: "stop failed",
      },
    });
    expect(calls.run).toHaveLength(1);
    expect(calls.stop).toHaveLength(1);
  });

  it("stops the sandbox when command execution is aborted", async () => {
    const calls = mockSandbox({
      runError: abortError("request aborted"),
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body.error).toStrictEqual({
      message:
        "node Vercel Sandbox smoke check failed during command execution",
      code: "VERCEL_SANDBOX_SMOKE_FAILED",
      phase: "run",
      check: "node",
      cause: {
        name: "AbortError",
        message: "request aborted",
      },
    });
    expect(response.body.cleanup).toStrictEqual({ status: "stopped" });
    expect(calls.stop).toHaveLength(1);
  });

  it("fails cleanup when sandbox stop reports a cleanup timeout", async () => {
    const calls = mockSandbox({
      stop() {
        return Promise.resolve({
          status: "failed",
          error: sandboxError("stop", abortError("Sandbox cleanup timed out")),
        });
      },
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "node Vercel Sandbox smoke check failed during sandbox cleanup",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "cleanup",
        check: "node",
        cause: {
          name: "AbortError",
          message: "Sandbox cleanup timed out",
        },
      },
      checks: [],
      sandbox: {
        id: "sandbox_smoke_test_1",
        runtime: "node24",
      },
      command: {
        cmd: "node",
        args: ["--version"],
        exitCode: 0,
        stdout: "v24.0.0\n",
        stderr: "",
      },
      cleanup: {
        status: "failed",
        error: {
          name: "AbortError",
          message: "Sandbox cleanup timed out",
        },
      },
    });
    expect(calls.stop).toHaveLength(1);
  });

  it("treats a non-zero command exit as a smoke failure", async () => {
    const calls = mockSandbox({
      runResults: [
        commandResult({
          exitCode: 1,
          stdout: "",
          stderr: "unexpected\n",
        }),
      ],
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body.error.phase).toBe("run");
    expect(response.body.error.check).toBe("node");
    expect(response.body.command).toStrictEqual({
      cmd: "node",
      args: ["--version"],
      exitCode: 1,
      stdout: "",
      stderr: "unexpected\n",
    });
    expect(response.body.cleanup).toStrictEqual({ status: "stopped" });
    expect(calls.stop).toHaveLength(1);
  });

  it("treats a missing command exit code as a smoke failure", async () => {
    const calls = mockSandbox({
      runResults: [
        commandResult({
          exitCode: null,
          stdout: "started\n",
          stderr: "",
        }),
      ],
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body.error).toStrictEqual({
      message:
        "node Vercel Sandbox smoke check failed during command execution",
      code: "VERCEL_SANDBOX_SMOKE_FAILED",
      phase: "run",
      check: "node",
      cause: {
        name: "Error",
        message: "Smoke command did not produce an exit code",
      },
    });
    expect(response.body.command).toBeUndefined();
    expect(response.body.cleanup).toStrictEqual({ status: "stopped" });
    expect(calls.stop).toHaveLength(1);
  });
});
