import Foundation

public enum McpServerConfig: Equatable, Sendable {
    case stdio(enabled: Bool, command: String, args: [String], env: [String: String])
    case http(enabled: Bool, url: String)

    public var enabled: Bool {
        switch self {
        case let .stdio(enabled, _, _, _): return enabled
        case let .http(enabled, _): return enabled
        }
    }

    public var transport: DesktopComputerUseMcpTransport {
        if case .http = self { return .http }
        return .stdio
    }

    public func withEnabled(_ value: Bool) -> McpServerConfig {
        switch self {
        case let .stdio(_, command, args, env): return .stdio(enabled: value, command: command, args: args, env: env)
        case let .http(_, url): return .http(enabled: value, url: url)
        }
    }

    public var json: JSONValue {
        switch self {
        case let .stdio(enabled, command, args, env):
            return .object([
                "enabled": .bool(enabled), "command": .string(command), "args": .array(args.map(JSONValue.string)),
                "env": .object(env.mapValues(JSONValue.string)),
            ])
        case let .http(enabled, url):
            return .object(["enabled": .bool(enabled), "url": .string(url)])
        }
    }

    /// Port of `normalizeServerConfig`: a `url` wins over `command`.
    public static func parse(_ value: JSONValue) -> McpServerConfig? {
        guard let object = value.objectValue else { return nil }
        let enabled = object["enabled"]?.boolValue == true
        if let url = object["url"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty {
            return .http(enabled: enabled, url: url)
        }
        if let command = object["command"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !command.isEmpty {
            let args = object["args"]?.arrayValue?.compactMap(\.stringValue) ?? []
            var env: [String: String] = [:]
            for (key, entry) in object["env"]?.objectValue ?? [:] {
                if let string = entry.stringValue { env[key] = string }
            }
            return .stdio(enabled: enabled, command: command, args: args, env: env)
        }
        return nil
    }
}

public enum McpServersJson {
    public static let namePattern = #/^[a-z0-9_-]{1,64}$/#

    public static func isValidName(_ name: String) -> Bool {
        name.firstMatch(of: namePattern) != nil
    }

    /// Parses a pasted configuration: `{"mcpServers": {...}}` or a bare map.
    /// Imported servers are never enabled by this step.
    public static func parse(_ json: String) throws -> [String: McpServerConfig] {
        let parsed: JSONValue
        do {
            parsed = try JSONValue.parse(json)
        } catch {
            throw McpError("MCP server configuration is not valid JSON")
        }
        guard let root = parsed.objectValue else {
            throw McpError("MCP server configuration must be a JSON object")
        }
        let entries = root["mcpServers"]?.objectValue ?? root
        guard !entries.isEmpty else {
            throw McpError("MCP server configuration contains no servers")
        }
        var servers: [String: McpServerConfig] = [:]
        for name in entries.keys.sorted() {
            guard isValidName(name) else {
                throw McpError("MCP server name \"\(name)\" is invalid: names must match [a-z0-9_-]{1,64}")
            }
            guard let config = McpServerConfig.parse(entries[name]!) else {
                throw McpError("MCP server \"\(name)\" must declare either \"command\" (stdio) or \"url\" (Streamable HTTP)")
            }
            servers[name] = config.withEnabled(false)
        }
        return servers
    }
}

/// Port of `DesktopMcpPluginManager`: one slot per configured server with
/// its own restart policy, the feature and host gates, and the failure
/// ladder for `plugin.call` commands addressed to `mcp`.
@MainActor
public final class DesktopMcpPluginManager {
    public static let pluginName = "mcp"
    public static let listToolsTool = "tools/list"
    public static let clientName = "okou-desktop-mcp-plugin"
    public static let clientVersion = "1.0.0"
    public static let preferencesKey = "computerUsePlugins"
    public static let mcpKey = "mcp"
    static let enoentHint = "Command not found on PATH. Set \"env\": {\"PATH\": \"...\"} in the server config or use an absolute command path."

    final class Slot {
        var status: DesktopComputerUsePluginStatus = .disabled
        var lastError: String? = nil
        var client: McpClient? = nil
        var tools: [String] = []
        var startTask: Task<Void, Never>? = nil
        var restartTask: Task<Void, Never>? = nil
        let restartPolicy = PluginRestartPolicy()
    }

    private let store: DesktopPreferencesStore
    private let onChange: () -> Void
    private let createTransport: (McpServerConfig, String?) -> McpTransport
    private let resolveShellPath: () async -> String?
    private let sleep: (Double) async -> Void
    private var servers: [String: McpServerConfig] = [:]
    private var slots: [String: Slot] = [:]
    private var featureEnabled = false
    private var hostRuntimeOnline = false
    private var shellPathTask: Task<String?, Never>? = nil

    public init(
        store: DesktopPreferencesStore,
        onChange: @escaping () -> Void,
        resolveShellPath: @escaping () async -> String? = { await LoginShellPath.resolve() },
        createTransport: ((McpServerConfig, String?) -> McpTransport)? = nil,
        sleep: @escaping (Double) async -> Void = { ms in try? await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000)) }
    ) {
        self.store = store
        self.onChange = onChange
        self.resolveShellPath = resolveShellPath
        self.sleep = sleep
        self.createTransport = createTransport ?? { config, shellPath in
            switch config {
            case let .http(_, url):
                return McpStreamableHTTPTransport(url: URL(string: url) ?? URL(fileURLWithPath: "/"))
            case let .stdio(_, command, args, env):
                var environment = McpDefaultEnvironment.environment()
                if let shellPath { environment["PATH"] = shellPath }
                for (key, value) in env { environment[key] = value }
                return McpStdioTransport(command: command, arguments: args, environment: environment)
            }
        }
    }

    static func withEnoentHint(_ message: String) -> String {
        message.contains("ENOENT") ? "\(message) — \(enoentHint)" : message
    }

    private func loginShellPath() async -> String? {
        if let shellPathTask { return await shellPathTask.value }
        let task = Task { await resolveShellPath() }
        shellPathTask = task
        return await task.value
    }

    public func load() {
        let record = (try? store.read()) ?? [:]
        var parsed: [String: McpServerConfig] = [:]
        for (name, entry) in record[Self.preferencesKey]?[Self.mcpKey]?["servers"]?.objectValue ?? [:] {
            guard McpServersJson.isValidName(name), let config = McpServerConfig.parse(entry) else { continue }
            parsed[name] = config
        }
        servers = parsed
        reconcile()
    }

    public var state: DesktopComputerUseMcpPluginState {
        let entries = servers.keys.sorted().map { name -> DesktopComputerUseMcpServerState in
            let config = servers[name]!
            let slot = slots[name]
            return DesktopComputerUseMcpServerState(
                name: name, transport: config.transport, enabled: config.enabled, status: slot?.status ?? .disabled,
                lastError: slot?.lastError, tools: slot?.tools ?? []
            )
        }
        return DesktopComputerUseMcpPluginState(featureEnabled: featureEnabled, servers: entries)
    }

    public var capabilities: [String] {
        slots.filter { $0.value.status == .running }.keys.sorted().map { "plugin.\(Self.pluginName).\($0)" }
    }

    public func setFeatureEnabled(_ value: Bool) {
        guard featureEnabled != value else { return }
        featureEnabled = value
        reconcile()
        onChange()
    }

    public func setHostRuntimeOnline(_ value: Bool) {
        guard hostRuntimeOnline != value else { return }
        hostRuntimeOnline = value
        reconcile()
        onChange()
    }

    public func importServersJson(_ json: String) throws {
        let imported = try McpServersJson.parse(json)
        for (name, config) in imported {
            servers[name] = config.withEnabled(servers[name]?.enabled ?? false)
        }
        try save()
        reconcile()
        onChange()
    }

    public func setServerEnabled(_ name: String, _ enabled: Bool) throws {
        guard let config = servers[name], config.enabled != enabled else { return }
        servers[name] = config.withEnabled(enabled)
        try save()
        reconcile()
        onChange()
    }

    public func removeServer(_ name: String) throws {
        guard servers.removeValue(forKey: name) != nil else { return }
        try save()
        reconcile()
        onChange()
    }

    private func save() throws {
        let servers = self.servers
        try store.update { record in
            var plugins = record[Self.preferencesKey]?.objectValue ?? [:]
            plugins[Self.mcpKey] = .object(["servers": .object(servers.mapValues(\.json))])
            record[Self.preferencesKey] = .object(plugins)
        }
    }

    public static func isMcpCallPayload(_ payload: [String: JSONValue]) -> Bool {
        payload["plugin"]?.stringValue == pluginName && payload["server"]?.stringValue != nil && payload["tool"]?.stringValue != nil
    }

    public func execute(_ command: ComputerUseCommand) async -> ComputerUseCommandExecutionResult {
        let payload = command.payload
        guard command.kind == ComputerUseCapabilities.pluginCallKind, Self.isMcpCallPayload(payload),
            let server = payload["server"]?.stringValue, McpServersJson.isValidName(server),
            let tool = payload["tool"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !tool.isEmpty, tool.count <= 256,
            payload["arguments"] == nil || payload["arguments"]?.objectValue != nil
        else {
            return .failure(.invalidArguments, "MCP plugin command payload is invalid.")
        }
        guard featureEnabled else {
            return .failure(.featureDisabled, "Computer Use Desktop plugins are disabled.")
        }
        guard let config = servers[server] else {
            return .failure(.pluginUnavailable, "MCP server is not configured on this host: \(server)")
        }
        guard config.enabled else {
            return .failure(.pluginDisabled, "MCP server is disabled: \(server)")
        }
        let slot = slots[server]
        if let slot, slot.status == .starting || slot.status == .restarting {
            return .failure(.pluginRestarting, "MCP server is \(slot.status.rawValue): \(server)")
        }
        guard let slot, slot.status == .running, let client = slot.client else {
            let detail = slot?.lastError.map { " (\($0))" } ?? ""
            return .failure(.pluginUnavailable, "MCP server is unavailable: \(server)\(detail)")
        }
        let arguments = payload["arguments"]?.objectValue ?? [:]
        let context = PluginToolResultContext(plugin: Self.pluginName, tool: tool, server: server)
        do {
            if tool == Self.listToolsTool {
                let tools = try await client.listTools()
                return PluginToolResults.jsonResult(context, value: .object(["server": .string(server), "tools": .array(tools.map(\.json))]))
            }
            if !slot.tools.contains(tool) {
                let live = try await client.listTools()
                guard live.contains(where: { $0.name == tool }) else {
                    return .failure(.unknownTool, "MCP server \(server) does not expose tool: \(tool)")
                }
            }
            let timeoutMs = payload["timeoutMs"]?.doubleValue.map { min(max($0, 1_000), 120_000) } ?? McpClient.requestTimeoutMs
            let result = try await client.callTool(name: tool, arguments: arguments, timeoutMs: timeoutMs)
            return PluginToolResults.normalize(context, result: result)
        } catch {
            return .failure(.mcpError, String(describing: error))
        }
    }

    public func stop() {
        for (name, slot) in slots {
            slot.restartTask?.cancel()
            slot.restartTask = nil
            slot.restartPolicy.reset()
            Task { await self.stopSlotRuntime(name, slot) }
        }
    }

    // MARK: Runtime

    private func serverShouldRun(_ config: McpServerConfig?) -> Bool {
        featureEnabled && hostRuntimeOnline && (config?.enabled ?? false)
    }

    private func ensureSlot(_ name: String) -> Slot {
        if let slot = slots[name] { return slot }
        let slot = Slot()
        slots[name] = slot
        return slot
    }

    private func reconcile() {
        for (name, slot) in slots {
            slot.restartTask?.cancel()
            slot.restartTask = nil
            slot.restartPolicy.reset()
            if servers[name] == nil {
                slots.removeValue(forKey: name)
                Task { await self.stopSlotRuntime(name, slot) }
            }
        }
        for name in servers.keys.sorted() {
            let slot = ensureSlot(name)
            if !serverShouldRun(servers[name]) {
                Task { await self.stopSlotRuntime(name, slot) }
                continue
            }
            Task { await self.restartSlotRuntime(name, slot) }
        }
    }

    private func scheduleRestartOrFail(_ name: String, _ slot: Slot, message: String) {
        guard slot.restartTask == nil else { return }
        guard let delayMs = slot.restartPolicy.nextDelayMs() else {
            slot.status = .error
            slot.lastError = message
            onChange()
            return
        }
        slot.status = .restarting
        slot.lastError = message
        onChange()
        let sleep = self.sleep
        slot.restartTask = Task { @MainActor [weak self, weak slot] in
            await sleep(delayMs)
            guard !Task.isCancelled, let self, let slot else { return }
            slot.restartTask = nil
            await self.restartSlotRuntime(name, slot)
        }
    }

    private func restartSlotRuntime(_ name: String, _ slot: Slot) async {
        await stopSlotRuntime(name, slot)
        if let startTask = slot.startTask {
            await startTask.value
            return
        }
        slot.status = .starting
        slot.lastError = nil
        onChange()
        let task = Task { @MainActor in await self.startSlotRuntime(name, slot) }
        slot.startTask = task
        await task.value
        slot.startTask = nil
    }

    private func startSlotRuntime(_ name: String, _ slot: Slot) async {
        guard let config = servers[name], serverShouldRun(config) else {
            slot.status = .disabled
            slot.lastError = nil
            onChange()
            return
        }
        let shellPath: String? = config.transport == .stdio ? await loginShellPath() : nil
        let transport = createTransport(config, shellPath)
        let client = McpClient(transport: transport, clientName: Self.clientName, clientVersion: Self.clientVersion)
        do {
            try await client.connect()
            let tools = try await client.listTools()
            transport.onClose = { [weak self, weak slot] in
                Task { @MainActor in
                    guard let self, let slot else { return }
                    slot.client = nil
                    slot.tools = []
                    if self.serverShouldRun(self.servers[name]) {
                        self.scheduleRestartOrFail(name, slot, message: "MCP server process exited: \(name)")
                    } else {
                        slot.status = .disabled
                        slot.lastError = nil
                        self.onChange()
                    }
                }
            }
            transport.onError = { [weak self, weak slot] error in
                Task { @MainActor in
                    slot?.lastError = String(describing: error)
                    self?.onChange()
                }
            }
            slot.client = client
            slot.tools = tools.map(\.name)
            slot.status = .running
            slot.lastError = nil
            slot.restartPolicy.notifyStarted()
            onChange()
        } catch {
            transport.onClose = nil
            transport.onError = nil
            await client.close()
            slot.client = nil
            slot.tools = []
            let message = Self.withEnoentHint(String(describing: error))
            if serverShouldRun(servers[name]) {
                scheduleRestartOrFail(name, slot, message: message)
                return
            }
            slot.status = .error
            slot.lastError = message
            onChange()
        }
    }

    private func stopSlotRuntime(_ name: String, _ slot: Slot) async {
        let client = slot.client
        slot.client = nil
        slot.tools = []
        if slot.status != .disabled {
            slot.status = .disabled
            slot.lastError = nil
            onChange()
        }
        guard let client else { return }
        client.transport.onClose = nil
        client.transport.onError = nil
        await client.close()
    }
}
