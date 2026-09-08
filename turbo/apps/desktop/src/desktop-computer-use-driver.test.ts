import type { ComputerUseCommandClock } from "./computer-use-command-budget";
import { DesktopRecorderController } from "./desktop-recorder-controller";
import { createRecorderNativeBackend } from "./desktop-recorder-native";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopMcpPluginManager } from "./desktop-mcp-plugin";
import { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { resolveDesktopConfig } from "./config";
import { DesktopAuthSession } from "./desktop-auth-session";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthTokenUrl,
} from "./desktop-auth";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import { createDesktopComputerUseHostRuntime } from "./desktop-computer-use-api";
import {
  ComputerUseDriverController,
  type ComputerUseDriver,
} from "./computer-use-driver";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { createComputerUsePermissions } from "./computer-use-permissions";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import {
  SUPPORTED_COMPUTER_USE_CAPABILITIES,
  type ComputerUseCommand,
} from "./computer-use-accessibility";
import { shouldDeferDesktopUpdate } from "./desktop-auto-update-policy";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn() };
});

const realChildProcess =
  await vi.importActual<typeof childProcess>("node:child_process");

const api = "https://api.okou.ai";
const server = setupServer();
const cleanups: (() => Promise<void>)[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  server.resetHandlers();
});
afterAll(() => server.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Only the host's scheduling boundary is controlled; promises and HTTP stay real. */
function controlledTimers() {
  const pending = new Map<
    ReturnType<typeof setTimeout>,
    { delay: number | undefined; run: () => void }
  >();
  const schedule = Object.assign(
    (run: () => void, delay?: number) => {
      const timer = setTimeout(() => {}, 2 ** 30);
      timer.unref();
      pending.set(timer, { delay, run });
      return timer;
    },
    { __promisify__: setTimeout.__promisify__ },
  );
  const clear = (
    timer: ReturnType<typeof setTimeout> | string | number | undefined,
  ) => {
    if (typeof timer === "object") pending.delete(timer);
    clearTimeout(timer);
  };
  return {
    schedule,
    clear,
    count: (delay: number) =>
      [...pending.values()].filter((item) => item.delay === delay).length,
    take(delay: number) {
      const entry = [...pending].find(([, item]) => item.delay === delay);
      if (!entry) throw new Error(`No timer scheduled for ${delay}ms`);
      clear(entry[0]);
      return entry[1].run;
    },
    run(delay: number) {
      this.take(delay)();
    },
    close() {
      for (const timer of pending.keys()) clear(timer);
    },
  };
}

interface NativeRequest {
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

function nativeProcesses(events: string[]) {
  const pauses = new Map<string, ReturnType<typeof pause>>();
  const active = new Set<ChildProcess>();
  const closeReached = deferred<void>();
  let holdClose = false;
  let created = 0;
  function pause(kind: string) {
    const gate = { reached: deferred<void>(), resume: deferred<void>() };
    pauses.set(kind, gate);
    return gate;
  }
  vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
    if (command !== "/test/computer-use-helper")
      return realChildProcess.spawn(command, args, options);
    const generation = ++created;
    events.push(`create:${generation}`);
    const child = new ChildProcess();
    child.kill = () => true;
    const input = new PassThrough();
    const output = new PassThrough();
    child.stdin = input;
    child.stdout = output;
    child.stderr = new PassThrough();
    active.add(child);
    input.on("data", (chunk: Buffer) => {
      const request: NativeRequest = JSON.parse(chunk.toString());
      const reply = async () => {
        events.push(`${generation}:${request.kind}`);
        const gate = pauses.get(request.kind);
        if (gate) {
          pauses.delete(request.kind);
          gate.reached.resolve();
          await gate.resume.promise;
        }
        let result: Record<string, unknown> = {};
        if (request.kind.startsWith("permissions."))
          result = { accessibility: true, screenRecording: true };
        if (request.kind === "apps.list")
          result = {
            apps: [{ name: `generation-${generation}`, bundleId: "test.app" }],
          };
        if (request.kind === "app.state")
          result = {
            app: request.payload.app,
            snapshotId: request.payload.snapshotId,
            screenshot: "data:image/png;base64,abc123",
            screenshotMimeType: "image/png",
            screenshotSource: "window",
            screenshotSourceName: "Test",
            screenshotWidth: 800,
            screenshotHeight: 600,
            screenshotSourceBounds: { x: 0, y: 0, width: 800, height: 600 },
            windowId: 123,
            windowFrame: { x: 0, y: 0, width: 800, height: 600 },
            elements: [
              {
                id: `element-${generation}`,
                role: "AXButton",
                name: "Open",
                actions: ["AXPress"],
              },
            ],
          };
        output.write(
          `${JSON.stringify({ id: request.id, status: "succeeded", result })}\n`,
        );
      };
      void reply();
    });
    input.on("finish", () => {
      events.push(`dispose:${generation}`);
      closeReached.resolve();
      if (!holdClose) {
        active.delete(child);
        child.emit("close", 0, null);
      }
    });
    return child;
  });
  return {
    pause,
    closeReached,
    holdClose: () => {
      holdClose = true;
    },
    get created() {
      return created;
    },
    get active() {
      return active.size;
    },
    close() {
      holdClose = false;
      for (const child of active) child.emit("close", 0, null);
      active.clear();
    },
  };
}

function desktop(
  options: {
    commandClock?: ComputerUseCommandClock;
    transitionTimeoutMs?: number;
    nativeShutdownGraceMs?: number;
    expectedQuitError?: string;
    plugin?: DesktopMcpPluginManager;
  } = {},
) {
  const events: string[] = [];
  const native = nativeProcesses(events);
  const timers = controlledTimers();
  const config = resolveDesktopConfig(undefined, "okou");
  const addClientHeaders = createDesktopClientHeaderInjector({
    clientVersion: "1.2.3",
  });
  const authSession = new DesktopAuthSession({
    apiBaseUrl: api,
    addClientHeaders,
    tokenUrl: buildDesktopAuthTokenUrl(config.authUrl),
    selectOrgUrl: buildDesktopAuthSelectOrgUrl(config.authUrl, true),
    consumeUrl: (code, id) =>
      buildDesktopAuthConsumeUrl(config.authUrl, code, id),
    runAuthWindow: async () => "app-token",
  });
  const driverDefinition: ComputerUseDriver = {
    id: "okou",
    createBackend: () =>
      createComputerUseNativeBackend({
        helperPath: "/test/computer-use-helper",
        shutdownGraceMs: options.nativeShutdownGraceMs ?? 100,
      }),
  };
  const driver = new ComputerUseDriverController(driverDefinition, "darwin");
  const permissions = createComputerUsePermissions((read) =>
    driver.withPermissionProvider(read),
  );
  const requests: {
    path: string;
    body: unknown;
    authorization: string | null;
  }[] = [];
  const heartbeat = deferred<void>();
  const releaseRequests: (() => void)[] = [];
  let hostStarts = 0;
  server.use(
    http.all(`${api}/*`, async ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        body: request.method === "POST" ? await request.json() : null,
        authorization: request.headers.get("authorization"),
      });
      if (path === "/api/auth/me")
        return HttpResponse.json({
          userId: "user",
          email: "test@example.test",
          orgId: "org",
        });
      if (path === "/api/org")
        return HttpResponse.json({ id: "org", name: "Workspace" });
      if (path.endsWith("/hosts/start"))
        return HttpResponse.json({
          hostId: `host-${++hostStarts}`,
          hostToken: "host-token",
        });
      if (path.endsWith("/heartbeat")) heartbeat.resolve();
      return HttpResponse.json({ status: "idle" });
    }),
  );
  const online: boolean[] = [];
  const stateWaiters: (() => void)[] = [];
  const notify = () => {
    options.plugin?.setHostRuntimeOnline(controller.isRuntimeOnline());
    for (const resolve of stateWaiters.splice(0)) resolve();
  };
  const controller = new ComputerUseRuntimeController({
    driver,
    createRuntime: () =>
      createDesktopComputerUseHostRuntime(
        {
          platformUrl: config.platformUrl,
          installationId: "00000000-0000-4000-8000-000000000001",
          hostName: "test-host",
          appVersion: "1.2.3",
          addClientHeaders,
          hostFetch: (input, init) => fetch(input, init),
          getPermissions: permissions.refreshComputerUsePermissionState,
          onChange: notify,
          getSupportedCapabilities: () => [
            ...SUPPORTED_COMPUTER_USE_CAPABILITIES,
            ...(options.plugin?.getCapabilities() ?? []),
          ],
          driver,
          executePluginCommand: async (command) => {
            if (!options.plugin)
              throw new Error("No plugin configured in this fixture");
            return options.plugin.execute(command);
          },
          commandClock: options.commandClock,
          setTimeout: timers.schedule,
          clearTimeout: timers.clear,
        },
        { getAuthSession: () => authSession },
      ),
    refreshPermissions: permissions.refreshComputerUsePermissionState,
    getAuthState: () => authSession.getAuthState(),
    setHostRuntimeOnline: (value) => {
      online.push(value);
      options.plugin?.setHostRuntimeOnline(value);
    },
    onChange: notify,
    transitionTimeoutMs: options.transitionTimeoutMs,
    lifecycleTimers: {
      setTimeout: timers.schedule,
      clearTimeout: timers.clear,
    },
  });
  cleanups.push(async () => {
    for (const release of releaseRequests) release();
    native.close();
    const quit = controller.stopForQuit();
    if (options.expectedQuitError)
      await expect(quit).rejects.toThrow(options.expectedQuitError);
    else await quit;
    timers.close();
  });
  function claim(command: ComputerUseCommand) {
    const reached = deferred<void>();
    const response = deferred<void>();
    const completed = deferred<Record<string, unknown>>();
    const completeResponse = deferred<void>();
    releaseRequests.push(() => {
      response.resolve();
      completeResponse.resolve();
    });
    server.use(
      http.post(`${api}/api/computer-use/host/commands/next`, async () => {
        events.push("claim");
        reached.resolve();
        await response.promise;
        return HttpResponse.json({
          status: "command",
          command: {
            timeoutMs: 60_000,
            createdAt: new Date().toISOString(),
            claimedAt: new Date().toISOString(),
            ...command,
          },
        });
      }),
      http.post<never, Record<string, unknown>>(
        `${api}/api/computer-use/host/commands/${command.id}/complete`,
        async ({ request }) => {
          const body: Record<string, unknown> = await request.json();
          events.push("completion");
          completed.resolve(body);
          await completeResponse.promise;
          return HttpResponse.json({ ok: true });
        },
      ),
    );
    return { reached, response, completed, completeResponse };
  }
  return {
    async waitForHostState(status: string) {
      while (controller.getHostState().status !== status)
        await new Promise<void>((resolve) => stateWaiters.push(resolve));
    },
    controller,
    driver,
    driverDefinition,
    permissions,
    native,
    events,
    timers,
    requests,
    heartbeat,
    online,
    claim,
  };
}

function pluginFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "driver-plugin-"));
  const script = path.join(dir, "server.cjs");
  writeFileSync(
    script,
    `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "pid", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: String(process.pid) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
  );
  const ready = deferred<void>();
  const manager = new DesktopMcpPluginManager({
    preferencesPath: path.join(dir, "preferences.json"),
    resolveShellPath: async () => null,
    onChange: () => {
      if (manager.getState().servers[0]?.status === "running") ready.resolve();
    },
  });
  manager.load();
  manager.importServersJson(
    JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: [script] } },
    }),
  );
  manager.setServerEnabled("fixture", true);
  manager.setFeatureEnabled(true);
  cleanups.push(async () => {
    manager.setHostRuntimeOnline(false);
    manager.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { manager, ready: ready.promise };
}

function recorderFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "driver-recorder-"));
  const helperPath = path.join(dir, "recorder.cjs");
  writeFileSync(
    helperPath,
    `#!${process.execPath}
const readline = require("node:readline");
let status = "idle";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.kind === "recorder.start") status = "recording";
  if (request.kind === "recorder.pause") status = "paused";
  if (request.kind === "recorder.resume") status = "recording";
  const result = request.kind === "recorder.prepare"
    ? { sessionId: String(process.pid), width: 800, height: 600, geometry: { originX: 0, originY: 0, widthPoints: 800, heightPoints: 600, scale: 1 } }
    : { status, elapsedMs: 1000 };
  process.stdout.write(JSON.stringify({ id: request.id, status: "succeeded", result }) + "\\n");
});
`,
  );
  chmodSync(helperPath, 0o755);
  const backend = createRecorderNativeBackend({ helperPath });
  const recorder = new DesktopRecorderController({
    createBackend: () => backend,
    createOutputPath: () => path.join(dir, "recording.mp4"),
    canDeliver: async () => true,
    deliver: async () => {
      throw new Error("Recording delivery is outside this fixture");
    },
    openReview: () => {},
  });
  recorder.setFeatureEnabled(true);
  cleanups.push(async () => {
    backend.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return recorder;
}

const action: ComputerUseCommand = {
  id: "command-1",
  kind: "keyboard.type_text",
  payload: { app: "test.app", text: "hello" },
};

describe("production driver generation and admission wiring", () => {
  it("drains delayed claim, permission, action, capture and completion on the original generation while the host stays alive", async () => {
    const app = desktop();
    await app.controller.start();
    const command = app.claim(action);
    app.timers.run(5_000);
    await command.reached.promise;
    const permission = app.native.pause("permissions.state");
    const write = app.native.pause("keyboard.type_text");
    const capture = app.native.pause("app.state");
    const switchDriver = app.controller.transitionDriver(app.driverDefinition);
    expect(app.controller.transitionDriver(app.driverDefinition)).toBe(
      switchDriver,
    );
    expect(shouldDeferDesktopUpdate(app.controller.getHostState())).toBe(true);
    command.response.resolve();
    await permission.reached.promise;
    expect(app.native.created).toBe(1);
    permission.resume.resolve();
    await write.reached.promise;
    app.timers.run(2_000);
    await app.heartbeat.promise;
    expect(app.controller.getHostState().hostId).toBe("host-1");
    expect(app.online).toEqual([true]);
    expect(app.timers.count(5_000)).toBe(0);
    write.resume.resolve();
    await capture.reached.promise;
    expect(app.events).not.toContain("dispose:1");
    capture.resume.resolve();
    expect(await command.completed.promise).toMatchObject({
      status: "succeeded",
      result: { app: "test.app", action: { app: "test.app" } },
    });
    expect(app.native.created).toBe(1);
    expect(app.events).not.toContain("dispose:1");
    command.completeResponse.resolve();
    await switchDriver;
    expect(app.events.indexOf("completion")).toBeLessThan(
      app.events.indexOf("dispose:1"),
    );
    expect(app.events.indexOf("dispose:1")).toBeLessThan(
      app.events.indexOf("create:2"),
    );
    expect(app.native.active).toBe(1);
    expect(app.driver.generation).toBe(2);
    expect(app.online).toEqual([true]);
    expect(app.timers.count(0)).toBe(1);
    expect(app.controller.getHostState()).toMatchObject({
      status: "online",
      hostId: "host-1",
    });
    for (const request of app.requests.filter(
      (request) =>
        request.path.endsWith("/heartbeat") ||
        request.path.endsWith("/hosts/start"),
    )) {
      expect(request.body).toMatchObject({
        supportedCapabilities: [...SUPPORTED_COMPUTER_USE_CAPABILITIES],
      });
    }
  });
  it("rejects an explicit snapshot from a retired generation before any new native action", async () => {
    const app = desktop();
    await app.controller.start();
    const command = app.claim({
      id: "capture",
      kind: "app.state",
      payload: { app: "test.app" },
    });
    app.timers.run(5_000);
    command.response.resolve();
    const completed = await command.completed.promise;
    const result = completed.result as { snapshotId: string };
    const transition = app.controller.transitionDriver(app.driverDefinition);
    command.completeResponse.resolve();
    await transition;
    const old = app.claim({
      ...action,
      id: "stale",
      payload: { ...action.payload, snapshotId: result.snapshotId },
    });
    app.timers.run(0);
    old.response.resolve();
    expect(await old.completed.promise).toMatchObject({
      status: "failed",
      error: { code: "unsupported_command" },
    });
    expect(app.events).not.toContain("2:keyboard.type_text");
    old.completeResponse.resolve();
  });
  it.each(["stop", "auth", "quit", "update"] as const)(
    "lets %s supersede a delayed host registration",
    async (reason) => {
      const app = desktop();
      const registration = deferred<void>();
      const response = deferred<void>();
      const stopped = deferred<void>();
      server.use(
        http.post(`${api}/api/computer-use/hosts/start`, async () => {
          registration.resolve();
          await response.promise;
          return HttpResponse.json({
            hostId: "late-host",
            hostToken: "late-token",
          });
        }),
        http.post(`${api}/api/computer-use/host/stop`, ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer late-token",
          );
          stopped.resolve();
          return HttpResponse.json({});
        }),
      );
      const start = app.controller.start();
      await registration.promise;
      if (reason === "stop") await app.controller.stop();
      if (reason === "auth") await app.controller.stopForAuthChange();
      if (reason === "quit") await app.controller.stopForQuit();
      if (reason === "update")
        await app.controller.stopForQuit("update_relaunch");
      response.resolve();
      await start;
      await stopped.promise;
      expect(app.controller.getHostState().status).toBe("offline");
      expect(app.online).not.toContain(true);
      expect(app.timers.count(5_000)).toBe(0);
      expect(app.native.active).toBe(0);
    },
  );
  it("waits for native disposal acknowledgment before publishing a replacement", async () => {
    const app = desktop();
    await app.controller.start();
    app.native.holdClose();
    const transition = app.controller.transitionDriver(app.driverDefinition);
    await app.native.closeReached.promise;
    expect(app.driver.generation).toBeNull();
    expect(app.native.created).toBe(1);
    await app.permissions.refreshComputerUsePermissionState();
    expect(
      app.events.filter((event) => event === "1:permissions.state"),
    ).toHaveLength(2);
    app.native.close();
    await transition;
    expect(app.native.created).toBe(2);
  });
  it("keeps the permission request UX available after a manual stop without restarting commands", async () => {
    const app = desktop();
    await app.controller.start();
    await app.controller.stop();
    await app.permissions.requestComputerUseAccessibilityPermission();
    expect(app.events).toContain("2:permissions.request_accessibility");
    await app.controller.start();
    expect(app.controller.getHostState().status).toBe("offline");
    await app.controller.start({ userInitiated: true });
    expect(app.controller.getHostState().status).toBe("online");
  });
  it("does not revive a start whose first permission read finishes after Stop", async () => {
    const app = desktop();
    const permission = app.native.pause("permissions.state");
    const start = app.controller.start();
    await permission.reached.promise;
    const stop = app.controller.stop();
    permission.resume.resolve();
    await Promise.all([start, stop]);
    expect(app.controller.getHostState().status).toBe("offline");
    expect(app.requests.map((request) => request.path)).toEqual([
      "/api/auth/me",
      "/api/org",
    ]);
    expect(app.native.active).toBe(0);
    await app.controller.start();
    expect(app.native.created).toBe(1);
  });

  it("serializes a replacement requested while the initial permission gate is pending", async () => {
    const app = desktop();
    const permission = app.native.pause("permissions.state");
    const start = app.controller.start();
    await permission.reached.promise;
    const transition = app.controller.transitionDriver(app.driverDefinition);
    permission.resume.resolve();
    await Promise.all([start, transition]);
    expect(app.driver.generation).toBe(2);
    expect(app.native.active).toBe(1);
    expect(app.controller.getHostState().status).toBe("online");
    // Only the latest startup registers; it starts with the normal poll delay.
    expect(app.timers.count(5_000)).toBe(1);
    expect(
      app.requests.filter((request) => request.path.endsWith("/hosts/start")),
    ).toHaveLength(1);
  });

  it.each(["stop", "auth", "quit", "update"] as const)(
    "lets %s supersede a transition with an in-flight action",
    async (reason) => {
      const app = desktop();
      await app.controller.start();
      const write = app.native.pause("keyboard.type_text");
      const command = app.claim(action);
      app.timers.run(5_000);
      command.response.resolve();
      await write.reached.promise;
      const transition = app.controller.transitionDriver(app.driverDefinition);
      const rejected = expect(transition).rejects.toThrow("superseded");
      const stop =
        reason === "stop"
          ? app.controller.stop()
          : reason === "auth"
            ? app.controller.stopForAuthChange()
            : app.controller.stopForQuit(
                reason === "update" ? "update_relaunch" : "app_quit",
              );
      write.resume.resolve();
      await stop;
      await rejected;
      expect(app.controller.getHostState().status).toBe("offline");
      expect(app.native.created).toBe(1);
      expect(app.native.active).toBe(0);
      expect(
        app.events.filter((event) => event === "1:keyboard.type_text"),
      ).toHaveLength(1);
      expect(app.timers.count(0)).toBe(0);
    },
  );

  it.each(["claim", "permission", "action", "capture", "completion"] as const)(
    "fails closed on a hung %s without releasing cleanup ownership or replaying",
    async (phase) => {
      const app = desktop({ transitionTimeoutMs: 1_234 });
      await app.controller.start();
      const gate =
        phase === "permission"
          ? app.native.pause("permissions.state")
          : phase === "action"
            ? app.native.pause("keyboard.type_text")
            : phase === "capture"
              ? app.native.pause("app.state")
              : null;
      const command = app.claim(action);
      app.timers.run(5_000);
      await command.reached.promise;
      if (phase !== "claim") command.response.resolve();
      if (gate) await gate.reached.promise;
      if (phase === "completion") await command.completed.promise;
      const transition = app.controller.transitionDriver(app.driverDefinition);
      const rejected = expect(transition).rejects.toThrow("timed out");
      app.timers.run(1_234);
      await rejected;
      expect(app.controller.getHostState().status).toBe("error");
      expect(app.native.created).toBe(1);
      expect(app.events).not.toContain("dispose:1");
      const start = app.controller.start({ userInitiated: true });
      const startRejected = expect(start).rejects.toThrow("timed out");
      app.timers.run(1_234);
      await startRejected;
      expect(app.native.created).toBe(1);
      command.response.resolve();
      gate?.resume.resolve();
      command.completeResponse.resolve();
      await app.controller.stop();
      expect(app.native.active).toBe(0);
      expect(
        app.events.filter((event) => event === "1:keyboard.type_text").length,
      ).toBeLessThanOrEqual(1);
      expect(app.timers.count(0)).toBe(0);
      await app.controller.start({ userInitiated: true });
      expect(app.driver.generation).toBe(2);
      expect(app.controller.getHostState().status).toBe("online");
    },
  );

  it("serializes different requests and resumes one polling path after the last replacement", async () => {
    const app = desktop();
    await app.controller.start();
    const other: ComputerUseDriver = {
      ...app.driverDefinition,
      id: "replacement-fixture",
    };
    const first = app.controller.transitionDriver(app.driverDefinition);
    const second = app.controller.transitionDriver(other);
    await Promise.all([first, second]);
    expect(app.driver.generation).toBe(2);
    expect(app.native.active).toBe(1);
    expect(app.timers.count(0)).toBe(1);
    expect(app.events.filter((event) => event.startsWith("dispose:"))).toEqual([
      "dispose:1",
    ]);
    expect(app.online).toEqual([true]);
  });
  it("preserves a real stdio MCP process and dispatches plugin commands after resume", async () => {
    const plugin = pluginFixture();
    const app = desktop({ plugin: plugin.manager });
    await app.controller.start();
    await plugin.ready;
    const command: ComputerUseCommand = {
      id: "plugin",
      kind: "plugin.call",
      payload: { plugin: "mcp", server: "fixture", tool: "pid", arguments: {} },
    };
    const before = await plugin.manager.execute(command);
    expect(before.status).toBe("succeeded");
    await app.controller.transitionDriver(app.driverDefinition);
    expect(plugin.manager.getState().servers[0]?.status).toBe("running");
    const queued = app.claim(command);
    app.timers.run(0);
    queued.response.resolve();
    expect(await queued.completed.promise).toEqual(before);
    queued.completeResponse.resolve();
    expect(app.online).toEqual([true]);
  });

  it("preserves manual Stop when a late sign-in completion arrives", async () => {
    const app = desktop();
    await app.controller.start();
    await app.controller.stop();
    await app.controller.startForAuthChange(new AbortController().signal);
    expect(app.controller.getHostState().status).toBe("offline");
    expect(app.native.created).toBe(1);
  });
  it("keeps a separate recorder session alive across native driver retirement", async () => {
    const app = desktop();
    const recorder = recorderFixture();
    await app.controller.start();
    await recorder.prepare({
      sourceId: "display:1",
      sourceKind: "display",
      systemAudio: false,
      microphone: false,
    });
    await recorder.start();
    const sessionId = recorder.getState().sessionId;
    expect(recorder.getState().status).toBe("recording");
    await app.controller.transitionDriver(app.driverDefinition);
    await recorder.refreshRecordingStatus();
    expect(recorder.getState()).toMatchObject({
      status: "recording",
      sessionId,
    });
    await recorder.pause();
    await recorder.resume();
    expect(recorder.getState()).toMatchObject({
      status: "recording",
      sessionId,
    });
    expect(app.driver.generation).toBe(2);
  });
  it("refuses replacement when native process exit cannot be confirmed", async () => {
    const app = desktop({
      nativeShutdownGraceMs: 0,
      expectedQuitError: "did not exit after SIGKILL",
    });
    await app.controller.start();
    app.native.holdClose();
    await expect(
      app.controller.transitionDriver(app.driverDefinition),
    ).rejects.toThrow("did not exit after SIGKILL");
    expect(app.controller.getHostState().status).toBe("error");
    expect(app.driver.generation).toBeNull();
    await expect(app.controller.start({ userInitiated: true })).rejects.toThrow(
      "did not exit after SIGKILL",
    );
    expect(app.native.created).toBe(1);
    expect(app.native.active).toBe(1);
    app.native.close();
  });

  it("does not register a host when the auth lifetime aborts during readiness", async () => {
    const app = desktop();
    const reached = deferred<void>();
    const response = deferred<void>();
    server.use(
      http.get(`${api}/api/auth/me`, async () => {
        reached.resolve();
        await response.promise;
        return HttpResponse.json({
          userId: "user",
          email: "test@example.test",
          orgId: "org",
        });
      }),
    );
    const auth = new AbortController();
    const start = app.controller.startForAuthChange(auth.signal);
    await reached.promise;
    auth.abort();
    response.resolve();
    await start;
    await app.controller.stop();
    expect(app.controller.getHostState().status).toBe("offline");
    expect(
      app.requests.some((request) => request.path.endsWith("/hosts/start")),
    ).toBe(false);
    expect(app.native.active).toBe(0);
  });
  it("blocks a recovery callback already queued before the admission pause", async () => {
    const app = desktop();
    await app.controller.start();
    let claims = 0;
    server.use(
      http.post(`${api}/api/computer-use/host/commands/next`, () => {
        claims++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    app.timers.run(5_000);
    await app.waitForHostState("recovering");
    const heartbeat = app.timers.take(2_000);
    const recovery = app.timers.take(2_000);
    app.native.holdClose();
    const transition = app.controller.transitionDriver(app.driverDefinition);
    await app.native.closeReached.promise;
    recovery();
    expect(claims).toBe(1);
    expect(app.native.created).toBe(1);
    app.native.close();
    await transition;
    expect(app.timers.count(0)).toBe(1);
    heartbeat();
    await app.heartbeat.promise;
    expect(app.controller.getHostState().status).toBe("online");
    expect(claims).toBe(1);
  });
});

it.each(["permissions.state", "apps.list", "app.open", "app.state"])(
  "keeps one Okou deadline through %s even before the timer callback is delivered",
  async (phase) => {
    let monotonic = 0;
    const app = desktop({
      commandClock: {
        wallNow: () => Date.parse("2026-09-08T02:42:36.593Z"),
        monotonicNow: () => monotonic,
        setTimeout: (run, delay) => setTimeout(run, delay),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });
    await app.controller.start();
    const gate = app.native.pause(phase);
    const command = app.claim({
      id: "deadline-command",
      kind: phase === "apps.list" ? "apps.list" : "app.open",
      payload: { app: "test.app" },
      timeoutMs: 10_000,
      createdAt: "2026-09-08T02:44:35.425Z",
      claimedAt: "2026-09-08T02:44:36.980Z",
    });
    app.timers.run(5_000);
    await command.reached.promise;
    command.response.resolve();
    await gate.reached.promise;
    monotonic = 10_000;
    const before = app.events.length;
    gate.resume.resolve();
    expect(await command.completed.promise).toMatchObject({
      status: "failed",
      error: { code: "command_timeout" },
    });
    expect(app.events.slice(before)).not.toContain("1:app.open");
    expect(app.events.slice(before)).not.toContain("1:app.state");
    expect(app.driver.getCapabilities()).toEqual([]);
    command.completeResponse.resolve();
    await app.driver.retire();
  },
);
