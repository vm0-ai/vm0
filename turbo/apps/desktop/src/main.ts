import { captureDesktopNativeHelperError } from "./sentry-main";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  powerSaveBlocker,
  protocol,
  session,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import {
  ComputerUseSnapshotStore,
  executeComputerUseCommand,
} from "./computer-use-accessibility";
import {
  MAC_AUTOMATION_SETTINGS_URL,
  createAutomationPermissionDeniedPrompt,
} from "./desktop-automation-permission";
import {
  installComputerUseIpc,
  notifyDesktopComputerUseChanged,
} from "./computer-use-electron";
import {
  ComputerUseHostRuntime,
  readSystemHostName,
  resolveComputerUseApiBaseUrl,
} from "./computer-use-host";
import {
  COMPUTER_USE_FEATURE_SWITCH_KEY,
  OFFLINE_COMPUTER_USE_HOST_STATE,
  hasRequiredComputerUsePermissions,
  type ComputerUseHostRuntimeState,
  type DesktopComputerUseState,
} from "./computer-use-types";
import {
  isComputerUseSetupRequired,
  resolveComputerUseStartupGate,
  type ComputerUseStartupGate,
} from "./computer-use-startup-gate";
import {
  getComputerUsePermissionState,
  refreshComputerUsePermissionState,
  requestComputerUseAccessibilityPermission,
  requestComputerUseScreenRecordingPermission,
  setComputerUsePermissionNativeBackend,
} from "./computer-use-permissions";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { resolveDesktopConfig } from "./config";
import { installDesktopAutoUpdates } from "./desktop-auto-updates";
import { DesktopComputerUseAutoStartSupervisor } from "./desktop-computer-use-autostart";
import { createDesktopComputerUseSessionFetch } from "./desktop-computer-use-api";
import { readOrCreateComputerUseInstallationId } from "./desktop-computer-use-installation";
import { DesktopKeepAwakeController } from "./desktop-keep-awake";
import { startDesktopLaunchComputerUse } from "./desktop-launch-computer-use";
import {
  DesktopQuitConfirmationController,
  buildDesktopQuitConfirmationOptions,
  isDesktopQuitConfirmed,
} from "./desktop-quit-confirmation";
import { installDesktopTray, type DesktopTrayController } from "./desktop-tray";
import { DesktopAuthSession } from "./desktop-auth-session";
import {
  installDesktopAuthIpc,
  notifyDesktopAuthChanged,
} from "./desktop-auth-electron";
import {
  installDesktopDeveloperToolsIpc,
  notifyDesktopDeveloperToolsChanged,
} from "./desktop-developer-tools-electron";
import type { DesktopDeveloperToolsState } from "./desktop-bridge";
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
  type DesktopAuthCallback,
} from "./desktop-auth";
import {
  hideDockForHiddenMainWindow,
  shouldHideMainWindowOnClose,
  showAndFocusWindow,
  showDockForVisibleMainWindow,
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
const ZERO_DEBUG_FEATURE_SWITCH_KEY = "zeroDebug";
const ZERO_FEATURE_SWITCHES_PATH = "/api/zero/feature-switches";
const noAllowedAppOrigins: ReadonlySet<string> = new Set();
const ELECTRON_ERR_ABORTED = -3;
const COMPUTER_USE_QUIT_STOP_TIMEOUT_MS = 1_000;
const DESKTOP_SIGN_OUT_STORAGES = [
  "cookies",
  "localstorage",
  "indexdb",
  "serviceworkers",
  "cachestorage",
] as const;
const MAC_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const MAC_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
let mainWindow: BrowserWindow | null = null;
let appIsQuitting = false;
let computerUseQuitStopStarted = false;
let computerUseManualStopRequested = false;
let computerUseNativeBackendDisposed = false;
let desktopTray: DesktopTrayController | null = null;
let keepAwakeController: DesktopKeepAwakeController | null = null;
let developerToolsAvailable = false;
let developerToolsEnabled = false;
let developerToolsRefresh: Promise<void> | null = null;
let developerToolsRefreshRequested = false;
const desktopAuthStartGate = createDesktopAuthStartGate();
let computerUseRuntime: ComputerUseHostRuntime | null = null;
let computerUseBlockedHostState: ComputerUseHostRuntimeState | null = null;
const computerUseSnapshotStore = new ComputerUseSnapshotStore();
const computerUseNativeBackend = createComputerUseNativeBackend({
  onRuntimeError: captureDesktopNativeHelperError,
});
setComputerUsePermissionNativeBackend(computerUseNativeBackend);
const automationPermissionPrompt = createAutomationPermissionDeniedPrompt({
  sourceLabel: config.identity.displayName,
  showDialog: async (options) => {
    const window = currentDialogWindow();
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    return result.response;
  },
  openAutomationSettings: () => {
    openExternal(MAC_AUTOMATION_SETTINGS_URL);
  },
  onError: (error) => {
    console.error("Automation permission prompt failed", error);
  },
});
const computerUseAutoStart = new DesktopComputerUseAutoStartSupervisor({
  getState: getComputerUseBridgeState,
  start: async () => {
    await startComputerUseRuntime();
  },
  logError: logComputerUseAutoStartError,
});
const quitConfirmation = new DesktopQuitConfirmationController({
  confirmQuit: confirmDesktopQuit,
  quit: () => {
    app.quit();
  },
});

function refreshDesktopTray(): void {
  desktopTray?.refresh();
}

function refreshDesktopTrayAuth(): void {
  desktopTray?.refreshAuth();
}

function notifyComputerUseChanged(): void {
  notifyDesktopComputerUseChanged();
  refreshDesktopTray();
  computerUseAutoStart.restartRecoverableRuntimeState();
}

function notifyAuthChanged(): void {
  notifyDesktopAuthChanged();
  refreshDesktopTrayAuth();
  refreshDeveloperToolsAvailabilityForState();
}

function notifyDeveloperToolsChanged(): void {
  notifyDesktopDeveloperToolsChanged();
  if (app.isReady()) {
    applyApplicationMenu();
  }
}

function getDesktopDeveloperToolsState(): DesktopDeveloperToolsState {
  return {
    available: developerToolsAvailable,
    enabled: developerToolsAvailable && developerToolsEnabled,
  };
}

function setDesktopDeveloperToolsEnabled(
  enabled: boolean,
): DesktopDeveloperToolsState {
  const nextEnabled = developerToolsAvailable && enabled;
  if (developerToolsEnabled !== nextEnabled) {
    developerToolsEnabled = nextEnabled;
    notifyDeveloperToolsChanged();
  }
  return getDesktopDeveloperToolsState();
}

function setDeveloperToolsAvailability(available: boolean): void {
  const nextEnabled = available ? developerToolsEnabled : false;
  if (
    developerToolsAvailable === available &&
    developerToolsEnabled === nextEnabled
  ) {
    return;
  }
  developerToolsAvailable = available;
  developerToolsEnabled = nextEnabled;
  notifyDeveloperToolsChanged();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroDebugEnabledFromFeatureSwitches(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.switches)) {
    return false;
  }
  return value.switches[ZERO_DEBUG_FEATURE_SWITCH_KEY] === true;
}

async function refreshDeveloperToolsAvailability(): Promise<void> {
  const response = await getAuthSession().fetchWithSessionAuth(
    new URL(ZERO_FEATURE_SWITCHES_PATH, desktopApiBaseUrl),
  );
  if (response.status === 401) {
    setDeveloperToolsAvailability(false);
    return;
  }
  if (!response.ok) {
    throw new Error(
      `Desktop developer tools feature switch failed: ${response.status}`,
    );
  }
  const body: unknown = await response.json();
  setDeveloperToolsAvailability(zeroDebugEnabledFromFeatureSwitches(body));
}

function refreshDeveloperToolsAvailabilityForState(): void {
  if (developerToolsRefresh) {
    developerToolsRefreshRequested = true;
    return;
  }
  developerToolsRefresh = refreshDeveloperToolsAvailability()
    .catch((error) => {
      console.warn("Unable to refresh desktop developer tools state", error);
      setDeveloperToolsAvailability(false);
    })
    .finally(() => {
      developerToolsRefresh = null;
      if (developerToolsRefreshRequested) {
        developerToolsRefreshRequested = false;
        refreshDeveloperToolsAvailabilityForState();
      }
    });
}

async function runAuthWindow(request: {
  readonly url: string;
  readonly visible: boolean;
  readonly allowInteractiveFallbacks: boolean;
}): Promise<void> {
  const authWindow = new BrowserWindow({
    ...browserWindowOptions(),
    show: request.visible,
    width: request.visible ? 520 : 480,
    height: 640,
    skipTaskbar: !request.visible,
  });
  installAuthConsumeWindowPolicy(authWindow);
  const pending = waitForAuthConsumeWindow(authWindow, {
    allowInteractiveFallbacks: request.allowInteractiveFallbacks,
  });
  await loadAuthUrl(authWindow, request.url);
  await pending;
}

let authSession: DesktopAuthSession | null = null;
let pendingDesktopAuthCallback: DesktopAuthCallback | null = null;

function getAuthSession(): DesktopAuthSession {
  if (authSession) {
    return authSession;
  }

  if (!app.isReady()) {
    throw new Error("Desktop auth session is unavailable before app is ready");
  }

  authSession = new DesktopAuthSession({
    apiBaseUrl: desktopApiBaseUrl,
    cookieUrls: [config.webUrl, config.platformUrl],
    cookieSource: session.fromPartition(config.sessionPartition),
    tokenUrl: desktopAuthTokenUrl,
    consumeUrl: (code, handoffId) =>
      buildDesktopAuthConsumeUrl(config.webUrl, code, handoffId),
    selectOrgUrl: desktopAuthSelectOrgUrl,
    runAuthWindow,
    onChange: notifyAuthChanged,
    onAuthCompleted: maybeStartComputerUseAfterAuth,
  });

  if (pendingDesktopAuthCallback) {
    authSession.queuePendingCallback(pendingDesktopAuthCallback);
    pendingDesktopAuthCallback = null;
  }

  return authSession;
}

function queuePendingDesktopAuthCallback(callback: DesktopAuthCallback): void {
  if (authSession) {
    authSession.queuePendingCallback(callback);
    return;
  }
  pendingDesktopAuthCallback = callback;
}

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

function trayIconPath(): string {
  return path.join(__dirname, "..", "assets", "tray-iconTemplate.png");
}

function trayIconDisabledPath(): string {
  return path.join(__dirname, "..", "assets", "tray-iconDisabled.png");
}

function trayIconRunningPath(): string {
  return path.join(__dirname, "..", "assets", "tray-iconRunning.png");
}

function desktopPreferencesPath(): string {
  return path.join(app.getPath("userData"), "desktop-preferences.json");
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

function hideDockForInactiveMainWindow(): void {
  hideDockForHiddenMainWindow({
    platform: process.platform,
    dock: app.dock,
  });
}

async function showDockForActiveMainWindow(): Promise<void> {
  await showDockForVisibleMainWindow({
    platform: process.platform,
    dock: app.dock,
  });
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
    host:
      computerUseRuntime?.getState() ??
      computerUseBlockedHostState ??
      OFFLINE_COMPUTER_USE_HOST_STATE,
    keepAwake: keepAwakeController?.getState() ?? {
      enabled: false,
      active: false,
    },
  };
}

function installKeepAwake(): void {
  keepAwakeController = new DesktopKeepAwakeController({
    preferencesPath: desktopPreferencesPath(),
    blocker: powerSaveBlocker,
    onChange: notifyComputerUseChanged,
  });
  keepAwakeController.load();
}

function setKeepAwakeEnabled(enabled: boolean): DesktopComputerUseState {
  if (!keepAwakeController) {
    throw new Error("Desktop keep-awake settings are unavailable");
  }
  keepAwakeController.setEnabled(enabled);
  return getComputerUseBridgeState();
}

function releaseKeepAwake(): void {
  keepAwakeController?.release();
}

async function startComputerUseRuntime(
  options: { readonly userInitiated?: boolean } = {},
): Promise<DesktopComputerUseState> {
  if (computerUseManualStopRequested && options.userInitiated !== true) {
    return getComputerUseBridgeState();
  }
  computerUseManualStopRequested = false;

  const permissions = await refreshComputerUsePermissionState();
  let startupGate: ComputerUseStartupGate = { status: "missing_permissions" };
  if (hasRequiredComputerUsePermissions(permissions)) {
    const authState = await getAuthSession().getAuthState();
    startupGate = resolveComputerUseStartupGate({ authState, permissions });
  }
  if (startupGate.status !== "ready") {
    if (computerUseRuntime) {
      await computerUseRuntime.stop();
      computerUseRuntime = null;
    }
    computerUseBlockedHostState =
      startupGate.status === "blocked" ? startupGate.host : null;
    notifyComputerUseChanged();
    return getComputerUseBridgeState();
  }

  const desktopSession = session.fromPartition(config.sessionPartition);
  computerUseBlockedHostState = null;
  if (!computerUseRuntime) {
    const installationId = readOrCreateComputerUseInstallationId(
      desktopPreferencesPath(),
    );
    computerUseRuntime = new ComputerUseHostRuntime({
      platformUrl: config.platformUrl,
      installationId,
      hostName: readSystemHostName(config.identity.displayName),
      appVersion: app.getVersion(),
      sessionFetch: createDesktopComputerUseSessionFetch({
        platformUrl: config.platformUrl,
        session: desktopSession,
        getCachedAuthToken: () => getAuthSession().getCachedToken(),
        getAuthToken: (options) => getAuthSession().getToken(options),
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
      onCommandFailure: automationPermissionPrompt,
      onChange: notifyComputerUseChanged,
    });
  }
  await computerUseRuntime.start();
  return getComputerUseBridgeState();
}

async function stopComputerUseRuntime(): Promise<DesktopComputerUseState> {
  computerUseManualStopRequested = true;
  await computerUseRuntime?.stop();
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

async function requestComputerUsePermission(): Promise<DesktopComputerUseState> {
  await requestComputerUseAccessibilityPermission();
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

async function requestComputerUseScreenRecording(): Promise<DesktopComputerUseState> {
  await requestComputerUseScreenRecordingPermission();
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

async function refreshComputerUsePermissions(): Promise<DesktopComputerUseState> {
  const permissions = await refreshComputerUsePermissionState();
  if (!hasRequiredComputerUsePermissions(permissions)) {
    computerUseBlockedHostState = null;
  }
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

function installComputerUse(): void {
  installComputerUseIpc(
    {
      getState: getComputerUseBridgeState,
      refreshPermissions: refreshComputerUsePermissions,
      start: startComputerUseRuntime,
      stop: stopComputerUseRuntime,
      requestAccessibilityPermission: requestComputerUsePermission,
      requestScreenRecordingPermission: requestComputerUseScreenRecording,
      setKeepAwakeEnabled,
    },
    { rendererUrl: localRendererUrl },
  );
}

function installDesktopDeveloperTools(): void {
  installDesktopDeveloperToolsIpc(
    {
      getState: getDesktopDeveloperToolsState,
      setEnabled: setDesktopDeveloperToolsEnabled,
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
      notifyComputerUseChanged();
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

function disposeComputerUseNativeBackend(): void {
  if (computerUseNativeBackendDisposed) {
    return;
  }
  computerUseNativeBackendDisposed = true;
  computerUseNativeBackend.dispose();
}

async function prepareForQuitAndInstall(): Promise<void> {
  quitConfirmation.allowQuitWithoutConfirmation();
  appIsQuitting = true;
  releaseKeepAwake();
  if (!computerUseQuitStopStarted) {
    computerUseQuitStopStarted = true;
    await stopComputerUseRuntimeForQuit();
  }
  disposeComputerUseNativeBackend();
}

async function clearDesktopAuthStorage(): Promise<void> {
  await session.fromPartition(config.sessionPartition).clearStorageData({
    storages: [...DESKTOP_SIGN_OUT_STORAGES],
  });
}

async function signOutDesktopSession(): Promise<void> {
  await clearDesktopAuthStorage();
  getAuthSession().signOut();
  const runtime = computerUseRuntime;
  computerUseRuntime = null;
  computerUseBlockedHostState = null;
  try {
    await runtime?.stop();
  } finally {
    notifyComputerUseChanged();
  }
}

function installDesktopAuth(): void {
  installDesktopAuthIpc(
    {
      getState: () => getAuthSession().getAuthState(),
      openSignIn: () => {
        openExternal(desktopAuthStartUrl);
      },
      openOrgSelection: () => getAuthSession().selectOrganization(),
      signOut: signOutDesktopSession,
      completeSignIn: (token) => getAuthSession().completeSignIn(token),
    },
    {
      rendererUrl: localRendererUrl,
      allowedAppOrigins: config.allowedAppOrigins,
    },
  );
}

function installTray(): void {
  desktopTray = installDesktopTray({
    displayName: config.identity.displayName,
    iconPath: trayIconPath(),
    disabledIconPath: trayIconDisabledPath(),
    runningIconPath: trayIconRunningPath(),
    getComputerUseState: getComputerUseBridgeState,
    getAuthState: () => getAuthSession().getAuthState(),
    showMainWindow: async () => {
      await createMainWindow();
    },
    startComputerUse: async () => {
      await startComputerUseRuntime({ userInitiated: true });
    },
    stopComputerUse: async () => {
      await stopComputerUseRuntime();
    },
    refreshStatus: async () => {
      await refreshComputerUsePermissions();
    },
    openSignIn: () => {
      openExternal(desktopAuthStartUrl);
    },
    switchWorkspace: () => getAuthSession().selectOrganization(),
    signOut: signOutDesktopSession,
    requestAccessibilityPermission: async () => {
      await requestComputerUsePermission();
    },
    requestScreenRecordingPermission: async () => {
      await requestComputerUseScreenRecording();
    },
    openAccessibilitySettings: () => {
      openExternal(MAC_ACCESSIBILITY_SETTINGS_URL);
    },
    openScreenRecordingSettings: () => {
      openExternal(MAC_SCREEN_RECORDING_SETTINGS_URL);
    },
    setKeepAwakeEnabled: async (enabled) => {
      setKeepAwakeEnabled(enabled);
    },
    quit: () => {
      requestDesktopQuit();
    },
  });
}

function requestDesktopQuit(): void {
  void quitConfirmation.requestQuit().catch((error) => {
    console.error("Desktop quit confirmation failed", error);
  });
}

function applyApplicationMenu(): void {
  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: "about" },
    { type: "separator" },
  ];
  if (developerToolsAvailable) {
    appSubmenu.push({
      label: "Developer Tools",
      type: "checkbox",
      checked: developerToolsEnabled,
      click: () => {
        setDesktopDeveloperToolsEnabled(!developerToolsEnabled);
      },
    });
    appSubmenu.push({ type: "separator" });
  }
  appSubmenu.push({
    label: `Quit ${config.identity.displayName}`,
    accelerator: "CommandOrControl+Q",
    click: requestDesktopQuit,
  });

  const menu = Menu.buildFromTemplate([
    {
      label: config.identity.displayName,
      submenu: appSubmenu,
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

function currentDialogWindow(): BrowserWindow | undefined {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? mainWindow
    : undefined;
}

async function confirmDesktopQuit(): Promise<boolean> {
  const options = buildDesktopQuitConfirmationOptions(
    config.identity.displayName,
  );
  const window = currentDialogWindow();
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return isDesktopQuitConfirmed(result.response);
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

function logComputerUseAutoStartError(error: unknown): void {
  console.error("Desktop Computer Use auto-start failed", error);
}

function logComputerUseLaunchError(error: unknown): void {
  console.error("Desktop Computer Use launch setup check failed", error);
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

  if (!authSession) {
    queuePendingDesktopAuthCallback(callback);
    return true;
  }

  void authSession
    .consumeCode(callback.code, callback.handoffId)
    .catch(logDesktopAuthError);
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
    await showDockForActiveMainWindow();
    showAndFocusWindow(mainWindow);
    return mainWindow;
  }

  await showDockForActiveMainWindow();
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
      hideDockForInactiveMainWindow();
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

function waitForAuthConsumeWindow(
  window: BrowserWindow,
  options: { readonly allowInteractiveFallbacks: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    const timeout = setTimeout(() => {
      rejectAuth(new Error("Desktop auth consume timed out"));
    }, 30_000);

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (!closed && !window.isDestroyed()) {
        window.webContents.off("did-navigate", handleNavigation);
        window.webContents.off("did-fail-load", handleLoadFailure);
        window.off("closed", handleClosed);
      }
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
      if (
        !options.allowInteractiveFallbacks &&
        isDesktopAuthStartNavigation(url, config.allowedAppOrigins)
      ) {
        resolveAuth();
        return;
      }
      if (isDesktopAuthSelectOrgNavigation(url, config.allowedAppOrigins)) {
        if (options.allowInteractiveFallbacks) {
          showAndFocusWindow(window);
          return;
        }
        resolveAuth();
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
      closed = true;
      rejectAuth(new Error("Desktop auth consume window closed"));
    };

    window.webContents.on("did-navigate", handleNavigation);
    window.webContents.on("did-fail-load", handleLoadFailure);
    window.on("closed", handleClosed);
  });
}

async function maybeStartComputerUseAfterAuth(): Promise<void> {
  const runtime = computerUseRuntime;
  computerUseRuntime = null;
  computerUseBlockedHostState = null;
  await runtime?.stop();
  notifyAuthChanged();
  notifyComputerUseChanged();
  const permissions = await refreshComputerUsePermissionState();
  notifyComputerUseChanged();
  if (hasRequiredComputerUsePermissions(permissions)) {
    await startComputerUseRuntime({ userInitiated: true });
  }
}

async function shouldOpenComputerUseSetupWindowOnLaunch(): Promise<boolean> {
  const permissions = await refreshComputerUsePermissionState();
  if (!hasRequiredComputerUsePermissions(permissions)) {
    return true;
  }

  const authState = await getAuthSession().getAuthState();
  return isComputerUseSetupRequired({ authState, permissions });
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
  if (!authSession) {
    queuePendingDesktopAuthCallback(callback);
    return true;
  }

  void authSession
    .consumeCode(callback.code, callback.handoffId)
    .catch(logDesktopAuthError);
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
  queuePendingDesktopAuthCallback(callback);
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
    if (!quitConfirmation.isQuitAllowed()) {
      event.preventDefault();
      requestDesktopQuit();
      return;
    }

    appIsQuitting = true;
    releaseKeepAwake();
    if (!computerUseRuntime || computerUseQuitStopStarted) {
      disposeComputerUseNativeBackend();
      return;
    }
    computerUseQuitStopStarted = true;
    event.preventDefault();
    void stopComputerUseRuntimeForQuit().finally(() => {
      disposeComputerUseNativeBackend();
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    applyDockIcon();
    hideDockForInactiveMainWindow();
    applyApplicationMenu();
    registerDesktopAuthProtocol();
    installDesktopRendererProtocol();
    installDesktopAutoUpdates({
      config,
      apiBaseUrl: desktopApiBaseUrl,
      getComputerUseHostState: () => getComputerUseBridgeState().host,
      prepareForQuitAndInstall,
    });
    installKeepAwake();
    installComputerUse();
    installDesktopDeveloperTools();
    refreshComputerUsePermissionsForState();
    const desktopAuthSession = getAuthSession();
    installDesktopAuth();
    refreshDeveloperToolsAvailabilityForState();
    installTray();
    queueDesktopAuthCallbackArgv(process.argv);

    startDesktopLaunchComputerUse({
      pendingCallback: desktopAuthSession.takePendingCallback(),
      consumeAuthCallback: (callback) =>
        desktopAuthSession.consumeCode(callback.code, callback.handoffId),
      isComputerUseSetupRequired: shouldOpenComputerUseSetupWindowOnLaunch,
      openSetupWindow: async () => {
        await createMainWindow();
      },
      requestAutoStartComputerUse: () => {
        computerUseAutoStart.requestStart();
      },
      logAuthError: logDesktopAuthError,
      logLaunchError: logComputerUseLaunchError,
    });

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
