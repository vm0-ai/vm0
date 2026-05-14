import { mockEnv } from "../../../lib/env";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  emptyBoundedTextOutput,
  mockSandboxClient,
  sandboxError,
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

function mockSandbox(
  args: {
    readonly createError?: unknown;
    readonly runError?: unknown;
    readonly stopError?: unknown;
    readonly runResult?: SandboxCommandResult;
    readonly stop?: (
      handle: SandboxHandle,
      options?: StopSandboxOptions,
    ) => Promise<SandboxCleanupResult>;
  } = {},
) {
  const handle = { sandboxId: "sandbox_smoke_test" };
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

      return Promise.resolve(handle);
    },
    get(sandboxId) {
      return Promise.resolve({ sandboxId });
    },
    runCommand(commandHandle, options) {
      calls.run.push({ handle: commandHandle, options });
      if (args.runError !== undefined) {
        throw args.runError;
      }
      return Promise.resolve(
        args.runResult ?? commandResult({ exitCode: 0, stdout: "v24.0.0\n" }),
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

function textOutput(text: string) {
  return {
    text,
    bytes: Buffer.byteLength(text),
    limitBytes: 1024,
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
        ? emptyBoundedTextOutput(1024)
        : textOutput(args.stdout),
    stderr:
      args.stderr === undefined
        ? emptyBoundedTextOutput(1024)
        : textOutput(args.stderr),
  };
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

  it("does not create a sandbox when the authorization header is missing", async () => {
    const calls = mockSandbox();

    const response = await accept(client().smoke({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
    expect(calls.create).toHaveLength(0);
    expect(calls.stop).toHaveLength(0);
  });

  it("runs the fixed smoke command and stops the sandbox", async () => {
    const calls = mockSandbox();

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      sandbox: {
        id: "sandbox_smoke_test",
        runtime: "node24",
      },
      command: {
        cmd: "node",
        args: ["--version"],
        exitCode: 0,
        stdout: "v24.0.0\n",
        stderr: "",
      },
      cleanup: { status: "stopped" },
    });
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({
      runtime: "node24",
      timeoutMs: 60_000,
    });
    expect(calls.run).toHaveLength(1);
    expect(calls.run[0]?.options).toMatchObject({
      cmd: "node",
      args: ["--version"],
      outputLimitBytes: 1024,
    });
    expect(calls.stop).toHaveLength(1);
    expect(calls.stop[0]?.handle).toStrictEqual({
      sandboxId: "sandbox_smoke_test",
    });
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
        message: "Vercel Sandbox smoke check failed during sandbox creation",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "create",
        cause: {
          name: "Error",
          message: "create failed token=[redacted]",
        },
      },
    });
    expect(calls.stop).toHaveLength(0);
  });

  it("redacts non-error sandbox creation failures", async () => {
    const calls = mockSandbox({
      createError:
        'create failed Bearer sandbox-token password=plain-text VERCEL_OIDC_TOKEN=oidc-secret {"access_token":"json-secret"}',
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Vercel Sandbox smoke check failed during sandbox creation",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "create",
        cause: {
          name: "Error",
          message:
            'create failed Bearer [redacted] password=[redacted] VERCEL_OIDC_TOKEN=[redacted] {"access_token":"[redacted]"}',
        },
      },
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
        message: "Vercel Sandbox smoke check failed during command execution",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "run",
        cause: {
          name: "Error",
          message: "run failed",
        },
      },
      sandbox: {
        id: "sandbox_smoke_test",
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

    expect(response.body).toStrictEqual({
      error: {
        message: "Vercel Sandbox smoke check failed during command execution",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "run",
        cause: {
          name: "Error",
          message: "run failed",
        },
      },
      sandbox: {
        id: "sandbox_smoke_test",
        runtime: "node24",
      },
      cleanup: {
        status: "failed",
        error: {
          name: "Error",
          message: "stop failed",
        },
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
      message: "Vercel Sandbox smoke check failed during command execution",
      code: "VERCEL_SANDBOX_SMOKE_FAILED",
      phase: "run",
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
        message: "Vercel Sandbox smoke check failed during sandbox cleanup",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "cleanup",
        cause: {
          name: "AbortError",
          message: "Sandbox cleanup timed out",
        },
      },
      sandbox: {
        id: "sandbox_smoke_test",
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

  it("returns command diagnostics when cleanup fails", async () => {
    const calls = mockSandbox({
      stopError: new Error("stop failed"),
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Vercel Sandbox smoke check failed during sandbox cleanup",
        code: "VERCEL_SANDBOX_SMOKE_FAILED",
        phase: "cleanup",
        cause: {
          name: "Error",
          message: "stop failed",
        },
      },
      sandbox: {
        id: "sandbox_smoke_test",
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
          name: "Error",
          message: "stop failed",
        },
      },
    });
    expect(calls.stop).toHaveLength(1);
  });

  it("treats a non-zero command exit as a smoke failure", async () => {
    const calls = mockSandbox({
      runResult: commandResult({
        exitCode: 1,
        stdout: "",
        stderr: "unexpected\n",
      }),
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body.error.phase).toBe("run");
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
      runResult: commandResult({
        exitCode: null,
        stdout: "started\n",
        stderr: "",
      }),
    });

    const response = await accept(
      client().smoke({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [503],
    );

    expect(response.body.error).toStrictEqual({
      message: "Vercel Sandbox smoke check failed during command execution",
      code: "VERCEL_SANDBOX_SMOKE_FAILED",
      phase: "run",
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
