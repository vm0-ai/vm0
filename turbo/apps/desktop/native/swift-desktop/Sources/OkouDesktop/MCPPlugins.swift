import AppKit
import DesktopCore
import MCP
import System

@MainActor
final class MCPPlugins {
  @MainActor private final class Slot {
    let id = UUID()
    let configuration: JSON
    var client = Client(name: "okou-desktop-mcp-plugin", version: "1.0.0")
    var process: Process?
    var pipes: [Pipe] = []
    var start: Task<Void, Never>?
    var restart: Task<Void, Never>?
    var teardown: Task<Void, Never>?
    var health: Task<Void, Never>?
    var runtimeID = UUID()
    var attempts = 0
    var startedAt: Date?
    var status = "starting"
    var error: String?
    var tools: [MCP.Tool] = []
    init(configuration: JSON) { self.configuration = configuration }
  }
  private let preferences: DesktopPreferences
  private var slots: [String: Slot] = [:]
  private var retirements: [String: (id: UUID, task: Task<Void, Never>)] = [:]
  private var available = false
  private var online = false
  var onChange: @MainActor () -> Void = {}

  init(preferences: DesktopPreferences) { self.preferences = preferences }
  var configs: [String: JSON] {
    preferences.value["computerUsePlugins"]["mcp"]["servers"].object ?? [:]
  }
  var states: [JSON] {
    configs.keys.sorted().map { name in
      let slot = slots[name]
      return .object([
        "name": .string(name), "enabled": .bool(configs[name]?["enabled"].bool == true),
        "status": .string(slot?.status ?? "disabled"),
        "lastError": slot?.error.map(JSON.string) ?? .null,
        "tools": .strings(slot?.tools.map(\.name) ?? []),
      ])
    }
  }
  var capabilities: [String] {
    let running = slots.filter { $0.value.status == "running" }.keys
    return running.isEmpty ? [] : ["plugin.call"] + running.sorted().map { "plugin.mcp.\($0)" }
  }

  func setContext(available: Bool, online: Bool) {
    self.available = available
    self.online = online
    reconcile()
  }

  func importJSON(_ text: String) throws {
    let document = try JSON.decode(Data(text.utf8))
    guard let entries = document["mcpServers"].object ?? document.object, !entries.isEmpty else {
      throw DesktopFailure("invalid_arguments", "MCP configuration must contain servers")
    }
    var servers = configs
    for (name, input) in entries {
      guard name.range(of: "^[a-z0-9_-]{1,64}$", options: .regularExpression) != nil else {
        throw DesktopFailure("invalid_arguments", "MCP names must match [a-z0-9_-]{1,64}")
      }
      // Match the existing Desktop import contract before persisting: whitespace
      // around a command/URL is not part of its identity, and URL takes priority.
      if let url = input["url"].string?.trimmingCharacters(in: .whitespacesAndNewlines),
        !url.isEmpty
      {
        servers[name] = .object(["enabled": .bool(false), "url": .string(url)])
      } else if let command = input["command"].string?.trimmingCharacters(
        in: .whitespacesAndNewlines),
        !command.isEmpty
      {
        servers[name] = .object([
          "enabled": .bool(false), "command": .string(command),
          "args": .strings(input["args"].array.compactMap(\.string)),
          "env": .object((input["env"].object ?? [:]).filter { $0.value.string != nil }),
        ])
      } else {
        throw DesktopFailure("invalid_arguments", "MCP server \(name) needs command or url")
      }
    }
    try preferences.update { $0["computerUsePlugins"]["mcp"]["servers"] = .object(servers) }
    reconcile()
    onChange()
  }

  func setEnabled(_ name: String, _ enabled: Bool) throws {
    guard configs[name] != nil else { throw DesktopFailure("unknown_plugin", "Unknown MCP server") }
    try preferences.update {
      $0["computerUsePlugins"]["mcp"]["servers"][name]["enabled"] = .bool(enabled)
    }
    reconcile()
    onChange()
  }

  func remove(_ name: String) throws {
    var servers = configs
    servers.removeValue(forKey: name)
    try preferences.update { $0["computerUsePlugins"]["mcp"]["servers"] = .object(servers) }
    reconcile()
    onChange()
  }

  private func reconcile() {
    for (name, slot) in slots {
      if !available || !online || configs[name] != slot.configuration
        || configs[name]?["enabled"].bool != true
      {
        stop(name)
      }
    }
    guard available && online else { return }
    for (name, config) in configs where config["enabled"].bool && slots[name] == nil {
      let slot = Slot(configuration: config)
      slots[name] = slot
      slot.start = Task { [weak self] in await self?.connect(name: name, slot: slot) }
    }
  }

  private func connect(name: String, slot: Slot) async {
    guard !Task.isCancelled, slots[name]?.id == slot.id else { return }
    await retirements[name]?.task.value
    guard !Task.isCancelled, slots[name]?.id == slot.id else { return }
    slot.runtimeID = UUID()
    let runtimeID = slot.runtimeID
    let client = Client(name: "okou-desktop-mcp-plugin", version: "1.0.0")
    slot.client = client
    slot.tools = []
    slot.status = "starting"
    onChange()
    do {
      let transport: any Transport
      if let raw = slot.configuration["url"].string {
        guard let url = URL(string: raw), ["https", "http"].contains(url.scheme), url.host != nil
        else { throw DesktopFailure("invalid_arguments", "Invalid MCP HTTP URL") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        transport = HTTPClientTransport(endpoint: url, configuration: configuration)
      } else {
        transport = try await stdioTransport(name: name, slot: slot, runtimeID: runtimeID)
      }
      let timeout = Task {
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
        await client.disconnect()
      }
      defer { timeout.cancel() }
      _ = try await client.connect(transport: transport)
      slot.tools = try await listTools(client)
      guard slots[name]?.id == slot.id, slot.runtimeID == runtimeID, !Task.isCancelled else {
        await client.disconnect()
        return
      }
      slot.status = "running"
      slot.error = nil
      slot.startedAt = Date()
      slot.health = Task { [weak self] in
        while !Task.isCancelled {
          do {
            try await Task.sleep(for: .seconds(30))
            let deadline = Task {
              do { try await Task.sleep(for: .seconds(15)) } catch { return }
              await client.disconnect()
            }
            defer { deadline.cancel() }
            try await client.ping()
          } catch {
            guard !Task.isCancelled else { return }
            self?.failed(
              name: name, slot: slot, runtimeID: runtimeID, message: error.localizedDescription)
            return
          }
        }
      }
      onChange()
    } catch {
      failed(name: name, slot: slot, runtimeID: runtimeID, message: error.localizedDescription)
    }
  }

  private func stdioTransport(name: String, slot: Slot, runtimeID: UUID) async throws
    -> any Transport
  {
    let process = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    let command = try slot.configuration.requireString("command")
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [command] + slot.configuration["args"].array.compactMap(\.string)
    // launchd has a restricted PATH. Resolve the login shell's PATH
    // once per process launch, while explicit server env wins last.
    var environment = [
      "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
      "SHELL": ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
    ]
    if let path = slot.configuration["env"]["PATH"].string {
      environment["PATH"] = path
    } else {
      environment["PATH"] = try await loginShellPath()
    }
    try Task.checkCancellation()
    guard slots[name]?.id == slot.id else { throw CancellationError() }
    for (key, value) in slot.configuration["env"].object ?? [:] {
      if let value = value.string { environment[key] = value }
    }
    process.environment = environment
    process.standardInput = stdin
    process.standardOutput = stdout
    process.standardError = FileHandle.standardError
    let slotID = slot.id
    process.terminationHandler = { [weak self] process in
      let status = process.terminationStatus
      Task { @MainActor in
        guard let self, let current = self.slots[name], current.id == slotID else { return }
        self.failed(
          name: name, slot: current, runtimeID: runtimeID,
          message: "MCP process exited (\(status))")
      }
    }
    try process.run()
    slot.process = process
    slot.pipes = [stdin, stdout]
    return StdioTransport(
      input: FileDescriptor(rawValue: stdout.fileHandleForReading.fileDescriptor),
      output: FileDescriptor(rawValue: stdin.fileHandleForWriting.fileDescriptor))
  }

  private func listTools(_ client: Client) async throws -> [MCP.Tool] {
    var tools: [MCP.Tool] = []
    var cursor: String?
    var cursors: Set<String> = []
    repeat {
      let page = try await client.listTools(cursor: cursor)
      tools += page.tools
      cursor = page.nextCursor
      guard tools.count <= 10000, cursor == nil || cursors.insert(cursor!).inserted else {
        throw DesktopFailure(
          "result_too_large", "MCP server advertised too many tools or repeated its cursor")
      }
    } while cursor != nil
    return tools
  }

  private func failed(name: String, slot: Slot, runtimeID: UUID, message: String) {
    guard slots[name]?.id == slot.id, slot.runtimeID == runtimeID, slot.restart == nil else {
      return
    }
    slot.runtimeID = UUID()
    slot.health?.cancel()
    slot.health = nil
    beginTeardown(slot)
    if let started = slot.startedAt, Date().timeIntervalSince(started) >= 60 { slot.attempts = 0 }
    slot.startedAt = nil
    slot.error = message
    let delays: [Double] = [1, 5, 30]
    guard slot.attempts < delays.count else {
      slot.status = "error"
      onChange()
      return
    }
    let delay = delays[slot.attempts]
    slot.attempts += 1
    slot.status = "restarting"
    onChange()
    slot.restart = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(delay)) } catch { return }
      guard let self, self.slots[name]?.id == slot.id else { return }
      await slot.start?.value
      await slot.teardown?.value
      guard !Task.isCancelled, self.slots[name]?.id == slot.id else { return }
      slot.restart = nil
      slot.start = Task { await self.connect(name: name, slot: slot) }
    }
  }

  func execute(_ payload: JSON) async -> JSON {
    do {
      guard available else {
        throw DesktopFailure("feature_disabled", "Desktop plugins are disabled for this account")
      }
      let name = try payload.requireString("server")
      let tool = try payload.requireString("tool")
      guard configs[name] != nil else {
        throw DesktopFailure("unknown_plugin", "Unknown MCP server")
      }
      guard configs[name]?["enabled"].bool == true else {
        throw DesktopFailure("plugin_disabled", "MCP server is disabled")
      }
      if let slot = slots[name], ["starting", "restarting"].contains(slot.status) {
        throw DesktopFailure("plugin_restarting", "MCP server is restarting")
      }
      guard let slot = slots[name], slot.status == "running" else {
        throw DesktopFailure("plugin_unavailable", "MCP server is not running")
      }
      let context: JSON = .object([
        "plugin": .string("mcp"), "server": .string(name), "tool": .string(tool),
      ])
      let client = slot.client
      let runtimeID = slot.runtimeID
      let timeout = Task {
        do { try await Task.sleep(for: .seconds(60)) } catch { return }
        self.failed(name: name, slot: slot, runtimeID: runtimeID, message: "MCP request timed out")
        await client.disconnect()
      }
      defer { timeout.cancel() }
      if tool == "tools/list" || !slot.tools.contains(where: { $0.name == tool }) {
        slot.tools = try await listTools(client)
      }
      if tool == "tools/list" {
        let data = try JSONEncoder().encode(slot.tools)
        let value: JSON = .object(["server": .string(name), "tools": try JSON.decode(data)])
        return try PluginResult.text(value.text(pretty: true), context: context)
      }
      guard slot.tools.contains(where: { $0.name == tool }) else {
        throw DesktopFailure("unknown_tool", "MCP server does not advertise \(tool)")
      }
      let arguments = try JSONDecoder().decode(
        [String: MCP.Value].self,
        from: (payload["arguments"].object == nil ? JSON.object([:]) : payload["arguments"])
          .encoded())
      let result = try await client.callTool(name: tool, arguments: arguments)
      let content = try JSON.decode(JSONEncoder().encode(result.content))
      return try PluginResult.normalize(
        .object(["content": content, "isError": .bool(result.isError == true)]), context: context)
    } catch let failure as DesktopFailure { return failure.response } catch {
      return DesktopFailure("mcp_error", error.localizedDescription).response
    }
  }

  @discardableResult
  private func beginTeardown(_ slot: Slot) -> Task<Void, Never> {
    let previous = slot.teardown
    let process = slot.process
    process?.terminationHandler = nil
    slot.process = nil
    let pipes = slot.pipes
    slot.pipes = []
    let client = slot.client
    let teardown = Task {
      await previous?.value
      await client.disconnect()
      for pipe in pipes {
        pipe.fileHandleForWriting.closeFile()
        pipe.fileHandleForReading.closeFile()
      }
      if let process { await ProcessTermination.stop(process) }
    }
    slot.teardown = teardown
    return teardown
  }

  private func stop(_ name: String) {
    guard let slot = slots.removeValue(forKey: name) else { return }
    slot.runtimeID = UUID()
    slot.start?.cancel()
    slot.restart?.cancel()
    slot.health?.cancel()
    let teardown = beginTeardown(slot)
    let retirement = Task { [weak self] in
      await teardown.value
      await slot.start?.value
      await slot.restart?.value
      await slot.health?.value
      if self?.retirements[name]?.id == slot.id { self?.retirements.removeValue(forKey: name) }
    }
    retirements[name] = (slot.id, retirement)
  }

  func shutdown() { for name in Array(slots.keys) { stop(name) } }

  func shutdownAndWait() async {
    shutdown()
    for retirement in retirements.values { await retirement.task.value }
  }

  private func loginShellPath() async throws -> String {
    let mark = UUID().uuidString
    let data = try await ProcessCommand().run(
      ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
      ["-ilc", "printf '\(mark)%s\(mark)' \"$PATH\""], timeout: 10)
    let parts = String(decoding: data, as: UTF8.self).components(separatedBy: mark)
    guard parts.count >= 3, !parts[1].isEmpty else {
      throw DesktopFailure("mcp_environment", "The login shell did not return a PATH for MCP")
    }
    return parts[1]
  }
}
