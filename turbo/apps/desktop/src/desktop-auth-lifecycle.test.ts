import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { MenuItemConstructorOptions } from "electron";
import { DesktopAuthSession } from "./desktop-auth-session";
import type { DesktopAuthWindowRequest } from "./desktop-auth-window";
import { DesktopTrayController } from "./desktop-tray";
import { DeveloperToolsController } from "./desktop-developer-tools-controller";
import { DesktopApplicationMenu } from "./desktop-application-menu";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import {
  ComputerUseDriverController,
  type ComputerUseDriver,
} from "./computer-use-driver";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import { DesktopComputerUseDriverPreferences } from "./desktop-computer-use-driver-preferences";
import { DesktopComputerUseDriverSelection } from "./desktop-computer-use-driver-selection";
import type { ComputerUseDriverId } from "./computer-use-types";
import { UNAVAILABLE_RECORDER_STATE } from "./desktop-recorder-types";

const native = vi.hoisted(() => ({
  application: [] as MenuItemConstructorOptions[][],
  tray: [] as MenuItemConstructorOptions[][],
}));
vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
    setApplicationMenu: (menu: MenuItemConstructorOptions[]) => {
      native.application.push(menu);
    },
  },
  Tray: class {
    setToolTip() {}
    setImage() {}
    setContextMenu(menu: MenuItemConstructorOptions[]) {
      native.tray.push(menu);
    }
  },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
}));
const api = "https://api.vm0.ai";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  native.application = [];
  native.tray = [];
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function developerCheckbox() {
  const submenu = native.application.at(-1)?.[0]?.submenu;
  return Array.isArray(submenu)
    ? submenu.find((item) => item.label === "Developer Tools")
    : undefined;
}

async function desktop(selectedDriver: ComputerUseDriverId) {
  const directory = mkdtempSync(path.join(tmpdir(), "desktop-auth-lifecycle-"));
  const file = path.join(directory, "preferences.json");
  if (selectedDriver === "cua")
    writeFileSync(
      file,
      JSON.stringify({
        computerUseDriver: { experimentalCuaEnabled: true, selectedDriver },
      }),
    );
  const pending = new Set<Promise<unknown>>();
  const own = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  const settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  const windows: DesktopAuthWindowRequest[] = [];
  const replies: ReturnType<typeof deferred<string | null>>[] = [];
  const allReplies: typeof replies = [];
  const nativeStarts: string[] = [];
  let lastAuthority: object | null = null;
  let lastDeveloper: object | null = null;
  let depth = 0;
  let maximumDepth = 0;
  let notifications = 0;
  const session = new DesktopAuthSession({
    apiBaseUrl: api,
    addClientHeaders: createDesktopClientHeaderInjector({
      clientVersion: "1.2.3",
    }),
    tokenUrl: `${api}/token`,
    selectOrgUrl: `${api}/select-org`,
    consumeUrl: () => `${api}/consume`,
    runAuthWindow: async (request) => {
      windows.push(request);
      return await (replies.shift()?.promise ?? Promise.resolve(null));
    },
    onChange: () => {
      notifications++;
      // Bound only the old-code reproduction. Production has no depth cap.
      if (depth === 8) return;
      depth++;
      maximumDepth = Math.max(maximumDepth, depth);
      // main.ts orders authority withdrawal, real tray read-back, then the
      // developer refresh. Both driver selections share that read-back.
      const authority = session.getAuthority();
      if (authority !== lastAuthority) {
        lastAuthority = authority;
        if (
          selection.requestedDriver().id === "cua" ||
          driver.selectedDriver.id === "cua"
        )
          own(runtime.stopForAuthChange());
      }
      tray.refreshAuth();
      developer.requestRefresh();
      depth--;
    },
  });
  const developer = new DeveloperToolsController({
    getSessionAuthority: () => session.getAuthority(),
    fetchFeatureSwitches: () =>
      own(session.fetchWithSessionAuth(new URL(`${api}/api/feature-switches`))),
    setFilesystemPluginFeatureEnabled: () => {},
    setScreenRecordingFeatureEnabled: () => {},
    onChange: () => {
      const authority = developer.getAuthorization();
      if (authority !== lastDeveloper) {
        lastDeveloper = authority;
        own(runtime.refreshDriverAuthorization());
      }
      menu.refresh();
    },
  });
  const backend = (id: string): never => {
    nativeStarts.push(id);
    throw new Error("Auth/menu reads must not start a native driver");
  };
  const okou: ComputerUseDriver = {
    id: "okou",
    buildVersion: "test",
    createBackend: () => backend("okou"),
  };
  const cua: ComputerUseDriver = {
    id: "cua",
    buildVersion: "test",
    createBackend: () => backend("cua"),
    getAuthorization: () => developer.getAuthorization(),
  };
  const driver = new ComputerUseDriverController(okou, "darwin");
  const runtime = new ComputerUseRuntimeController({
    driver,
    createRuntime: () => {
      throw new Error("Auth/menu reads must not start a host");
    },
    refreshPermissions: async () => ({
      accessibility: false,
      screenRecording: false,
    }),
    nativeBlockReason: (selected) => selection.blockReason(selected),
    getAuthState: () => own(session.getAuthState()),
    setHostRuntimeOnline: () => {},
  });
  const preferences = new DesktopComputerUseDriverPreferences(() => file);
  preferences.load();
  const selection = new DesktopComputerUseDriverSelection({
    preferences,
    developer,
    runtime,
    drivers: { okou, cua },
    onChange: () => menu.refresh(),
  });
  const menu = new DesktopApplicationMenu({
    displayName: "Okou",
    developerTools: developer,
    updatesEnabled: () => true,
    checkForUpdates: () => {},
    quit: () => {},
  });
  const tray = new DesktopTrayController({
    displayName: "Okou",
    iconPath: "/icon",
    disabledIconPath: "/disabled",
    runningIconPath: "/running",
    getComputerUseState: () => ({
      driver: selection.getState(),
      platform: "darwin",
      supported: true,
      permissions: { accessibility: false, screenRecording: false },
      host: runtime.getHostState(),
      keepAwake: { enabled: false, active: false },
    }),
    getAuthState: () => own(session.getAuthState()),
    showMainWindow: async () => {
      await session.getAuthState();
    },
    startComputerUse: () => runtime.start(),
    stopComputerUse: () => runtime.stop(),
    refreshStatus: async () => {},
    openSignIn: () => {},
    switchWorkspace: () => session.selectOrganization(),
    signOut: async () => session.signOut(),
    requestAccessibilityPermission: async () => {},
    requestScreenRecordingPermission: async () => {},
    openAccessibilitySettings: () => {},
    openScreenRecordingSettings: () => {},
    setKeepAwakeEnabled: async () => {},
    getRecorderState: () => UNAVAILABLE_RECORDER_STATE,
    startScreenRecording: async () => {},
    stopScreenRecording: async () => {},
    retryScreenRecordingDelivery: async () => {},
    quit: () => menu.dispose(),
  });
  server.use(
    http.get(`${api}/api/auth/me`, ({ request }) => {
      const userId = request.headers.get("authorization");
      return HttpResponse.json({
        userId,
        email: "fixture@example.test",
        orgId: `org-${userId}`,
      });
    }),
    http.get(`${api}/api/org`, ({ request }) =>
      HttpResponse.json({
        id: `org-${request.headers.get("authorization")}`,
        name: "Workspace",
      }),
    ),
    http.get(`${api}/api/feature-switches`, () =>
      HttpResponse.json({ effectiveSwitches: { _debug: true } }),
    ),
  );
  onTestFinished(async () => {
    menu.dispose();
    session.signOut();
    for (const reply of allReplies) reply.resolve(null);
    await settle();
    await runtime.stopForQuit();
    rmSync(directory, { recursive: true, force: true });
  });
  await runtime.transitionDriver(selection.requestedDriver());
  return {
    session,
    developer,
    selection,
    runtime,
    tray,
    menu,
    windows,
    nativeStarts,
    settle,
    metrics: () => ({ maximumDepth, notifications }),
    reply: () => {
      const reply = deferred<string | null>();
      replies.push(reply);
      allReplies.push(reply);
      return reply;
    },
  };
}

describe.each(["okou", "cua"] as const)(
  "%s auth/tray/developer composition",
  (driver) => {
    it("coalesces startup and signed-in restoration while revoking authority synchronously", async () => {
      const app = await desktop(driver);
      const first = app.reply();
      app.tray.install();
      const windowsAtStartup = app.windows.length;
      const startup = app.session.getAuthState();
      first.resolve("startup");
      await startup;
      await app.settle();
      expect(windowsAtStartup).toBe(1);
      await vi.waitFor(() => expect(developerCheckbox()?.checked).toBe(false));
      expect(app.windows).toHaveLength(1);
      expect(app.metrics().maximumDepth).toBe(1);
      expect(app.session.getAuthority()).not.toBeNull();
      expect(app.developer.getAuthorization()).not.toBeNull();
      const next = app.reply();
      const restore = app.session.getToken({ forceRefresh: true });
      expect(app.session.getCachedToken()).toBeNull();
      expect(app.session.getAuthority()).toBeNull();
      expect(app.developer.getAuthorization()).toBeNull();
      const reopened = [app.session.getAuthState(), app.session.getAuthState()];
      expect(app.windows).toHaveLength(2);
      next.resolve("restored");
      expect(await restore).toBe("restored");
      expect(await Promise.all(reopened)).toEqual([
        expect.objectContaining({ status: "signed_in" }),
        expect.objectContaining({ status: "signed_in" }),
      ]);
      await app.settle();
      await vi.waitFor(() =>
        expect(app.developer.getAuthorization()).not.toBeNull(),
      );
      await nextTurn();
      expect(app.selection.getState().selectedDriver).toBe(driver);
      expect(app.nativeStarts).toEqual([]);
      expect(app.metrics().notifications).toBeLessThan(12);
      expect(native.application.length).toBeLessThan(8);
      const before = native.tray.length;
      app.tray.refresh();
      app.tray.refresh();
      expect(native.tray).toHaveLength(before);
    });

    it.each(["empty", "failed", "cancelled"] as const)(
      "settles %s hidden restoration without reopening or granting authority",
      async (outcome) => {
        const app = await desktop(driver);
        const reply = app.reply();
        app.tray.install();
        const state = app.session.getAuthState();
        if (outcome === "cancelled") app.session.signOut();
        if (outcome === "failed") reply.reject(new Error("Auth window failed"));
        else reply.resolve(outcome === "cancelled" ? "late" : null);
        expect(await state).toMatchObject({ status: "signed_out" });
        await app.settle();
        await vi.waitFor(() =>
          expect(app.developer.getAvailability()).toBe("unavailable"),
        );
        await nextTurn();
        expect(await app.session.getAuthState()).toMatchObject({
          status: "signed_out",
        });
        expect(app.windows).toHaveLength(1);
        expect(app.session.getAuthority()).toBeNull();
        expect(app.developer.getAuthorization()).toBeNull();
        expect(developerCheckbox()).toBeUndefined();
        expect(app.nativeStarts).toEqual([]);
        expect(native.application.length).toBeLessThan(4);
      },
    );

    it("keeps interactive account and workspace changes when an older hidden reply arrives late", async () => {
      const app = await desktop(driver);
      const old = app.reply();
      app.tray.install();
      const explicit = app.reply();
      const signIn = app.session.consumeCode("new-account");
      expect(app.windows[0]?.signal.aborted).toBe(true);
      expect(await app.session.getAuthState()).toMatchObject({
        status: "signing_in",
      });
      explicit.resolve("account");
      await signIn;
      const workspace = app.reply();
      const switchOrg = app.session.selectOrganization();
      expect(app.session.getAuthority()).toBeNull();
      expect(app.developer.getAuthorization()).toBeNull();
      old.resolve("retired");
      workspace.resolve("workspace");
      await switchOrg;
      await app.settle();
      await vi.waitFor(() =>
        expect(app.developer.getAuthorization()).not.toBeNull(),
      );
      expect(app.session.getCachedToken()).toBe("workspace");
      expect(await app.session.getAuthState()).toMatchObject({
        user: { userId: "Bearer workspace" },
        organization: { id: "org-Bearer workspace" },
      });
      expect(app.selection.getState().selectedDriver).toBe(driver);
      expect(app.nativeStarts).toEqual([]);
    });

    it("coalesces a 401 refresh and rejects a late developer grant after sign-out", async () => {
      const app = await desktop(driver);
      const initial = app.reply();
      app.tray.install();
      initial.resolve("expired");
      await app.settle();
      await vi.waitFor(() =>
        expect(app.developer.getAuthorization()).not.toBeNull(),
      );
      const requested = deferred<void>();
      const release = deferred<void>();
      onTestFinished(() => release.resolve());
      server.use(
        http.get(
          `${api}/api/protected`,
          ({ request }) =>
            new HttpResponse(null, {
              status:
                request.headers.get("authorization") === "Bearer expired"
                  ? 401
                  : 200,
            }),
        ),
        http.get(`${api}/api/feature-switches`, async () => {
          requested.resolve();
          await release.promise;
          return HttpResponse.json({ effectiveSwitches: { _debug: true } });
        }),
      );
      const fresh = app.reply();
      const response = app.session.fetchWithSessionAuth(
        new URL(`${api}/api/protected`),
      );
      await vi.waitFor(() => expect(app.windows).toHaveLength(2));
      expect(app.session.getAuthority()).toBeNull();
      expect(app.developer.getAuthorization()).toBeNull();
      fresh.resolve("fresh");
      expect((await response).status).toBe(200);
      await requested.promise;
      app.session.signOut();
      expect(app.session.getAuthority()).toBeNull();
      expect(app.developer.getAuthorization()).toBeNull();
      release.resolve();
      await app.settle();
      await vi.waitFor(() =>
        expect(app.developer.getAvailability()).toBe("unavailable"),
      );
      expect(app.session.getCachedToken()).toBeNull();
      expect(app.developer.getAuthorization()).toBeNull();
      expect(app.nativeStarts).toEqual([]);
    });
  },
);
