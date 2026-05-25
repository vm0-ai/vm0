import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseHostRuntime,
  type ComputerUseHostFetch,
} from "./computer-use-host";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createRuntime(
  options: {
    readonly sessionFetch?: ComputerUseHostFetch;
    readonly hostFetch?: ComputerUseHostFetch;
  } = {},
) {
  const sessionFetch =
    options.sessionFetch ??
    vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
  const hostFetch =
    options.hostFetch ??
    vi.fn<ComputerUseHostFetch>(async () => {
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
    async executeCommand() {
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

    runtime.stop();
  });

  it("uses the host bearer token for polling after registration", async () => {
    vi.useFakeTimers();
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
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

    runtime.stop();
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
});
