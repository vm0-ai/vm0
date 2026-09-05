import AppKit
import DesktopCore
import IOKit.pwr_mgt
import Sentry

@MainActor
final class DesktopModel: ObservableObject {
  let configuration: DesktopConfiguration
  let preferences: DesktopPreferences
  let api: DesktopAPI
  let auth: DesktopAuth
  let helper: HelperProcess
  let host: HostRuntime
  let mcp: MCPPlugins
  let recorder: ScreenRecorder
  let areaSelector = AreaSelector()
  @Published var error: String?
  @Published var pluginsAvailable = false
  @Published var debugAvailable = false
  @Published var debugEnabled = false
  @Published var permissions: JSON = .object([:])
  private var keepAwakeAssertion: IOPMAssertionID = 0
  private var keepAwakeActive = false
  private var permissionTask: Task<Void, Never>?
  private var featuresTask: Task<Void, Never>?
  var onChange: @MainActor () -> Void = {}
  private let filesystem = FilesystemTools()

  init(configuration: DesktopConfiguration, directory: URL, helperDirectory: URL) throws {
    self.configuration = configuration
    preferences = try DesktopPreferences(directory: directory)
    api = DesktopAPI(configuration: configuration)
    auth = DesktopAuth(configuration: configuration, preferences: preferences)
    helper = HelperProcess(
      executable: helperDirectory.appendingPathComponent("computer-use-helper"))
    let commands = ComputerCommands(helper: helper)
    host = HostRuntime(
      api: api, installationID: try preferences.installationID(),
      permissions: { [helper] in try await helper.request("permissions.state") },
      execute: { command, permissions in await commands.execute(command, permissions: permissions) }
    )
    mcp = MCPPlugins(preferences: preferences)
    recorder = ScreenRecorder(
      helper: HelperProcess(
        executable: helperDirectory.appendingPathComponent("screen-recorder-helper"),
        cancelStopsProcess: false), preferences: preferences, api: api, auth: auth)
    api.tokenProvider = { [auth] force in try await auth.getToken(force: force) }
    host.execute = { [weak self, commands] command, permissions in
      guard let self else {
        return DesktopFailure("plugin_unavailable", "Desktop is shutting down").response
      }
      if command["kind"].string == "plugin.call" {
        guard self.pluginsAvailable else {
          return DesktopFailure("feature_disabled", "Desktop plugins are disabled for this account")
            .response
        }
        let payload = command["payload"]
        if payload["plugin"].string == "mcp" { return await self.mcp.execute(payload) }
        guard payload["plugin"].string == "filesystem" else {
          return DesktopFailure("unknown_plugin", "Unknown desktop plugin").response
        }
        guard self.filesystemEnabled else {
          return DesktopFailure("plugin_disabled", "Filesystem access is disabled").response
        }
        return await self.filesystem.execute(payload, allowedDirectories: self.allowedDirectories)
      }
      let result = await commands.execute(command, permissions: permissions)
      if result["error"]["code"].string == "automation_permission_denied" {
        self.error = "Allow browser Automation in System Settings to continue."
      }
      return result
    }
    host.capabilities = { [weak self] in
      guard let self else { return ComputerCommands.capabilities }
      var capabilities = ComputerCommands.capabilities + self.mcp.capabilities
      if self.pluginsAvailable && self.filesystemEnabled && !self.allowedDirectories.isEmpty {
        capabilities +=
          ["plugin.call", "plugin.filesystem"]
          + FilesystemTools.tools.map { "plugin.filesystem.\($0)" }
      }
      return Array(Set(capabilities)).sorted()
    }
    host.onChange = { [weak self] in
      guard let self else { return }
      self.mcp.setContext(
        available: self.pluginsAvailable,
        online: ["online", "recovering"].contains(self.host.status))
      self.changed()
    }
    auth.onChange = { [weak self] in self?.changed() }
    mcp.onChange = { [weak self] in self?.changed() }
    recorder.onChange = { [weak self] in self?.changed() }
  }

  var keepAwake: Bool { preferences.value["keepAwakeEnabled"].bool }
  var filesystemEnabled: Bool {
    preferences.value["computerUsePlugins"]["filesystem"]["enabled"].bool
  }
  var allowedDirectories: [String] {
    preferences.value["computerUsePlugins"]["filesystem"]["allowedDirectories"].array.compactMap(
      \.string)
  }
  var ready: Bool {
    auth.signedIn && auth.organization["id"].string != nil && permissions["accessibility"].bool
      && permissions["screenRecording"].bool
  }

  func launch() async {
    do {
      try applyKeepAwake()
      try await refresh()
      if ready { host.start() }
    } catch { report(error) }
    permissionTask = Task { [weak self] in
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: .seconds(3))
          guard let self else { return }
          self.permissions = try await self.helper.request("permissions.state")
          self.changed()
        } catch {
          if Task.isCancelled { return }
          self?.report(error)
        }
      }
    }
    featuresTask = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(60)) } catch { return }
        guard let self else { return }
        do { try await self.refreshFeatures() } catch { self.report(error) }
      }
    }
  }

  func refresh() async throws {
    permissions = try await helper.request("permissions.state")
    try await auth.refreshIdentity(api: api)
    try await refreshFeatures()
    changed()
  }

  private func refreshFeatures() async throws {
    do {
      let body = try await api.request("api/feature-switches")
      let switches =
        body["effectiveSwitches"].object == nil ? body["switches"] : body["effectiveSwitches"]
      pluginsAvailable = switches["computerUseDesktopPlugins"].bool
      debugAvailable = switches["_debug"].bool
      if !debugAvailable { debugEnabled = false }
      let recordingEnabled = switches["introVideo"].bool
      if recorder.available && !recordingEnabled { try await recorder.shutdown() }
      recorder.available = recordingEnabled
    } catch {
      pluginsAvailable = false
      debugAvailable = false
      debugEnabled = false
      recorder.available = false
      mcp.setContext(available: false, online: false)
      throw error
    }
    mcp.setContext(
      available: pluginsAvailable, online: ["online", "recovering"].contains(host.status))
    changed()
  }

  func consume(_ url: URL) async throws {
    guard configuration.callback(url) != nil else { return }
    await host.stop()
    if try await auth.consume(url) {
      try await refresh()
      if ready { host.start() }
    }
  }

  func switchOrganization() async throws {
    await host.stop()
    try await auth.selectOrganization()
    try await refresh()
    if ready { host.start() }
  }

  func signOut() async throws {
    await host.stop()
    mcp.shutdown()
    try await recorder.shutdown()
    try await auth.signOut()
    pluginsAvailable = false
    recorder.available = false
    debugAvailable = false
    debugEnabled = false
    changed()
  }

  func requestPermission(_ name: String) async throws {
    if name == "accessibility" {
      permissions = try await helper.request("permissions.request_accessibility")
    } else if name == "screenRecording" {
      permissions = try await helper.request("permissions.request_screen_recording")
    } else {
      _ = try await helper.request(
        "permissions.probe_automation", fields: .object(["target": .string(name)]))
      permissions = try await helper.request("permissions.state")
    }
    changed()
  }

  func setKeepAwake(_ enabled: Bool) throws {
    try preferences.update { $0["keepAwakeEnabled"] = .bool(enabled) }
    try applyKeepAwake()
    changed()
  }
  private func applyKeepAwake() throws {
    if keepAwake && !keepAwakeActive {
      let result = IOPMAssertionCreateWithName(
        kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn), "Okou Desktop Keep Awake" as CFString,
        &keepAwakeAssertion)
      guard result == kIOReturnSuccess else {
        throw DesktopFailure("keep_awake", "Could not prevent display sleep (\(result))")
      }
      keepAwakeActive = true
    } else if !keepAwake && keepAwakeActive {
      IOPMAssertionRelease(keepAwakeAssertion)
      keepAwakeActive = false
    }
  }

  func setFilesystem(_ enabled: Bool) throws {
    try preferences.update { $0["computerUsePlugins"]["filesystem"]["enabled"] = .bool(enabled) }
    changed()
  }
  func addDirectory() throws {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = true
    guard panel.runModal() == .OK else { return }
    let paths = Array(Set(allowedDirectories + panel.urls.map(\.path))).sorted()
    try preferences.update {
      $0["computerUsePlugins"]["filesystem"]["allowedDirectories"] = .strings(paths)
    }
    changed()
  }
  func removeDirectory(_ path: String) throws {
    let paths = allowedDirectories.filter { $0 != path }
    try preferences.update {
      $0["computerUsePlugins"]["filesystem"]["allowedDirectories"] = .strings(paths)
    }
    changed()
  }

  func shutdown() async throws {
    permissionTask?.cancel()
    featuresTask?.cancel()
    await permissionTask?.value
    await featuresTask?.value
    permissionTask = nil
    featuresTask = nil
    areaSelector.cancel()
    try await recorder.shutdown()
    await host.stop()
    mcp.shutdown()
    helper.close()
    if keepAwakeActive {
      IOPMAssertionRelease(keepAwakeAssertion)
      keepAwakeActive = false
    }
  }
  func run(_ operation: @escaping @MainActor () async throws -> Void) {
    Task { do { try await operation() } catch is CancellationError {} catch { report(error) } }
  }
  func report(_ error: any Error) {
    self.error = error.localizedDescription
    SentrySDK.capture(error: error)
    changed()
  }
  func changed() {
    objectWillChange.send()
    onChange()
  }
}
