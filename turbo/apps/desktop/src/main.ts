import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  Menu,
  net,
  protocol,
  session,
  shell,
} from "electron";
import {
  ComputerUseSnapshotStore,
  executeComputerUseCommand,
} from "./computer-use-accessibility";
import {
  installComputerUseIpc,
  notifyDesktopComputerUseChanged,
} from "./computer-use-electron";
import {
  ComputerUseHostRuntime,
  resolveComputerUseApiBaseUrl,
} from "./computer-use-host";
import {
  COMPUTER_USE_FEATURE_SWITCH_KEY,
  IDLE_COMPUTER_USE_HOST_STATE,
  hasRequiredComputerUsePermissions,
  type DesktopComputerUseState,
} from "./computer-use-types";
import {
  getComputerUsePermissionState,
  refreshComputerUsePermissionState,
  requestComputerUseAccessibilityPermission,
  requestComputerUseScreenRecordingPermission,
  setComputerUsePermissionNativeBackend,
} from "./computer-use-permissions";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { resolveDesktopConfig } from "./config";
import { createDesktopComputerUseSessionFetch } from "./desktop-computer-use-api";
import { DesktopAuthSession } from "./desktop-auth-session";
import {
  installDesktopAuthIpc,
  notifyDesktopAuthChanged,
} from "./desktop-auth-electron";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthStartUrl,
  buildDesktopAuthTokenUrl,
  createDesktopAuthStartGate,
  isDesktopAuthCompletionNavigation,
  isElectronNavigationAborted,
  isDesktopAuthSelectOrgNavigation,
  isDesktopAuthStartNavigation,
  parseDesktopAuthCallback,
  parseDesktopAuthCallbackArgv,
} from "./desktop-auth";
import {
  shouldHideMainWindowOnClose,
  showAndFocusWindow,
} from "./desktop-window-lifecycle";
import { buildDesktopWindowChromeOptions } from "./desktop-window-chrome";
import {
  desktopRendererFilePath,
  desktopRendererUrl,
  isDesktopRendererUrl,
} from "./desktop-renderer-url";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";

const config = resolveDesktopConfig();
const desktopApiBaseUrl = resolveComputerUseApiBaseUrl(config.platformUrl);
const desktopAuthStartUrl = buildDesktopAuthStartUrl(
  config.webUrl,
  config.identity.authScheme,
);
const desktopAuthSelectOrgUrl = buildDesktopAuthSelectOrgUrl(
  config.webUrl,
  true,
);
const desktopAuthTokenUrl = buildDesktopAuthTokenUrl(config.webUrl);
const localRendererUrl = desktopRendererUrl();
const noAllowedAppOrigins: ReadonlySet<string> = new Set();
const ELECTRON_ERR_ABORTED = -3;
const COMPUTER_USE_QUIT_STOP_TIMEOUT_MS = 1_000;
let mainWindow: BrowserWindow | null = null;
let appIsQuitting = false;
let computerUseQuitStopStarted = false;
const desktopAuthStartGate = createDesktopAuthStartGate();
let computerUseRuntime: ComputerUseHostRuntime | null = null;
const computerUseSnapshotStore = new ComputerUseSnapshotStore();
const computerUseNativeBackend = createComputerUseNativeBackend();
setComputerUsePermissionNativeBackend(computerUseNativeBackend);

async function runAuthWindow(request: {
  readonly url: string;
  readonly visible: boolean;
}): Promise<void> {
  const authWindow = new BrowserWindow({
    ...browserWindowOptions(),
    show: request.visible,
    width: request.visible ? 520 : 480,
    height: 640,
    skipTaskbar: !request.visible,
  });
  installAuthConsumeWindowPolicy(authWindow);
  const pending = waitForAuthConsumeWindow(authWindow);
  await loadAuthUrl(authWindow, request.url);
  await pending;
}

const authSession = new DesktopAuthSession({
  apiBaseUrl: desktopApiBaseUrl,
  cookieUrls: [config.webUrl, config.platformUrl],
  cookieSource: session.fromPartition(config.sessionPartition),
  tokenUrl: desktopAuthTokenUrl,
  consumeUrl: (code) => buildDesktopAuthConsumeUrl(config.webUrl, code),
  selectOrgUrl: desktopAuthSelectOrgUrl,
  runAuthWindow,
  onChange: notifyDesktopAuthChanged,
  onAuthCompleted: maybeStartComputerUseAfterAuth,
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "vm0-desktop",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

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

function installDesktopRendererProtocol(): void {
  const electronSession = session.fromPartition(config.sessionPartition);
  electronSession.protocol.handle("vm0-desktop", (request) => {
    const filePath = desktopRendererFilePath(request.url);
    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
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

async function startComputerUseRuntime(): Promise<DesktopComputerUseState> {
  const desktopSession = session.fromPartition(config.sessionPartition);
  if (!computerUseRuntime) {
    computerUseRuntime = new ComputerUseHostRuntime({
      platformUrl: config.platformUrl,
      displayName: config.identity.displayName,
      appVersion: app.getVersion(),
      sessionFetch: createDesktopComputerUseSessionFetch({
        platformUrl: config.platformUrl,
        session: desktopSession,
        getAuthToken: (options) => authSession.getToken(options),
      }),
      hostFetch: (input, init) => {
        return fetch(input, init);
      },
      getPermissions: refreshComputerUsePermissionState,
      executeCommand: (command, permissions) => {
        return executeComputerUseCommand(command, permissions, {
          nativeBackend: computerUseNativeBackend,
          snapshotStore: computerUseSnapshotStore,
        });
      },
      onChange: notifyDesktopComputerUseChanged,
    });
  }
  await computerUseRuntime.start();
  return getComputerUseBridgeState();
}

async function requestComputerUsePermission(): Promise<DesktopComputerUseState> {
  await requestComputerUseAccessibilityPermission();
  notifyDesktopComputerUseChanged();
  return getComputerUseBridgeState();
}

async function requestComputerUseScreenRecording(): Promise<DesktopComputerUseState> {
  await requestComputerUseScreenRecordingPermission();
  notifyDesktopComputerUseChanged();
  return getComputerUseBridgeState();
}

async function refreshComputerUsePermissions(): Promise<DesktopComputerUseState> {
  await refreshComputerUsePermissionState();
  notifyDesktopComputerUseChanged();
  return getComputerUseBridgeState();
}

function installComputerUse(): void {
  installComputerUseIpc(
    {
      getState: getComputerUseBridgeState,
      refreshPermissions: refreshComputerUsePermissions,
      start: startComputerUseRuntime,
      requestAccessibilityPermission: requestComputerUsePermission,
      requestScreenRecordingPermission: requestComputerUseScreenRecording,
    },
    { rendererUrl: localRendererUrl },
  );
}

function refreshComputerUsePermissionsForState(): void {
  void refreshComputerUsePermissionState()
    .catch((error) => {
      console.warn("Unable to refresh native Computer Use permissions", error);
    })
    .finally(() => {
      notifyDesktopComputerUseChanged();
    });
}

async function stopComputerUseRuntimeForQuit(): Promise<void> {
  const runtime = computerUseRuntime;
  if (!runtime) {
    return;
  }

  await Promise.race([
    runtime.stop(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, COMPUTER_USE_QUIT_STOP_TIMEOUT_MS);
    }),
  ]);
}

function installDesktopAuth(): void {
  installDesktopAuthIpc(
    {
      getState: () => authSession.getAuthState(),
      openSignIn: () => {
        openExternal(desktopAuthStartUrl);
      },
      openOrgSelection: () => authSession.selectOrganization(),
      completeSignIn: (token) => authSession.completeSignIn(token),
    },
    {
      rendererUrl: localRendererUrl,
      allowedAppOrigins: config.allowedAppOrigins,
    },
  );
}

function applyApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: config.identity.displayName,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
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

function logDesktopAuthError(error: unknown): void {
  if (isElectronNavigationAborted(error)) {
    return;
  }
  console.error("Desktop auth flow failed", error);
}

async function loadAuthUrl(window: BrowserWindow, url: string): Promise<void> {
  try {
    await window.loadURL(url);
  } catch (error) {
    if (!isElectronNavigationAborted(error)) {
      throw error;
    }
  }
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
    authSession.queuePendingCode(callback.code);
    return true;
  }

  void authSession.consumeCode(callback.code).catch(logDesktopAuthError);
  return true;
}

interface PreventableNavigationEvent {
  readonly preventDefault: () => void;
}

function handleAuthNavigation(
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
  return false;
}

interface BrowserWindowOptionsInput {
  readonly preload?: boolean;
}

function browserWindowOptions(options: BrowserWindowOptionsInput = {}) {
  const preload = options.preload === false ? undefined : preloadPath();
  return {
    title: config.identity.displayName,
    backgroundColor: "#19191b",
    icon: appIconPath(),
    ...buildDesktopWindowChromeOptions(process.platform),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      ...(preload ? { preload } : {}),
      partition: config.sessionPartition,
    },
  } satisfies Electron.BrowserWindowConstructorOptions;
}

function installMainWindowPolicy(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (handleAuthNavigation(event, url)) {
      return;
    }

    if (isDesktopRendererUrl(url, localRendererUrl)) {
      return;
    }
    event.preventDefault();
    const decision = decideWindowOpen(url, noAllowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
  });

  window.webContents.on("will-redirect", (event) => {
    if (!event.isMainFrame) {
      return;
    }
    handleAuthNavigation(event, event.url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (openDesktopAuthCallback(url)) {
      return { action: "deny" };
    }
    if (openDesktopAuthStart(url)) {
      return { action: "deny" };
    }

    const decision = decideWindowOpen(url, noAllowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
    return { action: "deny" };
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
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
  await window.loadURL(localRendererUrl);
  return window;
}

function installAuthConsumeWindowPolicy(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, config.allowedAppOrigins)) {
      return;
    }
    event.preventDefault();
    const decision = decideWindowOpen(url, noAllowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, noAllowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
    return { action: "deny" };
  });
}

function waitForAuthConsumeWindow(window: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      rejectAuth(new Error("Desktop auth consume timed out"));
    }, 30_000);

    const cleanup = (): void => {
      clearTimeout(timeout);
      window.webContents.off("did-navigate", handleNavigation);
      window.webContents.off("did-fail-load", handleLoadFailure);
      window.off("closed", handleClosed);
    };

    const resolveAuth = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (!window.isDestroyed()) {
        window.close();
      }
      resolve();
    };

    const rejectAuth = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (!window.isDestroyed()) {
        window.close();
      }
      reject(error);
    };

    const handleNavigation = (_event: Electron.Event, url: string): void => {
      if (isDesktopAuthSelectOrgNavigation(url, config.allowedAppOrigins)) {
        showAndFocusWindow(window);
        return;
      }
      if (isDesktopAuthCompletionNavigation(url, config.allowedAppOrigins)) {
        resolveAuth();
      }
    };

    const handleLoadFailure = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      if (errorCode === ELECTRON_ERR_ABORTED) {
        return;
      }
      if (isMainFrame) {
        rejectAuth(
          new Error(
            `Desktop auth consume failed: ${errorCode} ${errorDescription}`,
          ),
        );
      }
    };

    const handleClosed = (): void => {
      rejectAuth(new Error("Desktop auth consume window closed"));
    };

    window.webContents.on("did-navigate", handleNavigation);
    window.webContents.on("did-fail-load", handleLoadFailure);
    window.on("closed", handleClosed);
  });
}

async function maybeStartComputerUseAfterAuth(): Promise<void> {
  computerUseRuntime?.stop();
  computerUseRuntime = null;
  notifyDesktopAuthChanged();
  notifyDesktopComputerUseChanged();
  const permissions = await refreshComputerUsePermissionState();
  notifyDesktopComputerUseChanged();
  if (hasRequiredComputerUsePermissions(permissions)) {
    await startComputerUseRuntime();
  }
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
    authSession.queuePendingCode(callback.code);
    return true;
  }

  void authSession.consumeCode(callback.code).catch(logDesktopAuthError);
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
  authSession.queuePendingCode(callback.code);
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
    if (!computerUseRuntime || computerUseQuitStopStarted) {
      computerUseNativeBackend.dispose();
      return;
    }
    computerUseQuitStopStarted = true;
    event.preventDefault();
    void stopComputerUseRuntimeForQuit().finally(() => {
      computerUseNativeBackend.dispose();
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    applyDockIcon();
    applyApplicationMenu();
    registerDesktopAuthProtocol();
    installDesktopRendererProtocol();
    installComputerUse();
    refreshComputerUsePermissionsForState();
    installDesktopAuth();
    queueDesktopAuthCallbackArgv(process.argv);

    const pendingCode = authSession.takePendingCode();
    await createMainWindow();
    if (pendingCode) {
      void authSession.consumeCode(pendingCode).catch(logDesktopAuthError);
    }

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
