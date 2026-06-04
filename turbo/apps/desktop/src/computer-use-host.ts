import os from "node:os";
import type {
  ComputerUseCommand,
  ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import { SUPPORTED_COMPUTER_USE_CAPABILITIES } from "./computer-use-accessibility";
import type {
  ComputerUseHostRuntimeState,
  ComputerUseLocalCommandLogEntry,
  ComputerUsePermissionState,
  ComputerUseRuntimeAuditEvent,
} from "./computer-use-types";
import {
  COMPUTER_USE_NEEDS_ORGANIZATION_MESSAGE,
  COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
} from "./computer-use-startup-gate";

const ONLINE_POLL_MS = 2_000;
const COMMAND_COMPLETION_RETRY_DELAY_MS = 2_000;
const COMMAND_COMPLETION_MAX_ATTEMPTS = 3;
const AUTH_ME_PATH = "/api/auth/me";

export type ComputerUseHostFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type MaybePromise<T> = T | Promise<T>;

interface ComputerUseHostRuntimeOptions {
  readonly platformUrl: URL;
  readonly displayName: string;
  readonly appVersion: string;
  readonly sessionFetch: ComputerUseHostFetch;
  readonly hostFetch: ComputerUseHostFetch;
  readonly getPermissions: () => MaybePromise<ComputerUsePermissionState>;
  readonly executeCommand: (
    command: ComputerUseCommand,
    permissions: ComputerUsePermissionState,
  ) => Promise<ComputerUseCommandExecutionResult>;
  readonly onChange?: () => void;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

interface ComputerUseHostStartResponse {
  readonly hostId: string;
  readonly hostToken: string;
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

function commandFailureFromError(
  error: unknown,
): ComputerUseCommandExecutionResult {
  return {
    status: "failed",
    error: {
      code: "accessibility_unavailable",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

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
  private readonly sessionFetch: ComputerUseHostFetch;
  private readonly hostFetchRequest: ComputerUseHostFetch;
  private readonly getPermissions: ComputerUseHostRuntimeOptions["getPermissions"];
  private readonly executeCommand: ComputerUseHostRuntimeOptions["executeCommand"];
  private readonly onChange: () => void;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly clearScheduledTimeout: typeof clearTimeout;
  private running = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private commandTimer: NodeJS.Timeout | null = null;
  private commandExecutionRunning = false;
  private hostToken: string | null = null;
  private state: ComputerUseHostRuntimeState = {
    status: "idle",
    hostId: null,
    lastHeartbeatAt: null,
    lastCommandAt: null,
    lastError: null,
    recentAuditEvents: [],
    localCommandLog: [],
  };

  constructor(options: ComputerUseHostRuntimeOptions) {
    this.apiBaseUrl = resolveComputerUseApiBaseUrl(options.platformUrl);
    this.displayName = options.displayName;
    this.appVersion = options.appVersion;
    this.sessionFetch = options.sessionFetch;
    this.hostFetchRequest = options.hostFetch;
    this.getPermissions = options.getPermissions;
    this.executeCommand = options.executeCommand;
    this.onChange = options.onChange ?? (() => {});
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.clearScheduledTimeout = options.clearTimeout ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const nextDelay = await this.startHost();
      if (nextDelay === null) {
        this.running = false;
        return;
      }
      this.scheduleHeartbeat(nextDelay);
      this.scheduleCommandPoll(nextDelay);
    } catch (error) {
      this.setState({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearHeartbeatTimer();
    this.clearCommandTimer();
    const hostToken = this.hostToken;
    if (!hostToken) {
      return;
    }
    this.hostToken = null;
    this.setState({
      status: "idle",
      hostId: null,
      lastError: null,
    });
    try {
      await this.stopHost(hostToken);
    } catch (error) {
      this.setState({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getState(): ComputerUseHostRuntimeState {
    return this.state;
  }

  private async runtimeBody(): Promise<Record<string, unknown>> {
    return buildComputerUseRuntimeBody({
      displayName: this.displayName,
      appVersion: this.appVersion,
      permissions: await this.getPermissions(),
    });
  }

  private setState(update: Partial<ComputerUseHostRuntimeState>): void {
    this.state = { ...this.state, ...update };
    this.onChange();
  }

  private startLocalCommandLogEntry(
    command: ComputerUseCommand,
    startedAt: string,
  ): void {
    const app = command.payload.app;
    const entry: ComputerUseLocalCommandLogEntry = {
      commandId: command.id,
      kind: command.kind,
      app: typeof app === "string" ? app : null,
      status: "running",
      payload: command.payload,
      result: null,
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
    };
    this.setState({
      localCommandLog: [
        entry,
        ...this.state.localCommandLog.filter((candidate) => {
          return candidate.commandId !== command.id;
        }),
      ],
    });
  }

  private finishLocalCommandLogEntry(args: {
    readonly commandId: string;
    readonly status: "succeeded" | "failed";
    readonly result: Record<string, unknown> | null;
    readonly error: Record<string, unknown> | null;
    readonly completedAt: string;
    readonly durationMs: number;
  }): void {
    this.setState({
      localCommandLog: this.state.localCommandLog.map((entry) => {
        if (entry.commandId !== args.commandId) {
          return entry;
        }
        return {
          ...entry,
          status: args.status,
          result: args.result,
          error: args.error,
          completedAt: args.completedAt,
          durationMs: args.durationMs,
        };
      }),
    });
  }

  private clearHeartbeatTimer(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    this.clearScheduledTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearCommandTimer(): void {
    if (!this.commandTimer) {
      return;
    }
    this.clearScheduledTimeout(this.commandTimer);
    this.commandTimer = null;
  }

  private scheduleHeartbeat(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.heartbeatTimer = this.scheduleTimeout(() => {
      this.heartbeatTimer = null;
      void this.heartbeatLoop();
    }, delayMs);
  }

  private scheduleCommandPoll(delayMs: number): void {
    if (!this.running || this.commandTimer) {
      return;
    }
    this.commandTimer = this.scheduleTimeout(() => {
      this.commandTimer = null;
      void this.commandLoop();
    }, delayMs);
  }

  private async heartbeatLoop(): Promise<void> {
    try {
      if (!this.hostToken || !(await this.heartbeat())) {
        this.running = false;
        this.clearCommandTimer();
        return;
      }
      this.scheduleHeartbeat(ONLINE_POLL_MS);
    } catch (error) {
      this.setState({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.running = false;
      this.clearCommandTimer();
    }
  }

  private async commandLoop(): Promise<void> {
    if (this.commandExecutionRunning) {
      return;
    }
    this.commandExecutionRunning = true;
    try {
      await this.claimAndExecuteCommand();
    } catch (error) {
      if (this.running) {
        this.setState({
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.commandExecutionRunning = false;
      if (this.running && this.hostToken) {
        this.scheduleCommandPoll(ONLINE_POLL_MS);
      }
    }
  }

  private async startHost(): Promise<number | null> {
    this.setState({ status: "connecting", lastError: null });
    const response = await this.sessionFetch(
      `${this.apiBaseUrl}/api/zero/computer-use/hosts/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await this.runtimeBody()),
      },
    );
    if (response.status === 401) {
      if (await this.hasAuthenticatedSession()) {
        this.setState({
          status: "needs_organization",
          lastError: COMPUTER_USE_NEEDS_ORGANIZATION_MESSAGE,
        });
      } else {
        this.setState({
          status: "unauthenticated",
          lastError: COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
        });
      }
      return null;
    }
    if (response.status === 403) {
      this.setState({
        status: "disabled",
        lastError: "Computer Use is disabled for this account.",
      });
      return null;
    }
    if (response.status === 409) {
      this.setState({
        status: "error",
        hostId: null,
        lastError:
          "Computer Use is already active in another Zero Desktop session.",
      });
      return null;
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

  private async hasAuthenticatedSession(): Promise<boolean> {
    const response = await this.sessionFetch(
      `${this.apiBaseUrl}${AUTH_ME_PATH}`,
      {
        method: "GET",
      },
    );
    return response.ok;
  }

  private async heartbeat(): Promise<boolean> {
    const response = await this.hostFetch("/api/zero/computer-use/heartbeat", {
      method: "POST",
      body: JSON.stringify(await this.runtimeBody()),
    });
    if (response.status === 401) {
      this.hostToken = null;
      this.setState({
        status: "unauthenticated",
        hostId: null,
        lastError: COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
      });
      return false;
    }
    if (response.status === 409) {
      this.hostToken = null;
      this.setState({
        status: "error",
        hostId: null,
        lastError:
          "Computer Use is already active in another Zero Desktop session.",
      });
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

    const response = await this.sessionFetch(url.toString(), { method: "GET" });
    if (response.status === 401 || response.status === 403) {
      this.setState({ recentAuditEvents: [] });
      return;
    }
    if (!response.ok) {
      throw new Error(
        `Computer Use audit history refresh failed: ${response.status}`,
      );
    }

    const body = (await response.json()) as ComputerUseAuditEventsResponse;
    this.setState({
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

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    this.startLocalCommandLogEntry(body.command, startedAt);

    let completed: ComputerUseCommandExecutionResult;
    try {
      completed = await this.executeCommand(
        body.command,
        await this.getPermissions(),
      );
    } catch (error) {
      completed = commandFailureFromError(error);
    }
    const completedAtMs = Date.now();
    this.finishLocalCommandLogEntry({
      commandId: body.command.id,
      status: completed.status,
      result: completed.status === "succeeded" ? completed.result : null,
      error: completed.status === "failed" ? completed.error : null,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
    });
    if (!this.running || !this.hostToken) {
      return;
    }
    await this.completeCommandWithRetry(body.command.id, completed);
    this.setState({
      status: "online",
      lastCommandAt: new Date().toISOString(),
      lastError: null,
    });
    await this.refreshAuditEvents();
  }

  private async completeCommandWithRetry(
    commandId: string,
    completed: ComputerUseCommandExecutionResult,
  ): Promise<void> {
    let lastError: Error | null = null;
    for (
      let attempt = 1;
      attempt <= COMMAND_COMPLETION_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        const response = await this.hostFetch(
          `/api/zero/computer-use/host/commands/${commandId}/complete`,
          {
            method: "POST",
            body: JSON.stringify(completed),
          },
        );
        if (response.ok) {
          return;
        }
        lastError = new Error(
          `Computer Use command completion failed: ${response.status}`,
        );
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error(
                `Computer Use command completion failed: ${String(error)}`,
              );
      }

      if (attempt < COMMAND_COMPLETION_MAX_ATTEMPTS) {
        await this.sleep(COMMAND_COMPLETION_RETRY_DELAY_MS);
      }
    }

    throw lastError ?? new Error("Computer Use command completion failed");
  }

  private sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduleTimeout(resolve, delayMs);
    });
  }

  private hostFetch(path: string, init: RequestInit): Promise<Response> {
    if (!this.hostToken) {
      throw new Error("Computer Use host token is not available");
    }
    return this.hostFetchRequest(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.hostToken}`,
        ...init.headers,
      },
    });
  }

  private async stopHost(hostToken: string): Promise<void> {
    const response = await this.hostFetchRequest(
      `${this.apiBaseUrl}/api/zero/computer-use/host/stop`,
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hostToken}`,
        },
      },
    );
    if (response.status === 401) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Computer Use host stop failed: ${response.status}`);
    }
  }
}
