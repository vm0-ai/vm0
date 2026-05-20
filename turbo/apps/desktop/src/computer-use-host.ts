import os from "node:os";
import type {
  ComputerUseCommand,
  ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import { SUPPORTED_COMPUTER_USE_CAPABILITIES } from "./computer-use-accessibility";
import type { ComputerUsePermissionState } from "./computer-use-page";

const START_RETRY_MS = 15_000;
const ONLINE_POLL_MS = 2_000;
const ERROR_RETRY_MS = 10_000;

type ComputerUseHostRuntimeStatus =
  | "idle"
  | "connecting"
  | "online"
  | "unauthenticated"
  | "disabled"
  | "error";

type ComputerUseHostFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface ComputerUseHostRuntimeState {
  readonly status: ComputerUseHostRuntimeStatus;
  readonly hostId: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly lastCommandAt: string | null;
  readonly lastError: string | null;
  readonly pendingApprovals: readonly ComputerUsePendingApprovalRuntimeEvent[];
  readonly recentAuditEvents: readonly ComputerUseRuntimeAuditEvent[];
}

interface ComputerUseHostRuntimeOptions {
  readonly platformUrl: URL;
  readonly displayName: string;
  readonly appVersion: string;
  readonly fetch: ComputerUseHostFetch;
  readonly getPermissions: () => ComputerUsePermissionState;
  readonly executeCommand: (
    command: ComputerUseCommand,
    permissions: ComputerUsePermissionState,
  ) => Promise<ComputerUseCommandExecutionResult>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

interface ComputerUseHostStartResponse {
  readonly hostId: string;
  readonly hostToken: string;
}

interface ComputerUseRuntimeAuditEvent {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly event: "created" | "approved" | "denied" | "completed";
  readonly approvalOutcome: "approved" | "denied" | null;
  readonly createdAt: string;
}

interface ComputerUsePendingApprovalRuntimeEvent {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly createdAt: string;
}

interface ComputerUseAuditEventsResponse {
  readonly auditEvents: readonly ComputerUseRuntimeAuditEvent[];
}

interface ComputerUseHostNextIdleResponse {
  readonly status: "idle";
}

interface ComputerUseHostNextCommandResponse {
  readonly status: "command";
  readonly command: ComputerUseCommand;
}

type ComputerUseHostNextResponse =
  | ComputerUseHostNextIdleResponse
  | ComputerUseHostNextCommandResponse;

function replaceHostPrefix(hostname: string, target: string): string {
  return hostname.replace(/(^|-)(api|app|platform|www)\./, `$1${target}.`);
}

export function resolveComputerUseApiBaseUrl(platformUrl: URL): string {
  const url = new URL(platformUrl.toString());
  url.hostname = replaceHostPrefix(url.hostname, "api");
  return url.toString().replace(/\/$/, "");
}

export function buildComputerUseRuntimeBody(args: {
  readonly displayName: string;
  readonly appVersion: string;
  readonly permissions: ComputerUsePermissionState;
}): Record<string, unknown> {
  return {
    hostName: args.displayName,
    appVersion: args.appVersion,
    osVersion: `${os.type()} ${os.release()}`,
    supportedCapabilities: [...SUPPORTED_COMPUTER_USE_CAPABILITIES],
    permissions: args.permissions,
  };
}

export class ComputerUseHostRuntime {
  private readonly apiBaseUrl: string;
  private readonly displayName: string;
  private readonly appVersion: string;
  private readonly fetch: ComputerUseHostFetch;
  private readonly getPermissions: () => ComputerUsePermissionState;
  private readonly executeCommand: ComputerUseHostRuntimeOptions["executeCommand"];
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly clearScheduledTimeout: typeof clearTimeout;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private hostToken: string | null = null;
  private state: ComputerUseHostRuntimeState = {
    status: "idle",
    hostId: null,
    lastHeartbeatAt: null,
    lastCommandAt: null,
    lastError: null,
    pendingApprovals: [],
    recentAuditEvents: [],
  };

  constructor(options: ComputerUseHostRuntimeOptions) {
    this.apiBaseUrl = resolveComputerUseApiBaseUrl(options.platformUrl);
    this.displayName = options.displayName;
    this.appVersion = options.appVersion;
    this.fetch = options.fetch;
    this.getPermissions = options.getPermissions;
    this.executeCommand = options.executeCommand;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.clearScheduledTimeout = options.clearTimeout ?? clearTimeout;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      this.clearScheduledTimeout(this.timer);
      this.timer = null;
    }
  }

  getState(): ComputerUseHostRuntimeState {
    return this.state;
  }

  async decideCommand(args: {
    readonly commandId: string;
    readonly decision: "approve" | "deny";
  }): Promise<void> {
    const response = await this.fetch(
      `${this.apiBaseUrl}/api/zero/computer-use/commands/${encodeURIComponent(args.commandId)}/approval`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: args.decision }),
      },
    );
    if (!response.ok) {
      const message = `Computer Use approval failed: ${response.status}`;
      this.setState({ lastError: message });
      throw new Error(message);
    }

    this.setState({
      lastError: null,
      lastCommandAt: new Date().toISOString(),
    });
    await this.refreshAuditEvents();
  }

  private runtimeBody(): Record<string, unknown> {
    return buildComputerUseRuntimeBody({
      displayName: this.displayName,
      appVersion: this.appVersion,
      permissions: this.getPermissions(),
    });
  }

  private setState(update: Partial<ComputerUseHostRuntimeState>): void {
    this.state = { ...this.state, ...update };
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = this.scheduleTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let nextDelay = ONLINE_POLL_MS;
    try {
      if (!this.hostToken) {
        nextDelay = await this.startHost();
      } else {
        if (await this.heartbeat()) {
          await this.claimAndExecuteCommand();
        }
      }
    } catch (error) {
      this.setState({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
      nextDelay = ERROR_RETRY_MS;
    } finally {
      this.schedule(nextDelay);
    }
  }

  private async startHost(): Promise<number> {
    this.setState({ status: "connecting", lastError: null });
    const response = await this.fetch(
      `${this.apiBaseUrl}/api/zero/computer-use/hosts/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.runtimeBody()),
      },
    );
    if (response.status === 401) {
      this.setState({ status: "unauthenticated" });
      return START_RETRY_MS;
    }
    if (response.status === 403) {
      this.setState({ status: "disabled" });
      return START_RETRY_MS;
    }
    if (!response.ok) {
      throw new Error(`Failed to start Computer Use host: ${response.status}`);
    }

    const body = (await response.json()) as ComputerUseHostStartResponse;
    this.hostToken = body.hostToken;
    this.setState({
      status: "online",
      hostId: body.hostId,
      lastHeartbeatAt: new Date().toISOString(),
      lastError: null,
    });
    return ONLINE_POLL_MS;
  }

  private async heartbeat(): Promise<boolean> {
    const response = await this.hostFetch("/api/zero/computer-use/heartbeat", {
      method: "POST",
      body: JSON.stringify(this.runtimeBody()),
    });
    if (response.status === 401) {
      this.hostToken = null;
      this.setState({ status: "unauthenticated", hostId: null });
      return false;
    }
    if (!response.ok) {
      throw new Error(`Computer Use heartbeat failed: ${response.status}`);
    }
    this.setState({
      status: "online",
      lastHeartbeatAt: new Date().toISOString(),
      lastError: null,
    });
    await this.refreshAuditEvents();
    return true;
  }

  private async refreshAuditEvents(): Promise<void> {
    const hostId = this.state.hostId;
    if (!hostId) {
      return;
    }

    const url = new URL(
      `${this.apiBaseUrl}/api/zero/computer-use/audit-events`,
    );
    url.searchParams.set("hostId", hostId);
    url.searchParams.set("limit", "25");

    const response = await this.fetch(url.toString(), { method: "GET" });
    if (response.status === 401 || response.status === 403) {
      this.setState({ pendingApprovals: [], recentAuditEvents: [] });
      return;
    }
    if (!response.ok) {
      throw new Error(
        `Computer Use audit history refresh failed: ${response.status}`,
      );
    }

    const body = (await response.json()) as ComputerUseAuditEventsResponse;
    this.setState({
      pendingApprovals: derivePendingApprovals(body.auditEvents),
      recentAuditEvents: body.auditEvents,
    });
  }

  private async claimAndExecuteCommand(): Promise<void> {
    const next = await this.hostFetch(
      "/api/zero/computer-use/host/commands/next",
      {
        method: "POST",
        body: JSON.stringify({
          supportedCapabilities: [...SUPPORTED_COMPUTER_USE_CAPABILITIES],
        }),
      },
    );
    if (!next.ok) {
      throw new Error(`Computer Use command claim failed: ${next.status}`);
    }
    const body = (await next.json()) as ComputerUseHostNextResponse;
    if (body.status === "idle") {
      return;
    }

    const completed = await this.executeCommand(
      body.command,
      this.getPermissions(),
    );
    const response = await this.hostFetch(
      `/api/zero/computer-use/host/commands/${body.command.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify(completed),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Computer Use command completion failed: ${response.status}`,
      );
    }
    this.setState({
      status: "online",
      lastCommandAt: new Date().toISOString(),
      lastError: null,
    });
    await this.refreshAuditEvents();
  }

  private hostFetch(path: string, init: RequestInit): Promise<Response> {
    if (!this.hostToken) {
      throw new Error("Computer Use host token is not available");
    }
    return this.fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.hostToken}`,
        ...init.headers,
      },
    });
  }
}

function derivePendingApprovals(
  auditEvents: readonly ComputerUseRuntimeAuditEvent[],
): readonly ComputerUsePendingApprovalRuntimeEvent[] {
  const resolvedCommandIds = new Set(
    auditEvents
      .filter((event) => {
        return event.event !== "created";
      })
      .map((event) => {
        return event.commandId;
      }),
  );

  return auditEvents
    .filter((event) => {
      return (
        event.event === "created" && !resolvedCommandIds.has(event.commandId)
      );
    })
    .map((event) => {
      return {
        commandId: event.commandId,
        kind: event.kind,
        app: event.app,
        createdAt: event.createdAt,
      };
    });
}
