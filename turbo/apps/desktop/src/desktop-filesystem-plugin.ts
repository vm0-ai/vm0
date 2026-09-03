import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  COMPUTER_USE_FILESYSTEM_MCP_VERSION,
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUseFilesystemToolNames,
  computerUsePluginCallRequiredCapabilities,
  isComputerUsePluginCallPayload,
  isComputerUseFilesystemTool,
  parseComputerUseFilesystemToolArguments,
  type ComputerUseFilesystemTool,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import type {
  ComputerUseCommand,
  ComputerUseCommandExecutionResult,
  ComputerUseCommandFailure,
} from "./computer-use-accessibility";
import type { DesktopComputerUseFilesystemPluginState } from "./computer-use-types";
import { PluginRestartPolicy } from "./desktop-plugin-restart-policy";
import {
  commandFailure,
  normalizePluginToolResult,
  pluginErrorMessage,
} from "./desktop-plugin-tool-result";
import {
  readDesktopPreferenceRecord,
  writeDesktopPreferenceRecord,
} from "./desktop-preferences";

const nodeRequire = createRequire(__filename);
const PREFERENCES_KEY = "computerUsePlugins";
const FILESYSTEM_KEY = "filesystem";

interface FilesystemPluginPreferences {
  readonly enabled: boolean;
  readonly allowedDirectories: readonly string[];
}

interface FilesystemPluginRuntime {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly tools: ReadonlySet<ComputerUseFilesystemTool>;
}

interface DesktopFilesystemPluginManagerOptions {
  readonly preferencesPath: string;
  readonly onChange: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAllowedDirectories(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const directory = entry.trim();
    if (!directory || seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    directories.push(directory);
  }
  return directories;
}

function readFilesystemPluginPreferences(
  preferencesPath: string,
): FilesystemPluginPreferences {
  const preferences = readDesktopPreferenceRecord(preferencesPath);
  const plugins = preferences[PREFERENCES_KEY];
  const filesystem = isRecord(plugins) ? plugins[FILESYSTEM_KEY] : null;
  if (!isRecord(filesystem)) {
    return { enabled: false, allowedDirectories: [] };
  }
  return {
    enabled: filesystem.enabled === true,
    allowedDirectories: normalizeAllowedDirectories(
      filesystem.allowedDirectories,
    ),
  };
}

function writeFilesystemPluginPreferences(
  preferencesPath: string,
  filesystem: FilesystemPluginPreferences,
): void {
  const preferences = readDesktopPreferenceRecord(preferencesPath);
  const plugins = isRecord(preferences[PREFERENCES_KEY])
    ? preferences[PREFERENCES_KEY]
    : {};
  writeDesktopPreferenceRecord(preferencesPath, {
    ...preferences,
    [PREFERENCES_KEY]: {
      ...plugins,
      [FILESYSTEM_KEY]: {
        enabled: filesystem.enabled,
        allowedDirectories: [...filesystem.allowedDirectories],
      },
    },
  });
}

function packagedFilesystemServerEntry(): string | null {
  if (!process.resourcesPath) {
    return null;
  }
  const entry = path.join(process.resourcesPath, "mcp", "index.mjs");
  return existsSync(entry) ? entry : null;
}

function filesystemServerEntry(): string {
  return (
    packagedFilesystemServerEntry() ??
    nodeRequire.resolve("@modelcontextprotocol/server-filesystem/dist/index.js")
  );
}

function filesystemFailureCode(
  message: string,
): ComputerUseCommandFailure["error"]["code"] {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("allowed directory") ||
    normalized.includes("access denied") ||
    normalized.includes("permission denied") ||
    normalized.includes("outside")
  ) {
    return "path_denied";
  }
  return "mcp_error";
}

export class DesktopFilesystemPluginManager {
  private readonly preferencesPath: string;
  private readonly onChange: () => void;
  private preferences: FilesystemPluginPreferences = {
    enabled: false,
    allowedDirectories: [],
  };
  private featureEnabled = false;
  private hostRuntimeOnline = false;
  private runtime: FilesystemPluginRuntime | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly restartPolicy = new PluginRestartPolicy();
  private restartTimer: NodeJS.Timeout | null = null;
  private status: DesktopComputerUseFilesystemPluginState["status"] =
    "disabled";
  private lastError: string | null = null;

  constructor(options: DesktopFilesystemPluginManagerOptions) {
    this.preferencesPath = options.preferencesPath;
    this.onChange = options.onChange;
  }

  load(): void {
    this.preferences = readFilesystemPluginPreferences(this.preferencesPath);
    this.reconcile();
  }

  getState(): DesktopComputerUseFilesystemPluginState {
    return {
      featureEnabled: this.featureEnabled,
      enabled: this.preferences.enabled,
      allowedDirectories: [...this.preferences.allowedDirectories],
      status: this.status,
      lastError: this.lastError,
      version: COMPUTER_USE_FILESYSTEM_MCP_VERSION,
      capabilities: this.getCapabilities(),
    };
  }

  getCapabilities(): readonly string[] {
    if (this.status !== "running") {
      return [];
    }
    const toolCapabilities = [...(this.runtime?.tools ?? [])].flatMap(
      (tool) => {
        return computerUsePluginCallRequiredCapabilities({
          plugin: COMPUTER_USE_FILESYSTEM_PLUGIN,
          tool,
        });
      },
    );
    return [...new Set(toolCapabilities)];
  }

  setFeatureEnabled(enabled: boolean): void {
    if (this.featureEnabled === enabled) {
      return;
    }
    this.featureEnabled = enabled;
    this.reconcile();
    this.onChange();
  }

  setHostRuntimeOnline(online: boolean): void {
    if (this.hostRuntimeOnline === online) {
      return;
    }
    this.hostRuntimeOnline = online;
    this.reconcile();
    this.onChange();
  }

  setEnabled(enabled: boolean): void {
    if (this.preferences.enabled === enabled) {
      return;
    }
    this.preferences = { ...this.preferences, enabled };
    this.save();
    this.reconcile();
    this.onChange();
  }

  addAllowedDirectory(directory: string): void {
    const trimmed = directory.trim();
    if (!trimmed) {
      return;
    }
    if (this.preferences.allowedDirectories.includes(trimmed)) {
      return;
    }
    this.preferences = {
      ...this.preferences,
      allowedDirectories: [...this.preferences.allowedDirectories, trimmed],
    };
    this.save();
    this.reconcile();
    this.onChange();
  }

  removeAllowedDirectory(directory: string): void {
    const allowedDirectories = this.preferences.allowedDirectories.filter(
      (entry) => {
        return entry !== directory;
      },
    );
    if (
      allowedDirectories.length === this.preferences.allowedDirectories.length
    ) {
      return;
    }
    this.preferences = { ...this.preferences, allowedDirectories };
    this.save();
    this.reconcile();
    this.onChange();
  }

  async execute(
    command: ComputerUseCommand,
  ): Promise<ComputerUseCommandExecutionResult> {
    if (
      command.kind !== COMPUTER_USE_PLUGIN_CALL_KIND ||
      !isComputerUsePluginCallPayload(command.payload)
    ) {
      return commandFailure(
        "invalid_arguments",
        "Filesystem plugin command payload is invalid.",
      );
    }
    if (command.payload.plugin !== COMPUTER_USE_FILESYSTEM_PLUGIN) {
      return commandFailure(
        "unknown_plugin",
        `Unknown Computer Use plugin: ${command.payload.plugin}`,
      );
    }
    if (!isComputerUseFilesystemTool(command.payload.tool)) {
      return commandFailure(
        "unknown_tool",
        `Unknown filesystem plugin tool: ${command.payload.tool}`,
      );
    }
    if (!this.featureEnabled) {
      return commandFailure(
        "feature_disabled",
        "Computer Use Desktop plugins are disabled.",
      );
    }
    if (!this.preferences.enabled) {
      return commandFailure(
        "plugin_disabled",
        "Filesystem plugin is disabled.",
      );
    }
    if (this.preferences.allowedDirectories.length === 0) {
      return commandFailure(
        "plugin_disabled",
        "Filesystem plugin has no allowed directories.",
      );
    }
    if (this.status === "starting" || this.status === "restarting") {
      return commandFailure(
        "plugin_restarting",
        `Filesystem plugin is ${this.status}.`,
      );
    }
    if (this.status !== "running" || !this.runtime) {
      return commandFailure(
        "plugin_unavailable",
        "Filesystem plugin is unavailable.",
      );
    }
    if (!this.runtime.tools.has(command.payload.tool)) {
      return commandFailure(
        "unknown_tool",
        `Filesystem plugin tool is unavailable: ${command.payload.tool}`,
      );
    }

    let toolArguments: Record<string, unknown>;
    try {
      toolArguments = parseComputerUseFilesystemToolArguments(
        command.payload.tool,
        command.payload.arguments,
      );
    } catch (error) {
      return commandFailure("invalid_arguments", pluginErrorMessage(error));
    }

    try {
      const result = await this.runtime.client.callTool({
        name: command.payload.tool,
        arguments: toolArguments,
      });
      if (!("content" in result) || !Array.isArray(result.content)) {
        return commandFailure(
          "mcp_error",
          "Filesystem plugin returned an unsupported tool result.",
        );
      }
      return normalizePluginToolResult(
        {
          plugin: COMPUTER_USE_FILESYSTEM_PLUGIN,
          tool: command.payload.tool,
          mapErrorCode: filesystemFailureCode,
        },
        result as CallToolResult,
      );
    } catch (error) {
      const message = pluginErrorMessage(error);
      return commandFailure(filesystemFailureCode(message), message);
    }
  }

  stop(): void {
    this.cancelScheduledRestart();
    this.restartPolicy.reset();
    void this.stopRuntime();
  }

  private shouldRun(): boolean {
    return (
      this.featureEnabled &&
      this.hostRuntimeOnline &&
      this.preferences.enabled &&
      this.preferences.allowedDirectories.length > 0
    );
  }

  private reconcile(): void {
    this.cancelScheduledRestart();
    this.restartPolicy.reset();
    if (!this.shouldRun()) {
      void this.stopRuntime();
      return;
    }
    void this.restartRuntime();
  }

  private cancelScheduledRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private scheduleRestartOrFail(message: string): void {
    if (this.restartTimer) {
      return;
    }
    const delayMs = this.restartPolicy.nextDelayMs();
    if (delayMs === null) {
      this.status = "error";
      this.lastError = message;
      this.onChange();
      return;
    }
    this.status = "restarting";
    this.lastError = message;
    this.onChange();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartRuntime();
    }, delayMs);
  }

  private save(): void {
    writeFilesystemPluginPreferences(this.preferencesPath, this.preferences);
  }

  private async restartRuntime(): Promise<void> {
    await this.stopRuntime();
    if (this.startPromise) {
      return this.startPromise;
    }
    this.status = "starting";
    this.lastError = null;
    this.onChange();
    this.startPromise = this.startRuntime().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  private async startRuntime(): Promise<void> {
    let transport: StdioClientTransport | null = null;
    try {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [filesystemServerEntry(), ...this.preferences.allowedDirectories],
        env: {
          ...getDefaultEnvironment(),
          ELECTRON_RUN_AS_NODE: "1",
        },
        stderr: "pipe",
      });
      transport.onerror = (error) => {
        this.lastError = error.message;
        this.status = "error";
        this.onChange();
      };
      transport.onclose = () => {
        this.runtime = null;
        if (this.shouldRun()) {
          this.scheduleRestartOrFail("Filesystem plugin process exited.");
          return;
        }
        this.status = "disabled";
        this.lastError = null;
        this.onChange();
      };
      const client = new Client(
        {
          name: "okou-desktop-filesystem-plugin",
          version: COMPUTER_USE_FILESYSTEM_MCP_VERSION,
        },
        { capabilities: {} },
      );
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = new Set<ComputerUseFilesystemTool>();
      for (const tool of listed.tools) {
        if (isComputerUseFilesystemTool(tool.name)) {
          tools.add(tool.name);
        }
      }
      for (const tool of computerUseFilesystemToolNames) {
        if (!tools.has(tool)) {
          throw new Error(`Filesystem plugin missing required tool: ${tool}`);
        }
      }
      this.runtime = { client, transport, tools };
      this.status = "running";
      this.lastError = null;
      this.restartPolicy.notifyStarted();
      this.onChange();
    } catch (error) {
      this.runtime = null;
      if (transport) {
        transport.onclose = undefined;
        transport.onerror = undefined;
        try {
          await transport.close();
        } catch (closeError) {
          console.warn("Unable to close filesystem plugin process", closeError);
        }
      }
      if (this.shouldRun()) {
        this.scheduleRestartOrFail(pluginErrorMessage(error));
        return;
      }
      this.status = "error";
      this.lastError = pluginErrorMessage(error);
      this.onChange();
    }
  }

  private async stopRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    if (this.status !== "disabled") {
      this.status = "disabled";
      this.lastError = null;
      this.onChange();
    }
    if (!runtime) {
      return;
    }
    runtime.transport.onclose = undefined;
    runtime.transport.onerror = undefined;
    try {
      await runtime.client.close();
    } catch (error) {
      console.warn("Unable to close filesystem plugin client", error);
    }
    try {
      await runtime.transport.close();
    } catch (error) {
      console.warn("Unable to close filesystem plugin process", error);
    }
  }
}
