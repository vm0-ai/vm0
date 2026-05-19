import type { Session } from "electron";
import type {
  DesktopLocalAgentBackend,
  DesktopLocalAgentHostStartResponse,
  DesktopLocalAgentJobNextResponse,
} from "./desktop-local-agent-types";

interface ApiErrorBody {
  readonly error?: {
    readonly message?: string;
  };
}

export interface DesktopLocalAgentApiClient {
  readonly startHost: (params: {
    readonly hostName: string;
    readonly hostId?: string;
    readonly supportedBackends: readonly DesktopLocalAgentBackend[];
    readonly signal?: AbortSignal;
  }) => Promise<DesktopLocalAgentHostStartResponse>;
  readonly heartbeat: (params: {
    readonly hostToken: string;
    readonly hostName: string;
    readonly supportedBackends: readonly DesktopLocalAgentBackend[];
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly claimNextJob: (params: {
    readonly hostToken: string;
    readonly supportedBackends: readonly DesktopLocalAgentBackend[];
    readonly signal?: AbortSignal;
  }) => Promise<DesktopLocalAgentJobNextResponse>;
  readonly completeJob: (params: {
    readonly hostToken: string;
    readonly jobId: string;
    readonly status: "succeeded" | "failed";
    readonly output?: string;
    readonly error?: string;
    readonly exitCode?: number;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly closeHost: (params: {
    readonly hostToken: string;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
}

function replaceHostPrefix(hostname: string, target: string): string {
  return hostname.replace(/(^|-)(api|app|platform|www)\./, `$1${target}.`);
}

function resolveLocalAgentApiBaseUrl(platformUrl: URL): URL {
  if (
    platformUrl.hostname === "localhost" ||
    platformUrl.hostname === "127.0.0.1"
  ) {
    return new URL(platformUrl.toString());
  }

  const url = new URL(platformUrl.toString());
  url.hostname = replaceHostPrefix(url.hostname, "api");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function normalizeBaseUrl(baseUrl: URL): string {
  return baseUrl.toString().replace(/\/$/, "");
}

function parseErrorBody(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const body = value as ApiErrorBody;
  return body.error?.message ?? null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(
      parseErrorBody(body) ?? `Local agent API returned ${response.status}`,
    );
  }
  return body as T;
}

function bearerHeaders(hostToken: string): HeadersInit {
  return {
    authorization: `Bearer ${hostToken}`,
    "content-type": "application/json",
  };
}

async function cookieHeaderForSession(
  electronSession: Session,
  urls: readonly URL[],
): Promise<string> {
  const pairs = new Map<string, string>();
  for (const url of urls) {
    const cookies = await electronSession.cookies.get({ url: url.toString() });
    for (const cookie of cookies) {
      pairs.set(cookie.name, `${cookie.name}=${cookie.value}`);
    }
  }
  return [...pairs.values()].join("; ");
}

function optionalJsonBody(body: object): string {
  return JSON.stringify(body);
}

export function createDesktopLocalAgentApiClient(params: {
  readonly platformUrl: URL;
  readonly session: Session;
}): DesktopLocalAgentApiClient {
  const apiBaseUrl = resolveLocalAgentApiBaseUrl(params.platformUrl);
  const apiBase = normalizeBaseUrl(apiBaseUrl);

  const sessionHeaders = async (): Promise<HeadersInit> => {
    const cookie = await cookieHeaderForSession(params.session, [
      params.platformUrl,
      apiBaseUrl,
    ]);
    return {
      "content-type": "application/json",
      ...(cookie.length > 0 ? { cookie } : {}),
    };
  };

  return {
    async startHost(startParams) {
      const response = await fetch(
        `${apiBase}/api/zero/local-agent/hosts/start`,
        {
          method: "POST",
          headers: await sessionHeaders(),
          body: optionalJsonBody({
            hostName: startParams.hostName,
            supportedBackends: startParams.supportedBackends,
            ...(startParams.hostId ? { hostId: startParams.hostId } : {}),
          }),
          signal: startParams.signal,
        },
      );
      return parseResponse<DesktopLocalAgentHostStartResponse>(response);
    },
    async heartbeat(heartbeatParams) {
      const response = await fetch(
        `${apiBase}/api/zero/local-agent/heartbeat`,
        {
          method: "POST",
          headers: bearerHeaders(heartbeatParams.hostToken),
          body: optionalJsonBody({
            hostName: heartbeatParams.hostName,
            supportedBackends: heartbeatParams.supportedBackends,
            realtimeConnected: false,
          }),
          signal: heartbeatParams.signal,
        },
      );
      await parseResponse<{ readonly ok: true; readonly hostId: string }>(
        response,
      );
    },
    async claimNextJob(claimParams) {
      const response = await fetch(
        `${apiBase}/api/zero/local-agent/host/jobs/next`,
        {
          method: "POST",
          headers: bearerHeaders(claimParams.hostToken),
          body: optionalJsonBody({
            supportedBackends: claimParams.supportedBackends,
          }),
          signal: claimParams.signal,
        },
      );
      return parseResponse<DesktopLocalAgentJobNextResponse>(response);
    },
    async completeJob(completeParams) {
      const response = await fetch(
        `${apiBase}/api/zero/local-agent/host/jobs/${completeParams.jobId}/complete`,
        {
          method: "POST",
          headers: bearerHeaders(completeParams.hostToken),
          body: optionalJsonBody({
            status: completeParams.status,
            output: completeParams.output,
            error: completeParams.error,
            exitCode: completeParams.exitCode,
          }),
          signal: completeParams.signal,
        },
      );
      await parseResponse<{ readonly ok: true }>(response);
    },
    async closeHost(closeParams) {
      const response = await fetch(
        `${apiBase}/api/zero/local-agent/hosts/close`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${closeParams.hostToken}`,
          },
          signal: closeParams.signal,
        },
      );
      await parseResponse<{ readonly ok: true }>(response);
    },
  };
}
