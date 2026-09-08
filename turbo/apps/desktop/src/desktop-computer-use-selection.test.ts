import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  ComputerUseDriverController,
  type ComputerUseDriver,
} from "./computer-use-driver";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { createCuaComputerUseDriver } from "./computer-use-cua";
import { createDesktopComputerUsePermissions } from "./desktop-computer-use-permissions";
import { DesktopComputerUseDriverPreferences } from "./desktop-computer-use-driver-preferences";
import { DesktopComputerUseDriverSelection } from "./desktop-computer-use-driver-selection";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import { DeveloperToolsController } from "./desktop-developer-tools-controller";
import { desktopDeveloperToolsMenu } from "./desktop-developer-tools-menu";
import { DesktopAuthSession } from "./desktop-auth-session";
import { createDesktopComputerUseHostRuntime } from "./desktop-computer-use-api";
import { DesktopKeepAwakeController } from "./desktop-keep-awake";
import { DesktopFilesystemPluginManager } from "./desktop-filesystem-plugin";
import { readOrCreateComputerUseInstallationId } from "./desktop-computer-use-installation";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import { shouldDeferDesktopUpdate } from "./desktop-auto-update-policy";
import type { ComputerUseCommand } from "./computer-use-accessibility";
import { cuaBoundary, deferred } from "./test/cua-boundary";

const api = "https://api.vm0.ai";
const server = setupServer();
const cleanups: (() => Promise<void>)[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function desktop(initial?: string) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "desktop-driver-selection-"),
  );
  const file = path.join(directory, "preferences.json");
  const helper = path.join(directory, "helper.cjs");
  const nativeEvents = path.join(directory, "native-events");
  writeFileSync(nativeEvents, "");
  if (initial !== undefined) writeFileSync(file, initial);
  // The actuator is an external process; the real native protocol client,
  // generation owner, executor, auth, host and shared preference writers run.
  writeFileSync(
    helper,
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(nativeEvents)}, 'start\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  const result=r.kind.startsWith('permissions.') ? {accessibility:true,screenRecording:true} : {apps:[{name:'Okou fixture',bundleId:'test.editor'}]};
  process.stdout.write(JSON.stringify({id:r.id,status:'succeeded',result})+'\\n');
});
`,
  );
  chmodSync(helper, 0o755);
  let identity = "first";
  let debug = true;
  let hostGranted = true;
  let failLoad = false;
  let featureRead: (() => Promise<void>) | null = null;
  let configureCua: (
    boundary: ReturnType<typeof cuaBoundary>,
  ) => void = () => {};
  const boundaries: ReturnType<typeof cuaBoundary>[] = [];
  const requests: { path: string; body: unknown }[] = [];
  const pending = new Set<Promise<void>>();
  const own = (work: Promise<void>) => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
  };
  const timers = new Map<
    ReturnType<typeof setTimeout>,
    { run: () => void; delay: number }
  >();
  const schedule = (run: () => void, delay: number) => {
    const timer = setTimeout(() => {}, 2 ** 30);
    timer.unref();
    timers.set(timer, { run, delay });
    return timer;
  };
  const clear: typeof clearTimeout = (timer) => {
    if (typeof timer === "object") timers.delete(timer);
    clearTimeout(timer);
  };
  const tick = (delay: number) => {
    const found = [...timers].find(([, item]) => item.delay === delay);
    if (!found) throw new Error(`No lifecycle timer for ${delay}`);
    clear(found[0]);
    found[1].run();
  };
  const headers = createDesktopClientHeaderInjector({
    product: "okou",
    clientVersion: "1.2.3",
  });
  const cookies = { cookies: { get: async () => [] } };
  let authChanged = () => {};
  const auth = new DesktopAuthSession({
    product: "okou",
    apiBaseUrl: api,
    cookieUrls: [],
    cookieSource: cookies,
    addClientHeaders: headers,
    tokenUrl: `${api}/token`,
    selectOrgUrl: `${api}/select-org`,
    consumeUrl: () => `${api}/consume`,
    runAuthWindow: async () => identity,
    onChange: () => authChanged(),
  });
  let developerChanged = () => {};
  const developer = new DeveloperToolsController({
    getSessionAuthority: () => auth.getAuthority(),
    fetchFeatureSwitches: () =>
      auth.fetchWithSessionAuth(new URL(`${api}/api/feature-switches`)),
    setFilesystemPluginFeatureEnabled: () => {},
    setScreenRecordingFeatureEnabled: () => {},
    onChange: () => developerChanged(),
  });
  const preference = new DesktopComputerUseDriverPreferences(() => file);
  preference.load();
  const okou: ComputerUseDriver = {
    id: "okou",
    buildVersion: "1.2.3",
    createBackend: () => createComputerUseNativeBackend({ helperPath: helper }),
  };
  const cua: ComputerUseDriver = {
    ...createCuaComputerUseDriver({
      runtimeRoot: "/packaged/cua",
      hostBundleId: "ai.okou.desktop",
      loadSdk: async () => {
        if (failLoad)
          throw new Error("/private/session-secret/socket token=secret");
        const external = cuaBoundary();
        configureCua(external);
        boundaries.push(external);
        return external.sdk;
      },
    }),
    getAuthorization: () => developer.getAuthorization(),
  };
  const driver = new ComputerUseDriverController(okou, "darwin");
  const permissions = createDesktopComputerUsePermissions({
    driver,
    requestedDriver: () => preference.getState().selectedDriver,
    transitioning: () => controller.isTransitioning(),
    host: {
      getPermissions: async () => ({
        accessibility: hostGranted,
        screenRecording: hostGranted,
      }),
      requestAccessibilityPermission: async () => ({
        accessibility: hostGranted,
        screenRecording: hostGranted,
      }),
      requestScreenRecordingPermission: async () => ({
        accessibility: hostGranted,
        screenRecording: hostGranted,
      }),
      probeAutomationPermission: async () => ({
        status: "unknown",
        reason: null,
        updatedAt: null,
      }),
    },
  });
  const plugin = new DesktopFilesystemPluginManager({
    preferencesPath: file,
    onChange: () => {},
  });
  let command: ComputerUseCommand | null = null;
  const completed = deferred<unknown>();
  let completionGate: Promise<void> = Promise.resolve();
  let hostStarts = 0;
  const controller = new ComputerUseRuntimeController({
    driver,
    refreshPermissions: permissions.refreshComputerUsePermissionState,
    prepareNative: permissions.prepareNative,
    nativeBlockReason: (driver) => selection.blockReason(driver),
    getAuthState: () => auth.getAuthState(),
    setHostRuntimeOnline: (online) => plugin.setHostRuntimeOnline(online),
    getPluginCapabilities: () => plugin.getCapabilities(),
    preparePlugins: () => plugin.prepareForHost(),
    transitionTimeoutMs: 1234,
    lifecycleTimers: { setTimeout: schedule, clearTimeout: clear },
    createRuntime: () =>
      createDesktopComputerUseHostRuntime(
        {
          platformUrl: new URL("https://app.okou.ai"),
          installationId: readOrCreateComputerUseInstallationId(file),
          hostName: "fixture",
          appVersion: "1.2.3",
          addClientHeaders: headers,
          hostFetch: (input, init) => fetch(input, init),
          getPermissions: permissions.refreshReady,
          getSupportedCapabilities: () => [
            ...driver.getCapabilities(),
            ...plugin.getCapabilities(),
          ],
          driver,
          executePluginCommand: (command) => plugin.execute(command),
          setTimeout: schedule,
          clearTimeout: clear,
        },
        { product: "okou", session: cookies, getAuthSession: () => auth },
      ),
  });
  const selection = new DesktopComputerUseDriverSelection({
    preferences: preference,
    developer,
    runtime: controller,
    drivers: { okou, cua },
    onChange: () => {},
  });
  let lastAuth: object | null = null;
  let lastDeveloper: object | null = null;
  authChanged = () => {
    const current = auth.getAuthority();
    if (lastAuth !== current) {
      lastAuth = current;
      permissions.resetComputerUsePermissionState();
      if (
        selection.requestedDriver().id === "cua" ||
        driver.selectedDriver.id === "cua"
      )
        own(controller.stopForAuthChange());
    }
    developer.requestRefresh();
  };
  developerChanged = () => {
    const current = developer.getAuthorization();
    if (lastDeveloper !== current) {
      lastDeveloper = current;
      own(controller.refreshDriverAuthorization());
    }
  };
  server.use(
    http.all(`${api}/*`, async ({ request }) => {
      const url = new URL(request.url);
      const body: unknown =
        request.method === "POST" ? await request.json() : null;
      requests.push({ path: url.pathname, body });
      const user =
        request.headers.get("authorization")?.replace("Bearer ", "") ??
        "unknown";
      if (url.pathname === "/api/auth/me")
        return HttpResponse.json({
          userId: user,
          email: "fixture@example.test",
          orgId: `org-${user}`,
        });
      if (url.pathname === "/api/org")
        return HttpResponse.json({ id: `org-${user}`, name: "Workspace" });
      if (url.pathname === "/api/feature-switches") {
        const enabled = debug;
        await featureRead?.();
        return HttpResponse.json({ effectiveSwitches: { _debug: enabled } });
      }
      if (url.pathname.endsWith("/hosts/start"))
        return HttpResponse.json({
          hostId: `host-${++hostStarts}`,
          hostToken: "host-token",
        });
      if (url.pathname.endsWith("/commands/next")) {
        const next = command;
        command = null;
        return HttpResponse.json(
          next
            ? {
                status: "command",
                command: {
                  ...next,
                  timeoutMs: 60_000,
                  createdAt: new Date().toISOString(),
                  claimedAt: null,
                },
              }
            : { status: "idle" },
        );
      }
      if (url.pathname.endsWith("/complete")) {
        completed.resolve(body);
        await completionGate;
      }
      return HttpResponse.json({});
    }),
  );
  cleanups.push(async () => {
    await controller.stopForQuit();
    await Promise.allSettled([...pending]);
    plugin.stop();
    for (const timer of timers.keys()) clear(timer);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    auth,
    developer,
    preference,
    selection,
    controller,
    driver,
    permissions,
    boundaries,
    requests,
    file,
    plugin,
    directory,
    tick,
    completed,
    nativeStarts: () =>
      readFileSync(nativeEvents, "utf8").split("start\n").length - 1,
    restore: () => controller.transitionDriver(selection.requestedDriver()),
    async authorize() {
      await auth.getAuthState();
      developer.requestRefresh();
      await vi.waitFor(() =>
        expect(developer.getAvailability()).toBe("available"),
      );
    },
    set identity(value: string) {
      identity = value;
    },
    set debug(value: boolean) {
      debug = value;
    },
    set featureRead(value: (() => Promise<void>) | null) {
      featureRead = value;
    },
    set hostGranted(value: boolean) {
      hostGranted = value;
    },
    set failLoad(value: boolean) {
      failLoad = value;
    },
    set configureCua(value: typeof configureCua) {
      configureCua = value;
    },
    set command(value: ComputerUseCommand) {
      command = value;
    },
    set completionGate(value: Promise<void>) {
      completionGate = value;
    },
  };
}

it.each([
  undefined,
  "{}",
  '{"computerUseDriver":{"experimentalCuaEnabled":false,"selectedDriver":"okou"}}',
  '{"computerUseDriver":{"experimentalCuaEnabled":false,"selectedDriver":"cua"}}',
  '{"computerUseDriver":{"experimentalCuaEnabled":"true","selectedDriver":"cua"}}',
  '{"computerUseDriver":{"experimentalCuaEnabled":true,"selectedDriver":"other"}}',
])(
  "starts the default lane for missing or invalid preferences: %s",
  async (stored) => {
    const app = desktop(stored);
    await app.authorize();
    await app.restore();
    await app.controller.start();
    expect(app.selection.getState()).toMatchObject({
      selectedDriver: "okou",
      experimentalCuaEnabled: false,
      actual: { id: "okou", version: "1.2.3" },
      phase: "ready",
    });
    expect(app.boundaries).toHaveLength(0);
    const actual = app.selection.getState().actual;
    const authority = app.developer.getAuthorization();
    const menu = desktopDeveloperToolsMenu(app.developer);
    expect(menu).toEqual([
      {
        label: "Developer Tools",
        type: "checkbox",
        checked: false,
        click: expect.any(Function),
      },
      { type: "separator" },
    ]);
    menu[0]?.click?.();
    expect(app.developer.getState()).toEqual({
      available: true,
      enabled: true,
    });
    expect(desktopDeveloperToolsMenu(app.developer)[0]?.checked).toBe(true);
    desktopDeveloperToolsMenu(app.developer)[0]?.click?.();
    expect(app.developer.getState()).toEqual({
      available: true,
      enabled: false,
    });
    expect(app.developer.getAuthorization()).toBe(authority);
    expect(app.selection.getState()).toMatchObject({
      selectedDriver: "okou",
      experimentalCuaEnabled: false,
      actual,
    });
    expect(app.boundaries).toHaveLength(0);
  },
);

it.each([
  undefined,
  '{"computerUseDriver":{"experimentalCuaEnabled":false,"selectedDriver":"okou"}}',
  '{"computerUseDriver":{"experimentalCuaEnabled":true,"selectedDriver":"okou"}}',
])(
  "commits explicit CUA choice and opt-in together without starting a stopped host: %s",
  async (stored) => {
    const app = desktop(stored);
    await app.authorize();
    await app.controller.stop();
    const selecting = app.selection.select("cua");
    expect(
      JSON.parse(readFileSync(app.file, "utf8")).computerUseDriver,
    ).toEqual({
      experimentalCuaEnabled: true,
      selectedDriver: "cua",
    });
    await selecting;
    expect(app.selection.getState()).toMatchObject({
      experimentalCuaEnabled: true,
      selectedDriver: "cua",
      phase: "stopped",
      actual: null,
    });
    expect(app.boundaries).toHaveLength(0);
    expect(app.nativeStarts()).toBe(0);
    const restored = new DesktopComputerUseDriverPreferences(() => app.file);
    restored.load();
    expect(restored.getState()).toEqual(app.preference.getState());
  },
);

it("rejects CUA selection without current authority even if the panel was enabled", async () => {
  const app = desktop();
  expect(desktopDeveloperToolsMenu(app.developer)).toEqual([]);
  await expect(app.selection.select("cua")).rejects.toThrow("Developer access");
  await app.authorize();
  desktopDeveloperToolsMenu(app.developer)[0]?.click?.();
  app.auth.signOut();
  expect(app.developer.getAuthorization()).toBeNull();
  await expect(app.selection.select("cua")).rejects.toThrow("Developer access");
  expect(app.preference.getState()).toEqual({
    experimentalCuaEnabled: false,
    selectedDriver: "okou",
    preferenceError: null,
  });
  expect(app.boundaries).toHaveLength(0);
});

it("fails closed when saving the initial CUA choice fails", async () => {
  const stored =
    '{"computerUseDriver":{"experimentalCuaEnabled":false,"selectedDriver":"okou"}}';
  const app = desktop(stored);
  await app.authorize();
  // Reads succeed, but the atomic writer cannot create a temporary file.
  chmodSync(app.directory, 0o500);
  try {
    await expect(app.selection.select("cua")).rejects.toThrow(
      "could not be saved",
    );
  } finally {
    chmodSync(app.directory, 0o700);
  }
  expect(readFileSync(app.file, "utf8")).toBe(stored);
  expect(app.preference.getState()).toMatchObject({
    experimentalCuaEnabled: false,
    selectedDriver: "okou",
    preferenceError: expect.stringContaining("could not be saved"),
  });
  expect(app.selection.blockReason(app.selection.requestedDriver())).toContain(
    "could not be saved",
  );
  await app.controller.start({ userInitiated: true });
  expect(app.selection.getState()).toMatchObject({
    actual: null,
    phase: "blocked",
  });
  expect(app.boundaries).toHaveLength(0);
  expect(app.nativeStarts()).toBe(0);
});

it("keeps an admitted CUA command and its completion alive while the menu hides and restores tools", async () => {
  const app = desktop();
  await app.authorize();
  await app.selection.select("cua");
  await app.controller.start({ userInitiated: true });
  const original = app.selection.getState().actual;
  const host = app.controller.getHostState().hostId;
  const persisted = readFileSync(app.file, "utf8");
  const gate = deferred<void>();
  app.completionGate = gate.promise;
  app.command = { id: "command", kind: "apps.list", payload: {} };
  app.tick(5000);
  await app.completed.promise;
  for (const enabled of [true, false, true]) {
    desktopDeveloperToolsMenu(app.developer)[0]?.click?.();
    expect(app.developer.getState().enabled).toBe(enabled);
    expect(app.selection.getState()).toMatchObject({
      selectedDriver: "cua",
      experimentalCuaEnabled: true,
      actual: original,
      phase: "ready",
    });
    expect(app.boundaries).toHaveLength(1);
    expect(app.boundaries[0]?.live).toBe(true);
    expect(readFileSync(app.file, "utf8")).toBe(persisted);
  }
  gate.resolve();
  await vi.waitFor(() =>
    expect(app.controller.getHostState().localCommandLog).toHaveLength(1),
  );
  expect(app.controller.getHostState().localCommandLog[0]).toMatchObject({
    status: "succeeded",
    driver: original,
  });
  expect(app.controller.getHostState().hostId).toBe(host);
  expect(app.nativeStarts()).toBe(0);
});

it("restores CUA as a request without passive activation, and keeps manual Stop across selections and availability refresh", async () => {
  const app = desktop(
    '{"computerUseDriver":{"experimentalCuaEnabled":true,"selectedDriver":"cua"}}',
  );
  app.auth.signOut();
  await app.restore();
  await app.permissions.refreshComputerUsePermissionState();
  await app.permissions.requestComputerUseAccessibilityPermission();
  expect(app.boundaries).toHaveLength(0);
  expect(app.nativeStarts()).toBe(0);
  expect(app.selection.getState()).toMatchObject({
    actual: null,
    selectedDriver: "cua",
    phase: "blocked",
  });
  await app.auth.consumeCode("explicit");
  await app.authorize();
  await app.controller.start({ userInitiated: true });
  expect(app.selection.getState()).toMatchObject({
    actual: { id: "cua", version: "0.23.2" },
    phase: "ready",
  });
  await app.controller.stop();
  const generations = app.boundaries.length;
  await app.selection.select("okou");
  await app.selection.select("cua");
  await app.permissions.refreshComputerUsePermissionState();
  app.developer.requestRefresh();
  await vi.waitFor(() =>
    expect(app.developer.getAvailability()).toBe("available"),
  );
  await app.controller.start();
  expect(app.boundaries).toHaveLength(generations);
  expect(app.nativeStarts()).toBe(0);
  expect(app.controller.getHostState().status).toBe("offline");
});

it("preserves shared installation, keep-awake and plugin writes, and never overwrites corrupt settings", async () => {
  const app = desktop();
  await app.authorize();
  const installation = readOrCreateComputerUseInstallationId(app.file);
  const awake = new DesktopKeepAwakeController({
    preferencesPath: app.file,
    blocker: { start: () => 1, stop: () => {}, isStarted: () => true },
    onChange: () => {},
  });
  awake.load();
  awake.setEnabled(true);
  app.plugin.load();
  app.plugin.addAllowedDirectory(app.directory);
  await app.selection.select("cua");
  const restored = new DesktopComputerUseDriverPreferences(() => app.file);
  restored.load();
  expect(restored.getState()).toMatchObject({
    experimentalCuaEnabled: true,
    selectedDriver: "cua",
  });
  expect(readOrCreateComputerUseInstallationId(app.file)).toBe(installation);
  expect(JSON.parse(readFileSync(app.file, "utf8"))).toMatchObject({
    keepAwakeEnabled: true,
    computerUseInstallationId: installation,
  });
  writeFileSync(app.file, '["corrupt"]');
  await expect(app.selection.select("okou")).rejects.toThrow(
    "could not be saved",
  );
  expect(readFileSync(app.file, "utf8")).toBe('["corrupt"]');
  restored.load();
  expect(restored.getState()).toMatchObject({
    selectedDriver: "okou",
    experimentalCuaEnabled: false,
  });
  expect(restored.getState().preferenceError).not.toBeNull();
});

it("uses the latest alternating selection without overlapping executors or restarting the host", async () => {
  const app = desktop();
  await app.authorize();
  await app.controller.start();
  const host = app.controller.getHostState().hostId;
  await Promise.all([
    app.selection.select("cua"),
    app.selection.select("okou"),
    app.selection.select("cua"),
  ]);
  expect(app.selection.getState()).toMatchObject({
    selectedDriver: "cua",
    actual: { id: "cua", version: "0.23.2" },
    phase: "ready",
  });
  expect(app.boundaries).toHaveLength(1);
  expect(app.boundaries[0]?.live).toBe(true);
  expect(app.controller.getHostState().hostId).toBe(host);
  expect(
    app.requests.filter((r) => r.path.endsWith("/hosts/start")),
  ).toHaveLength(1);
});

it("keeps disable honest until the original CUA command and completion drain, with pinned private diagnostics", async () => {
  const app = desktop();
  await app.authorize();
  await app.selection.select("cua");
  await app.controller.start({ userInitiated: true });
  const original = app.selection.getState().actual;
  const gate = deferred<void>();
  app.completionGate = gate.promise;
  app.command = { id: "command", kind: "apps.list", payload: {} };
  app.tick(5000);
  await app.completed.promise;
  const disable = app.selection.setExperiment(false);
  await vi.waitFor(() =>
    expect(app.selection.getState().phase).toBe("switching"),
  );
  expect(app.selection.getState()).toMatchObject({
    selectedDriver: "okou",
    experimentalCuaEnabled: false,
    actual: original,
  });
  expect(app.nativeStarts()).toBe(0);
  const diagnostic = app.controller.getHostState().localCommandLog[0]?.driver;
  expect(diagnostic).toEqual(original);
  expect(Object.keys(diagnostic ?? {}).sort()).toEqual([
    "generation",
    "id",
    "version",
  ]);
  gate.resolve();
  await disable;
  expect(app.selection.getState()).toMatchObject({
    phase: "ready",
    actual: { id: "okou" },
  });
  expect(app.boundaries[0]?.live).toBe(false);
  expect(app.controller.getHostState().localCommandLog[0]?.driver).toEqual(
    original,
  );
});

it("blocks stale Developer authority on a new account and retains the stored CUA request", async () => {
  const app = desktop();
  await app.authorize();
  await app.selection.select("cua");
  const entered = deferred<void>();
  const response = deferred<void>();
  app.featureRead = async () => {
    entered.resolve();
    await response.promise;
  };
  app.developer.requestRefresh();
  await entered.promise;
  app.identity = "second";
  app.debug = false;
  await app.auth.selectOrganization();
  expect(app.developer.getAuthorization()).toBeNull();
  await expect(app.selection.select("cua")).rejects.toThrow("Developer access");
  app.featureRead = null;
  response.resolve();
  await vi.waitFor(() =>
    expect(app.developer.getAvailability()).toBe("unavailable"),
  );
  await app.controller.start({ userInitiated: true });
  expect(app.selection.getState()).toMatchObject({
    selectedDriver: "cua",
    experimentalCuaEnabled: true,
    actual: null,
    phase: "blocked",
  });
  expect(app.boundaries).toHaveLength(0);
  expect(app.nativeStarts()).toBe(0);
  await app.selection.select("okou");
  expect(app.controller.getHostState().status).toBe("offline");
});

it("keeps startup failure visible and sanitized without a passive retry or implicit Okou fallback", async () => {
  const app = desktop();
  await app.authorize();
  await app.selection.select("cua");
  app.failLoad = true;
  await app.controller.start({ userInitiated: true });
  await app.permissions.refreshComputerUsePermissionState();
  await app.controller.start();
  expect(app.selection.getState()).toMatchObject({
    selectedDriver: "cua",
    phase: "error",
    actual: null,
    expectedCuaVersion: "0.23.2",
  });
  expect(JSON.stringify(app.selection.getState())).not.toMatch(
    /private|session-secret|socket|token=secret/,
  );
  expect(app.nativeStarts()).toBe(0);
  app.failLoad = false;
  await app.controller.start({ userInitiated: true });
  expect(app.selection.getState()).toMatchObject({
    phase: "ready",
    actual: { id: "cua", version: "0.23.2" },
  });
});

it("defers update and refuses recovery after a UI timeout until native cleanup is proven", async () => {
  const app = desktop();
  await app.authorize();
  await app.selection.select("cua");
  await app.controller.start({ userInitiated: true });
  const external = app.boundaries[0]!;
  const exit = deferred<void>();
  external.intercept = async (name) => {
    if (name === "stop") await exit.promise;
  };
  const selection = app.selection.select("okou");
  await external.stopEntered.promise;
  expect(app.selection.getState()).toMatchObject({
    cleanupPending: true,
    actual: { id: "cua", version: null },
  });
  app.tick(1234);
  await selection;
  expect(shouldDeferDesktopUpdate(app.controller.getHostState())).toBe(true);
  expect(app.selection.getState()).toMatchObject({
    phase: "error",
    cleanupPending: true,
    canRetry: false,
  });
  const retry = app.controller.start({ userInitiated: true });
  const rejected = expect(retry).rejects.toThrow("timed out");
  app.tick(1234);
  await rejected;
  expect(app.nativeStarts()).toBe(0);
  exit.resolve();
  await app.controller.stop();
  await app.selection.select("okou");
  await app.controller.start({ userInitiated: true });
  expect(app.selection.getState()).toMatchObject({
    phase: "ready",
    actual: { id: "okou" },
  });
});

it("honors the latest same-driver request after the first CUA startup has already begun", async () => {
  const app = desktop();
  await app.authorize();
  await app.controller.start();
  const entered = deferred<void>();
  const release = deferred<void>();
  app.configureCua = (boundary) => {
    boundary.intercept = async (name) => {
      if (name === "check_permissions") {
        entered.resolve();
        await release.promise;
      }
    };
  };
  const first = app.selection.select("cua");
  await entered.promise;
  app.configureCua = () => {};
  const second = app.selection.select("okou");
  const last = app.selection.select("cua");
  release.resolve();
  await Promise.all([first, second, last]);
  expect(app.selection.getState()).toMatchObject({
    selectedDriver: "cua",
    actual: { id: "cua" },
    phase: "ready",
  });
  expect(app.boundaries.filter((boundary) => boundary.live)).toHaveLength(1);
  expect(
    app.requests.filter((r) => r.path.endsWith("/hosts/start")),
  ).toHaveLength(1);
});

it.each(["stop", "auth", "update", "selection"] as const)(
  "does not publish delayed CUA startup after %s supersedes it",
  async (action) => {
    const app = desktop();
    await app.authorize();
    await app.selection.select("cua");
    const entered = deferred<void>();
    const release = deferred<void>();
    app.configureCua = (boundary) => {
      boundary.intercept = async (name) => {
        if (name === "check_permissions") {
          entered.resolve();
          await release.promise;
        }
      };
    };
    const start = app.controller.start({ userInitiated: true });
    await entered.promise;
    expect(shouldDeferDesktopUpdate(app.controller.getHostState())).toBe(true);
    const superseding =
      action === "stop"
        ? app.controller.stop()
        : action === "auth"
          ? (app.auth.signOut(), app.controller.stopForAuthChange())
          : action === "update"
            ? app.controller.stopForQuit("update_relaunch")
            : app.selection.select("okou");
    release.resolve();
    await Promise.allSettled([start, superseding]);
    if (action === "selection")
      expect(app.selection.getState()).toMatchObject({
        phase: "ready",
        actual: { id: "okou" },
      });
    else {
      expect(app.selection.getState().phase).not.toBe("ready");
      expect(app.selection.getState().actual).toBeNull();
    }
    expect(app.boundaries.every((boundary) => !boundary.live)).toBe(true);
    expect(
      app.requests.filter((r) => r.path.endsWith("/hosts/start")),
    ).toHaveLength(action === "selection" ? 1 : 0);
    expect(app.nativeStarts()).toBe(action === "selection" ? 1 : 0);
  },
);

it("keeps the real filesystem process and host serving after CUA permission revocation and an explicit selection", async () => {
  const app = desktop();
  await app.authorize();
  app.plugin.setFeatureEnabled(true);
  app.plugin.addAllowedDirectory(app.directory);
  app.plugin.setEnabled(true);
  await app.selection.select("cua");
  await app.controller.start({ userInitiated: true });
  await vi.waitFor(
    () => expect(app.plugin.getCapabilities().length).toBeGreaterThan(0),
    { timeout: 10_000 },
  );
  const host = app.controller.getHostState().hostId;
  const external = app.boundaries[0]!;
  external.granted = false;
  await app.permissions.refreshReady();
  await vi.waitFor(() =>
    expect(app.selection.getState().cleanupPending).toBe(false),
  );
  expect(app.driver.getCapabilities()).toHaveLength(0);
  expect(app.selection.getState().phase).toBe("error");
  await app.selection.select("okou");
  expect(app.nativeStarts()).toBe(0);
  app.command = {
    id: "plugin-command",
    kind: "plugin.call",
    payload: {
      plugin: "filesystem",
      tool: "list_allowed_directories",
      arguments: {},
    },
  };
  app.tick(0);
  expect(await app.completed.promise).toMatchObject({ status: "succeeded" });
  expect(app.controller.getHostState().hostId).toBe(host);
  expect(
    app.requests.filter((r) => r.path.endsWith("/hosts/start")),
  ).toHaveLength(1);
  expect(
    app.controller.getHostState().localCommandLog[0]?.driver,
  ).toBeUndefined();
});

it("reports spontaneous embedded cleanup as update-busy and retries only after proof", async () => {
  const app = desktop();
  await app.authorize();
  await app.selection.select("cua");
  await app.controller.start({ userInitiated: true });
  const external = app.boundaries[0]!;
  const cleanup = deferred<void>();
  external.intercept = async (name) => {
    if (name === "stop") await cleanup.promise;
  };
  external.crash();
  await external.stopEntered.promise;
  expect(app.selection.getState()).toMatchObject({
    phase: "error",
    cleanupPending: true,
    canRetry: false,
    actual: { id: "cua", version: null },
  });
  expect(shouldDeferDesktopUpdate(app.controller.getHostState())).toBe(true);
  await app.controller.start();
  expect(app.boundaries).toHaveLength(1);
  cleanup.resolve();
  await vi.waitFor(() =>
    expect(app.selection.getState().cleanupPending).toBe(false),
  );
  await app.controller.start({ userInitiated: true });
  expect(app.selection.getState()).toMatchObject({
    phase: "ready",
    actual: { id: "cua", version: "0.23.2" },
  });
  expect(app.boundaries).toHaveLength(2);
});

it("withdraws live CUA immediately on unresolved access, resumes only an existing running intent, and blocks denial", async () => {
  const app = desktop();
  await app.authorize();
  await app.selection.select("cua");
  await app.controller.start({ userInitiated: true });
  const response = deferred<void>();
  app.featureRead = () => response.promise;
  app.developer.requestRefresh();
  expect(app.driver.getCapabilities()).toHaveLength(0);
  expect(app.selection.getState()).toMatchObject({
    selectedDriver: "cua",
    developerAvailability: "unresolved",
  });
  app.featureRead = null;
  response.resolve();
  await vi.waitFor(() =>
    expect(app.selection.getState()).toMatchObject({
      phase: "ready",
      actual: { id: "cua" },
    }),
  );
  app.debug = false;
  app.developer.requestRefresh();
  expect(app.driver.getCapabilities()).toHaveLength(0);
  await vi.waitFor(() =>
    expect(app.selection.getState()).toMatchObject({
      phase: "blocked",
      actual: null,
      selectedDriver: "cua",
      experimentalCuaEnabled: true,
    }),
  );
  expect(app.nativeStarts()).toBe(0);
});
