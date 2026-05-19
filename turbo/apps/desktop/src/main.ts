import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { resolveDesktopConfig } from "./config";
import {
  DESKTOP_AUTH_PROTOCOL,
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthStartUrl,
  createDesktopAuthStartGate,
  isDesktopAuthStartNavigation,
  isDesktopSignedOutNavigation,
  parseDesktopAuthCallbackArgv,
  parseDesktopAuthCallback,
} from "./desktop-auth";
import { buildSignedOutPageUrl } from "./signed-out-page";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";

const APP_NAME = "Zero";
const config = resolveDesktopConfig();
const desktopAuthStartUrl = buildDesktopAuthStartUrl(config.platformUrl);
const signedOutPageUrl = buildSignedOutPageUrl(desktopAuthStartUrl);
let mainWindow: BrowserWindow | null = null;
let pendingDesktopAuthCode: string | null = null;
const desktopAuthStartGate = createDesktopAuthStartGate();

function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function openExternal(url: string): void {
  void shell.openExternal(url);
}

function openDesktopAuthStart(rawUrl: string): boolean {
  if (!isDesktopAuthStartNavigation(rawUrl, config.allowedAppOrigins)) {
    return false;
  }

  if (desktopAuthStartGate.shouldOpen()) {
    openExternal(desktopAuthStartUrl);
  }
  return true;
}

function openDesktopAuthCallback(rawUrl: string): boolean {
  const callback = parseDesktopAuthCallback(rawUrl);
  if (!callback) {
    return false;
  }

  desktopAuthStartGate.suppressRetry();

  if (!app.isReady()) {
    pendingDesktopAuthCode = callback.code;
    return true;
  }

  void openDesktopAuthConsume(callback.code);
  return true;
}

function showSignedOutPage(window: BrowserWindow): void {
  void window.loadURL(signedOutPageUrl);
}

function shouldShowSignedOutPage(rawUrl: string): boolean {
  return isDesktopSignedOutNavigation(rawUrl, config.allowedAppOrigins);
}

interface PreventableNavigationEvent {
  readonly preventDefault: () => void;
}

function handleAuthNavigation(
  window: BrowserWindow,
  event: PreventableNavigationEvent,
  url: string,
): boolean {
  if (openDesktopAuthCallback(url)) {
    event.preventDefault();
    return true;
  }
  if (openDesktopAuthStart(url)) {
    event.preventDefault();
    return true;
  }
  if (shouldShowSignedOutPage(url)) {
    event.preventDefault();
    showSignedOutPage(window);
    return true;
  }
  return false;
}

function browserWindowOptions() {
  return {
    title: APP_NAME,
    backgroundColor: "#19191b",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
      partition: config.sessionPartition,
    },
  } satisfies Electron.BrowserWindowConstructorOptions;
}

function installChildWindowPolicy(window: BrowserWindow): void {
  const { webContents } = window;

  webContents.setWindowOpenHandler(({ url }) => {
    if (openDesktopAuthCallback(url)) {
      return { action: "deny" };
    }
    if (openDesktopAuthStart(url)) {
      return { action: "deny" };
    }
    if (shouldShowSignedOutPage(url)) {
      showSignedOutPage(window);
      return { action: "deny" };
    }

    const decision = decideWindowOpen(url, config.allowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
    return { action: "deny" };
  });
}

function installMainWindowPolicy(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (handleAuthNavigation(window, event, url)) {
      return;
    }

    if (isAllowedAppNavigation(url, config.allowedAppOrigins)) {
      return;
    }
    event.preventDefault();
    const decision = decideWindowOpen(url, config.allowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
  });

  window.webContents.on("will-redirect", (event) => {
    if (!event.isMainFrame) {
      return;
    }
    handleAuthNavigation(window, event, event.url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (openDesktopAuthCallback(url)) {
      return { action: "deny" };
    }
    if (openDesktopAuthStart(url)) {
      return { action: "deny" };
    }
    if (shouldShowSignedOutPage(url)) {
      showSignedOutPage(window);
      return { action: "deny" };
    }

    const decision = decideWindowOpen(url, config.allowedAppOrigins);
    if (decision.action === "allow-in-app") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: browserWindowOptions(),
      };
    }
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
    return { action: "deny" };
  });

  window.webContents.on("did-create-window", (childWindow) => {
    installChildWindowPolicy(childWindow);
  });
}

async function createMainWindow(initialUrl?: string): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (initialUrl) {
      await mainWindow.loadURL(initialUrl);
    }
    mainWindow.focus();
    return mainWindow;
  }

  const window = new BrowserWindow({
    ...browserWindowOptions(),
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
  });

  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  installMainWindowPolicy(window);
  await window.loadURL(initialUrl ?? config.platformUrl.toString());
  return window;
}

async function openDesktopAuthConsume(code: string): Promise<void> {
  const consumeUrl = buildDesktopAuthConsumeUrl(config.platformUrl, code);
  await createMainWindow(consumeUrl);
}

function handleDesktopAuthCallback(rawUrl: string): void {
  openDesktopAuthCallback(rawUrl);
}

function handleDesktopAuthCallbackArgv(argv: readonly string[]): boolean {
  const callback = parseDesktopAuthCallbackArgv(argv);
  if (!callback) {
    return false;
  }

  desktopAuthStartGate.suppressRetry();
  if (!app.isReady()) {
    pendingDesktopAuthCode = callback.code;
    return true;
  }

  void openDesktopAuthConsume(callback.code);
  return true;
}

function queueDesktopAuthCallbackArgv(argv: readonly string[]): boolean {
  const callback = parseDesktopAuthCallbackArgv(argv);
  if (!callback) {
    return false;
  }

  desktopAuthStartGate.suppressRetry();
  pendingDesktopAuthCode = callback.code;
  return true;
}

function registerDesktopAuthProtocol(): void {
  if (process.platform !== "darwin") {
    return;
  }

  if (process.defaultApp) {
    const entryPoint = process.argv[1];
    if (entryPoint) {
      app.setAsDefaultProtocolClient(DESKTOP_AUTH_PROTOCOL, process.execPath, [
        path.resolve(entryPoint),
      ]);
      return;
    }
  }

  app.setAsDefaultProtocolClient(DESKTOP_AUTH_PROTOCOL);
}

if (process.platform !== "darwin") {
  console.warn("Zero Desktop POC is macOS-first and only packages for darwin.");
}

app.name = APP_NAME;

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (handleDesktopAuthCallbackArgv(argv)) {
      return;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDesktopAuthCallback(url);
  });

  void app.whenReady().then(async () => {
    registerDesktopAuthProtocol();
    queueDesktopAuthCallbackArgv(process.argv);

    const pendingCode = pendingDesktopAuthCode;
    pendingDesktopAuthCode = null;
    await createMainWindow(
      pendingCode
        ? buildDesktopAuthConsumeUrl(config.platformUrl, pendingCode)
        : undefined,
    );

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
