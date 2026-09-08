import { spawn } from "node:child_process";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { sshCommand } from "../index";

const helper = vi.hoisted(() => {
  return { response: "", exit: 0, mode: "normal", requests: [] as string[] };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(
      (file: string, args: string[], options: { stdio: string[] }) => {
        expect(file).toBe("/usr/local/bin/runner-rpc-client");
        expect(args).toEqual([]);
        expect(options).toEqual({ stdio: ["pipe", "pipe", "pipe"] });
        const script = `
      let request = '';
      process.stdin.on('data', chunk => request += chunk);
      process.stdin.on('end', () => {
        process.send(request);
        if (process.env.SSH_TEST_MODE === 'hang') { setInterval(() => {}, 1000); return; }
        if (process.env.SSH_TEST_MODE === 'invalid-utf8') { process.stdout.end(Buffer.from([255, 10])); return; }
        if (['large', 'excess', 'aggregate'].includes(process.env.SSH_TEST_MODE)) {
          const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
          emit({ type: 'event', data: { type: 'accepted' } });
          const aggregate = process.env.SSH_TEST_MODE === 'aggregate';
          const chunks = aggregate ? 300 : process.env.SSH_TEST_MODE === 'excess' ? 65 : 64;
          for (const stream of ['stdout', 'stderr']) for (let i = 0; i < chunks; i++) {
            const output = { type: 'event', data: { type: 'output', stream, data: Buffer.alloc(aggregate ? 1 : 16384, 97).toString('base64') } };
            if (aggregate) process.stdout.write(' '.repeat(16384) + JSON.stringify(output) + '\\n');
            else emit(output);
          }
          emit({ type: 'result', data: { type: 'finished', effects: 'completed', exit: { type: 'status', code: 0 }, stdout_bytes: 1048576, stderr_bytes: 1048576, stdout_truncated: true, stderr_truncated: true } });
          process.stdout.end(); return;
        }
        process.stdout.end(Buffer.from(process.env.SSH_TEST_RESPONSE, 'base64'), () => process.exit(Number(process.env.SSH_TEST_EXIT)));
      });
    `;
        const child =
          helper.mode === "missing"
            ? original.spawn("/nonexistent/ssh-test-helper", [], {
                stdio: ["pipe", "pipe", "pipe"],
              })
            : original.spawn(process.execPath, ["-e", script], {
                stdio: ["pipe", "pipe", "pipe", "ipc"],
                env: {
                  ...process.env,
                  SSH_TEST_RESPONSE: Buffer.from(helper.response).toString(
                    "base64",
                  ),
                  SSH_TEST_EXIT: String(helper.exit),
                  SSH_TEST_MODE: helper.mode,
                },
              });
        child.on("message", (message: unknown) => {
          if (typeof message === "string") helper.requests.push(message);
        });
        return child;
      },
    ),
  };
});

const id = "a0000000-0000-4000-8000-000000000001";
const accepted = { type: "event", data: { type: "accepted" } };
const zero = {
  stdout_bytes: 0,
  stderr_bytes: 0,
  stdout_truncated: false,
  stderr_truncated: false,
};
function finished(code = 0) {
  return {
    type: "result",
    data: {
      type: "finished",
      effects: "completed",
      exit: { type: "status", code },
      ...zero,
    },
  };
}
function response(...messages: unknown[]) {
  helper.response =
    messages
      .map((message) => {
        return JSON.stringify(message);
      })
      .join("\n") + "\n";
}
function token(capabilities = ["ssh:read", "ssh:write"]) {
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities, userId: "owner", orgId: "org", runId: id })).toString("base64url")}.signature`,
  );
}
async function execute(...args: string[]) {
  await sshCommand.parseAsync(
    ["exec", id, "--command", "printf '$secret'", "--json", ...args],
    { from: "user" },
  );
}
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
function result(): unknown {
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}

beforeEach(() => {
  token();
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  helper.requests.length = 0;
  helper.mode = "normal";
  helper.exit = 0;
  response(accepted, finished());
  vi.mocked(spawn).mockClear();
});
afterEach(() => {
  process.exitCode = 0;
  output.mockClear();
  errors.mockClear();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("okou ssh command", () => {
  it("uses exact structured input and EOF without shell expansion or additional arguments", async () => {
    await execute();
    expect(
      helper.requests.map((request) => {
        return JSON.parse(request);
      }),
    ).toEqual([
      {
        version: 1,
        method: "ssh.exec",
        params: { sshConnectionId: id, command: "printf '$secret'" },
      },
    ]);
    expect(result()).toMatchObject({
      type: "finished",
      exit: { type: "status", code: 0 },
      effects: "completed",
    });
    expect(process.exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("lists live hosts through the canonical API", async () => {
    server.use(
      http.get("http://localhost:3000/api/ssh/hosts", () => {
        return HttpResponse.json({
          hosts: [
            {
              id,
              displayName: "Production",
              host: "ssh.example.com",
              port: 22,
              username: "deploy",
              learnedHostKey: null,
            },
          ],
        });
      }),
    );
    await sshCommand.parseAsync(["host", "list", "--json"], { from: "user" });
    expect(result()).toMatchObject({
      hosts: [{ id, host: "ssh.example.com" }],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([undefined, "personal-token"])(
    "requires a Run token even when explicitly invoked (%s)",
    async (value) => {
      vi.stubEnv("OKOU_TOKEN", value);
      await expect(execute()).rejects.toThrow("CLI exit");
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("enforces each subcommand's capability separately", async () => {
    token(["ssh:read"]);
    await expect(execute()).rejects.toThrow("CLI exit");
    token(["ssh:write"]);
    await expect(
      sshCommand.parseAsync(["host", "list"], { from: "user" }),
    ).rejects.toThrow("CLI exit");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([1, 255, 256, 0xffffffff])(
    "preserves remote status %s and never treats helper exit zero as remote success",
    async (code) => {
      response(accepted, finished(code));
      await execute();
      expect(result()).toMatchObject({
        type: "finished",
        exit: { type: "status", code },
      });
      expect(process.exitCode).toBe(code <= 255 ? code : 1);
    },
  );

  it("preserves binary streams and typed remote signal", async () => {
    const stdout = Buffer.from([0, 255, 13, 10]);
    const stderr = Buffer.from([128, 1]);
    response(
      accepted,
      {
        type: "event",
        data: {
          type: "output",
          stream: "stdout",
          data: stdout.toString("base64"),
        },
      },
      {
        type: "event",
        data: {
          type: "output",
          stream: "stderr",
          data: stderr.toString("base64"),
        },
      },
      {
        type: "result",
        data: {
          type: "finished",
          effects: "completed",
          exit: { type: "signal", signal: "TERM", core_dumped: false },
          ...zero,
          stdout_bytes: stdout.length,
          stderr_bytes: stderr.length,
        },
      },
    );
    await execute();
    expect(result()).toMatchObject({
      stdout_base64: stdout.toString("base64"),
      stderr_base64: stderr.toString("base64"),
      exit: { type: "signal", signal: "TERM" },
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    "unavailable",
    "authority_failure",
    "invalid_credential",
    "unsupported_credential",
    "credential_resource_limit",
    "unsafe_destination",
    "network_failure",
    "host_key_mismatch",
    "unsupported_host_key",
    "configuration_changed",
    "authentication_failed",
    "protocol",
    "exec_rejected",
    "disconnected",
    "timed_out",
    "cancelled",
    "resource_exhausted",
    "transport",
  ])("preserves typed failure %s without replay", async (failureReason) => {
    response({
      type: "result",
      data: {
        type: "failed",
        failure_reason: failureReason,
        effects: "not_started",
        ...zero,
      },
    });
    await execute();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: failureReason,
      effects: "not_started",
    });
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retains uncertain delivery from generic helper errors", async () => {
    helper.exit = 1;
    response({ type: "error", code: "transport", delivery: "unknown" });
    await execute();
    expect(result()).toMatchObject({
      type: "rpc_error",
      code: "transport",
      delivery: "unknown",
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [finished()],
    [accepted],
    [accepted, accepted, finished()],
    [accepted, finished(), finished()],
    [
      {
        type: "event",
        data: { type: "output", stream: "stdout", data: "YQ==" },
      },
      finished(),
    ],
    [
      accepted,
      { type: "event", data: { type: "output", stream: "stdout", data: "YQ" } },
      finished(),
    ],
    [
      accepted,
      {
        type: "event",
        data: { type: "output", stream: "stdout", data: "YQ==" },
      },
      finished(),
    ],
    [
      {
        type: "result",
        data: {
          type: "failed",
          failure_reason: "secret-canary",
          effects: "unknown",
          ...zero,
        },
      },
    ],
    [accepted, { ...finished(), extra: "secret-canary" }],
    [
      accepted,
      {
        type: "result",
        data: {
          type: "failed",
          failure_reason: "transport",
          effects: "not_started",
          ...zero,
        },
      },
    ],
  ])(
    "rejects malformed business responses %# conservatively",
    async (...messages) => {
      response(...messages);
      await execute();
      expect(result()).toMatchObject({
        type: "failed",
        failure_reason: "protocol",
        effects: "unknown",
      });
      expect(JSON.stringify(result())).not.toContain("secret-canary");
      expect(process.exitCode).toBe(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "{secret-canary\n",
    " ".repeat(25 * 1024),
    JSON.stringify(finished()),
  ])("rejects malformed, oversized or unterminated NDJSON %#", async (raw) => {
    helper.response = raw;
    await execute();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "protocol",
      effects: "unknown",
    });
  });

  it("reports a missing packaged helper without claiming remote execution", async () => {
    helper.mode = "missing";
    await execute();
    expect(result()).toMatchObject({ type: "failed", effects: "not_started" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("kills and awaits the owned helper on Ctrl-C, preserving uncertainty", async () => {
    helper.mode = "hang";
    const work = execute();
    await vi.waitFor(() => {
      return expect(helper.requests).toHaveLength(1);
    });
    process.emit("SIGINT");
    await work;
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "cancelled",
      effects: "unknown",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung helper with a deadline and does not replay", async () => {
    helper.mode = "hang";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = execute();
    await vi.waitFor(() => {
      expect(helper.requests).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(65_000);
    await work;
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "timed_out",
      effects: "unknown",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retains two independent bounded streams and truncation flags", async () => {
    helper.mode = "large";
    await execute();
    expect(result()).toMatchObject({
      type: "finished",
      stdout_bytes: 1048576,
      stderr_bytes: 1048576,
      stdout_truncated: true,
      stderr_truncated: true,
    });
    expect(process.exitCode).toBe(0);
  });

  it.each(["excess", "aggregate", "invalid-utf8"])(
    "rejects %s output without replay",
    async (mode) => {
      helper.mode = mode;
      await execute();
      expect(result()).toMatchObject({
        type: "failed",
        failure_reason: "protocol",
        effects: "unknown",
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("requires successful helper EOF even after a valid terminal", async () => {
    helper.exit = 1;
    await execute();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "protocol",
      effects: "unknown",
    });
  });

  it("streams binary output and awaits output backpressure in human mode", async () => {
    const bytes = Buffer.from([0, 255, 10]);
    response(
      accepted,
      {
        type: "event",
        data: {
          type: "output",
          stream: "stdout",
          data: bytes.toString("base64"),
        },
      },
      {
        type: "result",
        data: { ...finished().data, stdout_bytes: bytes.length },
      },
    );
    const writes: Buffer[] = [];
    let completeWrite: (() => void) | undefined;
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk, encodingOrCallback, callback) => {
        writes.push(Buffer.from(chunk));
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        completeWrite = () => {
          done?.();
        };
        return false;
      });
    const exec = sshCommand.commands.find((command) => {
      return command.name() === "exec";
    });
    if (!exec) throw new Error("Missing exec command");
    exec.setOptionValue("json", false);
    let settled = false;
    try {
      const work = sshCommand
        .parseAsync(["exec", id, "--command", "binary-output"], {
          from: "user",
        })
        .then(() => {
          settled = true;
        });
      await vi.waitFor(() => {
        expect(writes).toHaveLength(1);
      });
      expect(settled).toBe(false);
      completeWrite?.();
      await work;
      expect(Buffer.concat(writes)).toEqual(bytes);
      expect(output).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    } finally {
      completeWrite?.();
      stdout.mockRestore();
      exec.setOptionValue("json", true);
    }
  });
});
