import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DesktopLocalAgentApiClient } from "./desktop-local-agent-api";
import {
  defaultPermissionMode,
  type detectLocalAgentBackends,
  type executeLocalAgentBackend,
  type preflightLocalAgentBackend,
} from "./desktop-local-agent-runtime";
import type {
  DesktopLocalAgentAddOptions,
  DesktopLocalAgentBackend,
  DesktopLocalAgentBackendProbe,
  DesktopLocalAgentEntry,
  DesktopLocalAgentExecutionResult,
} from "./desktop-local-agent-types";

const HEARTBEAT_INTERVAL_MS = 60_000;
const IDLE_POLL_INTERVAL_MS = 2_000;

interface DesktopLocalAgentStore {
  readonly load: () => Promise<DesktopLocalAgentEntry[]>;
  readonly save: (entries: readonly DesktopLocalAgentEntry[]) => Promise<void>;
}

interface DesktopLocalAgentManagerDependencies {
  readonly store: DesktopLocalAgentStore;
  readonly api: DesktopLocalAgentApiClient;
  readonly selectFolder: () => Promise<string | null>;
  readonly openFolder: (folderPath: string) => Promise<void>;
  readonly detectBackends: typeof detectLocalAgentBackends;
  readonly preflightBackend: typeof preflightLocalAgentBackend;
  readonly executeBackend: typeof executeLocalAgentBackend;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly onChange?: () => void;
}

interface RunningAgent {
  readonly controller: AbortController;
  readonly hostToken: string;
  readonly promise: Promise<void>;
}

function cloneEntry(entry: DesktopLocalAgentEntry): DesktopLocalAgentEntry {
  return { ...entry };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function stoppedEntry(entry: DesktopLocalAgentEntry): DesktopLocalAgentEntry {
  const { errorMessage: _errorMessage, ...rest } = entry;
  return {
    ...rest,
    status: "stopped",
  };
}

function preferredBackend(
  probes: readonly DesktopLocalAgentBackendProbe[],
  requested?: DesktopLocalAgentBackend,
): DesktopLocalAgentBackend {
  if (requested) {
    return requested;
  }
  const availableCodex = probes.find((probe) => {
    return probe.backend === "codex" && probe.available;
  });
  if (availableCodex) {
    return "codex";
  }
  const firstAvailable = probes.find((probe) => {
    return probe.available;
  });
  return firstAvailable?.backend ?? "codex";
}

function uniqueName(
  basename: string,
  entries: readonly DesktopLocalAgentEntry[],
): string {
  const names = new Set(
    entries.map((entry) => {
      return entry.name;
    }),
  );
  if (!names.has(basename)) {
    return basename;
  }

  let index = 2;
  while (names.has(`${basename} ${index}`)) {
    index += 1;
  }
  return `${basename} ${index}`;
}

export class DesktopLocalAgentManager {
  private entries: DesktopLocalAgentEntry[] | null = null;
  private readonly runningAgents = new Map<string, RunningAgent>();
  private readonly backendRuntimePaths = new Map<string, string>();
  private nativeEnabled = false;

  constructor(private readonly deps: DesktopLocalAgentManagerDependencies) {}

  async setEnabled(enabled: boolean): Promise<void> {
    this.nativeEnabled = enabled;
    if (!enabled) {
      await this.stopAll();
    }
  }

  isEnabled(): boolean {
    return this.nativeEnabled;
  }

  hasRunningAgents(): boolean {
    return this.runningAgents.size > 0;
  }

  async list(): Promise<DesktopLocalAgentEntry[]> {
    this.assertEnabled();
    await this.ensureLoaded();
    return this.entriesOrThrow().map(cloneEntry);
  }

  async detectBackends(): Promise<DesktopLocalAgentBackendProbe[]> {
    this.assertEnabled();
    return this.deps.detectBackends();
  }

  async add(
    options: DesktopLocalAgentAddOptions = {},
  ): Promise<DesktopLocalAgentEntry | null> {
    this.assertEnabled();
    await this.ensureLoaded();
    const folderPath = await this.deps.selectFolder();
    if (!folderPath) {
      return null;
    }

    const probes = await this.deps.detectBackends();
    const backend = preferredBackend(probes, options.backend);
    const permissionMode =
      options.permissionMode ?? defaultPermissionMode(backend);
    const entries = this.entriesOrThrow();
    const basename = path.basename(folderPath) || folderPath;
    const entry: DesktopLocalAgentEntry = {
      id: this.randomId(),
      name: uniqueName(basename, entries),
      folderPath,
      backend,
      permissionMode,
      status: "stopped",
    };
    entries.push(entry);
    await this.persistAndNotify();
    return this.start(entry.id);
  }

  async start(id: string): Promise<DesktopLocalAgentEntry> {
    this.assertEnabled();
    await this.ensureLoaded();
    const entry = this.requireEntry(id);
    const existing = this.runningAgents.get(id);
    if (existing) {
      return cloneEntry(entry);
    }

    this.updateEntry(id, { status: "starting" });
    await this.persistAndNotify();

    try {
      await fs.access(entry.folderPath, fsConstants.R_OK | fsConstants.X_OK);
      const backendRuntime = await this.deps.preflightBackend(entry.backend);
      this.updateEntry(id, {
        executablePath: backendRuntime.executablePath,
      });
      this.backendRuntimePaths.set(id, backendRuntime.runtimePath);
      await this.persistAndNotify();

      const controller = new AbortController();
      const supportedBackends = [entry.backend];
      const host = await this.deps.api.startHost({
        hostName: entry.name,
        hostId: entry.hostId,
        supportedBackends,
        signal: controller.signal,
      });
      this.updateEntry(id, {
        hostId: host.hostId,
        status: "online",
        errorMessage: undefined,
      });
      await this.persistAndNotify();

      const promise = this.runLoop({
        id,
        hostToken: host.hostToken,
        controller,
      });
      this.runningAgents.set(id, {
        controller,
        hostToken: host.hostToken,
        promise,
      });
      void promise;
      return cloneEntry(this.requireEntry(id));
    } catch (error) {
      this.backendRuntimePaths.delete(id);
      this.updateEntry(id, {
        status: "error",
        errorMessage: errorMessage(error),
      });
      await this.persistAndNotify();
      return cloneEntry(this.requireEntry(id));
    }
  }

  async stop(id: string): Promise<DesktopLocalAgentEntry> {
    this.assertEnabled();
    return this.stopEntry(id);
  }

  private async stopEntry(id: string): Promise<DesktopLocalAgentEntry> {
    await this.ensureLoaded();
    const entry = this.requireEntry(id);
    const running = this.runningAgents.get(id);
    if (!running) {
      this.updateEntry(id, { status: "stopped" });
      await this.persistAndNotify();
      return cloneEntry(this.requireEntry(entry.id));
    }

    this.updateEntry(id, { status: "stopping" });
    await this.persistAndNotify();
    running.controller.abort();
    await running.promise.catch(() => {});
    await this.closeRunningHost(running);
    this.runningAgents.delete(id);
    this.backendRuntimePaths.delete(id);
    this.updateEntry(id, { status: "stopped", errorMessage: undefined });
    await this.persistAndNotify();
    return cloneEntry(this.requireEntry(id));
  }

  async stopAll(): Promise<void> {
    await this.ensureLoaded();
    await Promise.all(
      [...this.runningAgents.keys()].map((id) => {
        return this.stopEntry(id).then(() => {});
      }),
    );
  }

  async remove(id: string): Promise<void> {
    this.assertEnabled();
    await this.stopEntry(id).catch(() => {});
    await this.ensureLoaded();
    this.entries = this.entriesOrThrow().filter((entry) => {
      return entry.id !== id;
    });
    await this.persistAndNotify();
  }

  async openFolder(id: string): Promise<void> {
    this.assertEnabled();
    await this.ensureLoaded();
    const entry = this.requireEntry(id);
    await this.deps.openFolder(entry.folderPath);
  }

  private async runLoop(params: {
    readonly id: string;
    readonly hostToken: string;
    readonly controller: AbortController;
  }): Promise<void> {
    let nextHeartbeatAt = 0;
    const signal = params.controller.signal;
    try {
      while (!signal.aborted) {
        const entry = this.requireEntry(params.id);
        const supportedBackends = [entry.backend];
        if (Date.now() >= nextHeartbeatAt) {
          await this.sendHeartbeat({
            entry,
            hostToken: params.hostToken,
            supportedBackends,
            signal,
          });
          nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
        }
        const nextJob = await this.deps.api.claimNextJob({
          hostToken: params.hostToken,
          supportedBackends,
          signal,
        });
        if (nextJob.status === "idle") {
          await delay(IDLE_POLL_INTERVAL_MS, signal);
          continue;
        }
        await this.runJob({
          entry,
          hostToken: params.hostToken,
          jobId: nextJob.job.id,
          prompt: nextJob.job.prompt,
          backend: nextJob.job.backend,
          signal,
        });
      }
    } catch (error) {
      if (!signal.aborted) {
        this.runningAgents.delete(params.id);
        this.backendRuntimePaths.delete(params.id);
        await this.closeRunningHostToken(params.hostToken);
        this.updateEntry(params.id, {
          status: "error",
          errorMessage: errorMessage(error),
        });
        await this.persistAndNotify();
      }
    }
  }

  private async runJob(params: {
    readonly entry: DesktopLocalAgentEntry;
    readonly hostToken: string;
    readonly jobId: string;
    readonly prompt: string;
    readonly backend: DesktopLocalAgentBackend;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const result = await this.deps.executeBackend({
      backend: params.backend,
      prompt: params.prompt,
      workdir: params.entry.folderPath,
      permissionMode: params.entry.permissionMode,
      executablePath: params.entry.executablePath,
      runtimePath: this.backendRuntimePaths.get(params.entry.id),
      signal: params.signal,
    });
    await this.completeJob({
      hostToken: params.hostToken,
      jobId: params.jobId,
      result,
      signal: params.signal.aborted ? undefined : params.signal,
    });
    if (result.backendHealthy === false) {
      throw new Error(result.error ?? "Local agent backend is unavailable");
    }
  }

  private async completeJob(params: {
    readonly hostToken: string;
    readonly jobId: string;
    readonly result: DesktopLocalAgentExecutionResult;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    await this.deps.api.completeJob({
      hostToken: params.hostToken,
      jobId: params.jobId,
      status: params.result.exitCode === 0 ? "succeeded" : "failed",
      output: params.result.output,
      error: params.result.error,
      exitCode: params.result.exitCode,
      signal: params.signal,
    });
  }

  private async sendHeartbeat(params: {
    readonly entry: DesktopLocalAgentEntry;
    readonly hostToken: string;
    readonly supportedBackends: readonly DesktopLocalAgentBackend[];
    readonly signal: AbortSignal;
  }): Promise<void> {
    await this.deps.api.heartbeat({
      hostToken: params.hostToken,
      hostName: params.entry.name,
      supportedBackends: params.supportedBackends,
      signal: params.signal,
    });
    this.updateEntry(params.entry.id, {
      status: "online",
      lastHeartbeatAt: new Date(this.now()).toISOString(),
      errorMessage: undefined,
    });
    await this.persistAndNotify();
  }

  private async closeRunningHost(running: RunningAgent): Promise<void> {
    await this.closeRunningHostToken(running.hostToken);
  }

  private async closeRunningHostToken(hostToken: string): Promise<void> {
    await this.deps.api.closeHost({ hostToken }).catch(() => {});
  }

  private async ensureLoaded(): Promise<void> {
    if (this.entries) {
      return;
    }
    const entries = await this.deps.store.load();
    this.entries = entries.map(stoppedEntry);
    await this.deps.store.save(this.entries);
  }

  private entriesOrThrow(): DesktopLocalAgentEntry[] {
    if (!this.entries) {
      throw new Error("Desktop local agents have not loaded");
    }
    return this.entries;
  }

  private requireEntry(id: string): DesktopLocalAgentEntry {
    const entry = this.entriesOrThrow().find((candidate) => {
      return candidate.id === id;
    });
    if (!entry) {
      throw new Error("Desktop local agent not found");
    }
    return entry;
  }

  private updateEntry(
    id: string,
    patch: Partial<DesktopLocalAgentEntry>,
  ): void {
    const entries = this.entriesOrThrow();
    this.entries = entries.map((entry) => {
      return entry.id === id ? { ...entry, ...patch } : entry;
    });
  }

  private async persistAndNotify(): Promise<void> {
    await this.deps.store.save(this.entriesOrThrow());
    this.deps.onChange?.();
  }

  private assertEnabled(): void {
    if (!this.nativeEnabled) {
      throw new Error("Desktop local agent is disabled");
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private randomId(): string {
    return this.deps.randomId?.() ?? crypto.randomUUID();
  }
}
