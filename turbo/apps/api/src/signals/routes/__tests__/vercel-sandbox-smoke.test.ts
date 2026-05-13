import { mockEnv } from "../../../lib/env";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  mockVercelSandboxClient,
  mockVercelSandboxSmokeCleanupTimeoutMs,
  type CreateVercelSandboxOptions,
  type VercelSandboxCommandOptions,
  type VercelSandboxCommandResult,
} from "../../external/vercel-sandbox";
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
    readonly stop?: (options?: {
      readonly signal?: AbortSignal;
    }) => Promise<void>;
    readonly runResult?: VercelSandboxCommandResult;
  } = {},
) {
  const calls = {
    create: [] as CreateVercelSandboxOptions[],
    run: [] as VercelSandboxCommandOptions[],
    stop: [] as ({ readonly signal?: AbortSignal } | undefined)[],
  };

  mockVercelSandboxClient({
    create(options = {}) {
      calls.create.push(options);
      if (args.createError !== undefined) {
        throw args.createError;
      }

      return Promise.resolve({
        id: "sandbox_smoke_test",
        runCommand(options) {
          calls.run.push(options);
          if (args.runError !== undefined) {
            throw args.runError;
          }
          return Promise.resolve(
            args.runResult ?? {
              exitCode: 0,
              stdout: "v24.0.0\n",
              stderr: "",
            },
          );
        },
        stop(options) {
          calls.stop.push(options);
          if (args.stopError !== undefined) {
            throw args.stopError;
          }
          if (args.stop) {
            return args.stop(options);
          }
          return Promise.resolve();
        },
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
    expect(calls.run[0]).toMatchObject({
      cmd: "node",
      args: ["--version"],
    });
    expect(calls.stop).toHaveLength(1);
    expect(calls.stop[0]?.signal).toBeInstanceOf(AbortSignal);
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

  it("fails cleanup when sandbox stop waits for the cleanup timeout", async () => {
    mockVercelSandboxSmokeCleanupTimeoutMs(0);
    const calls = mockSandbox({
      stop(options) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error("stop called without a cleanup signal"));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
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
          message: "Vercel Sandbox cleanup timed out",
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
          message: "Vercel Sandbox cleanup timed out",
        },
      },
    });
    expect(calls.stop).toHaveLength(1);
    expect(calls.stop[0]?.signal?.aborted).toBeTruthy();
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
      runResult: {
        exitCode: 1,
        stdout: "",
        stderr: "unexpected\n",
      },
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
});
