import type {
  LocalBrowserCommandError,
  LocalBrowserCommandKind,
  LocalBrowserCommandResult,
} from "@vm0/api-contracts/contracts/zero-local-browser";

const LOCAL_BROWSER_WEB_MESSAGE_SOURCE = "vm0-local-browser-web";
export const LOCAL_BROWSER_EXTENSION_MESSAGE_SOURCE =
  "vm0-local-browser-extension";

export const SUPPORTED_CAPABILITIES = [
  "tabs.list",
  "tabs.current",
  "page.snapshot",
  "page.screenshot",
  "page.selection",
  "page.metadata",
  "page.click",
  "page.type",
  "page.scroll",
  "page.navigate",
  "tabs.activate",
  "tabs.open",
  "tabs.close",
] as const satisfies readonly LocalBrowserCommandKind[];

export interface LocalBrowserCommandPayload {
  readonly tabId?: string;
  readonly selector?: string;
  readonly x?: number;
  readonly y?: number;
  readonly text?: string;
  readonly direction?: "up" | "down";
  readonly amount?: number;
  readonly url?: string;
}

export interface LocalBrowserHostCommand {
  readonly id: string;
  readonly kind: LocalBrowserCommandKind;
  readonly payload: LocalBrowserCommandPayload;
  readonly timeoutMs: number | null;
}

export type LocalBrowserHostCommandNextResponse =
  | { readonly status: "idle" }
  | {
      readonly status: "command";
      readonly command: LocalBrowserHostCommand;
    };

export type LocalBrowserCommandCompleteBody =
  | {
      readonly status: "succeeded";
      readonly result: LocalBrowserCommandResult;
    }
  | {
      readonly status: "failed";
      readonly error: LocalBrowserCommandError;
    };

type BridgeRequestType = "detect" | "pair";

interface BridgeRequest {
  readonly source: typeof LOCAL_BROWSER_WEB_MESSAGE_SOURCE;
  readonly type: `vm0.localBrowser.${BridgeRequestType}`;
  readonly requestId: string;
}

export type BridgeBackgroundMessage =
  | {
      readonly type: "localBrowser.detect";
      readonly pageUrl: string;
    }
  | {
      readonly type: "localBrowser.pair";
      readonly pageUrl: string;
    }
  | { readonly type: "localBrowser.getStatus" }
  | { readonly type: "localBrowser.revokeHost" }
  | { readonly type: "localBrowser.openConnectorPage" };

export type BridgeBackgroundResponse =
  | {
      readonly ok: true;
      readonly type: "detected";
      readonly browser: string;
      readonly extensionVersion: string;
    }
  | {
      readonly ok: true;
      readonly type: "pairingStarted";
      readonly deviceCode: string;
      readonly userCode: string;
    }
  | {
      readonly ok: true;
      readonly type: "status";
      readonly status: ExtensionStatus;
    }
  | { readonly ok: true; readonly type: "done" }
  | { readonly ok: false; readonly message: string };

export interface DeviceStartResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly pollToken: string;
}

export type DevicePollResponse =
  | { readonly status: "pending" }
  | {
      readonly status: "linked";
      readonly hostId: string;
      readonly hostToken?: string;
    }
  | { readonly status: "expired" };

export interface LinkedHostState {
  readonly apiBaseUrl: string;
  readonly appBaseUrl: string;
  readonly hostId: string;
  readonly hostToken: string;
  readonly hostName: string;
  readonly browser: string;
  readonly extensionVersion: string;
  readonly supportedCapabilities: readonly string[];
  readonly linkedAt: number;
  readonly lastHeartbeatAt?: number;
  readonly lastCommandAt?: number;
}

export interface PairingState {
  readonly apiBaseUrl: string;
  readonly appBaseUrl: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly pollToken: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
  readonly nextPollAt: number;
  readonly hostName: string;
  readonly browser: string;
}

export interface ExtensionState {
  readonly host?: LinkedHostState;
  readonly pairing?: PairingState;
  readonly paused?: boolean;
  readonly lastError?: string;
  readonly lastStatusAt?: number;
}

export interface ExtensionStatus {
  readonly linked: boolean;
  readonly paired: boolean;
  readonly paused: boolean;
  readonly hostId?: string;
  readonly hostName?: string;
  readonly browser?: string;
  readonly apiBaseUrl?: string;
  readonly appBaseUrl?: string;
  readonly lastHeartbeatAt?: number;
  readonly lastCommandAt?: number;
  readonly lastError?: string;
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.source === LOCAL_BROWSER_WEB_MESSAGE_SOURCE &&
    typeof record.requestId === "string" &&
    (record.type === "vm0.localBrowser.detect" ||
      record.type === "vm0.localBrowser.pair")
  );
}

export function messageFromBridgeRequest(
  request: BridgeRequest,
  pageUrl: string,
): BridgeBackgroundMessage {
  if (request.type === "vm0.localBrowser.detect") {
    return { type: "localBrowser.detect", pageUrl };
  }
  return { type: "localBrowser.pair", pageUrl };
}

export function statusFromState(state: ExtensionState): ExtensionStatus {
  return {
    linked: !!state.host,
    paired: !!state.host || !!state.pairing,
    paused: !!state.paused,
    hostId: state.host?.hostId,
    hostName: state.host?.hostName ?? state.pairing?.hostName,
    browser: state.host?.browser ?? state.pairing?.browser,
    apiBaseUrl: state.host?.apiBaseUrl ?? state.pairing?.apiBaseUrl,
    appBaseUrl: state.host?.appBaseUrl ?? state.pairing?.appBaseUrl,
    lastHeartbeatAt: state.host?.lastHeartbeatAt,
    lastCommandAt: state.host?.lastCommandAt,
    lastError: state.lastError,
  };
}
