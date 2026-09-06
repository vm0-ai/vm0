import { EventEmitter } from "node:events";
import type { BrowserWindowConstructorOptions } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDesktopConfig } from "./config";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { DesktopAuthWindow } from "./desktop-auth-window";
import { DesktopAuthSession } from "./desktop-auth-session";
import { installDesktopAuthIpc } from "./desktop-auth-electron";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";

interface Frame {
  url: string;
}
interface Contents extends EventEmitter {
  mainFrame: Frame;
  destroyed: boolean;
  popup: (details: { url: string }) => { action: string };
}
interface TestWindow extends EventEmitter {
  webContents: Contents;
  options: BrowserWindowConstructorOptions;
  destroyed: boolean;
  close: () => void;
}
interface InvokeEvent {
  sender: Contents;
  senderFrame: Frame;
}
type Handler = (event: InvokeEvent, payload?: unknown) => unknown;
const electron = vi.hoisted(() => ({
  windows: [] as TestWindow[],
  handlers: new Map<string, Handler>(),
  storage: new Map<string, string[]>(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class WebContents extends EventEmitter {
    mainFrame = { url: "about:blank" };
    destroyed = false;
    popup = (_details: { url: string }) => ({ action: "deny" });
    isDestroyed() {
      return this.destroyed;
    }
    setWindowOpenHandler(
      handler: (details: { url: string }) => { action: string },
    ) {
      this.popup = handler;
    }
  }
  class BrowserWindow extends EventEmitter {
    webContents = new WebContents();
    destroyed = false;
    constructor(readonly options: BrowserWindowConstructorOptions) {
      super();
      electron.windows.push(this);
    }
    async loadURL(url: string) {
      this.webContents.mainFrame.url = url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroyed = true;
      this.emit("closed");
    }
    show() {}
    focus() {}
    isMinimized() {
      return false;
    }
  }
  return {
    BrowserWindow,
    session: {
      fromPartition: (partition: string) => ({
        clearStorageData: async () => {
          electron.storage.delete(partition);
        },
      }),
    },
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        electron.handlers.set(channel, handler),
    },
  };
});

const origin = "https://app.okou.ai";
const rendererUrl = "vm0-desktop://renderer/index.html";
const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  electron.windows.length = 0;
  electron.handlers.clear();
  electron.storage.clear();
  vi.clearAllMocks();
});
function setup(timeoutMs = 30_000, product: "okou" | "zero" = "zero") {
  const config = resolveDesktopConfig(undefined, product);
  const external: string[] = [];
  const driver = new DesktopAuthWindow({
    authOrigin: origin,
    partition: config.authPartition,
    timeoutMs,
    windowOptions: () => ({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    }),
    openExternal: (url) => {
      external.push(url);
    },
  });
  const session = new DesktopAuthSession({
    product,
    apiBaseUrl: "https://api.vm0.ai",
    cookieUrls: [],
    cookieSource: { cookies: { get: async () => [] } },
    addClientHeaders: () => {},
    tokenUrl: `${origin}/desktop-auth/token`,
    consumeUrl: () => `${origin}/desktop-auth/consume`,
    selectOrgUrl: `${origin}/desktop-auth/select-org`,
    runAuthWindow: (request) => driver.run(request),
  });
  installDesktopAuthIpc(
    {
      getState: () => session.getAuthState(),
      openSignIn: () => {},
      openOrgSelection: () => session.selectOrganization(),
      signOut: async () => session.signOut(),
    },
    { rendererUrl, authWindow: driver },
  );
  return { driver, session, external };
}
function currentWindow(): TestWindow {
  const window = electron.windows.at(-1);
  if (!window) throw new Error("Auth window was not created");
  return window;
}
function navigate(window: TestWindow, path: string) {
  const url = new URL(path, origin).toString();
  window.webContents.mainFrame.url = url;
  window.webContents.emit("did-navigate", {}, url);
}
async function deliver(
  window: TestWindow,
  payload: unknown = { token: "fresh" },
  override?: Partial<InvokeEvent>,
) {
  const handler = electron.handlers.get(DESKTOP_AUTH_CHANNELS.completeSignIn);
  if (!handler) throw new Error("IPC was not installed");
  return await handler(
    {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
      ...override,
    },
    payload,
  );
}
function run(
  driver: DesktopAuthWindow,
  path = "/desktop-auth/token",
  interactive = false,
) {
  const controller = new AbortController();
  controllers.push(controller);
  const pending = driver.run({
    url: `${origin}${path}`,
    visible: interactive,
    allowInteractiveFallbacks: interactive,
    signal: controller.signal,
  });
  return { pending, controller, window: currentWindow() };
}

describe("Desktop authentication IPC and document lifecycle", () => {
  it.each(["/desktop-auth/token", "/desktop-auth/select-org"])(
    "accepts only the live main frame at %s and waits for document completion",
    async (path) => {
      const { driver } = setup();
      const { pending, window } = run(driver, path, true);
      let completed = false;
      void pending.then(() => {
        completed = true;
      });
      await deliver(window);
      expect(completed).toBe(false);
      expect(window.destroyed).toBe(false);
      expect(window.options.webPreferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      });
      // App's server acknowledgement occurs between IPC resolution and this
      // full-document navigation. IPC alone cannot close the window or succeed.
      navigate(window, "/");
      expect(await pending).toBe("fresh");
      expect(window.destroyed).toBe(true);
      await expect(deliver(window)).rejects.toThrow("no longer active");
    },
  );

  it.each(["/", "/en", "/de/", "/ja", "/es/"])(
    "rejects completion navigation %s without a new token",
    async (path) => {
      const { driver } = setup();
      const { pending, window } = run(driver);
      const rejected = expect(pending).rejects.toThrow("without a token");
      navigate(window, path);
      await rejected;
    },
  );

  it.each([
    rendererUrl,
    "https://www.vm0.ai/desktop-auth/token",
    "https://api.vm0.ai/desktop-auth/token",
    "https://evil.test/desktop-auth/token",
    `${origin}/desktop-auth/callback`,
    `${origin}/desktop-auth/consume`,
    `${origin}/`,
    `${origin}/desktop-auth/token/`,
  ])("rejects delivery at %s", async (url) => {
    const { driver } = setup();
    const { pending, controller, window } = run(driver);
    window.webContents.mainFrame.url = url;
    await expect(deliver(window)).rejects.toThrow("unavailable on this page");
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort();
    await rejected;
  });

  it("rejects another webContents and subframes even with the exact allowed URL", async () => {
    const { driver } = setup();
    const { pending, window } = run(driver);
    const other = Object.assign(new EventEmitter(), {
      mainFrame: { url: `${origin}/desktop-auth/token` },
      destroyed: false,
      popup: () => ({ action: "deny" }),
    });
    await expect(
      deliver(window, { token: "foreign" }, { sender: other }),
    ).rejects.toThrow("unavailable on this page");
    await expect(
      deliver(
        window,
        { token: "iframe" },
        { senderFrame: { url: `${origin}/desktop-auth/token` } },
      ),
    ).rejects.toThrow("unavailable on this page");
    await deliver(window);
    navigate(window, "/");
    expect(await pending).toBe("fresh");
  });

  it.each([
    null,
    undefined,
    "token",
    {},
    { token: "" },
    { token: "  " },
    { token: "header\ninjection" },
    { token: 1 },
  ])("rejects malformed IPC payload %j", async (payload) => {
    const { driver } = setup();
    const { pending, window } = run(driver);
    const handler = electron.handlers.get(
      DESKTOP_AUTH_CHANNELS.completeSignIn,
    )!;
    await expect(
      Promise.resolve().then(() =>
        handler(
          {
            sender: window.webContents,
            senderFrame: window.webContents.mainFrame,
          },
          payload,
        ),
      ),
    ).rejects.toThrow("requires a token");
    await deliver(window);
    navigate(window, "/");
    expect(await pending).toBe("fresh");
  });

  it.each(["closed", "cancelled", "timeout"])(
    "rejects late IPC after %s even after token delivery",
    async (reason) => {
      const { driver } = setup(reason === "timeout" ? 5 : 30_000);
      const { pending, controller, window } = run(driver);
      const rejected = expect(pending).rejects.toThrow();
      await deliver(window);
      if (reason === "closed") window.close();
      if (reason === "cancelled") controller.abort();
      await rejected;
      await expect(deliver(window, { token: "late" })).rejects.toThrow(
        "no longer active",
      );
    },
  );

  it("supersedes an old window and rejects its completion against the new operation", async () => {
    const { driver } = setup();
    const old = run(driver);
    const rejected = expect(old.pending).rejects.toThrow("cancelled");
    const next = run(driver);
    await rejected;
    await expect(deliver(old.window)).rejects.toThrow(
      "unavailable on this page",
    );
    await deliver(next.window, { token: "new" });
    navigate(next.window, "/");
    expect(await next.pending).toBe("new");
  });

  it("sign-out invalidates the real session and staged IPC token before document navigation", async () => {
    const { session } = setup();
    const pending = session.consumeCode("code");
    const rejected = expect(pending).rejects.toThrow();
    const window = currentWindow();
    navigate(window, "/desktop-auth/token");
    await deliver(window);
    expect(session.getCachedToken()).toBeNull();
    session.signOut();
    await rejected;
    await expect(deliver(window)).rejects.toThrow("no longer active");
    expect(session.getCachedToken()).toBeNull();
    expect(await session.getAuthState()).toMatchObject({
      status: "signed_out",
    });
  });

  it("does not reuse the previously cached bearer when a new window only navigates", async () => {
    const { session } = setup();
    const initial = session.getToken();
    const first = currentWindow();
    await deliver(first, { token: "previous" });
    navigate(first, "/");
    expect(await initial).toBe("previous");
    const next = session.getToken({ forceRefresh: true });
    const rejected = expect(next).rejects.toThrow("without a token");
    navigate(currentWindow(), "/");
    await rejected;
    expect(session.getCachedToken()).toBeNull();
  });

  it.each(["/desktop-auth/start", "/desktop-auth/select-org"])(
    "ends a signed-out hidden restore at %s with no token",
    async (path) => {
      const { driver } = setup();
      const { pending, window } = run(driver);
      navigate(window, path);
      expect(await pending).toBeNull();
    },
  );

  it("restricts navigation and redirects to the exact configured auth origin", async () => {
    const { driver, external } = setup();
    const { pending, window } = run(driver);
    for (const url of [
      "https://www.vm0.ai/desktop-auth/token",
      "https://api.vm0.ai/desktop-auth/token",
      "https://app.okou.ai.evil.test/desktop-auth/token",
    ]) {
      for (const event of ["will-navigate", "will-redirect"]) {
        let prevented = false;
        window.webContents.emit(
          event,
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          url,
        );
        expect(prevented).toBe(true);
      }
    }
    let prevented = false;
    window.webContents.emit(
      "will-navigate",
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      `${origin}/desktop-auth/select-org`,
    );
    expect(prevented).toBe(false);
    expect(window.webContents.popup({ url: "https://example.test" })).toEqual({
      action: "deny",
    });
    expect(external).toContain("https://example.test/");
    await deliver(window);
    navigate(window, "/");
    expect(await pending).toBe("fresh");
  });

  it("rejects duplicate token delivery within the same operation", async () => {
    const { driver } = setup();
    const { pending, window } = run(driver);
    await deliver(window);
    await expect(deliver(window, { token: "replacement" })).rejects.toThrow(
      "already delivered",
    );
    navigate(window, "/");
    expect(await pending).toBe("fresh");
  });
  it("ignores consumed status and SPA navigation until full document completion", async () => {
    const { driver } = setup();
    const { pending, window } = run(driver);
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    window.webContents.emit("ipc-message", {}, "consumed");
    window.webContents.emit("did-navigate-in-page", {}, `${origin}/`);
    await deliver(window);
    expect(completed).toBe(false);
    navigate(window, "/");
    expect(await pending).toBe("fresh");
  });

  it("reports a load failure without echoing credential-bearing URLs or descriptions", async () => {
    const { driver } = setup();
    const { pending, window } = run(driver);
    const rejected = expect(pending).rejects.toThrow(
      "Desktop auth page failed: -2",
    );
    window.webContents.emit(
      "did-fail-load",
      {},
      -2,
      "secret-token",
      `${origin}/?code=secret-code`,
      true,
    );
    await rejected;
    await expect(deliver(window)).rejects.toThrow("no longer active");
  });
  it("clears the isolated App/Clerk store and preserves native profile data", async () => {
    const config = resolveDesktopConfig(undefined, "okou");
    const { driver } = setup(30_000, "okou");
    electron.storage.set(config.sessionPartition, [
      "host-registration",
      "preferences",
      "recordings",
      "plugins",
      "legacy-www-cookies",
    ]);
    electron.storage.set(config.authPartition, [
      "app-session",
      "clerk-client",
      "app-localstorage",
    ]);
    const { pending, window } = run(driver);
    expect(window.options.webPreferences?.partition).toBe(config.authPartition);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await driver.clearStorage();
    await rejected;
    expect(electron.storage.has(config.authPartition)).toBe(false);
    expect(electron.storage.get(config.sessionPartition)).toEqual([
      "host-registration",
      "preferences",
      "recordings",
      "plugins",
      "legacy-www-cookies",
    ]);
    await expect(deliver(window)).rejects.toThrow("no longer active");
  });

  it("validates an App bearer after real IPC and full document completion", async () => {
    const requests: string[] = [];
    const server = setupServer(
      http.get("https://api.vm0.ai/api/auth/me", ({ request }) => {
        requests.push(`me:${request.headers.get("authorization")}`);
        expect(request.headers.get("cookie")).toBeNull();
        return HttpResponse.json({
          userId: "app-user",
          email: "app@example.test",
          orgId: "app-org",
        });
      }),
      http.get("https://api.vm0.ai/api/org", ({ request }) => {
        requests.push(`org:${request.headers.get("authorization")}`);
        return HttpResponse.json({ id: "app-org", name: "App" });
      }),
    );
    server.listen({ onUnhandledRequest: "error" });
    try {
      const { session } = setup(30_000, "okou");
      const pending = session.consumeCode("code");
      const window = currentWindow();
      navigate(window, "/desktop-auth/token");
      await deliver(window);
      expect(session.getCachedToken()).toBeNull();
      expect(requests).toEqual([]);
      navigate(window, "/");
      await pending;
      expect(session.getCachedToken()).toBe("fresh");
      expect(requests).toEqual(["me:Bearer fresh", "org:Bearer fresh"]);
      await expect(deliver(window, { token: "stale" })).rejects.toThrow(
        "no longer active",
      );
      session.signOut();
      expect(await session.getAuthState()).toMatchObject({
        status: "signed_out",
      });
    } finally {
      server.close();
    }
  });
});
