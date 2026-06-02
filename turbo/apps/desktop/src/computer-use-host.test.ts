import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseHostRuntime,
  type ComputerUseHostFetch,
} from "./computer-use-host";
import type {
  ComputerUseCommand,
  ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import type { ComputerUsePermissionState } from "./computer-use-types";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createRuntime(
  options: {
    readonly sessionFetch?: ComputerUseHostFetch;
    readonly hostFetch?: ComputerUseHostFetch;
    readonly executeCommand?: (
      command: ComputerUseCommand,
      permissions: ComputerUsePermissionState,
    ) => Promise<ComputerUseCommandExecutionResult>;
  } = {},
) {
  const sessionFetch =
    options.sessionFetch ??
    vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.includes("/api/zero/computer-use/audit-events")) {
        return jsonResponse({ auditEvents: [] });
      }
      return jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
  const hostFetch =
    options.hostFetch ??
    vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/zero/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      return jsonResponse({ status: "idle" });
    });
  const runtime = new ComputerUseHostRuntime({
    platformUrl: new URL("https://app.vm0.ai"),
    displayName: "Zero Desktop",
    appVersion: "1.2.3",
    sessionFetch,
    hostFetch,
    getPermissions() {
      return { accessibility: true, screenRecording: false };
    },
    async executeCommand(command, permissions) {
      if (options.executeCommand) {
        return options.executeCommand(command, permissions);
      }
      return { status: "succeeded", result: {} };
    },
  });
  return { runtime, sessionFetch, hostFetch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ComputerUseHostRuntime", () => {
  it("does not register a host until manually started", async () => {
    vi.useFakeTimers();
    const { runtime, sessionFetch, hostFetch } = createRuntime();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runtime.getState().status).toBe("idle");
    expect(sessionFetch).not.toHaveBeenCalled();
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("registers the host on manual start without requiring Screen Recording", async () => {
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
    const { runtime, hostFetch } = createRuntime({ sessionFetch });

    await runtime.start();

    expect(sessionFetch).toHaveBeenCalledOnce();
    const call = sessionFetch.mock.calls[0];
    if (!call) {
      throw new Error("Expected Computer Use host registration request");
    }
    const [url, init] = call;
    expect(url).toBe("https://api.vm0.ai/api/zero/computer-use/hosts/start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      hostName: "Zero Desktop",
      appVersion: "1.2.3",
      permissions: {
        accessibility: true,
        screenRecording: false,
      },
    });
    expect(runtime.getState()).toMatchObject({
      status: "online",
      hostId: "host-1",
      lastError: null,
    });
    expect(hostFetch).not.toHaveBeenCalled();

    await runtime.stop();
  });

  it("uses the host bearer token for polling after registration", async () => {
    vi.useFakeTimers();
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.includes("/api/zero/computer-use/audit-events")) {
        return jsonResponse({ auditEvents: [] });
      }
      return jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/zero/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      return jsonResponse({ status: "idle" });
    });
    const { runtime } = createRuntime({ sessionFetch, hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const heartbeatCall = hostFetch.mock.calls.find(([url]) => {
      return url.endsWith("/api/zero/computer-use/heartbeat");
    });
    if (!heartbeatCall) {
      throw new Error("Expected Computer Use heartbeat request");
    }
    const headers = new Headers(heartbeatCall[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(headers.get("cookie")).toBeNull();
    expect(sessionFetch.mock.calls[0]?.[0]).toBe(
      "https://api.vm0.ai/api/zero/computer-use/hosts/start",
    );

    await runtime.stop();
  });

  it("records local native command payloads and results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T08:00:00.000Z"));
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/zero/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/zero/computer-use/host/commands/next")) {
        return jsonResponse({
          status: "claimed",
          command: {
            id: "cmd-1",
            kind: "app.state",
            payload: { app: "Things" },
          },
        });
      }
      if (url.endsWith("/api/zero/computer-use/host/commands/cmd-1/complete")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ status: "idle" });
    });
    const executeCommand = vi.fn<
      (
        command: ComputerUseCommand,
        permissions: ComputerUsePermissionState,
      ) => Promise<ComputerUseCommandExecutionResult>
    >(async () => {
      return {
        status: "succeeded",
        result: {
          appState: "0 standard window Inbox",
          screenshot: "data:image/png;base64,abc123",
          screenshotWidth: 800,
          screenshotHeight: 600,
          screenshotSourceName: "Inbox",
        },
      };
    });
    const { runtime } = createRuntime({ hostFetch, executeCommand });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const [entry] = runtime.getState().localCommandLog;
    expect(entry).toMatchObject({
      commandId: "cmd-1",
      kind: "app.state",
      app: "Things",
      status: "succeeded",
      payload: { app: "Things" },
      result: {
        appState: "0 standard window Inbox",
        screenshot: "data:image/png;base64,abc123",
        screenshotWidth: 800,
        screenshotHeight: 600,
        screenshotSourceName: "Inbox",
      },
      error: null,
      durationMs: 0,
    });
    expect(executeCommand).toHaveBeenCalledWith(
      {
        id: "cmd-1",
        kind: "app.state",
        payload: { app: "Things" },
      },
      { accessibility: true, screenRecording: false },
    );
    const completionCall = hostFetch.mock.calls.find(([url]) => {
      return url.endsWith(
        "/api/zero/computer-use/host/commands/cmd-1/complete",
      );
    });
    if (!completionCall) {
      throw new Error("Expected Computer Use command completion request");
    }
    expect(JSON.parse(String(completionCall[1]?.body))).toMatchObject({
      status: "succeeded",
      result: {
        appState: "0 standard window Inbox",
        screenshot: "data:image/png;base64,abc123",
      },
    });

    await runtime.stop();
  });

  it("keeps heartbeats running while a command is executing", async () => {
    vi.useFakeTimers();
    const command: ComputerUseCommand = {
      id: "cmd-1",
      kind: "keyboard.type_text",
      payload: { app: "Chrome", text: "https://mail.google.com/" },
    };
    const execution = deferred<ComputerUseCommandExecutionResult>();
    let nextCalls = 0;
    let completeCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/zero/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/zero/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({ status: "command", command })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/zero/computer-use/host/commands/cmd-1/complete")) {
        completeCalls++;
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const executeCommand = vi.fn<
      (
        command: ComputerUseCommand,
        permissions: ComputerUsePermissionState,
      ) => Promise<ComputerUseCommandExecutionResult>
    >(async () => {
      return await execution.promise;
    });
    const { runtime } = createRuntime({ hostFetch, executeCommand });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(executeCommand).toHaveBeenCalledOnce();
    expect(completeCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(90_000);

    const heartbeatCalls = hostFetch.mock.calls.filter(([url]) => {
      return url.endsWith("/api/zero/computer-use/heartbeat");
    });
    expect(heartbeatCalls.length).toBeGreaterThan(1);
    expect(completeCalls).toBe(0);

    execution.resolve({ status: "succeeded", result: {} });
    await vi.advanceTimersByTimeAsync(0);

    expect(completeCalls).toBe(1);

    await runtime.stop();
  });

  it("retries transient command completion failures", async () => {
    vi.useFakeTimers();
    let nextCalls = 0;
    let completeCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/zero/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/zero/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({
              status: "command",
              command: {
                id: "cmd-1",
                kind: "app.state",
                payload: { app: "Chrome" },
              },
            })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/zero/computer-use/host/commands/cmd-1/complete")) {
        completeCalls++;
        return completeCalls === 1
          ? new Response("{}", { status: 503 })
          : jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(completeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(completeCalls).toBe(2);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
    });

    await runtime.stop();
  });

  it("stops the registered host through the host API", async () => {
    const hostFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse({ ok: true, hostId: "host-1" });
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await runtime.stop();

    const stopCall = hostFetch.mock.calls.find(([url]) => {
      return url.endsWith("/api/zero/computer-use/host/stop");
    });
    if (!stopCall) {
      throw new Error("Expected Computer Use host stop request");
    }
    const headers = new Headers(stopCall[1]?.headers);
    expect(stopCall[1]?.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(runtime.getState()).toMatchObject({
      status: "idle",
      hostId: null,
      lastError: null,
    });
  });

  it("reports heartbeat active host conflicts without retrying", async () => {
    vi.useFakeTimers();
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/zero/computer-use/heartbeat")) {
        return jsonResponse(
          {
            error: { message: "A Desktop Computer Use host is already active" },
          },
          { status: 409 },
        );
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(hostFetch).toHaveBeenCalledOnce();
    expect(hostFetch.mock.calls[0]?.[0]).toBe(
      "https://api.vm0.ai/api/zero/computer-use/heartbeat",
    );
    expect(runtime.getState()).toMatchObject({
      status: "error",
      hostId: null,
      lastError:
        "Computer Use is already active in another Zero Desktop session.",
    });
  });

  it("stops after a 401 registration response so retry stays manual", async () => {
    vi.useFakeTimers();
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return new Response("{}", { status: 401 });
    });
    const { runtime } = createRuntime({ sessionFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sessionFetch).toHaveBeenCalledTimes(2);
    expect(sessionFetch.mock.calls[0]?.[0]).toBe(
      "https://api.vm0.ai/api/zero/computer-use/hosts/start",
    );
    expect(sessionFetch.mock.calls[1]?.[0]).toBe(
      "https://api.vm0.ai/api/auth/me",
    );
    expect(runtime.getState()).toMatchObject({
      status: "unauthenticated",
      hostId: null,
      lastError:
        "Desktop host could not authenticate with the API session. Sign in and retry.",
    });
  });

  it("reports missing organization when the Electron session is signed in", async () => {
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async (input) => {
      if (input.endsWith("/api/auth/me")) {
        return jsonResponse({ userId: "user-1", email: "user@example.com" });
      }
      return new Response("{}", { status: 401 });
    });
    const { runtime } = createRuntime({ sessionFetch });

    await runtime.start();

    expect(runtime.getState()).toMatchObject({
      status: "needs_organization",
      hostId: null,
      lastError:
        "Zero Desktop is signed in but no workspace is active. Select a workspace and retry.",
    });
  });

  it("reports an active host conflict without retrying registration", async () => {
    vi.useFakeTimers();
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse(
        { error: { message: "A Desktop Computer Use host is already active" } },
        { status: 409 },
      );
    });
    const { runtime } = createRuntime({ sessionFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sessionFetch).toHaveBeenCalledOnce();
    expect(runtime.getState()).toMatchObject({
      status: "error",
      hostId: null,
      lastError:
        "Computer Use is already active in another Zero Desktop session.",
    });
  });
});
