import { hostname } from "os";
import { Command } from "commander";
import chalk from "chalk";
import { Realtime, type AuthOptions, type InboundMessage } from "ably";
import type {
  LocalAgentBackend,
  LocalAgentHost,
  LocalAgentRealtimeSubscription,
} from "@vm0/api-contracts/contracts/zero-local-agent";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  ApiRequestError,
  claimNextLocalAgentHostJob,
  closeLocalAgentHost,
  completeLocalAgentHostJob,
  createLocalAgentHostRealtimeSubscription,
  listLocalAgentHosts,
  sendLocalAgentHeartbeat,
  startLocalAgentHost,
} from "../../../lib/api";
import { getBaseUrl } from "../../../lib/api/core/client-factory";
import {
  getLocalAgentHost,
  saveLocalAgentHost,
  type LocalAgentHostConfig,
} from "../../../lib/api/config";
import {
  isInteractive,
  promptSelect,
  promptText,
} from "../../../lib/utils/prompt-utils";
import {
  detectLocalAgentBackends,
  executeLocalAgentBackend,
  type LocalAgentPermissionMode,
} from "../../../lib/local-agent/backends";

const HEARTBEAT_INTERVAL_MS = 60_000;
const ABLY_CONNECT_TIMEOUT_MS = 10_000;

interface HostStartOptions {
  name?: string;
  workdir?: string;
  backend?: string;
  claudeArg?: string[];
  permissionMode?: string;
  hostId?: string;
  new?: boolean;
}

interface PermissionModeChoice {
  title: string;
  value: LocalAgentPermissionMode;
  description: string;
}

interface LocalAgentJobNotifier {
  isConnected(): boolean;
  wait(timeoutMs: number): Promise<boolean>;
  close(): void;
}

interface StartHostSelection {
  hostId?: string;
  hostName: string;
  restoredHost?: LocalAgentHost;
}

const NEW_HOST_SELECTION = "__new__";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInvalidHostTokenError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

function createHostRealtime(
  hostToken: string,
  initialSubscription: LocalAgentRealtimeSubscription,
): Realtime {
  let nextAuthSubscription: LocalAgentRealtimeSubscription | null =
    initialSubscription;
  const authCallback: NonNullable<AuthOptions["authCallback"]> = (
    _params,
    callback,
  ) => {
    const current = nextAuthSubscription;
    if (current) {
      nextAuthSubscription = null;
      callback(null, current.tokenRequest);
      return;
    }

    createLocalAgentHostRealtimeSubscription({ hostToken }).then(
      (subscription) => {
        callback(null, subscription.tokenRequest);
      },
      (error: unknown) => {
        callback(errorMessage(error), null);
      },
    );
  };

  return new Realtime({
    authCallback,
    autoConnect: true,
    disconnectedRetryTimeout: 5000,
    suspendedRetryTimeout: 15_000,
  });
}

function waitForRealtimeConnected(
  ably: Realtime,
  timeoutMs = ABLY_CONNECT_TIMEOUT_MS,
): Promise<void> {
  if (ably.connection.state === "connected") {
    return Promise.resolve();
  }
  if (ably.connection.state === "failed") {
    return Promise.reject(new Error("Ably connection failed"));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out connecting to Ably"));
    }, timeoutMs);

    ably.connection.once("connected", () => {
      clearTimeout(timer);
      resolve();
    });
    ably.connection.once("failed", (stateChange) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Ably connection failed: ${stateChange?.reason?.message ?? "unknown"}`,
        ),
      );
    });
  });
}

async function createLocalAgentJobNotifier(
  hostToken: string,
): Promise<LocalAgentJobNotifier> {
  const subscription = await createLocalAgentHostRealtimeSubscription({
    hostToken,
  });
  const ably = createHostRealtime(hostToken, subscription);

  try {
    await waitForRealtimeConnected(ably);
    const channel = ably.channels.get(subscription.channelName);

    let pendingEvent = false;
    let closed = false;
    let wake: (() => void) | null = null;

    const wakeWaiter = () => {
      const current = wake;
      wake = null;
      current?.();
    };

    const onMessage = (_message: InboundMessage) => {
      if (wake) {
        wakeWaiter();
        return;
      }
      pendingEvent = true;
    };

    await channel.subscribe(subscription.eventName, onMessage);

    return {
      isConnected(): boolean {
        return ably.connection.state === "connected";
      },
      wait(timeoutMs: number): Promise<boolean> {
        if (pendingEvent || closed) {
          pendingEvent = false;
          return Promise.resolve(true);
        }
        if (timeoutMs <= 0) {
          return Promise.resolve(false);
        }

        return new Promise((resolve) => {
          const done = (notified: boolean) => {
            clearTimeout(timer);
            if (wake === onWake) {
              wake = null;
            }
            resolve(notified);
          };
          function onWake() {
            done(true);
          }
          const timer = setTimeout(() => {
            done(false);
          }, timeoutMs);
          wake = onWake;
        });
      },
      close(): void {
        if (closed) {
          return;
        }
        closed = true;
        channel.unsubscribe(subscription.eventName, onMessage);
        wakeWaiter();
        ably.close();
      },
    };
  } catch (error) {
    ably.close();
    throw error;
  }
}

function backendLabel(backend: LocalAgentBackend): string {
  if (backend === "claude-code") return "Claude Code";
  return "Codex";
}

function parseBackend(value: string): LocalAgentBackend {
  if (value === "codex") {
    return "codex";
  }
  if (value === "claude-code" || value === "claude") {
    return "claude-code";
  }
  throw new Error("Backend must be one of: codex, claude-code");
}

function permissionModeChoices(
  backend: LocalAgentBackend,
): PermissionModeChoice[] {
  if (backend === "claude-code") {
    return [
      {
        title: "Default",
        value: "default",
        description: "Use Claude Code's configured default",
      },
      {
        title: "Accept edits",
        value: "acceptEdits",
        description: "Automatically accept file edits",
      },
      {
        title: "Auto",
        value: "auto",
        description: "Let Claude Code choose when to ask",
      },
      {
        title: "Don't ask",
        value: "dontAsk",
        description: "Run without interactive permission prompts",
      },
      {
        title: "Plan",
        value: "plan",
        description: "Run Claude Code in planning mode",
      },
      {
        title: "Bypass permissions",
        value: "bypassPermissions",
        description: "Skip Claude Code permission checks",
      },
    ];
  }

  return [
    {
      title: "Default",
      value: "default",
      description: "Use Codex's configured default",
    },
    {
      title: "Read only",
      value: "read-only",
      description: "Allow reading files only",
    },
    {
      title: "Workspace write",
      value: "workspace-write",
      description: "Allow edits inside the workspace",
    },
    {
      title: "Full access",
      value: "danger-full-access",
      description: "Allow unrestricted filesystem access",
    },
    {
      title: "Bypass approvals and sandbox",
      value: "bypassPermissions",
      description: "Run Codex without approvals or sandbox",
    },
  ];
}

function permissionModeLabel(mode: LocalAgentPermissionMode): string {
  if (mode === "default") return "Default";
  if (mode === "acceptEdits") return "Accept edits";
  if (mode === "auto") return "Auto";
  if (mode === "bypassPermissions") return "Bypass permissions";
  if (mode === "dontAsk") return "Don't ask";
  if (mode === "plan") return "Plan";
  if (mode === "read-only") return "Read only";
  if (mode === "workspace-write") return "Workspace write";
  return "Full access";
}

function formatHostAge(value: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function restoreHostSelection(host: LocalAgentHost): StartHostSelection {
  return {
    hostId: host.id,
    hostName: host.displayName,
    restoredHost: host,
  };
}

function formatSupportedBackends(
  backends: readonly LocalAgentBackend[],
): string {
  return backends.map(backendLabel).join(", ");
}

function assertHostNameAvailable(
  hostName: string,
  hosts: readonly LocalAgentHost[],
): void {
  const existingHost = hosts.find((host) => {
    return host.displayName === hostName;
  });
  if (!existingHost) {
    return;
  }

  throw new Error(
    `Local-agent host name already exists: ${hostName}. Use --host-id ${existingHost.id} to reactivate it, or choose another --name.`,
  );
}

function hostsMatchingName(
  hostName: string,
  hosts: readonly LocalAgentHost[],
): LocalAgentHost[] {
  return hosts.filter((host) => {
    return host.displayName === hostName;
  });
}

function hostSelectionForName(
  hostName: string,
  hosts: readonly LocalAgentHost[],
): StartHostSelection | null {
  const matchingNameHosts = hostsMatchingName(hostName, hosts);
  if (matchingNameHosts.length > 1) {
    throw new Error(
      `Multiple local-agent hosts are named ${hostName}. Use --host-id <id> to choose one.`,
    );
  }

  const [host] = matchingNameHosts;
  if (!host) {
    return null;
  }
  if (host.status === "closed") {
    return restoreHostSelection(host);
  }

  throw new Error(
    `Local-agent host is already online: ${hostName}. Choose another --name or delete the existing host first.`,
  );
}

async function promptNewHostName(params: {
  initialName: string;
  existingHosts: readonly LocalAgentHost[];
  allowClosedReuse?: boolean;
}): Promise<string> {
  const selected = await promptText(
    "Host name:",
    params.initialName,
    (value) => {
      const hostName = value.trim();
      if (!hostName) {
        return "Host name is required";
      }
      const matchingHosts = hostsMatchingName(hostName, params.existingHosts);
      if (matchingHosts.length === 0) {
        return true;
      }
      if (!params.allowClosedReuse) {
        return "A host with this name already exists";
      }
      if (matchingHosts.length > 1) {
        return "Multiple local-agent hosts have this name";
      }
      if (matchingHosts[0]?.status === "closed") {
        return true;
      }
      return "A host with this name is already online";
    },
  );
  const hostName = selected?.trim();

  if (hostName) {
    return hostName;
  }
  if (!isInteractive()) {
    throw new Error(
      "Local-agent start requires a host name in non-interactive mode. Use --name <name>.",
    );
  }
  throw new Error("Host name selection cancelled");
}

async function promptStartHostSelection(params: {
  initialName: string;
  existingHosts: readonly LocalAgentHost[];
}): Promise<StartHostSelection> {
  const hostName = await promptNewHostName({
    initialName: params.initialName,
    existingHosts: params.existingHosts,
    allowClosedReuse: true,
  });

  return hostSelectionForName(hostName, params.existingHosts) ?? { hostName };
}

export async function chooseHostForStart(params: {
  requestedHostName?: string;
  requestedHostId?: string;
  createNew?: boolean;
  savedHostId?: string;
}): Promise<StartHostSelection> {
  if (params.requestedHostId && params.createNew) {
    throw new Error("Use either --host-id or --new, not both");
  }

  const { hosts } = await listLocalAgentHosts();
  const closedHosts = hosts.filter((host) => {
    return host.status === "closed";
  });
  const requestedHostName = params.requestedHostName?.trim();

  if (params.requestedHostId) {
    const host = hosts.find((item) => {
      return item.id === params.requestedHostId;
    });
    if (!host) {
      throw new Error("Local-agent host not found");
    }
    return restoreHostSelection(host);
  }

  if (params.createNew) {
    const hostName =
      requestedHostName ??
      (await promptNewHostName({
        initialName: hostname(),
        existingHosts: hosts,
      }));
    assertHostNameAvailable(hostName, hosts);
    return { hostName };
  }

  if (requestedHostName) {
    return (
      hostSelectionForName(requestedHostName, hosts) ?? {
        hostName: requestedHostName,
      }
    );
  }

  if (!isInteractive()) {
    throw new Error(
      "Local-agent start requires a host name in non-interactive mode. Use --name <name> or --host-id <id>.",
    );
  }

  if (closedHosts.length > 0) {
    const choices = [
      {
        title: "New host",
        value: NEW_HOST_SELECTION,
        description: "Create a new named host",
      },
      ...closedHosts.map((host) => {
        const backends = formatSupportedBackends(host.supportedBackends);
        const saved = host.id === params.savedHostId ? " saved locally" : "";
        return {
          title: `${host.displayName} (existed)`,
          value: host.id,
          description: `${host.id} ${backends} ${formatHostAge(
            host.lastSeenAt,
          )}${saved}`,
        };
      }),
    ];
    const savedIndex = closedHosts.findIndex((host) => {
      return host.id === params.savedHostId;
    });
    const selected = await promptSelect<string>(
      "Start local-agent host:",
      choices,
      savedIndex >= 0 ? savedIndex + 1 : 0,
    );

    if (!selected) {
      throw new Error("Local-agent host selection cancelled");
    }
    if (selected === NEW_HOST_SELECTION) {
      return promptStartHostSelection({
        initialName: hostname(),
        existingHosts: hosts,
      });
    }

    const host = closedHosts.find((item) => {
      return item.id === selected;
    });
    if (!host) {
      throw new Error("Local-agent host not found");
    }
    return restoreHostSelection(host);
  }

  return {
    hostName: await promptNewHostName({
      initialName: hostname(),
      existingHosts: hosts,
    }),
  };
}

function parsePermissionMode(
  backend: LocalAgentBackend,
  value: string,
): LocalAgentPermissionMode {
  const choices = permissionModeChoices(backend);
  const mode = choices.find((choice) => {
    return choice.value === value;
  })?.value;

  if (mode) {
    return mode;
  }

  throw new Error(
    `Permission mode must be one of: ${choices
      .map((choice) => {
        return choice.value;
      })
      .join(", ")}`,
  );
}

async function chooseBackend(
  probes: Awaited<ReturnType<typeof detectLocalAgentBackends>>,
  requestedBackend?: string,
): Promise<LocalAgentBackend> {
  const available = probes.filter((probe) => {
    return probe.available;
  });

  if (available.length === 0) {
    throw new Error(
      "No supported agent CLI found. Install Codex CLI (`codex`) or Claude Code (`claude`) before starting local-agent.",
    );
  }

  if (requestedBackend) {
    const backend = parseBackend(requestedBackend);
    const probe = available.find((item) => {
      return item.backend === backend;
    });
    if (!probe) {
      throw new Error(
        `${backendLabel(backend)} CLI is not available on this machine.`,
      );
    }
    return backend;
  }

  const selected = await promptSelect<LocalAgentBackend>(
    "Select agent CLI:",
    available.map((probe) => {
      const version = probe.version ? ` (${probe.version})` : "";
      return {
        title: backendLabel(probe.backend),
        value: probe.backend,
        description: `${probe.command}${version}`,
      };
    }),
    0,
  );

  if (!selected) {
    if (!isInteractive()) {
      throw new Error(
        "Local-agent start requires a backend in non-interactive mode. Use --backend codex or --backend claude-code.",
      );
    }
    throw new Error("Backend selection cancelled");
  }

  return selected;
}

function chooseRestoredBackend(params: {
  host: LocalAgentHost;
  probes: Awaited<ReturnType<typeof detectLocalAgentBackends>>;
  requestedBackend?: string;
}): LocalAgentBackend {
  const available = params.probes.filter((probe) => {
    return probe.available;
  });

  const backend = params.requestedBackend
    ? parseBackend(params.requestedBackend)
    : params.host.supportedBackends.find((supportedBackend) => {
        return available.some((probe) => {
          return probe.backend === supportedBackend;
        });
      });

  if (!backend) {
    throw new Error(
      `No CLI found for restored host "${params.host.displayName}". Install ${formatSupportedBackends(
        params.host.supportedBackends,
      )}, or start a new host with --new --name <name>.`,
    );
  }
  if (!params.host.supportedBackends.includes(backend)) {
    throw new Error(
      `Local-agent host "${params.host.displayName}" was configured for ${formatSupportedBackends(
        params.host.supportedBackends,
      )}.`,
    );
  }
  if (
    !available.some((probe) => {
      return probe.backend === backend;
    })
  ) {
    throw new Error(
      `${backendLabel(backend)} CLI is not available on this machine.`,
    );
  }

  return backend;
}

async function choosePermissionMode(
  backend: LocalAgentBackend,
  requestedPermissionMode?: string,
): Promise<LocalAgentPermissionMode> {
  if (requestedPermissionMode) {
    return parsePermissionMode(backend, requestedPermissionMode);
  }

  const selected = await promptSelect<LocalAgentPermissionMode>(
    "Select permission mode:",
    permissionModeChoices(backend),
    0,
  );

  if (!selected) {
    if (!isInteractive()) {
      throw new Error(
        "Local-agent start requires a permission mode in non-interactive mode. Use --permission-mode default or another supported mode.",
      );
    }
    throw new Error("Permission mode selection cancelled");
  }

  return selected;
}

function chooseRestoredPermissionMode(params: {
  backend: LocalAgentBackend;
  requestedPermissionMode?: string;
  savedHost?: LocalAgentHostConfig;
  hostId?: string;
}): LocalAgentPermissionMode {
  if (params.requestedPermissionMode) {
    return parsePermissionMode(params.backend, params.requestedPermissionMode);
  }
  const savedHost = params.savedHost;
  if (
    !savedHost ||
    savedHost.id !== params.hostId ||
    !savedHost.permissionMode
  ) {
    return "default";
  }

  try {
    return parsePermissionMode(params.backend, savedHost.permissionMode);
  } catch {
    return "default";
  }
}

async function runHostLoop(params: {
  hostToken: string;
  hostName: string;
  supportedBackends: LocalAgentBackend[];
  claudeArgs: string[];
  permissionMode: LocalAgentPermissionMode;
  workdir: string;
}): Promise<void> {
  let latestError: string | null = null;
  let stopped = false;
  let closeHostOnStop = false;
  let nextHeartbeatAt = 0;
  let jobNotifier: LocalAgentJobNotifier | null = null;

  const stopLoop = () => {
    stopped = true;
    jobNotifier?.close();
  };
  const onStop = () => {
    closeHostOnStop = true;
    stopLoop();
  };

  const sendHeartbeat = async (): Promise<void> => {
    try {
      await sendLocalAgentHeartbeat({
        ...params,
        realtimeConnected: jobNotifier?.isConnected() ?? false,
      });
      nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
      latestError = null;
    } catch (error) {
      if (isInvalidHostTokenError(error)) {
        console.log(chalk.yellow("Local-agent host was deleted; stopping."));
        stopLoop();
        return;
      }
      nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== latestError) {
        console.log(chalk.yellow(`Heartbeat failed: ${message}`));
      }
      latestError = message;
    }
  };

  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);

  try {
    jobNotifier = await createLocalAgentJobNotifier(params.hostToken).catch(
      (error: unknown) => {
        throw new Error(
          `Realtime job notifications unavailable: ${errorMessage(error)}`,
        );
      },
    );
    const notifier = jobNotifier;

    if (!stopped) {
      await sendHeartbeat();
    }

    let shouldClaim = true;
    while (!stopped) {
      if (Date.now() >= nextHeartbeatAt) {
        await sendHeartbeat();
      }
      if (stopped) {
        break;
      }

      if (!shouldClaim) {
        shouldClaim = await notifier.wait(
          Math.max(1, nextHeartbeatAt - Date.now()),
        );
        continue;
      }

      let nextJob;
      try {
        nextJob = await claimNextLocalAgentHostJob({
          hostToken: params.hostToken,
          supportedBackends: params.supportedBackends,
        });
      } catch (error) {
        if (isInvalidHostTokenError(error)) {
          console.log(chalk.yellow("Local-agent host was deleted; stopping."));
          stopLoop();
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to claim local-agent job: ${message}`);
      }

      if (nextJob.status === "idle") {
        shouldClaim = false;
        continue;
      }

      console.log(
        chalk.cyan(
          `Running ${backendLabel(nextJob.job.backend)} job ${nextJob.job.id}`,
        ),
      );

      const result = await executeLocalAgentBackend({
        backend: nextJob.job.backend,
        prompt: nextJob.job.prompt,
        workdir: params.workdir,
        claudeArgs: params.claudeArgs,
        permissionMode: params.permissionMode,
      });

      await completeLocalAgentHostJob({
        hostToken: params.hostToken,
        jobId: nextJob.job.id,
        status: result.exitCode === 0 ? "succeeded" : "failed",
        output: result.output,
        error: result.error,
        exitCode: result.exitCode,
      });

      const status =
        result.exitCode === 0 ? chalk.green("completed") : chalk.red("failed");
      console.log(`${status} ${nextJob.job.id}`);
      shouldClaim = true;
    }
  } finally {
    jobNotifier?.close();
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
    if (closeHostOnStop) {
      try {
        await closeLocalAgentHost({ hostToken: params.hostToken });
      } catch (error) {
        console.log(
          chalk.yellow(
            `Failed to close local-agent host: ${errorMessage(error)}`,
          ),
        );
      }
    }
  }
}

export const startCommand = new Command()
  .name("start")
  .description("Start the local-agent host daemon")
  .option("--name <name>", "New host name, or a closed host name to reactivate")
  .option("--workdir <path>", "Working directory for Codex/Claude jobs")
  .option("--backend <backend>", "codex or claude-code for a new host")
  .option(
    "--claude-arg <arg>",
    "Additional argument to pass to Claude Code jobs",
    (value: string, previous: string[]) => {
      return [...previous, value];
    },
    [] as string[],
  )
  .option("--permission-mode <mode>", "Permission mode for Codex/Claude jobs")
  .option(
    "--host-id <id>",
    "Reactivate a closed host from vm0 local-agent list",
  )
  .option("--new", "Create a new host registration")
  .action(
    withErrorHandler(async (options: HostStartOptions) => {
      const requestedHostName = options.name?.trim();
      const workdir = options.workdir?.trim() || process.cwd();
      const claudeArgs = options.claudeArg ?? [];
      const savedHost = await getLocalAgentHost();
      const selection = await chooseHostForStart({
        requestedHostName,
        requestedHostId: options.hostId?.trim(),
        createNew: options.new,
        savedHostId: savedHost?.id,
      });

      console.log(chalk.cyan("Detecting local agent CLIs..."));
      const probes = await detectLocalAgentBackends();
      const available = probes.filter((probe) => {
        return probe.available;
      });

      for (const probe of available) {
        const version = probe.version ? ` (${probe.version})` : "";
        console.log(
          `  ${backendLabel(probe.backend)}: ${probe.command}${version}`,
        );
      }
      const selectedBackend = selection.restoredHost
        ? chooseRestoredBackend({
            host: selection.restoredHost,
            probes,
            requestedBackend: options.backend,
          })
        : await chooseBackend(probes, options.backend);
      if (claudeArgs.length > 0 && selectedBackend !== "claude-code") {
        throw new Error("--claude-arg can only be used with Claude Code jobs");
      }
      const permissionMode = selection.restoredHost
        ? chooseRestoredPermissionMode({
            backend: selectedBackend,
            requestedPermissionMode: options.permissionMode,
            savedHost,
            hostId: selection.hostId,
          })
        : await choosePermissionMode(selectedBackend, options.permissionMode);
      const supportedBackends = [selectedBackend];

      console.log();
      console.log(
        selection.restoredHost
          ? `Restoring host: ${selection.hostName}`
          : `New host: ${selection.hostName}`,
      );
      console.log(`Using ${backendLabel(selectedBackend)}`);
      console.log(`Permission mode: ${permissionModeLabel(permissionMode)}`);
      const baseUrl = await getBaseUrl();

      console.log(chalk.cyan("Starting local-agent host..."));
      const startParams = {
        hostName: selection.hostName,
        supportedBackends,
        ...(selection.hostId ? { hostId: selection.hostId } : {}),
      };
      const started = await startLocalAgentHost(startParams);

      await saveLocalAgentHost({
        id: started.hostId,
        token: started.hostToken,
        apiUrl: baseUrl,
        hostName: selection.hostName,
        supportedBackends,
        permissionMode,
        linkedAt: new Date().toISOString(),
      });

      console.log(chalk.green(`Local-agent host active: ${started.hostId}`));
      console.log(`Workdir: ${workdir}`);
      console.log(chalk.dim("Press ^C to stop"));
      console.log();

      await runHostLoop({
        hostToken: started.hostToken,
        hostName: selection.hostName,
        supportedBackends,
        claudeArgs,
        permissionMode,
        workdir,
      });

      console.log();
      console.log(chalk.green("Local-agent host stopped"));
    }),
  );
