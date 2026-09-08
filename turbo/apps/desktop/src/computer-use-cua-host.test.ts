import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { ComputerUseDriverController } from "./computer-use-driver";
import { createCuaComputerUseDriver } from "./computer-use-cua";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import { createComputerUsePermissions } from "./computer-use-permissions";
import { createDesktopComputerUseHostRuntime } from "./desktop-computer-use-api";
import { DesktopAuthSession } from "./desktop-auth-session";
import { DesktopFilesystemPluginManager } from "./desktop-filesystem-plugin";
import { resolveDesktopConfig } from "./config";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthTokenUrl,
} from "./desktop-auth";
import type { ComputerUseCommand } from "./computer-use-accessibility";
import type { ComputerUseCommandClock } from "./computer-use-command-budget";
import { cuaBoundary, deferred } from "./test/cua-boundary";

const server = setupServer();
const cleanups: (() => Promise<void>)[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

async function desktop(
  granted = true,
  pluginEnabled = false,
  options: {
    driver?: "okou" | "cua";
    wallTime?: number;
    startupFailure?: boolean;
    stopDuringPreparation?: boolean;
    ignoreNetworkAbort?: boolean;
  } = {},
) {
  const external = cuaBoundary();
  external.granted = granted;
  // macOS TMPDIR can contain /var -> /private/var aliases; MCP requires canonical roots.
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "cua-plugin-")),
  );
  const helperPath = path.join(directory, "computer-use-helper");
  const nativeLog = path.join(directory, "native.jsonl");
  await writeFile(nativeLog, "");
  if (options.driver === "okou") {
    // Exercise the shipped Okou backend against the external helper protocol.
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify(request) + "\\n");
  const result = request.kind === "permissions.state"
    ? { accessibility: true, screenRecording: true }
    : { apps: [{ name: "Editor", bundleId: "test.editor", running: true, pid: 123 }] };
  process.stdout.write(JSON.stringify({ id: request.id, status: "succeeded", result }) + "\\n");
});
`,
      { mode: 0o755 },
    );
  }
  const driver = new ComputerUseDriverController(
    options.driver === "okou"
      ? {
          id: "okou",
          createBackend: () => createComputerUseNativeBackend({ helperPath }),
        }
      : createCuaComputerUseDriver({
          runtimeRoot: "/packaged/cua",
          hostBundleId: "ai.okou.desktop",
          loadSdk: async () => {
            if (options.startupFailure) throw new Error("SDK load failed");
            return external.sdk;
          },
        }),
    "darwin",
  );
  const permissions = createComputerUsePermissions((read) =>
    driver.withPermissionProvider(read),
  );
  await writeFile(
    path.join(directory, "document.txt"),
    "plugin remains independent",
  );
  let notify = () => {};
  const plugin = new DesktopFilesystemPluginManager({
    preferencesPath: path.join(directory, "preferences.json"),
    onChange: () => notify(),
  });
  plugin.load();
  plugin.setFeatureEnabled(pluginEnabled);
  plugin.addAllowedDirectory(directory);
  plugin.setEnabled(pluginEnabled);
  const timers = new Map<
    ReturnType<typeof setTimeout>,
    { run: () => void; delay: number; due: number }
  >();
  const schedule = (run: () => void, delay: number) => {
    const id = setTimeout(() => {}, 2 ** 30);
    id.unref();
    timers.set(id, { run, delay, due: monotonic + delay });
    return id;
  };
  const clear: typeof clearTimeout = (id) => {
    if (typeof id === "object") timers.delete(id);
    clearTimeout(id);
  };
  let now = options.wallTime ?? Date.now();
  const serverNow = Date.parse("2026-09-08T02:44:36.980Z");
  let monotonic = 0;
  const budgetTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const commandClock: ComputerUseCommandClock = {
    wallNow: () => now,
    monotonicNow: () => monotonic,
    setTimeout: (run, delay) => {
      const id = schedule(run, delay);
      budgetTimers.set(id, run);
      return id;
    },
    clearTimeout: (id) => {
      if (typeof id === "object") budgetTimers.delete(id);
      clear(id);
    },
  };
  const config = resolveDesktopConfig(undefined, "okou");
  const api = "https://api.okou.ai";
  const addClientHeaders = createDesktopClientHeaderInjector({
    clientVersion: "1.2.3",
  });
  const auth = new DesktopAuthSession({
    apiBaseUrl: api,
    addClientHeaders,
    tokenUrl: buildDesktopAuthTokenUrl(config.authUrl),
    selectOrgUrl: buildDesktopAuthSelectOrgUrl(config.authUrl, true),
    consumeUrl: (code, id) =>
      buildDesktopAuthConsumeUrl(config.authUrl, code, id),
    runAuthWindow: async () => "token",
  });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let command: ComputerUseCommand | null = null;
  let completion = deferred<Record<string, unknown>>();
  let claimGate: ReturnType<typeof deferred<void>> | null = null;
  const claimEntered = deferred<void>();
  let streamClaim = false;
  let respondToCompletion: (request: Request) => Promise<Response> = async () =>
    HttpResponse.json({ ok: true });
  const controller = new ComputerUseRuntimeController({
    driver,
    refreshPermissions: permissions.refreshComputerUsePermissionState,
    getAuthState: () => auth.getAuthState(),
    setHostRuntimeOnline: (online) => plugin.setHostRuntimeOnline(online),
    getPluginCapabilities: () => plugin.getCapabilities(),
    preparePlugins: () => plugin.prepareForHost(),
    createRuntime: () =>
      createDesktopComputerUseHostRuntime(
        {
          platformUrl: config.platformUrl,
          installationId: "00000000-0000-4000-8000-000000000001",
          hostName: "host",
          appVersion: "1.2.3",
          hostFetch: (input, init) =>
            fetch(
              input,
              options.ignoreNetworkAbort
                ? { ...init, signal: undefined }
                : init,
            ),
          addClientHeaders,
          getPermissions: permissions.refreshComputerUsePermissionState,
          getSupportedCapabilities: () => [
            ...driver.getCapabilities(),
            ...plugin.getCapabilities(),
          ],
          driver,
          executePluginCommand: (command) => plugin.execute(command),
          setTimeout: schedule,
          clearTimeout: clear,
          commandClock,
        },
        { getAuthSession: () => auth },
      ),
  });
  notify = () => {
    plugin.setHostRuntimeOnline(controller.pluginsMayRun());
    if (
      options.stopDuringPreparation &&
      plugin.getState().status === "starting"
    )
      void controller.stop();
  };
  server.use(
    http.all(`${api}/*`, async ({ request }) => {
      const url = new URL(request.url);
      const body =
        request.method === "POST"
          ? ((await request.json()) as Record<string, unknown>)
          : {};
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/api/auth/me")
        return HttpResponse.json({
          userId: "user",
          email: "test@example.test",
          orgId: "org",
        });
      if (url.pathname === "/api/org")
        return HttpResponse.json({ id: "org", name: "Workspace" });
      if (url.pathname.endsWith("/hosts/start"))
        return HttpResponse.json({ hostId: "host", hostToken: "host-token" });
      if (url.pathname.endsWith("/next")) {
        const next = command;
        command = null;
        if (next && claimGate) {
          if (streamClaim) {
            const gate = claimGate;
            return new HttpResponse(
              new ReadableStream({
                async start(writer) {
                  claimEntered.resolve();
                  await gate.promise;
                  writer.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({ status: "command", command: next }),
                    ),
                  );
                  writer.close();
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          claimEntered.resolve();
          await claimGate.promise;
        }
        return HttpResponse.json(
          next ? { status: "command", command: next } : { status: "idle" },
        );
      }
      if (url.pathname.endsWith("/complete")) {
        completion.resolve(body);
        return respondToCompletion(request);
      }
      return HttpResponse.json({ ok: true });
    }),
  );
  cleanups.push(async () => {
    await controller.stopForQuit();
    plugin.setHostRuntimeOnline(false);
    for (const id of timers.keys()) clear(id);
    await rm(directory, { recursive: true, force: true });
  });
  await controller.start();
  return {
    external,
    driver,
    controller,
    requests,
    directory,
    plugin,
    serverNow,
    nativeLog: () => readFile(nativeLog, "utf8"),
    setWall(time: number) {
      now = time;
    },
    reportWith(respond: typeof respondToCompletion) {
      respondToCompletion = respond;
    },
    hasReportingTimer(delay: number) {
      return [...timers].some(
        ([id, timer]) => budgetTimers.has(id) && timer.delay === delay,
      );
    },
    runReportingTimer(delay: number) {
      const entry = [...timers].find(
        ([id, timer]) => budgetTimers.has(id) && timer.delay === delay,
      );
      if (!entry) throw new Error(`No reporting timer for ${delay}ms`);
      clear(entry[0]);
      budgetTimers.delete(entry[0]);
      entry[1].run();
    },
    delayClaim(body = false) {
      streamClaim = body;
      claimGate = deferred();
      return {
        entered: claimEntered.promise,
        release: () => claimGate?.resolve(),
      };
    },
    expirePoll() {
      const timer = [...timers.values()].find(
        (timer) => timer.delay === 30_000,
      );
      if (!timer) throw new Error("No command poll deadline is scheduled");
      timer.run();
    },
    elapse(ms: number) {
      now += ms;
      monotonic += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= monotonic) {
          clear(id);
          budgetTimers.delete(id);
          timer.run();
        }
      }
    },
    advance(ms: number) {
      now += ms;
      monotonic += ms;
    },
    expire() {
      monotonic += 120_000;
      for (const run of budgetTimers.values()) run();
    },
    queue(
      kind: string,
      payload: Record<string, unknown>,
      metadata: Partial<ComputerUseCommand> = {},
    ) {
      completion = deferred();
      command = {
        id: "command",
        kind,
        payload,
        timeoutMs: 30_000,
        createdAt: new Date(serverNow).toISOString(),
        claimedAt: new Date(serverNow).toISOString(),
        ...metadata,
      };
      const poll = [...timers].find(
        ([, timer]) =>
          timer.delay === 5000 || timer.delay === 0 || timer.delay === 500,
      );
      if (!poll) throw new Error("No native/plugin claim admitted");
      clear(poll[0]);
      poll[1].run();
      return completion.promise;
    },
  };
}

it("starts and completes real filesystem plugin work without native TCC or a native lease", async () => {
  const d = await desktop(false, true);
  expect(d.controller.getHostState().status).toBe("online");
  const registration = d.requests.find((request) =>
    request.path.endsWith("/hosts/start"),
  );
  expect(registration?.body.supportedCapabilities).not.toEqual([]);
  expect(registration?.body.supportedCapabilities).not.toContain("app.state");
  expect(d.driver.getCapabilities()).toEqual([]);
  const before = d.external.calls.length;
  const completed = await d.queue("plugin.call", {
    plugin: "filesystem",
    tool: "read_text_file",
    arguments: { path: path.join(d.directory, "document.txt") },
  });
  expect(completed.status).toBe("succeeded");
  expect(JSON.stringify(completed)).toContain("plugin remains independent");
  expect(d.external.calls.slice(before)).toEqual([]);
  expect(d.external.sessions).toBe(0);
});

it("does not register a capability-empty host", async () => {
  const d = await desktop(false);
  expect(d.controller.getHostState().status).toBe("offline");
  expect(
    d.requests.some((request) => request.path.endsWith("/hosts/start")),
  ).toBe(false);
});

it("keeps an authorized plugin-only host after CUA startup failure", async () => {
  const d = await desktop(true, true, { startupFailure: true });
  expect(d.controller.getHostState().status).toBe("online");
  expect(d.driver.getCapabilities()).toEqual([]);
  expect(
    await d.queue("plugin.call", {
      plugin: "filesystem",
      tool: "read_text_file",
      arguments: { path: path.join(d.directory, "document.txt") },
    }),
  ).toMatchObject({ status: "succeeded" });
});

it("does not revive a plugin or host when Stop supersedes plugin-only preparation", async () => {
  const d = await desktop(false, true, { stopDuringPreparation: true });
  expect(d.controller.getHostState().status).toBe("offline");
  expect(d.plugin.getState().status).toBe("disabled");
  expect(d.plugin.getCapabilities()).toEqual([]);
  expect(d.requests.some((r) => r.path.endsWith("/hosts/start"))).toBe(false);
});

it.each(["lost grants", "unexpected exit"])(
  "keeps plugin ownership after %s withdraws native capabilities",
  async (failure) => {
    const d = await desktop(true, true);
    await d.plugin.prepareForHost();
    if (failure === "lost grants") {
      d.external.granted = false;
      await d.driver.withPermissionProvider((provider) =>
        provider.getPermissions(),
      );
    } else {
      d.external.crash();
      await d.external.stopEntered.promise;
    }
    expect(d.driver.getCapabilities()).toEqual([]);
    const completed = await d.queue("plugin.call", {
      plugin: "filesystem",
      tool: "read_text_file",
      arguments: { path: path.join(d.directory, "document.txt") },
    });
    expect(completed.status).toBe("succeeded");
    expect(d.controller.getHostState().status).toBe("online");
    expect(
      d.requests.filter((r) => r.path.endsWith("/next")).at(-1)?.body
        .supportedCapabilities,
    ).not.toContain("app.state");
  },
);

it("owns a late claim but refuses it when its original wire budget has expired", async () => {
  const d = await desktop();
  const gate = d.delayClaim();
  const completed = d.queue("app.open", { app: "test.editor" });
  await gate.entered;
  d.advance(31_000);
  gate.release();
  expect(await completed).toMatchObject({
    status: "failed",
    error: { code: "command_timeout" },
  });
  expect(d.external.calls.some((call) => call.name === "launch_app")).toBe(
    false,
  );
});

it("completes a late claim after network cancellation without dispatching its action", async () => {
  const d = await desktop(true, false, { ignoreNetworkAbort: true });
  const gate = d.delayClaim();
  const completed = d.queue(
    "app.open",
    { app: "test.editor" },
    { timeoutMs: 60_000 },
  );
  await gate.entered;
  d.advance(31_000);
  d.expirePoll();
  gate.release();
  expect(await completed).toMatchObject({
    status: "failed",
    error: {
      code: "command_timeout",
      message: expect.stringContaining("no native action was dispatched"),
    },
  });
  expect(d.external.calls.some((call) => call.name === "launch_app")).toBe(
    false,
  );
});

it("preserves the existing plugin host and authorization when a selected replacement fails", async () => {
  const d = await desktop(true, true);
  await d.plugin.prepareForHost();
  await expect(
    d.controller.transitionDriver(
      createCuaComputerUseDriver({
        runtimeRoot: "/packaged/cua",
        hostBundleId: "ai.okou.desktop",
        loadSdk: async () => {
          throw new Error("replacement unavailable");
        },
      }),
    ),
  ).rejects.toThrow();
  expect(d.driver.getCapabilities()).toEqual([]);
  expect(
    await d.queue("plugin.call", {
      plugin: "filesystem",
      tool: "read_text_file",
      arguments: { path: path.join(d.directory, "document.txt") },
    }),
  ).toMatchObject({ status: "succeeded" });
  expect(
    d.requests.filter((r) => r.path.endsWith("/hosts/start")),
  ).toHaveLength(1);
  expect(d.requests.some((r) => r.path.endsWith("/host/stop"))).toBe(false);
});

it.each([
  { timeoutMs: 30_000, age: 30_001 },
  { timeoutMs: 60_000, age: 60_001 },
  { timeoutMs: null, age: 120_001 },
  { timeoutMs: 30_000, age: 0, createdAt: "malformed" },
])(
  "refuses an expired/malformed wire budget before permission or action ($timeoutMs)",
  async ({ timeoutMs, age, createdAt }) => {
    const d = await desktop();
    const before = d.external.calls.length;
    const completed = await d.queue(
      "app.open",
      { app: "test.editor" },
      {
        timeoutMs,
        createdAt:
          createdAt ?? new Date(d.serverNow - age - 1000).toISOString(),
      },
    );
    expect(completed).toMatchObject({
      status: "failed",
      error: { code: "command_timeout" },
    });
    expect(d.external.calls.slice(before)).toEqual([]);
  },
);

it.each(["check_permissions", "session", "get_window_state", "launch_app"])(
  "expires one budget during %s and blocks late state publication",
  async (phase) => {
    const d = await desktop();
    const entered = deferred<void>();
    const resume = deferred<void>();
    d.external.intercept = async (name) => {
      if (name === phase) {
        entered.resolve();
        await resume.promise;
      }
    };
    const completed = d.queue(
      phase === "launch_app" ? "app.open" : "app.state",
      { app: "test.editor" },
    );
    await entered.promise;
    d.expire();
    await d.external.stopEntered.promise;
    expect(await completed).toMatchObject({
      status: "failed",
      error: { code: "command_timeout" },
    });
    expect(d.driver.getCapabilities()).toEqual([]);
    expect(d.external.destroyed).toBe(false);
    resume.resolve();
    await d.driver.retire();
    expect(d.external.destroyed).toBe(true);
  },
);

it("charges discovery time against action and post-state without resetting a 30-second CLI budget", async () => {
  const d = await desktop();
  d.external.intercept = async (name) => {
    if (name === "list_apps") d.advance(31_000);
  };
  const completed = await d.queue("app.open", { app: "test.editor" });
  expect(completed).toMatchObject({
    status: "failed",
    error: { code: "command_timeout" },
  });
  expect(d.driver.getCapabilities()).toEqual([]);
});

const observedClaim = {
  createdAt: "2026-09-08T02:44:35.425Z",
  claimedAt: "2026-09-08T02:44:36.980Z",
  timeoutMs: 10_000,
};

it.each(["okou", "cua"] as const)(
  "admits the user's actual server/Mac timestamp inversion through %s",
  async (driver) => {
    const d = await desktop(true, false, {
      driver,
      wallTime: Date.parse("2026-09-08T02:44:36.593Z"),
    });
    const completed = await d.queue("apps.list", {}, observedClaim);
    expect(completed).toMatchObject({
      status: "succeeded",
      result: {
        apps: expect.arrayContaining([
          expect.objectContaining({ bundleId: "test.editor" }),
        ]),
      },
    });
    expect(d.controller.getHostState().localCommandLog[0]).toMatchObject({
      startedAt: "2026-09-08T02:44:36.593Z",
      status: "succeeded",
      driver: { id: driver },
    });
    if (driver === "okou")
      expect(await d.nativeLog()).toContain('"kind":"apps.list"');
    else
      expect(d.external.calls.some((call) => call.name === "list_apps")).toBe(
        true,
      );
  },
);

for (const driver of ["okou", "cua"] as const) {
  it.each([-120_000, 120_000])(
    `${driver} admits a fresh server grant with a %s ms wall offset`,
    async (offset) => {
      const d = await desktop(true, false, { driver });
      d.setWall(d.serverNow + offset);
      expect(await d.queue("apps.list", {}, observedClaim)).toMatchObject({
        status: "succeeded",
      });
    },
  );

  it.each([false, true])(
    `${driver} charges delayed claim headers/body (%s) before any permission or native action`,
    async (body) => {
      const d = await desktop(true, false, { driver, wallTime: 0 });
      const before = d.external.calls.length;
      const nativeBefore = await d.nativeLog();
      const gate = d.delayClaim(body);
      const report = d.queue("apps.list", {}, observedClaim);
      await gate.entered;
      d.advance(8_500); // 1,555 ms server queue age + transport exceeds 10 seconds.
      gate.release();
      expect(await report).toMatchObject({
        status: "failed",
        error: { code: "command_timeout" },
      });
      expect(d.external.calls.slice(before)).toEqual([]);
      expect(await d.nativeLog()).toBe(nativeBefore);
    },
  );

  it.each([
    { claimedAt: null },
    { claimedAt: undefined },
    { claimedAt: "invalid" },
    { claimedAt: "2026-09-08T02:44:35.424Z" },
    { createdAt: undefined },
    { timeoutMs: undefined },
    { timeoutMs: 999 },
    { timeoutMs: 120_001 },
    { timeoutMs: 1000.5 },
    { createdAt: "2026-09-08T02:44:26.980Z" },
  ])(
    `${driver} fails closed on unprovable or expired successful-claim metadata %j`,
    async (metadata) => {
      const d = await desktop(true, false, { driver });
      const before = d.external.calls.length;
      const nativeBefore = await d.nativeLog();
      const report = await d.queue(
        "apps.list",
        {},
        { ...observedClaim, ...metadata },
      );
      expect(report).toMatchObject({
        status: "failed",
        error: { code: "command_timeout" },
      });
      expect(d.external.calls.slice(before)).toEqual([]);
      expect(await d.nativeLog()).toBe(nativeBefore);
    },
  );

  it(`${driver} accepts the existing nullable timeout default without new API fields`, async () => {
    const d = await desktop(true, false, { driver });
    expect(await d.queue("apps.list", {}, { timeoutMs: null })).toMatchObject({
      status: "succeeded",
    });
  });
}

it("does not renew a deadline after a backwards or forwards Mac wall-clock adjustment", async () => {
  const d = await desktop();
  d.external.intercept = async (name) => {
    if (name === "check_permissions") {
      d.setWall(d.serverNow + 120_000);
      d.advance(10_000);
      d.setWall(d.serverNow - 120_000);
    }
  };
  expect(
    await d.queue("app.open", { app: "test.editor" }, observedClaim),
  ).toMatchObject({
    status: "failed",
    error: { code: "command_timeout" },
  });
  expect(d.external.calls.some((call) => call.name === "launch_app")).toBe(
    false,
  );
  expect(d.driver.getCapabilities()).toEqual([]);
});

it("keeps a cancelled poll's delayed JSON body owned and reports without dispatch", async () => {
  const d = await desktop(true, false, { ignoreNetworkAbort: true });
  const gate = d.delayClaim(true);
  const report = d.queue("apps.list", {}, { timeoutMs: 60_000 });
  await gate.entered;
  d.advance(31_000);
  d.expirePoll();
  gate.release();
  expect(await report).toMatchObject({
    status: "failed",
    error: {
      code: "command_timeout",
      message: expect.stringContaining("polling deadline"),
    },
  });
  expect(d.external.calls.some((call) => call.name === "list_apps")).toBe(
    false,
  );
});

it("delivers an exhausted execution's original error after 100 ms of reporting latency", async () => {
  const d = await desktop();
  const received = deferred<void>();
  const response = deferred<void>();
  d.reportWith(async () => {
    received.resolve();
    await response.promise;
    return HttpResponse.json({ ok: true });
  });
  const report = d.queue(
    "apps.list",
    {},
    { ...observedClaim, createdAt: "2026-09-08T02:44:26.980Z" },
  );
  await received.promise;
  d.elapse(100);
  response.resolve();
  expect(await report).toMatchObject({
    status: "failed",
    error: { code: "command_timeout" },
  });
  await expect
    .poll(() => d.controller.getHostState().lastCommandAt)
    .not.toBeNull();
  expect(d.requests.filter((r) => r.path.endsWith("/complete"))).toHaveLength(
    1,
  );
});

it("bounds transient retries and an abort-ignoring reporting request by one five-second deadline", async () => {
  const d = await desktop(true, false, { ignoreNetworkAbort: true });
  const secondAttempt = deferred<void>();
  const lateResponse = deferred<void>();
  let attempts = 0;
  d.reportWith(async () => {
    attempts++;
    if (attempts === 1) return new HttpResponse(null, { status: 503 });
    secondAttempt.resolve();
    await lateResponse.promise;
    return HttpResponse.json({ ok: true });
  });
  await d.queue("apps.list", {}, { ...observedClaim, claimedAt: null });
  await expect.poll(() => attempts).toBe(1);
  // Wait for HTTP consumption to schedule the retry, without replacing async code.
  await expect.poll(() => d.hasReportingTimer(2_000)).toBe(true);
  d.runReportingTimer(2_000);
  d.advance(2_000);
  await secondAttempt.promise;
  d.advance(3_000);
  d.runReportingTimer(5_000);
  await expect
    .poll(() => d.controller.getHostState().status)
    .toBe("recovering");
  expect(d.controller.getHostState().lastError).toContain(
    "reporting timed out after 5000ms",
  );
  expect(attempts).toBe(2);
  // Neither the pending response nor its late success keeps the native lease.
  await d.driver.retire();
  lateResponse.resolve();
  expect(d.controller.getHostState().lastCommandAt).toBeNull();
  expect(d.external.calls.some((call) => call.name === "list_apps")).toBe(
    false,
  );
});

it.each(["stop", "sign-out", "quit"])(
  "%s cancels reporting and releases its lease without waiting for the reporting deadline",
  async (reason) => {
    const d = await desktop();
    const received = deferred<void>();
    const cancelled = deferred<void>();
    const respond = deferred<void>();
    d.reportWith(async (request) => {
      request.signal.addEventListener("abort", () => cancelled.resolve(), {
        once: true,
      });
      received.resolve();
      await respond.promise;
      return HttpResponse.json({ ok: true });
    });
    await d.queue("apps.list", {}, observedClaim);
    await received.promise;
    if (reason === "stop") await d.controller.stop();
    else if (reason === "sign-out") await d.controller.stopForAuthChange();
    else await d.controller.stopForQuit();
    await cancelled.promise;
    respond.resolve();
    expect(d.controller.getHostState().status).toBe("offline");
    expect(d.driver.getCapabilities()).toEqual([]);
    expect(d.external.destroyed).toBe(true);
    expect(d.requests.filter((r) => r.path.endsWith("/complete"))).toHaveLength(
      1,
    );
  },
);

it("retries only result delivery and preserves the original result on success", async () => {
  const d = await desktop();
  let attempts = 0;
  d.reportWith(async () =>
    ++attempts === 1
      ? new HttpResponse(null, { status: 503 })
      : HttpResponse.json({ ok: true }),
  );
  const result = await d.queue("apps.list", {}, observedClaim);
  await expect.poll(() => d.hasReportingTimer(2_000)).toBe(true);
  d.advance(2_000);
  d.runReportingTimer(2_000);
  await expect
    .poll(() => d.controller.getHostState().lastCommandAt)
    .not.toBeNull();
  expect(
    d.requests.filter((r) => r.path.endsWith("/complete")).map((r) => r.body),
  ).toEqual([result, result]);
  expect(
    d.external.calls.filter((call) => call.name === "list_apps"),
  ).toHaveLength(1);
});

it("accepts a terminal server completion without retrying or overwriting the local failure", async () => {
  const d = await desktop();
  d.reportWith(async () => new HttpResponse(null, { status: 409 }));
  const result = await d.queue(
    "apps.list",
    {},
    { ...observedClaim, claimedAt: null },
  );
  await expect
    .poll(() => d.controller.getHostState().lastCommandAt)
    .not.toBeNull();
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "command_timeout" },
  });
  expect(d.controller.getHostState().localCommandLog[0]?.status).toBe("failed");
  expect(d.requests.filter((r) => r.path.endsWith("/complete"))).toHaveLength(
    1,
  );
});

it("retains the original driver generation while a normal switch drains reporting", async () => {
  const d = await desktop();
  const received = deferred<void>();
  const response = deferred<void>();
  d.reportWith(async () => {
    received.resolve();
    await response.promise;
    return HttpResponse.json({ ok: true });
  });
  await d.queue("apps.list", {}, observedClaim);
  await received.promise;
  const generation = d.driver.generation;
  const replacement = cuaBoundary();
  const transition = d.controller.transitionDriver(
    createCuaComputerUseDriver({
      runtimeRoot: "/packaged/cua",
      hostBundleId: "ai.okou.desktop",
      loadSdk: async () => replacement.sdk,
    }),
  );
  expect(d.external.destroyed).toBe(false);
  expect(replacement.sessions).toBe(0);
  d.advance(100);
  response.resolve();
  await transition;
  expect(d.external.destroyed).toBe(true);
  expect(d.driver.generation).not.toBe(generation);
  expect(
    d.requests.filter((r) => r.path.endsWith("/hosts/start")),
  ).toHaveLength(1);
  expect(
    d.external.calls.filter((call) => call.name === "list_apps"),
  ).toHaveLength(1);
});

it("cancels retry backoff on Stop without further reporting or native work", async () => {
  const d = await desktop();
  d.reportWith(async () => new HttpResponse(null, { status: 503 }));
  await d.queue("apps.list", {}, observedClaim);
  await expect.poll(() => d.hasReportingTimer(2_000)).toBe(true);
  await d.controller.stop();
  expect(d.hasReportingTimer(2_000)).toBe(false);
  expect(d.hasReportingTimer(5_000)).toBe(false);
  expect(d.controller.getHostState().status).toBe("offline");
  expect(d.requests.filter((r) => r.path.endsWith("/complete"))).toHaveLength(
    1,
  );
  expect(
    d.external.calls.filter((call) => call.name === "list_apps"),
  ).toHaveLength(1);
});
