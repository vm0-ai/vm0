import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
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
    startupFailure?: boolean;
    stopDuringPreparation?: boolean;
    ignoreNetworkAbort?: boolean;
  } = {},
) {
  const external = cuaBoundary();
  external.granted = granted;
  const driver = new ComputerUseDriverController(
    createCuaComputerUseDriver({
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
  // macOS TMPDIR can contain /var -> /private/var aliases; MCP authorizes
  // canonical roots and validates the requested path before following symlinks.
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "cua-plugin-")),
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
    { run: () => void; delay: number }
  >();
  const schedule = (run: () => void, delay: number) => {
    const id = setTimeout(() => {}, 2 ** 30);
    id.unref();
    timers.set(id, { run, delay });
    return id;
  };
  const clear: typeof clearTimeout = (id) => {
    if (typeof id === "object") timers.delete(id);
    clearTimeout(id);
  };
  let now = Date.now();
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
  const api = "https://api.vm0.ai";
  const cookies = { cookies: { get: async () => [] } };
  const addClientHeaders = createDesktopClientHeaderInjector({
    product: "okou",
    clientVersion: "1.2.3",
  });
  const auth = new DesktopAuthSession({
    product: "okou",
    apiBaseUrl: api,
    cookieUrls: [config.webUrl, config.platformUrl],
    cookieSource: cookies,
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
        { product: "okou", session: cookies, getAuthSession: () => auth },
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
          claimEntered.resolve();
          await claimGate.promise;
        }
        return HttpResponse.json(
          next ? { status: "command", command: next } : { status: "idle" },
        );
      }
      if (url.pathname.endsWith("/complete")) completion.resolve(body);
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
    delayClaim() {
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
        createdAt: new Date(now).toISOString(),
        claimedAt: null,
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
        createdAt: createdAt ?? new Date(Date.now() - age - 1000).toISOString(),
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
