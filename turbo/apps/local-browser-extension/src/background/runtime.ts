import type {
  LocalBrowserCommandError,
  LocalBrowserCommandResult,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import {
  claimNextCommand,
  completeCommand,
  heartbeatHost,
  pollDevicePairing,
  revokeCurrentHost,
  startDevicePairing,
} from "../shared/api";
import {
  SUPPORTED_CAPABILITIES,
  statusFromState,
  type BridgeBackgroundResponse,
  type ExtensionState,
  type LinkedHostState,
  type PairingState,
} from "../shared/protocol";
import {
  clearExtensionState,
  loadExtensionState,
  patchExtensionState,
  saveExtensionState,
} from "../shared/storage";
import {
  commandErrorFromUnknown,
  executeLocalBrowserCommand,
  LocalBrowserCommandFailure,
} from "./browser-actions";

const TICK_ALARM = "vm0-local-browser-tick";
const HEARTBEAT_INTERVAL_MS = 30_000;
const COMMAND_POLL_INTERVAL_MS = 2_000;
const MAX_COMMANDS_PER_TICK = 5;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

let commandLoopRunning = false;
let lastCommandPollAt = 0;

function now(): number {
  return Date.now();
}

function browserName(): string {
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Edg/")) {
    return "Microsoft Edge";
  }
  if (userAgent.includes("Chrome/")) {
    return "Chrome";
  }
  return "Chromium";
}

function platformName(): string {
  return navigator.platform || "this device";
}

function hostName(): string {
  return `${browserName()} on ${platformName()}`;
}

function normalizeOrigin(url: URL): string {
  return url.origin.endsWith("/") ? url.origin.slice(0, -1) : url.origin;
}

function rewriteApiHostname(hostname: string): string {
  return hostname.replace(/(^|-)(platform|app|www|api)\./u, "$1api.");
}

function resolveBasesFromPageUrl(pageUrl: string): {
  readonly apiBaseUrl: string;
  readonly appBaseUrl: string;
} {
  const url = new URL(pageUrl);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return {
      apiBaseUrl: "http://localhost:3000",
      appBaseUrl: normalizeOrigin(url),
    };
  }

  const apiUrl = new URL(url.origin);
  apiUrl.hostname = rewriteApiHostname(apiUrl.hostname);
  return {
    apiBaseUrl: normalizeOrigin(apiUrl),
    appBaseUrl: normalizeOrigin(url),
  };
}

function extensionVersion(): string {
  return chrome.runtime.getManifest().version || __EXTENSION_VERSION__;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Local browser runtime failed";
}

async function updateBadge(state: ExtensionState): Promise<void> {
  if (!chrome.action) {
    return;
  }
  const status = statusFromState(state);
  if (status.paused) {
    await chrome.action.setBadgeText({ text: "II" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setTitle({ title: "VM0 Local Browser paused" });
    return;
  }
  if (status.linked) {
    await chrome.action.setBadgeText({ text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    await chrome.action.setTitle({ title: "VM0 Local Browser connected" });
    return;
  }
  if (status.paired) {
    await chrome.action.setBadgeText({ text: "..." });
    await chrome.action.setBadgeBackgroundColor({ color: "#ca8a04" });
    await chrome.action.setTitle({ title: "VM0 Local Browser pairing" });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "VM0 Local Browser" });
}

async function saveError(message: string): Promise<void> {
  const state = await patchExtensionState({
    lastError: message,
    lastStatusAt: now(),
  });
  await updateBadge(state);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(
              new LocalBrowserCommandFailure("timeout", "Command timed out"),
            );
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function createPairingState(pageUrl: string): Promise<PairingState> {
  const bases = resolveBasesFromPageUrl(pageUrl);
  const browser = browserName();
  const response = await startDevicePairing({
    apiBaseUrl: bases.apiBaseUrl,
    browser,
    extensionVersion: extensionVersion(),
    hostName: hostName(),
    supportedCapabilities: SUPPORTED_CAPABILITIES,
  });
  const timestamp = now();
  return {
    apiBaseUrl: bases.apiBaseUrl,
    appBaseUrl: bases.appBaseUrl,
    browser,
    deviceCode: response.deviceCode,
    expiresAt: timestamp + response.expiresIn * 1000,
    hostName: hostName(),
    intervalMs: response.interval * 1000,
    nextPollAt: timestamp,
    pollToken: response.pollToken,
    userCode: response.userCode,
  };
}

async function continuePairing(state: ExtensionState): Promise<ExtensionState> {
  const pairing = state.pairing;
  if (!pairing) {
    return state;
  }

  const timestamp = now();
  if (timestamp >= pairing.expiresAt) {
    const nextState = {
      ...state,
      lastError: "Local browser pairing expired",
      lastStatusAt: timestamp,
      pairing: undefined,
    };
    await saveExtensionState(nextState);
    await updateBadge(nextState);
    return nextState;
  }
  if (timestamp < pairing.nextPollAt) {
    return state;
  }

  const response = await pollDevicePairing({
    apiBaseUrl: pairing.apiBaseUrl,
    deviceCode: pairing.deviceCode,
    pollToken: pairing.pollToken,
  });

  if (response.status === "pending") {
    const nextState = {
      ...state,
      pairing: {
        ...pairing,
        nextPollAt: timestamp + pairing.intervalMs,
      },
    };
    await saveExtensionState(nextState);
    await updateBadge(nextState);
    return nextState;
  }

  if (response.status === "expired" || !response.hostToken) {
    const nextState = {
      ...state,
      lastError: "Local browser pairing expired",
      lastStatusAt: timestamp,
      pairing: undefined,
    };
    await saveExtensionState(nextState);
    await updateBadge(nextState);
    return nextState;
  }

  const host: LinkedHostState = {
    apiBaseUrl: pairing.apiBaseUrl,
    appBaseUrl: pairing.appBaseUrl,
    browser: pairing.browser,
    extensionVersion: extensionVersion(),
    hostId: response.hostId,
    hostName: pairing.hostName,
    hostToken: response.hostToken,
    linkedAt: timestamp,
    supportedCapabilities: SUPPORTED_CAPABILITIES,
  };
  const nextState = {
    ...state,
    host,
    lastError: undefined,
    lastStatusAt: timestamp,
    pairing: undefined,
    paused: false,
  };
  await saveExtensionState(nextState);
  await updateBadge(nextState);
  return nextState;
}

async function heartbeatIfNeeded(
  state: ExtensionState,
): Promise<ExtensionState> {
  const host = state.host;
  if (!host) {
    return state;
  }
  const timestamp = now();
  if (
    host.lastHeartbeatAt &&
    timestamp - host.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS
  ) {
    return state;
  }

  const response = await heartbeatHost({
    apiBaseUrl: host.apiBaseUrl,
    browser: host.browser,
    extensionVersion: extensionVersion(),
    hostName: host.hostName,
    hostToken: host.hostToken,
    supportedCapabilities: SUPPORTED_CAPABILITIES,
  });
  const nextHost = {
    ...host,
    hostId: response.hostId,
    lastHeartbeatAt: timestamp,
    supportedCapabilities: SUPPORTED_CAPABILITIES,
  };
  const nextState = {
    ...state,
    host: nextHost,
    lastError: undefined,
    lastStatusAt: timestamp,
  };
  await saveExtensionState(nextState);
  await updateBadge(nextState);
  return nextState;
}

function completionBodyFromResult(result: LocalBrowserCommandResult) {
  return {
    result,
    status: "succeeded" as const,
  };
}

function completionBodyFromError(error: LocalBrowserCommandError) {
  return {
    error,
    status: "failed" as const,
  };
}

async function completeClaimedCommand(
  host: LinkedHostState,
  commandId: string,
  body:
    | ReturnType<typeof completionBodyFromResult>
    | ReturnType<typeof completionBodyFromError>,
): Promise<void> {
  await completeCommand({
    apiBaseUrl: host.apiBaseUrl,
    body,
    commandId,
    hostToken: host.hostToken,
  });
}

async function drainCommands(state: ExtensionState): Promise<ExtensionState> {
  const host = state.host;
  if (!host || state.paused) {
    return state;
  }

  const timestamp = now();
  if (timestamp - lastCommandPollAt < COMMAND_POLL_INTERVAL_MS) {
    return state;
  }
  if (commandLoopRunning) {
    return state;
  }

  commandLoopRunning = true;
  lastCommandPollAt = timestamp;
  let lastCommandAt = host.lastCommandAt;
  try {
    for (let i = 0; i < MAX_COMMANDS_PER_TICK; i += 1) {
      const next = await claimNextCommand({
        apiBaseUrl: host.apiBaseUrl,
        hostToken: host.hostToken,
        supportedCapabilities: SUPPORTED_CAPABILITIES,
      });
      if (next.status === "idle") {
        break;
      }

      let body:
        | ReturnType<typeof completionBodyFromResult>
        | ReturnType<typeof completionBodyFromError>;
      try {
        const result = await withTimeout(
          executeLocalBrowserCommand(next.command),
          next.command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        );
        body = completionBodyFromResult(result);
      } catch (error) {
        body = completionBodyFromError(commandErrorFromUnknown(error));
      }
      await completeClaimedCommand(host, next.command.id, body);
      lastCommandAt = now();
    }
  } finally {
    commandLoopRunning = false;
  }

  if (lastCommandAt === host.lastCommandAt) {
    return state;
  }

  const nextState = {
    ...state,
    host: {
      ...host,
      lastCommandAt,
    },
    lastStatusAt: now(),
  };
  await saveExtensionState(nextState);
  await updateBadge(nextState);
  return nextState;
}

async function runtimeTick(): Promise<void> {
  try {
    let state = await loadExtensionState();
    state = await continuePairing(state);
    if (!state.paused) {
      state = await heartbeatIfNeeded(state);
      await drainCommands(state);
    }
  } catch (error) {
    await saveError(toErrorMessage(error));
  }
}

export async function initializeRuntime(): Promise<void> {
  await chrome.alarms.create(TICK_ALARM, {
    delayInMinutes: 0.05,
    periodInMinutes: 0.5,
  });
  await updateBadge(await loadExtensionState());
  await runtimeTick();
}

export function handleAlarm(alarm: ChromeAlarm): void {
  if (alarm.name === TICK_ALARM) {
    void runtimeTick();
  }
}

export async function detectExtension(): Promise<BridgeBackgroundResponse> {
  return {
    browser: browserName(),
    extensionVersion: extensionVersion(),
    ok: true,
    type: "detected",
  };
}

export async function startPairing(
  pageUrl: string,
): Promise<BridgeBackgroundResponse> {
  const pairing = await createPairingState(pageUrl);
  const state = await patchExtensionState({
    host: undefined,
    lastError: undefined,
    lastStatusAt: now(),
    pairing,
  });
  await updateBadge(state);
  void runtimeTick();
  return {
    deviceCode: pairing.deviceCode,
    ok: true,
    type: "pairingStarted",
    userCode: pairing.userCode,
  };
}

export async function extensionStatus(): Promise<BridgeBackgroundResponse> {
  const state = await loadExtensionState();
  return {
    ok: true,
    status: statusFromState(state),
    type: "status",
  };
}

export async function revokeHost(): Promise<BridgeBackgroundResponse> {
  const state = await loadExtensionState();
  if (state.host) {
    await revokeCurrentHost({
      apiBaseUrl: state.host.apiBaseUrl,
      hostToken: state.host.hostToken,
    });
  }
  await clearExtensionState();
  await updateBadge({});
  return { ok: true, type: "done" };
}

export async function openConnectorPage(): Promise<BridgeBackgroundResponse> {
  const state = await loadExtensionState();
  const appBaseUrl =
    state.host?.appBaseUrl ?? state.pairing?.appBaseUrl ?? "https://app.vm0.ai";
  await chrome.tabs.create({
    url: `${appBaseUrl}/zero/connectors/local-browser`,
  });
  return { ok: true, type: "done" };
}
