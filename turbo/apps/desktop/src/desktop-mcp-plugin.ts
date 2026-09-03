import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  COMPUTER_USE_MCP_LIST_TOOLS,
  COMPUTER_USE_MCP_PLUGIN,
  COMPUTER_USE_MCP_SERVER_NAME_PATTERN,
  computerUseMcpServerCapability,
  isComputerUseMcpPluginCallPayload,
  type ComputerUseMcpPluginCallPayload,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import type {
  ComputerUseCommand,
  ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import type {
  DesktopComputerUseMcpPluginState,
  DesktopComputerUseMcpServerState,
  DesktopComputerUsePluginStatus,
} from "./computer-use-types";
import { PluginRestartPolicy } from "./desktop-plugin-restart-policy";
import { resolveLoginShellPath } from "./desktop-shell-env";
import {
  commandFailure,
  normalizePluginToolResult,
  pluginErrorMessage,
  pluginJsonResult,
} from "./desktop-plugin-tool-result";
import {
  readDesktopPreferenceRecord,
  writeDesktopPreferenceRecord,
} from "./desktop-preferences";

const PREFERENCES_KEY = "computerUsePlugins";
const MCP_KEY = "mcp";
const MCP_CLIENT_NAME = "okou-desktop-mcp-plugin";
const MCP_CLIENT_VERSION = "1.0.0";

interface McpStdioServerConfig {
  readonly enabled: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface McpHttpServerConfig {
  readonly enabled: boolean;
  readonly url: string;
}

type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

type McpServerConfigInput =
  | Omit<McpStdioServerConfig, "enabled">
  | Omit<McpHttpServerConfig, "enabled">;

interface McpPluginPreferences {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
}

interface McpServerRuntime {
  readonly client: Client;
  readonly transport: Transport;
  readonly tools: readonly string[];
}

interface McpServerSlot {
  status: DesktopComputerUsePluginStatus;
  lastError: string | null;
  runtime: McpServerRuntime | null;
  startPromise: Promise<void> | null;
  restartTimer: NodeJS.Timeout | null;
  readonly restartPolicy: PluginRestartPolicy;
}

interface DesktopMcpPluginManagerOptions {
  readonly preferencesPath: string;
  readonly onChange: () => void;
  readonly resolveShellPath?: () => Promise<string | null>;
}

const ENOENT_PATH_HINT =
  'Command not found on PATH. Set "env": {"PATH": "..."} in the server config or use an absolute command path.';

function withEnoentHint(message: string): string {
  return message.includes("ENOENT")
    ? `${message} — ${ENOENT_PATH_HINT}`
    : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpHttpServerConfig(
  config: McpServerConfig,
): config is McpHttpServerConfig {
  return "url" in config;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      record[key] = entry;
    }
  }
  return record;
}

function normalizeServerConfig(value: unknown): McpServerConfig | null {
  if (!isRecord(value)) {
    return null;
  }
  const enabled = value.enabled === true;
  if (typeof value.url === "string" && value.url.trim()) {
    return { enabled, url: value.url.trim() };
  }
  if (typeof value.command === "string" && value.command.trim()) {
    const args = Array.isArray(value.args)
      ? value.args.filter((entry): entry is string => {
          return typeof entry === "string";
        })
      : [];
    return {
      enabled,
      command: value.command.trim(),
      args,
      env: normalizeStringRecord(value.env),
    };
  }
  return null;
}

function readMcpPluginPreferences(
  preferencesPath: string,
): McpPluginPreferences {
  const preferences = readDesktopPreferenceRecord(preferencesPath);
  const plugins = preferences[PREFERENCES_KEY];
  const mcp = isRecord(plugins) ? plugins[MCP_KEY] : null;
  const rawServers = isRecord(mcp) ? mcp.servers : null;
  if (!isRecord(rawServers)) {
    return { servers: {} };
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(rawServers)) {
    if (!COMPUTER_USE_MCP_SERVER_NAME_PATTERN.test(name)) {
      continue;
    }
    const config = normalizeServerConfig(entry);
    if (config) {
      servers[name] = config;
    }
  }
  return { servers };
}

function writeMcpPluginPreferences(
  preferencesPath: string,
  mcp: McpPluginPreferences,
): void {
  const preferences = readDesktopPreferenceRecord(preferencesPath);
  const plugins = isRecord(preferences[PREFERENCES_KEY])
    ? preferences[PREFERENCES_KEY]
    : {};
  writeDesktopPreferenceRecord(preferencesPath, {
    ...preferences,
    [PREFERENCES_KEY]: {
      ...plugins,
      [MCP_KEY]: { servers: mcp.servers },
    },
  });
}

/**
 * Parses a user-pasted MCP server configuration document. Accepts the
 * community `{"mcpServers": {...}}` format (Claude Desktop / Cursor style) or
 * a bare name-to-config map. Throws with a readable message on invalid input.
 */
export function parseMcpServersJson(
  json: string,
): Readonly<Record<string, McpServerConfigInput>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("MCP server configuration is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("MCP server configuration must be a JSON object");
  }
  const entries = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  if (!isRecord(entries) || Object.keys(entries).length === 0) {
    throw new Error("MCP server configuration contains no servers");
  }
  const servers: Record<string, McpServerConfigInput> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (!COMPUTER_USE_MCP_SERVER_NAME_PATTERN.test(name)) {
      throw new Error(
        `MCP server name "${name}" is invalid: names must match [a-z0-9_-]{1,64}`,
      );
    }
    const config = normalizeServerConfig(
      isRecord(entry) ? { ...entry, enabled: false } : entry,
    );
    if (!config) {
      throw new Error(
        `MCP server "${name}" must declare either "command" (stdio) or "url" (Streamable HTTP)`,
      );
    }
    servers[name] = isMcpHttpServerConfig(config)
      ? { url: config.url }
      : { command: config.command, args: config.args, env: config.env };
  }
  return servers;
}

export class DesktopMcpPluginManager {
  private readonly preferencesPath: string;
  private readonly onChange: () => void;
  private preferences: McpPluginPreferences = { servers: {} };
  private featureEnabled = false;
  private hostRuntimeOnline = false;
  private readonly slots = new Map<string, McpServerSlot>();
  private readonly resolveShellPath: () => Promise<string | null>;
  private shellPathPromise: Promise<string | null> | null = null;

  constructor(options: DesktopMcpPluginManagerOptions) {
    this.preferencesPath = options.preferencesPath;
    this.onChange = options.onChange;
    this.resolveShellPath = options.resolveShellPath ?? resolveLoginShellPath;
  }

  private loginShellPath(): Promise<string | null> {
    this.shellPathPromise ??= this.resolveShellPath().catch(() => {
      return null;
    });
    return this.shellPathPromise;
  }

  load(): void {
    this.preferences = readMcpPluginPreferences(this.preferencesPath);
    this.reconcile();
  }

  getState(): DesktopComputerUseMcpPluginState {
    const servers: DesktopComputerUseMcpServerState[] = Object.entries(
      this.preferences.servers,
    ).map(([name, config]) => {
      const slot = this.slots.get(name);
      return {
        name,
        transport: isMcpHttpServerConfig(config) ? "http" : "stdio",
        enabled: config.enabled,
        status: slot?.status ?? "disabled",
        lastError: slot?.lastError ?? null,
        tools: slot?.runtime?.tools ?? [],
      };
    });
    return { featureEnabled: this.featureEnabled, servers };
  }

  getCapabilities(): readonly string[] {
    const capabilities: string[] = [];
    for (const [name, slot] of this.slots) {
      if (slot.status === "running") {
        capabilities.push(computerUseMcpServerCapability(name));
      }
    }
    return capabilities;
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

  importServersJson(json: string): void {
    const imported = parseMcpServersJson(json);
    const servers: Record<string, McpServerConfig> = {
      ...this.preferences.servers,
    };
    for (const [name, config] of Object.entries(imported)) {
      servers[name] = {
        ...config,
        enabled: this.preferences.servers[name]?.enabled ?? false,
      };
    }
    this.preferences = { servers };
    this.save();
    this.reconcile();
    this.onChange();
  }

  setServerEnabled(name: string, enabled: boolean): void {
    const config = this.preferences.servers[name];
    if (!config || config.enabled === enabled) {
      return;
    }
    this.preferences = {
      servers: { ...this.preferences.servers, [name]: { ...config, enabled } },
    };
    this.save();
    this.reconcile();
    this.onChange();
  }

  removeServer(name: string): void {
    if (!this.preferences.servers[name]) {
      return;
    }
    const servers = { ...this.preferences.servers };
    delete servers[name];
    this.preferences = { servers };
    this.save();
    this.reconcile();
    this.onChange();
  }

  async execute(
    command: ComputerUseCommand,
  ): Promise<ComputerUseCommandExecutionResult> {
    if (!isComputerUseMcpPluginCallPayload(command.payload)) {
      return commandFailure(
        "invalid_arguments",
        "MCP plugin command payload is invalid.",
      );
    }
    const payload = command.payload;
    if (!this.featureEnabled) {
      return commandFailure(
        "feature_disabled",
        "Computer Use Desktop plugins are disabled.",
      );
    }
    const config = this.preferences.servers[payload.server];
    if (!config) {
      return commandFailure(
        "plugin_unavailable",
        `MCP server is not configured on this host: ${payload.server}`,
      );
    }
    if (!config.enabled) {
      return commandFailure(
        "plugin_disabled",
        `MCP server is disabled: ${payload.server}`,
      );
    }
    const slot = this.slots.get(payload.server);
    if (slot && (slot.status === "starting" || slot.status === "restarting")) {
      return commandFailure(
        "plugin_restarting",
        `MCP server is ${slot.status}: ${payload.server}`,
      );
    }
    if (!slot || slot.status !== "running" || !slot.runtime) {
      return commandFailure(
        "plugin_unavailable",
        `MCP server is unavailable: ${payload.server}${
          slot?.lastError ? ` (${slot.lastError})` : ""
        }`,
      );
    }
    if (payload.tool === COMPUTER_USE_MCP_LIST_TOOLS) {
      return this.executeListTools(payload, slot.runtime);
    }
    return this.executeToolCall(payload, slot.runtime);
  }

  stop(): void {
    for (const [name, slot] of this.slots) {
      this.cancelScheduledRestart(slot);
      slot.restartPolicy.reset();
      void this.stopSlotRuntime(name, slot);
    }
  }

  private async executeListTools(
    payload: ComputerUseMcpPluginCallPayload,
    runtime: McpServerRuntime,
  ): Promise<ComputerUseCommandExecutionResult> {
    try {
      const listed = await runtime.client.listTools();
      return pluginJsonResult(
        {
          plugin: COMPUTER_USE_MCP_PLUGIN,
          server: payload.server,
          tool: payload.tool,
        },
        {
          server: payload.server,
          tools: listed.tools.map((tool) => {
            return {
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema,
            };
          }),
        },
      );
    } catch (error) {
      return commandFailure("mcp_error", pluginErrorMessage(error));
    }
  }

  private async executeToolCall(
    payload: ComputerUseMcpPluginCallPayload,
    runtime: McpServerRuntime,
  ): Promise<ComputerUseCommandExecutionResult> {
    try {
      if (!runtime.tools.includes(payload.tool)) {
        const listed = await runtime.client.listTools();
        const live = listed.tools.some((tool) => {
          return tool.name === payload.tool;
        });
        if (!live) {
          return commandFailure(
            "unknown_tool",
            `MCP server ${payload.server} does not expose tool: ${payload.tool}`,
          );
        }
      }
      const result = await runtime.client.callTool({
        name: payload.tool,
        arguments: payload.arguments,
      });
      if (!("content" in result) || !Array.isArray(result.content)) {
        return commandFailure(
          "mcp_error",
          `MCP server ${payload.server} returned an unsupported tool result.`,
        );
      }
      return normalizePluginToolResult(
        {
          plugin: COMPUTER_USE_MCP_PLUGIN,
          server: payload.server,
          tool: payload.tool,
        },
        result as CallToolResult,
      );
    } catch (error) {
      return commandFailure("mcp_error", pluginErrorMessage(error));
    }
  }

  private serverShouldRun(config: McpServerConfig | undefined): boolean {
    return Boolean(
      this.featureEnabled && this.hostRuntimeOnline && config && config.enabled,
    );
  }

  private ensureSlot(name: string): McpServerSlot {
    const existing = this.slots.get(name);
    if (existing) {
      return existing;
    }
    const slot: McpServerSlot = {
      status: "disabled",
      lastError: null,
      runtime: null,
      startPromise: null,
      restartTimer: null,
      restartPolicy: new PluginRestartPolicy(),
    };
    this.slots.set(name, slot);
    return slot;
  }

  private reconcile(): void {
    for (const [name, slot] of this.slots) {
      this.cancelScheduledRestart(slot);
      slot.restartPolicy.reset();
      if (!this.preferences.servers[name]) {
        void this.stopSlotRuntime(name, slot);
        this.slots.delete(name);
      }
    }
    for (const [name, config] of Object.entries(this.preferences.servers)) {
      const slot = this.ensureSlot(name);
      if (!this.serverShouldRun(config)) {
        void this.stopSlotRuntime(name, slot);
        continue;
      }
      void this.restartSlotRuntime(name, slot);
    }
  }

  private save(): void {
    writeMcpPluginPreferences(this.preferencesPath, this.preferences);
  }

  private cancelScheduledRestart(slot: McpServerSlot): void {
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
    }
  }

  private scheduleRestartOrFail(
    name: string,
    slot: McpServerSlot,
    message: string,
  ): void {
    if (slot.restartTimer) {
      return;
    }
    const delayMs = slot.restartPolicy.nextDelayMs();
    if (delayMs === null) {
      slot.status = "error";
      slot.lastError = message;
      this.onChange();
      return;
    }
    slot.status = "restarting";
    slot.lastError = message;
    this.onChange();
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      void this.restartSlotRuntime(name, slot);
    }, delayMs);
  }

  private async restartSlotRuntime(
    name: string,
    slot: McpServerSlot,
  ): Promise<void> {
    await this.stopSlotRuntime(name, slot);
    if (slot.startPromise) {
      return slot.startPromise;
    }
    slot.status = "starting";
    slot.lastError = null;
    this.onChange();
    slot.startPromise = this.startSlotRuntime(name, slot).finally(() => {
      slot.startPromise = null;
    });
    await slot.startPromise;
  }

  private async createTransport(config: McpServerConfig): Promise<Transport> {
    if (isMcpHttpServerConfig(config)) {
      return new StreamableHTTPClientTransport(new URL(config.url));
    }
    const shellPath = await this.loginShellPath();
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: {
        ...getDefaultEnvironment(),
        ...(shellPath ? { PATH: shellPath } : {}),
        ...config.env,
      },
      stderr: "pipe",
    });
  }

  private async startSlotRuntime(
    name: string,
    slot: McpServerSlot,
  ): Promise<void> {
    let transport: Transport | null = null;
    try {
      const config = this.preferences.servers[name];
      if (!this.serverShouldRun(config) || !config) {
        slot.status = "disabled";
        slot.lastError = null;
        this.onChange();
        return;
      }
      transport = await this.createTransport(config);
      transport.onerror = (error) => {
        slot.lastError = error.message;
        this.onChange();
      };
      transport.onclose = () => {
        slot.runtime = null;
        if (this.serverShouldRun(this.preferences.servers[name])) {
          this.scheduleRestartOrFail(
            name,
            slot,
            `MCP server process exited: ${name}`,
          );
          return;
        }
        slot.status = "disabled";
        slot.lastError = null;
        this.onChange();
      };
      const client = new Client(
        { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
        { capabilities: {} },
      );
      await client.connect(transport);
      const listed = await client.listTools();
      slot.runtime = {
        client,
        transport,
        tools: listed.tools.map((tool) => {
          return tool.name;
        }),
      };
      slot.status = "running";
      slot.lastError = null;
      slot.restartPolicy.notifyStarted();
      this.onChange();
    } catch (error) {
      slot.runtime = null;
      if (transport) {
        transport.onclose = undefined;
        transport.onerror = undefined;
        try {
          await transport.close();
        } catch (closeError) {
          console.warn("Unable to close MCP server", name, closeError);
        }
      }
      if (this.serverShouldRun(this.preferences.servers[name])) {
        this.scheduleRestartOrFail(
          name,
          slot,
          withEnoentHint(pluginErrorMessage(error)),
        );
        return;
      }
      slot.status = "error";
      slot.lastError = withEnoentHint(pluginErrorMessage(error));
      this.onChange();
    }
  }

  private async stopSlotRuntime(
    name: string,
    slot: McpServerSlot,
  ): Promise<void> {
    const runtime = slot.runtime;
    slot.runtime = null;
    if (slot.status !== "disabled") {
      slot.status = "disabled";
      slot.lastError = null;
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
      console.warn("Unable to close MCP client", name, error);
    }
    try {
      await runtime.transport.close();
    } catch (error) {
      console.warn("Unable to close MCP server", name, error);
    }
  }
}
