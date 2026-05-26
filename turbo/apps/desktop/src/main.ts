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
import type { DesktopAuthState } from "./desktop-bridge";
import {
  getComputerUsePermissionState,
  requestComputerUseAccessibilityPermission,
} from "./computer-use-permissions";
import { resolveDesktopConfig } from "./config";
import { createDesktopComputerUseSessionFetch } from "./desktop-computer-use-api";
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
const AUTH_ME_PATH = "/api/auth/me";
const ZERO_ORG_PATH = "/api/zero/org";
const COMPUTER_USE_QUIT_STOP_TIMEOUT_MS = 1_000;
let mainWindow: BrowserWindow | null = null;
let pendingDesktopAuthCode: string | null = null;
let appIsQuitting = false;
let computerUseQuitStopStarted = false;
const desktopAuthStartGate = createDesktopAuthStartGate();
let computerUseRuntime: ComputerUseHostRuntime | null = null;
let desktopAuthToken: string | null = null;
let desktopAuthTokenRefresh: Promise<string | null> | null = null;
const computerUseSnapshotStore = new ComputerUseSnapshotStore();

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

interface AuthMeResponse {
  readonly userId: string;
  readonly email: string;
}

interface ZeroOrgResponse {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
}

function signedOutDesktopAuthState(): DesktopAuthState {
  return {
    status: "signed_out",
    user: null,
    organization: null,
  };
}

async function getDesktopAuthState(): Promise<DesktopAuthState> {
  if (!desktopAuthToken) {
    return signedOutDesktopAuthState();
  }

  const authHeaders = {
    authorization: `Bearer ${desktopAuthToken}`,
  };
  const meResponse = await fetch(`${desktopApiBaseUrl}${AUTH_ME_PATH}`, {
    headers: authHeaders,
  });
  if (meResponse.status === 401) {
    desktopAuthToken = null;
    return signedOutDesktopAuthState();
  }
  if (!meResponse.ok) {
    throw new Error(`Desktop auth status failed: ${meResponse.status}`);
  }

  const user = (await meResponse.json()) as AuthMeResponse;
  const orgResponse = await fetch(`${desktopApiBaseUrl}${ZERO_ORG_PATH}`, {
    headers: authHeaders,
  });
  if (orgResponse.status === 401) {
    desktopAuthToken = null;
    return signedOutDesktopAuthState();
  }
  if (orgResponse.status === 404) {
    return { status: "signed_in", user, organization: null };
  }
  if (!orgResponse.ok) {
    throw new Error(
      `Desktop organization status failed: ${orgResponse.status}`,
    );
  }

  const organization = (await orgResponse.json()) as ZeroOrgResponse;
  return {
    status: "signed_in",
    user,
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug ?? null,
    },
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
        getAuthToken: getDesktopAuthToken,
      }),
      hostFetch: (input, init) => {
        return fetch(input, init);
      },
      getPermissions: getComputerUsePermissionState,
      executeCommand: (command, permissions) => {
        return executeComputerUseCommand(command, permissions, {
          snapshotStore: computerUseSnapshotStore,
        });
      },
      onChange: notifyDesktopComputerUseChanged,
    });
  }
  await computerUseRuntime.start();
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
      start: startComputerUseRuntime,
      requestAccessibilityPermission: requestComputerUsePermission,
    },
    { rendererUrl: localRendererUrl },
  );
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
      getState: getDesktopAuthState,
      openSignIn: () => {
        openExternal(desktopAuthStartUrl);
      },
      openOrgSelection: openDesktopAuthSelectOrg,
      completeSignIn: completeDesktopAuthSignIn,
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

function completeDesktopAuthSignIn(token: string): void {
  desktopAuthToken = token;
  notifyDesktopAuthChanged();
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

async function refreshDesktopAuthToken(): Promise<string | null> {
  if (desktopAuthTokenRefresh) {
    return await desktopAuthTokenRefresh;
  }

  desktopAuthTokenRefresh = (async () => {
    const authWindow = new BrowserWindow({
      ...browserWindowOptions(),
      show: false,
      width: 480,
      height: 640,
      skipTaskbar: true,
    });
    installAuthConsumeWindowPolicy(authWindow);
    const pendingToken = waitForAuthConsumeWindow(authWindow);
    await loadAuthUrl(authWindow, desktopAuthTokenUrl);
    await pendingToken;
    return desktopAuthToken;
  })();

  try {
    return await desktopAuthTokenRefresh;
  } finally {
    desktopAuthTokenRefresh = null;
  }
}

async function getDesktopAuthToken(options?: {
  readonly forceRefresh?: boolean;
}): Promise<string | null> {
  if (!options?.forceRefresh && desktopAuthToken) {
    return desktopAuthToken;
  }
  return await refreshDesktopAuthToken();
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

  void openDesktopAuthConsume(callback.code).catch(logDesktopAuthError);
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
  if (hasRequiredComputerUsePermissions(getComputerUsePermissionState())) {
    await startComputerUseRuntime();
  }
}

async function openDesktopAuthSelectOrg(): Promise<void> {
  const authWindow = new BrowserWindow({
    ...browserWindowOptions(),
    show: true,
    width: 520,
    height: 640,
    skipTaskbar: false,
  });
  installAuthConsumeWindowPolicy(authWindow);
  const pendingSelection = waitForAuthConsumeWindow(authWindow);
  await loadAuthUrl(authWindow, desktopAuthSelectOrgUrl);
  await pendingSelection;
  await maybeStartComputerUseAfterAuth();
}

async function openDesktopAuthConsume(code: string): Promise<void> {
  const consumeUrl = buildDesktopAuthConsumeUrl(config.webUrl, code);
  const authWindow = new BrowserWindow({
    ...browserWindowOptions(),
    show: false,
    width: 480,
    height: 640,
    skipTaskbar: true,
  });
  installAuthConsumeWindowPolicy(authWindow);
  const pendingConsume = waitForAuthConsumeWindow(authWindow);
  await loadAuthUrl(authWindow, consumeUrl);
  await pendingConsume;
  await maybeStartComputerUseAfterAuth();
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

  void openDesktopAuthConsume(callback.code).catch(logDesktopAuthError);
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
    if (!computerUseRuntime || computerUseQuitStopStarted) {
      return;
    }
    computerUseQuitStopStarted = true;
    event.preventDefault();
    void stopComputerUseRuntimeForQuit().finally(() => {
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    applyDockIcon();
    applyApplicationMenu();
    registerDesktopAuthProtocol();
    installDesktopRendererProtocol();
    installComputerUse();
    installDesktopAuth();
    queueDesktopAuthCallbackArgv(process.argv);

    const pendingCode = pendingDesktopAuthCode;
    pendingDesktopAuthCode = null;
    await createMainWindow();
    if (pendingCode) {
      void openDesktopAuthConsume(pendingCode).catch(logDesktopAuthError);
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
