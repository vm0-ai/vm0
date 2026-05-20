import path from "node:path";
import { app, BrowserWindow, Menu, session, shell } from "electron";
import { executeComputerUseCommand } from "./computer-use-accessibility";
import {
  installComputerUseIpc,
  notifyDesktopComputerUseChanged,
} from "./computer-use-electron";
import { ComputerUseHostRuntime } from "./computer-use-host";
import { buildDesktopComputerUsePageUrl } from "./computer-use-page-url";
import { captureComputerUseScreenshot } from "./computer-use-screenshot";
import {
  COMPUTER_USE_FEATURE_SWITCH_KEY,
  IDLE_COMPUTER_USE_HOST_STATE,
  type ComputerUseApprovalAction,
  type DesktopComputerUseState,
} from "./computer-use-types";
import {
  getComputerUsePermissionState,
  requestComputerUseAccessibilityPermission,
} from "./computer-use-permissions";
import { resolveDesktopConfig } from "./config";
import { createDesktopLocalAgentApiClient } from "./desktop-local-agent-api";
import {
  installDesktopLocalAgentIpc,
  notifyDesktopLocalAgentsChanged,
  openLocalAgentFolder,
  selectLocalAgentFolder,
} from "./desktop-local-agent-electron";
import { DesktopLocalAgentManager } from "./desktop-local-agent-manager";
import {
  detectLocalAgentBackends,
  executeLocalAgentBackend,
  preflightLocalAgentBackend,
} from "./desktop-local-agent-runtime";
import { createDesktopLocalAgentStore } from "./desktop-local-agent-store";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthStartUrl,
  createDesktopAuthStartGate,
  isDesktopAuthStartNavigation,
  isDesktopSignedOutNavigation,
  parseDesktopAuthCallback,
  parseDesktopAuthCallbackArgv,
} from "./desktop-auth";
import {
  shouldHideMainWindowOnClose,
  showAndFocusWindow,
} from "./desktop-window-lifecycle";
import { installDesktopWindowChromeIpc } from "./desktop-window-chrome-electron";
import { buildDesktopWindowChromeOptions } from "./desktop-window-chrome";
import { buildSignedOutPageUrl } from "./signed-out-page";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";

const config = resolveDesktopConfig();
const desktopAuthStartUrl = buildDesktopAuthStartUrl(
  config.platformUrl,
  config.identity.authScheme,
);
const signedOutPageUrl = buildSignedOutPageUrl(desktopAuthStartUrl);
let mainWindow: BrowserWindow | null = null;
let pendingDesktopAuthCode: string | null = null;
let desktopLocalAgentManager: DesktopLocalAgentManager | null = null;
let appIsQuitting = false;
let quittingAfterLocalAgentStop = false;
const desktopAuthStartGate = createDesktopAuthStartGate();
let computerUseRuntime: ComputerUseHostRuntime | null = null;

function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function appIconPath(): string {
  return path.join(__dirname, "..", "assets", "icon.png");
}

function applyAppName(): void {
  app.setName(config.identity.displayName);
  app.name = config.identity.displayName;
}

function applyDockIcon(): void {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIconPath());
  }
}

function createDesktopLocalAgentManager(): DesktopLocalAgentManager {
  const electronSession = session.fromPartition(config.sessionPartition);
  return new DesktopLocalAgentManager({
    store: createDesktopLocalAgentStore(
      path.join(app.getPath("userData"), "local-agents.json"),
    ),
    api: createDesktopLocalAgentApiClient({
      platformUrl: config.platformUrl,
      session: electronSession,
    }),
    selectFolder: selectLocalAgentFolder,
    openFolder: openLocalAgentFolder,
    detectBackends: detectLocalAgentBackends,
    preflightBackend: preflightLocalAgentBackend,
    executeBackend: executeLocalAgentBackend,
    onChange: notifyDesktopLocalAgentsChanged,
  });
}

function installDesktopLocalAgent(): void {
  if (desktopLocalAgentManager) {
    return;
  }
  desktopLocalAgentManager = createDesktopLocalAgentManager();
  installDesktopLocalAgentIpc(desktopLocalAgentManager, {
    allowedAppOrigins: config.allowedAppOrigins,
  });
}

async function openComputerUsePage(): Promise<void> {
  await createMainWindow(buildDesktopComputerUsePageUrl(config.platformUrl));
}

function getComputerUseBridgeState(): DesktopComputerUseState {
  return {
    featureSwitchKey: COMPUTER_USE_FEATURE_SWITCH_KEY,
    platform: process.platform,
    supported: process.platform === "darwin",
    permissions: getComputerUsePermissionState(),
    host: computerUseRuntime?.getState() ?? IDLE_COMPUTER_USE_HOST_STATE,
  };
}

function startComputerUseRuntime(): void {
  if (computerUseRuntime) {
    return;
  }

  const desktopSession = session.fromPartition(config.sessionPartition);
  computerUseRuntime = new ComputerUseHostRuntime({
    platformUrl: config.platformUrl,
    displayName: config.identity.displayName,
    appVersion: app.getVersion(),
    fetch: (input, init) => {
      return desktopSession.fetch(input, init);
    },
    getPermissions: getComputerUsePermissionState,
    executeCommand: (command, permissions) => {
      return executeComputerUseCommand(command, permissions, {
        captureScreenshot: captureComputerUseScreenshot,
      });
    },
    onChange: notifyDesktopComputerUseChanged,
  });
  computerUseRuntime.start();
}

async function decideComputerUseCommand(
  action: ComputerUseApprovalAction,
): Promise<DesktopComputerUseState> {
  if (!computerUseRuntime) {
    return getComputerUseBridgeState();
  }
  await computerUseRuntime.decideCommand(action);
  return getComputerUseBridgeState();
}

function requestComputerUsePermission(): DesktopComputerUseState {
  requestComputerUseAccessibilityPermission();
  notifyDesktopComputerUseChanged();
  return getComputerUseBridgeState();
}

function installComputerUse(): void {
  installComputerUseIpc(
    {
      getState: getComputerUseBridgeState,
      requestAccessibilityPermission: requestComputerUsePermission,
      decideCommand: decideComputerUseCommand,
    },
    { allowedAppOrigins: config.allowedAppOrigins },
  );
}

function applyApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: config.identity.displayName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Computer Use",
          click: () => {
            void openComputerUsePage();
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ]);
  Menu.setApplicationMenu(menu);
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
  const callback = parseDesktopAuthCallback(rawUrl, config.identity.authScheme);
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
    title: config.identity.displayName,
    backgroundColor: "#19191b",
    icon: appIconPath(),
    ...buildDesktopWindowChromeOptions(process.platform),
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
    showAndFocusWindow(mainWindow);
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
  window.on("close", (event) => {
    if (
      shouldHideMainWindowOnClose({
        platform: process.platform,
        isQuitting: appIsQuitting,
      })
    ) {
      event.preventDefault();
      window.hide();
    }
  });
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
  const callback = parseDesktopAuthCallbackArgv(
    argv,
    config.identity.authScheme,
  );
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
  const callback = parseDesktopAuthCallbackArgv(
    argv,
    config.identity.authScheme,
  );
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
      app.setAsDefaultProtocolClient(
        config.identity.authScheme,
        process.execPath,
        [path.resolve(entryPoint)],
      );
      return;
    }
  }

  app.setAsDefaultProtocolClient(config.identity.authScheme);
}

if (process.platform !== "darwin") {
  console.warn("Zero Desktop POC is macOS-first and only packages for darwin.");
}

applyAppName();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (handleDesktopAuthCallbackArgv(argv)) {
      return;
    }

    void createMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDesktopAuthCallback(url);
  });

  app.on("before-quit", (event) => {
    appIsQuitting = true;
    const manager = desktopLocalAgentManager;
    if (
      !manager ||
      !manager.hasRunningAgents() ||
      quittingAfterLocalAgentStop
    ) {
      return;
    }

    event.preventDefault();
    quittingAfterLocalAgentStop = true;
    void manager.stopAll().finally(() => {
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    applyDockIcon();
    applyApplicationMenu();
    registerDesktopAuthProtocol();
    installDesktopWindowChromeIpc({
      allowedAppOrigins: config.allowedAppOrigins,
      platform: process.platform,
    });
    installDesktopLocalAgent();
    installComputerUse();
    queueDesktopAuthCallbackArgv(process.argv);
    startComputerUseRuntime();

    const pendingCode = pendingDesktopAuthCode;
    pendingDesktopAuthCode = null;
    await createMainWindow(
      pendingCode
        ? buildDesktopAuthConsumeUrl(config.platformUrl, pendingCode)
        : undefined,
    );

    app.on("activate", () => {
      void createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
