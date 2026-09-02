import { captureDesktopNativeHelperError } from "./sentry-main";
import { openAsBlob, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
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
  SUPPORTED_COMPUTER_USE_CAPABILITIES,
  executeComputerUseCommand,
} from "./computer-use-accessibility";
import {
  COMPUTER_USE_PLUGIN_CALL_KIND,
  isComputerUseMcpPluginCallPayload,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
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
  hasRequiredComputerUsePermissions,
  type ComputerUseAutomationPermissionTarget,
  type DesktopComputerUseState,
} from "./computer-use-types";
import { isComputerUseSetupRequired } from "./computer-use-startup-gate";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import { DeveloperToolsController } from "./desktop-developer-tools-controller";
import { DesktopRecorderController } from "./desktop-recorder-controller";
import { createRecorderNativeBackend } from "./desktop-recorder-native";
import { deliverRecording } from "./desktop-recorder-delivery";
import { installDesktopRecorderIpc } from "./desktop-recorder-electron";
import { DesktopRecorderWindows } from "./desktop-recorder-windows";
import { STOP_SCREEN_RECORDING_ACCELERATOR } from "./desktop-recorder-types";
import type {
  DesktopRecorderArea,
  DesktopRecorderAudioChoice,
  DesktopRecorderPrepareRequest,
} from "./desktop-recorder-types";
import { buildWindowOptions } from "./desktop-recorder-window-options";
import { areaToGlobal } from "./desktop-recorder-overlay-geometry";
import {
  getComputerUsePermissionState,
  probeComputerUseAutomationPermission,
  refreshComputerUsePermissionState,
  recordComputerUseAutomationPermissionDenied,
  requestComputerUseAccessibilityPermission,
  requestComputerUseScreenRecordingPermission,
  setComputerUsePermissionNativeBackend,
} from "./computer-use-permissions";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { resolveDesktopConfig } from "./config";
import { checkForDesktopUpdates } from "./desktop-auto-updates";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import type { DesktopMainModule } from "./desktop-main-module";
import { DesktopComputerUseAutoStartSupervisor } from "./desktop-computer-use-autostart";
import { createDesktopComputerUseSessionFetch } from "./desktop-computer-use-api";
import { readOrCreateComputerUseInstallationId } from "./desktop-computer-use-installation";
import { DesktopFilesystemPluginManager } from "./desktop-filesystem-plugin";
import { DesktopMcpPluginManager } from "./desktop-mcp-plugin";
import { DesktopKeepAwakeController } from "./desktop-keep-awake";
import type { DesktopIdentityInfo } from "./desktop-bridge";
import { DESKTOP_IDENTITY_CHANNEL } from "./desktop-identity-ipc-channels";
import { startDesktopLaunchComputerUse } from "./desktop-launch-computer-use";
import {
  DesktopQuitConfirmationController,
  buildDesktopQuitConfirmationOptions,
  isDesktopQuitConfirmed,
} from "./desktop-quit-confirmation";
import {
  DESKTOP_SMOKE_TEST_READY_MARKER,
  isDesktopSmokeTestEnabled,
} from "./desktop-smoke-test";
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
  buildDesktopMainWindowSizeOptions,
  hideDockForHiddenMainWindow,
  shouldHideMainWindowOnClose,
  showAndFocusWindow,
  showDockForVisibleMainWindow,
} from "./desktop-window-lifecycle";
import { buildDesktopWindowChromeOptions } from "./desktop-window-chrome";
import {
  desktopRecorderUrl,
  desktopRendererFilePath,
  desktopRendererUrl,
  isDesktopRendererUrl,
} from "./desktop-renderer-url";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";

const config = resolveDesktopConfig();
const desktopApiBaseUrl = resolveComputerUseApiBaseUrl(config.platformUrl);
const addDesktopClientHeaders = createDesktopClientHeaderInjector({
  clientVersion: app.getVersion(),
  product: config.identity.product,
});
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
const localRecorderUrl = desktopRecorderUrl("bar");
const ZERO_FEATURE_SWITCHES_PATH = "/api/feature-switches";
const noAllowedAppOrigins: ReadonlySet<string> = new Set();
const ELECTRON_ERR_ABORTED = -3;
const DESKTOP_SIGN_OUT_STORAGES = [
  "cookies",
  "localstorage",
  "indexdb",
  "serviceworkers",
  "cachestorage",
] as const;
const SCREEN_RECORDING_POLL_INTERVAL_MS = 1000;
const MAC_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const MAC_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
let mainWindow: BrowserWindow | null = null;
let appIsQuitting = false;
let computerUseNativeBackendDisposed = false;
let desktopTray: DesktopTrayController | null = null;
let keepAwakeController: DesktopKeepAwakeController | null = null;

const desktopIdentity: DesktopIdentityInfo = {
  product: config.identity.product,
  brandName: config.identity.brandName,
  displayName: config.identity.displayName,
};

ipcMain.on(DESKTOP_IDENTITY_CHANNEL, (event) => {
  event.returnValue = desktopIdentity;
});
let filesystemPluginManager: DesktopFilesystemPluginManager | null = null;
let mcpPluginManager: DesktopMcpPluginManager | null = null;
let desktopAutoUpdatesInstalled = false;
const desktopAuthStartGate = createDesktopAuthStartGate();
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
  onPermissionDenied: (target, reason) => {
    recordComputerUseAutomationPermissionDenied(target, reason);
    notifyComputerUseChanged();
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
const screenRecorder = new DesktopRecorderController({
  createBackend: () => createRecorderNativeBackend(),
  createOutputPath: () =>
    path.join(
      app.getPath("userData"),
      "recordings",
      `screen-recording-${Date.now().toString()}.mp4`,
    ),
  canDeliver: async () => {
    const auth = await getAuthSession().getAuthState();
    return auth.status === "signed_in" && auth.organization !== null;
  },
  deliver: async (recording) => {
    const auth = await getAuthSession().getAuthState();
    if (auth.status !== "signed_in") {
      throw new Error("Sign in to Okou to upload the recording");
    }
    return await deliverRecording(recording, {
      apiBaseUrl: desktopApiBaseUrl,
      appUrl: config.platformUrl.toString(),
      userId: auth.user.userId,
      fetchWithSessionAuth: (url, init) =>
        getAuthSession().fetchWithSessionAuth(url, init),
      fetchUpload: (url, init) => fetch(url, init),
      // Streams from disk rather than buffering a whole video in memory.
      readFile: (filePath) => openAsBlob(filePath),
    });
  },
  openReview: (reviewUrl) => {
    openExternal(reviewUrl);
  },
  onChange: notifyScreenRecorderChanged,
  logError: (error) => {
    console.warn("Desktop screen recording teardown failed", error);
  },
});
let screenRecordingPollTimer: NodeJS.Timeout | null = null;
const developerTools = new DeveloperToolsController({
  fetchFeatureSwitches: () =>
    getAuthSession().fetchWithSessionAuth(
      new URL(ZERO_FEATURE_SWITCHES_PATH, desktopApiBaseUrl),
    ),
  setFilesystemPluginFeatureEnabled: (enabled) => {
    filesystemPluginManager?.setFeatureEnabled(enabled);
    mcpPluginManager?.setFeatureEnabled(enabled);
  },
  setScreenRecordingFeatureEnabled: (enabled) => {
    screenRecorder.setFeatureEnabled(enabled);
  },
  onChange: notifyDeveloperToolsChanged,
  logRefreshError: (error) => {
    console.warn("Unable to refresh desktop developer tools state", error);
  },
});
const computerUseController = new ComputerUseRuntimeController({
  createRuntime: createComputerUseHostRuntime,
  refreshPermissions: refreshComputerUsePermissionState,
  getAuthState: () => getAuthSession().getAuthState(),
  setHostRuntimeOnline: (online) => {
    filesystemPluginManager?.setHostRuntimeOnline(online);
    mcpPluginManager?.setHostRuntimeOnline(online);
  },
  onChange: notifyComputerUseChanged,
});

function refreshDesktopTray(): void {
  desktopTray?.refresh();
}

/**
 * Keeps the poll timer and the global stop shortcut alive exactly while a
 * capture is running.
 *
 * The helper protocol has no push channel, so a source disappearing — the
 * display being unplugged — only surfaces through polling. The shortcut is
 * registered just for the duration so it is not held hostage the rest of the
 * time, and it exists because the recording controls live in the menu bar
 * rather than in an overlay that the capture would record.
 */
function notifyScreenRecorderChanged(): void {
  refreshDesktopTray();

  const status = screenRecorder.getState().status;
  // Paused still holds the capture open, so the poll, the stop shortcut and the
  // on-screen controls all stay alive for it.
  const isCapturing = status === "recording" || status === "paused";

  // The controller belongs to a live capture and nothing else. Deciding that
  // here rather than at each call site is what dismisses it when a recording
  // ends from the tray, the shortcut, the system indicator, or a failure — and
  // what takes it off screen the moment a finish starts uploading.
  if (!isCapturing) {
    recorderWindows?.hideController();
  }

  if (isCapturing === (screenRecordingPollTimer !== null)) {
    return;
  }

  if (isCapturing) {
    screenRecordingPollTimer = setInterval(() => {
      void screenRecorder.refreshRecordingStatus().catch((error: unknown) => {
        console.warn("Desktop screen recording status refresh failed", error);
      });
    }, SCREEN_RECORDING_POLL_INTERVAL_MS);
    if (
      !globalShortcut.register(
        STOP_SCREEN_RECORDING_ACCELERATOR,
        stopScreenRecordingFromShortcut,
      )
    ) {
      console.warn(
        "Unable to register the screen recording stop shortcut",
        STOP_SCREEN_RECORDING_ACCELERATOR,
      );
    }
    return;
  }

  clearInterval(screenRecordingPollTimer ?? undefined);
  screenRecordingPollTimer = null;
  globalShortcut.unregister(STOP_SCREEN_RECORDING_ACCELERATOR);
}

function stopScreenRecordingFromShortcut(): void {
  void screenRecorder.stop().catch((error: unknown) => {
    console.error("Desktop screen recording stop failed", error);
  });
}

function refreshDesktopTrayAuth(): void {
  desktopTray?.refreshAuth();
}

function notifyComputerUseChanged(): void {
  filesystemPluginManager?.setHostRuntimeOnline(
    computerUseController.isRuntimeOnline(),
  );
  mcpPluginManager?.setHostRuntimeOnline(
    computerUseController.isRuntimeOnline(),
  );
  notifyDesktopComputerUseChanged();
  refreshDesktopTray();
  computerUseAutoStart.restartRecoverableRuntimeState();
}

function notifyAuthChanged(): void {
  notifyDesktopAuthChanged();
  refreshDesktopTrayAuth();
  developerTools.requestRefresh();
}

function notifyDeveloperToolsChanged(): void {
  notifyDesktopDeveloperToolsChanged();
  if (app.isReady()) {
    applyApplicationMenu();
  }
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
    addClientHeaders: addDesktopClientHeaders,
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
function friendlyDeviceName(): string | null {
  const hostname = os.hostname().trim();
  if (!hostname) {
    return null;
  }
  return hostname.replace(/\.local$/i, "");
}

function getComputerUseBridgeState(): DesktopComputerUseState {
  return {
    platform: process.platform,
    supported: process.platform === "darwin",
    deviceName: friendlyDeviceName(),
    permissions: getComputerUsePermissionState(),
    host: computerUseController.getHostState(),
    keepAwake: keepAwakeController?.getState() ?? {
      enabled: false,
      active: false,
    },
    plugins: {
      filesystem: filesystemPluginManager?.getState() ?? {
        featureEnabled: false,
        enabled: false,
        allowedDirectories: [],
        status: "disabled",
        lastError: null,
        version: "",
        capabilities: [],
      },
      mcp: mcpPluginManager?.getState() ?? {
        featureEnabled: false,
        servers: [],
      },
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

function ensureFilesystemPluginManager(): DesktopFilesystemPluginManager {
  if (!filesystemPluginManager) {
    filesystemPluginManager = new DesktopFilesystemPluginManager({
      preferencesPath: desktopPreferencesPath(),
      onChange: notifyComputerUseChanged,
    });
    filesystemPluginManager.load();
  }
  return filesystemPluginManager;
}

function ensureMcpPluginManager(): DesktopMcpPluginManager {
  if (!mcpPluginManager) {
    mcpPluginManager = new DesktopMcpPluginManager({
      preferencesPath: desktopPreferencesPath(),
      onChange: notifyComputerUseChanged,
    });
    mcpPluginManager.load();
  }
  return mcpPluginManager;
}

function supportedComputerUseCapabilities(): readonly string[] {
  return [
    ...SUPPORTED_COMPUTER_USE_CAPABILITIES,
    ...(filesystemPluginManager?.getCapabilities() ?? []),
    ...(mcpPluginManager?.getCapabilities() ?? []),
  ];
}

function createComputerUseHostRuntime(): ComputerUseHostRuntime {
  const desktopSession = session.fromPartition(config.sessionPartition);
  const installationId = readOrCreateComputerUseInstallationId(
    desktopPreferencesPath(),
  );
  return new ComputerUseHostRuntime({
    platformUrl: config.platformUrl,
    installationId,
    hostName: readSystemHostName(config.identity.displayName),
    appVersion: app.getVersion(),
    sessionFetch: createDesktopComputerUseSessionFetch({
      platformUrl: config.platformUrl,
      session: desktopSession,
      addClientHeaders: addDesktopClientHeaders,
      getCachedAuthToken: () => getAuthSession().getCachedToken(),
      getAuthToken: (options) => getAuthSession().getToken(options),
    }),
    hostFetch: (input, init) => {
      return fetch(input, init);
    },
    addClientHeaders: addDesktopClientHeaders,
    getPermissions: refreshComputerUsePermissionState,
    getSupportedCapabilities: supportedComputerUseCapabilities,
    executeCommand: (command, permissions) => {
      if (command.kind === COMPUTER_USE_PLUGIN_CALL_KIND) {
        if (isComputerUseMcpPluginCallPayload(command.payload)) {
          return ensureMcpPluginManager().execute(command);
        }
        return ensureFilesystemPluginManager().execute(command);
      }
      return executeComputerUseCommand(command, permissions, {
        nativeBackend: computerUseNativeBackend,
        snapshotStore: computerUseSnapshotStore,
      });
    },
    onCommandFailure: automationPermissionPrompt,
    onChange: notifyComputerUseChanged,
  });
}

async function startComputerUseRuntime(
  options: { readonly userInitiated?: boolean } = {},
): Promise<DesktopComputerUseState> {
  await computerUseController.start(options);
  return getComputerUseBridgeState();
}

async function stopComputerUseRuntime(): Promise<DesktopComputerUseState> {
  await computerUseController.stop();
  return getComputerUseBridgeState();
}

function setFilesystemPluginEnabled(enabled: boolean): DesktopComputerUseState {
  ensureFilesystemPluginManager().setEnabled(enabled);
  return getComputerUseBridgeState();
}

function importMcpPluginServers(json: string): DesktopComputerUseState {
  ensureMcpPluginManager().importServersJson(json);
  return getComputerUseBridgeState();
}

function setMcpPluginServerEnabled(
  server: string,
  enabled: boolean,
): DesktopComputerUseState {
  ensureMcpPluginManager().setServerEnabled(server, enabled);
  return getComputerUseBridgeState();
}

function removeMcpPluginServer(server: string): DesktopComputerUseState {
  ensureMcpPluginManager().removeServer(server);
  return getComputerUseBridgeState();
}

async function addFilesystemPluginAllowedDirectory(): Promise<DesktopComputerUseState> {
  const options = {
    properties: ["openDirectory", "createDirectory"],
  } satisfies Electron.OpenDialogOptions;
  const window = currentDialogWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (!result.canceled) {
    const [directory] = result.filePaths;
    if (directory) {
      ensureFilesystemPluginManager().addAllowedDirectory(directory);
    }
  }
  return getComputerUseBridgeState();
}

function removeFilesystemPluginAllowedDirectory(
  directory: string,
): DesktopComputerUseState {
  ensureFilesystemPluginManager().removeAllowedDirectory(directory);
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
    computerUseController.clearBlockedHostState();
  }
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

async function probeComputerUseAutomation(
  target: ComputerUseAutomationPermissionTarget,
): Promise<DesktopComputerUseState> {
  await probeComputerUseAutomationPermission(target);
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

function installComputerUse(): void {
  ensureFilesystemPluginManager();
  ensureMcpPluginManager();
  installComputerUseIpc(
    {
      getState: getComputerUseBridgeState,
      refreshPermissions: refreshComputerUsePermissions,
      start: startComputerUseRuntime,
      stop: stopComputerUseRuntime,
      requestAccessibilityPermission: requestComputerUsePermission,
      requestScreenRecordingPermission: requestComputerUseScreenRecording,
      probeAutomationPermission: probeComputerUseAutomation,
      setKeepAwakeEnabled,
      setFilesystemPluginEnabled,
      addFilesystemPluginAllowedDirectory,
      removeFilesystemPluginAllowedDirectory,
      importMcpPluginServers,
      setMcpPluginServerEnabled,
      removeMcpPluginServer,
    },
    { rendererUrl: localRendererUrl },
  );
}

let recorderWindows: DesktopRecorderWindows | null = null;

function getRecorderWindows(): DesktopRecorderWindows {
  recorderWindows ??= new DesktopRecorderWindows({
    preloadPath: preloadPath(),
    sessionPartition: config.sessionPartition,
    logError: (error) => {
      console.error("Desktop recorder overlay failed", error);
    },
  });
  return recorderWindows;
}

/**
 * The audio choices made in the bar, held while the area overlays are open.
 *
 * An area capture starts from the overlay that drew the region, by which time
 * the bar is no longer the one asking, so its toggles have to travel with the
 * selection rather than be read back from a window that may already be gone.
 */
let pendingAreaAudio: DesktopRecorderAudioChoice | null = null;

async function startRecorderCapture(
  request: DesktopRecorderPrepareRequest,
  captured: DesktopRecorderArea | null,
): Promise<void> {
  const windows = getRecorderWindows();
  await screenRecorder.prepare(request);
  await screenRecorder.start();
  // The bar has done its job; leaving it up would put it in the capture.
  windows.hideBar();
  windows.showController(captured);
}

function installDesktopRecorder(): void {
  installDesktopRecorderIpc(
    {
      getState: () => screenRecorder.getState(),
      listSources: () => screenRecorder.listSources(),
      listWindowOptions: async () => {
        const [sources, previews] = await Promise.all([
          screenRecorder.listSources(),
          screenRecorder.listWindowPreviews(),
        ]);
        return buildWindowOptions(sources.sources, previews);
      },
      startCapture: async (request) => {
        const windows = getRecorderWindows();
        await startRecorderCapture(
          {
            sourceId:
              request.sourceKind === "window"
                ? request.sourceId
                : windows.displaySourceId(windows.barDisplayId()),
            sourceKind: request.sourceKind,
            systemAudio: request.systemAudio,
            microphone: request.microphone,
          },
          null,
        );
      },
      beginAreaSelection: (audio) => {
        pendingAreaAudio = audio;
        getRecorderWindows().openAreaSelectors();
      },
      completeAreaSelection: async (selection) => {
        const windows = getRecorderWindows();
        const audio = pendingAreaAudio;
        pendingAreaAudio = null;
        windows.closeAreaSelectors();
        if (!selection || !audio) {
          return;
        }
        const display = windows.displayBounds(selection.displayId);
        if (!display) {
          throw new Error("The screen that region was drawn on is gone");
        }
        const area = areaToGlobal(selection.area, display);
        await startRecorderCapture(
          {
            sourceId: windows.displaySourceId(selection.displayId),
            sourceKind: "area",
            systemAudio: audio.systemAudio,
            microphone: audio.microphone,
            area,
          },
          area,
        );
      },
      selectWindow: () => getRecorderWindows().selectWindow(),
      completeWindowSelection: (choice) => {
        getRecorderWindows().completeWindowSelection(choice);
      },
      pause: () => screenRecorder.pause(),
      resume: () => screenRecorder.resume(),
      discard: () => screenRecorder.discard(),
      stop: async () => {
        await screenRecorder.stop();
      },
      cancel: () => {
        getRecorderWindows().hideBar();
      },
    },
    { recorderUrl: localRecorderUrl },
  );
}

function installDesktopDeveloperTools(): void {
  installDesktopDeveloperToolsIpc(
    {
      getState: () => developerTools.getState(),
      setEnabled: (enabled) => developerTools.setEnabled(enabled),
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
  await computerUseController.stopForQuit();
  disposeComputerUseNativeBackend();
}

// Bootstrap contract: the auto-updater is owned by bootstrap.ts so it keeps
// working when this bundle fails to load. Bootstrap reads these typed exports
// after requiring this module at runtime.
export const desktopUpdateHooks: DesktopMainModule["desktopUpdateHooks"] =
  () => ({
    getComputerUseHostState: () => getComputerUseBridgeState().host,
    prepareForQuitAndInstall,
  });

export const notifyDesktopAutoUpdatesInstalled: DesktopMainModule["notifyDesktopAutoUpdatesInstalled"] =
  (installed) => {
    desktopAutoUpdatesInstalled = installed;
    applyApplicationMenu();
  };

async function clearDesktopAuthStorage(): Promise<void> {
  await session.fromPartition(config.sessionPartition).clearStorageData({
    storages: [...DESKTOP_SIGN_OUT_STORAGES],
  });
}

async function signOutDesktopSession(): Promise<void> {
  await clearDesktopAuthStorage();
  getAuthSession().signOut();
  await computerUseController.stopForAuthChange();
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
    brandName: config.identity.brandName,
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
    getRecorderState: () => screenRecorder.getState(),
    startScreenRecording: async () => {
      getRecorderWindows().showBar();
    },
    stopScreenRecording: async () => {
      await screenRecorder.stop();
    },
    retryScreenRecordingDelivery: async () => {
      await screenRecorder.retryDelivery();
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

function requestDesktopUpdateCheck(): void {
  if (!desktopAutoUpdatesInstalled) {
    return;
  }

  checkForDesktopUpdates(config.identity.displayName);
}

function applyApplicationMenu(): void {
  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: "about" },
    {
      label: "Check for Updates...",
      enabled: desktopAutoUpdatesInstalled,
      click: requestDesktopUpdateCheck,
    },
    { type: "separator" },
  ];
  const developerToolsState = developerTools.getState();
  if (developerToolsState.available) {
    appSubmenu.push({
      label: "Developer Tools",
      type: "checkbox",
      checked: developerToolsState.enabled,
      click: () => {
        developerTools.setEnabled(!developerToolsState.enabled);
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

function dispatchDesktopAuthCallback(callback: DesktopAuthCallback): void {
  desktopAuthStartGate.suppressRetry();
  if (authSession) {
    authSession.consumeCallback(callback, logDesktopAuthError);
    return;
  }
  queuePendingDesktopAuthCallback(callback);
}

function openDesktopAuthCallback(rawUrl: string): boolean {
  const callback = parseDesktopAuthCallback(rawUrl, config.identity.authScheme);
  if (!callback) {
    return false;
  }

  dispatchDesktopAuthCallback(callback);
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
    ...buildDesktopMainWindowSizeOptions(),
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

interface DesktopSmokeBridgeState {
  readonly auth: boolean;
  readonly computerUse: boolean;
  readonly developerTools: boolean;
  readonly identity: DesktopIdentityInfo | null;
}

function isDesktopIdentityInfo(value: unknown): value is DesktopIdentityInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "product" in value &&
    (value.product === "zero" || value.product === "okou") &&
    "brandName" in value &&
    (value.brandName === "Zero" || value.brandName === "Okou") &&
    "displayName" in value &&
    typeof value.displayName === "string"
  );
}

function isDesktopSmokeBridgeState(
  value: unknown,
): value is DesktopSmokeBridgeState {
  return (
    typeof value === "object" &&
    value !== null &&
    "auth" in value &&
    typeof value.auth === "boolean" &&
    "computerUse" in value &&
    typeof value.computerUse === "boolean" &&
    "developerTools" in value &&
    typeof value.developerTools === "boolean" &&
    "identity" in value &&
    (value.identity === null || isDesktopIdentityInfo(value.identity))
  );
}

async function verifyDesktopSmokeBridge(): Promise<void> {
  const window = await createMainWindow();
  const rawState: unknown = await window.webContents.executeJavaScript(
    `({
      auth: typeof window.vm0DesktopAuth === "object",
      computerUse: typeof window.vm0DesktopComputerUse === "object",
      developerTools: typeof window.vm0DesktopDeveloperTools === "object",
      identity: window.vm0DesktopIdentity ?? null,
    })`,
    true,
  );

  if (!isDesktopSmokeBridgeState(rawState)) {
    throw new Error(
      `Desktop renderer bridge returned an invalid result: ${JSON.stringify(rawState)}`,
    );
  }

  const state = rawState;
  if (
    !state.auth ||
    !state.computerUse ||
    !state.developerTools ||
    !state.identity ||
    state.identity.product !== desktopIdentity.product ||
    state.identity.brandName !== desktopIdentity.brandName ||
    state.identity.displayName !== desktopIdentity.displayName
  ) {
    throw new Error(
      `Desktop renderer bridge failed acceptance: ${JSON.stringify(state)}`,
    );
  }
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
  await computerUseController.stopForAuthChange();
  notifyAuthChanged();
  const permissions = await refreshComputerUsePermissionState();
  notifyComputerUseChanged();
  if (hasRequiredComputerUsePermissions(permissions)) {
    await computerUseController.start({ userInitiated: true });
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

  dispatchDesktopAuthCallback(callback);
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
  console.warn(
    "Computer Use Desktop is macOS-first and only packages for darwin.",
  );
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
    globalShortcut.unregisterAll();
    if (!computerUseController.quitStopRequired()) {
      disposeComputerUseNativeBackend();
      return;
    }
    event.preventDefault();
    void computerUseController.stopForQuit().finally(() => {
      disposeComputerUseNativeBackend();
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    applyDockIcon();
    hideDockForInactiveMainWindow();
    registerDesktopAuthProtocol();
    installDesktopRendererProtocol();
    applyApplicationMenu();
    installKeepAwake();
    installComputerUse();
    installDesktopDeveloperTools();
    installDesktopRecorder();
    const desktopAuthSession = getAuthSession();
    installDesktopAuth();
    refreshComputerUsePermissionsForState();
    developerTools.requestRefresh();
    installTray();
    queueDesktopAuthCallbackArgv(process.argv);

    if (isDesktopSmokeTestEnabled(process.env)) {
      desktopAuthSession.signOut();
      try {
        await verifyDesktopSmokeBridge();
      } catch (error) {
        console.error("[smoke-test] desktop renderer bridge failed", error);
        app.exit(1);
        return;
      }
      writeSync(1, `${DESKTOP_SMOKE_TEST_READY_MARKER}\n`);
      process.exit(0);
    }

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
