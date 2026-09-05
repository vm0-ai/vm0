import AppKit
import DesktopCore
import MCP
import System

@MainActor
final class MCPPlugins {
  @MainActor private final class Slot {
    let id = UUID()
    let configuration: JSON
    let client = Client(name: "okou-desktop-mcp-plugin", version: "1.0.0")
    var process: Process?
    var pipes: [Pipe] = []
    var start: Task<Void, Never>?
    var status = "starting"
    var error: String?
    var tools: [MCP.Tool] = []
    init(configuration: JSON) { self.configuration = configuration }
  }
  private let preferences: DesktopPreferences
  private var slots: [String: Slot] = [:]
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
      guard input["command"].string?.isEmpty == false || input["url"].string?.isEmpty == false
      else { throw DesktopFailure("invalid_arguments", "MCP server \(name) needs command or url") }
      var config = input
      config["enabled"] = .bool(false)
      servers[name] = config
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
    do {
      let transport: any Transport
      if let raw = slot.configuration["url"].string {
        guard let url = URL(string: raw), ["https", "http"].contains(url.scheme), url.host != nil
        else { throw DesktopFailure("invalid_arguments", "Invalid MCP HTTP URL") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        transport = HTTPClientTransport(endpoint: url, configuration: configuration)
      } else {
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
        if let path = try await loginShellPath() { environment["PATH"] = path }
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
            current.status = "error"
            current.error = "MCP process exited (\(status))"
            self.onChange()
          }
        }
        try process.run()
        slot.process = process
        slot.pipes = [stdin, stdout]
        transport = StdioTransport(
          input: FileDescriptor(rawValue: stdout.fileHandleForReading.fileDescriptor),
          output: FileDescriptor(rawValue: stdin.fileHandleForWriting.fileDescriptor))
      }
      let timeout = Task {
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
        await slot.client.disconnect()
      }
      defer { timeout.cancel() }
      _ = try await slot.client.connect(transport: transport)
      var cursor: String?
      repeat {
        let page = try await slot.client.listTools(cursor: cursor)
        slot.tools += page.tools
        cursor = page.nextCursor
        guard slot.tools.count <= 10000 else {
          throw DesktopFailure("result_too_large", "MCP server advertised too many tools")
        }
      } while cursor != nil
      guard slots[name]?.id == slot.id, !Task.isCancelled else {
        await slot.client.disconnect()
        return
      }
      slot.status = "running"
      slot.error = nil
      onChange()
    } catch {
      guard slots[name]?.id == slot.id else { return }
      slot.status = "error"
      slot.error = error.localizedDescription
      if let process = slot.process, process.isRunning { process.terminate() }
      onChange()
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
      guard let slot = slots[name], slot.status == "running" else {
        throw DesktopFailure("plugin_unavailable", "MCP server is not running")
      }
      let context: JSON = .object([
        "plugin": .string("mcp"), "server": .string(name), "tool": .string(tool),
      ])
      if tool == "tools/list" {
        let data = try JSONEncoder().encode(slot.tools)
        return try PluginResult.text(JSON.decode(data).text(pretty: true), context: context)
      }
      guard slot.tools.contains(where: { $0.name == tool }) else {
        throw DesktopFailure("unknown_tool", "MCP server does not advertise \(tool)")
      }
      let arguments = try JSONDecoder().decode(
        [String: MCP.Value].self, from: payload["arguments"].encoded())
      let timeout = Task {
        do { try await Task.sleep(for: .seconds(60)) } catch { return }
        await slot.client.disconnect()
      }
      defer { timeout.cancel() }
      let result = try await slot.client.callTool(name: tool, arguments: arguments)
      let content = try JSON.decode(JSONEncoder().encode(result.content))
      return try PluginResult.normalize(
        .object(["content": content, "isError": .bool(result.isError == true)]), context: context)
    } catch let failure as DesktopFailure { return failure.response } catch {
      return DesktopFailure("mcp_error", error.localizedDescription).response
    }
  }

  private func stop(_ name: String) {
    guard let slot = slots.removeValue(forKey: name) else { return }
    slot.start?.cancel()
    slot.process?.terminationHandler = nil
    if let process = slot.process, process.isRunning { process.terminate() }
    Task { await slot.client.disconnect() }
  }

  func shutdown() { for name in Array(slots.keys) { stop(name) } }

  private func loginShellPath() async throws -> String? {
    let mark = UUID().uuidString
    let data = try await ProcessCommand().run(
      ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
      ["-ilc", "printf '\(mark)%s\(mark)' \"$PATH\""], timeout: 10)
    let parts = String(decoding: data, as: UTF8.self).components(separatedBy: mark)
    return parts.count >= 3 ? parts[1] : nil
  }
}
