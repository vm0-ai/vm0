import type {
  DevicePollResponse,
  DeviceStartResponse,
  LocalBrowserCommandCompleteBody,
  LocalBrowserHostCommandNextResponse,
} from "./protocol";

class LocalBrowserApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LocalBrowserApiError";
  }
}

type JsonRecord = Record<string, unknown>;

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
}

function isErrorBody(value: unknown): value is {
  readonly error?: { readonly message?: string; readonly code?: string };
} {
  return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

async function apiJson<T>(
  apiBaseUrl: string,
  path: string,
  options: {
    readonly method: "DELETE" | "GET" | "POST";
    readonly body?: JsonRecord;
    readonly hostToken?: string;
    readonly signal?: AbortSignal;
  },
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  if (options.hostToken) {
    headers.Authorization = `Bearer ${options.hostToken}`;
  }

  const response = await fetch(`${normalizeApiBaseUrl(apiBaseUrl)}${path}`, {
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "omit",
    headers,
    method: options.method,
    signal: options.signal,
  });
  const json = await readJson(response);
  if (!response.ok) {
    const message =
      isErrorBody(json) && json.error?.message
        ? json.error.message
        : `VM0 API request failed with ${response.status}`;
    throw new LocalBrowserApiError(
      message,
      response.status,
      isErrorBody(json) ? json.error?.code : undefined,
    );
  }
  return json as T;
}

export async function startDevicePairing(params: {
  readonly apiBaseUrl: string;
  readonly hostName: string;
  readonly browser: string;
  readonly extensionVersion: string;
  readonly supportedCapabilities: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<DeviceStartResponse> {
  return await apiJson<DeviceStartResponse>(
    params.apiBaseUrl,
    "/api/zero/local-browser/device/start",
    {
      body: {
        browser: params.browser,
        extensionVersion: params.extensionVersion,
        hostName: params.hostName,
        supportedCapabilities: [...params.supportedCapabilities],
      },
      method: "POST",
      signal: params.signal,
    },
  );
}

export async function pollDevicePairing(params: {
  readonly apiBaseUrl: string;
  readonly deviceCode: string;
  readonly pollToken: string;
  readonly signal?: AbortSignal;
}): Promise<DevicePollResponse> {
  return await apiJson<DevicePollResponse>(
    params.apiBaseUrl,
    "/api/zero/local-browser/device/poll",
    {
      body: {
        deviceCode: params.deviceCode,
        pollToken: params.pollToken,
      },
      method: "POST",
      signal: params.signal,
    },
  );
}

export async function heartbeatHost(params: {
  readonly apiBaseUrl: string;
  readonly hostToken: string;
  readonly hostName: string;
  readonly browser: string;
  readonly extensionVersion: string;
  readonly supportedCapabilities: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly hostId: string }> {
  return await apiJson<{ readonly ok: true; readonly hostId: string }>(
    params.apiBaseUrl,
    "/api/zero/local-browser/heartbeat",
    {
      body: {
        browser: params.browser,
        extensionVersion: params.extensionVersion,
        hostName: params.hostName,
        supportedCapabilities: [...params.supportedCapabilities],
      },
      hostToken: params.hostToken,
      method: "POST",
      signal: params.signal,
    },
  );
}

export async function claimNextCommand(params: {
  readonly apiBaseUrl: string;
  readonly hostToken: string;
  readonly supportedCapabilities: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<LocalBrowserHostCommandNextResponse> {
  return await apiJson<LocalBrowserHostCommandNextResponse>(
    params.apiBaseUrl,
    "/api/zero/local-browser/host/commands/next",
    {
      body: {
        supportedCapabilities: [...params.supportedCapabilities],
      },
      hostToken: params.hostToken,
      method: "POST",
      signal: params.signal,
    },
  );
}

export async function completeCommand(params: {
  readonly apiBaseUrl: string;
  readonly hostToken: string;
  readonly commandId: string;
  readonly body: LocalBrowserCommandCompleteBody;
  readonly signal?: AbortSignal;
}): Promise<{ readonly ok: true }> {
  return await apiJson<{ readonly ok: true }>(
    params.apiBaseUrl,
    `/api/zero/local-browser/host/commands/${encodeURIComponent(
      params.commandId,
    )}/complete`,
    {
      body: params.body,
      hostToken: params.hostToken,
      method: "POST",
      signal: params.signal,
    },
  );
}

export async function revokeCurrentHost(params: {
  readonly apiBaseUrl: string;
  readonly hostToken: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly ok: true }> {
  return await apiJson<{ readonly ok: true }>(
    params.apiBaseUrl,
    "/api/zero/local-browser/host",
    {
      hostToken: params.hostToken,
      method: "DELETE",
      signal: params.signal,
    },
  );
}
